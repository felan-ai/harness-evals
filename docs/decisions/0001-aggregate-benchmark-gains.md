# ADR 0001: Aggregate Additive Benchmark Gains from Reduced Case Totals

> Status: Accepted
> Date: 2026-09-05
> Deciders: Felan maintainers
> Related: [Output and reports](../output-and-reports.md)

## Context

Benchmark reports currently reduce repeated attempts within each case, compute
a percentage change for every case, and use the arithmetic mean of those
percentages as the headline. This gives every case equal influence, regardless
of its baseline cost. It answers whether the typical relative case effect is
favorable, but it does not answer how much an additive resource total changes
when the benchmark workload contains one execution of every case.

Summing every raw attempt would answer a different question. Attempts are
repeated measurements, not additional workload units, and benchmark
definitions deliberately choose a mean or median trial reducer. Ignoring that
reducer would make the headline depend on the attempt count and could make a
single outlier dominate a median-based benchmark.

## Decision

Add an explicit `ratioOfReducedSums` case aggregation mode. For each arm and
case, apply the configured trial reducer first. Sum those reduced case values
within each arm, then calculate the goal-aware candidate-versus-baseline
percentage from the two sums.

Keep `macroMean` as the default and preserve its existing fields and behavior.
Reports using the new mode expose separately named aggregate values and use
the aggregate gain as their headline. The arithmetic mean and range of
case-level gains remain available as labeled diagnostics rather than being
redefined.

The aggregation mode does not alter completeness checks, attempt status,
failure handling, or quality gates. An incomplete objective has no aggregate
headline. A zero baseline aggregate has no percentage result.

## Alternatives Considered

- **Keep macro mean as the only result:** Preserves equal case weighting, but
  does not represent total resource movement for an additive workload.
- **Use raw attempt totals:** Represents observed benchmark spend, but silently
  replaces the configured trial reducer and makes the result depend on trial
  count and outliers.
- **Change the default globally:** Produces simpler configuration, but silently
  changes the meaning of existing benchmark definitions and immutable reports.

## Consequences

- More expensive baseline cases have proportionally more influence on the
  aggregate result; the selected case mix therefore defines the workload.
- Authors must choose the estimator that matches their question instead of
  treating the two estimators as interchangeable.
- Selecting the new mode changes the benchmark definition digest and requires
  a new revision and new report artifacts.
- JSON and CSV gain explicit aggregate fields while legacy macro fields remain
  compatible.
- HTML must identify whether its headline is a macro mean or a ratio of reduced
  sums.
