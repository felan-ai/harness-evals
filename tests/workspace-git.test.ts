import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadHarnessConfig } from '../src/config/load.js';
import { buildMatrix } from '../src/runner/matrix.js';
import { copyWorkspace } from '../src/workspace/copy.js';
import { acquireGitWorkspace, cleanupGitWorkspace } from '../src/workspace/git-source.js';

const tempDirs: string[] = [];
const COMMIT = '104faa5559029c8be9e8a1eb504d87974a5864e9';

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test('loads and merges an exact Git workspace source', async () => {
  const root = await tempRoot();
  await writeProject(root, `
workspace:
  git:
    repository: https://github.com/felan-ai/felan.git
    commit: ${COMMIT.toUpperCase()}
`, `
id: git-source
workspace:
  setup:
    - command: node
      args: [--version]
prompt: hi
assert: []
`);

  const config = await loadHarnessConfig({ cwd: root });
  const entry = buildMatrix(config)[0];

  expect(config.workspace.git).toEqual({
    repository: 'https://github.com/felan-ai/felan.git',
    commit: COMMIT,
  });
  expect(config.workspace.source).toBeUndefined();
  expect(entry.workspace.git).toEqual(config.workspace.git);
  expect(entry.workspace.source).toBeUndefined();
  expect(entry.workspace.setup).toEqual([{ command: 'node', args: ['--version'], cwd: undefined, timeoutMs: undefined }]);
});

test('a case fixture replaces a project Git source', async () => {
  const root = await tempRoot();
  await mkdir(join(root, 'fixture'));
  await writeProject(root, `
workspace:
  git:
    repository: https://github.com/felan-ai/felan.git
    commit: ${COMMIT}
`, `
id: local-fixture
workspace:
  fixture: fixture
prompt: hi
assert: []
`);

  const entry = buildMatrix(await loadHarnessConfig({ cwd: root }))[0];

  expect(entry.workspace.fixture).toBe(join(root, 'fixture'));
  expect(entry.workspace.source).toBeUndefined();
  expect(entry.workspace.git).toBeUndefined();
  expect(entry.workspace.seedFromImage).toBe(false);
});

test('accepts project-contained file repositories', async () => {
  const root = await tempRoot();
  const repository = join(root, 'repository.git');
  await mkdir(repository);
  await writeProject(root, '', `
id: local-git-source
workspace:
  git:
    repository: ${pathToFileURL(repository).href}
    commit: ${COMMIT}
prompt: hi
assert: []
`);

  const config = await loadHarnessConfig({ cwd: root });

  expect(config.testCases[0].workspace?.git).toEqual({
    repository: pathToFileURL(repository).href,
    commit: COMMIT,
  });
});

test('rejects invalid or ambiguous Git workspace sources', async () => {
  const cases = [
    {
      name: 'abbreviated commit',
      workspace: `git:\n    repository: https://github.com/felan-ai/felan.git\n    commit: 104faa5`,
      message: 'commit must be a full 40-character hexadecimal SHA',
    },
    {
      name: 'credentials',
      workspace: `git:\n    repository: https://token@github.com/felan-ai/felan.git\n    commit: ${COMMIT}`,
      message: 'repository must not include credentials',
    },
    {
      name: 'unsupported protocol',
      workspace: `git:\n    repository: http://github.com/felan-ai/felan.git\n    commit: ${COMMIT}`,
      message: 'repository must use https or a project-contained file URL',
    },
    {
      name: 'ambiguous fixture',
      workspace: `fixture: fixture\n  git:\n    repository: https://github.com/felan-ai/felan.git\n    commit: ${COMMIT}`,
      message: 'must select only one of source, fixture, git, or seedFromImage',
    },
  ];

  for (const invalid of cases) {
    const root = await tempRoot();
    await mkdir(join(root, 'fixture'));
    await writeProject(root, '', `
id: ${invalid.name.replaceAll(' ', '-')}
workspace:
  ${invalid.workspace}
prompt: hi
assert: []
`);

    await expect(loadHarnessConfig({ cwd: root })).rejects.toThrow(invalid.message);
  }
});

test('rejects file repositories outside the project root', async () => {
  const root = await tempRoot();
  const outside = await tempRoot();
  await writeProject(root, '', `
id: escaped-local-git-source
workspace:
  git:
    repository: ${pathToFileURL(outside).href}
    commit: ${COMMIT}
prompt: hi
assert: []
`);

  await expect(loadHarnessConfig({ cwd: root })).rejects.toThrow('Path escapes project root');
});

test('acquires an exact detached commit without a remote and cleans it up', async () => {
  const repository = await createRepository();
  const commit = execGit(repository, ['rev-list', '--max-parents=0', 'HEAD']);
  const source = await acquireGitWorkspace({ repository: pathToFileURL(repository).href, commit });

  expect(execGit(source.path, ['rev-parse', 'HEAD'])).toBe(commit);
  expect(execGit(source.path, ['symbolic-ref', '--quiet', '--short', 'HEAD'], false)).toBe('');
  expect(execGit(source.path, ['remote'])).toBe('');
  expect(execGit(source.path, ['rev-list', '--count', 'HEAD'])).toBe('1');
  expect(await Bun.file(join(source.path, 'README.md')).text()).toBe('first\n');

  const sourcePath = source.path;
  await cleanupGitWorkspace(source);
  expect(await Bun.file(sourcePath).exists()).toBe(false);
});

test('copies Git metadata even when workspace ignores match it', async () => {
  const repository = await createRepository();
  const commit = execGit(repository, ['rev-list', '--max-parents=0', 'HEAD']);
  const source = await acquireGitWorkspace({ repository: pathToFileURL(repository).href, commit });
  const destination = join(await tempRoot(), 'workspace');

  try {
    await copyWorkspace(source.path, destination, {
      ignore: ['.git', '.git/**'],
      includeGitMetadata: true,
    });
    expect(execGit(destination, ['rev-parse', 'HEAD'])).toBe(commit);
  } finally {
    await cleanupGitWorkspace(source);
  }
});

test('cleans a failed exact commit acquisition', async () => {
  const repository = await createRepository();
  const before = (await readdir(tmpdir())).filter((name) => name.startsWith('harness-evals-git-'));

  await expect(acquireGitWorkspace({
    repository: pathToFileURL(repository).href,
    commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  })).rejects.toThrow('git fetch failed');

  const after = (await readdir(tmpdir())).filter((name) => name.startsWith('harness-evals-git-'));
  expect(after).toEqual(before);
});

async function writeProject(root: string, configWorkspace: string, testCase: string): Promise<void> {
  await mkdir(join(root, 'cases'), { recursive: true });
  await writeFile(join(root, 'harness-evals.yaml'), `
version: 1
${configWorkspace}
agents:
  command:
    adapter: command
    command: echo
tests:
  - cases/*.yaml
`);
  await writeFile(join(root, 'cases', 'case.yaml'), testCase);
}

async function createRepository(): Promise<string> {
  const repository = await tempRoot();
  execGit(repository, ['init', '--quiet']);
  execGit(repository, ['config', 'user.name', 'Harness Tests']);
  execGit(repository, ['config', 'user.email', 'tests@example.invalid']);
  await writeFile(join(repository, 'README.md'), 'first\n');
  execGit(repository, ['add', 'README.md']);
  execGit(repository, ['commit', '--quiet', '-m', 'first']);
  const firstCommit = execGit(repository, ['rev-parse', 'HEAD']);
  await writeFile(join(repository, 'README.md'), 'second\n');
  execGit(repository, ['add', 'README.md']);
  execGit(repository, ['commit', '--quiet', '-m', 'second']);
  execGit(repository, ['update-ref', 'refs/keep/first', firstCommit]);
  return repository;
}

function execGit(cwd: string, args: string[], expectSuccess = true): string {
  try {
    return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', expectSuccess ? 'pipe' : 'ignore'] }).trim();
  } catch (error) {
    if (!expectSuccess) return '';
    throw error;
  }
}

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'harness-evals-workspace-git-'));
  tempDirs.push(root);
  return root;
}
