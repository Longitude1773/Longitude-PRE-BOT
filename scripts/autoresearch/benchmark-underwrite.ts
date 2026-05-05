import { fileURLToPath } from "node:url";

import { buildUnderwriteBundle } from "../workflows/underwrite.ts";
import {
  aggregateCaseMetrics,
  computeCaseMetrics,
  loadBenchmarkDataset,
  metricLine,
  type BenchmarkAggregate,
} from "./underwrite-benchmark.ts";

export async function runBenchmark(top = 10) {
  const dataset = await loadBenchmarkDataset();
  const caseMetrics = [];

  for (const benchmarkCase of dataset.cases) {
    const bundle = await buildUnderwriteBundle(benchmarkCase.input);
    if (!bundle.evalData.projections) {
      throw new Error(`Missing projections for benchmark case ${benchmarkCase.id}.`);
    }
    caseMetrics.push(
      computeCaseMetrics(
        benchmarkCase.id,
        bundle.evalData.projections,
        benchmarkCase.target.projections,
      ),
    );
  }

  return {
    dataset,
    aggregate: aggregateCaseMetrics(caseMetrics, top),
  };
}

function argValue(flag: string) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function printSummary(aggregate: BenchmarkAggregate) {
  console.log(`Underwrite benchmark cases: ${aggregate.cases}`);
  console.log(`Exact case matches: ${aggregate.exactMatches}/${aggregate.cases}`);
  console.log(`Composite error: ${aggregate.compositeError.toFixed(4)} (lower is better)`);
  console.log(`Mean revenue MAPE: ${aggregate.meanRevenueMape.toFixed(4)}`);
  console.log(`Mean ADR MAPE: ${aggregate.meanAdrMape.toFixed(4)}`);
  console.log(`Mean occupancy MAE: ${aggregate.meanOccupancyMae.toFixed(4)}`);
  console.log("");
  console.log("Worst cases:");
  for (const item of aggregate.worstCases) {
    console.log(
      `- ${item.caseId}: composite=${item.compositeError.toFixed(4)} revenue=${item.revenueMape.toFixed(4)} adr=${item.adrMape.toFixed(4)} occ=${item.occupancyMae.toFixed(4)}`,
    );
  }
}

async function main() {
  const top = Number(argValue("--top") || "10");
  const quiet = process.argv.includes("--quiet");
  const json = process.argv.includes("--json");

  const result = await runBenchmark(top);

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (!quiet) {
    printSummary(result.aggregate);
  }

  console.log(metricLine("composite_error", result.aggregate.compositeError));
  console.log(metricLine("mean_revenue_mape", result.aggregate.meanRevenueMape));
  console.log(metricLine("mean_adr_mape", result.aggregate.meanAdrMape));
  console.log(metricLine("mean_occupancy_mae", result.aggregate.meanOccupancyMae));
  console.log(`METRIC exact_case_matches=${result.aggregate.exactMatches}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
