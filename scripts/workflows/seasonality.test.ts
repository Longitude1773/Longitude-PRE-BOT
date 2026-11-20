import assert from "node:assert/strict";
import test from "node:test";

import type { EvalData } from "../write-sheet-data.ts";
import { deriveSpreadScenarios, roundMonthsToTotal, roundProjectionRevenue, SCENARIO_SPREAD } from "./lib.ts";
import { loadMarketKnowledge } from "./market-knowledge.ts";
import { applyReplyAdjustments, isAdjustmentReply } from "./reply-adjustments.ts";
import {
  applySeasonalityProfile,
  buildSeasonalScenario,
  parseSeasonalityProfile,
  SEASONALITY_PROFILES,
  SEASONALITY_SHARES,
  seasonalitySplit,
} from "./seasonality.ts";

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

function buildEvalData(overrides: Partial<EvalData> = {}): EvalData {
  const data: EvalData = {
    mlsNumber: "12605064",
    price: 825000,
    bedrooms: 3,
    squareFootage: 2000,
    market: "Heber Valley",
    subMarket: "Jordanelle Ridge",
    luxuryTier: "tier-1",
    tierConfidence: "high",
    amenities: { primary: [], secondary: [] },
    narrative: "Balanced revenue comes in around $78,900 gross annually before management and operating costs.",
    methodology: "Market: Heber Valley.",
    projections: deriveSpreadScenarios(buildSeasonalScenario(310, 0.55, 1, 0)),
    ...overrides,
  };
  roundProjectionRevenue(data);
  return data;
}

test("every curve is twelve months summing to 100%", () => {
  for (const profile of SEASONALITY_PROFILES) {
    assert.equal(SEASONALITY_SHARES[profile].length, 12, profile);
    assert.equal(sum([...SEASONALITY_SHARES[profile]]), 100, profile);
  }
  assert.deepEqual(seasonalitySplit("ski-heavy"), { winter: 65, summer: 20, shoulder: 15 });
  assert.deepEqual(seasonalitySplit("standard"), { winter: 55, summer: 29, shoulder: 16 });
  assert.deepEqual(seasonalitySplit("summer-heavy"), { winter: 39, summer: 38, shoulder: 23 });
});

test("months follow the curve and occupancy stays between 18% and 90%", () => {
  for (const baseOcc of [0.42, 0.58, 0.72]) {
    for (const profile of SEASONALITY_PROFILES) {
      const s = buildSeasonalScenario(350, baseOcc, 1, 0, profile);
      s.monthly.forEach((m, i) => {
        assert.ok(Math.abs(m.revenue / s.revenue - SEASONALITY_SHARES[profile][i] / 100) < 0.001, `${profile} ${m.month}`);
        assert.ok(m.occupancy >= 0.18 && m.occupancy <= 0.9, `${profile} ${m.month} occ ${m.occupancy}`);
        assert.ok(m.adr > 0);
      });
    }
  }
});

test("the curve changes the months, not the annual level", () => {
  const annual = SEASONALITY_PROFILES.map((p) => buildSeasonalScenario(350, 0.6, 1, 0, p).revenue);
  assert.ok(Math.max(...annual) - Math.min(...annual) <= 12, annual.join(","));
});

test("rounded months add up exactly to the rounded annual figure", () => {
  const data = buildEvalData();
  for (const s of Object.values(data.projections!)) {
    assert.equal(sum(s.monthly.map((m) => m.revenue)), s.revenue);
    assert.ok(s.monthly.every((m) => m.revenue % 100 === 0));
  }
  const months = roundMonthsToTotal([{ revenue: 1049 }, { revenue: 1049 }, { revenue: 1049 }], 3200);
  assert.equal(sum(months.map((m) => m.revenue)), 3200);
});

test("reshaping keeps every annual figure and re-derives the spread", () => {
  const data = buildEvalData();
  const before = structuredClone(data.projections!);
  applySeasonalityProfile(data, "summer-heavy");
  const p = data.projections!;
  assert.equal(p.medium.revenue, before.medium.revenue);
  assert.equal(p.medium.adr, before.medium.adr);
  assert.equal(p.medium.occupancy, before.medium.occupancy);
  assert.ok(Math.abs(p.high.revenue - p.medium.revenue * SCENARIO_SPREAD.OPTIMIZED) <= 100);
  assert.ok(Math.abs(p.low.revenue - p.medium.revenue * SCENARIO_SPREAD.CONSERVATIVE) <= 100);
  const jul = p.medium.monthly[6].revenue, jan = p.medium.monthly[0].revenue;
  assert.ok(jul > jan, "summer-heavy July beats January");
  assert.equal(data.seasonalityProfile, "summer-heavy");
  assert.match(data.methodology!, /^Seasonality: Summer-heavy curve/m);

  applySeasonalityProfile(data, "standard");
  assert.doesNotMatch(data.methodology!, /^Seasonality:/m);
  assert.ok(data.projections!.medium.monthly[0].revenue > data.projections!.medium.monthly[6].revenue);
});

test("parses the curve words reviewers type", () => {
  assert.deepEqual(parseSeasonalityProfile("approve ski-heavy"), { kind: "ok", profile: "ski-heavy" });
  assert.deepEqual(parseSeasonalityProfile("Approve summer heavy"), { kind: "ok", profile: "summer-heavy" });
  assert.deepEqual(parseSeasonalityProfile("approve winter-heavy"), { kind: "ok", profile: "ski-heavy" });
  assert.deepEqual(parseSeasonalityProfile("go back to the standard curve"), { kind: "ok", profile: "standard" });
  assert.equal(parseSeasonalityProfile("approve"), null);
  assert.equal(parseSeasonalityProfile("approve, summer is strong here"), null);
  assert.equal(parseSeasonalityProfile("this is a standard tier 1 condo"), null);
  assert.equal(parseSeasonalityProfile("ski-heavy or summer-heavy?")?.kind, "clarify");
});

test("a curve word on its own is an adjustment; a tier change keeps the curve", async () => {
  assert.equal(isAdjustmentReply("summer-heavy"), true);
  const knowledge = await loadMarketKnowledge();
  const data = buildEvalData();
  const first = await applyReplyAdjustments(data, "make this summer-heavy", async () => knowledge);
  assert.equal(first.kind, "applied");
  if (first.kind === "applied") assert.equal(first.category, "seasonality");

  const second = await applyReplyAdjustments(data, "this is tier 2", async () => knowledge);
  assert.equal(second.kind, "applied");
  if (second.kind === "applied") assert.equal(second.category, "classification-tier");
  assert.equal(data.seasonalityProfile, "summer-heavy");
  assert.ok(data.projections!.medium.monthly[6].revenue > data.projections!.medium.monthly[0].revenue);
  assert.match(data.methodology!, /^Seasonality: Summer-heavy curve/m);
});

test("tier, number and curve in one reply apply in order", async () => {
  const knowledge = await loadMarketKnowledge();
  const data = buildEvalData();
  const result = await applyReplyAdjustments(data, "tier 2, set balanced to 60,000, ski-heavy", async () => knowledge);
  assert.equal(result.kind, "applied");
  if (result.kind === "applied") assert.equal(result.category, "classification-tier");
  assert.equal(data.luxuryTier, "tier-2");
  assert.equal(data.projections!.medium.revenue, 60000);
  assert.equal(data.seasonalityProfile, "ski-heavy");
  assert.equal(sum(data.projections!.medium.monthly.map((m) => m.revenue)), 60000);
});
