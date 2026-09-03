import {
  DEFAULT_HARNESS_CONFIG,
  type AgentConfig,
  type BenchmarkDefinition,
  type DockerConfig,
  type HarnessConfig,
  type MockConfig,
  type OutputConfig,
  type ProjectScoringConfig,
  type ResultsConfig,
  type ResultsPublishConfig,
  type VisualizationConfig,
  type WorkspaceConfig,
  type WorkspaceSetupCommand,
} from './schema.js';

type VisualizationConfigOverride = Omit<Partial<VisualizationConfig>, 'include'> & { include?: Partial<VisualizationConfig['include']> };

export interface HarnessConfigOverride extends Omit<Partial<HarnessConfig>, 'workspace' | 'docker' | 'agents' | 'tests' | 'mocks' | 'output' | 'visualization' | 'scoring' | 'results' | 'benchmarks'> {
  workspace?: Partial<WorkspaceConfig>;
  docker?: Partial<DockerConfig>;
  agents?: Record<string, AgentConfig>;
  tests?: string[];
  mocks?: Partial<MockConfig>;
  output?: Partial<OutputConfig>;
  visualization?: VisualizationConfigOverride;
  scoring?: ProjectScoringConfig;
  results?: ResultsConfig;
  benchmarks?: Record<string, BenchmarkDefinition>;
}

export function mergeHarnessConfig(base: HarnessConfig, override: HarnessConfigOverride): HarnessConfig {
  return {
    ...base,
    ...definedObject(override),
    workspace: mergeWorkspaceConfig(base.workspace, override.workspace),
    docker: mergeDockerConfig(base.docker, override.docker),
    agents: mergeRecord(base.agents, override.agents),
    tests: override.tests ? [...override.tests] : [...base.tests],
    adapters: mergeRecord(base.adapters, override.adapters),
    mocks: mergeMockConfig(base.mocks, override.mocks),
    output: mergeOutputConfig(base.output, override.output),
    visualization: mergeVisualizationConfig(base.visualization, override.visualization),
    scoring: mergeScoringConfig(base.scoring, override.scoring),
    results: mergeResultsConfig(base.results, override.results),
    benchmarks: cloneBenchmarks(override.benchmarks ?? base.benchmarks),
  };
}

function cloneBenchmarks(benchmarks: Record<string, BenchmarkDefinition>): Record<string, BenchmarkDefinition> {
  return Object.fromEntries(Object.entries(benchmarks).map(([id, benchmark]) => [id, {
    ...benchmark,
    select: {
      suites: benchmark.select.suites ? [...benchmark.select.suites] : undefined,
      cases: benchmark.select.cases ? [...benchmark.select.cases] : undefined,
    },
    arms: { baseline: benchmark.arms.baseline, candidate: benchmark.arms.candidate },
    qualityGates: benchmark.qualityGates.map((gate) => ({ ...gate })),
    objective: benchmark.objective.map((objective) => ({ ...objective })) as BenchmarkDefinition['objective'],
    aggregation: { ...benchmark.aggregation },
  }]));
}

export function withHarnessDefaults(config: HarnessConfigOverride): HarnessConfig {
  return mergeHarnessConfig(DEFAULT_HARNESS_CONFIG, config);
}

export function mergeWorkspaceConfig(base: WorkspaceConfig, override?: Partial<WorkspaceConfig>): WorkspaceConfig {
  if (!override) return cloneWorkspaceConfig(base);
  const merged: WorkspaceConfig = {
    ...base,
    ...definedObject(override),
    ignore: override.ignore ? [...override.ignore] : [...base.ignore],
    setup: override.setup ? cloneWorkspaceSetup(override.setup) : cloneWorkspaceSetup(base.setup ?? []),
    git: override.git ? { ...override.git } : base.git ? { ...base.git } : undefined,
  };

  if (override.git) {
    merged.source = undefined;
    merged.fixture = undefined;
    merged.seedFromImage = false;
  } else if (override.fixture !== undefined) {
    merged.source = undefined;
    merged.git = undefined;
    merged.seedFromImage = false;
  } else if (override.source !== undefined) {
    merged.git = undefined;
    merged.fixture = undefined;
    merged.seedFromImage = false;
  } else if (override.seedFromImage === true) {
    merged.source = undefined;
    merged.git = undefined;
    merged.fixture = undefined;
  }

  return merged;
}

function cloneWorkspaceConfig(workspace: WorkspaceConfig): WorkspaceConfig {
  return {
    ...workspace,
    ignore: [...workspace.ignore],
    setup: cloneWorkspaceSetup(workspace.setup ?? []),
    git: workspace.git ? { ...workspace.git } : undefined,
  };
}

function cloneWorkspaceSetup(setup: WorkspaceSetupCommand[]): WorkspaceSetupCommand[] {
  return setup.map((entry) => ({
    ...entry,
    args: [...entry.args],
    network: entry.network
      ? { ...entry.network, allow: entry.network.allow ? [...entry.network.allow] : undefined }
      : undefined,
  }));
}

export function mergeDockerConfig(base: DockerConfig, override?: Partial<DockerConfig>): DockerConfig {
  if (!override) return { ...base, envAllowlist: [...base.envAllowlist], baseSetup: base.baseSetup ? [...base.baseSetup] : undefined };
  return {
    ...base,
    ...definedObject(override),
    envAllowlist: override.envAllowlist ? [...override.envAllowlist] : [...base.envAllowlist],
    baseSetup: override.baseSetup ? [...override.baseSetup] : base.baseSetup ? [...base.baseSetup] : undefined,
  };
}

export function mergeAgentConfig(base: AgentConfig, override?: Partial<AgentConfig>): AgentConfig {
  if (!override) return cloneAgentConfig(base);
  return {
    ...base,
    ...definedObject(override),
    args: override.args ?? base.args,
    env: override.env ?? base.env,
    envAllowlist: override.envAllowlist ?? base.envAllowlist,
    auth: override.auth ? { ...override.auth } : base.auth ? { ...base.auth } : undefined,
    projectConfigDirs: override.projectConfigDirs ?? base.projectConfigDirs,
    userConfigDirs: override.userConfigDirs ?? base.userConfigDirs,
    config: mergeUnknownRecord(base.config, override.config),
  };
}

export function resolveAgentExtends(agents: Record<string, AgentConfig>): Record<string, AgentConfig> {
  const resolved: Record<string, AgentConfig> = {};
  const resolving = new Set<string>();

  const resolveOne = (name: string): AgentConfig => {
    if (resolved[name]) return resolved[name];
    const agent = agents[name];
    if (!agent) throw new Error(`Unknown agent: ${name}`);
    if (resolving.has(name)) throw new Error(`Circular agent extends chain at ${name}`);

    resolving.add(name);
    const parent = agent.extends ? resolveOne(agent.extends) : undefined;
    const merged = parent ? mergeAgentConfig(parent, agent) : cloneAgentConfig(agent);
    delete merged.extends;
    resolving.delete(name);
    resolved[name] = merged;
    return merged;
  };

  for (const name of Object.keys(agents)) {
    resolveOne(name);
  }

  return resolved;
}

function mergeMockConfig(base: MockConfig, override?: Partial<MockConfig>): MockConfig {
  return { ...base, ...definedObject(override) };
}

function mergeOutputConfig(base: OutputConfig, override?: Partial<OutputConfig>): OutputConfig {
  return {
    providers: override?.providers ? [...override.providers] : [...base.providers],
  };
}

function mergeVisualizationConfig(
  base: VisualizationConfig,
  override?: VisualizationConfigOverride,
): VisualizationConfig {
  if (!override) return cloneVisualizationConfig(base);
  return {
    ...base,
    ...definedObject(override),
    formats: override.formats ? [...override.formats] : [...base.formats],
    include: { ...base.include, ...(override.include ?? {}) },
  };
}

function mergeScoringConfig(base: ProjectScoringConfig, override?: ProjectScoringConfig): ProjectScoringConfig {
  if (!override) return cloneScoringConfig(base);
  const merged: ProjectScoringConfig = cloneScoringConfig(base);
  for (const key of Object.keys(override) as Array<keyof ProjectScoringConfig>) {
    merged[key] = { ...(base[key] ?? {}), ...(override[key] ?? {}) } as ProjectScoringConfig[typeof key];
  }
  return merged;
}

function mergeResultsConfig(base: ResultsConfig, override?: ResultsConfig): ResultsConfig {
  if (!override) return cloneResultsConfig(base);
  return {
    publish: override.publish
      ? { ...base.publish, ...override.publish, store: { ...(base.publish?.store ?? {}), ...override.publish.store } }
      : base.publish ? { ...base.publish, store: { ...base.publish.store } } : undefined,
  };
}

function cloneResultsConfig(config: ResultsConfig): ResultsConfig {
  return config.publish
    ? { publish: { ...config.publish, store: { ...config.publish.store } } }
    : {};
}

function mergeRecord<T>(base: Record<string, T>, override?: Record<string, T>): Record<string, T> {
  return { ...base, ...(override ?? {}) };
}

function mergeUnknownRecord(
  base: Record<string, unknown> | undefined,
  override: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!base && !override) return undefined;
  return { ...(base ?? {}), ...(override ?? {}) };
}

function cloneAgentConfig(agent: AgentConfig): AgentConfig {
  return {
    ...agent,
    args: agent.args ? [...agent.args] : undefined,
    env: agent.env ? [...agent.env] : undefined,
    envAllowlist: agent.envAllowlist ? [...agent.envAllowlist] : undefined,
    auth: agent.auth ? { ...agent.auth } : undefined,
    projectConfigDirs: agent.projectConfigDirs ? [...agent.projectConfigDirs] : undefined,
    userConfigDirs: agent.userConfigDirs ? [...agent.userConfigDirs] : undefined,
    config: agent.config ? { ...agent.config } : undefined,
  };
}

function cloneVisualizationConfig(config: VisualizationConfig): VisualizationConfig {
  return {
    ...config,
    formats: [...config.formats],
    include: { ...config.include },
  };
}

function cloneScoringConfig(config: ProjectScoringConfig): ProjectScoringConfig {
  return Object.fromEntries(Object.entries(config).map(([key, value]) => [key, value ? { ...value } : value])) as ProjectScoringConfig;
}

function definedObject<T extends object>(value: T | undefined): Partial<T> {
  if (!value) return {};
  return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined)) as Partial<T>;
}
