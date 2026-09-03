# Getting started

This guide covers the first agent-led setup and the core CLI loop:

1. install the skill and CLI
2. have your agent create project-specific evals
3. list discovered agents and cases
4. run one focused case
5. view or export the report

## Before you start

Install the `harness-evals` skill, then ask your coding agent to set up evals for the project. The agent should check whether the CLI is installed and ask whether to install it globally or locally if it is missing.

The examples below use `harness-evals`. If the CLI is installed locally, run the same commands through your package runner, such as `npx harness-evals`, `pnpm exec harness-evals`, or `bunx harness-evals`.

## 1. Ask your agent to set up evals

From the repo or directory you want to evaluate, start with a goal-oriented prompt:

```text
/harness-evals Set up evals for this project. Interview me first about what I want to test and how success should be judged.
```

The agent should:

- inspect the repo and existing agent configuration
- ask what behavior, workflow, failure, or session should become the first eval
- create or update `harness-evals.yaml`
- create goal-specific cases under `evals/tests/`
- add mocks, fixtures, judge assertions, or scoring only when they match the goal

## 2. Review the generated harness files

A typical project contains:

- `harness-evals.yaml`
- `evals/tests/<case-id>.yaml`
- optional `evals/mocks/`
- optional focused fixtures under `evals/fixtures/`

Check that the first case prompt, selected agents, and assertions match the behavior you wanted to evaluate.

## 3. List agents, cases, and matrix size

```bash
harness-evals list
```

You should see:

- configured agent names
- discovered case IDs and suites
- total matrix entry count
- whether the run will use a ready Docker image or an automatically managed one

## 4. Run one focused case

```bash
harness-evals run --case <case-id> --agents <agent-name>
```

What this does:

- copies the configured workspace into a Docker workspace
- runs the selected agent against the selected case
- evaluates assertions from the test case
- writes run artifacts and, when enabled, the last invocation's summary report

A passing run exits with code `0`. A failing run exits with code `1` and still writes artifacts for inspection.

## 5. View the report

By default, `view` generates the benchmark landing page and each declared
benchmark's report, prints the landing-page path, and opens it:

```bash
harness-evals view
```

To generate the benchmark reports and print the path without opening it:

```bash
harness-evals view --no-open
```

To serve reports on a local port:

```bash
harness-evals view --port 3000 --open
```

You can also target a specific run if you know its run id:

```bash
harness-evals view --run <run-id>
```

Use `--latest` to target the pre-rendered summary from the last invocation
instead of generating benchmark reports. This is also the useful view when a
project has not declared benchmarks:

```bash
harness-evals view --latest --open
```

Per-run HTML lives at:

- `.harness-evals/runs/<run-id>/index.html`

The generated benchmark landing page lives at:

- `.harness-evals/output/benchmarks/index.html`

The last invocation's summary lives at:

- `.harness-evals/output/latest/results.html`

## 6. Export a report file

Export a declared benchmark report in one of the enabled visualization formats:

```bash
harness-evals export --benchmark <id> --format html --output ./artifacts/results.html
harness-evals export --benchmark <id> --format json --output ./artifacts/results.json
harness-evals export --benchmark <id> --format csv --output ./artifacts/results.csv
```

Pass `--latest` to copy the last invocation's pre-rendered summary instead:

```bash
harness-evals export --latest --format json --output ./artifacts/latest-results.json
```

To export a specific run instead of the latest summary:

```bash
harness-evals export --run <run-id> --format json --output ./artifacts/run.json
```

`--format` must be one of `html`, `json`, or `csv`, and that format must be enabled in `visualization.formats`.

## What to inspect after a run

Useful generated paths:

- `.harness-evals/output/benchmarks/index.html` (after plain `view`)
- `.harness-evals/output/latest/results.html`
- `.harness-evals/output/latest/results.json`
- `.harness-evals/output/latest/results.csv`
- `.harness-evals/runs/<run-id>/result.json`
- `.harness-evals/runs/<run-id>/steps/<step-id>/stdout.log`
- `.harness-evals/runs/<run-id>/steps/<step-id>/assertions.json`

## Next steps

After the first case runs, the usual next moves are:

- tighten assertions based on the first artifacts
- add cases from existing sessions, failures, or repeated workflows
- compare more agents on the same case
- add mocks under `evals/mocks/` for deterministic external behavior
- group cases into suites and run them with `--suite`

For practical patterns, continue to [Use cases](./use-cases.md).
