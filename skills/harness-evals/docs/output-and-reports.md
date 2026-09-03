# Output and reports

Harness-evals writes per-run artifacts and a rolling latest summary through the built-in file output provider.

## File output provider

If you do not configure output providers, harness-evals uses the built-in `file` provider.

Default roots:

- run artifacts: `.harness-evals/runs`
- latest summaries and exports: `.harness-evals/output`

The file provider is also the provider that renders the built-in visualizations.

## Artifact layout

Each scenario/agent run gets its own directory under `artifactRoot`:

```text
.harness-evals/runs/
  <case>-<agent>-<timestamp>-<n>/
```

Common files in a run directory:

- `records.jsonl`: every emitted output record, in order
- `run-started.json`
- `image-resolution.json`
- `workspace-diff.json`
- `score-summary.json`: scenario-level score summary
- `cost-summary.json`: scenario-level cost summary
- `result.json`: full run result
- `summary.json`: compact run summary
- `finalize.json`: provider finalize status
- `index.html`: per-run HTML report when HTML visualization is enabled
- `mock-config.json` and `mock-calls.jsonl` when mocks are used
- `model.patch` when model patch capture is enabled
- `hidden-patch.json` when a hidden patch is applied
- `workspace-source.json` when the workspace comes from an exact Git commit

Verifier files live under `verifier/` when a case has `verifier`:

- `verifier-started.json`
- `command.redacted.json`
- `stdout.log`
- `stderr.log`
- `reward.json` when a reward file is parsed
- `result.json`

Per-step files live under `steps/<step-id>/`:

- `step-started.json`
- `command.redacted.json`
- `stdout.log`
- `stderr.log`
- `events-summary.json`
- `assertions.json`
- `score.json`
- `cost.json`
- `step-completed.json`
- `mock-config.json` and `mock-calls.jsonl` for step-scoped mocks
- `judges/<assertion-id>.json` for `llmJudge` results

Step ids are sanitized for artifact paths, so use stable, distinct step ids.

## Latest summary

After a run finishes, harness-evals writes a latest report set under:

```text
.harness-evals/output/latest/
```

By default it writes:

- `results.html`
- `results.json`
- `results.csv`

The summary content is built from the full run results and includes pass/fail counts, average score, duration, cost, token usage, pass@k summaries when eligible, per-case rows, and per-agent columns.

## Visualization formats

Built-in visualization formats are:

- `html`
- `json`
- `csv`

Default config:

```yaml
visualization:
  enabled: true
  formats: [html, json, csv]
  latest: true
```

Notes:

- per-run `index.html` is generated only when `html` is enabled
- latest files are generated only when `visualization.enabled` and `visualization.latest` are both true
- if you limit `formats`, only those files are written

You can also control detail sections included in reports:

```yaml
visualization:
  include:
    logs: true
    workspaceDiff: true
    toolCalls: true
    mockCalls: true
    judgeDetails: true
```

These switches affect the rendered report content, not the underlying artifacts.

## Export reports

Use declared benchmarks or stored run summaries for portable report files:

```bash
harness-evals export --benchmark <id> --format html --output report.html
harness-evals export --benchmark <id> --format json --output report.json
harness-evals export --benchmark <id> --format csv --output report.csv
harness-evals export --latest --format json --output latest.json
harness-evals export --run <run-id> --format csv --output run.csv
```

Benchmark exports use the selected retained batch (newest relevant batch by
 default) and preserve benchmark objectives, trial observations, and quality
 gates. `--latest` copies the latest pre-rendered summary, while `--run` renders
 a single retained run. Bare `export` is rejected; it cannot generate a
 workspace-wide report. Parent directories are created automatically.

## What the HTML reports are for

The per-run/latest and benchmark HTML reports are focused comparison and
triage views. They can include steps, failed assertions, tool calls, mock
calls, judge results, verifier results, workspace diffs, and portable artifact
links when enabled.

The per-run/latest report:

- groups results by test case
- shows one column for each agent/provider/model configuration
- shows status, score, human-readable agent time, requests, tokens, cost,
  assertions, result, and actions as metric rows
- opens diagnostics in a scrollable modal and preserves portable artifact links

## Benchmark reports

Benchmark reports show the declared primary and optional secondary objectives, matrix completeness,
quality gates, every trial observation, per-case reductions, absolute values,
and baseline deltas. A
candidate is not eligible when required quality regresses or observations are
missing.

Each benchmark has exactly two arms. The combined report renders one row per
benchmark: a bar for the mean goal-aware outcome across cases and a whisker
spanning the minimum and maximum outcomes, without a redundant range column.
The primary percentage is positive when the candidate moves in the declared
direction, including when a minimized metric decreases. An optional secondary
objective is described from its raw direction, such as `40.5% fewer prompt
tokens`, and colored according to its own goal. HTML shows only these
goal-aware outcomes, while raw percentage change remains available in JSON and
CSV. The metrics matrix separately shows each absolute candidate-minus-baseline
delta. Quality-regressed comparisons are marked as not credited rather than
celebrated as improvements.

JSON stores the primary comparison under `comparison` and all ordered objective
comparisons under `objectiveComparisons`; each includes `metric`, `role`,
`goal`, `changePercent`, and positive `gainPercent` fields. CSV exposes the
same fields plus `objectiveRole` and `objectiveGoal`. Every metric found in
the retained run summaries is included in an aggregate matrix with metrics as
rows and benchmark arms as columns, including duration, prompt/output/cache
tokens, requests, quality, cost, and custom numeric metrics.

Numeric observations are persisted in `summary.json.metrics`. Small,
explicitly marked `benchmark-metrics.json` sidecars can supply derived metrics
for historical local runs without making the scanner load large `result.json`
artifacts. `harness-evals view --benchmark all` generates the combined landing
page and each benchmark's HTML/JSON/CSV files.

Benchmark reports use only runs stamped with the current benchmark ID and
definition digest. Runs from an older definition, unstamped legacy runs, and
duplicate or out-of-range trial numbers are excluded or reported incomplete;
rerun the benchmark after changing its selectors, objectives, gates, trials, or
reducers. To migrate retained runs to a changed definition without executing
agents, use `harness-evals reprocess --source <benchmark>=<completed-batch>`;
then regenerate with `harness-evals view --benchmark <id>` or
`harness-evals export --benchmark <id>`. Reprocessing is offline and writes
derived, non-publishable runs; provider-backed judges, networked verifiers,
hidden patches, and incomplete source batches are not supported.
