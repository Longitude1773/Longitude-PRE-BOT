import type { EvalData } from "../write-sheet-data.ts";
import { asString, deriveSpreadScenarios, fmtCurrency, roundProjectionRevenue, SCENARIO_SPREAD } from "./lib.ts";
import {
  projectMedium,
  TIER_DISPLAY_NAME,
  TIERS,
  unwrapAmenities,
  type Classification,
  type LuxuryTier,
  type MarketKnowledge,
} from "./market-knowledge.ts";
import { buildScenario, buildSupportedMethodology } from "./underwrite.ts";

export type TierCorrectionParse =
  | { kind: "ok"; tier: LuxuryTier; keepNumbers: boolean }
  | { kind: "clarify"; message: string };

const TIER_MENTION = /\btier[\s-]*([1-4])\b/gi;
// A tier named right after one of these is the one being corrected away from:
// "not tier 1", "from tier 1 to tier 2", "tier 2 instead of tier 1".
const NEGATED_PREFIX = /(?:\bnot|n['’]t|\bfrom|\binstead\s+of|\brather\s+than|\bwas|\bnever)\s+(?:an?\s+)?$/i;
const QUESTION_OPENER = /^\s*(?:why|how|what|is|isn['’]t|does|did|are|can|could|should|would|was)\b/i;
const KEEP_NUMBERS =
  /\b(?:numbers?|projections?|revenue)\b[\s\S]{0,30}?\b(?:look|looks|are|is|seem|seems)\s+(?:good|right|correct|fine|ok|okay)\b|\b(?:keep|leave)\s+(?:the\s+)?(?:numbers|projections|revenue)\b|\bdon['’]?t\s+change\s+(?:the\s+)?(?:numbers|projections|revenue)\b/i;
const NARRATIVE_REVENUE = /(Balanced revenue comes in around )\$[\d,]+/;
const REVIEWER_NOTE = /\s*Reviewer reclassified this property to Tier \d \([^)]+\)[^.]*\./g;

// Returns null when the text names no tier, so the caller falls through to the
// other reply rules. "Is this tier 2?" is a question, not a correction.
export function parseTierCorrection(text: string): TierCorrectionParse | null {
  const mentions = [...text.matchAll(TIER_MENTION)];
  if (mentions.length === 0) return null;
  if (text.includes("?") && QUESTION_OPENER.test(text)) return null;

  const asserted = new Set<LuxuryTier>();
  for (const match of mentions) {
    const prefix = text.slice(Math.max(0, (match.index ?? 0) - 20), match.index);
    if (NEGATED_PREFIX.test(prefix)) continue;
    asserted.add(`tier-${match[1]}` as LuxuryTier);
  }

  if (asserted.size === 1) {
    return { kind: "ok", tier: [...asserted][0], keepNumbers: KEEP_NUMBERS.test(text) };
  }
  return { kind: "clarify", message: "Which tier should this be: Tier 1 (Standard), 2 (Premium), 3 (Luxury), or 4 (Ultra-Luxury)?" };
}

export class TierCorrectionError extends Error {}

function tierName(tier: string) {
  return TIERS.includes(tier as LuxuryTier) ? TIER_DISPLAY_NAME[tier as LuxuryTier] : "unclassified";
}

// The Promontory sub-market only exists for Tier 3-4 (see classify()); a
// downgrade has to move back to plain East Basin or the grid lookup is wrong.
function subMarketForTier(subMarket: string, tier: LuxuryTier, knowledge: MarketKnowledge) {
  if (subMarket === "East Basin (Promontory Tier 3-4)" && (tier === "tier-1" || tier === "tier-2") && knowledge.subMarkets["East Basin"]) {
    return "East Basin";
  }
  return subMarket;
}

// Reclassify to the reviewer's tier and re-underwrite Balanced from that tier's
// grid cell, the same way a fresh eval is built (projectMedium → seasonal
// builder → locked spread). With keepNumbers, only the classification changes.
export function applyTierCorrection(
  data: EvalData,
  tier: LuxuryTier,
  knowledge: MarketKnowledge,
  options: { keepNumbers?: boolean } = {},
) {
  const priorTier = asString(data.luxuryTier);
  const subMarket = subMarketForTier(asString(data.subMarket), tier, knowledge);
  if (!knowledge.subMarkets[subMarket]) {
    throw new TierCorrectionError(
      `I can't re-underwrite by tier because this eval has no recognized sub-market${data.subMarket ? ` ("${data.subMarket}")` : ""}. Tell me the sub-market and I'll redo it.`,
    );
  }

  const classification: Classification = {
    market: knowledge.subMarkets[subMarket].market || asString(data.market),
    subMarket,
    luxuryTier: tier,
    tierConfidence: "high",
    amenities: unwrapAmenities(data.amenities),
  };
  data.market = classification.market;
  data.subMarket = subMarket;
  data.luxuryTier = tier;
  data.tierConfidence = "high";
  delete data.borderlineWith;

  const change = priorTier === tier ? `Confirmed ${tierName(tier)}` : `Reclassified from ${tierName(priorTier)} to ${tierName(tier)}`;
  if (options.keepNumbers || !data.projections) {
    return { data, reasoning: `${change}; projections left unchanged at the reviewer's request.` };
  }

  const priorMedium = data.projections.medium;
  const bedrooms = Number.isFinite(data.bedrooms) ? Number(data.bedrooms) : 2;
  const projection = projectMedium(bedrooms, knowledge, classification);
  data.projections = deriveSpreadScenarios(buildScenario(projection.adr, projection.occupancy, 1, 0));
  roundProjectionRevenue(data);
  const medium = data.projections.medium;

  // Synthetic market-knowledge benchmarks are scaled off Balanced; keep them in
  // step. Vendor comps (AirDNA etc.) are real data and stay as they were.
  const revenueRatio = priorMedium.revenue ? medium.revenue / priorMedium.revenue : 1;
  const adrRatio = priorMedium.adr ? medium.adr / priorMedium.adr : 1;
  data.comparables = (data.comparables || []).map((comp) =>
    comp.source === "market-knowledge"
      ? {
          ...comp,
          annualRevenue: Math.round((comp.annualRevenue ?? 0) * revenueRatio),
          averageDailyRate: Math.round((comp.averageDailyRate ?? 0) * adrRatio),
        }
      : comp,
  );

  const methodology = buildSupportedMethodology(knowledge, classification, projection, {
    price: data.price,
    squareFootage: data.squareFootage,
  } as Parameters<typeof buildSupportedMethodology>[3]);
  data.methodology = methodology.replace(
    /^Tier: .*$/m,
    `Tier: ${tierName(tier)} — set by the reviewer in the Slack thread${priorTier && priorTier !== tier ? ` (model had ${tierName(priorTier)})` : ""}.`,
  );

  const reviewerNote = ` Reviewer reclassified this property to ${tierName(tier)}; projections were re-underwritten from that tier's grid cell.`;
  data.narrative =
    asString(data.narrative).replace(REVIEWER_NOTE, "").replace(NARRATIVE_REVENUE, `$1${fmtCurrency(medium.revenue)}`).trim() + reviewerNote;

  const proxyNotes = projection.methodologyNotes.filter((note) => /proxy|generic baseline/i.test(note));
  const reasoning = [
    `${change} and re-underwrote Balanced from the ${subMarket} ${bedrooms === 0 ? "studio" : `${bedrooms}BR`} ${tierName(tier)} grid: ` +
      `${fmtCurrency(priorMedium.revenue)} → ${fmtCurrency(medium.revenue)}. ` +
      `Optimized and Conservative re-derived (×${SCENARIO_SPREAD.OPTIMIZED} / ×${SCENARIO_SPREAD.CONSERVATIVE}).`,
    ...proxyNotes,
  ].join(" ");

  return { data, reasoning };
}
