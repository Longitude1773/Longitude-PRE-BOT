# STR Underwrite Autoresearch

## Objective

Reduce divergence between `scripts/workflows/underwrite.ts` and the repo's canonical evaluation artifacts, using a fixed benchmark corpus derived from checked-in `data/listing-*.json` and `data/eval-*.json` pairs.

Only `scripts/workflows/underwrite.ts` is in scope for autonomous experiments.

## Commands

Primary benchmark:

```bash
./autoresearch.sh
```

Backpressure checks:

```bash
./autoresearch.checks.sh
```

Refresh the frozen benchmark corpus intentionally, outside the experiment loop:

```bash
npm run autoresearch:refresh-benchmark
```

Review-friction / RL-style benchmark:

```bash
npm run autoresearch:review-reward
```

## Benchmark

- Dataset: `data/autoresearch/underwrite-benchmark.json`
- Cases: 41
- Exclusions:
  - `12501851`: manual thread adjustment, not a pure automatic underwrite target
  - `12601192`: missing listing/eval pair
  - `ZPID-122537467`: malformed Zillow rent Zestimate input
- Primary metric:

  ```text
  composite_error = mean(revenue_mape) + 0.5 * mean(adr_mape) + 2.0 * mean(occupancy_mae)
  ```

## Baseline

Baseline captured on 2026-04-16 from the current repo state:

- `composite_error = 0.126826`
- `mean_revenue_mape = 0.079682`
- `mean_adr_mape = 0.064434`
- `mean_occupancy_mae = 0.007463`
- `exact_case_matches = 31 / 41`

## Known Hotspots

The current worst misses are concentrated in a few recognizable buckets:

- `12601387`: small 1BR Park City Core condo overestimation
- `12601380`: Park Meadows / Cove at Eagle Mountain case with lower target ADR and occupancy than the current heuristic
- `12601288`: Lower Deer Valley 2BR/2BA case with materially lower target ADR
- `12601393`: Lower Deer Valley case with downshifted revenue/ADR relative to the current baseline
- `ZPID-439589886`: lower-confidence off-market Zillow case where occupancy and revenue are both too high
- `12600268`: ultra-premium Deer Valley case where occupancy is too optimistic

## Notes

- The benchmark is intentionally frozen. Do not modify it during the experiment loop.
- The current corpus includes some imperfect listing inputs. That is acceptable here because the benchmark is measuring end-to-end underwriting behavior against canonical repo artifacts, not idealized source data.
- Favor changes that improve the metric by capturing listing classes better, not by memorizing individual IDs.
- `review-reward.md` defines the better RL-style objective: get closer to approved final outcomes while reducing review friction and preserving grounding.
