import type { BenchmarkDefinition } from '../config/schema.js';
import type { ScannedTaskRun } from '../visualization/scan.js';

export type BenchmarkArmState = 'eligible' | 'quality regression' | 'incomplete' | 'metric unavailable' | 'inconclusive';

export interface BenchmarkCaseResult {
  caseId: string;
  observations: Record<string, number[]>;
  attempts: Record<string, BenchmarkAttemptObservation[]>;
  values: Record<string, number>;
}

export interface BenchmarkAttemptObservation {
  attemptNumber: number;
  value: number;
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

export interface BenchmarkCaseGain {
  caseId: string;
  baselineValue?: number;
  candidateValue?: number;
  gainPercent?: number;
  attempts: BenchmarkAttemptGain[];
}

export interface BenchmarkAttemptGain {
  attemptNumber: number;
  baselineValue?: number;
  candidateValue?: number;
  gainPercent?: number;
}

export interface BenchmarkGainSummary {
  averagePercent?: number;
  minPercent?: number;
  maxPercent?: number;
  comparedCases: number;
  expectedCases: number;
  cases: BenchmarkCaseGain[];
}

export interface BenchmarkReportData {
  id: string;
  definition: BenchmarkDefinition;
  cases: string[];
  expectedTrials: number;
  baseline: BenchmarkArmResult;
  candidate: BenchmarkArmResult;
  gain: BenchmarkGainSummary;
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
    gain: summarizeGain(definition, caseIds, baseline, candidate),
    warnings,
    runCount: selectedRuns.length,
    derivedRunCount: selectedRuns.filter((run) => run.metricsSource === 'historical-derived').length,
  };
}

function summarizeGain(
  definition: BenchmarkDefinition,
  caseIds: readonly string[],
  baseline: BenchmarkArmResult,
  candidate: BenchmarkArmResult,
): BenchmarkGainSummary {
  const metric = definition.objective.metric;
  const cases = caseIds.map((caseId) => {
    const baselineCase = baseline.cases.find((item) => item.caseId === caseId);
    const candidateCase = candidate.cases.find((item) => item.caseId === caseId);
    const baselineValue = baselineCase?.values[metric];
    const candidateValue = candidateCase?.values[metric];
    const baselineAttempts = baselineCase?.attempts[metric] ?? [];
    const candidateAttempts = candidateCase?.attempts[metric] ?? [];
    const attemptNumbers = [...new Set([
      ...baselineAttempts.map((attempt) => attempt.attemptNumber),
      ...candidateAttempts.map((attempt) => attempt.attemptNumber),
    ])].sort((a, b) => a - b);
    return {
      caseId,
      baselineValue,
      candidateValue,
      gainPercent: percentageGain(definition.objective.goal, baselineValue, candidateValue),
      attempts: attemptNumbers.map((attemptNumber) => {
        const baselineAttempt = baselineAttempts.find((attempt) => attempt.attemptNumber === attemptNumber)?.value;
        const candidateAttempt = candidateAttempts.find((attempt) => attempt.attemptNumber === attemptNumber)?.value;
        return {
          attemptNumber,
          baselineValue: baselineAttempt,
          candidateValue: candidateAttempt,
          gainPercent: percentageGain(definition.objective.goal, baselineAttempt, candidateAttempt),
        };
      }),
    };
  });
  const values = cases.map((item) => item.gainPercent).filter((value): value is number => value !== undefined);
  const complete = values.length === caseIds.length && caseIds.length > 0 && caseIds.every((caseId) =>
    baseline.cases.find((item) => item.caseId === caseId)?.observations[metric]?.length === definition.trials
    && candidate.cases.find((item) => item.caseId === caseId)?.observations[metric]?.length === definition.trials);
  return {
    averagePercent: complete ? reduce(values, 'mean') : undefined,
    minPercent: complete ? Math.min(...values) : undefined,
    maxPercent: complete ? Math.max(...values) : undefined,
    comparedCases: values.length,
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
          ? [{ attemptNumber: run.attemptNumber ?? index + 1, value }]
          : [];
      });
      const points = metricAttempts.map((attempt) => attempt.value);
      attempts[metric] = metricAttempts;
      observations[metric] = points;
      const reduced = reduce(points, definition.aggregation.trials);
      if (reduced !== undefined) values[metric] = reduced;
    }
    return { caseId, observations, attempts, values };
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
  const complete = actualRuns === expectedRuns && cases.every((item) =>
    [...requiredMetrics].every((metric) => item.observations[metric]?.length === definition.trials
      && new Set(item.attempts[metric]?.map((attempt) => attempt.attemptNumber)).size === definition.trials));
  const state: BenchmarkArmState = !complete ? 'incomplete' : gateResults.some((gate) => !gate.pass) ? 'quality regression' : values[definition.objective.metric] === undefined ? 'metric unavailable' : definition.trials < 2 ? 'inconclusive' : 'eligible';
  return { agentName, comparisonId, state, expectedRuns, actualRuns, missingRuns: Math.max(0, expectedRuns - actualRuns), cases, values, deltas: {}, gateResults };
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

function percentageGain(
  goal: BenchmarkDefinition['objective']['goal'],
  baseline: number | undefined,
  candidate: number | undefined,
): number | undefined {
  if (baseline === undefined || candidate === undefined || baseline === 0) return undefined;
  const change = (candidate - baseline) / Math.abs(baseline) * 100;
  return goal === 'maximize' ? change : -change;
}
