import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { EvalData, EvalDecision, EvalGrounding, EvalGroundingSource } from "../write-sheet-data.ts";
import { confidenceRank, inferUnderwriteDecision, normalizeConfidence } from "../workflows/underwrite-decision.ts";
import type { UnderwriteInput } from "../workflows/underwrite.ts";

export type RewardProjection = {
  revenue: number;
  occupancy: number;
  adr: number;
};

export type RewardProjectionSet = {
  high: RewardProjection;
  medium: RewardProjection;
  low: RewardProjection;
};

export type RewardEvidenceRequirements = {
  minComparableCount: number;
  minSourceCount: number;
  requiredKinds: string[];
  requireGroundingSummary: boolean;
  requireListingUrl: boolean;
  preferWebSearch: boolean;
};

export type RewardEpisodeMetadata = {
  finalVersion: number;
  extraVersions: number;
  threadReplyTurns: number;
  adjustmentCount: number;
  clarifyCount: number;
  questionCount: number;
  manualAdjustmentCount: number;
};

type RewardSnapshotTarget = {
  region?: string;
  confidence?: string;
  methodology?: string;
  decision: EvalDecision;
  decisionReason: string;
};

export type ReviewRewardCase = {
  id: string;
  threadTs: string;
  sourceListingPath: string;
  sourceThreadContextPath: string;
  input: UnderwriteInput;
  referenceInitial: RewardSnapshotTarget & {
    projections: RewardProjectionSet;
    comparableCount: number;
    grounding?: EvalGrounding;
  };
  approvedTarget: RewardSnapshotTarget & {
    status: "approved" | "dismissed";
    projections: RewardProjectionSet;
    comparableCount: number;
    evidenceRequirements: RewardEvidenceRequirements;
  };
  episode: RewardEpisodeMetadata;
};

export type ReviewRewardDataset = {
  version: number;
  generatedAt: string;
  description: string;
  metric: {
    name: string;
    direction: "higher";
    formula: string;
  };
  exclusions: Array<{
    id: string;
    threadTs?: string;
    reason: string;
  }>;
  cases: ReviewRewardCase[];
};

type CandidateSnapshot = {
  projections: RewardProjectionSet;
  comparableCount: number;
  grounding?: EvalGrounding;
  listingUrl?: string;
  confidence?: string;
  region?: string;
  methodology?: string;
  decision?: EvalDecision;
};

export type ReviewRewardCaseScore = {
  caseId: string;
  reward: number;
  referenceReward: number;
  improvementOverReference: number;
  targetDecision: EvalDecision;
  candidateDecision: EvalDecision;
  decisionReward: number;
  projectionLoss: number;
  evidenceCoverageLoss: number;
  calibrationLoss: number;
  frictionWeight: number;
  exactProjectionMatch: boolean;
  correctDecision: boolean;
  correctEstimate: boolean;
  correctEscalation: boolean;
};

export type ReviewRewardAggregate = {
  cases: number;
  meanReward: number;
  meanReferenceReward: number;
  meanImprovementOverReference: number;
  meanDecisionReward: number;
  meanProjectionLoss: number;
  meanEvidenceCoverageLoss: number;
  meanCalibrationLoss: number;
  exactProjectionMatches: number;
  correctDecisions: number;
  correctEstimates: number;
  correctEscalations: number;
  lowestRewardCases: ReviewRewardCaseScore[];
};

export const reviewRewardDatasetPath = resolve(import.meta.dirname, "../../data/autoresearch/review-reward-benchmark.json");

function avg(values: number[]) {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function relativeError(actual: number, predicted: number) {
  return Math.abs(predicted - actual) / Math.max(1, Math.abs(actual));
}

function projectionDistance(predicted: RewardProjectionSet, target: RewardProjectionSet) {
  const weights = { high: 0.2, medium: 0.6, low: 0.2 } as const;
  let total = 0;
  for (const scenario of ["high", "medium", "low"] as const) {
    const predictedScenario = predicted[scenario];
    const targetScenario = target[scenario];
    const revenueLoss = relativeError(targetScenario.revenue, predictedScenario.revenue);
    const adrLoss = relativeError(targetScenario.adr, predictedScenario.adr);
    const occupancyLoss = Math.abs(targetScenario.occupancy - predictedScenario.occupancy);
    total += weights[scenario] * (revenueLoss + (0.35 * adrLoss) + (2.0 * occupancyLoss));
  }
  return total;
}

function groundingKinds(sources: EvalGroundingSource[]) {
  return new Set(sources.map((source) => String(source.kind || "").trim()).filter(Boolean));
}

function evidenceCoverageLoss(snapshot: CandidateSnapshot, requirements: RewardEvidenceRequirements) {
  const sources = snapshot.grounding?.sources || [];
  const kinds = groundingKinds(sources);
  let loss = 0;

  if (requirements.requireGroundingSummary && !String(snapshot.grounding?.summary || "").trim()) {
    loss += 0.05;
  }
  if (requirements.requireListingUrl && !String(snapshot.listingUrl || "").trim()) {
    loss += 0.05;
  }
  if (sources.length < requirements.minSourceCount) {
    loss += 0.04 * (requirements.minSourceCount - sources.length);
  }
  for (const kind of requirements.requiredKinds) {
    if (!kinds.has(kind)) {
      loss += kind === "market_knowledge" ? 0.12 : 0.08;
    }
  }
  if (requirements.minComparableCount > 0 && snapshot.comparableCount < requirements.minComparableCount) {
    loss += 0.12 * ((requirements.minComparableCount - snapshot.comparableCount) / requirements.minComparableCount);
  }
  if (requirements.preferWebSearch && !kinds.has("web_search")) {
    loss += 0.08;
  }

  return loss;
}

function episodeWeight(episode: RewardEpisodeMetadata) {
  return 1
    + (0.15 * episode.extraVersions)
    + (0.05 * episode.threadReplyTurns)
    + (0.10 * episode.clarifyCount)
    + (0.15 * episode.manualAdjustmentCount);
}

function asSnapshot(data: {
  projections: RewardProjectionSet;
  comparableCount: number;
  grounding?: EvalGrounding;
  listingUrl?: string;
  confidence?: string;
  region?: string;
  methodology?: string;
  decision?: EvalDecision;
}) {
  return {
    projections: data.projections,
    comparableCount: data.comparableCount,
    grounding: data.grounding,
    listingUrl: data.listingUrl,
    confidence: data.confidence,
    region: data.region,
    methodology: data.methodology,
    decision: data.decision,
  } satisfies CandidateSnapshot;
}

function decisionForSnapshot(snapshot: CandidateSnapshot) {
  if (snapshot.decision) return snapshot.decision;
  return inferUnderwriteDecision({
    comparableCount: snapshot.comparableCount,
    confidence: snapshot.confidence,
    methodology: snapshot.methodology,
    region: snapshot.region,
  }).decision;
}

function decisionReward(targetDecision: EvalDecision, candidateDecision: EvalDecision) {
  if (targetDecision === candidateDecision) {
    return targetDecision === "escalate" ? 1.1 : 1.0;
  }
  return targetDecision === "escalate" ? -1.0 : -0.35;
}

function calibrationLoss(snapshot: CandidateSnapshot, rewardCase: ReviewRewardCase, candidateDecision: EvalDecision) {
  const targetDecision = rewardCase.approvedTarget.decision;
  const targetConfidence = normalizeConfidence(rewardCase.approvedTarget.confidence);
  const candidateConfidence = normalizeConfidence(snapshot.confidence);
  let loss = 0;

  if (targetConfidence) {
    loss += 0.08 * Math.abs(confidenceRank(candidateConfidence) - confidenceRank(targetConfidence));
  }

  if (candidateDecision === "escalate" && confidenceRank(candidateConfidence) > confidenceRank("low")) {
    loss += 0.08 * (confidenceRank(candidateConfidence) - confidenceRank("low"));
  }

  if (candidateDecision === "estimate" && targetDecision === "escalate") {
    loss += 0.12 * Math.max(0, confidenceRank(candidateConfidence) - confidenceRank("low"));
  }

  return loss;
}

function exactProjectionMatch(
  predicted: RewardProjectionSet,
  target: RewardProjectionSet,
  targetDecision: EvalDecision,
  candidateDecision: EvalDecision,
) {
  if (targetDecision !== "estimate" || candidateDecision !== "estimate") {
    return false;
  }

  return (["high", "medium", "low"] as const).every((scenario) =>
    predicted[scenario].revenue === target[scenario].revenue &&
    predicted[scenario].adr === target[scenario].adr &&
    predicted[scenario].occupancy === target[scenario].occupancy,
  );
}

function rewardForSnapshot(
  snapshot: CandidateSnapshot,
  rewardCase: ReviewRewardCase,
) {
  const targetDecision = rewardCase.approvedTarget.decision;
  const candidateDecision = decisionForSnapshot(snapshot);
  const decisionRewardValue = decisionReward(targetDecision, candidateDecision);
  const projectionLossValue =
    targetDecision === "estimate" && candidateDecision === "estimate"
      ? projectionDistance(snapshot.projections, rewardCase.approvedTarget.projections)
      : 0;
  const evidenceCoverageLossValue = evidenceCoverageLoss(snapshot, rewardCase.approvedTarget.evidenceRequirements);
  const calibrationLossValue = calibrationLoss(snapshot, rewardCase, candidateDecision);
  const frictionWeight = episodeWeight(rewardCase.episode);

  return {
    reward: decisionRewardValue - (frictionWeight * (projectionLossValue + evidenceCoverageLossValue + calibrationLossValue)),
    targetDecision,
    candidateDecision,
    decisionReward: decisionRewardValue,
    projectionLoss: projectionLossValue,
    evidenceCoverageLoss: evidenceCoverageLossValue,
    calibrationLoss: calibrationLossValue,
    frictionWeight,
  };
}

export async function loadReviewRewardDataset(path = reviewRewardDatasetPath) {
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw) as ReviewRewardDataset;
}

export function scoreReviewRewardCase(
  rewardCase: ReviewRewardCase,
  candidate: EvalData,
): ReviewRewardCaseScore {
  if (!candidate.projections) {
    throw new Error(`Missing projections for review reward case ${rewardCase.id}.`);
  }

  const candidateSnapshot = asSnapshot({
    projections: candidate.projections,
    comparableCount: candidate.comparables?.length || 0,
    grounding: candidate.grounding,
    listingUrl: candidate.listingUrl,
    confidence: candidate.confidence,
    region: candidate.region,
    methodology: candidate.methodology,
    decision: candidate.decision,
  });
  const referenceSnapshot = asSnapshot({
    projections: rewardCase.referenceInitial.projections,
    comparableCount: rewardCase.referenceInitial.comparableCount,
    grounding: rewardCase.referenceInitial.grounding,
    listingUrl: rewardCase.input.listingUrl,
    confidence: rewardCase.referenceInitial.confidence,
    region: rewardCase.referenceInitial.region,
    methodology: rewardCase.referenceInitial.methodology,
    decision: rewardCase.referenceInitial.decision,
  });

  const candidateReward = rewardForSnapshot(candidateSnapshot, rewardCase);
  const referenceReward = rewardForSnapshot(referenceSnapshot, rewardCase);
  const correctDecision = candidateReward.targetDecision === candidateReward.candidateDecision;

  return {
    caseId: rewardCase.id,
    reward: candidateReward.reward,
    referenceReward: referenceReward.reward,
    improvementOverReference: candidateReward.reward - referenceReward.reward,
    targetDecision: candidateReward.targetDecision,
    candidateDecision: candidateReward.candidateDecision,
    decisionReward: candidateReward.decisionReward,
    projectionLoss: candidateReward.projectionLoss,
    evidenceCoverageLoss: candidateReward.evidenceCoverageLoss,
    calibrationLoss: candidateReward.calibrationLoss,
    frictionWeight: candidateReward.frictionWeight,
    exactProjectionMatch: exactProjectionMatch(
      candidate.projections,
      rewardCase.approvedTarget.projections,
      candidateReward.targetDecision,
      candidateReward.candidateDecision,
    ),
    correctDecision,
    correctEstimate: correctDecision && candidateReward.targetDecision === "estimate",
    correctEscalation: correctDecision && candidateReward.targetDecision === "escalate",
  };
}

export function aggregateReviewRewardScores(
  scores: ReviewRewardCaseScore[],
  top = 10,
): ReviewRewardAggregate {
  return {
    cases: scores.length,
    meanReward: avg(scores.map((score) => score.reward)),
    meanReferenceReward: avg(scores.map((score) => score.referenceReward)),
    meanImprovementOverReference: avg(scores.map((score) => score.improvementOverReference)),
    meanDecisionReward: avg(scores.map((score) => score.decisionReward)),
    meanProjectionLoss: avg(scores.map((score) => score.projectionLoss)),
    meanEvidenceCoverageLoss: avg(scores.map((score) => score.evidenceCoverageLoss)),
    meanCalibrationLoss: avg(scores.map((score) => score.calibrationLoss)),
    exactProjectionMatches: scores.filter((score) => score.exactProjectionMatch).length,
    correctDecisions: scores.filter((score) => score.correctDecision).length,
    correctEstimates: scores.filter((score) => score.correctEstimate).length,
    correctEscalations: scores.filter((score) => score.correctEscalation).length,
    lowestRewardCases: [...scores]
      .sort((a, b) => a.reward - b.reward)
      .slice(0, top),
  };
}

export function metricLine(name: string, value: number) {
  return `METRIC ${name}=${value.toFixed(6)}`;
}
