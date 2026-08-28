export type PublicRunStatus =
  | 'passed'
  | 'failed'
  | 'error'
  | 'skipped'
  | 'timeout'
  | 'incomplete';

export type PublicBatchValidity = 'valid' | 'invalid' | 'superseded';

export interface PublicCostSummary {
  totalCost?: number;
  currency?: string;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  requests?: number;
}

export interface PublicRunSummary {
  runId: string;
  caseId: string;
  agentName: string;
  agentLabel?: string;
  comparisonId?: string;
  suite?: string;
  attemptNumber?: number;
  attempts?: number;
  status: PublicRunStatus;
  pass: boolean;
  startedAt?: string;
  durationMs?: number;
  exitCode?: number | null;
  score?: number;
  assertionPassRate?: number;
  judgeScore?: number;
  verifierReward?: number;
  provider?: string;
  model?: string;
  models?: string[];
  assertions?: {
    total: number;
    passed: number;
    failedRequired: number;
  };
  cost?: PublicCostSummary;
}

export interface PublicBatchTotals {
  runs: number;
  passed: number;
  failed: number;
  errors: number;
  skipped: number;
  timeouts: number;
  incomplete: number;
  durationMs?: number;
  cost?: PublicCostSummary;
}

export interface PublicProvenance {
  harnessEvalsVersion?: string;
  projectRepository?: string;
  projectCommit?: string;
  projectDirty?: boolean;
  agentPackageVersions?: Record<string, string>;
}

export interface PublicBatchManifest {
  schemaVersion: 1;
  batchId: string;
  startedAt?: string;
  label?: string;
  suites: string[];
  cases: string[];
  agents: string[];
  totals: PublicBatchTotals;
  provenance?: PublicProvenance;
  runs: PublicRunSummary[];
}

export interface PublicBatchIndexEntry {
  batchId: string;
  startedAt?: string;
  label?: string;
  validity: PublicBatchValidity;
  validityNote?: string;
  supersededBy?: string;
  suites: string[];
  cases: string[];
  agents: string[];
  totals: PublicBatchTotals;
  manifestPath: string;
  reportPath: string;
  csvPath: string;
}

export interface PublicResultsIndex {
  schemaVersion: 1;
  updatedAt: string;
  batches: PublicBatchIndexEntry[];
}

export interface PublicResultsObjectOptions {
  contentType: string;
  cacheControl?: string;
}

export interface PublicResultsStore {
  get(key: string): Promise<Uint8Array | undefined>;
  put(key: string, content: Uint8Array, options: PublicResultsObjectOptions): Promise<void>;
  list(prefix: string): Promise<string[]>;
}
