import { afterEach, expect, test } from 'bun:test';
import { access, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBatchInfo } from '../src/runner/batch.js';
import {
  localBatchRecordPath,
  readLocalBatchRecord,
  writeCompletedBatchRecord,
  writeRunningBatchRecord,
} from '../src/runner/batch-record.js';
import { FilePublicResultsStore } from '../src/results/public/stores/file.js';
import { publishBatch, publishBatchStatus } from '../src/results/public/publish.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test('local batch records transition atomically from running to completed', async () => {
  const root = await tempRoot();
  const batch = createBatchInfo({ agents: ['a'], caseCount: 2, runCount: 2 });

  const running = await writeRunningBatchRecord({ projectRoot: root, batch, expectedRunCount: 2 });
  expect(running).toMatchObject({ schemaVersion: 1, status: 'running', expectedRunCount: 2, runIds: [] });
  expect(await readLocalBatchRecord(root, batch.batchId)).toEqual(running);

  const completed = await writeCompletedBatchRecord({
    projectRoot: root,
    batch,
    expectedRunCount: 2,
    runIds: ['run-a', 'run-b'],
    completedAt: '2026-01-02T03:04:05.000Z',
  });
  expect(await readLocalBatchRecord(root, batch.batchId)).toEqual(completed);
  expect(completed).toMatchObject({ status: 'completed', runIds: ['run-a', 'run-b'] });
  expect((await readdir(join(root, '.harness-evals', 'batches'))).filter((name) => name.includes('.tmp'))).toEqual([]);
});

test('completed local batch records require exact unique run IDs', async () => {
  const root = await tempRoot();
  const batch = createBatchInfo({ runCount: 2 });

  await expect(writeCompletedBatchRecord({ projectRoot: root, batch, expectedRunCount: 2, runIds: ['one'] }))
    .rejects.toThrow('expected 2 run IDs, received 1');
  await expect(writeCompletedBatchRecord({ projectRoot: root, batch, expectedRunCount: 2, runIds: ['one', 'one'] }))
    .rejects.toThrow('run IDs must be unique');
});

test('local batch record reader validates its persisted envelope', async () => {
  const root = await tempRoot();
  const batch = createBatchInfo({ runCount: 1 });
  const path = localBatchRecordPath(root, batch.batchId);
  await writeRunningBatchRecord({ projectRoot: root, batch, expectedRunCount: 1 });
  await writeFile(path, '{"schemaVersion":2}\n');

  await expect(readLocalBatchRecord(root, batch.batchId)).rejects.toThrow('schemaVersion must be 1');
  await writeFile(path, `${JSON.stringify({
    schemaVersion: 1,
    batch,
    status: 'completed',
    expectedRunCount: 2,
    runIds: ['duplicate', 'duplicate'],
    completedAt: '2026-01-02T03:04:05.000Z',
  })}\n`);
  await expect(readLocalBatchRecord(root, batch.batchId)).rejects.toThrow('runIds must be unique');
  expect(await readLocalBatchRecord(root, '20260101-000000-abcd')).toBeUndefined();
  await expect(readLocalBatchRecord(root, '../escape')).rejects.toThrow('Invalid batch ID');
});

test('publishes a finalized batch to filesystem and reclassifies catalog without rewriting immutable files', async () => {
  const root = await tempRoot();
  const batchId = '20260101-010203-abcd';
  const artifactRoot = join(root, '.harness-evals', 'runs');
  const runId = 'case-a-agent-2026-01-01T01-02-03-000Z-0';
  const runDir = join(artifactRoot, runId);
  await writeFile(join(await mkdirPath(runDir), 'summary.json'), JSON.stringify({ caseId: 'case-a', agentName: 'agent', batchId, status: 'passed', pass: true, durationMs: 42, metrics: { 'quality.passRate': 1, 'cost.total': 1 } }));
  await writeFile(join(runDir, 'run-started.json'), JSON.stringify({ caseId: 'case-a', agentName: 'agent', batch: { batchId, startedAt: '2026-01-01T01:02:03.000Z', label: '<batch>' } }));
  const batch = { batchId, startedAt: '2026-01-01T01:02:03.000Z', label: '<batch>', agents: ['agent'], caseCount: 1, runCount: 1 };
  await writeCompletedBatchRecord({ projectRoot: root, batch, expectedRunCount: 1, runIds: [runId] });
  const store = new FilePublicResultsStore(join(root, 'store'));
  const config = { store: { type: 'file' as const, root: join(root, 'store') }, prefix: 'archive', publicBaseUrl: 'https://example.test/archive/v1' };

  const published = await publishBatch({ projectRoot: root, artifactRoot, config, batchId, store, benchmarks: {
    cost: { revision: 1, label: 'Cost', select: { cases: ['case-a'] }, arms: { baseline: 'agent', candidate: 'candidate' }, trials: 1, qualityGates: [{ metric: 'quality.passRate', min: 1 }], objective: { metric: 'cost.total', goal: 'minimize' }, aggregation: { trials: 'median', cases: 'macroMean' }, secondaryMetrics: [] },
  } });
  expect(published.reportUrl).toBe(`https://example.test/archive/v1/batches/${batchId}/results.html`);
  const before = await store.get(`archive/v1/batches/${batchId}/manifest.json`);
  expect(before).toBeDefined();
  await publishBatchStatus({ config, batchId, validity: 'invalid', validityNote: 'review', store });
  expect(await store.get(`archive/v1/batches/${batchId}/manifest.json`)).toEqual(before);
  expect(await store.get(`archive/v1/batches/${batchId}/benchmarks/cost/results.json`)).toBeDefined();
  const index = JSON.parse(new TextDecoder().decode(await store.get('archive/v1/index.json')));
  expect(index.batches[0]).toMatchObject({ batchId, validity: 'invalid', validityNote: 'review' });
});

test('publication status dry run does not create an absent file store', async () => {
  const root = await tempRoot();
  const storeRoot = join(root, 'absent-store');
  const store = new FilePublicResultsStore(storeRoot);
  const config = { store: { type: 'file' as const, root: storeRoot }, prefix: 'archive' };

  await expect(publishBatchStatus({
    config,
    batchId: '20260101-010203-abcd',
    validity: 'invalid',
    validityNote: 'review',
    store,
    dryRun: true,
  })).rejects.toThrow('Published batch not found');
  await expect(access(storeRoot)).rejects.toThrow();
});

test('publishes through the CLI process and writes the documented archive layout', async () => {
  const root = await tempRoot();
  const batchId = '20260101-010203-abcd';
  const runId = 'case-a-agent-2026-01-01T01-02-03-000Z-0';
  const runDir = join(root, '.harness-evals', 'runs', runId);
  await writeFile(join(await mkdirPath(runDir), 'summary.json'), JSON.stringify({ caseId: 'case-a', agentName: 'agent', batchId, status: 'passed', pass: true }));
  await writeFile(join(runDir, 'run-started.json'), JSON.stringify({ caseId: 'case-a', agentName: 'agent', batch: { batchId, startedAt: '2026-01-01T01:02:03.000Z' } }));
  await mkdirPath(join(root, '.harness-evals', 'batches'));
  await writeFile(join(root, '.harness-evals', 'batches', `${batchId}.json`), JSON.stringify({
    schemaVersion: 1,
    batch: { batchId, startedAt: '2026-01-01T01:02:03.000Z', agents: ['agent'], caseCount: 1, runCount: 1 },
    status: 'completed', expectedRunCount: 1, runIds: [runId], completedAt: '2026-01-01T01:03:00.000Z',
  }));
  await writeFile(join(root, 'harness-evals.yaml'), `version: 1\nresults:\n  publish:\n    store:\n      type: file\n      root: .harness-evals/public-results\n    prefix: archive\n    publicBaseUrl: https://example.test/archive/v1\n`);

  const dryRun = await runCli(root, 'publish', '--config', 'harness-evals.yaml', '--batch', batchId, '--dry-run');
  expect(dryRun.code).toBe(0);
  expect(await fileExists(join(root, '.harness-evals', 'public-results', 'archive', 'v1', 'index.json'))).toBe(false);
  expect((await runCli(root, 'publish', '--config', 'harness-evals.yaml', '--batch', batchId)).code).toBe(0);
  const archiveRoot = join(root, '.harness-evals', 'public-results', 'archive', 'v1');
  for (const path of ['index.html', 'index.json', `batches/${batchId}/manifest.json`, `batches/${batchId}/results.html`, `batches/${batchId}/results.csv`]) {
    expect(await fileExists(join(archiveRoot, path))).toBe(true);
  }
  const indexBeforeDryRun = await readFile(join(archiveRoot, 'index.json'), 'utf8');
  const statusDryRun = await runCli(root, 'publish-status', '--config', 'harness-evals.yaml', '--batch', batchId, '--validity', 'invalid', '--validity-note', 'manual review', '--dry-run');
  expect(statusDryRun.code).toBe(0);
  expect(statusDryRun.stdout).toContain('Validated publication status');
  expect(await readFile(join(archiveRoot, 'index.json'), 'utf8')).toBe(indexBeforeDryRun);
  expect((await runCli(root, 'publish-status', '--config', 'harness-evals.yaml', '--batch', batchId, '--validity', 'invalid', '--validity-note', 'manual review')).code).toBe(0);
  const index = JSON.parse(await readFile(join(archiveRoot, 'index.json'), 'utf8')) as { batches: Array<{ validity: string; validityNote?: string }> };
  expect(index.batches[0]).toMatchObject({ validity: 'invalid', validityNote: 'manual review' });
});

async function mkdirPath(path: string): Promise<string> {
  const { mkdir } = await import('node:fs/promises');
  await mkdir(path, { recursive: true });
  return path;
}

async function fileExists(path: string): Promise<boolean> {
  try { await readFile(path); return true; } catch { return false; }
}

async function runCli(cwd: string, ...args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [join(import.meta.dir, '..', 'src', 'cli.ts'), ...args], { cwd });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => resolveResult({ code, stdout, stderr }));
  });
}

async function tempRoot(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'harness-evals-public-'));
  tempDirs.push(path);
  return path;
}
