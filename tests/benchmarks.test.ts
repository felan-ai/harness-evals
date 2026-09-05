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
  objective: [{ metric: 'cost.total', goal: 'minimize' }],
  aggregation: { trials: 'median', cases: 'macroMean' },
};

function run(agentName: string, caseId: string, attemptNumber: number, cost: number, pass = true, extraMetrics: Record<string, number> = {}): ScannedTaskRun {
  return {
    runId: `${agentName}-${caseId}-${attemptNumber}`,
    batchId: '20260101-010203-abcd',
    batchSynthetic: false,
    caseId,
    agentName,
    comparisonId: agentName === 'base' ? 'base-id' : 'candidate-id',
    attemptNumber,
    attempts: 3,
    status: pass ? 'passed' : 'failed',
    pass,
    metrics: { 'cost.total': cost, 'quality.passRate': pass ? 1 : 0, ...extraMetrics },
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
    averageGainPercent: -25,
    minGainPercent: -100,
    maxGainPercent: 50,
    comparedCases: 2,
    expectedCases: 2,
  });
  expect(report.comparison.cases[0]).toMatchObject({ changePercent: 100, gainPercent: -100 });
  const html = renderBenchmarkIndexHtml([report]);
  expect(html.match(/class="benchmark-row"/g)).toHaveLength(1);
  expect(html).toContain('<h1>Benchmarks</h1>');
  expect(html).toContain('Average outcome -25.0%; range -100.0% to +50.0% across 2 tests; unfavorable');
  expect(html).toContain('<span class="status-text bad">unfavorable</span>');
  expect(html).not.toContain('<small>unfavorable</small>');
  expect(html).toContain('-100.0% to +50.0%');
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
  expect(renderBenchmarkCsv(report)).toContain('changePercent,gainPercent,objectiveRole,objectiveGoal,caseReducer,averageChangePercent,minChangePercent,maxChangePercent');
    expect(renderBenchmarkJson(report)).toContain('"comparison"');
  expect(renderBenchmarkJson(report)).not.toContain('"gain"');
});

test('ratio of reduced sums keeps macro diagnostics and uses asymmetric reduced case totals', () => {
  const ratioDefinition: BenchmarkDefinition = {
    ...definition,
    aggregation: { trials: 'median', cases: 'ratioOfReducedSums' },
  };
  const runs = [
    ...[1, 3, 5].map((cost, index) => run('base', 'one', index + 1, cost)),
    ...[100, 100, 110].map((cost, index) => run('base', 'two', index + 1, cost)),
    ...[2, 4, 6].map((cost, index) => run('candidate', 'one', index + 1, cost)),
    ...[80, 80, 90].map((cost, index) => run('candidate', 'two', index + 1, cost)),
  ];

  const report = analyzeBenchmark({ id: 'cost-ratio', definition: ratioDefinition, runs });

  expect(report.baseline.values['cost.total']).toBe(51.5);
  expect(report.candidate.values['cost.total']).toBe(42);
  expect(report.candidate.deltas['cost.total']).toBe(-9.5);
  expect(report.comparison).toMatchObject({
    baselineReducedSum: 103,
    candidateReducedSum: 84,
    aggregateChangePercent: (84 - 103) / 103 * 100,
    aggregateGainPercent: (103 - 84) / 103 * 100,
  });
  expect(report.comparison.averageGainPercent).toBeCloseTo(((-100 / 3) + 20) / 2, 12);
  expect(report.comparison.cases.map((item) => [item.baselineValue, item.candidateValue])).toEqual([
    [3, 4],
    [100, 80],
  ]);
  expect(report.comparison.cases[0]?.gainPercent).toBeCloseTo(-100 / 3, 12);
  expect(report.comparison.cases[1]?.gainPercent).toBe(20);

  const json = renderBenchmarkJson(report);
  expect(json).toContain('"baselineReducedSum": 103');
  expect(json).toContain('"aggregateGainPercent"');
  const csv = renderBenchmarkCsv(report);
  expect(csv.split('\n', 1)[0]).toEndWith('baselineReducedSum,candidateReducedSum,aggregateChangePercent,aggregateGainPercent');
  expect(csv).toContain(',103,84,-18.446601941747574,18.446601941747574');
  const html = renderBenchmarkHtml(report);
  expect(html).toContain('Ratio of reduced sums');
  expect(html).toContain('Aggregate outcome');
  expect(html).toContain('Case range (macro mean)');
});

test('ratio of reduced sums applies the configured mean or median trial reducer', () => {
  const values = (trials: 'mean' | 'median') => analyzeBenchmark({
    id: `cost-${trials}`,
    definition: { ...definition, aggregation: { trials, cases: 'ratioOfReducedSums' } },
    runs: [
      ...[1, 9, 9].map((cost, index) => run('base', 'one', index + 1, cost)),
      ...[3, 3, 3].map((cost, index) => run('base', 'two', index + 1, cost)),
      ...[2, 8, 8].map((cost, index) => run('candidate', 'one', index + 1, cost)),
      ...[4, 4, 4].map((cost, index) => run('candidate', 'two', index + 1, cost)),
    ],
  });

  expect(values('mean').comparison.baselineReducedSum).toBe(3 + 19 / 3);
  expect(values('mean').comparison.candidateReducedSum).toBe(10);
  expect(values('median').comparison.baselineReducedSum).toBe(12);
  expect(values('median').comparison.candidateReducedSum).toBe(12);
});

test('ratio of reduced sums handles maximize goals, zero totals, and incomplete coverage', () => {
  const maximizeDefinition: BenchmarkDefinition = {
    ...definition,
    trials: 1,
    objective: [{ metric: 'cost.total', goal: 'maximize' }],
    aggregation: { trials: 'median', cases: 'ratioOfReducedSums' },
  };
  const maximize = analyzeBenchmark({
    id: 'maximize',
    definition: maximizeDefinition,
    runs: [run('base', 'one', 1, 10), run('base', 'two', 1, 20), run('candidate', 'one', 1, 15), run('candidate', 'two', 1, 30)],
  });
  expect(maximize.comparison).toMatchObject({ baselineReducedSum: 30, candidateReducedSum: 45, aggregateChangePercent: 50, aggregateGainPercent: 50 });

  const zero = analyzeBenchmark({
    id: 'zero',
    definition: { ...definition, trials: 1, aggregation: { trials: 'median', cases: 'ratioOfReducedSums' } },
    runs: [run('base', 'one', 1, -1), run('base', 'two', 1, 1), run('candidate', 'one', 1, -2), run('candidate', 'two', 1, 2)],
  });
  expect(zero.comparison).toMatchObject({ baselineReducedSum: 0, candidateReducedSum: 0 });
  expect(zero.comparison.aggregateChangePercent).toBeUndefined();
  expect(zero.comparison.aggregateGainPercent).toBeUndefined();
  expect(renderBenchmarkHtml(zero)).toContain('Aggregate outcome —');

  const zeroCase = analyzeBenchmark({
    id: 'zero-case',
    definition: { ...definition, trials: 1, aggregation: { trials: 'median', cases: 'ratioOfReducedSums' } },
    runs: [run('base', 'one', 1, 0), run('base', 'two', 1, 2), run('candidate', 'one', 1, 1), run('candidate', 'two', 1, 1)],
  });
  expect(zeroCase.comparison).toMatchObject({ baselineReducedSum: 2, candidateReducedSum: 2, aggregateChangePercent: 0 });
  expect(zeroCase.comparison.aggregateGainPercent).toBeCloseTo(0, 12);
  expect(zeroCase.comparison.cases[0]?.changePercent).toBeUndefined();

  const incomplete = analyzeBenchmark({
    id: 'incomplete',
    definition: { ...definition, aggregation: { trials: 'median', cases: 'ratioOfReducedSums' } },
    runs: [run('base', 'one', 1, 1), run('base', 'one', 2, 1), run('candidate', 'one', 1, 1)],
  });
  expect(incomplete.baseline.state).toBe('incomplete');
  expect(incomplete.candidate.state).toBe('incomplete');
  expect(incomplete.comparison.baselineReducedSum).toBeUndefined();
  expect(incomplete.comparison.candidateReducedSum).toBeUndefined();
  expect(incomplete.comparison.aggregateGainPercent).toBeUndefined();
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

test('benchmark objectives report primary and secondary gains and retain every metric', () => {
  const twoObjectives: BenchmarkDefinition = {
    ...definition,
    objective: [
      { metric: 'cost.total', goal: 'minimize' },
      { metric: 'usage.promptTokens', goal: 'minimize' },
    ],
    select: { cases: ['one'] },
    trials: 1,
  };
  const runs = [
    run('base', 'one', 1, 10, true, { 'usage.promptTokens': 1_000, 'usage.outputTokens': 200, 'usage.requests': 3, 'duration.ms': 900 }),
    run('candidate', 'one', 1, 5, true, { 'usage.promptTokens': 500, 'usage.outputTokens': 150, 'usage.requests': 2, 'duration.ms': 700 }),
  ];
  const report = analyzeBenchmark({ id: 'rtk', definition: twoObjectives, runs });
  expect(report.objectiveComparisons.map((item) => [item.role, item.metric, item.averageGainPercent])).toEqual([
    ['primary', 'cost.total', 50],
    ['secondary', 'usage.promptTokens', 50],
  ]);
  expect(report.baseline.values).toMatchObject({ 'usage.outputTokens': 200, 'usage.requests': 3, 'duration.ms': 900 });
  expect(report.candidate.deltas).toMatchObject({ 'usage.promptTokens': -500, 'usage.outputTokens': -50, 'usage.requests': -1, 'duration.ms': -200 });
  const html = renderBenchmarkHtml(report);
  expect(html).toContain('primary outcome');
  expect(html).toContain('Prompt tokens');
  expect(html).toContain('Output tokens');
  expect(html).toContain('Requests');
  expect(html).toContain('<h2>Metrics</h2>');
  expect(html).toContain('<th scope="col"><span class="arm-heading">base-id');
  expect(html).toContain('<th scope="col"><span class="arm-heading">candidate-id');
  expect(html).toContain('<th scope="row">Output tokens</th><td>200 tokens</td><td>150 tokens</td><td>-50 tokens</td>');
  expect(html).not.toContain('<h2>Arms</h2>');
  expect(html).not.toContain('All metrics');
  expect(html).not.toContain('Raw change');
  expect(html).not.toContain('Gain');
  const indexHtml = renderBenchmarkIndexHtml([report]);
  expect(indexHtml).toContain('<span>Secondary objective</span>');
  expect(indexHtml).toContain('<span class="secondary-outcome positive" aria-label="Secondary outcome: 50.0% fewer prompt tokens; favorable">50.0% fewer prompt tokens</span>');
  expect(indexHtml).not.toContain('<span>Range</span>');
  expect(renderBenchmarkJson(report)).toContain('"role": "secondary"');
  expect(renderBenchmarkCsv(report)).toContain('usage.promptTokens');
});

test('secondary home-page outcomes describe direction and use unfavorable and neutral colors', () => {
  const twoObjectives: BenchmarkDefinition = {
    ...definition,
    objective: [
      { metric: 'cost.total', goal: 'minimize' },
      { metric: 'usage.promptTokens', goal: 'minimize' },
    ],
    select: { cases: ['one'] },
    trials: 1,
  };
  const unfavorable = analyzeBenchmark({
    id: 'secondary-unfavorable',
    definition: twoObjectives,
    runs: [
      run('base', 'one', 1, 10, true, { 'usage.promptTokens': 1_000 }),
      run('candidate', 'one', 1, 5, true, { 'usage.promptTokens': 1_500 }),
    ],
  });
  const neutral = analyzeBenchmark({
    id: 'secondary-neutral',
    definition: twoObjectives,
    runs: [
      run('base', 'one', 1, 10, true, { 'usage.promptTokens': 1_000 }),
      run('candidate', 'one', 1, 5, true, { 'usage.promptTokens': 1_000 }),
    ],
  });
  const maximize = analyzeBenchmark({
    id: 'secondary-maximize',
    definition: { ...twoObjectives, objective: [twoObjectives.objective[0], { metric: 'usage.promptTokens', goal: 'maximize' }] },
    runs: [
      run('base', 'one', 1, 10, true, { 'usage.promptTokens': 1_000 }),
      run('candidate', 'one', 1, 5, true, { 'usage.promptTokens': 1_500 }),
    ],
  });
  const html = renderBenchmarkIndexHtml([unfavorable, neutral, maximize]);
  expect(html).toContain('<span class="secondary-outcome negative" aria-label="Secondary outcome: 50.0% more prompt tokens; unfavorable">50.0% more prompt tokens</span>');
  expect(html).toContain('<span class="secondary-outcome neutral" aria-label="Secondary outcome: No change in prompt tokens; no change">No change in prompt tokens</span>');
  expect(html).toContain('<span class="secondary-outcome positive" aria-label="Secondary outcome: 50.0% more prompt tokens; favorable">50.0% more prompt tokens</span>');
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
  const maximize: BenchmarkDefinition = { ...definition, objective: [{ metric: 'cost.total', goal: 'maximize' }] };
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
    averageGainPercent: 25,
    minGainPercent: -50,
    maxGainPercent: 100,
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
  expect(html).toContain('<strong class="change-value positive">+50.0%</strong>');
  expect(html).not.toContain('>favorable</span>');
  expect(html).not.toContain('<small>favorable</small>');
  expect(html).toContain('<span class="secondary-outcome muted" aria-label="No secondary objective">—</span>');
  expect(html).not.toContain('<span>Range</span>');
  expect(html.toLowerCase()).not.toContain('gain');
  expect(html.toLowerCase()).not.toContain('raw change');
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
  expect(html).toContain('class="change-value negative">+50.0%</strong>');
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
  expect(passingTest).toContain('class="change-value positive">+50.0%');
  expect(passingTest).toContain('aria-label="Outcome +50.0%; favorable"');
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
  expect(html).toContain('class="change-value neutral">0.0%</strong>');
  expect(html).toContain('class="change-chart neutral"');
});

test('raw change stays unavailable when the baseline is zero', () => {
  const singleCase = { ...definition, select: { cases: ['one'] }, trials: 1 };
  const report = analyzeBenchmark({ id: 'zero-baseline', definition: singleCase, runs: [run('base', 'one', 1, 0), run('candidate', 'one', 1, 1)] });
  expect(report.candidate.deltas['cost.total']).toBe(1);
  expect(report.comparison.cases[0]?.changePercent).toBeUndefined();
  const html = `${renderBenchmarkIndexHtml([report])}${renderBenchmarkHtml(report)}`;
  expect(html).toContain('Change unavailable');
  expect(html).toContain('vs baseline');
});

test('tiny goal-aware outcomes retain their sign and precision', () => {
  const singleCase = { ...definition, select: { cases: ['one'] }, trials: 1 };
  const report = analyzeBenchmark({ id: 'tiny-change', definition: singleCase, runs: [run('base', 'one', 1, 100), run('candidate', 'one', 1, 99.99)] });
  expect(report.comparison.cases[0]?.changePercent).toBeCloseTo(-0.01);
  expect(report.comparison.cases[0]?.gainPercent).toBeCloseTo(0.01);
  expect(renderBenchmarkHtml(report)).toContain('+0.01%');
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
    objective: [{ metric: cost.total, goal: minimize }]
`);
    for (const [agentName, cost] of [['base', 4], ['candidate', 2]] as const) {
      const runDir = join(runs, `${agentName}-one-2026-01-01T00-00-00-000Z-0`);
      await mkdir(runDir, { recursive: true });
      await writeFile(join(runDir, 'summary.json'), JSON.stringify({ caseId: 'one', agentName, comparisonId: agentName, benchmark: { id: 'cost', revision: 1, digest: benchmarkDefinitionDigest('cost', { revision: 1, label: 'Cost', select: { cases: ['one'] }, arms: { baseline: 'base', candidate: 'candidate' }, trials: 1, qualityGates: [{ metric: 'quality.passRate', min: 1 }], objective: [{ metric: 'cost.total', goal: 'minimize' }], aggregation: { trials: 'median', cases: 'macroMean' } }) }, status: 'passed', pass: true, metrics: { 'quality.passRate': 1, 'cost.total': cost } }));
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
    const view = Bun.spawnSync(['bun', join(import.meta.dir, '..', 'src', 'cli.ts'), 'view', '--no-open', '--config', join(root, 'harness-evals.yaml')], { cwd: root });
    if (view.exitCode !== 0) throw new Error(new TextDecoder().decode(view.stderr));
    expect(new TextDecoder().decode(view.stdout).trim()).toBe(join(root, '.harness-evals', 'output', 'benchmarks', 'index.html'));
    expect(existsSync(join(root, '.harness-evals', 'output', 'benchmarks', 'index.html'))).toBe(true);
    expect(existsSync(join(root, '.harness-evals', 'output', 'report', 'index.html'))).toBe(false);
    expect(existsSync(stale)).toBe(false);

    const benchmarkRoot = join(root, '.harness-evals', 'output', 'benchmarks');
    await rm(benchmarkRoot, { recursive: true, force: true });
    const specificView = Bun.spawnSync(['bun', join(import.meta.dir, '..', 'src', 'cli.ts'), 'view', '--benchmark', 'cost', '--no-open', '--config', join(root, 'harness-evals.yaml')], { cwd: root });
    if (specificView.exitCode !== 0) throw new Error(new TextDecoder().decode(specificView.stderr));
    expect(new TextDecoder().decode(specificView.stdout).trim()).toBe(join(benchmarkRoot, 'cost', 'results.html'));
    expect(existsSync(join(benchmarkRoot, 'index.html'))).toBe(true);
    expect(await readFile(join(benchmarkRoot, 'cost', 'results.html'), 'utf8')).toContain('href="../index.html"');
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
