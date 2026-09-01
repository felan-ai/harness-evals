import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzeBenchmark } from '../src/benchmarks/analyze.js';
import { renderBenchmarkCsv, renderBenchmarkHtml, renderBenchmarkIndexHtml, renderBenchmarkJson } from '../src/benchmarks/render.js';
import { benchmarkDefinitionDigest, filterBenchmarkRuns } from '../src/benchmarks/select.js';
import type { BenchmarkDefinition } from '../src/config/schema.js';
import type { ScannedTaskRun } from '../src/visualization/scan.js';

const definition: BenchmarkDefinition = {
  revision: 1,
  label: 'Cost comparison',
  select: { cases: ['one', 'two'] },
  arms: { baseline: 'base', candidate: 'candidate' },
  trials: 3,
  qualityGates: [{ metric: 'quality.passRate', min: 1 }],
  objective: { metric: 'cost.total', goal: 'minimize' },
  aggregation: { trials: 'median', cases: 'macroMean' },
  secondaryMetrics: [],
};

function run(agentName: string, caseId: string, attemptNumber: number, cost: number, pass = true): ScannedTaskRun {
  return {
    runId: `${agentName}-${caseId}-${attemptNumber}`,
    runDir: '/runs',
    batchId: '20260101-010203-abcd',
    batchSynthetic: false,
    caseId,
    agentName,
    comparisonId: agentName === 'base' ? 'base-id' : 'candidate-id',
    attemptNumber,
    attempts: 3,
    status: pass ? 'passed' : 'failed',
    pass,
    metrics: { 'cost.total': cost, 'quality.passRate': pass ? 1 : 0 },
    hasIndexHtml: false,
  };
}

test('benchmark analyzer reduces trials, macro-averages cases, and computes baseline deltas', () => {
  const runs = [
    ...[1, 2, 3].map((attempt) => run('base', 'one', attempt, attempt)),
    ...[1, 2, 3].map((attempt) => run('base', 'two', attempt, 10 + attempt)),
    ...[1, 2, 3].map((attempt) => run('candidate', 'one', attempt, 2 + attempt)),
    ...[1, 2, 3].map((attempt) => run('candidate', 'two', attempt, 4 + attempt)),
  ];
  const report = analyzeBenchmark({ id: 'cost', definition, runs });
  expect(report.baseline.values['cost.total']).toBe(7);
  expect(report.candidate.values['cost.total']).toBe(5);
  expect(report.candidate.deltas['cost.total']).toBe(-2);
  expect(report.candidate.state).toBe('eligible');
  expect(report.candidate.cases[0]?.observations['cost.total']).toHaveLength(3);
  expect(report.gain.cases[0]?.attempts.map((attempt) => attempt.attemptNumber)).toEqual([1, 2, 3]);
  expect(report.gain).toMatchObject({ averagePercent: -25, minPercent: -100, maxPercent: 50, comparedCases: 2, expectedCases: 2 });
  const html = renderBenchmarkIndexHtml([report]);
  expect(html.match(/class="benchmark-row"/g)).toHaveLength(1);
  expect(html).toContain('<h1>Benchmarks</h1>');
  expect(html).toContain('Average gain -25.0%; range -100.0% to +50.0% across 2 tests');
  expect(html).toContain('-100.0% to +50.0%');
  expect(html).toContain('class="gain-range"');
  expect(html).not.toContain('class="gain-zero"');
  expect(html).not.toContain('class="gain-average"');
  const detailHtml = renderBenchmarkHtml(report);
  expect(detailHtml).toContain('<h2>Tests</h2>');
  expect(detailHtml.match(/<details class="test-block">/g)).toHaveLength(2);
  expect(detailHtml.match(/<summary class="test-summary"/g)).toHaveLength(2);
  expect(detailHtml.match(/class="attempt-row"/g)).toHaveLength(6);
  expect(detailHtml).toContain('<span>Attempt 1</span>');
  expect(renderBenchmarkCsv(report)).toContain('averageGainPercent,minGainPercent,maxGainPercent');
});

test('benchmark analyzer reports incomplete and quality regression arms', () => {
  const report = analyzeBenchmark({
    id: 'cost',
    definition,
    runs: [run('base', 'one', 1, 1), run('candidate', 'one', 1, 1, false)],
  });
  expect(report.baseline.state).toBe('incomplete');
  expect(report.candidate.state).toBe('incomplete');
  expect(report.gain.averagePercent).toBeUndefined();
});

test('benchmark reports identify failed attempts without raw diagnostics', () => {
  const failedBase = run('base', 'one', 1, 10, false);
  const maliciousAssertionId = '<img src=x onerror=alert(1)>';
  failedBase.failures = { categories: ['assertion'], failedAssertions: ['prewalk-entered', maliciousAssertionId] };
  failedBase.error = 'do not publish this error';
  const timedOutCandidate = run('candidate', 'one', 1, 5, false);
  timedOutCandidate.status = 'timeout';
  timedOutCandidate.failures = { categories: ['timeout', 'verifier'] };
  const report = analyzeBenchmark({
    id: 'diagnostics',
    definition: { ...definition, select: { cases: ['one'] }, trials: 1 },
    runs: [failedBase, timedOutCandidate],
  });
  const attempt = report.gain.cases[0]?.attempts[0];
  expect(attempt?.baselineQuality).toMatchObject({ status: 'failed', categories: ['assertion'], failedAssertions: ['prewalk-entered', maliciousAssertionId] });
  expect(attempt?.candidateQuality).toMatchObject({ status: 'timeout', categories: ['timeout', 'verifier'] });
  const html = renderBenchmarkHtml(report);
  expect(html).toContain('0/1 passed; 1 failed · assertion');
  expect(html).toContain('Failed · assertion');
  expect(html).toContain('Timed out');
  expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  expect(html).not.toContain(maliciousAssertionId);
  expect(renderBenchmarkJson(report)).toContain('prewalk-entered');
  expect(renderBenchmarkJson(report)).not.toContain('do not publish this error');
  const csv = renderBenchmarkCsv(report);
  expect(csv).toContain('rowType,benchmark,caseId,attemptNumber');
  expect(csv).toContain('attempt,diagnostics,one,1');
  expect(csv).toContain('prewalk-entered');
});

test('benchmark gains respect maximize objectives', () => {
  const maximize = { ...definition, objective: { metric: 'cost.total', goal: 'maximize' as const } };
  const runs = [
    ...[1, 2, 3].map((attempt) => run('base', 'one', attempt, attempt)),
    ...[1, 2, 3].map((attempt) => run('base', 'two', attempt, 10 + attempt)),
    ...[1, 2, 3].map((attempt) => run('candidate', 'one', attempt, 2 + attempt)),
    ...[1, 2, 3].map((attempt) => run('candidate', 'two', attempt, 4 + attempt)),
  ];
  const report = analyzeBenchmark({ id: 'gain', definition: maximize, runs });
  expect(report.gain).toMatchObject({ averagePercent: 25, minPercent: -50, maxPercent: 100 });
});

test('a collapsed test range does not draw a line at the bar endpoint', () => {
  const singleCase = { ...definition, select: { cases: ['one'] } };
  const runs = [
    ...[1, 2, 3].map((attempt) => run('base', 'one', attempt, 10)),
    ...[1, 2, 3].map((attempt) => run('candidate', 'one', attempt, 5)),
  ];
  const html = renderBenchmarkIndexHtml([analyzeBenchmark({ id: 'gain', definition: singleCase, runs })]);
  expect(html).not.toContain('class="gain-range"');
});

test('quality gates use every trial instead of the objective median', () => {
  const runs = [
    ...[1, 2, 3].map((attempt) => run('base', 'one', attempt, attempt)),
    ...[1, 2, 3].map((attempt) => run('base', 'two', attempt, attempt)),
    run('candidate', 'one', 1, 1), run('candidate', 'one', 2, 1), run('candidate', 'one', 3, 1, false),
    ...[1, 2, 3].map((attempt) => run('candidate', 'two', attempt, attempt)),
  ];
  const report = analyzeBenchmark({ id: 'cost', definition, runs });
  expect(report.candidate.state).toBe('quality regression');
  expect(report.candidate.gateResults[0]?.value).toBeCloseTo(5 / 6);
});

test('gain direction remains visible when a quality gate fails', () => {
  const singleCase = { ...definition, select: { cases: ['one'] } };
  const runs = [
    ...[1, 2, 3].map((attempt) => run('base', 'one', attempt, 10)),
    run('candidate', 'one', 1, 5), run('candidate', 'one', 2, 5), run('candidate', 'one', 3, 5, false),
  ];
  const report = analyzeBenchmark({ id: 'gain-with-regression', definition: singleCase, runs });
  expect(report.candidate.state).toBe('quality regression');

  const html = `${renderBenchmarkIndexHtml([report])}${renderBenchmarkHtml(report)}`;
  expect(html).toContain('class="gain-value positive">+50.0%');
  expect(html).toContain('class="gain-chart positive"');
  expect(html).toContain('class="status-text bad">quality regression</span>');
  expect(html).toContain('class="quality bad">Failed');
});

test('zero gain uses a neutral style', () => {
  const singleCase = { ...definition, select: { cases: ['one'] } };
  const runs = [
    ...[1, 2, 3].map((attempt) => run('base', 'one', attempt, 10)),
    ...[1, 2, 3].map((attempt) => run('candidate', 'one', attempt, 10)),
  ];
  const report = analyzeBenchmark({ id: 'no-change', definition: singleCase, runs });
  const html = `${renderBenchmarkIndexHtml([report])}${renderBenchmarkHtml(report)}`;
  expect(html).toContain('class="gain-value neutral">0.0%');
  expect(html).toContain('class="gain-chart neutral"');
});

test('benchmark reports require matching stamped provenance and exact attempts', () => {
  const benchmarkDefinition = { ...definition, select: { cases: ['one'] } };
  const digest = benchmarkDefinitionDigest('provenance', benchmarkDefinition);
  const matching = run('base', 'one', 1, 10);
  matching.benchmark = { id: 'provenance', revision: benchmarkDefinition.revision, digest };
  const stale = { ...matching, runId: 'stale', benchmark: { id: 'provenance', revision: 1, digest: 'old' } };
  const wrongRevision = { ...matching, runId: 'wrong-revision', benchmark: { id: 'provenance', revision: 2, digest } };
  expect(filterBenchmarkRuns([matching, stale, wrongRevision], 'provenance', benchmarkDefinition)).toEqual([matching]);

  const duplicateRuns = [
    run('base', 'one', 1, 10), run('base', 'one', 1, 11), run('base', 'one', 2, 10), run('base', 'one', 3, 10),
    ...[1, 2, 3].map((attempt) => run('candidate', 'one', attempt, 5)),
  ];
  const report = analyzeBenchmark({ id: 'provenance', definition: benchmarkDefinition, runs: duplicateRuns });
  expect(report.baseline.state).toBe('incomplete');
  expect(report.gain.averagePercent).toBeUndefined();
});

test('missing quality-gate observations make an arm incomplete', () => {
  const runs = [
    ...[1, 2, 3].map((attempt) => run('base', 'one', attempt, attempt)),
    ...[1, 2, 3].map((attempt) => run('base', 'two', attempt, attempt)),
    ...[1, 2, 3].map((attempt) => run('candidate', 'one', attempt, attempt)),
    ...[1, 2, 3].map((attempt) => run('candidate', 'two', attempt, attempt)),
  ];
  delete runs[0]?.metrics?.['quality.passRate'];
  const report = analyzeBenchmark({ id: 'cost', definition, runs });
  expect(report.baseline.state).toBe('incomplete');
});

test('reports expose both quality regression and incomplete states', () => {
  const runs = [
    run('base', 'one', 1, 1, false),
    ...[2, 3].map((attempt) => run('base', 'one', attempt, attempt)),
    ...[1, 2, 3].map((attempt) => run('base', 'two', attempt, attempt)),
    run('candidate', 'one', 1, 1),
  ];
  const report = analyzeBenchmark({ id: 'cost', definition, runs });
  expect(report.baseline.state).toBe('quality regression');
  expect(report.candidate.state).toBe('incomplete');
  const html = renderBenchmarkIndexHtml([report]);
  expect(html).toContain('>quality regression / incomplete</span>');
});

test('benchmark HTML stays minimal while JSON retains derived provenance', () => {
  const derivedRun = run('base', 'one', 1, 1);
  derivedRun.metricsSource = 'historical-derived';
  const report = analyzeBenchmark({ id: 'cost', definition, runs: [derivedRun] });
  const html = `${renderBenchmarkIndexHtml([report])}${renderBenchmarkHtml(report)}`;
  expect(html).not.toContain('Derived metrics');
  expect(html).not.toContain('Positive gain is better');
  expect(renderBenchmarkJson(report)).toContain('"derivedRunCount": 1');
});

test('benchmark CLI exports a report without running a provider', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harness-evals-benchmark-cli-'));
  try {
    const runs = join(root, '.harness-evals', 'runs');
    await mkdir(runs, { recursive: true });
    await mkdir(join(root, 'cases'), { recursive: true });
    await writeFile(join(root, 'cases', 'one.yaml'), 'id: one\nprompt: hi\nassert: []\n');
    await writeFile(join(root, 'harness-evals.yaml'), `version: 1
agents:
  base: { adapter: command, command: echo }
  candidate: { adapter: command, command: echo }
tests: [cases/*.yaml]
benchmarks:
  cost:
    label: Cost
    select: { cases: [one] }
    arms: { baseline: base, candidate: candidate }
    trials: 1
    qualityGates: [{ metric: quality.passRate, min: 1 }]
    objective: { metric: cost.total, goal: minimize }
`);
    for (const [agentName, cost] of [['base', 4], ['candidate', 2]] as const) {
      const runDir = join(runs, `${agentName}-one-2026-01-01T00-00-00-000Z-0`);
      await mkdir(runDir, { recursive: true });
      await writeFile(join(runDir, 'summary.json'), JSON.stringify({ caseId: 'one', agentName, comparisonId: agentName, benchmark: { id: 'cost', revision: 1, digest: benchmarkDefinitionDigest('cost', { revision: 1, label: 'Cost', select: { cases: ['one'] }, arms: { baseline: 'base', candidate: 'candidate' }, trials: 1, qualityGates: [{ metric: 'quality.passRate', min: 1 }], objective: { metric: 'cost.total', goal: 'minimize' }, aggregation: { trials: 'median', cases: 'macroMean' }, secondaryMetrics: [] }) }, status: 'passed', pass: true, metrics: { 'quality.passRate': 1, 'cost.total': cost } }));
    }
    const output = join(root, 'benchmark.json');
    const result = Bun.spawnSync(['bun', join(import.meta.dir, '..', 'src', 'cli.ts'), 'export', '--benchmark', 'cost', '--format', 'json', '--output', output, '--config', join(root, 'harness-evals.yaml')], { cwd: root });
    if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
    const report = JSON.parse(await readFile(output, 'utf8')) as { baseline: { values: Record<string, number> }; candidate: { values: Record<string, number>; deltas: Record<string, number> } };
    expect(report.baseline.values['cost.total']).toBe(4);
    expect(report.candidate.deltas['cost.total']).toBe(-2);

    const stale = join(root, '.harness-evals', 'output', 'benchmarks', 'stale');
    await mkdir(stale, { recursive: true });
    await writeFile(join(stale, 'results.html'), 'stale');
    const view = Bun.spawnSync(['bun', join(import.meta.dir, '..', 'src', 'cli.ts'), 'view', '--benchmark', 'all', '--no-open', '--config', join(root, 'harness-evals.yaml')], { cwd: root });
    if (view.exitCode !== 0) throw new Error(new TextDecoder().decode(view.stderr));
    expect(existsSync(join(root, '.harness-evals', 'output', 'benchmarks', 'index.html'))).toBe(true);
    expect(existsSync(stale)).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('CLI rejects malformed positive integer flags', () => {
  const cli = join(import.meta.dir, '..', 'src', 'cli.ts');
  const result = Bun.spawnSync(['bun', cli, 'list', '--attempts', '1foo'], { cwd: import.meta.dir });
  expect(result.exitCode).toBe(1);
  expect(new TextDecoder().decode(result.stderr)).toContain('--attempts must be a positive integer');
});
