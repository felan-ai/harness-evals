import { access, chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { expandTrustedPath } from '../config/paths.js';
import { parsePiJsonlEvents } from './pi-jsonl.js';
import { prepareFelanOAuth } from './felan-oauth.js';
import type { AgentAdapter, AgentStepPrepareInput, AgentStepRunPlan } from './types.js';

export const FELAN_AUTH_ENV_NAMES = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'DEEPSEEK_API_KEY',
  'MISTRAL_API_KEY',
  'GROQ_API_KEY',
  'CEREBRAS_API_KEY',
  'AZURE_OPENAI_API_KEY',
] as const;

const FELAN_PACKAGE = '@felan-ai/felan';
const FELAN_CONFIG_DIR = 'felan';
const FELAN_SECRET_FILES = ['auth.json', 'models.json', 'models-store.json'] as const;
const EXACT_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export const felanAdapter: AgentAdapter = {
  name: 'felan',
  authEnvNames: FELAN_AUTH_ENV_NAMES,
  async getInstallRecipe(input) {
    const packageVersion = readPackageVersion(input.agent.config);
    const packageSpec = packageVersion ? `${FELAN_PACKAGE}@${packageVersion}` : FELAN_PACKAGE;
    return {
      commands: input.agent.command ? [] : [`npm install -g ${packageSpec}`],
      probes: [{ command: [input.agent.command ?? 'felan', '--version'] }],
      cacheKey: packageSpec,
    };
  },
  async prepareStep(input: AgentStepPrepareInput): Promise<AgentStepRunPlan> {
    const config = input.agent.config ?? {};
    const configDir = join(input.configDir, FELAN_CONFIG_DIR);
    await mkdir(configDir, { recursive: true, mode: 0o700 });

    const useCurrentConfig = readBoolean(config.useCurrentConfig) ?? input.agent.useCurrentConfig ?? true;
    const sourceDir = currentFelanDir(input);
    const oauth = input.agent.auth?.type === 'oauth'
      ? await prepareFelanOAuth({ projectRoot: input.projectRoot, provider: input.agent.provider!, auth: input.agent.auth })
      : undefined;
    const copiedFiles = useCurrentConfig ? await copyCurrentFelanFiles(sourceDir, configDir, oauth !== undefined) : [];
    const settings = await prepareSettings(sourceDir, configDir, useCurrentConfig, config.settings);
    const configMounts = oauth
      ? await prepareOAuthMount(configDir, oauth.authPath, `${input.docker.configRoot}/${FELAN_CONFIG_DIR}/auth.json`)
      : [];

    const command = input.agent.command ?? 'felan';
    const mode = input.agent.outputFormat === 'text' ? 'text' : 'json';
    const argv = [command, '--mode', mode];
    if (input.agent.provider) argv.push('--provider', input.agent.provider);
    if (input.agent.model) argv.push('--model', input.agent.model);
    if (input.agent.thinking) argv.push('--thinking', input.agent.thinking);
    argv.push(...(input.agent.args ?? []), input.prompt);

    return {
      argv,
      cwd: input.agent.cwd ?? input.workspace.containerPath,
      envNames: unique([
        input.agent.apiKeyEnv,
        ...FELAN_AUTH_ENV_NAMES,
        ...(input.agent.env ?? []),
        ...(input.agent.envAllowlist ?? []),
      ]),
      envValues: { FELAN_AGENT_DIR: `${input.docker.configRoot}/${FELAN_CONFIG_DIR}` },
      configMounts,
      parser: input.agent.parser ?? (mode === 'json' ? 'pi-jsonl' : 'text'),
      timeoutMs: input.agent.timeoutMs,
      cleanupPaths: [configDir],
      metadata: {
        felan: {
          agentDir: `${input.docker.configRoot}/${FELAN_CONFIG_DIR}`,
          sourceDir,
          copiedFiles,
          settingsGenerated: settings !== undefined,
          ...(oauth ? { oauth: { provider: oauth.provider, profile: oauth.profile, refreshed: oauth.refreshed } } : {}),
        },
      },
    };
  },
  async parseEvents(input) {
    if (input.plan.parser === 'text') {
      return {
        finalOutput: input.stdout.trim(),
        toolCalls: [],
        errors: input.stderr.trim() ? [input.stderr.trim()] : [],
      };
    }
    const summary = await parsePiJsonlEvents(input);
    if (input.stderr.trim()) summary.errors.push(input.stderr.trim());
    return summary;
  },
};

function currentFelanDir(input: AgentStepPrepareInput): string {
  return expandTrustedPath(input.agent.userConfigDirs?.[0] ?? process.env.FELAN_AGENT_DIR ?? join(homedir(), '.felan'));
}

async function copyCurrentFelanFiles(sourceDir: string, targetDir: string, skipAuth: boolean): Promise<string[]> {
  const copied: string[] = [];
  for (const name of FELAN_SECRET_FILES) {
    if (skipAuth && name === 'auth.json') continue;
    const source = join(sourceDir, name);
    if (!(await pathExists(source))) continue;
    const target = join(targetDir, name);
    await copyFile(source, target);
    await chmod(target, 0o600);
    copied.push(name);
  }
  return copied;
}

async function prepareOAuthMount(configDir: string, sourcePath: string, targetPath: string): Promise<[{ source: string; target: string; readonly: boolean }]> {
  const placeholder = join(configDir, 'auth.json');
  if (!(await pathExists(placeholder))) await writeFile(placeholder, '{}\n', { mode: 0o600 });
  await chmod(placeholder, 0o600);
  return [{ source: sourcePath, target: targetPath, readonly: false }];
}

async function prepareSettings(
  sourceDir: string,
  targetDir: string,
  useCurrentConfig: boolean,
  configured: unknown,
): Promise<Record<string, unknown> | undefined> {
  const current = useCurrentConfig ? await readJsonObject(join(sourceDir, 'settings.json')) : undefined;
  const overrides = isRecord(configured) ? configured : undefined;
  if (!current && !overrides) return undefined;
  const settings = { ...(current ?? {}), ...(overrides ?? {}) };
  const target = join(targetDir, 'settings.json');
  await writeFile(target, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  await chmod(target, 0o600);
  return settings;
}

async function readJsonObject(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function readPackageVersion(config: Record<string, unknown> | undefined): string | undefined {
  const value = config?.packageVersion;
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !EXACT_SEMVER.test(value)) {
    throw new Error('felan config.packageVersion must be an exact semantic version such as 0.14.2');
  }
  return value;
}

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
