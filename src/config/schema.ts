export type WorkspaceMode = 'copy';

export interface WorkspaceSetupCommand {
  command: string;
  args: string[];
  cwd?: string;
  timeoutMs?: number;
  network?: NetworkPolicyConfig;
}

export interface WorkspaceGitConfig {
  repository: string;
  commit: string;
}

export interface WorkspaceConfig {
  source?: string;
  mode: WorkspaceMode;
  containerPath: string;
  ignore: string[];
  // Trusted commands executed without a shell in the resolved image after the
  // workspace is mounted and before its baseline snapshot is captured.
  setup?: WorkspaceSetupCommand[];
  fixture?: string;
  // Exact Git commit acquired on the host into the isolated run workspace.
  git?: WorkspaceGitConfig;
  // When true, the workspace is seeded by extracting `seedPath` (default /app)
  // from the resolved Docker image instead of copying `source`/`fixture`.
  // Used for Harbor/DeepSWE-style tasks whose repo lives inside the image.
  seedFromImage?: boolean;
  seedPath?: string;
}

export interface DockerConfig {
  image?: string;
  // Base image for the managed build. When set (and `image` is not), the agent
  // install recipe is layered on top of this image instead of MANAGED_BASE_IMAGE.
  baseImage?: string;
  // Commands run in the managed Dockerfile right after the base image, before
  // adapter recipes. Use to guarantee runtimes (node/python3) on arbitrary bases.
  baseSetup?: string[];
  // Local-only base images cannot be resolved by Docker's refresh-time pull.
  pullOnRefresh?: boolean;
  repoPath: string;
  home: string;
  configRoot: string;
  timeoutMs: number;
  envAllowlist: string[];
}

export type NetworkPolicyMode = 'default' | 'none' | 'allowlist';

export interface NetworkPolicyConfig {
  mode: NetworkPolicyMode;
  allow?: string[];
}

export interface AgentAuthConfig {
  type: 'oauth';
  profile?: string;
  openBrowser?: boolean;
}

export interface AgentConfig {
  adapter: string;
  extends?: string;
  label?: string;
  /** Stable public identity for comparing an effective profile across runs and config roots. */
  comparisonId?: string;
  command?: string;
  args?: string[];
  cwd?: string;
  env?: string[];
  envAllowlist?: string[];
  timeoutMs?: number;
  provider?: string;
  providerEnv?: string;
  model?: string;
  modelEnv?: string;
  thinking?: string;
  apiKeyEnv?: string;
  auth?: AgentAuthConfig;
  profile?: string;
  outputFormat?: string;
  useCurrentConfig?: boolean;
  projectConfigDirs?: string[];
  userConfigDirs?: string[];
  config?: Record<string, unknown>;
  parser?: string;
}

export interface AgentsSelection {
  include?: string[];
  exclude?: string[];
  overrides?: Record<string, Partial<AgentConfig>>;
}

export interface AdapterDeclaration {
  module: string;
  export?: string;
}

export interface MockConfig {
  root: string;
  strict: boolean;
  recordCalls: boolean;
}

export interface TestCaseMockConfig {
  cli?: Record<string, string>;
  mcp?: Record<string, string>;
  strict?: boolean;
}

export type VerifierRewardFormat = 'auto' | 'json' | 'text';

export interface TestCaseVerifierConfig {
  command: string;
  args?: string[];
  cwd?: string;
  env?: string[];
  timeoutMs?: number;
  infrastructureExitCodes?: number[];
  rewardFile?: string;
  rewardFormat?: VerifierRewardFormat;
  hiddenPatch?: string;
  captureModelPatch?: boolean;
  network?: NetworkPolicyConfig;
  // Project-relative host directory mounted read-only into the verifier
  // container only (not the agent steps). Used to deliver hidden tests.
  assetsDir?: string;
  // Container mount target for `assetsDir` (default /tests).
  assetsTarget?: string;
}

export interface OutputProviderConfig {
  type: string;
  module?: string;
  export?: string;
  config?: Record<string, unknown>;
}

export interface OutputConfig {
  providers: OutputProviderConfig[];
}

export interface ResultsStoreConfig {
  type: 'file';
  root: string;
}

export interface ResultsPublishConfig {
  store: ResultsStoreConfig;
  prefix: string;
  publicBaseUrl?: string;
}

export interface ResultsConfig {
  publish?: ResultsPublishConfig;
}

export type VisualizationFormat = 'html' | 'json' | 'csv';

export interface VisualizationIncludeConfig {
  logs: boolean;
  workspaceDiff: boolean;
  toolCalls: boolean;
  mockCalls: boolean;
  judgeDetails: boolean;
}

export interface VisualizationConfig {
  enabled: boolean;
  formats: VisualizationFormat[];
  latest: boolean;
  include: VisualizationIncludeConfig;
}

export interface JudgeDefaults {
  provider?: string;
  model?: string;
  apiKeyEnv?: string;
  temperature?: number;
  promptTemplate?: string;
}

export type JudgeInputRef =
  | 'finalOutput'
  | 'stdout'
  | 'stderr'
  | 'events'
  | 'toolCalls'
  | 'mockCalls'
  | 'assertions'
  | 'workspaceDiff'
  | 'cost';

export interface JudgeAssertionDefinition extends Partial<JudgeDefaults> {
  rubric: string;
  inputs: JudgeInputRef[];
}

export interface AssertionCondition {
  agent: string;
}

export interface BaseAssertionConfig {
  id?: string;
  type: string;
  required?: boolean;
  when?: AssertionCondition;
  [key: string]: unknown;
}

export interface LlmJudgeAssertionConfig extends BaseAssertionConfig {
  type: 'llmJudge';
  threshold: number;
  judge: JudgeAssertionDefinition;
}

export type AssertionConfig = BaseAssertionConfig | LlmJudgeAssertionConfig;

export type ScoreType = 'assertionPassRate' | 'judgeScore' | 'verifierReward' | 'latency' | 'cost' | 'tokenUsage';
export type ScoreTarget = 'maximize' | 'minimize';

export interface ScoreTypeConfig {
  weight: number;
}

export interface MetricScoreConfig extends ScoreTypeConfig {
  target?: ScoreTarget;
  best?: number;
  worst?: number;
}

export type ProjectScoringConfig = Partial<Record<ScoreType, ScoreTypeConfig | MetricScoreConfig>>;

export type BenchmarkGoal = 'minimize' | 'maximize';
export type BenchmarkTrialReducer = 'median' | 'mean';
export type BenchmarkCaseReducer = 'macroMean' | 'ratioOfReducedSums';

export interface BenchmarkSelector {
  suites?: string[];
  cases?: string[];
}

export interface BenchmarkArms {
  baseline: string;
  candidate: string;
}

export interface BenchmarkMetricRef {
  metric: string;
}

export interface BenchmarkObjective extends BenchmarkMetricRef {
  goal: BenchmarkGoal;
}

export type BenchmarkObjectives = BenchmarkObjective[];

export interface BenchmarkQualityGate extends BenchmarkMetricRef {
  min?: number;
  max?: number;
}

export interface BenchmarkAggregation {
  trials: BenchmarkTrialReducer;
  cases: BenchmarkCaseReducer;
}

export interface BenchmarkDefinition {
  revision: number;
  label: string;
  description?: string;
  select: BenchmarkSelector;
  arms: BenchmarkArms;
  trials: number;
  qualityGates: BenchmarkQualityGate[];
  objective: BenchmarkObjectives;
  aggregation: BenchmarkAggregation;
}

export interface BenchmarkRunMetadata {
  id: string;
  revision: number;
  digest: string;
}

export interface TestCaseStepDefinition {
  id: string;
  prompt: string;
  timeoutMs?: number;
  args?: string[];
  env?: string[];
  config?: Record<string, unknown>;
  mocks?: TestCaseMockConfig;
  assert: AssertionConfig[];
}

export interface TestCaseDefinition {
  id: string;
  description?: string;
  suite?: string;
  // Per-case base image (becomes docker.baseImage for this case's managed build).
  image?: string;
  workspace?: Partial<WorkspaceConfig>;
  agents?: AgentsSelection;
  mocks?: TestCaseMockConfig;
  verifier?: TestCaseVerifierConfig;
  attempts?: number;
  steps: TestCaseStepDefinition[];
  timeoutMs?: number;
  sourcePath?: string;

  prompt: string;
  assert: AssertionConfig[];
  args?: string[];
  env?: string[];
  config?: Record<string, unknown>;
  parser?: string;
}

export type TestCase = TestCaseDefinition;

export interface HarnessConfig {
  version: 1;
  artifactRoot: string;
  outputRoot: string;
  workspace: WorkspaceConfig;
  docker: DockerConfig;
  agents: Record<string, AgentConfig>;
  tests: string[];
  adapters: Record<string, AdapterDeclaration>;
  mocks: MockConfig;
  output: OutputConfig;
  results: ResultsConfig;
  visualization: VisualizationConfig;
  judge?: JudgeDefaults;
  scoring: ProjectScoringConfig;
  benchmarks: Record<string, BenchmarkDefinition>;
}

export interface LoadedHarnessConfig extends HarnessConfig {
  projectRoot: string;
  configPath: string;
  testCases: TestCase[];
}

export interface CliOverrides {
  benchmarkId?: string;
  agents?: string[];
  caseId?: string;
  suite?: string;
  concurrency?: number;
  attempts?: number;
  provider?: string;
  model?: string;
  timeoutMs?: number;
  dockerImage?: string;
  refreshManagedImage?: boolean;
  cleanup?: boolean;
}

export interface MatrixEntry {
  testCase: TestCase;
  agentName: string;
  agent: AgentConfig;
  workspace: WorkspaceConfig;
  docker: DockerConfig;
  attemptIndex: number;
  attemptNumber: number;
  attempts: number;
  benchmark?: BenchmarkRunMetadata;
}

export const DEFAULT_ENV_ALLOWLIST = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'DEEPSEEK_API_KEY',
  'MISTRAL_API_KEY',
  'GROQ_API_KEY',
  'CEREBRAS_API_KEY',
  'AZURE_OPENAI_API_KEY',
];

export const DEFAULT_HARNESS_CONFIG: HarnessConfig = {
  version: 1,
  artifactRoot: '.harness-evals/runs',
  outputRoot: '.harness-evals/output',
  workspace: {
    source: '.',
    mode: 'copy',
    containerPath: '/workspace',
    ignore: ['.git', 'node_modules', '.harness-evals', '.pi-evals', 'evals/output'],
    setup: [],
  },
  docker: {
    repoPath: '/workspace',
    home: '/home/harness',
    configRoot: '/agent-config',
    timeoutMs: 300_000,
    envAllowlist: DEFAULT_ENV_ALLOWLIST,
    baseSetup: [],
    pullOnRefresh: true,
  },
  agents: {},
  tests: ['evals/tests/**/*.yaml'],
  adapters: {},
  mocks: {
    root: 'evals/mocks',
    strict: true,
    recordCalls: true,
  },
  output: {
    providers: [{ type: 'file' }],
  },
  results: {},
  visualization: {
    enabled: true,
    formats: ['html', 'json', 'csv'],
    latest: true,
    include: {
      logs: true,
      workspaceDiff: true,
      toolCalls: true,
      mockCalls: true,
      judgeDetails: true,
    },
  },
  scoring: {
    assertionPassRate: { weight: 1 },
    judgeScore: { weight: 1 },
    verifierReward: { weight: 1 },
    latency: { weight: 0 },
    cost: { weight: 0 },
    tokenUsage: { weight: 0 },
  },
  benchmarks: {},
};
