# Review Reward

## Goal

This benchmark is the repo's v2 RL-style underwriting objective.

It no longer optimizes only for "match the final approved numbers." The target is now:

`estimate when the evidence supports an estimate, escalate when it does not, and minimize reviewer correction either way.`

That means the reward judges four things together:

- decision quality: `estimate` versus `escalate`
- projection quality when an estimate is warranted
- evidence coverage and provenance
- calibration against the accepted confidence level

## Frozen Data

The dataset lives at:

`data/autoresearch/review-reward-benchmark.json`

Each case stores:

- the listing-derived `UnderwriteInput`
- a frozen `referenceInitial` snapshot from the current first-pass underwrite
- the accepted terminal target from the review thread plus final eval JSON when available
- the accepted target decision:
  - `estimate`
  - `escalate`
- episode friction metadata:
  - extra versions
  - review-thread turns
  - adjustment count
  - clarify count
  - manual adjustment count
- evidence requirements inferred from the accepted target

The builder now prefers `data/eval-*.json` for accepted target fields like `region`, `confidence`, `methodology`, and comparable count, then falls back to thread context only when needed. That fixes the earlier bug where every target case was treated as unsupported because thread context did not reliably carry `region`.

## Reward

Primary metric:

```text
mean_reward = mean(
  decision_reward
  - friction_weight * (
      projection_loss
      + evidence_coverage_loss
      + calibration_loss
    )
)
```

Where:

- `decision_reward` is highest when the candidate makes the same `estimate` versus `escalate` decision as the accepted target
- `projection_loss` is applied only when both target and candidate are `estimate`
- `evidence_coverage_loss` penalizes missing provenance, missing comparable support when needed, and lack of `web_search` support on weak-evidence cases
- `calibration_loss` penalizes confidence mismatches and overconfident estimates on cases that should escalate
- `friction_weight` increases the impact of historically costly review episodes

Higher is better.

## Grounding

The benchmark expects underwriting output to carry explicit provenance in `evalData.grounding`.

Supported source kinds:

- `listing`
- `tool`
- `market_knowledge`
- `web_search`

Operational on-demand underwriting now runs through `scripts/workflows/underwrite-research.ts`, which performs live Brave Search queries when enabled and feeds those results into `groundingSources`.

The frozen benchmark remains offline and deterministic. That means:

- it can score whether grounded evidence is present
- it can reward `web_search` support when frozen inputs include it
- it does not perform live search during the benchmark run

So this benchmark now expresses the correct objective, but a future frozen research corpus would make tool-use optimization more direct inside the harness.

## Commands

Build or refresh the dataset intentionally:

```bash
npm run autoresearch:refresh-review-reward
```

Run the benchmark:

```bash
npm run autoresearch:review-reward
```
