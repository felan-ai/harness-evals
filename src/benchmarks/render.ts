import type { BenchmarkArmState, BenchmarkAttemptQuality, BenchmarkReportData } from './analyze.js';

export function renderBenchmarkJson(report: BenchmarkReportData): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function renderBenchmarkCsv(report: BenchmarkReportData): string {
  const rows = [[
    'rowType', 'benchmark', 'caseId', 'attemptNumber', 'metric', 'baselineArm', 'candidateArm',
    'baselineStatus', 'candidateStatus', 'baselineFailureCategories', 'candidateFailureCategories',
    'baselineFailedAssertions', 'candidateFailedAssertions',
    'baselineObservations', 'candidateObservations', 'baselineValue',
    'candidateValue', 'changePercent', 'gainPercent', 'objectiveRole', 'objectiveGoal',
    'averageChangePercent', 'minChangePercent', 'maxChangePercent',
    'averageGainPercent', 'minGainPercent', 'maxGainPercent',
  ]];
  const primaryObjective = report.definition.objective[0];
  const objective = primaryObjective.metric;
  for (const caseId of report.cases) {
    const baseline = report.baseline.cases.find((item) => item.caseId === caseId);
    const candidate = report.candidate.cases.find((item) => item.caseId === caseId);
    const metrics = new Set([...Object.keys(baseline?.observations ?? {}), ...Object.keys(candidate?.observations ?? {})]);
    for (const metric of metrics) {
      const objectiveComparison = report.objectiveComparisons.find((item) => item.metric === metric);
      const comparison = objectiveComparison?.cases.find((item) => item.caseId === caseId);
      rows.push([
        'test',
        report.id,
        caseId,
        '',
        metric,
        report.baseline.comparisonId,
        report.candidate.comparisonId,
        '', '', '', '', '', '',
        JSON.stringify(baseline?.observations[metric] ?? []),
        JSON.stringify(candidate?.observations[metric] ?? []),
        String(baseline?.values[metric] ?? ''),
        String(candidate?.values[metric] ?? ''),
        String(comparison?.changePercent ?? ''),
        String(comparison?.gainPercent ?? ''),
        objectiveComparison?.role ?? '',
        objectiveComparison?.goal ?? '',
        String(objectiveComparison?.averageChangePercent ?? ''),
        String(objectiveComparison?.minChangePercent ?? ''),
        String(objectiveComparison?.maxChangePercent ?? ''),
        String(objectiveComparison?.averageGainPercent ?? ''),
        String(objectiveComparison?.minGainPercent ?? ''),
        String(objectiveComparison?.maxGainPercent ?? ''),
      ]);
    }
    const comparison = report.comparison.cases.find((item) => item.caseId === caseId);
    for (const attempt of comparison?.attempts ?? []) {
      rows.push([
        'attempt', report.id, caseId, String(attempt.attemptNumber), objective,
        report.baseline.comparisonId, report.candidate.comparisonId,
        attempt.baselineQuality?.status ?? '', attempt.candidateQuality?.status ?? '',
        categories(attempt.baselineQuality), categories(attempt.candidateQuality),
        attempt.baselineQuality?.failedAssertions?.join('|') ?? '', attempt.candidateQuality?.failedAssertions?.join('|') ?? '',
        '', '', String(attempt.baselineValue ?? ''), String(attempt.candidateValue ?? ''),
        String(attempt.changePercent ?? ''), String(attempt.gainPercent ?? ''), 'primary', primaryObjective.goal, '', '', '', '', '',
      ]);
    }
  }
  return `${rows.map((row) => row.map(csv).join(',')).join('\n')}\n`;
}

export function renderBenchmarkHtml(report: BenchmarkReportData): string {
  const primaryObjective = report.definition.objective[0];
  const objective = primaryObjective.metric;
  const states = comparisonStates(report);
  const objectiveLabel = `${metricLabel(objective)} · ${primaryObjective.goal}`;
  const overallAssessment = assessment(report, report.comparison.averageGainPercent);
  const tests = report.comparison.cases.map((item) => {
    const attempts = item.attempts.map((attempt) => {
      const attemptAssessment = assessmentForQualities(attempt.gainPercent, [attempt.baselineQuality, attempt.candidateQuality]);
      const outcomeLabel = `Outcome ${formatPercent(attempt.gainPercent)}; ${formatAssessment(attemptAssessment)}`;
      return `<div class="attempt-row"><span>Attempt ${attempt.attemptNumber}</span><span>${formatMetric(objective, attempt.baselineValue)}<small class="quality ${qualityClass(attempt.baselineQuality)}">${escape(formatQuality(attempt.baselineQuality))}</small></span><span>${formatMetric(objective, attempt.candidateValue)}<small class="quality ${qualityClass(attempt.candidateQuality)}">${escape(formatQuality(attempt.candidateQuality))}</small></span><span class="change-value ${assessmentClass(attemptAssessment)}" aria-label="${escape(outcomeLabel)}">${formatPercent(attempt.gainPercent)}</span></div>`;
    }).join('');
    const baselineQuality = item.attempts.map((attempt) => attempt.baselineQuality).filter((quality): quality is BenchmarkAttemptQuality => quality !== undefined);
    const candidateQuality = item.attempts.map((attempt) => attempt.candidateQuality).filter((quality): quality is BenchmarkAttemptQuality => quality !== undefined);
    const itemAssessment = assessmentForQualities(item.gainPercent, [...baselineQuality, ...candidateQuality]);
    const label = `${item.caseId}: baseline ${formatMetric(objective, item.baselineValue)}, ${formatQualitySummary(baselineQuality)}; candidate ${formatMetric(objective, item.candidateValue)}, ${formatQualitySummary(candidateQuality)}; outcome ${formatPercent(item.gainPercent)}, ${formatAssessment(itemAssessment)}`;
    return `<details class="test-block"><summary class="test-summary" aria-label="${escape(label)}"><span class="test-name">${escape(item.caseId)}</span><span>${formatMetric(objective, item.baselineValue)}<small class="quality ${qualityClassForList(baselineQuality)}">${escape(formatQualitySummary(baselineQuality))}</small></span><span>${formatMetric(objective, item.candidateValue)}<small class="quality ${qualityClassForList(candidateQuality)}">${escape(formatQualitySummary(candidateQuality))}</small></span><span class="change-value ${assessmentClass(itemAssessment)}">${formatPercent(item.gainPercent)}</span></summary><div class="attempt-list">${attempts}</div></details>`;
  }).join('');
  const status = renderStatus(states);
  const reducer = capitalize(report.definition.aggregation.trials);
  const direction = primaryObjective.goal === 'minimize' ? 'lower' : 'higher';
  const objectiveSummaries = report.objectiveComparisons.map((comparison) => {
    const comparisonAssessment = assessment(report, comparison.averageGainPercent);
    const label = `${metricLabel(comparison.metric)} outcome ${formatPercent(comparison.averageGainPercent)}; ${formatAssessment(comparisonAssessment)}`;
    return `<div class="objective-card"><strong>${escape(metricLabel(comparison.metric))}</strong><span>${comparison.role} · ${comparison.goal}</span><b class="change-value ${assessmentClass(comparisonAssessment)}" aria-label="${escape(label)}">${formatPercent(comparison.averageGainPercent)}</b><small>range ${formatRange(comparison.minGainPercent, comparison.maxGainPercent)}</small></div>`;
  }).join('');
  const primaryLabel = `Primary outcome ${formatPercent(report.comparison.averageGainPercent)}; ${formatAssessment(overallAssessment)}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(report.definition.label)}</title><style>${styles()}</style></head><body><main><a class="back" href="../index.html">← Benchmarks</a><header class="detail-header"><h1>${escape(report.definition.label)}</h1><p class="pair">${escape(report.candidate.comparisonId)} vs ${escape(report.baseline.comparisonId)}</p><p class="objective">${escape(objectiveLabel)} · ${direction} is better</p><div class="result-line"><span class="result-stat"><strong class="change-value ${changeClass(report, report.comparison.averageGainPercent)}" aria-label="${escape(primaryLabel)}">${formatPercent(report.comparison.averageGainPercent)}</strong><span>primary outcome</span></span><span class="separator">·</span><span class="result-stat"><strong>${formatRange(report.comparison.minGainPercent, report.comparison.maxGainPercent)}</strong><span>range</span></span>${status}</div>${report.baseline.state === 'quality regression' || report.candidate.state === 'quality regression' ? '<p class="quality-warning">Quality regression — metric movement is shown for diagnosis; it is not a success signal.</p>' : ''}</header><section class="objective-grid">${objectiveSummaries}</section><section class="data-section"><h2>Metrics</h2>${renderMetricTable(report)}</section><section class="data-section"><h2>Tests</h2><div class="test-list"><div class="test-columns"><span>Test</span><span>Baseline (${reducer})</span><span>Candidate (${reducer})</span><span>vs baseline</span></div>${tests || '<p class="empty-list">No tests.</p>'}</div></section></main></body></html>\n`;
}

function renderMetricTable(report: BenchmarkReportData): string {
  const metrics = [...new Set([...Object.keys(report.baseline.values), ...Object.keys(report.candidate.values)])];
  if (metrics.length === 0) return '';
  const rows = metrics.map((metric) => `<tr><th scope="row">${escape(metricLabel(metric))}</th><td>${formatMetric(metric, report.baseline.values[metric])}</td><td>${formatMetric(metric, report.candidate.values[metric])}</td><td>${formatMetric(metric, deltaValue(report.candidate.values[metric], report.baseline.values[metric]), true)}</td></tr>`).join('');
  return `<div class="metric-table"><table><caption class="sr-only">Benchmark metrics by arm</caption><thead><tr><th scope="col">Metric</th>${renderArmHeading(report, 'baseline')}${renderArmHeading(report, 'candidate')}<th scope="col">Delta</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function renderArmHeading(report: BenchmarkReportData, role: 'baseline' | 'candidate'): string {
  const arm = report[role];
  const qualities = report.comparison.cases.flatMap((item) => item.attempts.map((attempt) => role === 'baseline' ? attempt.baselineQuality : attempt.candidateQuality).filter((value): value is BenchmarkAttemptQuality => value !== undefined));
  return `<th scope="col"><span class="arm-heading">${escape(arm.comparisonId)}<small>${role} · ${arm.actualRuns}/${arm.expectedRuns} runs · ${escape(formatQualitySummary(qualities))}</small></span></th>`;
}

function deltaValue(value: number | undefined, baseline: number | undefined): number | undefined {
  return value !== undefined && baseline !== undefined ? value - baseline : undefined;
}

export function renderBenchmarkIndexHtml(reports: readonly BenchmarkReportData[]): string {
  const scale = gainScale(reports);
  const rows = reports.map((report) => renderBenchmarkRow(report, scale)).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Benchmarks</title><style>${styles()}</style></head><body><main class="index"><header><h1>Benchmarks</h1></header><section class="benchmark-list"><div class="benchmark-columns"><span>Benchmark</span><span class="change-heading">Primary vs baseline</span><span>Secondary objective</span></div>${rows || '<p class="empty-list">No benchmarks.</p>'}</section></main></body></html>\n`;
}

interface ChangeScale {
  min: number;
  max: number;
}

function renderBenchmarkRow(report: BenchmarkReportData, scale: ChangeScale): string {
  const states = comparisonStates(report);
  const average = report.comparison.averageGainPercent;
  const minimum = report.comparison.minGainPercent;
  const maximum = report.comparison.maxGainPercent;
  const chart = changeChart(report, average, minimum, maximum, scale, report.comparison.expectedCases);
  const overallAssessment = assessment(report, report.comparison.averageGainPercent);
  const unfavorable = overallAssessment === 'unfavorable' ? '<span class="status-text bad">unfavorable</span>' : '';
  return `<article class="benchmark-row" data-benchmark-id="${escape(report.id)}"><div class="benchmark-name"><a href="${encodeURIComponent(report.id)}/results.html">${escape(report.definition.label)}</a><div class="benchmark-meta"><span>${escape(report.candidate.comparisonId)} vs ${escape(report.baseline.comparisonId)}</span>${renderStatus(states)}${unfavorable}</div></div>${chart}<strong class="change-value ${assessmentClass(overallAssessment)}">${formatPercent(average)}</strong>${renderSecondaryOutcome(report)}</article>`;
}

function renderSecondaryOutcome(report: BenchmarkReportData): string {
  const secondary = report.objectiveComparisons.find((comparison) => comparison.role === 'secondary');
  if (!secondary) return '<span class="secondary-outcome muted" aria-label="No secondary objective">—</span>';
  const outcomeAssessment = assessment(report, secondary.averageGainPercent);
  const description = secondaryOutcomeDescription(secondary.metric, secondary.averageChangePercent);
  const label = `Secondary outcome: ${description}; ${formatAssessment(outcomeAssessment)}`;
  return `<span class="secondary-outcome ${assessmentClass(outcomeAssessment)}" aria-label="${escape(label)}">${escape(description)}</span>`;
}

function secondaryOutcomeDescription(metric: string, change: number | undefined): string {
  const label = lowerFirst(metricLabel(metric));
  if (change === undefined) return `${metricLabel(metric)} unavailable`;
  if (Math.abs(change) < 0.05) return `No change in ${label}`;
  const amount = formatPercent(Math.abs(change)).replace(/^\+/, '');
  const decreased = change < 0;
  if (metric.endsWith('Tokens') || metric === 'usage.requests') return `${amount} ${decreased ? 'fewer' : 'more'} ${label}`;
  if (metric === 'duration.ms') return `${amount} ${decreased ? 'shorter' : 'longer'} duration`;
  return `${amount} ${decreased ? 'lower' : 'higher'} ${label}`;
}

function changeChart(
  report: BenchmarkReportData,
  average: number | undefined,
  minimum: number | undefined,
  maximum: number | undefined,
  scale: ChangeScale,
  tests: number,
): string {
  if (average === undefined || minimum === undefined || maximum === undefined) {
    return '<div class="change-chart unavailable" role="img" aria-label="Change unavailable">—</div>';
  }
  const zero = changePosition(0, scale);
  const averagePosition = changePosition(average, scale);
  const minimumPosition = changePosition(minimum, scale);
  const maximumPosition = changePosition(maximum, scale);
  const left = Math.min(zero, averagePosition);
  const width = Math.abs(averagePosition - zero);
  const rangeLeft = Math.min(minimumPosition, maximumPosition);
  const rangeWidth = Math.abs(maximumPosition - minimumPosition);
  const label = `Average outcome ${formatPercent(average)}; range ${formatPercent(minimum)} to ${formatPercent(maximum)} across ${tests} ${tests === 1 ? 'test' : 'tests'}; ${formatAssessment(assessment(report, report.comparison.averageGainPercent))}`;
  const range = rangeWidth > 0 ? '<span class="change-range"></span>' : '';
  return `<div class="change-chart ${changeClass(report, report.comparison.averageGainPercent)}" role="img" aria-label="${escape(label)}" style="--bar-left:${decimal(left)}%;--bar-width:${decimal(width)}%;--range-left:${decimal(rangeLeft)}%;--range-width:${decimal(rangeWidth)}%"><span class="change-track"></span><span class="change-bar"></span>${range}</div>`;
}

function gainScale(reports: readonly BenchmarkReportData[]): ChangeScale {
  const values = reports.flatMap((report) => [report.comparison.averageGainPercent, report.comparison.minGainPercent, report.comparison.maxGainPercent])
    .filter((value): value is number => value !== undefined && Number.isFinite(value));
  if (values.length === 0) return { min: 0, max: 100 };
  const rawMin = Math.min(0, ...values);
  const rawMax = Math.max(0, ...values);
  if (rawMin === rawMax) return { min: rawMin - 1, max: rawMax + 1 };
  const span = rawMax - rawMin;
  const step = span <= 20 ? 2 : span <= 100 ? 10 : span <= 500 ? 50 : 10 ** Math.floor(Math.log10(span));
  const min = Math.floor(rawMin / step) * step;
  const max = Math.ceil(rawMax / step) * step;
  return min === max ? { min: min - step, max: max + step } : { min, max };
}

function changePosition(value: number, scale: ChangeScale): number {
  return Math.max(0, Math.min(100, (value - scale.min) / (scale.max - scale.min) * 100));
}

function comparisonStates(report: BenchmarkReportData): [BenchmarkArmState, ...BenchmarkArmState[]] {
  const armStates = [report.baseline.state, report.candidate.state];
  const states = (['quality regression', 'incomplete', 'metric unavailable', 'inconclusive'] as const)
    .filter((state) => armStates.includes(state));
  if (states.length > 0) return states as [BenchmarkArmState, ...BenchmarkArmState[]];
  return [report.comparison.averageGainPercent === undefined ? 'metric unavailable' : 'eligible'];
}

function renderStatus(states: readonly BenchmarkArmState[]): string {
  const visible = states.filter((state) => state !== 'eligible');
  if (visible.length === 0) return '';
  const tone = visible.includes('quality regression') ? 'bad' : 'muted';
  return `<span class="status-text ${tone}">${escape(visible.join(' / '))}</span>`;
}

function format(value: number | undefined): string {
  return value === undefined ? '—' : Number.isInteger(value) ? String(value) : value.toFixed(4);
}

function formatMetric(metric: string, value: number | undefined, signed = false): string {
  if (value === undefined) return '—';
  const sign = signed && value > 0 ? '+' : '';
  if (metric === 'cost.total') return `${value < 0 ? '-' : sign}$${Math.abs(value).toFixed(4)}`;
  if (metric.endsWith('Tokens')) return `${sign}${Math.round(value).toLocaleString('en-US')} tokens`;
  return `${sign}${format(value)}`;
}

function formatPercent(value: number | undefined): string {
  if (value === undefined) return '—';
  const precision = Math.abs(value) < 0.1 && value !== 0 ? 2 : 1;
  return `${value > 0 ? '+' : ''}${value.toFixed(precision)}%`;
}

function formatRange(minimum: number | undefined, maximum: number | undefined): string {
  return minimum === undefined || maximum === undefined ? '—' : `${formatPercent(minimum)} to ${formatPercent(maximum)}`;
}

function metricLabel(metric: string): string {
  if (metric === 'cost.total') return 'Cost';
  if (metric === 'usage.outputTokens') return 'Output tokens';
  if (metric === 'usage.promptTokens') return 'Prompt tokens';
  if (metric === 'usage.uncachedInputTokens') return 'Uncached input tokens';
  if (metric === 'usage.cacheReadInputTokens') return 'Cache-read input tokens';
  if (metric === 'usage.cacheWriteInputTokens') return 'Cache-write input tokens';
  if (metric === 'usage.requests') return 'Requests';
  if (metric === 'duration.ms') return 'Duration';
  return metric;
}

function categories(quality: BenchmarkAttemptQuality | undefined): string {
  return quality?.categories.join('|') ?? '';
}

function formatQuality(quality: BenchmarkAttemptQuality | undefined): string {
  if (!quality) return 'Unavailable';
  if (quality.status === 'invalid') {
    const details = quality.categories.join(', ');
    return details ? `Invalid · ${details}` : 'Invalid';
  }
  if (quality.status === 'timeout') return 'Timed out';
  if (quality.status === 'passed' && quality.pass) return 'Passed';
  const details = quality.categories.join(', ');
  const assertionIds = quality.failedAssertions?.length ? ` (${quality.failedAssertions.join(', ')})` : '';
  return details ? `Failed · ${details}${assertionIds}` : `Failed · ${quality.status}${assertionIds}`;
}

function formatQualitySummary(qualities: readonly BenchmarkAttemptQuality[]): string {
  if (qualities.length === 0) return 'Unavailable';
  const invalid = qualities.filter((quality) => quality.status === 'invalid').length;
  const valid = qualities.filter((quality) => quality.status !== 'invalid');
  const passed = valid.filter((quality) => quality.status === 'passed' && quality.pass).length;
  const failed = valid.length - passed;
  const summary = valid.length > 0 ? `${passed}/${valid.length} passed` : 'No valid grades';
  const categories = [...new Set(valid.filter(isQualityFailure).flatMap((quality) => quality.categories))].join(', ');
  return `${summary}${failed > 0 ? `; ${failed} failed${categories ? ` · ${categories}` : ''}` : ''}${invalid > 0 ? `; ${invalid} invalid` : ''}`;
}

function qualityClass(quality: BenchmarkAttemptQuality | undefined): string {
  if (!quality) return 'muted';
  if (quality.status === 'invalid') return 'muted';
  return isQualityFailure(quality) ? 'bad' : 'ok';
}

function qualityClassForList(qualities: readonly BenchmarkAttemptQuality[]): string {
  if (qualities.length === 0) return 'muted';
  if (qualities.some(isQualityFailure)) return 'bad';
  return qualities.some((quality) => quality.status === 'invalid') ? 'muted' : 'ok';
}

type ChangeAssessment = 'favorable' | 'unfavorable' | 'no change' | 'unavailable' | 'quality regression' | 'invalid grading';

function assessment(report: BenchmarkReportData, improvement: number | undefined): ChangeAssessment {
  if (report.baseline.state === 'quality regression' || report.candidate.state === 'quality regression') return 'quality regression';
  return movementAssessment(improvement);
}

function assessmentForQualities(improvement: number | undefined, qualities: readonly (BenchmarkAttemptQuality | undefined)[]): ChangeAssessment {
  if (qualities.some((quality) => quality !== undefined && isQualityFailure(quality))) return 'quality regression';
  if (qualities.some((quality) => quality?.status === 'invalid')) return 'invalid grading';
  if (qualities.some((quality) => quality === undefined)) return 'unavailable';
  return movementAssessment(improvement);
}

function movementAssessment(improvement: number | undefined): ChangeAssessment {
  if (improvement === undefined) return 'unavailable';
  if (Math.abs(improvement) < 0.05) return 'no change';
  return improvement > 0 ? 'favorable' : 'unfavorable';
}

function isQualityFailure(quality: BenchmarkAttemptQuality): boolean {
  return quality.status !== 'invalid' && (quality.status !== 'passed' || !quality.pass);
}

function formatAssessment(value: ChangeAssessment): string {
  return value;
}

function changeClass(report: BenchmarkReportData, improvement: number | undefined): 'positive' | 'negative' | 'neutral' {
  return assessmentClass(assessment(report, improvement));
}

function assessmentClass(value: ChangeAssessment): 'positive' | 'negative' | 'neutral' {
  return value === 'favorable' ? 'positive' : value === 'unfavorable' || value === 'quality regression' ? 'negative' : 'neutral';
}

function capitalize(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

function lowerFirst(value: string): string {
  return `${value.charAt(0).toLowerCase()}${value.slice(1)}`;
}

function decimal(value: number): string {
  return value.toFixed(4);
}

function csv(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function escape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function styles(): string {
  return `
:root {
  color-scheme: light;
  --ink: #20232d;
  --muted: #687083;
  --rule: #dfe2e7;
  --subtle: #f7f7f6;
  --track: #e8eaee;
  --positive: #21764f;
  --positive-fill: #5fc98a;
  --negative: #b33a2b;
  --negative-fill: #ef8673;
  --warning: #8a5d00;
}
* { box-sizing: border-box; }
body { margin: 0; background: #fff; color: var(--ink); font: 14px/1.45 system-ui, -apple-system, sans-serif; }
main { max-width: 1140px; margin: 0 auto; padding: 52px 24px 72px; }
a { color: inherit; }
h1 { margin: 0; font-size: 36px; letter-spacing: -.035em; }
h2 { margin: 0 0 14px; font-size: 19px; }
.back { display: inline-block; margin-bottom: 28px; color: var(--muted); text-decoration: none; }
.back:hover { color: var(--ink); }
.index > header { margin-bottom: 24px; }
.detail-header { margin-bottom: 34px; }
.objective-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 10px; margin: -12px 0 28px; }
.objective-card { display: grid; gap: 3px; padding: 13px; border: 1px solid var(--rule); background: var(--subtle); }
.objective-card span, .objective-card small { color: var(--muted); font-size: 11px; }
.objective-card b { font-size: 20px; }
.pair { margin: 5px 0 0; color: var(--muted); font: 12px ui-monospace, monospace; }
.result-line { display: flex; flex-wrap: wrap; align-items: baseline; gap: 7px; margin-top: 20px; color: var(--muted); }
.result-stat { display: inline-flex; align-items: baseline; gap: 7px; white-space: nowrap; }
.result-stat strong { color: var(--ink); font-size: 16px; }
.result-stat:first-child strong { font-size: 26px; }
.result-line .change-value.positive { color: var(--positive); }
.result-line .change-value.negative { color: var(--negative); }
.result-line .change-value.neutral { color: var(--muted); }
.separator { margin: 0 3px; color: #a2a7b0; }
.status-text { flex: 0 0 auto; padding: 1px 6px; border: 1px solid var(--rule); border-radius: 999px; color: var(--muted); font-size: 10px; }
.status-text.bad { border-color: #edc2bc; background: #fff5f3; color: var(--negative); }
.benchmark-list { border-top: 1px solid var(--rule); border-bottom: 1px solid var(--rule); }
.benchmark-columns, .benchmark-row { display: grid; grid-template-columns: minmax(230px, 1.35fr) minmax(280px, 2fr) 90px minmax(180px, .9fr); gap: 18px; align-items: center; }
.benchmark-columns { padding: 10px 14px; color: var(--muted); border-bottom: 1px solid var(--rule); font: 600 10px ui-monospace, monospace; letter-spacing: .08em; text-transform: uppercase; }
.change-heading { grid-column: 2 / 4; }
.benchmark-row { min-height: 72px; padding: 13px 14px; border-bottom: 1px solid var(--rule); }
.benchmark-row:last-child { border-bottom: 0; }
.benchmark-name { min-width: 0; }
.benchmark-name > a { display: block; overflow: hidden; font-weight: 650; text-decoration: none; text-overflow: ellipsis; white-space: nowrap; }
.benchmark-name > a:hover { text-decoration: underline; }
.benchmark-meta { display: flex; gap: 6px; align-items: center; min-width: 0; color: var(--muted); font: 11px ui-monospace, monospace; }
.benchmark-meta > span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.change-chart { position: relative; height: 24px; }
.change-track { position: absolute; inset: 11px 0 auto; height: 2px; background: var(--track); }
.change-bar { position: absolute; top: 7px; left: var(--bar-left); width: max(2px, var(--bar-width)); height: 10px; background: var(--positive-fill); }
.change-chart.negative .change-bar { background: var(--negative-fill); }
.change-chart.neutral .change-bar { background: var(--muted); }
.change-range { position: absolute; top: 3px; left: var(--range-left); width: max(1px, var(--range-width)); height: 18px; border-left: 1px solid #596170; border-right: 1px solid #596170; }
.change-range::after { content: ""; position: absolute; top: 8px; left: 0; width: 100%; border-top: 1px solid #596170; }
.change-chart.unavailable { display: flex; align-items: center; color: var(--muted); }
.change-value { font-variant-numeric: tabular-nums; }
.objective { margin: 7px 0 0; color: var(--muted); font-size: 12px; }
.quality-warning { margin: 16px 0 0; color: var(--negative); font-size: 12px; }
.change-value.positive { color: var(--positive); }
.change-value.negative { color: var(--negative); }
.change-value.neutral { color: var(--muted); }
.secondary-outcome { font-size: 12px; font-weight: 650; font-variant-numeric: tabular-nums; }
.secondary-outcome.positive { color: var(--positive); }
.secondary-outcome.negative { color: var(--negative); }
.secondary-outcome.neutral { color: var(--warning); }
.secondary-outcome.muted { color: var(--muted); }
.data-section { margin-top: 0; padding: 26px 0; border-top: 1px solid var(--rule); }
table { width: 100%; border-collapse: collapse; }
th, td { padding: 10px 8px; border-bottom: 1px solid var(--rule); text-align: left; }
thead th { color: var(--muted); font: 600 10px ui-monospace, monospace; letter-spacing: .08em; text-transform: uppercase; }
tbody th { font-weight: 600; }
.metric-table { overflow-x: auto; }
.metric-table table { min-width: 620px; }
.metric-table th:first-child { width: 28%; }
.metric-table th, .metric-table td { vertical-align: top; }
.arm-heading { display: grid; gap: 2px; overflow-wrap: anywhere; }
.arm-heading small { color: var(--muted); font: 500 10px/1.35 system-ui, -apple-system, sans-serif; letter-spacing: 0; text-transform: none; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
.test-list { overflow-x: auto; border-top: 1px solid var(--rule); }
.test-columns, .test-summary, .attempt-row { display: grid; grid-template-columns: minmax(250px, 2fr) repeat(3, minmax(125px, 1fr)); gap: 16px; align-items: center; min-width: 720px; }
.test-columns { padding: 10px 12px; color: var(--muted); border-bottom: 1px solid var(--rule); font: 600 10px ui-monospace, monospace; letter-spacing: .08em; text-transform: uppercase; }
.test-block { min-width: 720px; border-bottom: 1px solid var(--rule); }
.test-block:last-child { border-bottom: 0; }
.test-summary { padding: 12px; cursor: pointer; list-style: none; }
.test-summary::-webkit-details-marker { display: none; }
.test-summary:hover { background: var(--subtle); }
.test-summary:focus-visible { outline: 2px solid #555d6c; outline-offset: -2px; }
.test-name { min-width: 0; overflow: hidden; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
.test-name::before { content: "›"; display: inline-block; width: 18px; color: var(--muted); transform-origin: 45% 50%; }
.test-block[open] .test-name::before { transform: rotate(90deg); }
.quality { display: block; margin-top: 3px; font: 500 10px ui-monospace, monospace; }
.quality.ok { color: var(--positive); }
.quality.bad { color: var(--negative); }
.quality.muted { color: var(--muted); }
.attempt-list { background: var(--subtle); }
.attempt-row { padding: 9px 12px; border-top: 1px solid var(--rule); color: var(--muted); font-size: 12px; }
.attempt-row > span:first-child { padding-left: 18px; }
.empty-list { margin: 0; padding: 18px 12px; color: var(--muted); }
@media (max-width: 900px) {
  .benchmark-columns { display: none; }
  .benchmark-row { grid-template-columns: 82px 1fr; gap: 10px; min-height: 108px; }
  .benchmark-name { grid-column: 1 / 3; }
  .change-chart { grid-column: 1 / 3; }
  .secondary-outcome { justify-self: end; text-align: right; }
}
@media (max-width: 760px) {
  main { padding: 30px 14px 56px; }
  h1 { font-size: 31px; }
}
`;
}
