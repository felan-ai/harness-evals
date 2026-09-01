# CLI reference

`harness-evals` defaults to `run` when you do not pass a command.

## Common behavior

- `--config <path>`: use a specific config file. If omitted, `harness-evals` searches upward from the current working directory for `harness-evals.yaml`.
- `--help`, `-h`: print CLI help.
- Unknown commands or flags fail immediately.

Built-in agent definitions can select Felan directly:

```yaml
agents:
  felan:
    adapter: felan
    provider: google
    model: gemini-2.5-pro
    thinking: high
```

The adapter invokes Felan's supported `--mode json` headless interface and keeps
per-run settings and selected credentials under an isolated `FELAN_AGENT_DIR`.

## Commands

### `run`

Run the selected case/agent matrix.

`--benchmark <id>` selects the benchmark's exact cases, baseline/candidate
agents, and trial count. It cannot be combined with `--suite`, `--case`,
`--agents`, or `--attempts`.

```bash
harness-evals run [--config path] [--suite name] [--case id] [--agents a,b] [--concurrency n] [--attempts n]
```

Flags:

- `--suite <name>`: run only cases in one suite.
- `--case <id>`: run only one case ID.
- `--agents <a,b>`: run only the named agents (comma-separated).
- `--concurrency <n>`: run up to `n` matrix entries at once.
- `--attempts <n>`: override case-level attempt counts for selected cases.
- `--provider <name>`: override the provider for selected agents.
- `--model <name>`: override the model for selected agents.
- `--timeout-ms <n>`: override the per-run timeout.
- `--image <ref>`: use a ready Docker image for all selected runs and skip managed image builds.
- `--refresh-managed-image`: rebuild the selected managed image before running, using Docker `--pull` and `--no-cache`.
- `--cleanup`: delete adapter cleanup paths after each run. You can also set `HARNESS_EVALS_CLEANUP=1`.
- `--no-cleanup`: keep adapter cleanup paths after each run. This is the default.

Output:

- Prints one row per case/agent result, including artifact path.
- Prints `Summary: <path>` for the harness summary output.
- Exits with code `0` when all selected runs pass, `1` when any run fails or the command errors.
- Keeps adapter cleanup paths unless `--cleanup` or `HARNESS_EVALS_CLEANUP=1` is set.

### `list`

List configured agents, cases, and the size of the selected matrix.

Use `--benchmark <id>` to validate and display its resolved matrix.

```bash
harness-evals list [--config path]
```

Useful filters:

- `--suite <name>`
- `--case <id>`
- `--agents <a,b>`
- `--image <ref>`
- `--refresh-managed-image` (accepted for parity with `run`; it only annotates managed-image output)

Output includes:

- agent names and adapters
- case IDs and suites
- matrix entry count after filters
- runtime image mode: ready image vs managed image

### `view`

Generate and open the aggregate workspace report, or locate single-run reports.

`view --benchmark <id>` writes one quality-gated benchmark report.
`view --benchmark all` writes a landing page and HTML/JSON/CSV artifacts for
every declared benchmark, using the newest relevant batch by default.
Only runs stamped with the current benchmark definition digest are eligible;
after changing a benchmark definition, run it again before viewing or
publishing the report.

```bash
harness-evals view [--config path] [--batch id|latest|all] [--agents a,b] [--suite name] [--status s1,s2] [--no-open] [--port n]
harness-evals view --run id | --latest [--open] [--port n]
```

Flags:

- `--batch <id|latest|all>`: pre-select batches in the report (comma list allowed). Default: newest batch.
- `--agents`, `--suite`, `--status`: pre-set the report's filters.
- `--no-open`: write and print the report path without opening a browser.
- `--run <id>`: target a specific run directory under the artifact root (back-compat detail view).
- `--latest`: target the last invocation's `results.html`.
- `--open`: open the file path or local server URL (aggregate view opens by default).
- `--port <n>`: serve reports on `127.0.0.1:<n>` instead of just printing the file path.

Behavior:

- Default: scans every run directory, writes `<outputRoot>/report/index.html` (self-contained interactive aggregate: batch selector, filters, charts), and opens it.
- With `--run`, resolves `<artifactRoot>/<run-id>/index.html`.
- With `--latest`, resolves `<outputRoot>/latest/results.html`.
- With `--port`, serves `/report/...`, `/runs/...`, and `/latest/...` until interrupted.

### `export`

Export the aggregate report (filtered server-side), or copy/render legacy reports.

Use `--benchmark <id>` to export its benchmark-specific HTML, JSON, or CSV.

```bash
harness-evals export [--config path] --format html|json|csv --output path [--batch id|latest|all] [--agents a,b] [--suite name] [--case id] [--status s1,s2]
harness-evals export --run id | --latest --format html|json|csv --output path
```

Required flags:

- `--format <html|json|csv>`
- `--output <path>`

Optional flags:

- `--batch <id|latest|all>`: which batches to include (default `latest`); merging several keeps the newest graded attempt per (case, agent).
- `--agents`, `--suite`, `--case`, `--status`: server-side row filters.
- `--latest`: copy `<outputRoot>/latest/results.<format>` verbatim (pre-aggregate behavior).
- `--run <id>`: export a specific historical run from its `result.json`.

Behavior:

- Default renders the aggregate: `html` is the interactive report, `csv` one row per task run, `json` the embedded data model.
- Creates parent directories for `--output` automatically.
- Fails if visualization is disabled or the requested format is not enabled in config.

## Docker image behavior

`harness-evals` has two runtime image modes:

- Ready image: set `docker.image` in config or pass `--image <ref>` to use an existing image.
- Managed image: if no ready image is configured, `harness-evals run` builds one automatically for the selected agents, caches it, and reuses it on later runs when possible.

Ready image behavior:

- The CLI probes the image to confirm required tools are present.
- If probes fail, the run stops and asks you to supply a suitable image or remove the ready-image setting so managed image resolution can be used.

Managed image behavior:

- The image is built from the install recipes required by the selected agents.
- Cached images are probed before reuse; if a cached image fails probes, it is rebuilt.
- Pass `--refresh-managed-image` to bypass cached-image reuse and rebuild the managed image with Docker `--pull` and `--no-cache`.
- There is no separate Docker build workflow to run first.

If you call the `docker` command directly, the CLI fails with guidance to use `run` and either let managed builds happen automatically or supply `docker.image` / `--image`.

## Publish a public batch archive

Publication is explicit and separate from `run`, `view`, and `export`:

```bash
harness-evals publish --batch <batch-id> [--config path] [--dry-run]
harness-evals publish-status --batch <batch-id> --validity valid|invalid|superseded [--dry-run]
```

Configure the filesystem publisher with:

```yaml
results:
  publish:
    store:
      type: file
      root: .harness-evals/public-results
    prefix: harness-evals-results
    publicBaseUrl: https://results.example.com/harness-evals-results/v1
```

`publish` reads only compact `summary.json` and `run-started.json` files. It
publishes a summary manifest, HTML report, CSV, and root catalog. It never
uploads transcripts, logs, workspaces, credentials, raw results, or local
paths. `--dry-run` validates and renders without writing files. A completed
local batch record is required; use `--allow-unfinalized` only with
`--validity invalid` and a non-empty `--validity-note`.

`publish-status` changes only the catalog validity metadata and requires that
the batch was already published. Pass `--dry-run` to validate a reclassification
without updating the catalog. Batch objects remain immutable. The storage
interface is provider-neutral; a cloud backend can be added later without
changing published archive paths.

The public archive root is an aggregate dashboard rather than a batch list.
It fetches the selected compact manifests and supports:

- **Latest results** — union batches and keep the newest result for each
  case/agent pair.
- **All runs / attempts** — retain every published run so repeated executions
  can be compared as attempts.

Suite, case, agent, validity, and status filters apply across the selected
batches. Individual immutable batch reports remain available from their
stable URLs.
