import type { EvalData } from "../write-sheet-data.ts";
import { applyStructuredAdjustment, parseAdjustmentRequest, type AdjustmentCategory } from "./lib.ts";
import { loadMarketKnowledge, type MarketKnowledge } from "./market-knowledge.ts";
import { applySeasonalityProfile, parseSeasonalityProfile } from "./seasonality.ts";
import { applyTierCorrection, parseTierCorrection, TierCorrectionError } from "./tier-correction.ts";

export type ReplyAdjustment =
  | { kind: "none" }
  | { kind: "clarify"; message: string }
  | { kind: "applied"; category: AdjustmentCategory; reasoning: string };

// True when an eval-thread reply asks for any change this module can make.
export function isAdjustmentReply(text: string) {
  if (parseTierCorrection(text) || parseSeasonalityProfile(text)) return true;
  const parsed = parseAdjustmentRequest(text);
  return parsed.kind === "ok" || parsed.kind === "clarify";
}

// Apply everything a review reply asks for, in a fixed order: tier
// re-underwrite, then a number ("set balanced to X"), then the seasonality
// curve, which only re-spreads the months and so must come last. Mutates data.
export async function applyReplyAdjustments(
  data: EvalData,
  text: string,
  loadKnowledge: () => Promise<MarketKnowledge> = loadMarketKnowledge,
): Promise<ReplyAdjustment> {
  const tier = parseTierCorrection(text);
  const season = parseSeasonalityProfile(text);
  const parsed = parseAdjustmentRequest(text);
  if (tier?.kind === "clarify") return tier;
  if (season?.kind === "clarify") return season;

  const reasons: string[] = [];
  let category: AdjustmentCategory | undefined;

  if (tier?.kind === "ok") {
    try {
      reasons.push(applyTierCorrection(data, tier.tier, await loadKnowledge(), { keepNumbers: tier.keepNumbers }).reasoning);
    } catch (error) {
      if (error instanceof TierCorrectionError) return { kind: "clarify", message: error.message };
      throw error;
    }
    category = "classification-tier";
  }

  if (parsed.kind === "ok") {
    // With a tier change, skip the generic "higher tier" uplift: it would
    // double-count the tier.
    if (!tier || parsed.spec.category !== "general-direction") {
      reasons.push(applyStructuredAdjustment(data, parsed.spec).reasoning);
      category ??= parsed.spec.category;
    }
  } else if (parsed.kind === "clarify" && !tier && !season) {
    return parsed;
  }

  if (season?.kind === "ok") {
    reasons.push(applySeasonalityProfile(data, season.profile).reasoning);
    category ??= "seasonality";
  }

  if (!category) return { kind: "none" };
  return { kind: "applied", category, reasoning: reasons.join(" ") };
}
