import { afterEach, expect, test } from 'bun:test';
import { access, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FilePublicResultsStore } from '../src/results/public/stores/file.js';
import { projectPublicBatch } from '../src/results/public/project.js';
import { renderPublicBatchCsv } from '../src/results/public/render-csv.js';
import { renderPublicBatchHtml, renderPublicIndexHtml } from '../src/results/public/render-html.js';
import type { BatchSummaryInfo, ScannedTaskRun } from '../src/visualization/scan.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test('public projection is allowlisted, deterministic, and does not total mixed currencies', () => {
  const batch: BatchSummaryInfo = {
    batchId: '20260101-010203-abcd',
    startedAt: '2026-01-01T01:02:03.000Z',
    label: '<unsafe>',
    agents: ['z-agent', 'a-agent'],
    synthetic: false,
    runCount: 2,
  };
  const runs = [
    fakeRun({ runId: 'z', caseId: 'case-b', agentName: 'z-agent', status: 'error', cost: { totalCost: 2, currency: 'EUR' }, error: 'private error', runDir: '/private' }),
    fakeRun({ runId: 'a', caseId: 'case-a', agentName: 'a-agent', agentLabel: 'Felan full', comparisonId: 'felan-full', status: 'passed', durationMs: 10, score: 0.9, assertionPassRate: 1, verifierReward: 1, cost: { totalCost: 1, currency: 'USD', totalTokens: 5 }, description: 'private description' }),
  ];
  const manifest = projectPublicBatch(batch, runs);

  expect(manifest.runs.map((run) => run.runId)).toEqual(['a', 'z']);
  expect(manifest.totals).toMatchObject({ runs: 2, passed: 1, errors: 1, durationMs: 10 });
  expect(manifest.totals.cost).toEqual({ totalTokens: 5 });
  expect(manifest.runs[0]).not.toHaveProperty('error');
  expect(manifest.runs[0]).not.toHaveProperty('runDir');
  expect(manifest.runs[0]).toMatchObject({ agentLabel: 'Felan full', comparisonId: 'felan-full', score: 0.9, assertionPassRate: 1, verifierReward: 1 });
  expect(manifest.agents).toEqual(['a-agent', 'z-agent']);
  expect(manifest.label).toBe('<unsafe>');
});

test('public projection carries agent identity and derives batch package versions', () => {
  const batch = { batchId: '20260101-010203-abcd', synthetic: false, runCount: 3 };
  const manifest = projectPublicBatch(batch, [
    fakeRun({ runId: 'a', agentName: 'felan-cbm-on', provider: 'openai-codex', model: 'gpt-5.6-sol', thinking: 'max', packageVersion: '0.19.2' }),
    fakeRun({ runId: 'b', agentName: 'felan-cbm-off', packageVersion: '0.19.2' }),
    // Same agent, a different build: the batch cannot claim one version for it.
    fakeRun({ runId: 'c', agentName: 'felan-cbm-off', packageVersion: '0.19.1' }),
  ]);

  expect(manifest.runs.find((run) => run.runId === 'a')).toMatchObject({
    provider: 'openai-codex', model: 'gpt-5.6-sol', thinking: 'max', packageVersion: '0.19.2',
  });
  expect(manifest.provenance?.agentPackageVersions).toEqual({ 'felan-cbm-on': '0.19.2' });
});

test('caller-supplied provenance wins over versions derived from runs', () => {
  const batch = { batchId: '20260101-010203-abcd', synthetic: false, runCount: 1 };
  const manifest = projectPublicBatch(
    batch,
    [fakeRun({ runId: 'a', agentName: 'felan', packageVersion: '0.19.2' })],
    { provenance: { harnessEvalsVersion: '0.2.8', agentPackageVersions: { felan: '0.20.0' } } },
  );

  expect(manifest.provenance).toEqual({ harnessEvalsVersion: '0.2.8', agentPackageVersions: { felan: '0.20.0' } });
});

test('a batch with no recorded agent build reports no provenance at all', () => {
  const batch = { batchId: '20260101-010203-abcd', synthetic: false, runCount: 1 };
  const manifest = projectPublicBatch(batch, [fakeRun({ runId: 'a' })]);

  expect(manifest.provenance).toBeUndefined();
});

test('file public store rejects unsafe keys and supports mutable catalog objects', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harness-evals-public-store-'));
  tempDirs.push(root);
  const store = new FilePublicResultsStore(root);
  const content = new TextEncoder().encode('hello');

  await store.put('v1/index.json', content, { contentType: 'application/json' });
  await store.put('v1/index.json', new TextEncoder().encode('updated'), { contentType: 'application/json' });
  expect(new TextDecoder().decode(await store.get('v1/index.json'))).toBe('updated');
  expect((await readdir(join(root, 'v1'))).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  expect(await store.list('v1')).toEqual(['v1/index.json']);
  await store.put('v1/batch/manifest.json', content, { contentType: 'application/json' });
  await store.put('v1/batch/manifest.json', new TextEncoder().encode('different'), { contentType: 'text/plain' });
  await expect(store.get('../outside')).rejects.toThrow('Unsafe public result key');
  await expect(store.put('/outside', content, { contentType: 'text/plain' })).rejects.toThrow('Unsafe public result key');
  await expect(store.list('v1/')).rejects.toThrow('Unsafe public result key');
});

test('file public store reads do not create an absent store root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harness-evals-public-store-'));
  tempDirs.push(root);
  const storeRoot = join(root, 'absent');
  const store = new FilePublicResultsStore(storeRoot);

  expect(await store.get('v1/index.json')).toBeUndefined();
  expect(await store.list('v1')).toEqual([]);
  await expect(access(storeRoot)).rejects.toThrow();
});

test('file public store cleans up temporary files when atomic replacement fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harness-evals-public-store-'));
  tempDirs.push(root);
  const store = new FilePublicResultsStore(root);
  const target = join(root, 'v1', 'directory-target');
  await mkdir(target, { recursive: true });

  await expect(store.put('v1/directory-target', new TextEncoder().encode('content'), { contentType: 'text/plain' })).rejects.toThrow();

  expect((await readdir(join(root, 'v1'))).filter((name) => name.endsWith('.tmp'))).toEqual([]);
});

test('public totals keep skipped, timeout, and incomplete runs distinct', () => {
  const batch = { batchId: '20260101-010203-abcd', synthetic: false, runCount: 3 };
  const manifest = projectPublicBatch(batch, [
    fakeRun({ runId: 'skipped', status: 'skipped', pass: false }),
    fakeRun({ runId: 'timeout', status: 'timeout', pass: false }),
    fakeRun({ runId: 'incomplete', status: 'incomplete', pass: false }),
  ]);

  expect(manifest.totals).toMatchObject({ runs: 3, skipped: 1, timeouts: 1, incomplete: 1 });
});

test('CSV and HTML render compact public data with escaped dynamic strings', () => {
  const manifest = projectPublicBatch({ batchId: '20260101-010203-abcd', label: '<unsafe>', synthetic: false, runCount: 1 }, [fakeRun({ caseId: '<case>,', agentName: 'agent&', suite: 'suite', assertionPassRate: 0.5 })]);
  const csv = renderPublicBatchCsv(manifest);
  expect(csv).toContain('runId,caseId,agentName');
  expect(csv).toContain('"<case>,"');
  expect(csv.split('\n', 1)[0]).not.toContain(',pass,');
  expect(csv).toContain('comparisonId');
  expect(csv).toContain('assertionPassRate');
  const html = renderPublicBatchHtml(manifest);
  expect(html).toContain('&lt;unsafe&gt;');
  expect(html).not.toContain('<title><unsafe>');
  expect(html).toContain('data-agent="agent&amp;"');
  expect(html).toContain('\\u003Ccase\\u003E');
  expect(html).not.toContain('<th>Pass</th>');
  expect(html).toContain('<th scope="row">Assertions</th>');
  expect(html).toContain('<span>Skipped</span>');
  expect(html).toContain('<span>Timeouts</span>');
  expect(html).toContain('class="metric-matrix"');
  expect(html).toContain('<strong>agent&amp;</strong>');
  const index = renderPublicIndexHtml();
  expect(index).toContain("fetch('./index.json')");
  expect(index).toContain('Latest results');
  expect(index).toContain('All runs / attempts');
  expect(index).toContain('fetch(safeHref(batch.manifestPath))');
  expect(index).toContain('superseded');
  expect(index).toContain('latest');
  expect(index).toContain('--brand: 152 44% 26%');
  expect(index).toContain(':root.dark');
  expect(index).toContain('.brand img');
  expect(index).toContain('data:image/svg+xml;base64,PD94bWwgdmVyc2lvbj0iMS4wIj8+');
  expect(index).not.toContain('fonts.googleapis.com');
  expect(index).toContain('suite-group');
  expect(index).toContain('case-group');
  expect(index).toContain('participant');
  expect(index).toContain("table.className='metric-matrix'");
  expect(index).toContain("text(row,'Status','th')");
  expect(index).toContain("text(cell,name,'strong')");
  expect(index).not.toContain("card.className='comparison-card'");
  expect(index).not.toContain('<th>Pass</th>');
  expect(index).toContain("run.comparisonId??run.agentName");
  expect(index).toContain("const statusTotals={passed:'passed',failed:'failed',error:'errors',skipped:'skipped',timeout:'timeouts',incomplete:'incomplete'}");
  expect(index).toContain('batch.totals[statusTotals[fields.status.value]]>0');
  expect(index).not.toContain('run.status===fields.status.value');
  expect(index).toContain("['Skipped',counts.skipped]");
  expect(index).toContain("['Timeouts',counts.timeouts]");
  expect(index).toContain("['Incomplete',counts.incomplete]");
});

test('legacy manifests use agentName when comparisonId is absent', () => {
  const manifest = projectPublicBatch({ batchId: '20260101-010203-abcd', synthetic: false, runCount: 1 }, [fakeRun({ agentName: 'legacy-agent' })]);
  delete manifest.runs[0]?.comparisonId;
  const html = renderPublicBatchHtml(manifest);
  const csv = renderPublicBatchCsv(manifest);
  expect(html).toContain('legacy-agent');
  expect(csv).toContain(',legacy-agent,,legacy-agent,');
});

function fakeRun(overrides: Partial<ScannedTaskRun> = {}): ScannedTaskRun {
  return {
    runId: 'run',
    runDir: '/tmp/private-run',
    batchId: '20260101-010203-abcd',
    batchSynthetic: false,
    caseId: 'case',
    agentName: 'agent',
    status: 'passed',
    pass: true,
    hasIndexHtml: true,
    ...overrides,
  };
}
