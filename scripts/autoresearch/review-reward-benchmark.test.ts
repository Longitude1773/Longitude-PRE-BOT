import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";

import type { EvalData } from "../write-sheet-data.ts";
import { runReviewRewardBenchmark } from "./benchmark-review-reward.ts";
import { buildReviewRewardBenchmark } from "./build-review-reward-benchmark.ts";
import { reviewRewardDatasetPath, scoreReviewRewardCase, type ReviewRewardCase } from "./review-reward.ts";

function evalProjection(revenue: number, occupancy: number, adr: number) {
  return {
    revenue,
    occupancy,
    adr,
    monthly: [],
  };
}

test("review reward benchmark corpus loads and produces finite metrics", async () => {
  if (!existsSync(reviewRewardDatasetPath)) {
    await buildReviewRewardBenchmark();
  }

  const result = await runReviewRewardBenchmark(3);

  assert.ok(result.dataset.cases.length >= 10);
  assert.ok(result.aggregate.cases >= 10);
  assert.ok(Number.isFinite(result.aggregate.meanReward));
  assert.ok(Number.isFinite(result.aggregate.meanReferenceReward));
  assert.ok(Number.isFinite(result.aggregate.meanImprovementOverReference));
  assert.ok(Number.isFinite(result.aggregate.meanDecisionReward));
  assert.ok(Number.isFinite(result.aggregate.meanProjectionLoss));
  assert.ok(Number.isFinite(result.aggregate.meanEvidenceCoverageLoss));
  assert.ok(Number.isFinite(result.aggregate.meanCalibrationLoss));
  assert.ok(result.aggregate.correctDecisions >= 0);
  assert.ok(result.aggregate.lowestRewardCases.length <= 3);
});

test("review reward prefers correct escalation on weak-evidence cases", () => {
  const rewardCase: ReviewRewardCase = {
    id: "synthetic-escalate",
    threadTs: "synthetic",
    sourceListingPath: "data/listing-synthetic.json",
    sourceThreadContextPath: "data/inbox/thread-context/synthetic.json",
    input: {
      listingId: "synthetic-escalate",
      listingSource: "zillow_on_demand",
      address: "123 Example Rd, Unknown, UT 84000",
      listingUrl: "https://example.com/listing",
      skipMarketGate: true,
    },
    referenceInitial: {
      region: "",
      confidence: "low",
      methodology: "Off-market heuristic estimate without market support.",
      decision: "estimate",
      decisionReason: "heuristic_estimate",
      projections: {
        high: { revenue: 182000, occupancy: 0.62, adr: 805 },
        medium: { revenue: 150000, occupancy: 0.54, adr: 760 },
        low: { revenue: 108000, occupancy: 0.42, adr: 703 },
      },
      comparableCount: 0,
      grounding: {
        summary: "source listing; listing acquisition tool",
        sources: [
          { kind: "listing", label: "source listing" },
          { kind: "tool", label: "listing acquisition tool", tool: "zillow_scrape" },
        ],
      },
    },
    approvedTarget: {
      status: "approved",
      region: "",
      confidence: "very_low",
      methodology: "Off-market manual correction with no comparable support.",
      decision: "escalate",
      decisionReason: "unsupported_market_low_evidence",
      projections: {
        high: { revenue: 182000, occupancy: 0.62, adr: 805 },
        medium: { revenue: 150000, occupancy: 0.54, adr: 760 },
        low: { revenue: 108000, occupancy: 0.42, adr: 703 },
      },
      comparableCount: 0,
      evidenceRequirements: {
        minComparableCount: 0,
        minSourceCount: 3,
        requiredKinds: ["listing", "tool"],
        requireGroundingSummary: true,
        requireListingUrl: true,
        preferWebSearch: true,
      },
    },
    episode: {
      finalVersion: 2,
      extraVersions: 1,
      threadReplyTurns: 1,
      adjustmentCount: 1,
      clarifyCount: 0,
      questionCount: 1,
      manualAdjustmentCount: 1,
    },
  };

  const estimateCandidate: EvalData = {
    address: rewardCase.input.address,
    mlsNumber: rewardCase.input.listingId,
    listingUrl: rewardCase.input.listingUrl,
    listingSource: rewardCase.input.listingSource,
    narrative: "Heuristic estimate",
    methodology: "Generic STR heuristics without market-specific support.",
    confidence: "medium",
    decision: "estimate",
    decisionReason: "heuristic_estimate",
    projections: {
      high: evalProjection(182000, 0.62, 805),
      medium: evalProjection(150000, 0.54, 760),
      low: evalProjection(108000, 0.42, 703),
    },
    comparables: [],
    grounding: {
      summary: "source listing; listing acquisition tool",
      sources: [
        { kind: "listing", label: "source listing" },
        { kind: "tool", label: "listing acquisition tool", tool: "zillow_scrape" },
      ],
    },
  };

  const escalateCandidate: EvalData = {
    ...estimateCandidate,
    confidence: "low",
    decision: "escalate",
    decisionReason: "unsupported_market_low_evidence",
    grounding: {
      summary: "source listing; listing acquisition tool; live market search",
      sources: [
        { kind: "listing", label: "source listing" },
        { kind: "tool", label: "listing acquisition tool", tool: "zillow_scrape" },
        { kind: "web_search", label: "live market search", url: "https://example.com/search" },
      ],
    },
  };

  const estimateScore = scoreReviewRewardCase(rewardCase, estimateCandidate);
  const escalateScore = scoreReviewRewardCase(rewardCase, escalateCandidate);

  assert.equal(estimateScore.correctDecision, false);
  assert.equal(escalateScore.correctEscalation, true);
  assert.ok(escalateScore.reward > estimateScore.reward);
});
