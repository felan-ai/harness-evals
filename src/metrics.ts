import type { CostReport, CostSummary } from './cost/types.js';

export type NumericMetrics = Record<string, number>;

export function metricsForStep(input: { durationMs: number; pass: boolean; cost: CostReport }): NumericMetrics {
  const metrics: NumericMetrics = {
    'duration.ms': input.durationMs,
    'quality.passRate': input.pass ? 1 : 0,
  };
  addCostMetrics(metrics, input.cost);
  return metrics;
}

export function metricsForRun(input: { durationMs: number; pass: boolean; cost: CostSummary; qualityValid?: boolean }): NumericMetrics {
  const metrics: NumericMetrics = { 'duration.ms': input.durationMs };
  if (input.qualityValid !== false) metrics['quality.passRate'] = input.pass ? 1 : 0;
  addCostMetrics(metrics, input.cost);
  return metrics;
}

function addCostMetrics(metrics: NumericMetrics, cost: CostReport | CostSummary): void {
  const rollup = 'rollup' in cost ? cost.rollup : {
    inputTokens: cost.usage?.reduce((sum, usage) => sum + (usage.inputTokens ?? 0), 0),
    cachedInputTokens: cost.usage?.reduce((sum, usage) => sum + (usage.cachedInputTokens ?? 0), 0),
    outputTokens: cost.usage?.reduce((sum, usage) => sum + (usage.outputTokens ?? 0), 0),
    requests: cost.usage?.reduce((sum, usage) => sum + (usage.requests ?? 0), 0),
  };
  add(metrics, 'cost.total', cost.totalCost);
  add(metrics, 'usage.promptTokens', rollup.promptTokens ?? rollup.inputTokens);
  add(metrics, 'usage.uncachedInputTokens', rollup.uncachedInputTokens ?? rollup.inputTokens);
  add(metrics, 'usage.cacheReadInputTokens', rollup.cacheReadInputTokens ?? rollup.cachedInputTokens);
  add(metrics, 'usage.cacheWriteInputTokens', rollup.cacheWriteInputTokens);
  add(metrics, 'usage.outputTokens', rollup.outputTokens);
  add(metrics, 'usage.requests', rollup.requests);
}

function add(metrics: NumericMetrics, name: string, value: number | undefined): void {
  if (value !== undefined && Number.isFinite(value)) metrics[name] = value;
}

