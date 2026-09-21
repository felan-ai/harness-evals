# ADR 0002: Add Jev as an Explicit Structured Judge

> Status: Accepted
> Date: 2026-09-21
> Deciders: Felan maintainers
> Related: [Scoring and judging](../../skills/harness-evals/docs/scoring-and-judging.md)

## Context

The existing `llmJudge` assertion sends a prompt to a text-generating model
and parses a JSON score and rationale. Jev is a different service: it
evaluates shared state against typed questions and returns calibrated
probabilities, choices, and confidence metadata. Treating Jev as an LLM
provider would make the current prompt and response contract misleading and
would not support its TypeSafe, OpenRouter, or Vercel evaluation transports.

Provider selection also affects reproducibility. Choosing a route from
whatever credentials happen to be present can silently change a benchmark.

## Decision

Add a separate `jevJudge` assertion and nested `judge.jev` defaults. Jev
provider selection is explicit and limited to `typesafe`, `openrouter`, and
`vercel-ai-gateway`; model and credential environment names may use provider
defaults and may be overridden in configuration. The existing `llmJudge`
configuration, fallback behavior, and text response contract remain unchanged.

Jev results will enter the existing judge score, assertion, artifact, and cost
pipelines through a normalized result contract, while preserving Jev-specific
probability and confidence metadata. Jev calls run as a host-side judge and
do not become part of the evaluated agent's adapter or persisted credentials.

## Alternatives Considered

- **Reuse `llmJudge`:** rejected because Jev does not return prose or the
  `score`/`reason` JSON contract used by that assertion.
- **Replace `llmJudge`:** rejected because it would break existing evals and
  remove useful text-generating judge providers.
- **Infer a provider from available credentials:** rejected because the same
  eval could use a different provider across machines or CI runs.

## Consequences

- Eval authors get an explicit structured-judge contract without a migration
  requirement for existing suites.
- Provider-specific transport validation and metadata normalization are needed
  in the judge boundary.
- Jev confidence and probability are available for diagnostics, but Jev does
  not provide a generated rationale; rubrics must express the decision being
  scored.
- Offline retained-run reprocessing must continue to reject provider-backed
  judge assertions.
