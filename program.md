# autoresearch

This repo uses the autoresearch pattern to improve underwriting heuristics against a fixed benchmark.

## Setup

To start a new run:

1. Create a fresh branch named `autoresearch/<tag>` from the current default branch state.
2. Read these files before changing anything:
   - `program.md`
   - `autoresearch.md`
   - `ARCHITECTURE.md`
   - `scripts/workflows/underwrite.ts`
   - `scripts/autoresearch/benchmark-underwrite.ts`
   - `data/autoresearch/underwrite-benchmark.json`
3. Initialize `results.tsv` if it does not exist. It must stay untracked by git and use this tab-separated header:

   ```text
   commit	composite_error	mean_revenue_mape	mean_adr_mape	mean_occupancy_mae	exact_case_matches	status	description
   ```

4. The first run is always the baseline:

   ```bash
   ./autoresearch.sh > run.log 2>&1
   ```

5. Extract the metrics with:

   ```bash
   rg '^METRIC ' run.log
   ```

## Scope

This autoresearch setup is deliberately narrow.

What you CAN change:

- `scripts/workflows/underwrite.ts`

What you CANNOT change:

- `data/autoresearch/underwrite-benchmark.json`
- `scripts/autoresearch/benchmark-underwrite.ts`
- `scripts/autoresearch/underwrite-benchmark.ts`
- `autoresearch.sh`
- `autoresearch.checks.sh`
- `data/market-knowledge.md`
- package dependencies
- any other workflow or data file

The goal is to keep one editable surface and one fixed evaluation harness, exactly like the original autoresearch setup.

## Metric

Run the benchmark with:

```bash
./autoresearch.sh
```

The primary metric is `composite_error`, and lower is better.

The benchmark computes:

```text
composite_error = mean(revenue_mape) + 0.5 * mean(adr_mape) + 2.0 * mean(occupancy_mae)
```

Secondary metrics are also printed:

- `mean_revenue_mape`
- `mean_adr_mape`
- `mean_occupancy_mae`
- `exact_case_matches`

## Loop

LOOP FOREVER until interrupted:

1. Look at the current branch and commit.
2. Edit only `scripts/workflows/underwrite.ts`.
3. Commit the experiment.
4. Run:

   ```bash
   ./autoresearch.sh > run.log 2>&1
   ```

5. Read the metrics:

   ```bash
   rg '^METRIC ' run.log
   ```

6. If the benchmark crashed, inspect the failure, fix obvious mistakes, and retry once or twice. If the idea is fundamentally broken, log it as `crash` and move on.
7. If `composite_error` improved, run correctness checks:

   ```bash
   ./autoresearch.checks.sh
   ```

8. Log the result to `results.tsv`.
9. Keep the commit only when:
   - `composite_error` is lower than the previous best, and
   - `./autoresearch.checks.sh` passes.
10. If the benchmark is flat or worse, discard the experiment and return to the prior best commit.

## Judgment

- Prefer simple heuristics over brittle special cases.
- Small wins that delete code are especially valuable.
- Do not overfit one case by adding opaque one-off hacks unless they generalize to a clear class of listings.
- Use the worst benchmark cases in `autoresearch.md` as idea sources, but optimize the full metric, not a single listing.
