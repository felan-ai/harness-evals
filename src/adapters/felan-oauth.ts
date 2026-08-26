import { createInterface } from 'node:readline/promises';
import { spawn } from 'node:child_process';
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { getOAuthProvider } from '@earendil-works/pi-ai/oauth';
import type { OAuthCredentials, OAuthLoginCallbacks } from '@earendil-works/pi-ai/oauth';
import type { AgentAuthConfig } from '../config/schema.js';

const DEFAULT_PROFILE = 'default';
const authLocks = new Map<string, Promise<void>>();

export interface FelanOAuthPreparation {
  authPath: string;
  provider: string;
  profile: string;
  loggedIn: boolean;
  refreshed: boolean;
}

interface OAuthProviderLike {
  login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials>;
  refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials>;
}

export async function prepareFelanOAuth(input: {
  projectRoot: string;
  provider: string;
  auth: AgentAuthConfig;
  providerOverride?: OAuthProviderLike;
}): Promise<FelanOAuthPreparation> {
  const profile = input.auth.profile ?? DEFAULT_PROFILE;
  const authPath = join(input.projectRoot, '.harness-evals', 'auth', 'felan', profile, 'auth.json');
  await ensureSafeAuthFile(authPath, input.projectRoot);
  const provider = input.providerOverride ?? getOAuthProvider(input.provider);
  if (!provider) throw new Error(`Unsupported Felan OAuth provider: ${input.provider}`);

  return withAuthLock(authPath, async () => {
    const auth = await readAuthFile(authPath);
    const current = auth[input.provider];
    if (current && !isOAuthCredentials(current)) {
      throw new Error(`Felan OAuth credential for ${input.provider} is malformed in ${authPath}`);
    }

    if (current && current.expires > Date.now() + 60_000) {
      return { authPath, provider: input.provider, profile, loggedIn: true, refreshed: false };
    }

    let credentials: OAuthCredentials;
    let refreshed = false;
    if (current) {
      try {
        credentials = await provider.refreshToken(current);
        refreshed = true;
      } catch (error) {
        throw new Error(`Failed to refresh Felan OAuth token for ${input.provider}: ${errorMessage(error)}`);
      }
    } else {
      if (!process.stdin.isTTY) {
        throw new Error(`Felan OAuth login for ${input.provider} requires an interactive terminal; authenticate first or run with a TTY`);
      }
      credentials = await login(provider, input.auth.openBrowser ?? true);
    }

    await writeAuthFile(authPath, { ...auth, [input.provider]: { type: 'oauth', ...credentials } });
    return { authPath, provider: input.provider, profile, loggedIn: !refreshed, refreshed };
  });
}

async function login(provider: {
  login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials>;
}, openBrowser: boolean): Promise<OAuthCredentials> {
  const reader = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await provider.login({
      onAuth: (info) => {
        process.stderr.write(`\nOpen this URL to authenticate:\n${info.url}\n`);
        if (info.instructions) process.stderr.write(`${info.instructions}\n`);
        if (openBrowser) launchBrowser(info.url);
      },
      onPrompt: async (prompt) => reader.question(`${prompt.message}${prompt.placeholder ? ` (${prompt.placeholder})` : ''}: `),
      onProgress: (message) => process.stderr.write(`${message}\n`),
    });
  } finally {
    reader.close();
  }
}

async function ensureSafeAuthFile(path: string, projectRoot: string): Promise<void> {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  let current = projectRoot;
  for (const segment of relative(projectRoot, parent).split('/').filter(Boolean)) {
    current = join(current, segment);
    if ((await lstat(current)).isSymbolicLink()) throw new Error(`Felan OAuth auth directory must not contain symlinks: ${current}`);
  }
  await chmod(parent, 0o700);
  try {
    const info = await lstat(path);
    if (!info.isFile()) throw new Error(`Felan OAuth auth path is not a regular file: ${path}`);
  } catch (error) {
    if (!isNotFound(error)) throw error;
    await writeFile(path, '{}\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  }
  await chmod(path, 0o600);
}

async function readAuthFile(path: string): Promise<Record<string, OAuthCredentials | { type?: unknown }>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new Error(`Failed to read Felan OAuth credentials at ${path}: ${errorMessage(error)}`);
  }
  if (!isRecord(parsed)) throw new Error(`Felan OAuth credentials at ${path} must be a JSON object`);
  return parsed as Record<string, OAuthCredentials | { type?: unknown }>;
}

async function writeAuthFile(path: string, auth: Record<string, unknown>): Promise<void> {
  const temporary = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(auth, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function withAuthLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const previous = authLocks.get(path) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.then(() => current);
  authLocks.set(path, queued);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (authLocks.get(path) === queued) authLocks.delete(path);
  }
}

function isOAuthCredentials(value: unknown): value is OAuthCredentials {
  return isRecord(value)
    && value.type === 'oauth'
    && typeof value.access === 'string'
    && value.access.length > 0
    && typeof value.refresh === 'string'
    && value.refresh.length > 0
    && typeof value.expires === 'number'
    && Number.isFinite(value.expires);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

function launchBrowser(url: string): void {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  spawn(command, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
