import { access, chmod, copyFile, lstat, mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { CostReport } from '../cost/types.js';
import { expandTrustedPath } from '../config/paths.js';
import { parsePiJsonlEventsWithContext, parsePiJsonlSessionCost } from './pi-jsonl.js';
import { mergeCostReports } from '../cost/rollup.js';
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
    const parsed = await parsePiJsonlEventsWithContext(input);
    const summary = parsed.summary;
    if (input.stderr.trim()) summary.errors.push(input.stderr.trim());
    if (input.configDir && parsed.sessionId) {
      const childCosts = await readChildSessionCosts(input.configDir, parsed.sessionId);
      if (childCosts.length > 0) {
        summary.cost = mergeCostReports([summary.cost, ...childCosts.map((entry) => entry.cost)]);
        if (summary.cost) {
          summary.cost.metadata = {
            ...(summary.cost.metadata ?? {}),
            felanChildSessionCount: childCosts.length,
          };
        }
      }
    }
    return summary;
  },
};

const MAX_CHILD_SESSION_FILES = 256;
const MAX_CHILD_SESSION_BYTES = 16 * 1024 * 1024;
const MAX_CHILD_RECORD_BYTES = 4 * 1024 * 1024;

type ChildSessionCost = { id: string; cost: CostReport };

async function readChildSessionCosts(configDir: string, rootSessionId: string): Promise<ChildSessionCost[]> {
  const felanDir = resolve(configDir, FELAN_CONFIG_DIR);
  const subagentsDir = join(felanDir, 'subagents', encodeURIComponent(rootSessionId));
  const sessionsDir = join(subagentsDir, 'sessions');
  let entries;
  try {
    entries = await readdir(sessionsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  let realSessionsDir: string;
  try {
    realSessionsDir = await realpath(sessionsDir);
  } catch {
    return [];
  }
  const realFelanDir = await realpath(felanDir).catch(() => felanDir);
  if (!isPathInside(realFelanDir, realSessionsDir)) return [];
  const childSessionFiles = await readChildSessionFiles(subagentsDir, realFelanDir, rootSessionId);
  if (childSessionFiles.size === 0) return [];
  const costs: ChildSessionCost[] = [];
  const seenSessionIds = new Set<string>();
  const sessionEntries = entries
    .filter((entry) => entry.isFile() && childSessionFiles.has(entry.name))
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
    .slice(0, MAX_CHILD_SESSION_FILES);
  for (const entry of sessionEntries) {
    const path = join(sessionsDir, entry.name);
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.size > MAX_CHILD_SESSION_BYTES) continue;
      const realFile = await realpath(path);
      if (!isPathInside(realSessionsDir, realFile)) continue;
      const parsed = parsePiJsonlSessionCost(await readFile(realFile, 'utf8'));
      const expectedSessionId = childSessionFiles.get(entry.name);
      if (
        parsed
        && parsed.sessionId === expectedSessionId
        && parsed.sessionId !== rootSessionId
        && !seenSessionIds.has(parsed.sessionId)
      ) {
        seenSessionIds.add(parsed.sessionId);
        costs.push({ id: parsed.sessionId, cost: parsed.cost });
      }
    } catch {
      continue;
    }
  }
  return costs;
}

async function readChildSessionFiles(
  subagentsDir: string,
  realFelanDir: string,
  rootSessionId: string,
): Promise<Map<string, string>> {
  const path = join(subagentsDir, 'records.json');
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.size > MAX_CHILD_RECORD_BYTES) return new Map();
    const realFile = await realpath(path);
    if (!isPathInside(realFelanDir, realFile)) return new Map();
    const stored = JSON.parse(await readFile(realFile, 'utf8')) as unknown;
    if (!isRecord(stored) || stored.version !== 1 || !Array.isArray(stored.children)) return new Map();
    const filesBySessionId = new Map<string, string>();
    const duplicateSessionIds = new Set<string>();
    for (const child of stored.children) {
      if (!isRecord(child) || !isRecord(child.record)) continue;
      const sessionId = child.record.agentId;
      if (
        child.record.rootSessionId !== rootSessionId
        || typeof sessionId !== 'string'
        || typeof child.sessionFile !== 'string'
      ) continue;
      const fileName = recordedSessionFileName(child.sessionFile, rootSessionId, sessionId);
      if (!fileName || duplicateSessionIds.has(sessionId)) continue;
      const previous = filesBySessionId.get(sessionId);
      if (previous && previous !== fileName) {
        filesBySessionId.delete(sessionId);
        duplicateSessionIds.add(sessionId);
        continue;
      }
      filesBySessionId.set(sessionId, fileName);
    }
    return new Map([...filesBySessionId].map(([sessionId, fileName]) => [fileName, sessionId]));
  } catch {
    return new Map();
  }
}

function recordedSessionFileName(sessionFile: string, rootSessionId: string, sessionId: string): string | undefined {
  const normalized = sessionFile.replaceAll('\\', '/');
  const fileName = normalized.split('/').at(-1);
  if (!fileName || !sessionFileMatchesId(fileName, sessionId)) return undefined;
  const expectedSuffix = `/felan/subagents/${encodeURIComponent(rootSessionId)}/sessions/${fileName}`;
  return normalized.endsWith(expectedSuffix) ? fileName : undefined;
}

function sessionFileMatchesId(fileName: string, sessionId: string): boolean {
  if (fileName === `${sessionId}.jsonl`) return true;
  const suffix = `_${sessionId}.jsonl`;
  if (!fileName.endsWith(suffix)) return false;
  return /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/.test(fileName.slice(0, -suffix.length));
}

function isPathInside(parent: string, child: string): boolean {
  if (!isAbsolute(parent) || !isAbsolute(child)) return false;
  const relation = relative(parent, child);
  return relation === '' || (relation !== '..' && !relation.startsWith(`..${sep}`));
}

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
