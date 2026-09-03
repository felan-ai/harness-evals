export { loadHarnessConfig, type LoadHarnessConfigOptions } from './config/load.js';
export { runHarness, runTestCase, type RunHarnessOptions } from './runner/evaluate.js';
export { buildMatrix } from './runner/matrix.js';
export { metricsForRun, metricsForStep, type NumericMetrics } from './metrics.js';
export { benchmarkDefinitionDigest, resolveBenchmarkSelection, type ResolvedBenchmarkSelection } from './benchmarks/select.js';
export {
  analyzeBenchmark,
  type BenchmarkArmResult,
  type BenchmarkArmState,
  type BenchmarkAttemptComparison,
  type BenchmarkAttemptObservation,
  type BenchmarkCaseComparison,
  type BenchmarkCaseResult,
  type BenchmarkComparisonSummary,
  type BenchmarkObjectiveComparison,
  type BenchmarkReportData,
} from './benchmarks/analyze.js';
export { renderBenchmarkCsv, renderBenchmarkHtml, renderBenchmarkIndexHtml, renderBenchmarkJson } from './benchmarks/render.js';
export {
  ImageResolutionError,
  resolveDockerImage,
  type ImageMode,
  type ImageResolutionAgent,
  type ImageResolutionInput,
  type ImageResolutionResult,
  type InstallManifest,
  type NormalizedInstallRecipe,
  type ProbeResult,
} from './docker/image-resolver.js';
export {
  createAdapterRegistry,
  validateAdapterContract,
  validateAdapterReferences,
  builtInAdapters,
  type AdapterRegistry,
  type AdapterRegistryInput,
  type AgentAdapterMetadata,
} from './adapters/registry.js';
export {
  type AgentAdapter,
  type AgentCompletionInput,
  type AgentEventInput,
  type AgentStepPrepareInput,
  type AgentStepRunPlan,
  type AdapterInstallInput,
  type AdapterInstallRecipe,
  type AdapterProbe,
  type ApplyMcpMocksInput,
  type ApplyMcpMocksResult,
  type AdapterContinuation,
  type MockRuntimePlan,
} from './adapters/types.js';
export { commandAdapter } from './adapters/command.js';
export { piAdapter } from './adapters/pi.js';
export { felanAdapter } from './adapters/felan.js';
export { claudeCodeAdapter } from './adapters/claude-code.js';
export { codexAdapter } from './adapters/codex.js';
export { cursorAdapter } from './adapters/cursor.js';
export { builtInAssertions, runAssertions } from './assertions/builtins.js';
export type { AssertionContext, AssertionResult, AssertionRunner, AssertionRunOptions } from './assertions/types.js';
export { createConfiguredJudgeRunner, defaultJudgeRunner } from './judge/index.js';
export type { JudgeRecord, JudgeRequest, JudgeResult, JudgeRunner } from './judge/index.js';
export { buildScenarioScoreSummary, buildScoreSummary } from './scoring/index.js';
export type { ScoreBucketResult, ScoreSummary } from './scoring/index.js';
export { readMockCallLogs, strictMockFailures, summarizeMockCalls } from './mocks/calls.js';
export { mergeMockDeclarations, stageMockRuntime } from './mocks/stage.js';
export type { MockCallRecord, MockFixture, MockRule, MockSurface } from './mocks/types.js';
export type {
  HarnessConfig,
  LoadedHarnessConfig,
  AgentConfig,
  AgentAuthConfig,
  TestCase,
  TestCaseDefinition,
  TestCaseStepDefinition,
  AssertionConfig,
  AssertionCondition,
  AdapterDeclaration,
  MockConfig,
  TestCaseMockConfig,
  TestCaseVerifierConfig,
  VerifierRewardFormat,
  NetworkPolicyConfig,
  NetworkPolicyMode,
  OutputConfig,
  OutputProviderConfig,
  ResultsConfig,
  ResultsPublishConfig,
  ResultsStoreConfig,
  VisualizationConfig,
  JudgeDefaults,
  ProjectScoringConfig,
  BenchmarkAggregation,
  BenchmarkArms,
  BenchmarkCaseReducer,
  BenchmarkDefinition,
  BenchmarkGoal,
  BenchmarkMetricRef,
  BenchmarkObjective,
  BenchmarkObjectives,
  BenchmarkQualityGate,
  BenchmarkRunMetadata,
  BenchmarkSelector,
  BenchmarkTrialReducer,
  MatrixEntry,
  WorkspaceGitConfig,
} from './config/schema.js';
export type { HarnessRunResult, PassAtKSummary, ScenarioRunContext, ScenarioRunStatus, ScenarioStepResult, ScenarioStepStatus, TestRunResult } from './runner/result.js';
export { publishBatch, publishBatchStatus } from './results/public/publish.js';
export { FilePublicResultsStore } from './results/public/stores/file.js';
export type { LocalBatchRecord } from './runner/batch-record.js';
export type {
  PublicBatchIndexEntry, PublicBatchManifest, PublicBatchTotals, PublicBatchValidity, PublicBenchmarkIndexEntry, PublicCostSummary,
  PublicProvenance, PublicResultsIndex, PublicResultsObjectOptions, PublicResultsStore, PublicRunStatus, PublicRunSummary,
} from './results/public/types.js';
export type { HiddenPatchResult, ModelPatchArtifact, VerifierRewardResult, VerifierRunResult, VerifierStatus } from './verifier/types.js';
export { reprocessRetained } from './regrade.js';
export type { ReprocessOptions, ReprocessSource } from './regrade.js';
export type { WorkspaceDiff } from './workspace/diff.js';
export type { AgentEventsSummary, ToolCallSummary, MockCallSummary, CostReport, CostRollup, UsageReport } from './events/types.js';
export {
  createOutputDispatcher,
  OutputDispatcher,
  createFileOutputProvider,
  createOutputProviderRegistry,
  validateOutputProviderContract,
  type ConfiguredOutputProvider,
  type CreateOutputDispatcherInput,
  type CreateOutputProvidersInput,
  type FileOutputProviderOptions,
  type OutputBlob,
  type OutputBlobRef,
  type OutputFinalizeInput,
  type OutputProvider,
  type OutputProviderFactory,
  type OutputProviderFailure,
  type OutputProviderInitializeInput,
  type OutputProviderMetadata,
  type OutputProviderRegistry,
  type OutputProviderRegistryInput,
  type OutputRecord,
  type OutputRecordInput,
  type OutputRecordType,
  type OutputRunStatus,
} from './output/index.js';
