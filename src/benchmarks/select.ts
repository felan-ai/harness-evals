import { createHash } from 'node:crypto';
import type { BenchmarkDefinition, CliOverrides, LoadedHarnessConfig, TestCase } from '../config/schema.js';
import type { ScannedTaskRun } from '../visualization/scan.js';

export interface ResolvedBenchmarkSelection {
  id: string;
  definition: BenchmarkDefinition;
  digest: string;
  testCases: TestCase[];
  agentNames: string[];
}

export function resolveBenchmarkSelection(
  config: LoadedHarnessConfig,
  benchmarkId: string,
  cli: CliOverrides = {},
): ResolvedBenchmarkSelection {
  const definition = config.benchmarks[benchmarkId];
  if (!definition) throw new Error(`Unknown benchmark: ${benchmarkId}`);
  const conflicts = [
    cli.caseId ? '--case' : undefined,
    cli.suite ? '--suite' : undefined,
    cli.agents?.length ? '--agents' : undefined,
    cli.attempts !== undefined ? '--attempts' : undefined,
  ].filter((value): value is string => Boolean(value));
  if (conflicts.length > 0) throw new Error(`--benchmark cannot be combined with ${conflicts.join(', ')}`);

  const testCases = config.testCases.filter((testCase) =>
    definition.select.cases?.includes(testCase.id)
    || Boolean(testCase.suite && definition.select.suites?.includes(testCase.suite)));
  return {
    id: benchmarkId,
    definition,
    digest: benchmarkDefinitionDigest(benchmarkId, definition),
    testCases,
    agentNames: [definition.arms.baseline, definition.arms.candidate],
  };
}

export function benchmarkDefinitionDigest(id: string, definition: BenchmarkDefinition): string {
  return createHash('sha256').update(JSON.stringify({ id, ...definition })).digest('hex');
}

export function filterBenchmarkRuns(runs: readonly ScannedTaskRun[], id: string, definition: BenchmarkDefinition): ScannedTaskRun[] {
  const digest = benchmarkDefinitionDigest(id, definition);
  return runs.filter((run) => run.benchmark?.id === id
    && run.benchmark.revision === definition.revision
    && run.benchmark.digest === digest);
}
