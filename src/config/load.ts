import { readFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fg from 'fast-glob';
import YAML from 'yaml';
import { safeStepId } from '../step-id.js';
import { resolveAgentExtends, withHarnessDefaults, type HarnessConfigOverride } from './merge.js';
import { findHarnessConfig, resolveOptionalProjectPath, resolveProjectPath } from './paths.js';
import type {
  AdapterDeclaration,
  AgentAuthConfig,
  AgentConfig,
  AgentsSelection,
  AssertionCondition,
  AssertionConfig,
  BenchmarkAggregation,
  BenchmarkDefinition,
  BenchmarkGoal,
  BenchmarkQualityGate,
  BenchmarkTrialReducer,
  HarnessConfig,
  JudgeAssertionDefinition,
  JudgeDefaults,
  LoadedHarnessConfig,
  MockConfig,
  NetworkPolicyConfig,
  OutputConfig,
  OutputProviderConfig,
  ProjectScoringConfig,
  ResultsConfig,
  ResultsPublishConfig,
  ResultsStoreConfig,
  ScoreType,
  TestCase,
  TestCaseMockConfig,
  TestCaseStepDefinition,
  TestCaseVerifierConfig,
  VerifierRewardFormat,
  VisualizationConfig,
  VisualizationFormat,
  WorkspaceConfig,
  WorkspaceGitConfig,
} from './schema.js';

export interface LoadHarnessConfigOptions {
  cwd?: string;
  configPath?: string;
}

const BUILT_IN_PROVIDER_TYPES = new Set(['file']);
const VISUALIZATION_FORMATS = new Set<VisualizationFormat>(['html', 'json', 'csv']);
const SCORING_TYPES = new Set<ScoreType>(['assertionPassRate', 'judgeScore', 'verifierReward', 'latency', 'cost', 'tokenUsage']);
const METRIC_SCORING_TYPES = new Set<ScoreType>(['latency', 'cost', 'tokenUsage']);
const SCORE_TARGETS = new Set(['maximize', 'minimize']);
const JUDGE_INPUT_REFS = new Set(['finalOutput', 'stdout', 'stderr', 'events', 'toolCalls', 'mockCalls', 'assertions', 'workspaceDiff', 'cost']);
const VERIFIER_REWARD_FORMATS = new Set<VerifierRewardFormat>(['auto', 'json', 'text']);
const NETWORK_POLICY_MODES = new Set<NetworkPolicyConfig['mode']>(['default', 'none', 'allowlist']);
const BENCHMARK_GOALS = new Set<BenchmarkGoal>(['minimize', 'maximize']);
const BENCHMARK_TRIAL_REDUCERS = new Set<BenchmarkTrialReducer>(['median', 'mean']);
const BENCHMARK_METRIC_PATTERN = /^[a-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)+$/;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

const BASE_ASSERTION_KEYS = ['id', 'type', 'required', 'when'] as const;
const ASSERTION_KEYS: Record<string, readonly string[]> = {
  exitCode: assertionKeys('equals'),
  contains: assertionKeys('value'),
  notContains: assertionKeys('value'),
  toolCalled: assertionKeys('name', 'min', 'max', 'argsContain', 'isError'),
  mockCalled: assertionKeys('name', 'surface', 'min', 'max', 'argsContain', 'matched'),
  noToolErrors: assertionKeys(),
  workspaceDiff: assertionKeys('changedFiles', 'addedFiles', 'deletedFiles', 'minChanged', 'maxChanged'),
  settingsDrivenSetup: assertionKeys(),
  llmJudge: assertionKeys('threshold', 'judge'),
};

function assertionKeys(...keys: string[]): readonly string[] {
  return [...BASE_ASSERTION_KEYS, ...keys];
}

export async function loadHarnessConfig(options: LoadHarnessConfigOptions = {}): Promise<LoadedHarnessConfig> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const configPath = options.configPath ? resolve(cwd, options.configPath) : await findHarnessConfig(cwd);
  const projectRoot = dirname(configPath);
  const rawConfig = await readYamlFile(configPath);
  const interpolated = interpolateEnv(rawConfig);
  const config = normalizeHarnessConfig(withHarnessDefaults(readHarnessConfig(interpolated)), projectRoot);
  const testCases = await loadTestCases(config.tests, projectRoot, config.mocks);
  validateExplicitJudgeConfig(testCases, config.judge);
  validateAssertionConditions(testCases, config.agents);
  validateBenchmarkReferences(config.benchmarks, testCases, config.agents);

  return {
    ...config,
    projectRoot,
    configPath,
    testCases,
  };
}

async function loadTestCases(patterns: string[], projectRoot: string, mocks: MockConfig): Promise<TestCase[]> {
  const cases: TestCase[] = [];

  for (const pattern of patterns) {
    validateProjectRelativeGlob(pattern, `tests ${pattern}`);
    const matches = await fg(pattern, { cwd: projectRoot, absolute: true, onlyFiles: true });
    for (const match of matches.sort()) {
      resolveProjectPath(projectRoot, match, `tests ${pattern}`);
      cases.push(await loadTestCaseFile(match, projectRoot, mocks));
    }
  }

  return cases;
}

async function loadTestCaseFile(path: string, projectRoot: string, mocks: MockConfig): Promise<TestCase> {
  const raw = await readYamlFile(path);
  const parsed = readTestCase(interpolateEnv(raw), path);
  return normalizeTestCase(parsed, projectRoot, path, mocks);
}

async function readYamlFile(path: string): Promise<unknown> {
  const raw = await readFile(path, 'utf8');
  return YAML.parse(raw) as unknown;
}

function readHarnessConfig(value: unknown): HarnessConfigOverride {
  if (!isRecord(value)) throw new Error('harness-evals.yaml must contain an object');
  const version = value.version ?? 1;
  if (version !== 1) throw new Error(`Unsupported harness config version: ${String(version)}`);

  return {
    version: 1,
    artifactRoot: readOptionalString(value.artifactRoot, 'artifactRoot'),
    outputRoot: readOptionalString(value.outputRoot, 'outputRoot'),
    workspace: readWorkspaceConfig(value.workspace, 'workspace'),
    docker: readOptionalRecord(value.docker, 'docker') as Partial<HarnessConfig['docker']> | undefined,
    agents: readAgents(value.agents),
    tests: readTests(value.tests),
    adapters: readAdapters(value.adapters),
    mocks: readMockDefaults(value.mocks),
    output: readOutputConfig(value.output),
    visualization: readVisualizationConfig(value.visualization),
    judge: readJudgeDefaults(value.judge),
    scoring: readScoringConfig(value.scoring),
    results: readResultsConfig(value.results),
    benchmarks: readBenchmarks(value.benchmarks),
  };
}

function readBenchmarks(value: unknown): Record<string, BenchmarkDefinition> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new Error('benchmarks must be an object');
  const benchmarks: Record<string, BenchmarkDefinition> = {};
  for (const [id, raw] of Object.entries(value)) {
    readComparisonId(id, `benchmarks.${id}`);
    if (!isRecord(raw)) throw new Error(`benchmarks.${id} must be an object`);
    const field = `benchmarks.${id}`;
    assertKnownKeys(raw, ['revision', 'label', 'description', 'select', 'arms', 'trials', 'qualityGates', 'objective', 'aggregation', 'secondaryMetrics'], field);
    benchmarks[id] = {
      revision: readOptionalPositiveInteger(raw.revision, `${field}.revision`) ?? 1,
      label: readRequiredString(raw.label, `${field}.label`),
      description: readOptionalString(raw.description, `${field}.description`),
      select: readBenchmarkSelector(raw.select, `${field}.select`),
      arms: readBenchmarkArms(raw.arms, `${field}.arms`),
      trials: readOptionalPositiveInteger(raw.trials, `${field}.trials`) ?? 1,
      qualityGates: readBenchmarkQualityGates(raw.qualityGates, `${field}.qualityGates`),
      objective: readBenchmarkObjective(raw.objective, `${field}.objective`),
      aggregation: readBenchmarkAggregation(raw.aggregation, `${field}.aggregation`),
      secondaryMetrics: readMetricNames(raw.secondaryMetrics, `${field}.secondaryMetrics`),
    };
  }
  return benchmarks;
}

function readBenchmarkSelector(value: unknown, field: string): BenchmarkDefinition['select'] {
  if (!isRecord(value)) throw new Error(`${field} must be an object`);
  assertKnownKeys(value, ['suites', 'cases'], field);
  const suites = readOptionalStringArray(value.suites, `${field}.suites`);
  const cases = readOptionalStringArray(value.cases, `${field}.cases`);
  if (!suites?.length && !cases?.length) throw new Error(`${field} must include at least one suite or case`);
  assertUniqueNonEmpty(suites, `${field}.suites`);
  assertUniqueNonEmpty(cases, `${field}.cases`);
  return { suites, cases };
}

function readBenchmarkArms(value: unknown, field: string): BenchmarkDefinition['arms'] {
  if (!isRecord(value)) throw new Error(`${field} must be an object`);
  assertKnownKeys(value, ['baseline', 'candidate'], field);
  const baseline = readRequiredString(value.baseline, `${field}.baseline`);
  const candidate = readRequiredString(value.candidate, `${field}.candidate`);
  if (candidate === baseline) throw new Error(`${field}.baseline and ${field}.candidate must be different`);
  return { baseline, candidate };
}

function readBenchmarkObjective(value: unknown, field: string): BenchmarkDefinition['objective'] {
  if (!isRecord(value)) throw new Error(`${field} must be an object`);
  assertKnownKeys(value, ['metric', 'goal'], field);
  const goal = readRequiredString(value.goal, `${field}.goal`);
  if (!BENCHMARK_GOALS.has(goal as BenchmarkGoal)) throw new Error(`${field}.goal must be minimize or maximize`);
  return { metric: readMetricName(value.metric, `${field}.metric`), goal: goal as BenchmarkGoal };
}

function readBenchmarkQualityGates(value: unknown, field: string): BenchmarkQualityGate[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value.map((entry, index) => {
    const itemField = `${field}[${index}]`;
    if (!isRecord(entry)) throw new Error(`${itemField} must be an object`);
    assertKnownKeys(entry, ['metric', 'min', 'max'], itemField);
    const min = readOptionalNumber(entry.min, `${itemField}.min`);
    const max = readOptionalNumber(entry.max, `${itemField}.max`);
    if (min === undefined && max === undefined) throw new Error(`${itemField} requires min or max`);
    if (min !== undefined && max !== undefined && min > max) throw new Error(`${itemField}.min must not exceed max`);
    return { metric: readMetricName(entry.metric, `${itemField}.metric`), min, max };
  });
}

function readBenchmarkAggregation(value: unknown, field: string): BenchmarkAggregation {
  if (value === undefined || value === null) return { trials: 'median', cases: 'macroMean' };
  if (!isRecord(value)) throw new Error(`${field} must be an object`);
  assertKnownKeys(value, ['trials', 'cases'], field);
  const trials = readOptionalString(value.trials, `${field}.trials`) ?? 'median';
  if (!BENCHMARK_TRIAL_REDUCERS.has(trials as BenchmarkTrialReducer)) throw new Error(`${field}.trials must be median or mean`);
  const cases = readOptionalString(value.cases, `${field}.cases`) ?? 'macroMean';
  if (cases !== 'macroMean') throw new Error(`${field}.cases must be macroMean`);
  return { trials: trials as BenchmarkTrialReducer, cases: 'macroMean' };
}

function readMetricNames(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  const metrics = value.map((entry, index) => readMetricName(entry, `${field}[${index}]`));
  assertUniqueNonEmpty(metrics, field);
  return metrics;
}

function readMetricName(value: unknown, field: string): string {
  const metric = readRequiredString(value, field);
  if (!BENCHMARK_METRIC_PATTERN.test(metric)) throw new Error(`${field} must be a dotted metric name`);
  return metric;
}

function validateBenchmarkReferences(
  benchmarks: Record<string, BenchmarkDefinition>,
  testCases: TestCase[],
  agents: Record<string, AgentConfig>,
): void {
  const caseIds = new Set(testCases.map((testCase) => testCase.id));
  const suites = new Set(testCases.map((testCase) => testCase.suite).filter((suite): suite is string => Boolean(suite)));
  for (const [id, benchmark] of Object.entries(benchmarks)) {
    for (const suite of benchmark.select.suites ?? []) {
      if (!suites.has(suite)) throw new Error(`benchmarks.${id}.select.suites references unknown suite: ${suite}`);
    }
    for (const caseId of benchmark.select.cases ?? []) {
      if (!caseIds.has(caseId)) throw new Error(`benchmarks.${id}.select.cases references unknown case: ${caseId}`);
    }
    const selected = testCases.filter((testCase) =>
      benchmark.select.cases?.includes(testCase.id) || (testCase.suite && benchmark.select.suites?.includes(testCase.suite)));
    if (selected.length === 0) throw new Error(`benchmarks.${id} selects no cases`);
    const armNames = [benchmark.arms.baseline, benchmark.arms.candidate];
    for (const agentName of armNames) {
      if (!agents[agentName]) throw new Error(`benchmarks.${id}.arms references unknown agent: ${agentName}`);
    }
    const comparisonIds = armNames.map((agentName) => agents[agentName].comparisonId ?? agentName);
    if (new Set(comparisonIds).size !== comparisonIds.length) {
      throw new Error(`benchmarks.${id}.arms must resolve to distinct comparisonId values`);
    }
    if (benchmark.secondaryMetrics.includes(benchmark.objective.metric)) {
      throw new Error(`benchmarks.${id}.secondaryMetrics must not repeat the objective metric`);
    }
  }
}

function assertUniqueNonEmpty(values: string[] | undefined, field: string): void {
  if (!values) return;
  if (values.some((value) => !value.trim())) throw new Error(`${field} must contain non-empty strings`);
  if (new Set(values).size !== values.length) throw new Error(`${field} must not contain duplicates`);
}

function readRequiredString(value: unknown, field: string): string {
  const result = readOptionalString(value, field);
  if (!result) throw new Error(`${field} is required`);
  return result;
}

function normalizeHarnessConfig(config: HarnessConfig, projectRoot: string): HarnessConfig {
  validateAdapters(config.adapters, projectRoot);
  validateOutputProviders(config.output.providers, projectRoot);

  const outputProviders = config.output.providers.length > 0 ? config.output.providers : [{ type: 'file' }];

  return {
    ...config,
    artifactRoot: resolveProjectPath(projectRoot, config.artifactRoot, 'artifactRoot'),
    outputRoot: resolveProjectPath(projectRoot, config.outputRoot, 'outputRoot'),
    workspace: {
      ...config.workspace,
      source: config.workspace.source ? resolveProjectPath(projectRoot, config.workspace.source, 'workspace.source') : undefined,
      fixture: resolveOptionalProjectPath(projectRoot, config.workspace.fixture, 'workspace.fixture'),
      git: normalizeWorkspaceGitConfig(config.workspace.git, projectRoot, 'workspace.git'),
    },
    mocks: {
      ...config.mocks,
      root: resolveProjectPath(projectRoot, config.mocks.root, 'mocks.root'),
    },
    output: {
      providers: outputProviders,
    },
    results: normalizeResultsConfig(config.results, projectRoot),
    agents: resolveAgentExtends(config.agents),
    tests: [...config.tests],
  };
}

function readResultsConfig(value: unknown): Partial<ResultsConfig> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new Error('results must be an object');
  assertKnownKeys(value, ['publish'], 'results');
  if (value.publish === undefined || value.publish === null) return {};
  if (!isRecord(value.publish)) throw new Error('results.publish must be an object');
  assertKnownKeys(value.publish, ['store', 'prefix', 'publicBaseUrl'], 'results.publish');
  const prefix = readOptionalString(value.publish.prefix, 'results.publish.prefix');
  if (!prefix) throw new Error('results.publish.prefix is required');
  validateArchivePrefix(prefix);
  const store = readResultsStore(value.publish.store);
  return {
    publish: {
      store,
      prefix,
      publicBaseUrl: readOptionalPublicBaseUrl(value.publish.publicBaseUrl),
    },
  };
}

function readResultsStore(value: unknown): ResultsStoreConfig {
  if (!isRecord(value)) throw new Error('results.publish.store must be an object');
  assertKnownKeys(value, ['type', 'root'], 'results.publish.store');
  const type = readOptionalString(value.type, 'results.publish.store.type');
  if (type !== 'file') throw new Error('results.publish.store.type must be file');
  const root = readOptionalString(value.root, 'results.publish.store.root');
  if (!root) throw new Error('results.publish.store.root is required');
  if (root.startsWith('/') || root.startsWith('~') || hasTraversalSegment(root)) {
    throw new Error('results.publish.store.root must be project-relative and may not contain path traversal');
  }
  return { type, root };
}

function normalizeResultsConfig(config: ResultsConfig, projectRoot: string): ResultsConfig {
  if (!config.publish) return {};
  const store = config.publish.store;
  return {
    publish: {
      ...config.publish,
      store: {
        ...store,
        root: resolveProjectPath(projectRoot, store.root, 'results.publish.store.root'),
      },
    },
  };
}

function validateArchivePrefix(prefix: string): void {
  if (prefix.includes('\\') || prefix.startsWith('/') || prefix.endsWith('/') || prefix.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`results.publish.prefix must be a safe relative path: ${prefix}`);
  }
}

function readOptionalPublicBaseUrl(value: unknown): string | undefined {
  const url = readOptionalString(value, 'results.publish.publicBaseUrl');
  if (!url) return undefined;
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error('results.publish.publicBaseUrl must be an absolute http(s) URL'); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('results.publish.publicBaseUrl must be an absolute http(s) URL');
  return url.replace(/\/+$/, '');
}

function readAgents(value: unknown): Record<string, AgentConfig> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new Error('agents must be an object');

  const agents: Record<string, AgentConfig> = {};
  for (const [name, rawAgent] of Object.entries(value)) {
    if (!isRecord(rawAgent)) throw new Error(`agents.${name} must be an object`);
    const adapter = readOptionalString(rawAgent.adapter, `agents.${name}.adapter`);
    const parent = readOptionalString(rawAgent.extends, `agents.${name}.extends`);
    if (!adapter && !parent) throw new Error(`agents.${name}.adapter is required unless extends is set`);
    agents[name] = readAgentConfig(rawAgent, adapter ?? (parent ? undefined : 'command'), `agents.${name}`);
  }
  return agents;
}

function readAgentConfig(raw: Record<string, unknown>, fallbackAdapter: string | undefined, field: string): AgentConfig {
  const fields = readAgentFields(raw, field);
  return {
    ...fields,
    adapter: readOptionalString(raw.adapter, `${field}.adapter`) ?? (fallbackAdapter as string),
  };
}

function readAgentFields(raw: Record<string, unknown>, field: string): Partial<AgentConfig> {
  return {
    extends: readOptionalString(raw.extends, `${field}.extends`),
    label: readOptionalString(raw.label, `${field}.label`),
    comparisonId: readComparisonId(raw.comparisonId, `${field}.comparisonId`),
    command: readOptionalString(raw.command, `${field}.command`),
    args: readOptionalStringArray(raw.args, `${field}.args`),
    cwd: readOptionalString(raw.cwd, `${field}.cwd`),
    env: readOptionalStringArray(raw.env, `${field}.env`),
    envAllowlist: readOptionalStringArray(raw.envAllowlist, `${field}.envAllowlist`),
    timeoutMs: readOptionalNumber(raw.timeoutMs, `${field}.timeoutMs`),
    provider: readOptionalString(raw.provider, `${field}.provider`),
    providerEnv: readOptionalString(raw.providerEnv, `${field}.providerEnv`),
    model: readOptionalString(raw.model, `${field}.model`),
    modelEnv: readOptionalString(raw.modelEnv, `${field}.modelEnv`),
    thinking: readOptionalString(raw.thinking, `${field}.thinking`),
    apiKeyEnv: readOptionalString(raw.apiKeyEnv, `${field}.apiKeyEnv`),
    auth: readAgentAuthConfig(raw.auth, `${field}.auth`),
    profile: readOptionalString(raw.profile, `${field}.profile`),
    outputFormat: readOptionalString(raw.outputFormat, `${field}.outputFormat`),
    useCurrentConfig: readOptionalBoolean(raw.useCurrentConfig, `${field}.useCurrentConfig`),
    projectConfigDirs: readOptionalStringArray(raw.projectConfigDirs, `${field}.projectConfigDirs`),
    userConfigDirs: readOptionalStringArray(raw.userConfigDirs, `${field}.userConfigDirs`),
    config: readOptionalRecord(raw.config, `${field}.config`),
    parser: readOptionalString(raw.parser, `${field}.parser`),
  };
}

function readComparisonId(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  const id = value.trim();
  if (!id) throw new Error(`${field} must not be empty`);
  if (id === '.' || id === '..' || id.length > 64 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
    throw new Error(`${field} must use 1-64 letters, numbers, dots, underscores, or hyphens and start with a letter or number`);
  }
  return id;
}

function readAgentAuthConfig(value: unknown, field: string): AgentAuthConfig | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new Error(`${field} must be an object`);
  assertKnownKeys(value, ['type', 'profile', 'openBrowser'], field);
  const type = readOptionalString(value.type, `${field}.type`);
  if (type !== 'oauth') throw new Error(`${field}.type must be oauth`);
  const profile = readOptionalString(value.profile, `${field}.profile`);
  if (profile && !isSafeAuthProfile(profile)) {
    throw new Error(`${field}.profile must be a safe name using letters, numbers, dots, underscores, or hyphens`);
  }
  return {
    type,
    profile,
    openBrowser: readOptionalBoolean(value.openBrowser, `${field}.openBrowser`),
  };
}

function isSafeAuthProfile(value: string): boolean {
  return value !== '.'
    && value !== '..'
    && value.length <= 64
    && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
}

function readTests(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new Error('tests must be an array of project-relative glob strings');
  return value.map((entry, index) => {
    if (typeof entry !== 'string') throw new Error(`tests[${index}] must be a project-relative glob string`);
    const trimmed = entry.trim();
    if (!trimmed) throw new Error(`tests[${index}] must not be empty`);
    validateProjectRelativeGlob(trimmed, `tests[${index}]`);
    return trimmed;
  });
}

function readAdapters(value: unknown): Record<string, AdapterDeclaration> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new Error('adapters must be an object');

  const adapters: Record<string, AdapterDeclaration> = {};
  for (const [name, raw] of Object.entries(value)) {
    if (!isRecord(raw)) throw new Error(`adapters.${name} must be an object`);
    assertKnownKeys(raw, ['module', 'export'], `adapters.${name}`);
    const module = readOptionalString(raw.module, `adapters.${name}.module`);
    if (!module) throw new Error(`adapters.${name}.module is required`);
    adapters[name] = { module, export: readOptionalString(raw.export, `adapters.${name}.export`) };
  }
  return adapters;
}

function readMockDefaults(value: unknown): Partial<MockConfig> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new Error('mocks must be an object');
  assertKnownKeys(value, ['root', 'strict', 'recordCalls'], 'mocks');
  return {
    root: readOptionalString(value.root, 'mocks.root'),
    strict: readOptionalBoolean(value.strict, 'mocks.strict'),
    recordCalls: readOptionalBoolean(value.recordCalls, 'mocks.recordCalls'),
  };
}

function readOutputConfig(value: unknown): Partial<OutputConfig> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new Error('output must be an object');
  assertKnownKeys(value, ['providers'], 'output');
  const providers = value.providers === undefined ? undefined : readOutputProviders(value.providers);
  return providers ? { providers } : undefined;
}

function readOutputProviders(value: unknown): OutputProviderConfig[] {
  if (!Array.isArray(value)) throw new Error('output.providers must be an array');
  return value.map((entry, index) => {
    const field = `output.providers[${index}]`;
    if (!isRecord(entry)) throw new Error(`${field} must be an object`);
    assertKnownKeys(entry, ['type', 'module', 'export', 'config'], field);
    const type = readOptionalString(entry.type, `${field}.type`);
    if (!type) throw new Error(`${field}.type is required`);
    const module = readOptionalString(entry.module, `${field}.module`);
    if (!BUILT_IN_PROVIDER_TYPES.has(type) && !module) throw new Error(`${field}.module is required for custom provider type ${type}`);
    return {
      type,
      module,
      export: readOptionalString(entry.export, `${field}.export`),
      config: readOptionalRecord(entry.config, `${field}.config`),
    };
  });
}

function readVisualizationConfig(value: unknown): HarnessConfigOverride['visualization'] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new Error('visualization must be an object');
  assertKnownKeys(value, ['enabled', 'formats', 'latest', 'include'], 'visualization');

  return {
    enabled: readOptionalBoolean(value.enabled, 'visualization.enabled'),
    formats: readOptionalVisualizationFormats(value.formats, 'visualization.formats'),
    latest: readOptionalBoolean(value.latest, 'visualization.latest'),
    include: readVisualizationInclude(value.include),
  };
}

function readVisualizationInclude(value: unknown): Partial<VisualizationConfig['include']> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new Error('visualization.include must be an object');
  assertKnownKeys(value, ['logs', 'workspaceDiff', 'toolCalls', 'mockCalls', 'judgeDetails'], 'visualization.include');
  return {
    logs: readOptionalBoolean(value.logs, 'visualization.include.logs'),
    workspaceDiff: readOptionalBoolean(value.workspaceDiff, 'visualization.include.workspaceDiff'),
    toolCalls: readOptionalBoolean(value.toolCalls, 'visualization.include.toolCalls'),
    mockCalls: readOptionalBoolean(value.mockCalls, 'visualization.include.mockCalls'),
    judgeDetails: readOptionalBoolean(value.judgeDetails, 'visualization.include.judgeDetails'),
  };
}

function readOptionalVisualizationFormats(value: unknown, field: string): VisualizationFormat[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value.map((entry, index) => {
    if (typeof entry !== 'string' || !VISUALIZATION_FORMATS.has(entry as VisualizationFormat)) {
      throw new Error(`${field}[${index}] must be one of: html, json, csv`);
    }
    return entry as VisualizationFormat;
  });
}

function readJudgeDefaults(value: unknown): JudgeDefaults | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new Error('judge must be an object');
  assertKnownKeys(value, ['provider', 'model', 'apiKeyEnv', 'temperature', 'promptTemplate'], 'judge');
  return {
    provider: readOptionalString(value.provider, 'judge.provider'),
    model: readOptionalString(value.model, 'judge.model'),
    apiKeyEnv: readOptionalString(value.apiKeyEnv, 'judge.apiKeyEnv'),
    temperature: readOptionalNumber(value.temperature, 'judge.temperature'),
    promptTemplate: readOptionalString(value.promptTemplate, 'judge.promptTemplate'),
  };
}

function readScoringConfig(value: unknown): ProjectScoringConfig | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new Error('scoring must be an object');

  const scoring: ProjectScoringConfig = {};
  for (const [key, rawConfig] of Object.entries(value)) {
    if (!SCORING_TYPES.has(key as ScoreType)) throw new Error(`Unknown scoring key: ${key}`);
    const field = `scoring.${key}`;
    if (!isRecord(rawConfig)) throw new Error(`${field} must be an object`);
    const scoreType = key as ScoreType;
    const allowed = METRIC_SCORING_TYPES.has(scoreType) ? ['weight', 'target', 'best', 'worst'] : ['weight'];
    assertKnownKeys(rawConfig, allowed, field);
    const weight = readOptionalNumber(rawConfig.weight, `${field}.weight`);
    if (weight === undefined) throw new Error(`${field}.weight is required`);
    const target = readOptionalString(rawConfig.target, `${field}.target`);
    if (target && !SCORE_TARGETS.has(target)) throw new Error(`${field}.target must be maximize or minimize`);
    const scoreConfig: Record<string, unknown> = { weight };
    if (target) scoreConfig.target = target;
    const best = readOptionalNumber(rawConfig.best, `${field}.best`);
    if (best !== undefined) scoreConfig.best = best;
    const worst = readOptionalNumber(rawConfig.worst, `${field}.worst`);
    if (worst !== undefined) scoreConfig.worst = worst;
    scoring[scoreType] = scoreConfig as unknown as ProjectScoringConfig[typeof scoreType];
  }
  return scoring;
}

function readTestCase(value: unknown, path: string): TestCase {
  if (!isRecord(value)) throw new Error(`Test case must contain an object: ${path}`);
  const vars = isRecord(value.vars) ? value.vars : undefined;
  const id = readOptionalString(value.id, 'id') ?? readOptionalString(vars?.caseId, 'vars.caseId') ?? readOptionalString(value.description, 'description');
  if (!id) throw new Error(`Test case requires id: ${path}`);

  const timeoutMs = readOptionalNumber(value.timeoutMs, 'timeoutMs') ?? readOptionalNumber(vars?.timeout, 'vars.timeout');
  const topLevelArgs = readOptionalStringArray(value.args, 'args');
  const topLevelEnv = readOptionalStringArray(value.env, 'env');
  const topLevelConfig = readOptionalRecord(value.config, 'config') ?? readOptionalRecord(vars?.setup, 'vars.setup');
  const topLevelAssert = readAssertions(value.assert, 'assert');
  const steps = readSteps(value.steps, {
    path,
    fallbackPrompt: readOptionalString(value.prompt, 'prompt') ?? readOptionalString(vars?.prompt, 'vars.prompt'),
    fallbackTimeoutMs: timeoutMs,
    fallbackArgs: topLevelArgs,
    fallbackEnv: topLevelEnv,
    fallbackConfig: topLevelConfig,
    fallbackAssert: topLevelAssert,
  });
  validateUniqueArtifactStepIds(steps, path);
  const firstStep = steps[0];

  return {
    id,
    description: readOptionalString(value.description, 'description'),
    suite: readOptionalString(value.suite, 'suite'),
    image: readOptionalString(value.image, 'image'),
    agents: readAgentsSelection(value.agents),
    workspace: normalizeLegacyWorkspace(value.workspace, vars),
    mocks: readTestCaseMocks(value.mocks, 'mocks'),
    verifier: readVerifierConfig(value.verifier, 'verifier'),
    attempts: readOptionalPositiveInteger(value.attempts, 'attempts'),
    steps,
    timeoutMs,
    args: firstStep.args,
    env: firstStep.env,
    config: firstStep.config,
    parser: readOptionalString(value.parser, 'parser'),
    prompt: firstStep.prompt,
    assert: topLevelAssert.length > 0 ? topLevelAssert : firstStep.assert,
    sourcePath: path,
  };
}

function readSteps(value: unknown, options: {
  path: string;
  fallbackPrompt?: string;
  fallbackTimeoutMs?: number;
  fallbackArgs?: string[];
  fallbackEnv?: string[];
  fallbackConfig?: Record<string, unknown>;
  fallbackAssert: AssertionConfig[];
}): TestCaseStepDefinition[] {
  if (value === undefined || value === null) {
    if (!options.fallbackPrompt) throw new Error(`Test case requires prompt or steps: ${options.path}`);
    return [{
      id: 'run',
      prompt: options.fallbackPrompt,
      timeoutMs: options.fallbackTimeoutMs,
      args: options.fallbackArgs,
      env: options.fallbackEnv,
      config: options.fallbackConfig,
      assert: options.fallbackAssert,
    }];
  }

  if (!Array.isArray(value)) throw new Error('steps must be an array');
  if (value.length === 0) throw new Error('steps must not be empty');

  return value.map((entry, index) => {
    const field = `steps[${index}]`;
    if (!isRecord(entry)) throw new Error(`${field} must be an object`);
    assertKnownKeys(entry, ['id', 'prompt', 'timeoutMs', 'args', 'env', 'config', 'mocks', 'assert'], field);
    const id = readOptionalString(entry.id, `${field}.id`);
    if (!id) throw new Error(`${field}.id is required`);
    const prompt = readOptionalString(entry.prompt, `${field}.prompt`);
    if (!prompt) throw new Error(`${field}.prompt is required`);
    return {
      id,
      prompt,
      timeoutMs: readOptionalNumber(entry.timeoutMs, `${field}.timeoutMs`),
      args: readOptionalStringArray(entry.args, `${field}.args`),
      env: readOptionalStringArray(entry.env, `${field}.env`),
      config: readOptionalRecord(entry.config, `${field}.config`),
      mocks: readTestCaseMocks(entry.mocks, `${field}.mocks`),
      assert: readAssertions(entry.assert, `${field}.assert`),
    };
  });
}

function validateUniqueArtifactStepIds(steps: readonly TestCaseStepDefinition[], path: string): void {
  const seen = new Map<string, string>();
  for (const step of steps) {
    const artifactId = safeStepId(step.id);
    const existing = seen.get(artifactId);
    if (existing) throw new Error(`Step ids "${existing}" and "${step.id}" in ${path} both map to artifact id "${artifactId}"`);
    seen.set(artifactId, step.id);
  }
}

function readAgentsSelection(value: unknown): AgentsSelection | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new Error('agents must be an object');
  assertKnownKeys(value, ['include', 'exclude', 'overrides'], 'agents');
  return {
    include: readOptionalStringArray(value.include, 'agents.include'),
    exclude: readOptionalStringArray(value.exclude, 'agents.exclude'),
    overrides: readAgentOverrides(value.overrides),
  };
}

function readAgentOverrides(value: unknown): Record<string, Partial<AgentConfig>> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new Error('agents.overrides must be an object');
  return Object.fromEntries(Object.entries(value).map(([name, raw]) => {
    if (!isRecord(raw)) throw new Error(`agents.overrides.${name} must be an object`);
    return [name, { ...readAgentFields(raw, `agents.overrides.${name}`), adapter: readOptionalString(raw.adapter, `agents.overrides.${name}.adapter`) }];
  }));
}

function readTestCaseMocks(value: unknown, field: string): TestCaseMockConfig | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new Error(`${field} must be an object`);
  assertKnownKeys(value, ['cli', 'mcp', 'strict'], field);
  return {
    cli: readStringRecord(value.cli, `${field}.cli`),
    mcp: readStringRecord(value.mcp, `${field}.mcp`),
    strict: readOptionalBoolean(value.strict, `${field}.strict`),
  };
}

function readVerifierConfig(value: unknown, field: string): TestCaseVerifierConfig | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new Error(`${field} must be an object`);
  assertKnownKeys(value, ['command', 'args', 'cwd', 'env', 'timeoutMs', 'rewardFile', 'rewardFormat', 'hiddenPatch', 'captureModelPatch', 'network', 'assetsDir', 'assetsTarget'], field);
  const command = readOptionalString(value.command, `${field}.command`);
  if (!command) throw new Error(`${field}.command is required`);
  const rewardFile = readRelativePath(value.rewardFile, `${field}.rewardFile`);
  const hiddenPatch = readRelativePath(value.hiddenPatch, `${field}.hiddenPatch`);
  const rewardFormat = readRewardFormat(value.rewardFormat, `${field}.rewardFormat`);
  const assetsDir = readRelativePath(value.assetsDir, `${field}.assetsDir`);

  return {
    command,
    args: readOptionalStringArray(value.args, `${field}.args`),
    cwd: readOptionalString(value.cwd, `${field}.cwd`),
    env: readOptionalStringArray(value.env, `${field}.env`),
    timeoutMs: readOptionalPositiveInteger(value.timeoutMs, `${field}.timeoutMs`),
    rewardFile,
    rewardFormat,
    hiddenPatch,
    captureModelPatch: readOptionalBoolean(value.captureModelPatch, `${field}.captureModelPatch`),
    network: readNetworkPolicy(value.network, `${field}.network`),
    assetsDir,
    assetsTarget: readOptionalString(value.assetsTarget, `${field}.assetsTarget`),
  };
}

function readRewardFormat(value: unknown, field: string): VerifierRewardFormat | undefined {
  const format = readOptionalString(value, field);
  if (!format) return undefined;
  if (!VERIFIER_REWARD_FORMATS.has(format as VerifierRewardFormat)) throw new Error(`${field} must be one of: auto, json, text`);
  return format as VerifierRewardFormat;
}

function readNetworkPolicy(value: unknown, field: string): NetworkPolicyConfig | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new Error(`${field} must be an object`);
  assertKnownKeys(value, ['mode', 'allow'], field);
  const mode = readOptionalString(value.mode, `${field}.mode`);
  if (!mode) throw new Error(`${field}.mode is required`);
  if (!NETWORK_POLICY_MODES.has(mode as NetworkPolicyConfig['mode'])) throw new Error(`${field}.mode must be one of: default, none, allowlist`);
  const allow = readNetworkAllowlist(value.allow, `${field}.allow`);
  if (mode === 'allowlist' && (!allow || allow.length === 0)) throw new Error(`${field}.allow is required when mode is allowlist`);
  if (mode !== 'allowlist' && allow) throw new Error(`${field}.allow is only valid when mode is allowlist`);
  return allow ? { mode: mode as NetworkPolicyConfig['mode'], allow } : { mode: mode as NetworkPolicyConfig['mode'] };
}

function readNetworkAllowlist(value: unknown, field: string): string[] | undefined {
  const allow = readOptionalStringArray(value, field);
  if (!allow) return undefined;
  return allow.map((entry, index) => {
    const trimmed = entry.trim();
    if (!trimmed) throw new Error(`${field}[${index}] must not be empty`);
    if (/\s/.test(trimmed)) throw new Error(`${field}[${index}] must be a URL or host without whitespace`);
    if (trimmed.includes('://')) {
      try {
        const url = new URL(trimmed);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('unsupported protocol');
        return url.host;
      } catch {
        throw new Error(`${field}[${index}] must be a valid http(s) URL or host`);
      }
    }
    return trimmed;
  });
}

function normalizeLegacyWorkspace(value: unknown, vars: Record<string, unknown> | undefined): Partial<TestCase['workspace']> | undefined {
  const workspace = readWorkspaceConfig(value, 'workspace');
  const fixture = readOptionalString(vars?.fixture, 'vars.fixture');
  if (!fixture) return workspace;
  return { ...(workspace ?? {}), fixture };
}

function readWorkspaceConfig(value: unknown, field: string): Partial<WorkspaceConfig> | undefined {
  const raw = readOptionalRecord(value, field);
  if (!raw) return undefined;
  const setup = readWorkspaceSetup(raw.setup, `${field}.setup`);
  const git = readWorkspaceGitConfig(raw.git, `${field}.git`);
  validateWorkspaceSourceSelection(raw, field);
  return {
    ...raw,
    ...(setup ? { setup } : {}),
    ...(git ? { git } : {}),
  } as Partial<WorkspaceConfig>;
}

function readWorkspaceGitConfig(value: unknown, field: string): WorkspaceGitConfig | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new Error(`${field} must be an object`);
  assertKnownKeys(value, ['repository', 'commit'], field);
  const repository = readOptionalString(value.repository, `${field}.repository`);
  if (!repository) throw new Error(`${field}.repository is required`);
  const commit = readOptionalString(value.commit, `${field}.commit`);
  if (!commit) throw new Error(`${field}.commit is required`);
  if (!/^[0-9a-f]{40}$/iu.test(commit)) throw new Error(`${field}.commit must be a full 40-character hexadecimal SHA`);
  return { repository, commit: commit.toLowerCase() };
}

function validateWorkspaceSourceSelection(value: Record<string, unknown>, field: string): void {
  const selectors = [
    value.source === undefined || value.source === null ? undefined : 'source',
    value.fixture === undefined || value.fixture === null ? undefined : 'fixture',
    value.git === undefined || value.git === null ? undefined : 'git',
    value.seedFromImage === true ? 'seedFromImage' : undefined,
  ].filter((entry): entry is string => entry !== undefined);
  if (selectors.length > 1) {
    throw new Error(`${field} must select only one of source, fixture, git, or seedFromImage; received ${selectors.join(', ')}`);
  }
}

function readWorkspaceSetup(value: unknown, field: string): WorkspaceConfig['setup'] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value.map((entry, index) => {
    const entryField = `${field}[${index}]`;
    if (!isRecord(entry)) throw new Error(`${entryField} must be an object`);
    assertKnownKeys(entry, ['command', 'args', 'cwd', 'timeoutMs'], entryField);
    const command = readOptionalString(entry.command, `${entryField}.command`);
    if (!command) throw new Error(`${entryField}.command is required`);
    const cwd = readOptionalString(entry.cwd, `${entryField}.cwd`);
    if (cwd && !cwd.startsWith('/')) throw new Error(`${entryField}.cwd must be an absolute container path`);
    return {
      command,
      args: readOptionalStringArray(entry.args, `${entryField}.args`) ?? [],
      cwd,
      timeoutMs: readOptionalPositiveInteger(entry.timeoutMs, `${entryField}.timeoutMs`),
    };
  });
}

function normalizeTestCase(testCase: TestCase, projectRoot: string, path: string, mocks: MockConfig): TestCase {
  const fixture = testCase.workspace?.fixture
    ? resolveProjectPath(projectRoot, testCase.workspace.fixture, `workspace.fixture in ${path}`)
    : undefined;
  const source = testCase.workspace?.source
    ? resolveProjectPath(projectRoot, testCase.workspace.source, `workspace.source in ${path}`)
    : undefined;
  const git = normalizeWorkspaceGitConfig(testCase.workspace?.git, projectRoot, `workspace.git in ${path}`);
  const hiddenPatch = testCase.verifier?.hiddenPatch
    ? resolveProjectPath(projectRoot, testCase.verifier.hiddenPatch, `verifier.hiddenPatch in ${path}`)
    : undefined;
  const assetsDir = testCase.verifier?.assetsDir
    ? resolveProjectPath(projectRoot, testCase.verifier.assetsDir, `verifier.assetsDir in ${path}`)
    : undefined;

  validateMockReferences(testCase.mocks, mocks.root, projectRoot, `mocks in ${path}`);
  for (const step of testCase.steps) {
    validateMockReferences(step.mocks, mocks.root, projectRoot, `steps.${step.id}.mocks in ${path}`);
  }

  const workspace = testCase.workspace ? { ...testCase.workspace } : undefined;
  if (workspace) {
    if (source) workspace.source = source;
    else delete workspace.source;
    if (fixture) workspace.fixture = fixture;
    else delete workspace.fixture;
    if (git) workspace.git = git;
    else delete workspace.git;
  }

  return {
    ...testCase,
    workspace,
    verifier: testCase.verifier ? { ...testCase.verifier, hiddenPatch, assetsDir } : undefined,
  };
}

function normalizeWorkspaceGitConfig(
  git: WorkspaceGitConfig | undefined,
  projectRoot: string,
  field: string,
): WorkspaceGitConfig | undefined {
  if (!git) return undefined;

  let url: URL;
  try {
    url = new URL(git.repository);
  } catch {
    throw new Error(`${field}.repository must be a credential-free HTTPS URL or a project-contained file URL`);
  }
  if (url.username || url.password) throw new Error(`${field}.repository must not include credentials`);
  if (url.search || url.hash) throw new Error(`${field}.repository must not include a query string or fragment`);

  if (url.protocol === 'https:') {
    if (!url.hostname) throw new Error(`${field}.repository must include a host`);
    return { ...git, repository: url.href };
  }
  if (url.protocol === 'file:') {
    const repositoryPath = resolveProjectPath(projectRoot, fileURLToPath(url), `${field}.repository`);
    return { ...git, repository: pathToFileURL(repositoryPath).href };
  }
  throw new Error(`${field}.repository must use https or a project-contained file URL`);
}

function readAssertions(value: unknown, field: string): AssertionConfig[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value.map((entry, index) => {
    const itemField = `${field}[${index}]`;
    if (!isRecord(entry)) throw new Error(`${itemField} must be an object`);
    const type = readOptionalString(entry.type, `${itemField}.type`);
    if (!type) throw new Error(`${itemField}.type is required`);
    const allowedKeys = ASSERTION_KEYS[type];
    if (!allowedKeys) throw new Error(`Unknown assertion type: ${type}`);
    assertKnownKeys(entry, allowedKeys, itemField);
    const id = readOptionalString(entry.id, `${itemField}.id`);
    const required = readOptionalBoolean(entry.required, `${itemField}.required`) ?? true;
    const when = readAssertionCondition(entry.when, `${itemField}.when`);
    const normalized: AssertionConfig = { ...entry, id, type, required, ...(when ? { when } : {}) };
    if (type === 'toolCalled' && entry.isError !== undefined) {
      (normalized as Record<string, unknown>).isError = readOptionalBoolean(entry.isError, `${itemField}.isError`);
    }
    if (type === 'llmJudge') {
      const threshold = readOptionalNumber(entry.threshold, `${itemField}.threshold`);
      if (threshold === undefined) throw new Error(`${itemField}.threshold is required`);
      if (threshold < 0 || threshold > 1) throw new Error(`${itemField}.threshold must be between 0 and 1`);
      return { ...normalized, threshold, judge: readJudgeAssertion(entry.judge, `${itemField}.judge`) };
    }
    return normalized;
  });
}

function readAssertionCondition(value: unknown, field: string): AssertionCondition | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new Error(`${field} must be an object`);
  assertKnownKeys(value, ['agent'], field);
  const agent = readOptionalString(value.agent, `${field}.agent`);
  if (!agent) throw new Error(`${field}.agent is required`);
  return { agent };
}

function readJudgeAssertion(value: unknown, field: string): JudgeAssertionDefinition {
  if (!isRecord(value)) throw new Error(`${field} must be an object`);
  assertKnownKeys(value, ['provider', 'model', 'apiKeyEnv', 'temperature', 'promptTemplate', 'rubric', 'inputs'], field);
  const rubric = readOptionalString(value.rubric, `${field}.rubric`);
  if (!rubric) throw new Error(`${field}.rubric is required`);
  const inputs = readOptionalStringArray(value.inputs, `${field}.inputs`);
  if (!inputs || inputs.length === 0) throw new Error(`${field}.inputs is required`);
  for (const input of inputs) {
    if (!JUDGE_INPUT_REFS.has(input)) throw new Error(`${field}.inputs contains unsupported ref: ${input}`);
  }
  return {
    provider: readOptionalString(value.provider, `${field}.provider`),
    model: readOptionalString(value.model, `${field}.model`),
    apiKeyEnv: readOptionalString(value.apiKeyEnv, `${field}.apiKeyEnv`),
    temperature: readOptionalNumber(value.temperature, `${field}.temperature`),
    promptTemplate: readOptionalString(value.promptTemplate, `${field}.promptTemplate`),
    rubric,
    inputs: inputs as JudgeAssertionDefinition['inputs'],
  };
}

function validateExplicitJudgeConfig(testCases: TestCase[], defaults: JudgeDefaults | undefined): void {
  for (const testCase of testCases) {
    for (const step of testCase.steps) {
      for (const assertion of step.assert) {
        if (assertion.type !== 'llmJudge') continue;
        const judgeAssertion = assertion as AssertionConfig & { judge: JudgeAssertionDefinition };
        const provider = judgeAssertion.judge.provider ?? defaults?.provider;
        const model = judgeAssertion.judge.model ?? defaults?.model;
        const apiKeyEnv = judgeAssertion.judge.apiKeyEnv ?? defaults?.apiKeyEnv;
        if (!provider && !model && !apiKeyEnv) continue;
        const missing = [
          provider ? undefined : 'provider',
          model ? undefined : 'model',
          apiKeyEnv ? undefined : 'apiKeyEnv',
        ].filter((value): value is string => Boolean(value));
        if (missing.length > 0) {
          throw new Error(`llmJudge assertion ${judgeAssertion.id ?? judgeAssertion.type} in ${testCase.id}.${step.id} requires judge.${missing.join(', ')} when explicit judge config is used`);
        }
      }
    }
  }
}

function validateAssertionConditions(testCases: TestCase[], agents: Record<string, AgentConfig>): void {
  const configuredAgents = new Set(Object.keys(agents));
  for (const testCase of testCases) {
    for (const step of testCase.steps) {
      for (const assertion of step.assert) {
        const agent = assertion.when?.agent;
        if (agent && !configuredAgents.has(agent)) {
          throw new Error(`Assertion ${assertion.id ?? assertion.type} in ${testCase.id}.${step.id} references unknown agent: ${agent}`);
        }
      }
    }
  }
}

function validateAdapters(adapters: Record<string, AdapterDeclaration>, projectRoot: string): void {
  for (const [name, declaration] of Object.entries(adapters)) {
    validateModuleSpecifier(declaration.module, projectRoot, `adapters.${name}.module`);
  }
}

function validateOutputProviders(providers: OutputProviderConfig[], projectRoot: string): void {
  for (const [index, provider] of providers.entries()) {
    if (provider.module) validateModuleSpecifier(provider.module, projectRoot, `output.providers[${index}].module`);
  }
}

function validateModuleSpecifier(module: string, projectRoot: string, field: string): void {
  if (module.startsWith('.') || module.startsWith('/')) {
    resolveProjectPath(projectRoot, module, field);
  }
}

function validateMockReferences(mocks: TestCaseMockConfig | undefined, mocksRoot: string, projectRoot: string, field: string): void {
  if (!mocks) return;
  for (const [surface, refs] of [['cli', mocks.cli], ['mcp', mocks.mcp]] as const) {
    if (!refs) continue;
    for (const [name, fixture] of Object.entries(refs)) {
      resolveMockFixturePath(mocksRoot, projectRoot, surface, fixture, `${field}.${surface}.${name}`);
    }
  }
}

function resolveMockFixturePath(mocksRoot: string, projectRoot: string, surface: 'cli' | 'mcp', fixture: string, field: string): string {
  if (hasTraversalSegment(fixture)) throw new Error(`Path escapes project root (${field}: ${fixture})`);
  const path = isFixtureName(fixture) ? join(mocksRoot, surface, withYamlExtension(fixture)) : withYamlExtension(fixture);
  return resolveProjectPath(projectRoot, path, field);
}

function withYamlExtension(path: string): string {
  return extname(path) ? path : `${path}.yaml`;
}

function isFixtureName(value: string): boolean {
  return !value.startsWith('.') && !value.includes('/') && !value.includes('\\');
}

function validateProjectRelativeGlob(pattern: string, field: string): void {
  if (isAbsolute(pattern) || pattern.startsWith('~')) throw new Error(`${field} must be project-relative`);
  if (hasTraversalSegment(pattern)) throw new Error(`Test file glob may not contain path traversal: ${pattern}`);
}

function hasTraversalSegment(path: string): boolean {
  return path.split(/[\\/]+/).includes('..');
}

function assertKnownKeys(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) throw new Error(`Unknown ${field} key: ${key}`);
  }
}

function readStringRecord(value: unknown, field: string): Record<string, string> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new Error(`${field} must be an object`);
  return Object.fromEntries(Object.entries(value).map(([key, child]) => {
    if (typeof child !== 'string' || !child.trim()) throw new Error(`${field}.${key} must be a string`);
    return [key, child.trim()];
  }));
}

function interpolateEnv(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?}/g, (_match, name: string, fallback: string | undefined) => {
      return process.env[name] ?? fallback ?? '';
    });
  }
  if (Array.isArray(value)) return value.map((item) => interpolateEnv(item));
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, interpolateEnv(child)]));
  }
  return value;
}

function readOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function readOptionalStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value.map((entry, index) => {
    if (typeof entry !== 'string') throw new Error(`${field}[${index}] must be a string`);
    return entry;
  });
}

function readOptionalNumber(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  throw new Error(`${field} must be a number`);
}

function readOptionalPositiveInteger(value: unknown, field: string): number | undefined {
  const parsed = readOptionalNumber(value, field);
  if (parsed === undefined) return undefined;
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${field} must be a positive integer`);
  return parsed;
}

function readRelativePath(value: unknown, field: string): string | undefined {
  const path = readOptionalString(value, field);
  if (!path) return undefined;
  if (isAbsolute(path) || path.startsWith('~')) throw new Error(`${field} must be project-relative`);
  if (hasTraversalSegment(path)) throw new Error(`${field} may not contain path traversal: ${path}`);
  return path;
}

function readOptionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') throw new Error(`${field} must be a boolean`);
  return value;
}

function readOptionalRecord(value: unknown, field: string): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new Error(`${field} must be an object`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
