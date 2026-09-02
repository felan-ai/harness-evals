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
  expect(report.comparison.cases[0]?.attempts.map((attempt) => attempt.attemptNumber)).toEqual([1, 2, 3]);
  expect(report.comparison).toMatchObject({
    averageChangePercent: 25,
    minChangePercent: -50,
    maxChangePercent: 100,
    averageImprovementPercent: -25,
    minImprovementPercent: -100,
    maxImprovementPercent: 50,
    comparedCases: 2,
    expectedCases: 2,
  });
  expect(report.comparison.cases[0]).toMatchObject({ changePercent: 100, improvementPercent: -100 });
  const html = renderBenchmarkIndexHtml([report]);
  expect(html.match(/class="benchmark-row"/g)).toHaveLength(1);
  expect(html).toContain('<h1>Benchmarks</h1>');
  expect(html).toContain('Average change +25.0%; range -50.0% to +100.0% across 2 tests; unfavorable');
  expect(html).toContain('<span class="status-text bad">unfavorable</span>');
  expect(html).not.toContain('<small>unfavorable</small>');
  expect(html).toContain('-50.0% to +100.0%');
  expect(html).toContain('class="change-range"');
  expect(html).toContain('--range-left:0.0000%;--range-width:100.0000%');
  const detailHtml = renderBenchmarkHtml(report);
  expect(detailHtml).toContain('<h2>Tests</h2>');
  expect(detailHtml.match(/<details class="test-block">/g)).toHaveLength(2);
  expect(detailHtml.match(/<summary class="test-summary"/g)).toHaveLength(2);
  expect(detailHtml.match(/<\/summary><div class="attempt-list">/g)).toHaveLength(2);
  expect(detailHtml.match(/class="attempt-row"/g)).toHaveLength(6);
  expect(detailHtml).toContain('<span>Attempt 1</span>');
  expect(detailHtml).not.toContain('>Assessment<');
  expect(detailHtml).not.toContain('<caption>Attempts for');
  expect(detailHtml).not.toContain('<th scope="col">Attempt</th>');
  expect(renderBenchmarkCsv(report)).toContain('changePercent,improvementPercent,averageChangePercent,minChangePercent,maxChangePercent');
  expect(renderBenchmarkCsv(report)).not.toContain('gain');
  expect(renderBenchmarkJson(report)).toContain('"comparison"');
  expect(renderBenchmarkJson(report)).not.toContain('"gain"');
});

test('benchmark analyzer reports incomplete and quality regression arms', () => {
  const report = analyzeBenchmark({
    id: 'cost',
    definition,
    runs: [run('base', 'one', 1, 1), run('candidate', 'one', 1, 1, false)],
  });
  expect(report.baseline.state).toBe('incomplete');
  expect(report.candidate.state).toBe('incomplete');
  expect(report.comparison.averageChangePercent).toBeUndefined();
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
  const attempt = report.comparison.cases[0]?.attempts[0];
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

test('benchmark improvements respect maximize objectives', () => {
  const maximize = { ...definition, objective: { metric: 'cost.total', goal: 'maximize' as const } };
  const runs = [
    ...[1, 2, 3].map((attempt) => run('base', 'one', attempt, attempt)),
    ...[1, 2, 3].map((attempt) => run('base', 'two', attempt, 10 + attempt)),
    ...[1, 2, 3].map((attempt) => run('candidate', 'one', attempt, 2 + attempt)),
    ...[1, 2, 3].map((attempt) => run('candidate', 'two', attempt, 4 + attempt)),
  ];
  const report = analyzeBenchmark({ id: 'maximize-change', definition: maximize, runs });
  expect(report.comparison).toMatchObject({
    averageChangePercent: 25,
    minChangePercent: -50,
    maxChangePercent: 100,
    averageImprovementPercent: 25,
    minImprovementPercent: -50,
    maxImprovementPercent: 100,
  });
});

test('a collapsed test range does not draw a line at the bar endpoint', () => {
  const singleCase = { ...definition, select: { cases: ['one'] } };
  const runs = [
    ...[1, 2, 3].map((attempt) => run('base', 'one', attempt, 10)),
    ...[1, 2, 3].map((attempt) => run('candidate', 'one', attempt, 5)),
  ];
  const html = renderBenchmarkIndexHtml([analyzeBenchmark({ id: 'change', definition: singleCase, runs })]);
  expect(html).not.toContain('class="change-range"');
});

test('favorable home-page changes rely on the green value without a label', () => {
  const singleCase = { ...definition, select: { cases: ['one'] } };
  const runs = [
    ...[1, 2, 3].map((attempt) => run('base', 'one', attempt, 10)),
    ...[1, 2, 3].map((attempt) => run('candidate', 'one', attempt, 5)),
  ];
  const html = renderBenchmarkIndexHtml([analyzeBenchmark({ id: 'favorable', definition: singleCase, runs })]);
  expect(html).toContain('<strong class="change-value positive">-50.0%</strong>');
  expect(html).not.toContain('>favorable</span>');
  expect(html).not.toContain('<small>favorable</small>');
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

test('change direction remains visible when a quality gate fails', () => {
  const singleCase = { ...definition, select: { cases: ['one'] } };
  const runs = [
    ...[1, 2, 3].map((attempt) => run('base', 'one', attempt, 10)),
    run('candidate', 'one', 1, 5), run('candidate', 'one', 2, 5), run('candidate', 'one', 3, 5, false),
  ];
  const report = analyzeBenchmark({ id: 'change-with-regression', definition: singleCase, runs });
  expect(report.candidate.state).toBe('quality regression');

  const html = `${renderBenchmarkIndexHtml([report])}${renderBenchmarkHtml(report)}`;
  expect(html).toContain('class="change-value negative">-50.0%');
  expect(html).toContain('class="change-chart negative"');
  expect(html).toContain('class="status-text bad">quality regression</span>');
  expect(html).toContain('class="quality bad">Failed');
});

test('benchmark-wide quality regression does not relabel passing tests and attempts', () => {
  const runs = [
    ...[1, 2, 3].map((attempt) => run('base', 'one', attempt, 10)),
    ...[1, 2, 3].map((attempt) => run('base', 'two', attempt, 10)),
    run('candidate', 'one', 1, 5, false), run('candidate', 'one', 2, 5), run('candidate', 'one', 3, 5),
    ...[1, 2, 3].map((attempt) => run('candidate', 'two', attempt, 5)),
  ];
  const report = analyzeBenchmark({ id: 'local-assessment', definition, runs });
  expect(report.candidate.state).toBe('quality regression');

  const html = renderBenchmarkHtml(report);
  const passingTest = html.match(/<details class="test-block"><summary[^>]*><span class="test-name">two<\/span>[\s\S]*?<\/details>/)?.[0];
  expect(passingTest).toBeDefined();
  expect(passingTest).toContain('class="change-value positive">-50.0%');
  expect(passingTest).toContain('aria-label="Raw change -50.0%; favorable"');
  expect(passingTest).not.toContain('<span>favorable</span>');
  expect(passingTest).not.toContain('quality regression');
});

test('zero change uses a neutral style', () => {
  const singleCase = { ...definition, select: { cases: ['one'] } };
  const runs = [
    ...[1, 2, 3].map((attempt) => run('base', 'one', attempt, 10)),
    ...[1, 2, 3].map((attempt) => run('candidate', 'one', attempt, 10)),
  ];
  const report = analyzeBenchmark({ id: 'no-change', definition: singleCase, runs });
  const html = `${renderBenchmarkIndexHtml([report])}${renderBenchmarkHtml(report)}`;
  expect(html).toContain('class="change-value neutral">0.0%');
  expect(html).toContain('class="change-chart neutral"');
});

test('raw change stays unavailable when the baseline is zero', () => {
  const singleCase = { ...definition, select: { cases: ['one'] }, trials: 1 };
  const report = analyzeBenchmark({ id: 'zero-baseline', definition: singleCase, runs: [run('base', 'one', 1, 0), run('candidate', 'one', 1, 1)] });
  expect(report.candidate.deltas['cost.total']).toBe(1);
  expect(report.comparison.cases[0]?.changePercent).toBeUndefined();
  const html = `${renderBenchmarkIndexHtml([report])}${renderBenchmarkHtml(report)}`;
  expect(html).toContain('Change unavailable');
  expect(html).toContain('Change vs baseline');
});

test('tiny raw changes retain their sign and precision', () => {
  const singleCase = { ...definition, select: { cases: ['one'] }, trials: 1 };
  const report = analyzeBenchmark({ id: 'tiny-change', definition: singleCase, runs: [run('base', 'one', 1, 100), run('candidate', 'one', 1, 99.99)] });
  expect(renderBenchmarkHtml(report)).toContain('-0.01%');
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
  expect(report.comparison.averageChangePercent).toBeUndefined();
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

test('invalid attempts are excluded from quality gates without making the matrix incomplete', () => {
  const runs = [
    ...[1, 2, 3].map((attempt) => run('base', 'one', attempt, attempt)),
    ...[1, 2, 3].map((attempt) => run('base', 'two', attempt, attempt)),
    ...[1, 2, 3].map((attempt) => run('candidate', 'one', attempt, attempt)),
    ...[1, 2, 3].map((attempt) => run('candidate', 'two', attempt, attempt)),
  ];
  const invalid = runs.find((entry) => entry.agentName === 'candidate' && entry.caseId === 'one' && entry.attemptNumber === 1);
  if (!invalid) throw new Error('missing test run');
  invalid.status = 'invalid';
  invalid.pass = false;
  invalid.failures = { categories: ['infrastructure'] };
  delete invalid.metrics?.['quality.passRate'];

  const report = analyzeBenchmark({ id: 'cost', definition: { ...definition, qualityGates: [{ metric: 'quality.passRate', min: 0.8 }] }, runs });
  expect(report.candidate.state).toBe('eligible');
  expect(report.candidate.gateResults[0]?.value).toBe(1);
  expect(report.comparison.cases[0]?.attempts[0]?.candidateQuality?.status).toBe('invalid');
  const html = renderBenchmarkHtml(report);
  expect(html).toContain('Invalid · infrastructure');
  expect(html).toContain('invalid grading');
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
