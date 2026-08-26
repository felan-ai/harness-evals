import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadHarnessConfig } from '../src/config/load.js';
import { buildMatrix } from '../src/runner/matrix.js';
import { prepareFelanOAuth } from '../src/adapters/felan-oauth.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test('Felan agents accept first-class OAuth configuration', async () => {
  const root = await writeProject(`
agents:
  felan-subscription:
    adapter: felan
    provider: openai-codex
    model: gpt-5.3-codex
    auth:
      type: oauth
      profile: work-account
      openBrowser: false
`);

  const config = await loadHarnessConfig({ cwd: root });
  const entry = buildMatrix(config)[0];

  expect(entry.agent.auth).toEqual({
    type: 'oauth',
    profile: 'work-account',
    openBrowser: false,
  });
});

test('agent OAuth configuration rejects malformed fields and unsafe profiles', async () => {
  const invalidAuth = [
    ['api-key', 'auth.type must be oauth'],
    ['oauth\n      unexpected: true', 'Unknown agents.felan.auth key'],
    ['oauth\n      profile: ../outside', 'auth.profile must be a safe name'],
  ] as const;

  for (const [authBody, message] of invalidAuth) {
    const root = await writeProject(`
agents:
  felan:
    adapter: felan
    provider: openai-codex
    auth:
      type: ${authBody}
`);
    await expect(loadHarnessConfig({ cwd: root })).rejects.toThrow(message);
  }
});

test('resolved OAuth agents require the Felan adapter and a provider', async () => {
  const wrongAdapterRoot = await writeProject(`
agents:
  wrong:
    adapter: command
    command: echo
    provider: openai-codex
    auth:
      type: oauth
`);
  const wrongAdapter = await loadHarnessConfig({ cwd: wrongAdapterRoot });
  expect(() => buildMatrix(wrongAdapter)).toThrow('only the felan adapter supports it');

  const missingProviderRoot = await writeProject(`
agents:
  missing-provider:
    adapter: felan
    auth:
      type: oauth
`);
  const missingProvider = await loadHarnessConfig({ cwd: missingProviderRoot });
  expect(() => buildMatrix(missingProvider)).toThrow('requires provider');
});

test('Felan OAuth persists credentials, reuses them, and refreshes expired credentials', async () => {
  const root = await writeProject('');
  const calls: string[] = [];
  let isTTY = process.stdin.isTTY;
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
  const provider = {
    async login() {
      calls.push('login');
      return { access: 'access-1', refresh: 'refresh-1', expires: Date.now() + 3_600_000 };
    },
    async refreshToken() {
      calls.push('refresh');
      return { access: 'access-2', refresh: 'refresh-2', expires: Date.now() + 3_600_000 };
    },
  };
  try {
    const auth = { type: 'oauth' as const, profile: 'profile' };
    const first = await prepareFelanOAuth({ projectRoot: root, provider: 'test-provider', auth, providerOverride: provider });
    expect(first.refreshed).toBe(false);
    expect(calls).toEqual(['login']);
    expect(JSON.parse(await readFile(first.authPath, 'utf8'))['test-provider']).toMatchObject({
      type: 'oauth', access: 'access-1', refresh: 'refresh-1',
    });

    await prepareFelanOAuth({ projectRoot: root, provider: 'test-provider', auth, providerOverride: provider });
    expect(calls).toEqual(['login']);

    await writeFile(first.authPath, JSON.stringify({ 'test-provider': {
      type: 'oauth', access: 'expired', refresh: 'refresh-1', expires: Date.now() - 1,
    } }));
    const refreshed = await prepareFelanOAuth({ projectRoot: root, provider: 'test-provider', auth, providerOverride: provider });
    expect(refreshed.refreshed).toBe(true);
    expect(calls).toEqual(['login', 'refresh']);
    expect(JSON.parse(await readFile(first.authPath, 'utf8'))['test-provider'].access).toBe('access-2');
  } finally {
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: isTTY });
  }
});

async function writeProject(configBody: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'harness-evals-felan-oauth-'));
  tempDirs.push(root);
  await mkdir(join(root, 'cases'), { recursive: true });
  await writeFile(join(root, 'harness-evals.yaml'), `
version: 1
docker:
  image: fake-image
${configBody}
tests:
  - cases/*.yaml
`);
  await writeFile(join(root, 'cases', 'case.yaml'), `
id: oauth
prompt: Test OAuth.
assert: []
`);
  return root;
}
