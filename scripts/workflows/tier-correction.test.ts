import assert from "node:assert/strict";
import test from "node:test";

import type { EvalData } from "../write-sheet-data.ts";
import { applyStructuredAdjustment, parseAdjustmentRequest, SCENARIO_SPREAD } from "./lib.ts";
import { loadMarketKnowledge, projectMedium } from "./market-knowledge.ts";
import { applyTierCorrection, parseTierCorrection, TierCorrectionError } from "./tier-correction.ts";
import { buildScenario } from "./underwrite.ts";

function buildEvalData(overrides: Partial<EvalData> = {}): EvalData {
  const medium = buildScenario(300, 0.5, 1, 0);
  return {
    mlsNumber: "12604953",
    address: "2000 Prospector Avenue 208, Park City, UT 84060",
    price: 385000,
    bedrooms: 1,
    bathrooms: 1,
    squareFootage: 520,
    market: "Park City",
    subMarket: "Old Town / Main St",
    luxuryTier: "tier-2",
    tierConfidence: "borderline",
    borderlineWith: "tier-1",
    amenities: { primary: [], secondary: [] },
    narrative: "Condominium underwritten off the baseline. Balanced revenue comes in around $46,773 gross annually before management and operating costs.",
    methodology: "A premium-tier pricing assumption was used.",
    projections: { high: medium, medium, low: medium },
    comparables: [
      { source: "market-knowledge", title: "benchmark", address: "x", bedrooms: 1, bathrooms: 1, annualRevenue: medium.revenue, occupancyRate: 0.5, averageDailyRate: 300, distanceMiles: 0.3 },
      { source: "airdna", title: "real comp", address: "y", bedrooms: 1, bathrooms: 1, annualRevenue: 41000, occupancyRate: 0.6, averageDailyRate: 250, distanceMiles: 0.8 },
    ],
    ...overrides,
  };
}

test("parses the tier corrections reviewers actually send", () => {
  const cases: Array<[string, string]> = [
    ["this is tier 1. Set balanace to 27,400", "tier-1"],
    ["this is tier 2. recalibrate", "tier-2"],
    ["this is a tier 2 property in East Basin", "tier-2"],
    ["Tier-3", "tier-3"],
    ["should be tier 4", "tier-4"],
    ["not tier 1, it's tier 2", "tier-2"],
    ["move it from tier 1 to tier 3", "tier-3"],
    ["tier 2 instead of tier 3", "tier-2"],
  ];
  for (const [text, tier] of cases) {
    const parsed = parseTierCorrection(text);
    assert.equal(parsed?.kind, "ok", text);
    if (parsed?.kind === "ok") assert.equal(parsed.tier, tier, text);
  }
});

test("leaves questions and non-tier replies to the other rules", () => {
  assert.equal(parseTierCorrection("why is this tier 1?"), null);
  assert.equal(parseTierCorrection("Is this tier 2?"), null);
  assert.equal(parseTierCorrection("bump balanced to $50k"), null);
  assert.equal(parseTierCorrection("premium finishes, higher tier"), null);
});

test("asks which tier when the reply asserts two", () => {
  assert.equal(parseTierCorrection("tier 2 or tier 3")?.kind, "clarify");
});

test("detects 'the numbers look right' as a classification-only correction", () => {
  const parsed = parseTierCorrection("this is tier 2, but with ski in ski out access the numbers look correct");
  assert.equal(parsed?.kind, "ok");
  if (parsed?.kind === "ok") assert.equal(parsed.keepNumbers, true);
  const plain = parseTierCorrection("this is tier 2");
  if (plain?.kind === "ok") assert.equal(plain.keepNumbers, false);
});

test("re-underwrites Balanced from the corrected tier's grid cell and locks the spread", async () => {
  const knowledge = await loadMarketKnowledge();
  const data = buildEvalData();
  const { reasoning } = applyTierCorrection(data, "tier-1", knowledge);

  const expected = projectMedium(1, knowledge, {
    market: data.market!,
    subMarket: "Old Town / Main St",
    luxuryTier: "tier-1",
    tierConfidence: "high",
    amenities: { primary: [], secondary: [] },
  });
  const p = data.projections!;
  assert.equal(p.medium.adr, expected.adr);
  assert.equal(p.medium.monthly.length, 12);
  assert.ok(p.medium.revenue > 0 && p.medium.revenue % 100 === 0);
  assert.ok(Math.abs(p.high.revenue - p.medium.revenue * SCENARIO_SPREAD.OPTIMIZED) <= 100);
  assert.ok(Math.abs(p.low.revenue - p.medium.revenue * SCENARIO_SPREAD.CONSERVATIVE) <= 100);

  assert.equal(data.luxuryTier, "tier-1");
  assert.equal(data.tierConfidence, "high");
  assert.equal(data.borderlineWith, undefined);
  assert.match(data.methodology!, /^Tier: Tier 1 \(Standard\) — set by the reviewer/m);
  assert.doesNotMatch(data.methodology!, /premium-tier pricing assumption/);
  assert.match(data.narrative!, new RegExp(`around \\$${p.medium.revenue.toLocaleString("en-US")} gross`));
  assert.match(reasoning, /Reclassified from Tier 2 \(Premium\) to Tier 1 \(Standard\)/);

  // Synthetic benchmarks follow Balanced; vendor comps are untouched.
  assert.notEqual(data.comparables![0].annualRevenue, buildEvalData().comparables![0].annualRevenue);
  assert.equal(data.comparables![1].annualRevenue, 41000);
});

test("a repeated correction does not stack reviewer notes in the narrative", async () => {
  const knowledge = await loadMarketKnowledge();
  const data = buildEvalData();
  applyTierCorrection(data, "tier-1", knowledge);
  applyTierCorrection(data, "tier-3", knowledge);
  assert.equal(data.narrative!.match(/Reviewer reclassified/g)?.length, 1);
  assert.match(data.narrative!, /Tier 3 \(Luxury\)/);
});

test("keepNumbers changes the classification and nothing else", async () => {
  const knowledge = await loadMarketKnowledge();
  const data = buildEvalData();
  const before = structuredClone(data.projections);
  applyTierCorrection(data, "tier-3", knowledge, { keepNumbers: true });
  assert.equal(data.luxuryTier, "tier-3");
  assert.deepEqual(data.projections, before);
});

test("tier plus a Balanced target applies the target on top of the re-underwrite", async () => {
  const knowledge = await loadMarketKnowledge();
  const data = buildEvalData();
  const text = "this is tier 1. Set balanace to 27,400";
  applyTierCorrection(data, "tier-1", knowledge);
  const parsed = parseAdjustmentRequest(text);
  assert.equal(parsed.kind, "ok");
  if (parsed.kind !== "ok") return;
  applyStructuredAdjustment(data, parsed.spec);
  assert.equal(data.luxuryTier, "tier-1");
  assert.equal(data.projections!.medium.revenue, 27400);
  assert.equal(data.projections!.high.revenue, Math.round(27400 * SCENARIO_SPREAD.OPTIMIZED));
});

test("downgrading out of Promontory moves the sub-market back to East Basin", async () => {
  const knowledge = await loadMarketKnowledge();
  const data = buildEvalData({ subMarket: "East Basin (Promontory Tier 3-4)", luxuryTier: "tier-3", bedrooms: 4 });
  applyTierCorrection(data, "tier-2", knowledge);
  assert.equal(data.subMarket, "East Basin");
});

test("refuses to guess when the eval has no recognized sub-market", async () => {
  const knowledge = await loadMarketKnowledge();
  assert.throws(() => applyTierCorrection(buildEvalData({ subMarket: "" }), "tier-2", knowledge), TierCorrectionError);
});
