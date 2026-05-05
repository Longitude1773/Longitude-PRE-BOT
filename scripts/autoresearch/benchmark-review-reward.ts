import { fileURLToPath } from "node:url";

import { buildUnderwriteBundle } from "../workflows/underwrite.ts";
import {
  aggregateReviewRewardScores,
  loadReviewRewardDataset,
  metricLine,
  scoreReviewRewardCase,
  type ReviewRewardAggregate,
} from "./review-reward.ts";

export async function runReviewRewardBenchmark(top = 10) {
  const dataset = await loadReviewRewardDataset();
  const scores = [];

  for (const rewardCase of dataset.cases) {
    const bundle = await buildUnderwriteBundle(rewardCase.input);
    scores.push(scoreReviewRewardCase(rewardCase, bundle.evalData));
  }

  return {
    dataset,
    aggregate: aggregateReviewRewardScores(scores, top),
  };
}

function argValue(flag: string) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function printSummary(aggregate: ReviewRewardAggregate) {
  console.log(`Review reward cases: ${aggregate.cases}`);
  console.log(`Mean reward: ${aggregate.meanReward.toFixed(4)} (higher is better)`);
  console.log(`Mean reference reward: ${aggregate.meanReferenceReward.toFixed(4)}`);
  console.log(`Mean improvement over reference: ${aggregate.meanImprovementOverReference.toFixed(4)}`);
  console.log(`Mean decision reward: ${aggregate.meanDecisionReward.toFixed(4)}`);
  console.log(`Mean projection loss: ${aggregate.meanProjectionLoss.toFixed(4)}`);
  console.log(`Mean evidence coverage loss: ${aggregate.meanEvidenceCoverageLoss.toFixed(4)}`);
  console.log(`Mean calibration loss: ${aggregate.meanCalibrationLoss.toFixed(4)}`);
  console.log(`Correct decisions: ${aggregate.correctDecisions}/${aggregate.cases}`);
  console.log(`Correct estimates: ${aggregate.correctEstimates}/${aggregate.cases}`);
  console.log(`Correct escalations: ${aggregate.correctEscalations}/${aggregate.cases}`);
  console.log(`Exact projection matches: ${aggregate.exactProjectionMatches}/${aggregate.cases}`);
  console.log("");
  console.log("Lowest reward cases:");
  for (const item of aggregate.lowestRewardCases) {
    console.log(
      `- ${item.caseId}: reward=${item.reward.toFixed(4)} delta=${item.improvementOverReference.toFixed(4)} decision=${item.candidateDecision}->${item.targetDecision} projection=${item.projectionLoss.toFixed(4)} evidence=${item.evidenceCoverageLoss.toFixed(4)} calibration=${item.calibrationLoss.toFixed(4)} weight=${item.frictionWeight.toFixed(2)}`,
    );
  }
}

async function main() {
  const top = Number(argValue("--top") || "10");
  const quiet = process.argv.includes("--quiet");
  const json = process.argv.includes("--json");
  const result = await runReviewRewardBenchmark(top);

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (!quiet) {
    printSummary(result.aggregate);
  }

  console.log(metricLine("mean_reward", result.aggregate.meanReward));
  console.log(metricLine("mean_reference_reward", result.aggregate.meanReferenceReward));
  console.log(metricLine("mean_improvement_over_reference", result.aggregate.meanImprovementOverReference));
  console.log(metricLine("mean_decision_reward", result.aggregate.meanDecisionReward));
  console.log(metricLine("mean_projection_loss", result.aggregate.meanProjectionLoss));
  console.log(metricLine("mean_evidence_coverage_loss", result.aggregate.meanEvidenceCoverageLoss));
  console.log(metricLine("mean_calibration_loss", result.aggregate.meanCalibrationLoss));
  console.log(`METRIC correct_decisions=${result.aggregate.correctDecisions}`);
  console.log(`METRIC correct_estimates=${result.aggregate.correctEstimates}`);
  console.log(`METRIC correct_escalations=${result.aggregate.correctEscalations}`);
  console.log(`METRIC exact_projection_matches=${result.aggregate.exactProjectionMatches}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
