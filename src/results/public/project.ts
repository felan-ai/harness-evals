import type { BatchSummaryInfo, ScannedTaskRun } from '../../visualization/scan.js';
import type {
  PublicBatchManifest,
  PublicBatchTotals,
  PublicCostSummary,
  PublicProvenance,
  PublicRunSummary,
} from './types.js';

export interface PublicBatchProjectionOptions {
  provenance?: PublicProvenance;
}

/** Project compact scanner records into the deliberately small public schema. */
export function projectPublicBatch(
  batch: BatchSummaryInfo,
  runs: readonly ScannedTaskRun[],
  options: PublicBatchProjectionOptions = {},
): PublicBatchManifest {
  if (runs.some((run) => run.batchId !== batch.batchId)) {
    throw new Error(`Cannot project runs from another batch into ${batch.batchId}`);
  }
  const sortedRuns = [...runs].sort(compareRuns);
  const publicRuns = sortedRuns.map(projectRun);
  const manifest: PublicBatchManifest = {
    schemaVersion: 1,
    batchId: batch.batchId,
    suites: sortedUnique(publicRuns.map((run) => run.suite).filter(isPresent)),
    cases: sortedUnique(publicRuns.map((run) => run.caseId)),
    agents: sortedUnique([...(batch.agents ?? []), ...publicRuns.map((run) => run.agentName)]),
    totals: calculatePublicBatchTotals(publicRuns),
    runs: publicRuns,
  };
  addIfPresent(manifest, 'startedAt', batch.startedAt);
  addIfPresent(manifest, 'label', batch.label);
  const provenance = mergeProvenance(options.provenance, deriveAgentPackageVersions(sortedRuns));
  if (provenance) manifest.provenance = provenance;
  return manifest;
}

/**
 * A batch is only attributable to an agent build if every run of that agent
 * reports the same one. Disagreement means the config changed mid-batch, so the
 * agent is left out rather than credited to whichever run happened to sort first.
 */
function deriveAgentPackageVersions(runs: readonly ScannedTaskRun[]): Record<string, string> | undefined {
  const seen = new Map<string, Set<string>>();
  for (const run of runs) {
    if (!run.packageVersion) continue;
    const versions = seen.get(run.agentName) ?? new Set<string>();
    versions.add(run.packageVersion);
    seen.set(run.agentName, versions);
  }
  const result: Record<string, string> = {};
  for (const [agentName, versions] of [...seen.entries()].sort(([a], [b]) => compareStrings(a, b))) {
    if (versions.size === 1) result[agentName] = [...versions][0]!;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function mergeProvenance(
  supplied: PublicProvenance | undefined,
  agentPackageVersions: Record<string, string> | undefined,
): PublicProvenance | undefined {
  const merged: PublicProvenance = { ...(supplied ?? {}) };
  // Caller-supplied versions win: they describe what the publisher knows about
  // the build, which the run artifacts cannot contradict.
  if (agentPackageVersions && !merged.agentPackageVersions) merged.agentPackageVersions = agentPackageVersions;
  return Object.keys(merged).length > 0 ? merged : undefined;
}

export function calculatePublicBatchTotals(runs: readonly PublicRunSummary[]): PublicBatchTotals {
  const totals: PublicBatchTotals = {
    runs: runs.length,
    passed: 0,
    failed: 0,
    errors: 0,
    skipped: 0,
    timeouts: 0,
    incomplete: 0,
  };
  let duration = 0;
  let hasDuration = false;
  for (const run of runs) {
    switch (run.status) {
      case 'passed': totals.passed += 1; break;
      case 'failed': totals.failed += 1; break;
      case 'error': totals.errors += 1; break;
      case 'skipped': totals.skipped += 1; break;
      case 'timeout': totals.timeouts += 1; break;
      case 'incomplete': totals.incomplete += 1; break;
    }
    if (run.durationMs !== undefined) {
      duration += run.durationMs;
      hasDuration = true;
    }
  }
  if (hasDuration) totals.durationMs = duration;
  const cost = aggregateCosts(runs.map((run) => run.cost).filter(isPresent));
  if (cost) totals.cost = cost;
  return totals;
}

export function projectPublicRun(run: ScannedTaskRun): PublicRunSummary {
  return projectRun(run);
}

function projectRun(run: ScannedTaskRun): PublicRunSummary {
  const result: PublicRunSummary = {
    runId: run.runId,
    caseId: run.caseId,
    agentName: run.agentName,
    status: run.status,
    pass: run.pass,
  };
  addIfPresent(result, 'agentLabel', run.agentLabel);
  addIfPresent(result, 'comparisonId', run.comparisonId ?? run.agentName);
  addIfPresent(result, 'suite', run.suite);
  addIfPresent(result, 'attemptNumber', run.attemptNumber);
  addIfPresent(result, 'attempts', run.attempts);
  addIfPresent(result, 'startedAt', run.startedAt);
  addIfPresent(result, 'durationMs', run.durationMs);
  if (run.exitCode !== undefined) result.exitCode = run.exitCode;
  addIfPresent(result, 'score', run.score);
  addIfPresent(result, 'assertionPassRate', run.assertionPassRate);
  addIfPresent(result, 'judgeScore', run.judgeScore);
  addIfPresent(result, 'verifierReward', run.verifierReward);
  addIfPresent(result, 'provider', run.provider);
  addIfPresent(result, 'model', run.model);
  if (run.models?.length) result.models = sortedUnique(run.models);
  addIfPresent(result, 'thinking', run.thinking);
  addIfPresent(result, 'packageVersion', run.packageVersion);
  if (run.assertions) result.assertions = { ...run.assertions };
  if (run.cost) {
    const cost = compactCost(run.cost);
    if (cost) result.cost = cost;
  }
  return result;
}

function aggregateCosts(costs: readonly PublicCostSummary[]): PublicCostSummary | undefined {
  if (costs.length === 0) return undefined;
  const result: PublicCostSummary = {};
  const totalCostEntries = costs.filter((cost) => cost.totalCost !== undefined);
  const currencies = new Set(totalCostEntries.map((cost) => cost.currency));
  const compatibleCurrency = currencies.size <= 1;
  if (compatibleCurrency && totalCostEntries.length > 0) {
    result.totalCost = totalCostEntries.reduce((sum, cost) => sum + cost.totalCost!, 0);
    const currency = totalCostEntries[0]?.currency;
    if (currency !== undefined) result.currency = currency;
  }
  const fields: (keyof PublicCostSummary)[] = [
    'inputTokens', 'outputTokens', 'cachedInputTokens', 'reasoningTokens', 'totalTokens', 'requests',
  ];
  for (const field of fields) {
    const values = costs.filter((cost) => cost[field] !== undefined).map((cost) => cost[field] as number);
    if (values.length > 0) Object.assign(result, { [field]: values.reduce((sum, value) => sum + value, 0) });
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function compactCost(cost: NonNullable<ScannedTaskRun['cost']>): PublicCostSummary | undefined {
  const result: PublicCostSummary = {};
  for (const field of ['totalCost', 'currency', 'inputTokens', 'outputTokens', 'cachedInputTokens', 'reasoningTokens', 'totalTokens', 'requests'] as const) {
    const value = cost[field];
    if (value !== undefined) Object.assign(result, { [field]: value });
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function compareRuns(a: ScannedTaskRun, b: ScannedTaskRun): number {
  return compareStrings(a.caseId, b.caseId)
    || compareStrings(a.agentName, b.agentName)
    || (a.attemptNumber ?? 0) - (b.attemptNumber ?? 0)
    || compareStrings(a.runId, b.runId);
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareStrings);
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function addIfPresent<T extends object, K extends keyof T>(target: T, key: K, value: T[K] | undefined): void {
  if (value !== undefined) target[key] = value;
}

function isPresent<T>(value: T | undefined): value is T {
  return value !== undefined;
}
