import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
import {
  copyFile,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { buildMatrix } from './runner/matrix.js';
import { buildScenarioScoreSummary, buildScoreSummary } from './scoring/aggregate.js';
import { loadHarnessConfig } from './config/load.js';
import { metricsForRun, metricsForStep } from './metrics.js';
import { resolveBenchmarkSelection } from './benchmarks/select.js';
import { runAssertions } from './assertions/builtins.js';
import type { LoadedHarnessConfig, MatrixEntry } from './config/schema.js';
import type { AssertionResult } from './assertions/types.js';
import type { ScenarioRunStatus, ScenarioStepResult, TestRunResult } from './runner/result.js';
import type { BenchmarkRunMetadata } from './config/schema.js';
import type { VerifierRunResult } from './verifier/types.js';
import { writeCompletedBatchRecord } from './runner/batch-record.js';
import { runVerifier } from './verifier/run.js';
import { buildRunReport } from './visualization/report.js';
import { renderReport } from './visualization/render.js';

export interface ReprocessOptions {
  configPath: string;
  sources: ReprocessSource[];
  concurrency: number;
  dryRun: boolean;
  probeRunId?: string;
}

export interface ReprocessSource {
  benchmarkId: string;
  batchId: string;
}

interface LocalBatchRecord {
  schemaVersion: number;
  batch: Record<string, unknown>;
  status: string;
  expectedRunCount: number;
  runIds: string[];
  completedAt?: string;
}

interface PreparedSource {
  benchmarkId: string;
  sourceBatchId: string;
  sourceBatchPath: string;
  sourceBatchDigest: string;
  sourceBenchmark: BenchmarkRunMetadata;
  targetBenchmark: BenchmarkRunMetadata;
  targetCaseIds: string[];
  targetAgentNames: string[];
  derivedBatch: DerivedBatch;
  runs: PreparedRun[];
}

interface PreparedRun {
  index: number;
  sourceRunId: string;
  sourceRunDir: string;
  derivedRunId: string;
  finalRunDir: string;
  entry: MatrixEntry;
  sourceSummary: Record<string, unknown>;
  sourceStarted: Record<string, unknown>;
  imageResolution: Record<string, unknown>;
  image: string;
  imageId: string;
  felanVersion?: string;
  sourceControlDigest: string;
  targetCaseDigest: string;
  verifierAssetsDigest: string;
}

interface DerivedBatch {
  batchId: string;
  startedAt: string;
  label: string;
  argv: string[];
  agents: string[];
  caseCount: number;
  runCount: number;
}

interface DerivedRunSummary {
  benchmarkId: string;
  sourceBatchId: string;
  derivedBatchId: string;
  sourceRunId: string;
  derivedRunId: string;
  caseId: string;
  agentName: string;
  attemptNumber: number;
  sourceStatus: string;
  status: string;
  sourcePass: boolean;
  pass: boolean;
  sourceVerifierStatus?: string;
  verifierStatus?: string;
  verifierReward?: number;
  sourceAssertionFailures: number;
  assertionFailures: number;
  durationMs: number;
  verifierDurationMs?: number;
  image: string;
  imageId: string;
  felanVersion?: string;
  sourceControlDigest: string;
  metrics: Record<string, number>;
}

interface ReverificationProvenance {
  schemaVersion: 1;
  kind: 'offline-reprocess';
  reverifiedAt: string;
  sourceRunId: string;
  sourceBatchId: string;
  sourceBenchmark: BenchmarkRunMetadata;
  targetBenchmark: BenchmarkRunMetadata;
  sourceControlDigest: string;
  targetCaseDigest: string;
  verifierAssetsDigest: string;
  agentExecution: 'reused';
  providerCalls: 0;
  workspace: 'temporary-copy';
  verifierNetwork: 'none' | 'not-run';
  publicationEligible: false;
}

const BATCH_ID_PATTERN = /^\d{8}-\d{6}-[0-9a-f]{4}$/u;
const CONTROL_PATHS = [
  'run-started.json',
  'result.json',
  'summary.json',
  'score-summary.json',
  'finalize.json',
  'verifier/verifier-started.json',
  'verifier/command.redacted.json',
  'verifier/stdout.log',
  'verifier/stderr.log',
  'verifier/reward.json',
  'verifier/result.json',
  'workspace/.harness-evals-reward.txt',
] as const;

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  await reprocessRetained(options);
}

export async function reprocessRetained(options: ReprocessOptions): Promise<void> {
  const config = await loadHarnessConfig({ configPath: options.configPath });
  const startedAt = new Date().toISOString();
  const reverificationId = batchId(startedAt);
  const harnessMetadata = await readHarnessMetadata(config.projectRoot);
  const preparedSources = await prepareSources(config, options.sources, startedAt);
  const preparedRuns = preparedSources.flatMap((source) => source.runs);
  const selectedRuns = options.probeRunId
    ? preparedRuns.filter((run) => run.sourceRunId === options.probeRunId)
    : preparedRuns;

  if (options.probeRunId && selectedRuns.length !== 1) {
    throw new Error(`Probe run must match exactly one selected source run: ${options.probeRunId}`);
  }

  const plan = {
    schemaVersion: 1,
    kind: 'offline-reprocess',
    mode: options.dryRun ? 'dry-run' : options.probeRunId ? 'probe' : 'complete',
    reverificationId,
    concurrency: options.concurrency,
    providerCalls: 0,
    agentExecutions: 0,
    harnessEvals: harnessMetadata,
    sources: preparedSources.map((source) => ({
      benchmarkId: source.benchmarkId,
      sourceBatchId: source.sourceBatchId,
      sourceBatchDigest: source.sourceBatchDigest,
      sourceBenchmark: source.sourceBenchmark,
      targetBenchmark: source.targetBenchmark,
      derivedBatchId: source.derivedBatch.batchId,
      runCount: source.runs.length,
      cases: source.targetCaseIds,
      agents: source.targetAgentNames,
    })),
    selectedRunCount: selectedRuns.length,
    selectedRunIds: selectedRuns.map((run) => run.sourceRunId),
  };

  if (options.dryRun) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }

  const harnessRoot = join(config.projectRoot, '.harness-evals');
  const stagingRoot = join(harnessRoot, 'reverification-staging', reverificationId);
  const workspaceRoot = join(harnessRoot, 'reverification-workspaces', reverificationId);
  const recordRoot = join(harnessRoot, 'reverifications', reverificationId);
  const stagedRunsRoot = join(stagingRoot, 'runs');
  const movedRunDirs: string[] = [];

  await mkdir(stagedRunsRoot, { recursive: true });
  await mkdir(workspaceRoot, { recursive: true });

  try {
    const results = await mapConcurrent(selectedRuns, options.concurrency, async (prepared) => {
      const source = sourceForPreparedRun(prepared, preparedSources);
      const result = await reverifyRun(config, source, prepared, stagedRunsRoot, workspaceRoot);
      console.log(`${result.status === 'passed' ? 'PASS' : 'FAIL'} ${result.derivedRunId}`);
      return result;
    });

    await assertSourcesUnchanged(preparedSources);

    const completedAt = new Date().toISOString();
    const manifest = buildManifest({
      plan,
      startedAt,
      completedAt,
      probeRunId: options.probeRunId,
      preparedSources,
      results,
    });

    if (options.probeRunId) {
      await mkdir(recordRoot, { recursive: true });
      await rename(join(stagedRunsRoot, results[0].derivedRunId), join(recordRoot, results[0].derivedRunId));
      await writeJson(join(recordRoot, 'manifest.json'), manifest);
    } else {
      for (const result of results) {
        const destination = join(config.artifactRoot, result.derivedRunId);
        await assertMissing(destination);
        await rename(join(stagedRunsRoot, result.derivedRunId), destination);
        movedRunDirs.push(destination);
      }
      for (const source of preparedSources) {
        await writeCompletedBatchRecord({
          projectRoot: config.projectRoot,
          batch: source.derivedBatch,
          expectedRunCount: source.runs.length,
          runIds: results.filter((result) => result.benchmarkId === source.benchmarkId).map((result) => result.derivedRunId),
        });
      }
      await mkdir(recordRoot, { recursive: true });
      await writeJson(join(recordRoot, 'manifest.json'), manifest);
    }

    console.log(`Manifest: ${relative(config.projectRoot, join(recordRoot, 'manifest.json'))}`);
    if (!options.probeRunId) {
      for (const source of preparedSources) {
        console.log(`${source.benchmarkId}: ${source.derivedBatch.batchId}`);
      }
    }
  } catch (error) {
    await Promise.all(movedRunDirs.map((path) => rm(path, { recursive: true, force: true })));
    await rm(recordRoot, { recursive: true, force: true });
    throw error;
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

function parseArgs(argv: string[]): ReprocessOptions {
  const options: ReprocessOptions = {
    configPath: 'harness-evals.yaml',
    sources: [],
    concurrency: 1,
    dryRun: false,
  };

  while (argv.length > 0) {
    const argument = argv.shift();
    switch (argument) {
      case '--config':
        options.configPath = readArgument(argv, argument);
        break;
      case '--source':
        options.sources.push(parseSource(readArgument(argv, argument)));
        break;
      case '--concurrency': {
        const concurrency = Number(readArgument(argv, argument));
        if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 3) {
          throw new Error('--concurrency must be an integer from 1 to 3');
        }
        options.concurrency = concurrency;
        break;
      }
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--probe-run':
        options.probeRunId = readArgument(argv, argument);
        break;
      case '--help':
        printHelp();
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${String(argument)}`);
    }
  }

  if (options.sources.length === 0) throw new Error('At least one --source <benchmark>=<batch> is required');
  if (new Set(options.sources.map((source) => source.benchmarkId)).size !== options.sources.length) {
    throw new Error('Each benchmark may be selected only once');
  }
  if (options.dryRun && options.probeRunId) throw new Error('--dry-run and --probe-run cannot be combined');
  return options;
}

function parseSource(value: string): ReprocessSource {
  const separator = value.indexOf('=');
  const benchmarkId = value.slice(0, separator);
  const batchIdValue = value.slice(separator + 1);
  if (separator <= 0 || !/^[a-z0-9][a-z0-9-]*$/u.test(benchmarkId)) {
    throw new Error(`Invalid --source benchmark: ${value}`);
  }
  if (!BATCH_ID_PATTERN.test(batchIdValue)) throw new Error(`Invalid --source batch ID: ${value}`);
  return { benchmarkId, batchId: batchIdValue };
}

function readArgument(argv: string[], name: string): string {
  const value = argv.shift();
  if (!value) throw new Error(`${name} requires a value`);
  return value;
}

function printHelp(): void {
  console.log(`Usage:
  bun scripts/reverify-retained.ts --source <benchmark>=<batch> [--source ...] [--concurrency 1-3]

Options:
  --config <path>       Harness configuration (default: harness-evals.yaml)
  --source <id>=<batch> Explicit benchmark and retained source batch; repeatable
  --concurrency <n>     Parallel verifier limit, maximum 3 (default: 1)
  --dry-run             Validate provenance and print the exact matrix only
  --probe-run <run-id>  Reverify one run outside the scanner-visible artifact root
`);
}

async function prepareSources(
  config: LoadedHarnessConfig,
  arguments_: ReprocessSource[],
  startedAt: string,
): Promise<PreparedSource[]> {
  const allDerivedIds = new Set<string>();
  let globalIndex = 0;
  const sources: PreparedSource[] = [];

  for (const [sourceIndex, argument] of arguments_.entries()) {
    const selection = resolveBenchmarkSelection(config, argument.benchmarkId);
    const entries = buildMatrix(config, { benchmarkId: argument.benchmarkId });
    const expected = new Map(entries.map((entry) => [matrixKey(entry.testCase.id, entry.agentName, entry.attemptNumber), entry]));
    const sourceBatchPath = join(config.projectRoot, '.harness-evals', 'batches', `${argument.batchId}.json`);
    const sourceBatch = await readJson<LocalBatchRecord>(sourceBatchPath);
    validateSourceBatch(sourceBatch, argument.batchId);
    const sourceBatchDigest = await sha256Path(sourceBatchPath);
    const derivedBatchStartedAt = new Date(Date.parse(startedAt) + sourceIndex).toISOString();
    const derivedBatch: DerivedBatch = {
      batchId: batchId(derivedBatchStartedAt),
      startedAt: derivedBatchStartedAt,
      label: `Offline verifier replay · ${argument.benchmarkId} · source ${argument.batchId}`,
      argv: ['reprocess', '--source', `${argument.benchmarkId}=${argument.batchId}`],
      agents: [...selection.agentNames],
      caseCount: selection.testCases.length,
      runCount: entries.length,
    };
    const preparedRuns: PreparedRun[] = [];
    let sourceBenchmark: BenchmarkRunMetadata | undefined;

    for (const sourceRunId of sourceBatch.runIds) {
      const sourceRunDir = join(config.artifactRoot, sourceRunId);
      const sourceSummary = await readJson<Record<string, unknown>>(join(sourceRunDir, 'summary.json'));
      const sourceStarted = await readJson<Record<string, unknown>>(join(sourceRunDir, 'run-started.json'));
      const imageResolution = await readJson<Record<string, unknown>>(join(sourceRunDir, 'image-resolution.json'));
      const caseId = requiredString(sourceSummary.caseId, `${sourceRunId} summary.caseId`);
      const agentName = requiredString(sourceSummary.agentName, `${sourceRunId} summary.agentName`);
      const attemptNumber = requiredInteger(sourceSummary.attemptNumber, `${sourceRunId} summary.attemptNumber`);
      const key = matrixKey(caseId, agentName, attemptNumber);
      const entry = expected.get(key);
      if (!entry) continue;
      expected.delete(key);
      validateSourceIdentity(sourceRunId, sourceSummary, sourceStarted, entry, argument);
      const benchmark = readBenchmarkMetadata(sourceSummary.benchmark, `${sourceRunId} summary.benchmark`);
      if (benchmark.id !== argument.benchmarkId) throw new Error(`${sourceRunId} belongs to benchmark ${benchmark.id}`);
      if (sourceBenchmark && !sameBenchmark(sourceBenchmark, benchmark)) {
        throw new Error(`Source batch ${argument.batchId} contains mixed benchmark definitions`);
      }
      sourceBenchmark = benchmark;

      const targetBenchmark = entry.benchmark;
      if (!targetBenchmark) throw new Error(`Current matrix entry has no benchmark metadata: ${key}`);
      if (sameBenchmark(benchmark, targetBenchmark)) {
        throw new Error(`${sourceRunId} already uses the current benchmark definition`);
      }
      validateOfflineInputs(entry, sourceRunId);
      await assertDirectory(join(sourceRunDir, 'workspace'));
      await assertFile(join(sourceRunDir, 'result.json'));
      const image = requiredString(imageResolution.image, `${sourceRunId} image-resolution.image`);
      const imageId = await dockerImageId(image);
      const felanVersion = readFelanVersion(imageResolution);
      const runStamp = new Date(Date.parse(derivedBatchStartedAt) + globalIndex + 1).toISOString();
      const derivedRunId = `${sanitize(caseId)}-${sanitize(agentName)}-reverified-${runStamp.replace(/[:.]/gu, '-')}-${globalIndex}`;
      if (allDerivedIds.has(derivedRunId)) throw new Error(`Duplicate derived run ID: ${derivedRunId}`);
      allDerivedIds.add(derivedRunId);
      const sourceControlDigest = await digestControlFiles(sourceRunDir);
      const targetCaseDigest = await sha256Path(requiredString(entry.testCase.sourcePath, `${caseId} sourcePath`));
      const verifierAssetsDigest = await verifierDigest(config.projectRoot, entry);

      preparedRuns.push({
        index: globalIndex,
        sourceRunId,
        sourceRunDir,
        derivedRunId,
        finalRunDir: join(config.artifactRoot, derivedRunId),
        entry,
        sourceSummary,
        sourceStarted,
        imageResolution,
        image,
        imageId,
        felanVersion,
        sourceControlDigest,
        targetCaseDigest,
        verifierAssetsDigest,
      });
      globalIndex += 1;
    }

    if (expected.size > 0) throw new Error(`Source batch ${argument.batchId} is missing matrix entries: ${[...expected.keys()].join(', ')}`);
    if (!sourceBenchmark) throw new Error(`Source batch ${argument.batchId} contains no runs`);
    const targetBenchmark = entries[0]?.benchmark;
    if (!targetBenchmark) throw new Error(`Benchmark ${argument.benchmarkId} has no current metadata`);
    sources.push({
      benchmarkId: argument.benchmarkId,
      sourceBatchId: argument.batchId,
      sourceBatchPath,
      sourceBatchDigest,
      sourceBenchmark,
      targetBenchmark,
      targetCaseIds: selection.testCases.map((testCase) => testCase.id),
      targetAgentNames: selection.agentNames,
      derivedBatch,
      runs: preparedRuns,
    });
  }

  return sources;
}

function validateSourceBatch(batch: LocalBatchRecord, expectedId: string): void {
  if (batch.schemaVersion !== 1 || batch.status !== 'completed') throw new Error(`Source batch is not completed: ${expectedId}`);
  if (!Array.isArray(batch.runIds) || batch.runIds.some((runId) => typeof runId !== 'string' || !runId)) {
    throw new Error(`Source batch has invalid run IDs: ${expectedId}`);
  }
  if (new Set(batch.runIds).size !== batch.runIds.length) throw new Error(`Source batch has duplicate run IDs: ${expectedId}`);
  if (batch.runIds.length !== batch.expectedRunCount) throw new Error(`Source batch ${expectedId} has ${batch.runIds.length}/${batch.expectedRunCount} runs`);
  const batchIdValue = requiredString(batch.batch?.batchId, `${expectedId} batch.batchId`);
  if (batchIdValue !== expectedId) throw new Error(`Source batch record identity mismatch: ${batchIdValue}`);
}

function validateSourceIdentity(
  runId: string,
  summary: Record<string, unknown>,
  started: Record<string, unknown>,
  entry: MatrixEntry,
  source: ReprocessSource,
): void {
  if (summary.batchId !== source.batchId || asRecord(started.batch)?.batchId !== source.batchId) {
    throw new Error(`${runId} does not belong to source batch ${source.batchId}`);
  }
  if (started.runId !== runId) throw new Error(`${runId} run-started identity mismatch`);
  if (summary.caseId !== entry.testCase.id || started.caseId !== entry.testCase.id) throw new Error(`${runId} case identity mismatch`);
  if (summary.agentName !== entry.agentName || started.agentName !== entry.agentName) throw new Error(`${runId} agent identity mismatch`);
  if (summary.attemptNumber !== entry.attemptNumber || started.attemptNumber !== entry.attemptNumber) throw new Error(`${runId} attempt identity mismatch`);
  if (summary.attempts !== entry.attempts || started.attempts !== entry.attempts) throw new Error(`${runId} attempt count mismatch`);
  const startedBenchmark = readBenchmarkMetadata(started.benchmark, `${runId} run-started.benchmark`);
  const summaryBenchmark = readBenchmarkMetadata(summary.benchmark, `${runId} summary.benchmark`);
  if (!sameBenchmark(startedBenchmark, summaryBenchmark)) throw new Error(`${runId} benchmark metadata disagrees across source artifacts`);
  const startedAgent = asRecord(started.agent);
  if (startedAgent?.comparisonId !== entry.agent.comparisonId) throw new Error(`${runId} comparison identity changed`);
  if (startedAgent?.provider !== entry.agent.provider || startedAgent?.model !== entry.agent.model) {
    throw new Error(`${runId} provider/model identity changed`);
  }
}

function validateOfflineInputs(entry: MatrixEntry, sourceRunId: string): void {
  const verifier = entry.testCase.verifier;
  if (verifier) {
    if ((verifier.network?.mode ?? 'none') !== 'none') throw new Error(`${sourceRunId} verifier network must be none`);
    if ((verifier.env?.length ?? 0) > 0) throw new Error(`${sourceRunId} verifier may not forward environment variables`);
    if (verifier.hiddenPatch || verifier.captureModelPatch) {
      throw new Error(`${sourceRunId} uses hidden patch capture, which retained replay does not support`);
    }
  }
  const judgeAssertions = entry.testCase.steps.flatMap((step) => step.assert).filter((assertion) => assertion.type === 'llmJudge');
  if (judgeAssertions.length > 0) throw new Error(`${sourceRunId} uses llmJudge assertions, which could call a provider`);
}

async function reverifyRun(
  config: LoadedHarnessConfig,
  source: PreparedSource,
  prepared: PreparedRun,
  stagedRunsRoot: string,
  workspaceRoot: string,
): Promise<DerivedRunSummary> {
  const verifier = prepared.entry.testCase.verifier;
  if (!prepared.entry.benchmark) throw new Error(`Missing benchmark metadata for ${prepared.sourceRunId}`);
  const runWorkspaceRoot = join(workspaceRoot, prepared.derivedRunId);
  const workspaceDir = join(runWorkspaceRoot, 'workspace');
  const configDir = join(runWorkspaceRoot, 'config');
  const stagedRunDir = join(stagedRunsRoot, prepared.derivedRunId);
  await assertMissing(stagedRunDir);

  try {
    await cloneWorkspace(join(prepared.sourceRunDir, 'workspace'), workspaceDir);
    await mkdir(configDir, { recursive: true, mode: 0o700 });
    const clonedWorkspace = await realpath(workspaceDir);
    const sourceWorkspace = await realpath(join(prepared.sourceRunDir, 'workspace'));
    if (clonedWorkspace === sourceWorkspace) throw new Error(`Workspace clone aliases its source: ${prepared.sourceRunId}`);

    const verifierResult = verifier
      ? await runVerifier({
        verifier,
        dockerImage: prepared.image,
        workspaceDir,
        configDir,
        workspace: prepared.entry.workspace,
        docker: prepared.entry.docker,
        projectRoot: config.projectRoot,
        caseId: prepared.entry.testCase.id,
        agentName: prepared.entry.agentName,
      })
      : undefined;
    if (verifierResult) assertVerifierIsolation(verifierResult, workspaceDir, configDir);

    const sourceResult = await readJson<TestRunResult>(join(prepared.sourceRunDir, 'result.json'));
    const steps = await regradeAssertions(config, prepared.entry, sourceResult.steps);
    const reprocessedAt = verifierResult?.completedAt ?? new Date().toISOString();
    const result = buildDerivedResult(config, prepared, sourceResult, steps, verifierResult, reprocessedAt);
    const provenance = buildRunProvenance(prepared, reprocessedAt);
    await writeDerivedArtifacts(source, prepared, stagedRunDir, result, verifierResult, provenance);
    await validateDerivedArtifacts(stagedRunDir, result, provenance);

    const unchangedDigest = await digestControlFiles(prepared.sourceRunDir);
    if (unchangedDigest !== prepared.sourceControlDigest) {
      throw new Error(`Source run changed during reverification: ${prepared.sourceRunId}`);
    }

    return summarizeDerivedRun(source, prepared, sourceResult, result, verifierResult);
  } finally {
    await rm(runWorkspaceRoot, { recursive: true, force: true });
  }
}

async function regradeAssertions(
  config: LoadedHarnessConfig,
  entry: MatrixEntry,
  sourceSteps: ScenarioStepResult[],
): Promise<ScenarioStepResult[]> {
  if (sourceSteps.length !== entry.testCase.steps.length) {
    throw new Error(`${entry.testCase.id}/${entry.agentName} step count changed`);
  }

  const steps: ScenarioStepResult[] = [];
  for (const [index, sourceStep] of sourceSteps.entries()) {
    const definition = entry.testCase.steps[index];
    if (!definition || definition.id !== sourceStep.originalStepId) {
      throw new Error(`${entry.testCase.id}/${entry.agentName} step identity changed at index ${index}`);
    }
    if (sourceStep.status === 'error' || sourceStep.status === 'timeout' || sourceStep.status === 'skipped') {
      steps.push(structuredClone(sourceStep));
      continue;
    }
    const assertions = await runAssertions(definition.assert, {
      agentName: entry.agentName,
      output: sourceStep.output,
      stdout: sourceStep.stdout,
      stderr: sourceStep.stderr,
      exitCode: sourceStep.exitCode,
      events: sourceStep.events,
      workspace: sourceStep.workspace,
      metadata: sourceStep.metadata,
      mockCalls: sourceStep.events.mockCalls,
    });
    const pass = requiredAssertionsPass(assertions);
    const status = pass ? 'passed' : 'failed';
    const score = buildScoreSummary(config.scoring, {
      assertions,
      durationMs: sourceStep.durationMs,
      cost: sourceStep.cost,
    });
    steps.push({
      ...structuredClone(sourceStep),
      status,
      pass,
      assertions,
      score,
      metrics: metricsForStep({ durationMs: sourceStep.durationMs, pass, cost: sourceStep.cost }),
      metadata: {
        ...structuredClone(sourceStep.metadata),
        reverification: { assertionsReplayed: true },
      },
    });
  }
  return steps;
}

function buildDerivedResult(
  config: LoadedHarnessConfig,
  prepared: PreparedRun,
  source: TestRunResult,
  steps: ScenarioStepResult[],
  verifier: VerifierRunResult | undefined,
  reprocessedAt: string,
): TestRunResult {
  const status = runStatus(steps, verifier);
  const pass = status === 'passed';
  const assertions = steps.flatMap((step) => step.assertions);
  const score = buildScenarioScoreSummary(config.scoring, steps, verifier);
  const durationMs = Math.max(0, source.durationMs - (source.verifier?.durationMs ?? 0) + (verifier?.durationMs ?? 0));
  const metrics = metricsForRun({ durationMs, pass, qualityValid: status !== 'invalid', cost: source.cost });
  const stepError = steps.find((step) => step.status === 'error' || step.status === 'timeout')?.error;
  const error = stepError ?? verifier?.error;
  const provenance = buildRunProvenance(prepared, reprocessedAt);
  const sourceMetadata = asRecord(source.metadata) ?? {};

  return {
    ...structuredClone(source),
    runId: prepared.derivedRunId,
    runDir: prepared.finalRunDir,
    status,
    pass,
    durationMs,
    steps,
    assertions,
    score,
    verifier,
    error,
    metrics,
    metadata: {
      ...structuredClone(sourceMetadata),
      runId: prepared.derivedRunId,
      runDir: prepared.finalRunDir,
      status,
      benchmark: prepared.entry.benchmark,
      score,
      verifier,
      reverification: provenance,
    },
  };
}

function runStatus(steps: ScenarioStepResult[], verifier?: VerifierRunResult): ScenarioRunStatus {
  if (steps.length === 0 || steps.some((step) => step.status === 'error')) return 'error';
  if (steps.some((step) => step.status === 'timeout')) return 'timeout';
  if (verifier?.status === 'invalid') return 'invalid';
  if (verifier?.status === 'error') return 'error';
  if (verifier?.status === 'timeout') return 'timeout';
  if (verifier && !verifier.pass) return 'failed';
  return steps.every((step) => step.status === 'passed') ? 'passed' : 'failed';
}

function requiredAssertionsPass(assertions: AssertionResult[]): boolean {
  return assertions.every((assertion) => assertion.pass || !assertion.required);
}

function buildRunProvenance(prepared: PreparedRun, reverifiedAt: string): ReverificationProvenance {
  const sourceBenchmark = readBenchmarkMetadata(prepared.sourceSummary.benchmark, `${prepared.sourceRunId} source benchmark`);
  const targetBenchmark = prepared.entry.benchmark;
  if (!targetBenchmark) throw new Error(`Missing target benchmark for ${prepared.sourceRunId}`);
  return {
    schemaVersion: 1,
    kind: 'offline-reprocess',
    reverifiedAt,
    sourceRunId: prepared.sourceRunId,
    sourceBatchId: requiredString(prepared.sourceSummary.batchId, `${prepared.sourceRunId} batchId`),
    sourceBenchmark,
    targetBenchmark,
    sourceControlDigest: prepared.sourceControlDigest,
    targetCaseDigest: prepared.targetCaseDigest,
    verifierAssetsDigest: prepared.verifierAssetsDigest,
    agentExecution: 'reused',
    providerCalls: 0,
    workspace: 'temporary-copy',
    verifierNetwork: prepared.entry.testCase.verifier ? 'none' : 'not-run',
    publicationEligible: false,
  };
}

async function writeDerivedArtifacts(
  source: PreparedSource,
  prepared: PreparedRun,
  runDir: string,
  result: TestRunResult,
  verifier: VerifierRunResult | undefined,
  provenance: ReverificationProvenance,
): Promise<void> {
  const sourceSummary = prepared.sourceSummary;
  const sourceStarted = prepared.sourceStarted;
  const assertions = result.assertions;
  const batch = source.derivedBatch;
  const runStarted = {
    ...structuredClone(sourceStarted),
    runId: prepared.derivedRunId,
    runDir: prepared.finalRunDir,
    benchmark: prepared.entry.benchmark,
    batch,
    reverification: provenance,
  };
  const summary = {
    ...structuredClone(sourceSummary),
    batchId: batch.batchId,
    benchmark: prepared.entry.benchmark,
    runDir: prepared.finalRunDir,
    status: result.status,
    pass: result.pass,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    error: result.error,
    score: result.score,
    verifier,
    metrics: result.metrics,
    steps: result.steps.map((step) => ({
      id: step.id,
      originalStepId: step.originalStepId,
      stepIndex: step.stepIndex,
      status: step.status,
      pass: step.pass,
      durationMs: step.durationMs,
      score: step.score,
      cost: step.cost,
      error: step.error,
    })),
    assertions: {
      total: assertions.length,
      passed: assertions.filter((assertion) => assertion.pass || !assertion.required).length,
      failedRequired: assertions.filter((assertion) => !assertion.pass && assertion.required).length,
    },
    reverification: provenance,
  };
  await writeJson(join(runDir, 'run-started.json'), runStarted);
  await writeJson(join(runDir, 'image-resolution.json'), prepared.imageResolution);
  await copyOptional(join(prepared.sourceRunDir, 'workspace-source.json'), join(runDir, 'workspace-source.json'));
  await copyOptional(join(prepared.sourceRunDir, 'workspace-diff.json'), join(runDir, 'workspace-diff.json'));
  await writeJson(join(runDir, 'score-summary.json'), result.score);
  await writeJson(join(runDir, 'cost-summary.json'), result.cost);
  await writeJson(join(runDir, 'result.json'), result);
  await writeJson(join(runDir, 'summary.json'), summary);
  await writeJson(join(runDir, 'benchmark-metrics.json'), {
    schemaVersion: 1,
    source: 'historical-derived',
    derivation: 'offline-reprocess',
    sourceRunId: prepared.sourceRunId,
    targetBenchmark: prepared.entry.benchmark,
    metrics: result.metrics,
  });
  await writeJson(join(runDir, 'reverification.json'), provenance);
  if (verifier) {
    await mkdir(join(runDir, 'verifier'), { recursive: true });
    await writeJson(join(runDir, 'verifier', 'verifier-started.json'), {
      command: prepared.entry.testCase.verifier?.command,
      args: prepared.entry.testCase.verifier?.args ?? [],
      rewardFile: prepared.entry.testCase.verifier?.rewardFile,
      rewardFormat: prepared.entry.testCase.verifier?.rewardFormat,
      network: prepared.entry.testCase.verifier?.network ?? { mode: 'none' },
    });
    if (verifier.command) await writeJson(join(runDir, 'verifier', 'command.redacted.json'), verifier.command);
    await writeFile(join(runDir, 'verifier', 'stdout.log'), verifier.stdout);
    await writeFile(join(runDir, 'verifier', 'stderr.log'), verifier.stderr);
    if (verifier.reward) await writeJson(join(runDir, 'verifier', 'reward.json'), verifier.reward);
    await writeJson(join(runDir, 'verifier', 'result.json'), verifier);
  }
  await writeFile(join(runDir, 'records.jsonl'), `${JSON.stringify({ type: 'offline-reprocess', runId: prepared.derivedRunId, provenance })}\n`);
  await writeFile(join(runDir, 'index.html'), renderReport(buildRunReport(result, { runId: prepared.derivedRunId }), 'html', { reportPath: join(runDir, 'index.html') }));
  await writeJson(join(runDir, 'finalize.json'), {
    runId: prepared.derivedRunId,
    status: result.status === 'passed' ? 'passed' : result.status === 'error' ? 'error' : 'failed',
    providerFailures: [],
    reverification: provenance,
  });

  for (const step of result.steps) {
    const stepDir = join(runDir, 'steps', sanitize(step.id));
    await mkdir(stepDir, { recursive: true });
    await writeJson(join(stepDir, 'assertions.json'), step.assertions);
    await writeJson(join(stepDir, 'score.json'), step.score);
    await writeJson(join(stepDir, 'cost.json'), step.cost);
    await writeJson(join(stepDir, 'step-completed.json'), {
      stepId: step.id,
      originalStepId: step.originalStepId,
      stepIndex: step.stepIndex,
      status: step.status,
      pass: step.pass,
      exitCode: step.exitCode,
      durationMs: step.durationMs,
      startedAt: step.startedAt,
      completedAt: step.completedAt,
      error: step.error,
      score: step.score,
      cost: step.cost,
      assertions: {
        total: step.assertions.length,
        passed: step.assertions.filter((assertion) => assertion.pass || !assertion.required).length,
        failedRequired: step.assertions.filter((assertion) => !assertion.pass && assertion.required).length,
      },
      failedAssertions: step.assertions
        .filter((assertion) => !assertion.pass && assertion.required && assertion.id)
        .map((assertion) => assertion.id),
    });
  }
}

async function validateDerivedArtifacts(
  runDir: string,
  expectedResult: TestRunResult,
  expectedProvenance: ReverificationProvenance,
): Promise<void> {
  const result = await readJson<TestRunResult>(join(runDir, 'result.json'));
  const summary = await readJson<Record<string, unknown>>(join(runDir, 'summary.json'));
  const score = await readJson<Record<string, unknown>>(join(runDir, 'score-summary.json'));
  const verifier = expectedResult.verifier
    ? await readJson<VerifierRunResult>(join(runDir, 'verifier', 'result.json'))
    : undefined;
  const provenance = await readJson<ReverificationProvenance>(join(runDir, 'reverification.json'));
  const metrics = asRecord(summary.metrics);
  if (result.runId !== expectedResult.runId || summary.status !== result.status || summary.pass !== result.pass) {
    throw new Error(`Derived result/summary identity or status mismatch: ${expectedResult.runId}`);
  }
  if (verifier && (verifier.status !== result.verifier?.status || verifier.pass !== result.verifier?.pass)) {
    throw new Error(`Derived verifier/result mismatch: ${expectedResult.runId}`);
  }
  if (JSON.stringify(score) !== JSON.stringify(result.score) || JSON.stringify(summary.score) !== JSON.stringify(result.score)) {
    throw new Error(`Derived score artifacts disagree: ${expectedResult.runId}`);
  }
  const expectedQuality = result.status === 'invalid' ? undefined : result.pass ? 1 : 0;
  if (metrics?.['quality.passRate'] !== expectedQuality) {
    throw new Error(`Derived quality metric disagrees with pass status: ${expectedResult.runId}`);
  }
  if (JSON.stringify(provenance) !== JSON.stringify(expectedProvenance)) {
    throw new Error(`Derived provenance artifact mismatch: ${expectedResult.runId}`);
  }
}

function summarizeDerivedRun(
  sourceBatch: PreparedSource,
  prepared: PreparedRun,
  source: TestRunResult,
  result: TestRunResult,
  verifier: VerifierRunResult | undefined,
): DerivedRunSummary {
  const sourceVerifierStatus = source.verifier?.status;
  const sourceAssertionFailures = source.assertions.filter((assertion) => !assertion.pass && assertion.required).length;
  const assertionFailures = result.assertions.filter((assertion) => !assertion.pass && assertion.required).length;
  const metrics = result.metrics ?? {};
  return {
    benchmarkId: prepared.entry.benchmark?.id ?? 'unknown',
    sourceBatchId: requiredString(prepared.sourceSummary.batchId, `${prepared.sourceRunId} batchId`),
    derivedBatchId: sourceBatch.derivedBatch.batchId,
    sourceRunId: prepared.sourceRunId,
    derivedRunId: prepared.derivedRunId,
    caseId: result.caseId,
    agentName: result.agentName,
    attemptNumber: result.attemptNumber,
    sourceStatus: source.status,
    status: result.status,
    sourcePass: source.pass,
    pass: result.pass,
    sourceVerifierStatus,
    verifierStatus: verifier?.status,
    verifierReward: verifier?.reward?.primary,
    sourceAssertionFailures,
    assertionFailures,
    durationMs: result.durationMs,
    verifierDurationMs: verifier?.durationMs,
    image: prepared.image,
    imageId: prepared.imageId,
    felanVersion: prepared.felanVersion,
    sourceControlDigest: prepared.sourceControlDigest,
    metrics,
  };
}

function buildManifest(input: {
  plan: Record<string, unknown>;
  startedAt: string;
  completedAt: string;
  probeRunId?: string;
  preparedSources: PreparedSource[];
  results: DerivedRunSummary[];
}): Record<string, unknown> {
  const passed = input.results.filter((result) => result.pass).length;
  return {
    ...input.plan,
    status: 'completed',
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    probeRunId: input.probeRunId,
    publicationEligible: false,
    originalArtifacts: 'preserved',
    workspaces: 'temporary copies removed',
    totals: {
      runs: input.results.length,
      passed,
      failed: input.results.length - passed,
      providerCalls: 0,
      agentExecutions: 0,
    },
    derivedBatches: input.preparedSources.map((source) => ({
      benchmarkId: source.benchmarkId,
      ...source.derivedBatch,
      sourceBatchId: source.sourceBatchId,
      sourceBatchDigest: source.sourceBatchDigest,
      sourceBenchmark: source.sourceBenchmark,
      targetBenchmark: source.targetBenchmark,
      publicationEligible: false,
      runIds: input.results
        .filter((result) => result.benchmarkId === source.benchmarkId)
        .map((result) => result.derivedRunId),
    })),
    results: input.results,
  };
}

async function assertSourcesUnchanged(sources: PreparedSource[]): Promise<void> {
  for (const source of sources) {
    if (await sha256Path(source.sourceBatchPath) !== source.sourceBatchDigest) {
      throw new Error(`Source batch record changed during reverification: ${source.sourceBatchId}`);
    }
    for (const run of source.runs) {
      if (await digestControlFiles(run.sourceRunDir) !== run.sourceControlDigest) {
        throw new Error(`Source run changed during reverification: ${run.sourceRunId}`);
      }
    }
  }
}

function assertVerifierIsolation(result: VerifierRunResult, workspaceDir: string, configDir: string): void {
  if (asRecord(result.metadata)?.network && asRecord(asRecord(result.metadata)?.network)?.mode !== 'none') {
    throw new Error('Verifier replay did not use network none');
  }
  const command = asRecord(result.command);
  const mounts = asRecord(command?.mounts);
  const workspace = asRecord(mounts?.workspace);
  const config = asRecord(mounts?.config);
  if (workspace?.source !== workspaceDir || workspace?.readonly !== false) {
    throw new Error('Verifier replay command did not mount the temporary workspace as expected');
  }
  if (config?.source !== configDir || config?.readonly !== false) {
    throw new Error('Verifier replay command did not mount the empty temporary config as expected');
  }
  if (command?.network && asRecord(command.network)?.mode !== 'none') {
    throw new Error('Verifier replay command metadata did not record network none');
  }
}

async function cloneWorkspace(source: string, destination: string): Promise<void> {
  await assertDirectory(source);
  await assertMissing(destination);
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  if (process.platform === 'darwin') {
    const cloned = spawnSync('cp', ['-cR', source, destination], { stdio: 'pipe' });
    if (cloned.status === 0) return;
    await rm(destination, { recursive: true, force: true });
  }
  await cp(source, destination, {
    recursive: true,
    preserveTimestamps: true,
    verbatimSymlinks: true,
    mode: constants.COPYFILE_FICLONE,
  });
}

async function verifierDigest(projectRoot: string, entry: MatrixEntry): Promise<string> {
  const assetsDir = entry.testCase.verifier?.assetsDir;
  if (!assetsDir) return sha256Text('no-assets');
  const path = resolve(projectRoot, assetsDir);
  assertContained(projectRoot, path, `verifier assets for ${entry.testCase.id}`);
  return sha256Path(path);
}

async function digestControlFiles(runDir: string): Promise<string> {
  const hash = createHash('sha256');
  for (const path of CONTROL_PATHS) {
    hash.update(path);
    hash.update(await sha256Path(join(runDir, path), true));
  }
  return hash.digest('hex');
}

async function sha256Path(path: string, allowMissing = false): Promise<string> {
  let status;
  try {
    status = await lstat(path);
  } catch (error) {
    if (allowMissing && isMissing(error)) return sha256Text('missing');
    throw error;
  }
  const hash = createHash('sha256');
  if (status.isSymbolicLink()) {
    hash.update('symlink\0');
    hash.update(await readlink(path));
    return hash.digest('hex');
  }
  if (status.isFile()) {
    hash.update('file\0');
    hash.update(await readFile(path));
    return hash.digest('hex');
  }
  if (status.isDirectory()) {
    hash.update('directory\0');
    for (const entry of (await readdir(path)).sort()) {
      hash.update(entry);
      hash.update(await sha256Path(join(path, entry)));
    }
    return hash.digest('hex');
  }
  hash.update(`other:${status.mode}:${status.size}`);
  return hash.digest('hex');
}

function sha256Text(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function dockerImageId(image: string): Promise<string> {
  const result = spawnSync('docker', ['image', 'inspect', image, '--format', '{{.Id}}'], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`Recorded Docker image is unavailable: ${image}: ${result.stderr.trim()}`);
  }
  const id = result.stdout.trim();
  if (!id.startsWith('sha256:')) throw new Error(`Docker returned an invalid image ID for ${image}`);
  return id;
}

function readFelanVersion(imageResolution: Record<string, unknown>): string | undefined {
  const probes = Array.isArray(imageResolution.probes) ? imageResolution.probes.map(asRecord).filter(Boolean) : [];
  const probe = probes.find((candidate) => {
    const command = Array.isArray(candidate?.command) ? candidate.command : [];
    return command.length === 2 && command[0] === 'felan' && command[1] === '--version';
  });
  return typeof probe?.stdout === 'string' ? probe.stdout.trim() : undefined;
}

async function readHarnessMetadata(projectRoot: string): Promise<Record<string, unknown>> {
  const packagePath = join(projectRoot, 'node_modules', 'harness-evals', 'package.json');
  const packageJson = await readJson<Record<string, unknown>>(packagePath);
  const linkedPath = await realpath(join(projectRoot, 'node_modules', 'harness-evals'));
  const commit = gitOutput(linkedPath, ['rev-parse', 'HEAD']);
  return {
    version: packageJson.version,
    commit,
    linkedPath: relative(projectRoot, linkedPath),
  };
}

function gitOutput(cwd: string, args: string[]): string | undefined {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

function sourceForPreparedRun(run: PreparedRun, sources: PreparedSource[]): PreparedSource {
  const source = sources.find((candidate) => candidate.runs.includes(run));
  if (!source) throw new Error(`Internal source lookup failed for ${run.sourceRunId}`);
  return source;
}

async function mapConcurrent<T, R>(items: readonly T[], concurrency: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  let failure: unknown;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (failure === undefined) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      try {
        results[index] = await worker(items[index]);
      } catch (error) {
        failure = error;
      }
    }
  });
  await Promise.all(workers);
  if (failure !== undefined) throw failure;
  return results;
}

function batchId(iso: string): string {
  const stamp = iso.replace(/[-:]/gu, '').slice(0, 15).replace('T', '-');
  return `${stamp}-${randomBytes(2).toString('hex')}`;
}

function matrixKey(caseId: string, agentName: string, attemptNumber: number): string {
  return `${caseId}|${agentName}|${attemptNumber}`;
}

function sanitize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_.-]+/gu, '-').replace(/^-+|-+$/gu, '') || 'run';
}

function readBenchmarkMetadata(value: unknown, field: string): BenchmarkRunMetadata {
  const record = asRecord(value);
  if (!record) throw new Error(`${field} must be an object`);
  return {
    id: requiredString(record.id, `${field}.id`),
    revision: requiredInteger(record.revision, `${field}.revision`),
    digest: requiredString(record.digest, `${field}.digest`),
  };
}

function sameBenchmark(left: BenchmarkRunMetadata, right: BenchmarkRunMetadata): boolean {
  return left.id === right.id && left.revision === right.revision && left.digest === right.digest;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${field} must be a non-empty string`);
  return value;
}

function requiredInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value)) throw new Error(`${field} must be an integer`);
  return value as number;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function copyOptional(source: string, destination: string): Promise<void> {
  try {
    await copyFile(source, destination);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

async function assertDirectory(path: string): Promise<void> {
  const status = await lstat(path);
  if (!status.isDirectory() || status.isSymbolicLink()) throw new Error(`Expected a real directory: ${path}`);
}

async function assertFile(path: string): Promise<void> {
  const status = await lstat(path);
  if (!status.isFile() || status.isSymbolicLink()) throw new Error(`Expected a regular file: ${path}`);
}

async function assertMissing(path: string): Promise<void> {
  try {
    await stat(path);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  throw new Error(`Path already exists: ${path}`);
}

function assertContained(root: string, child: string, label: string): void {
  const relativePath = relative(root, child);
  if (relativePath.startsWith('..') || isAbsolute(relativePath)) throw new Error(`${label} escapes the project root`);
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
