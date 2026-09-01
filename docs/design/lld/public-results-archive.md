# LLD — Public Results Archive

> **HLD:** `../HDL.md`
> **Companion LLDs:** `output-providers.md`, `result-visualization.md`, `cost-and-artifacts.md`
> **Research:** `../../research/persistent-results-storage.md`
> **Status:** Proposed for V1

## How this fits

This LLD defines a small, provider-neutral way to publish completed evaluation
batch summaries to public object storage. It is intentionally a post-run
publisher rather than an output provider: live runs continue to use the local
file provider, and publication begins only after a user explicitly selects a
completed batch.

The public archive is a summary read model. Local output records and run
artifacts remain the detailed source for debugging; V1 does not upload those
raw artifacts.

## 1. Goals and invariants

V1 must:

- preserve compact evaluation results across machines and checkouts;
- provide stable public URLs for individual batches;
- support aggregate latest-results and all-attempts browsing across batches,
  grouping cases by suite and comparing only the agent configurations that
  actually ran each case;
- provide stable authored comparison identities so the same conceptual agent
  can be compared across different batches and config roots;
  without a database or backend API;
- publish only compact summaries and summary reports;
- keep the archive format independent of the selected storage vendor;
- avoid adding a remote dependency to paid or otherwise live evaluation runs;
- leave a straightforward path to a database or analytical export later.

The core invariants are:

1. A batch is one `harness-evals run` invocation and is identified by its
   existing `batchId`.
2. A task run is one case × agent × attempt observation. Every task run in the
   selected batch is retained in its manifest.
3. Objects under `batches/<batch-id>/` are immutable after publication.
4. Batch objects are uploaded before the root catalog is updated.
5. A batch is discoverable only after its entry appears in `index.json`.
6. “Latest” is derived by sorting/filtering catalog entries; no result is
   stored under a mutable `latest` result path.
7. Publication uses an explicit field allowlist. Local artifact directories
   are never mirrored wholesale.
8. Missing metrics remain absent. Missing cost, token, or duration data must
   never be converted to zero.
9. Batch IDs and every generated object-key segment are validated before they
   reach a storage adapter.
10. A batch defaults to publishable only after the runner has written a local
    terminal batch record and all expected task runs are present.
11. Immutable manifests and batch reports describe observed results only.
    Mutable validity, invalidation notes, and supersession pointers live only
    in the root catalog so they cannot become stale inside immutable objects.

## 2. Non-goals

V1 does not provide:

- raw `records.jsonl`, model transcripts, tool calls, or step logs;
- copied workspaces, config directories, verifier assets, or auth state;
- raw `result.json` or the existing detail-rich HTML/JSON reports;
- PostgreSQL, Parquet, Iceberg, a data warehouse, or a result service;
- private result access, accounts, or read authorization;
- concurrent publishers or conditional catalog transactions;
- remote import/pull or a remote replacement for the local viewer;
- cross-batch statistical claims or compatibility fingerprinting;
- an append-only correction ledger;
- automatic publication at the end of `run`.

These can be added when measured usage requires them without changing the V1
batch paths or manifest envelope.

## 3. Existing inputs

The implementation should build on the existing compact workspace scanner:

- `BatchInfo` identifies one CLI invocation.
- Each run directory records its batch in `run-started.json`.
- `summary.json` contains compact status, score, assertion, cost, and usage
  information.
- `scanWorkspaceRuns()` reads only `summary.json` and `run-started.json` and
  produces `ScannedTaskRun` plus `BatchSummaryInfo` records.

The publisher must not use the existing full `result.json` or detail report as
its source. Those files can embed output, events, workspace details, verifier
data, and local paths. The public projection should explicitly map allowed
fields from `ScannedTaskRun` and `BatchSummaryInfo` into the types below.

For a selected real batch, publication preserves every scanned task run. It
must not apply `dedupeNewestValid()` across batches: that function is useful
for a comparison view but would discard longitudinal observations.

### Required local batch finalization record

The current scanner can discover task runs, but it cannot prove that the
invocation which created them has finished. `BatchInfo.runCount` is also not
retained separately from the number of directories discovered by the scan.
The implementation must close this gap before enabling default publication.

The runner writes one local record outside the per-run directories:

```text
.harness-evals/batches/<batch-id>.json
```

```ts
export interface LocalBatchRecord {
  schemaVersion: 1;
  batch: BatchInfo;
  status: 'running' | 'completed';
  expectedRunCount: number;
  runIds: string[];
  completedAt?: string;
}
```

The record is created with `running` before task execution and replaced
atomically with `completed` after every task run reaches a terminal harness
result. The completed record contains the exact run IDs. Normal publication
requires:

- `status === 'completed'`;
- `expectedRunCount === runIds.length`;
- every recorded run ID is present in the compact scan; and
- no additional scanned run claims the same batch ID.

Legacy or interrupted batches without a terminal record may be published only
through an explicit override and may not default to `valid`.

## 4. Public object layout

The configured prefix contains one format-version directory:

```text
<prefix>/v1/
  index.html
  index.json
  batches/
    <batch-id>/
      manifest.json
      results.html
      results.csv
```

Rules:

- Keys and URLs use `/` separators regardless of the local platform.
- A publishable batch ID must match the existing real ID format
  `^\d{8}-\d{6}-[0-9a-f]{4}$`. Synthetic legacy IDs are not accepted by
  default.
- Prefixes must be relative, use `/` separators, and contain no empty, `.`,
  `..`, or backslash-containing segment.
- Paths inside JSON are relative to the `v1/` root.
- Manifests never contain bucket names, provider object identifiers, local
  filesystem paths, or signed URLs.
- `index.html` is a standalone page with inline CSS and JavaScript and no
  external runtime dependencies.
- `manifest.json` is the machine-readable batch result; V1 does not need a
  second `results.json` containing the same data.

Recommended response metadata:

| Object | Content type | Cache control |
| --- | --- | --- |
| `index.json` | `application/json; charset=utf-8` | `no-cache` |
| `index.html` | `text/html; charset=utf-8` | short cache or `no-cache` |
| Batch manifest | `application/json; charset=utf-8` | `public, max-age=31536000, immutable` |
| Batch HTML | `text/html; charset=utf-8` | `public, max-age=31536000, immutable` |
| Batch CSV | `text/csv; charset=utf-8` | `public, max-age=31536000, immutable` |

## 5. Public data contracts

The TypeScript interfaces below define the V1 JSON contract. JSON objects omit
optional values instead of writing misleading placeholders.

```ts
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
```

### Data rules

- Arrays are sorted deterministically and contain unique values.
- Runs are sorted by case, agent, attempt number, then run ID.
- Batch entries are sorted newest first using `startedAt`, then `batchId`.
- `pass` remains in JSON for compatibility, but human-facing HTML and CSV use
  the single `status` field and do not render a duplicate pass column.
- `comparisonId` is an explicitly authored stable identity for grouping an
  effective agent configuration across batches. Readers fall back to
  `agentName` for older manifests. `agentLabel` is display-only and may change
  without changing the identity.
- Aggregate status counts include all runs, including errors, timeouts, and
  incomplete runs.
- Duration is summed only from available values. Cost is summed only when
  currencies are compatible; mixed currencies do not produce one total.
- A case description, raw `error` string, `runDir`, argv, source path, local
  report path, or arbitrary metadata is not part of the V1 public projection.
- Benchmark artifacts may include only bounded outcomes: status, pass flag,
  failure categories, failed required assertion IDs, verifier reward, duration,
  and stable run ID. Raw errors, assertion reasons, logs, prompts, commands,
  workspaces, and verifier output remain excluded.
- Projects may add an explicitly authored public case label in a later schema;
  the publisher must not treat the existing case description as sanitized
  public copy.
- Provenance is best-effort in V1. The publisher must not claim that the
  current checkout describes a historical run unless that provenance was
  recorded with the run or supplied explicitly for publication.

## 6. Static index page

`index.html` fetches `./index.json` and then the selected compact manifests. It
provides:

- a suite → case dashboard with one result card per participating comparison
  identity (different cases may have different participating agents);
- a latest-results strategy that keeps the newest run per case and comparison
  identity, and an all-runs/attempts strategy that retains every observation;
- filters for suite, case, agent, validity, and whether a batch contains a
  given aggregate run status;
- run and pass/fail/error/timeout/incomplete counts;
- duration, cost, and token totals when available;
- visible `valid`, `invalid`, and `superseded` labels and notes;
- links to published batch reports;
- meaningful score, assertion, judge, verifier, duration, usage, and cost
  metrics when available;
- an inline light/dark theme toggle using the Felan platform's warm-neutral
  surfaces and green brand palette.

The page performs filtering and grouping client-side. It fetches only compact
manifests for batches selected by the catalog filters. It does not expose raw
run data or configuration details.

Root status filters are batch-level: they answer questions such as “show
batches containing an error.” They do not promise a compound run-level query
such as “errors for agent A in suite B,” because the index does not contain
per-run dimensions. The batch report may filter its own manifest rows by case,
agent, and run status.

The batch `results.html` report is generated from `PublicBatchManifest`, not
from the detail-rich `RunReport`. It shows the same compact run fields as the
manifest and CSV and contains no artifact links or expandable transcript
details. It does not embed validity or supersession state; the root index is
the authoritative current publication status and the report links back to it.

## 7. Storage abstraction

Provider neutrality applies to the archive layout and contracts first. The
framework can initially implement a filesystem store for tests and one
S3-compatible store for deployment.

```ts
export interface PublicResultsStore {
  get(key: string): Promise<Uint8Array | undefined>;
  put(
    key: string,
    content: Uint8Array,
    options: {
      contentType: string;
      cacheControl?: string;
    },
  ): Promise<void>;
  list(prefix: string): Promise<string[]>;
}
```

V1 intentionally has no delete operation. `list()` supports immutable batch
discovery and verification; normal publication reads and updates `index.json`
directly. Validity notes and supersession pointers exist only in the mutable
catalog, so they cannot be reconstructed from immutable manifests in V1. A
catalog update must preserve existing publication metadata. Durable correction
history or a rebuildable status log is deferred.

Store implementations must treat keys as opaque relative paths and must not
place provider-specific metadata in manifests. A public base URL is
presentation configuration, not stored result data.

Every adapter must independently enforce safe relative keys. The filesystem
store resolves the destination and verifies that it remains under its
configured root before reading or writing. Object-store adapters reject
absolute keys, backslashes, and `.` or `..` segments. Validation at the CLI is
not a substitute for validation at the storage boundary.

## 8. Configuration

Proposed configuration keeps secrets in named environment variables:

```yaml
results:
  publish:
    store:
      type: s3
      endpointEnv: RESULTS_STORAGE_ENDPOINT
      regionEnv: RESULTS_STORAGE_REGION
      bucketEnv: RESULTS_STORAGE_BUCKET
      accessKeyEnv: RESULTS_STORAGE_ACCESS_KEY
      secretKeyEnv: RESULTS_STORAGE_SECRET_KEY
    prefix: harness-evals-results
    publicBaseUrl: https://results.example.com/harness-evals-results/v1
```

The filesystem implementation used by tests can use:

```yaml
results:
  publish:
    store:
      type: file
      root: .harness-evals/public-results
    prefix: harness-evals-results
```

The exact cloud provider remains a deployment choice. V1 should not expose
provider-specific URLs or require provider SDK types outside the store
implementation.

## 9. CLI contract

Publication is explicit:

```text
harness-evals publish --batch <batch-id> [--config <path>] [--dry-run]
  [--validity valid|invalid|superseded]
  [--validity-note <text>] [--superseded-by <batch-id>]
  [--allow-unfinalized]

harness-evals publish-status --batch <batch-id> [--config <path>] [--dry-run]
  --validity valid|invalid|superseded
  [--validity-note <text>] [--superseded-by <batch-id>]
```

Rules:

1. `--batch` is required; publication never silently chooses or automatically
   uploads the latest paid run.
2. `--dry-run` builds and validates the public files locally without writing
   to the configured remote store.
3. The command fails when the batch ID is unsafe, unknown, has no scanned task
   runs, lacks a completed local batch record, or does not match that record's
   expected run IDs.
4. The command may publish failed, timeout, or incomplete runs; their statuses
   remain visible rather than being discarded.
5. Re-running publication is idempotent when the generated immutable batch
   objects are byte-identical.
6. If an immutable key already contains different bytes, publication fails
   rather than overwriting the batch.
7. Success prints the stable public report URL when `publicBaseUrl` is set.
8. `--allow-unfinalized` exists for deliberate migration or transparency of a
   legacy/interrupted batch. It requires explicit `--validity invalid` and a
   non-empty `--validity-note`; it never silently upgrades the batch to valid.
9. `--superseded-by` is accepted only with `--validity superseded`, and its
   value must pass the same batch-ID validation.
10. Validity flags update only the batch's `index.json` entry. Reclassifying an
    already published batch never rewrites its manifest, HTML, or CSV.
11. `publish-status` is a catalog-only operation. It requires an existing
    remote catalog entry, does not scan local run artifacts or require a local
    batch record, and fails rather than creating a result entry without an
    immutable published batch.
12. `publish-status --dry-run` validates the requested reclassification and
    existing catalog entry without writing the updated catalog.

## 10. Publication lifecycle

```text
explicit publish command
  -> load harness config
  -> scan compact local run summaries
  -> validate the terminal local batch record and safe identifiers
  -> select every task run in the requested batch
  -> project allowlisted public fields
  -> compute deterministic totals and ordering
  -> render manifest, summary HTML, and CSV
  -> validate the staged file allowlist
  -> upload/verify immutable batch objects
  -> merge the batch summary and mutable publication status into index.json
  -> upload index.html when needed
  -> upload index.json last
  -> print public URL
```

Failure behavior:

- A failure before `index.json` is written may leave unreferenced batch
  objects, but public browsing does not discover a partial batch.
- A retry verifies and reuses identical objects.
- A catalog upload failure leaves the previous catalog valid.
- Reclassification changes only `index.json`; immutable batch files retain the
  originally observed result data and do not present a stale validity label.
- Publisher failure does not change the recorded evaluation verdict.
- With the single-publisher V1 assumption, updating `index.json` does not need
  optimistic concurrency. Conditional writes can be added with multiple
  publishers.

Catalog-only reclassification follows a shorter lifecycle:

```text
explicit publish-status command
  -> load publishing configuration
  -> validate the batch ID and validity arguments
  -> read index.json
  -> require an existing batch entry
  -> update only validity/note/supersededBy
  -> stop without writing when --dry-run is set
  -> write index.json
```

## 11. Public-data boundary

Only generated files are uploaded. The publisher must never recursively sync
`.harness-evals/` or a run directory.

V1 excludes:

```text
.harness-evals/auth/
.harness-evals/agent-config/
.harness-evals/image-cache/
<run>/records.jsonl
<run>/result.json
<run>/index.html
<run>/workspace/
<run>/config/
<run>/steps/
<run>/verifier/
<run>/workspace-setup/
```

The public projection must also remove local filesystem paths. Even when the
evaluated repositories are open source, credentials, hidden verifier details,
and incidental local data are not assumed public.

All strings written into HTML, including validity notes, case IDs, agent names,
providers, and models, are escaped as text rather than interpolated as markup.

Read access to the deployed objects is public. Write credentials remain
private and are never included in reports, config committed to source control,
or public page JavaScript.

## 12. Implementation boundaries

Recommended framework modules:

```text
src/runner/batch-record.ts
src/results/public/types.ts
src/results/public/project.ts
src/results/public/render-html.ts
src/results/public/render-csv.ts
src/results/public/publish.ts
src/results/public/stores/file.ts
src/results/public/stores/s3.ts
```

The exact module split may remain smaller if the implementation is clearer.
Responsibilities are:

- The runner creates and atomically finalizes the local batch record without
  changing per-run output-provider behavior.
- `scanWorkspaceRuns()` continues to own local compact discovery.
- The publisher reads the local batch record and reconciles its expected run
  IDs with the scan before projection.
- Public projection owns the explicit field allowlist and aggregate totals.
- Public rendering consumes only the public manifest contract.
- Store adapters own provider I/O and object metadata.
- The CLI coordinates publication but contains no rendering or storage logic.
- The existing output-provider dispatcher remains unchanged in V1.

Project repositories such as `harness-bench` own deployment configuration,
the bucket/prefix, public base URL, and the decision to publish a batch. The
portable manifest, renderer, publisher, and storage boundary belong in
`harness-evals`.

## 13. Verification and acceptance criteria

The implementation is complete when tests verify:

1. A batch with multiple cases, agents, attempts, and statuses produces a
   deterministic manifest retaining every task run.
2. The projection omits descriptions, local paths, argv, arbitrary metadata,
   raw errors, logs, events, workspace data, verifier details, and credentials.
3. JSON, CSV, and HTML agree on run counts and metrics.
4. Missing cost and usage remain unavailable rather than zero.
5. Mixed currencies are not incorrectly summed.
6. Unsafe batch IDs, prefixes, and traversal keys are rejected, and the file
   store cannot read or write outside its configured root.
7. An unfinalized, partial, missing, or mismatched batch record is rejected by
   default; the explicit unfinalized override can publish it only as invalid.
8. The static index lists, sorts, and applies its documented batch-level
   filters to more than one batch using only `index.json`.
9. Batch objects are written before `index.json`.
10. A failed batch upload leaves the prior catalog unchanged.
11. Retrying byte-identical publication is successful and does not create a
   duplicate catalog entry.
12. A different object at an immutable batch key causes a clear failure.
13. Catalog-only reclassification works without local run artifacts, requires
    an existing catalog entry, and leaves the immutable manifest, HTML, and CSV
    byte-identical.
14. Dynamic strings are HTML-escaped in both the root and batch reports.
15. File-store integration tests exercise publication without network access.
16. Existing `run`, `view`, and `export` behavior remains unchanged.

Run the repository's normal gates after implementation:

```bash
bun run check
bun test
bun run build
```

No provider-backed evaluation run is required to verify publication.

## 14. Deferred evolution

The object-only design should remain until usage demonstrates a need for more.
Potential later additions are:

- compact provenance and compatibility fingerprints;
- downloadable allowlisted evidence bundles;
- append-only correction/invalidation events;
- conditional catalog writes for concurrent publishers;
- remote pull/import and richer historical queries;
- database-backed metadata and APIs;
- Parquet analytical exports;
- private or gated result access;
- checksummed manifests and formal JSON Schema publication.

A database becomes justified when there are concurrent publishers, private
access rules, frequent server-side longitudinal queries, editable review
workflows, or a catalog too large for comfortable browser loading. Parquet or
a lakehouse becomes justified only when bulk analytical scans become a common
workflow.
