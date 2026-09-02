import type { BenchmarkDefinition } from '../config/schema.js';
import type { ScannedFailureCategory, ScannedTaskRun, ScannedRunStatus } from '../visualization/scan.js';

export type BenchmarkArmState = 'eligible' | 'quality regression' | 'incomplete' | 'metric unavailable' | 'inconclusive';

export interface BenchmarkCaseResult {
  caseId: string;
  observations: Record<string, number[]>;
  attempts: Record<string, BenchmarkAttemptObservation[]>;
  qualityAttempts: BenchmarkAttemptQuality[];
  values: Record<string, number>;
}

export interface BenchmarkAttemptObservation {
  attemptNumber: number;
  value: number;
  quality: BenchmarkAttemptQuality;
}

export interface BenchmarkAttemptQuality {
  attemptNumber: number;
  status: ScannedRunStatus;
  pass: boolean;
  categories: ScannedFailureCategory[];
  failedAssertions?: string[];
  verifierReward?: number;
  durationMs?: number;
  runId: string;
}

export interface BenchmarkArmResult {
  agentName: string;
  comparisonId: string;
  state: BenchmarkArmState;
  expectedRuns: number;
  actualRuns: number;
  missingRuns: number;
  cases: BenchmarkCaseResult[];
  values: Record<string, number>;
  deltas: Record<string, number | undefined>;
  gateResults: Array<{ metric: string; value?: number; pass: boolean; min?: number; max?: number }>;
}

export interface BenchmarkCaseComparison {
  caseId: string;
  baselineValue?: number;
  candidateValue?: number;
  changePercent?: number;
  improvementPercent?: number;
  attempts: BenchmarkAttemptComparison[];
}

export interface BenchmarkAttemptComparison {
  attemptNumber: number;
  baselineValue?: number;
  candidateValue?: number;
  changePercent?: number;
  improvementPercent?: number;
  baselineQuality?: BenchmarkAttemptQuality;
  candidateQuality?: BenchmarkAttemptQuality;
}

export interface BenchmarkComparisonSummary {
  averageChangePercent?: number;
  minChangePercent?: number;
  maxChangePercent?: number;
  averageImprovementPercent?: number;
  minImprovementPercent?: number;
  maxImprovementPercent?: number;
  comparedCases: number;
  expectedCases: number;
  cases: BenchmarkCaseComparison[];
}

export interface BenchmarkReportData {
  id: string;
  definition: BenchmarkDefinition;
  cases: string[];
  expectedTrials: number;
  baseline: BenchmarkArmResult;
  candidate: BenchmarkArmResult;
  comparison: BenchmarkComparisonSummary;
  warnings: string[];
  runCount: number;
  derivedRunCount: number;
}

export function analyzeBenchmark(input: {
  id: string;
  definition: BenchmarkDefinition;
  runs: readonly ScannedTaskRun[];
  cases?: readonly string[];
}): BenchmarkReportData {
  const definition = input.definition;
  const caseIds = [...new Set(input.cases ?? input.runs.map((run) => run.caseId))].sort();
  const selectedRuns = input.runs.filter((run) => run.attemptNumber !== undefined || definition.trials === 1);
  const armNames = [definition.arms.baseline, definition.arms.candidate];
  const arms = armNames.map((agentName) => buildArm(agentName, definition, caseIds, selectedRuns));
  const baseline = arms[0];
  if (!baseline) throw new Error(`Benchmark ${input.id} has no baseline`);
  const candidate = arms[1];
  if (!candidate) throw new Error(`Benchmark ${input.id} has no candidate`);
  for (const metric of metricsFor(definition)) candidate.deltas[metric] = delta(candidate.values[metric], baseline.values[metric]);
  const warnings = arms.filter((arm) => arm.state !== 'eligible').map((arm) => `${arm.comparisonId}: ${arm.state}`);
  return {
    id: input.id,
    definition,
    cases: caseIds,
    expectedTrials: definition.trials,
    baseline,
    candidate,
    comparison: summarizeComparison(definition, caseIds, baseline, candidate),
    warnings,
    runCount: selectedRuns.length,
    derivedRunCount: selectedRuns.filter((run) => run.metricsSource === 'historical-derived').length,
  };
}

function summarizeComparison(
  definition: BenchmarkDefinition,
  caseIds: readonly string[],
  baseline: BenchmarkArmResult,
  candidate: BenchmarkArmResult,
): BenchmarkComparisonSummary {
  const metric = definition.objective.metric;
  const cases = caseIds.map((caseId) => {
    const baselineCase = baseline.cases.find((item) => item.caseId === caseId);
    const candidateCase = candidate.cases.find((item) => item.caseId === caseId);
    const baselineValue = baselineCase?.values[metric];
    const candidateValue = candidateCase?.values[metric];
    const baselineAttempts = baselineCase?.attempts[metric] ?? [];
    const candidateAttempts = candidateCase?.attempts[metric] ?? [];
    const baselineQualityAttempts = baselineCase?.qualityAttempts ?? [];
    const candidateQualityAttempts = candidateCase?.qualityAttempts ?? [];
    const changePercent = percentageChange(baselineValue, candidateValue);
    const improvementPercent = percentageImprovement(definition.objective.goal, changePercent);
    const attemptNumbers = [...new Set([
      ...baselineAttempts.map((attempt) => attempt.attemptNumber),
      ...candidateAttempts.map((attempt) => attempt.attemptNumber),
      ...baselineQualityAttempts.map((attempt) => attempt.attemptNumber),
      ...candidateQualityAttempts.map((attempt) => attempt.attemptNumber),
    ])].sort((a, b) => a - b);
    return {
      caseId,
      baselineValue,
      candidateValue,
      changePercent,
      improvementPercent,
      attempts: attemptNumbers.map((attemptNumber) => {
        const baselineAttempt = baselineAttempts.find((attempt) => attempt.attemptNumber === attemptNumber)?.value;
        const candidateAttempt = candidateAttempts.find((attempt) => attempt.attemptNumber === attemptNumber)?.value;
        const attemptChangePercent = percentageChange(baselineAttempt, candidateAttempt);
        const attemptImprovementPercent = percentageImprovement(definition.objective.goal, attemptChangePercent);
        return {
          attemptNumber,
          baselineValue: baselineAttempt,
          candidateValue: candidateAttempt,
          changePercent: attemptChangePercent,
          improvementPercent: attemptImprovementPercent,
          baselineQuality: baselineAttempts.find((attempt) => attempt.attemptNumber === attemptNumber)?.quality
            ?? baselineQualityAttempts.find((attempt) => attempt.attemptNumber === attemptNumber),
          candidateQuality: candidateAttempts.find((attempt) => attempt.attemptNumber === attemptNumber)?.quality
            ?? candidateQualityAttempts.find((attempt) => attempt.attemptNumber === attemptNumber),
        };
      }),
    };
  });
  const changeValues = cases.map((item) => item.changePercent).filter((value): value is number => value !== undefined);
  const improvementValues = cases.map((item) => item.improvementPercent).filter((value): value is number => value !== undefined);
  const complete = changeValues.length === caseIds.length && improvementValues.length === caseIds.length && caseIds.length > 0 && caseIds.every((caseId) =>
    hasExpectedAttempts(baseline.cases.find((item) => item.caseId === caseId), metric, definition.trials)
    && hasExpectedAttempts(candidate.cases.find((item) => item.caseId === caseId), metric, definition.trials));
  const averageImprovementPercent = complete ? reduce(improvementValues, 'mean') : undefined;
  const minImprovementPercent = complete ? Math.min(...improvementValues) : undefined;
  const maxImprovementPercent = complete ? Math.max(...improvementValues) : undefined;
  return {
    averageChangePercent: complete ? reduce(changeValues, 'mean') : undefined,
    minChangePercent: complete ? Math.min(...changeValues) : undefined,
    maxChangePercent: complete ? Math.max(...changeValues) : undefined,
    averageImprovementPercent,
    minImprovementPercent,
    maxImprovementPercent,
    comparedCases: changeValues.length,
    expectedCases: caseIds.length,
    cases,
  };
}

function buildArm(agentName: string, definition: BenchmarkDefinition, caseIds: string[], runs: readonly ScannedTaskRun[]): BenchmarkArmResult {
  const comparisonId = runs.find((run) => run.agentName === agentName)?.comparisonId ?? agentName;
  const armRuns = runs.filter((run) => caseIds.includes(run.caseId)
    && ((run.comparisonId ?? run.agentName) === comparisonId || run.agentName === agentName));
  const metricNames = metricsFor(definition);
  const cases = caseIds.map((caseId) => {
    const observations: Record<string, number[]> = {};
    const attempts: Record<string, BenchmarkAttemptObservation[]> = {};
    const values: Record<string, number> = {};
    const caseRuns = armRuns.filter((run) => run.caseId === caseId)
      .sort((a, b) => (a.attemptNumber ?? Number.MAX_SAFE_INTEGER) - (b.attemptNumber ?? Number.MAX_SAFE_INTEGER));
    for (const metric of metricNames) {
      const metricAttempts = caseRuns.flatMap((run, index) => {
        const value = run.metrics?.[metric];
        return value !== undefined && Number.isFinite(value)
          ? [{ attemptNumber: run.attemptNumber ?? index + 1, value, quality: qualityForRun(run) }]
          : [];
      });
      const points = metricAttempts.map((attempt) => attempt.value);
      attempts[metric] = metricAttempts;
      observations[metric] = points;
      const reduced = reduce(points, definition.aggregation.trials);
      if (reduced !== undefined) values[metric] = reduced;
    }
    return { caseId, observations, attempts, qualityAttempts: caseRuns.map(qualityForRun), values };
  });
  const values: Record<string, number> = {};
  for (const metric of metricNames) {
    const caseValues = cases.map((item) => item.values[metric]).filter((value): value is number => value !== undefined);
    const reduced = reduce(caseValues, 'mean');
    if (reduced !== undefined) values[metric] = reduced;
  }
  const gateResults = definition.qualityGates.map((gate) => {
    const value = reduce(cases.flatMap((item) => item.observations[gate.metric] ?? []), 'mean');
    return { ...gate, value, pass: value !== undefined && (gate.min === undefined || value >= gate.min) && (gate.max === undefined || value <= gate.max) };
  });
  const expectedRuns = caseIds.length * definition.trials;
  const actualRuns = armRuns.length;
  const requiredMetrics = new Set([definition.objective.metric, ...definition.qualityGates.map((gate) => gate.metric)]);
  const qualityMetrics = new Set(definition.qualityGates.map((gate) => gate.metric));
  const complete = actualRuns === expectedRuns && cases.every((item) =>
    [...requiredMetrics].every((metric) => qualityMetrics.has(metric)
      ? hasQualityCoverage(item, metric, definition.trials)
      : hasExpectedAttempts(item, metric, definition.trials)));
  const state: BenchmarkArmState = !complete ? 'incomplete' : gateResults.some((gate) => !gate.pass) ? 'quality regression' : values[definition.objective.metric] === undefined ? 'metric unavailable' : definition.trials < 2 ? 'inconclusive' : 'eligible';
  return { agentName, comparisonId, state, expectedRuns, actualRuns, missingRuns: Math.max(0, expectedRuns - actualRuns), cases, values, deltas: {}, gateResults };
}

function hasQualityCoverage(item: BenchmarkCaseResult, metric: string, trials: number): boolean {
  const attempts = item.attempts[metric] ?? [];
  const invalidAttempts = item.qualityAttempts.filter((attempt) => attempt.status === 'invalid').map((attempt) => attempt.attemptNumber);
  const covered = new Set([...attempts.map((attempt) => attempt.attemptNumber), ...invalidAttempts]);
  if (attempts.length + invalidAttempts.length !== trials) return false;
  return covered.size === trials && [...covered].every((attempt) => attempt >= 1 && attempt <= trials);
}

function hasExpectedAttempts(item: BenchmarkCaseResult | undefined, metric: string, trials: number): boolean {
  const attempts = item?.attempts[metric] ?? [];
  return attempts.length === trials && attempts.every((attempt) => attempt.attemptNumber >= 1 && attempt.attemptNumber <= trials)
    && new Set(attempts.map((attempt) => attempt.attemptNumber)).size === trials;
}

function qualityForRun(run: ScannedTaskRun): BenchmarkAttemptQuality {
  return {
    attemptNumber: run.attemptNumber ?? 1,
    status: run.status,
    pass: run.pass,
    categories: run.failures?.categories ?? [],
    ...(run.failures?.failedAssertions ? { failedAssertions: run.failures.failedAssertions } : {}),
    ...(run.verifierReward !== undefined ? { verifierReward: run.verifierReward } : {}),
    ...(run.durationMs !== undefined ? { durationMs: run.durationMs } : {}),
    runId: run.runId,
  };
}

function metricsFor(definition: BenchmarkDefinition): string[] {
  return [...new Set([definition.objective.metric, ...definition.secondaryMetrics, ...definition.qualityGates.map((gate) => gate.metric)])];
}

function reduce(values: readonly number[], reducer: 'median' | 'mean'): number | undefined {
  if (values.length === 0) return undefined;
  if (reducer === 'mean') return values.reduce((sum, value) => sum + value, 0) / values.length;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function delta(value: number | undefined, baseline: number | undefined): number | undefined {
  return value !== undefined && baseline !== undefined ? value - baseline : undefined;
}

function percentageChange(
  baseline: number | undefined,
  candidate: number | undefined,
): number | undefined {
  if (baseline === undefined || candidate === undefined || baseline === 0) return undefined;
  return (candidate - baseline) / Math.abs(baseline) * 100;
}

function percentageImprovement(
  goal: BenchmarkDefinition['objective']['goal'],
  change: number | undefined,
): number | undefined {
  if (change === undefined) return undefined;
  return goal === 'maximize' ? change : -change;
}
