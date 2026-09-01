# Installation and configuration

Use this page when you need to get `harness-evals` running in a repo, understand where config comes from, or safely wire in credentials.

## Recommended setup path

Most users start from the repo or npm package page, install the packaged skill, then let their coding agent configure the project.

Install the skill with the Skills CLI:

```bash
npx skills add harness-evals --skill harness-evals
```

Then open your coding agent and ask it to interview you before creating eval files:

```text
/harness-evals Interview me about what to evaluate, then set up the first focused eval for this project.
```

The skill tells the agent to read these docs, check whether the CLI is installed, ask how to install it if missing, inspect the project, and translate your goals into harness config and eval cases. Normal onboarding should start with what you want to test and how, not with a dummy case.

## CLI installation choices

The CLI comes from the `harness-evals` npm package. The agent should check for it before editing harness files, for example with `harness-evals --help` or the package-manager runner used by the project.

If the CLI is missing, choose one install mode:

### Global CLI

Use this when you want `harness-evals` available in any repo:

```bash
npm install -g harness-evals
harness-evals --help
```

### Local project CLI

Use this when the project should pin the harness version in dev dependencies:

```bash
npm install -D harness-evals
npx harness-evals --help
```

Equivalent package-manager commands:

```bash
pnpm add -D harness-evals
pnpm exec harness-evals --help

bun add -d harness-evals
bunx harness-evals --help

yarn add -D harness-evals
yarn harness-evals --help
```

When installed locally, run commands through the package runner or add package scripts for repeatable CI usage.

## First validation run

After your agent creates `harness-evals.yaml` and at least one goal-specific case, validate that setup with:

```bash
harness-evals list
harness-evals run --case <case-id> --agents <agent-name>
```

If you installed locally, prefix those commands with the package runner, such as `npx harness-evals`.

## Contributor setup from this repository

For local development on the harness itself:

```bash
bun install
bun run check
bun run build

repo_root="$(git rev-parse --show-toplevel)"
skill_source="$repo_root/skills/harness-evals"
skill_target="$HOME/.agents/skills/harness-evals"

test -f "$skill_source/SKILL.md"
mkdir -p "$HOME/.agents/skills"
ln -s "$skill_source" "$skill_target"
```

The Skills CLI copies a local skill into its canonical installation directory,
so a Skills CLI install does not track later repository edits. Use the direct
repository symlink above while editing the skill. Inspect `skill_target` first;
if it already exists and is not the correct symlink, get the user's approval
before replacing that user-level agent configuration. Verify the link with
`readlink` and start a new agent session to reload the skill. A later Skills CLI
install or update may replace the direct link.

## `harness-evals.yaml`

Without `--config`, the discovered file name is fixed:
`harness-evals.yaml`. The `--config <path>` option can select a differently named
YAML file explicitly.

Minimal config shape:

```yaml
version: 1

agents:
  local-command:
    adapter: command
    command: echo
    args:
      - "{{ prompt }}"

  felan:
    adapter: felan
    provider: google
    model: gemini-2.5-pro
    thinking: high
    config:
      packageVersion: 0.14.2

tests:
  - evals/tests/**/*.yaml
```

Useful top-level sections:

- `artifactRoot`: per-run artifacts
- `outputRoot`: exported/latest reports
- `workspace`: source copy / Git / seed settings (`source`, `fixture`, `git`, or `seedFromImage`)
- `docker`: runtime image (`image` ready / `baseImage` + `baseSetup` managed), timeout, env allowlist
- `agents`: named agent configs
- `tests`: project-relative globs for test case YAML files
- `adapters`: project-defined adapter modules
- `mocks`: mock fixture root and strictness
- `output`: output providers
- `visualization`: html/json/csv report settings
- `judge`: shared defaults for `llmJudge` assertions
- `scoring`: weights for pass rate, judge score, verifier reward, latency, cost, token usage
- `benchmarks`: named comparisons with selectors, baseline/candidate arms,
  trials, quality gates, one objective, and explicit reducers

Minimal benchmark example:

```yaml
benchmarks:
  cost:
    label: Agent cost
    select: { suites: [checkout] }
    arms: { baseline: agent-a, candidate: agent-b }
    trials: 3
    qualityGates:
      - { metric: quality.passRate, min: 1 }
    objective: { metric: cost.total, goal: minimize }
```

## Config discovery

`harness-evals` resolves config in this order:

1. `--config <path>` if you pass it
2. otherwise, search upward from the current working directory for `harness-evals.yaml`

If no config is found, the CLI fails.

## Defaults

When a field is omitted, the loader fills in defaults.

Default highlights:

```yaml
artifactRoot: .harness-evals/runs
outputRoot: .harness-evals/output
workspace:
  source: .
  mode: copy
  containerPath: /workspace
  ignore:
    - .git
    - node_modules
    - .harness-evals
    - .pi-evals
    - evals/output
docker:
  repoPath: /workspace
  home: /home/harness
  configRoot: /agent-config
  timeoutMs: 300000
  baseSetup: []
mocks:
  root: evals/mocks
  strict: true
  recordCalls: true
output:
  providers:
    - type: file
visualization:
  enabled: true
  formats: [html, json, csv]
  latest: true
scoring:
  assertionPassRate: { weight: 1 }
  judgeScore: { weight: 1 }
  verifierReward: { weight: 1 }
  latency: { weight: 0 }
  cost: { weight: 0 }
  tokenUsage: { weight: 0 }
tests:
  - evals/tests/**/*.yaml
```

If `output.providers` ends up empty, `file` is restored automatically.

## Merge order

There are two separate merges to keep in mind.

### 1) Harness config merge

`harness-evals.yaml` is merged onto built-in defaults.

Rules:

- objects are merged shallowly by section
- arrays replace the default array for that field
- agent definitions are merged by name
- `agents.<name>.extends` lets one agent inherit from another

Example:

```yaml
agents:
  base:
    adapter: command
    command: echo
    model: root-model
  child:
    extends: base
    model: child-model
```

`child` inherits `adapter` and `command`, then overrides `model`.

### 2) Runtime agent merge

For a selected test case and agent, runtime settings are applied in this order:

1. resolved agent config from `harness-evals.yaml`
2. test-case base overrides (`timeoutMs`, `parser`)
3. test-case wildcard override: `agents.overrides["*"]`
4. test-case named override: `agents.overrides["<agent-name>"]`
5. CLI overrides such as `--provider`, `--model`, `--timeout-ms`

CLI flags win last.

## Path resolution rules

Most file paths are resolved relative to the directory that contains `harness-evals.yaml`.

This includes:

- `artifactRoot`
- `outputRoot`
- `workspace.source`
- `workspace.fixture`
- `mocks.root`
- adapter modules referenced by `adapters.*.module`
- custom output provider modules

Rules enforced by the loader:

- test globs must be project-relative
- `~` is not allowed in test globs
- path traversal such as `../` is rejected for test globs and fixtures
- project-contained `file:` URLs in `workspace.git.repository` are resolved
  against the same project-root boundary
- Git commits must be full 40-character hexadecimal SHAs; Git repositories must
  be credential-free HTTPS URLs or project-contained `file:` URLs
- project-relative paths must stay inside the project root

Mock fixture references support two forms:

- fixture name, for example `jira-success` -> `<mocks.root>/cli/jira-success.yaml` or `<mocks.root>/mcp/...`
- explicit path, for example `evals/mocks/cli/jira-success.yaml`

## Environment interpolation

YAML values can interpolate environment variables:

```yaml
judge:
  provider: openai
  model: gpt-4.1
  apiKeyEnv: OPENAI_API_KEY

output:
  providers:
    - type: postgres
      module: ./evals/output/postgres-output.js
      config:
        connectionEnv: ${env:HARNESS_EVALS_DATABASE_URL}
```

Supported forms:

- `${env:NAME}`
- `${env:NAME:-fallback}`

Missing variables without a fallback become an empty string.

For `llmJudge`, explicit `judge.provider`, `judge.model`, and `judge.apiKeyEnv` are optional only when a configured agent adapter supports headless `complete()` calls for automatic judge fallback.

## Safe credential handling

Prefer environment variable names in config, not raw credential values.

Good:

```yaml
judge:
  provider: openai
  model: gpt-4.1
  apiKeyEnv: OPENAI_API_KEY
```

Avoid putting raw keys, tokens, or passwords into:

- `harness-evals.yaml`
- test case YAML files
- checked-in adapter config
- mock fixtures

Safer patterns:

- pass env var names such as `apiKeyEnv: OPENAI_API_KEY`
- reference env values with `${env:NAME}` only when the target field expects a value, not an env var name
- keep credentials in your shell, CI credential store, or local agent config
- use `docker.envAllowlist` and agent `env` / `envAllowlist` to forward only the variables the run needs

For Felan subscription access, use the built-in OAuth configuration instead of
putting access or refresh tokens in this file. See [Agents and adapters](./agents-and-adapters.md#felan-subscription-oauth)
for the supported provider IDs and the local `.harness-evals/auth` storage
behavior.

Default Docker allowlist includes common LLM API key names such as `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, and `GEMINI_API_KEY`.

## Common commands

```bash
harness-evals list
harness-evals run --suite smoke
harness-evals run --case checkout-refactor --agents pi-gemini,claude-sonnet
harness-evals view --latest --open
harness-evals export --format html --output report.html
harness-evals export --run <run-id> --format json --output run.json
```

Use `--config path/to/harness-evals.yaml` when you are not running from the project tree that contains the config.

## Public results archive

The optional `results.publish` section enables explicit publication of compact
completed batch summaries. V1 supports a local filesystem store, which is
useful for testing and staging:

```yaml
results:
  publish:
    store:
      type: file
      root: .harness-evals/public-results
    prefix: harness-evals-results
    publicBaseUrl: https://results.example.com/harness-evals-results/v1
```

Run `harness-evals publish --batch <batch-id>` after a run. The publisher
writes immutable per-batch `manifest.json`, `results.html`, and `results.csv`
objects before updating the root catalog. Configured benchmarks also get
immutable JSON, HTML, and CSV objects under the batch's benchmark directory,
with their paths recorded in the catalog. The completed local batch record must
exactly match the scanned run IDs; duplicate or missing IDs are rejected. Use `--dry-run` to validate without
writing. `publish-status` reclassifies an existing catalog entry without
reading local artifacts; its `--dry-run` option validates without updating the
catalog. The public projection contains summary dimensions,
status, score, usage, and cost only; it excludes logs, transcripts,
workspaces, verifier details, credentials, raw errors, and filesystem paths.

The archive store is intentionally provider-neutral. Supabase Storage or
Vercel Blob can be implemented behind the same interface once deployment
requirements are chosen.

The archive root aggregates all published batches. Its **Latest results** view
unions suites and cases and selects the newest result for each case/comparison
identity (`comparisonId`, falling back to the agent name);
**All runs / attempts** retains every observation for longitudinal comparison.
Use the suite, case, agent, validity, and status filters to narrow the view.
