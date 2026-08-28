# Persistent Evaluation Results Storage Research

> **Decision:** V1 uses a public, object-storage-only summary archive.
> **Implementation design:** [`../design/lld/public-results-archive.md`](../design/lld/public-results-archive.md)

## Research question

How should coding-agent evaluation results be preserved, browsed, aggregated,
and eventually published without tying the result format to one database or
cloud provider?

The research considered experiment trackers, evaluation platforms, public
benchmark publishers, open data formats, object-storage durability, and
provenance standards.

## Long-term industry pattern

Larger evaluation systems commonly separate three concerns:

1. Immutable or durable evidence in object storage.
2. Queryable metadata in a relational or analytical database.
3. Derived exports and public reports for human and machine consumption.

Examples include:

| System | Relevant pattern |
| --- | --- |
| [MLflow](https://mlflow.org/docs/latest/self-hosting/architecture/overview/) | Relational backend metadata is separated from artifact storage. |
| [Braintrust](https://www.braintrust.dev/docs/evaluate/run-evaluations) | Experiments are durable evaluation snapshots with versioned dataset linkage. |
| [LangSmith](https://docs.langchain.com/langsmith/data-export) | Trace storage is separated from feedback and supports Parquet export. |
| [Inspect AI](https://inspect.aisi.org.uk/eval-logs.html) | Portable eval logs can be persisted to S3-compatible storage. |
| [HELM](https://crfm-helm.readthedocs.io/en/stable/downloading_raw_results/) | Versioned raw benchmark results are published separately from leaderboard views. |
| [Hugging Face](https://huggingface.co/docs/hub/eval-results) | Structured evaluation metadata is paired with cards, verification status, and source links. |
| [MLCommons](https://mlcommons.org/results-change-log/) | Published results retain explicit correction and invalidation history. |

The common lessons are:

- Preserve observations below derived aggregates.
- Version benchmark inputs, configurations, and evaluators.
- Treat “latest” and leaderboards as views rather than overwritten evidence.
- Keep large payloads outside transactional databases.
- Include failures, timeouts, incomplete runs, provenance, and correction
  status in public claims.

## Format findings

Different formats serve different purposes:

| Format | Appropriate use |
| --- | --- |
| JSON | Portable manifests, small API responses, and schema-versioned interchange. |
| JSONL | Ordered event streams and append-friendly raw logs. |
| PostgreSQL | Frequently filtered metadata and operational queries. |
| Parquet | Compressed longitudinal analytics and bulk exports. |
| HTML and CSV | Human browsing and convenient downloads. |
| OpenTelemetry conventions | Shared vocabulary for model and tool telemetry, not a benchmark archive contract. |

Relevant format and provenance references:

- [JSON, RFC 8259](https://www.rfc-editor.org/rfc/rfc8259.html)
- [JSON Schema Draft 2020-12](https://json-schema.org/specification)
- [JSON Canonicalization Scheme, RFC 8785](https://www.rfc-editor.org/rfc/rfc8785.html)
- [Apache Parquet](https://parquet.apache.org/docs/overview/)
- [DuckDB Parquet queries](https://duckdb.org/docs/stable/data/parquet/overview)
- [OpenTelemetry GenAI attributes](https://opentelemetry.io/docs/specs/semconv/registry/attributes/gen-ai/)
- [SLSA provenance](https://slsa.dev/spec/v1.2/provenance)

Object storage can add versioning, integrity checks, lifecycle policies, and
selective write-once retention. Those features do not require the archive
format to expose a provider-specific object URI:

- [S3 Versioning](https://docs.aws.amazon.com/AmazonS3/latest/userguide/Versioning.html)
- [S3 object integrity](https://docs.aws.amazon.com/AmazonS3/latest/userguide/checking-object-integrity.html)
- [S3 Object Lock](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lock.html)

For analytical tables, plain Parquet is sufficient before table-management
requirements appear. [Apache Iceberg](https://iceberg.apache.org/docs/latest/evolution/)
becomes useful only with concurrent writers, table snapshots, schema evolution,
partition evolution, or multiple analytical engines.

## Scale observed in the initial project

The inspected Harness Bench workspace contained a small number of batches and
24 task-run directories. Its local `.harness-evals` data was about 1.6 GiB,
of which roughly 1.36 GiB was duplicated copied workspaces. Compact summary
files are therefore a much better first public payload than mirroring local run
directories.

The current aggregate scanner already reads only `summary.json` and
`run-started.json`. Those compact records provide the dimensions needed for a
small public history: batch, case, suite, agent, attempt, status, score,
duration, cost, usage, provider, and model.

The existing detailed HTML and JSON reports are not suitable as a summary-only
public contract because they may embed events, output, configuration, workspace
details, verifier data, and local paths.

## V1 decision

The larger metadata-database and analytical architecture would be unnecessary
operational overhead for the expected first-version volume. V1 therefore uses:

- public-read object storage with private write credentials;
- immutable batch directories;
- one compact JSON manifest per batch;
- one summary HTML report and CSV per batch;
- one root `index.json` catalog;
- one standalone static `index.html` browser;
- explicit post-run publication;
- a provider-neutral object layout and small store interface.

V1 publishes reports and summaries only. It deliberately excludes transcripts,
logs, copied workspaces, configs, verifier assets, raw results, auth state, and
caches. This preserves public comparison history but not full forensic evidence;
that is an explicit retention trade-off.

The archive remains migration-friendly: a future service can ingest the
versioned manifests into PostgreSQL or materialize Parquet without changing
historical batch URLs.

## Ownership

`harness-evals` should own the portable manifest types, compact projection,
summary renderers, publish workflow, and storage abstraction. Evaluation
projects should own their deployment configuration, public URL, storage
credentials, and the decision to publish a batch.

The V1 publisher is separate from the live `OutputProvider` lifecycle. This
keeps remote storage failures out of evaluation execution and ensures only
complete, explicitly selected batches become public.
