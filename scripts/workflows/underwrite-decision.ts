import type { EvalDecision } from "../write-sheet-data.ts";

export type UnderwriteDecisionSnapshot = {
  comparableCount?: number;
  confidence?: string;
  methodology?: string;
  region?: string;
};

export function normalizeConfidence(value: string | undefined) {
  return String(value || "").trim().toLowerCase();
}

export function confidenceRank(value: string | undefined) {
  const normalized = normalizeConfidence(value);
  if (normalized === "very_low") return 0;
  if (normalized === "low") return 1;
  if (normalized === "medium") return 2;
  if (normalized === "high") return 3;
  return 1;
}

export function inferUnderwriteDecision(
  snapshot: UnderwriteDecisionSnapshot,
): { decision: EvalDecision; decisionReason: string } {
  const confidence = normalizeConfidence(snapshot.confidence);
  const comparableCount = Number(snapshot.comparableCount || 0);
  const methodology = String(snapshot.methodology || "").toLowerCase();
  const supportedMarket = Boolean(String(snapshot.region || "").trim());
  const lowConfidence = confidence === "low" || confidence === "very_low";
  const veryLowConfidence = confidence === "very_low";
  const offMarketSignals =
    methodology.includes("off-market") ||
    methodology.includes("lower-confidence") ||
    methodology.includes("not a park city comp-backed underwrite") ||
    methodology.includes("not a park city market-knowledge underwrite") ||
    methodology.includes("generic str heuristics") ||
    methodology.includes("manual correction");

  if (!supportedMarket && comparableCount === 0 && lowConfidence) {
    return { decision: "escalate", decisionReason: "unsupported_market_low_evidence" };
  }
  if (!supportedMarket && veryLowConfidence && comparableCount <= 1) {
    return { decision: "escalate", decisionReason: "very_low_confidence_requires_review" };
  }
  if (offMarketSignals && !supportedMarket && comparableCount === 0) {
    return { decision: "escalate", decisionReason: "off_market_without_comparable_support" };
  }
  if (supportedMarket) {
    return { decision: "estimate", decisionReason: "supported_market_estimate" };
  }
  return { decision: "estimate", decisionReason: "heuristic_estimate" };
}
