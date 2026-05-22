import { test } from "node:test";
import assert from "node:assert/strict";

import {
  classify,
  clearMarketKnowledgeCache,
  inferAmenities,
  inferSubMarket,
  inferTier,
  loadMarketKnowledge,
  parseMarketKnowledge,
  projectMedium,
  resolveEffectiveGrid,
  SEASONALITY_K,
  type AnchoredSubMarket,
  type Classification,
  type DerivedSubMarket,
} from "./market-knowledge.ts";

const FIXTURE = `# Test Market Knowledge

## Luxury Tier Definitions

### Tier 1 — Standard
Entry-level homes.
Price ceiling: $1,000,000
PPSF ceiling: $400
Examples:
- Example 1

### Tier 2 — Premium
Mid-tier.
Price ceiling: $2,500,000
PPSF ceiling: $700
Examples:
- Example 2

### Tier 3 — Luxury
High end.
Price ceiling: $5,000,000
PPSF ceiling: $1,200
Examples:
- Example 3

### Tier 4 — Ultra-Luxury
Top of market.
Price ceiling: —
PPSF ceiling: —
Examples:
- Example 4

## Amenity Framework

### Primary Amenities

| Amenity | Lift | Geographic Scope | Qualifier |
|---|---|---|---|
| Ski-in/ski-out access | 35% | Test Anchor A | — |
| Exceptional sleeping capacity | 15% | — | max occupancy >= bedrooms*2 + 4 |
| Iconic/unique | 20% | — | qualitative |

### Secondary Amenities
- Hot tub
- Theater room
- Heated driveway

## Sub-Markets

### Test Anchor A  [ANCHOR]
Market: Test Market

Annual revenue grid:

| Bedrooms | Tier 1 | Tier 2 | Tier 3 | Tier 4 |
|---|---|---|---|---|
| 2 | $50,000 | $80,000 | $120,000 | — |
| 3 | $70,000 | $110,000 | $160,000 | $200,000 |

Typical ADR by tier (ski-peak, 4BR baseline):
- Tier 1: $300-$400
- Tier 2: $400-$500
- Tier 3: $500-$700
- Tier 4: $700-$900

Typical occupancy by tier (annual average):
- Tier 1: 0.50-0.60
- Tier 2: 0.55-0.65
- Tier 3: 0.60-0.70
- Tier 4: 0.55-0.65

### Test Derived A1  [DERIVED from Test Anchor A]
Market: Test Market
Revenue factor: 0.80
Occupancy delta: 0
Notes: Form A uniform.

### Test Derived A2  [DERIVED from Test Anchor A]
Market: Test Market
Revenue factor:
- Tier 2: 1.10
- Tier 3: 1.15
- Tier 4: 1.20
Occupancy delta: -0.02
Notes: Form B per-tier (Tier 1 omitted).

### Test Derived Chained  [DERIVED from Test Derived A1]
Market: Test Market
Revenue factor: 0.90
Occupancy delta: 0
Notes: Chain reference (chains through A1 to anchor).
`;

test("parses tier definitions including ceilings", () => {
  const k = parseMarketKnowledge(FIXTURE);
  assert.equal(k.tierDefinitions["tier-1"].priceCeiling, 1_000_000);
  assert.equal(k.tierDefinitions["tier-1"].ppsfCeiling, 400);
  assert.equal(k.tierDefinitions["tier-2"].priceCeiling, 2_500_000);
  assert.equal(k.tierDefinitions["tier-2"].ppsfCeiling, 700);
  assert.equal(k.tierDefinitions["tier-3"].priceCeiling, 5_000_000);
  assert.equal(k.tierDefinitions["tier-3"].ppsfCeiling, 1_200);
  assert.equal(k.tierDefinitions["tier-4"].priceCeiling, undefined);
  assert.equal(k.tierDefinitions["tier-4"].ppsfCeiling, undefined);
  assert.deepEqual(k.tierDefinitions["tier-1"].examples, ["Example 1"]);
});

test("parses amenity framework with framework constants", () => {
  const k = parseMarketKnowledge(FIXTURE);
  assert.equal(k.amenityFramework.primaries.length, 3);
  assert.equal(k.amenityFramework.primaries[0].name, "Ski-in/ski-out access");
  assert.deepEqual(k.amenityFramework.primaries[0].geographicScope, ["Test Anchor A"]);
  assert.equal(k.amenityFramework.primaries[0].lift, 0.35);
  assert.equal(k.amenityFramework.primaries[1].qualifier, "max occupancy >= bedrooms*2 + 4");
  assert.equal(k.amenityFramework.secondaries.length, 3);
  assert.equal(k.amenityFramework.primaryDiminishingReturn, 0.05);
  assert.equal(k.amenityFramework.secondaryThreshold, 3);
  assert.equal(k.amenityFramework.secondaryLiftWithoutPrimary, 0.10);
  assert.equal(k.amenityFramework.secondaryLiftWithPrimary, 0.03);
});

test("parses anchor with full grid + ranges", () => {
  const k = parseMarketKnowledge(FIXTURE);
  const a = k.subMarkets["Test Anchor A"] as AnchoredSubMarket;
  assert.equal(a.kind, "anchored");
  assert.equal(a.anchorRevenueGrid[2]["tier-1"], 50_000);
  assert.equal(a.anchorRevenueGrid[2]["tier-4"], undefined);
  assert.equal(a.anchorRevenueGrid[3]["tier-4"], 200_000);
  assert.deepEqual(a.baseAdr["tier-3"], [500, 700]);
  assert.deepEqual(a.baseOccupancy["tier-3"], [0.60, 0.70]);
});

test("parses Form A (uniform) revenue factor", () => {
  const k = parseMarketKnowledge(FIXTURE);
  const d = k.subMarkets["Test Derived A1"] as DerivedSubMarket;
  assert.equal(d.kind, "derived");
  assert.equal(d.revenueFactor, 0.80);
  assert.equal(d.derivedFrom, "Test Anchor A");
});

test("parses Form B (per-tier) revenue factor with Tier 1 omitted", () => {
  const k = parseMarketKnowledge(FIXTURE);
  const d = k.subMarkets["Test Derived A2"] as DerivedSubMarket;
  assert.deepEqual(d.revenueFactor, { "tier-2": 1.10, "tier-3": 1.15, "tier-4": 1.20 });
  assert.equal(d.occupancyDelta, -0.02);
});

test("resolveEffectiveGrid composes a single Form A derived", () => {
  const k = parseMarketKnowledge(FIXTURE);
  const eff = resolveEffectiveGrid(k, "Test Derived A1");
  assert.equal(eff.byBedroom[2]["tier-1"], 40_000);
  assert.equal(eff.byBedroom[3]["tier-4"], 160_000);
  assert.equal(eff.anchorName, "Test Anchor A");
  assert.deepEqual(eff.chain, ["Test Derived A1"]);
});

test("resolveEffectiveGrid composes Form B (Tier 1 dropped per option a)", () => {
  const k = parseMarketKnowledge(FIXTURE);
  const eff = resolveEffectiveGrid(k, "Test Derived A2");
  assert.equal(eff.byBedroom[2]["tier-1"], undefined, "Tier 1 must be dropped when omitted from Form B");
  assert.equal(eff.byBedroom[2]["tier-2"], 88_000);
  assert.equal(eff.byBedroom[3]["tier-3"], 184_000);
  assert.equal(eff.byBedroom[3]["tier-4"], 240_000);
  assert.equal(eff.occupancyDeltaSum, -0.02);
});

test("resolveEffectiveGrid resolves a 2-link chain", () => {
  const k = parseMarketKnowledge(FIXTURE);
  const eff = resolveEffectiveGrid(k, "Test Derived Chained");
  assert.equal(eff.byBedroom[2]["tier-1"], 36_000);
  assert.equal(eff.byBedroom[3]["tier-3"], 115_200);
  assert.deepEqual(eff.chain, ["Test Derived Chained", "Test Derived A1"]);
  assert.equal(eff.anchorName, "Test Anchor A");
});

test("resolveEffectiveGrid throws on cycle", () => {
  const k = parseMarketKnowledge(FIXTURE);
  (k.subMarkets["Test Derived A1"] as DerivedSubMarket).derivedFrom = "Test Derived Chained";
  assert.throws(() => resolveEffectiveGrid(k, "Test Derived Chained"), /Cycle/);
});

test("smoke test: parses the real market-knowledge.draft.md", async () => {
  clearMarketKnowledgeCache();
  const k = await loadMarketKnowledge();
  assert.equal(Object.keys(k.tierDefinitions).length, 4);
  assert.equal(k.tierDefinitions["tier-1"].priceCeiling, 1_000_000);
  assert.equal(k.amenityFramework.primaries.length, 3);
  assert.equal(k.amenityFramework.secondaries.length, 9);
  assert.ok(k.subMarkets["Old Town / Main St"]);
  assert.equal(k.subMarkets["Old Town / Main St"].kind, "anchored");
  assert.ok(k.subMarkets["Canyons Village"]);
  assert.equal(k.subMarkets["Canyons Village"].kind, "derived");

  const canyons = resolveEffectiveGrid(k, "Canyons Village");
  assert.equal(canyons.anchorName, "Old Town / Main St");
  assert.deepEqual(canyons.chain, ["Canyons Village", "Lower Deer Valley"]);
});

// === Classification tests ===

test("inferTier covers the OR-condition examples", () => {
  const k = parseMarketKnowledge(FIXTURE);
  // $1.5M / $300 ppsf → exceeds T1 price → Tier 2
  assert.equal(inferTier({ price: 1_500_000, squareFootage: 5_000 }, k).tier, "tier-2");
  // $900K / $500 ppsf → exceeds T1 ppsf → Tier 2
  assert.equal(inferTier({ price: 900_000, squareFootage: 1_800 }, k).tier, "tier-2");
  // $900K / $300 ppsf → exceeds nothing → Tier 1
  assert.equal(inferTier({ price: 900_000, squareFootage: 3_000 }, k).tier, "tier-1");
  // $1.4M / $350 ppsf → exceeds T1 price only → Tier 2
  assert.equal(inferTier({ price: 1_400_000, squareFootage: 4_000 }, k).tier, "tier-2");
  // $5.5M / $800 ppsf → exceeds T1, T2, T3 price → Tier 4
  assert.equal(inferTier({ price: 5_500_000, squareFootage: 6_875 }, k).tier, "tier-4");
});

test("inferTier flags borderline cases within 10% of a ceiling", () => {
  const k = parseMarketKnowledge(FIXTURE);
  // $1.05M / $300 ppsf → T1 price ratio 1.05, within 10% → borderline tier-1/tier-2
  const a = inferTier({ price: 1_050_000, squareFootage: 3_500 }, k);
  assert.equal(a.tier, "tier-2");
  assert.equal(a.confidence, "borderline");
  assert.equal(a.borderlineWith, "tier-1");

  // $700K / $440 ppsf → T1 ppsf ratio 1.10 exactly → borderline (≤ 10%)
  const b = inferTier({ price: 700_000, squareFootage: 1_591 }, k); // 700000/1591 ≈ 440
  assert.equal(b.tier, "tier-2");
  assert.equal(b.confidence, "borderline");
  assert.equal(b.borderlineWith, "tier-1");

  // $1.4M / $350 ppsf → no ceiling within 10% → high confidence
  const c = inferTier({ price: 1_400_000, squareFootage: 4_000 }, k);
  assert.equal(c.tier, "tier-2");
  assert.equal(c.confidence, "high");
  assert.equal(c.borderlineWith, undefined);
});

test("inferSubMarket matches keywords against the real knowledge", async () => {
  clearMarketKnowledgeCache();
  const k = await loadMarketKnowledge();

  const emp = inferSubMarket({ description: "Estate in Empire Pass with skiing access" }, k);
  assert.equal(emp.name, "Upper Deer Valley");
  assert.equal(emp.matched, true);
  assert.equal(emp.promontoryHint, false);

  const prom = inferSubMarket({ subdivision: "Promontory Club" }, k);
  assert.equal(prom.name, "East Basin");
  assert.equal(prom.promontoryHint, true);

  const kamas = inferSubMarket({ city: "Kamas" }, k);
  assert.equal(kamas.name, "Kamas/Oakley");

  // Park City catch-all → Old Town / Main St
  const generic = inferSubMarket({ city: "Park City", description: "Cozy mountain home" }, k);
  assert.equal(generic.name, "Old Town / Main St");

  // No keyword match
  const unmatched = inferSubMarket({ city: "Salt Lake City" }, k);
  assert.equal(unmatched.matched, false);
});

test("classify promotes Promontory to the special sub-market at Tier 3-4", async () => {
  clearMarketKnowledgeCache();
  const k = await loadMarketKnowledge();

  // Promontory + Tier 3 → swap to East Basin (Promontory Tier 3-4)
  const high = classify({
    subdivision: "Promontory",
    price: 4_500_000,
    squareFootage: 5_000,  // ppsf $900 → exceeds T1 ($400) + T2 ($700) ceilings → Tier 3
  }, k);
  assert.ok(high);
  assert.equal(high!.subMarket, "East Basin (Promontory Tier 3-4)");
  assert.equal(high!.luxuryTier, "tier-3");

  // Promontory + Tier 1 → stay at East Basin
  const low = classify({
    subdivision: "Promontory",
    price: 800_000,
    squareFootage: 3_000,  // ppsf $267 → Tier 1
  }, k);
  assert.ok(low);
  assert.equal(low!.subMarket, "East Basin");
  assert.equal(low!.luxuryTier, "tier-1");
});

test("classify returns null when sub-market is unmatched (caller uses PC generic fallback)", async () => {
  clearMarketKnowledgeCache();
  const k = await loadMarketKnowledge();
  const result = classify({ city: "Salt Lake City", price: 1_200_000, squareFootage: 3_000 }, k);
  assert.equal(result, null);
});

// === Projection math tests ===

test("projectMedium uses anchor grid + back-solves ADR/occupancy in typical ranges", async () => {
  clearMarketKnowledgeCache();
  const k = await loadMarketKnowledge();
  const classification: Classification = {
    market: "Park City",
    subMarket: "Old Town / Main St",
    luxuryTier: "tier-3",
    tierConfidence: "high",
    amenities: { primary: [], secondary: [] },
  };
  const result = projectMedium(4, k, classification);
  // Old Town / Main St 4BR Tier 3 = $145,000 (no amenity lifts).
  assert.equal(result.annualRevenue, 145000);
  assert.ok(result.adr >= 720 && result.adr <= 995, `ADR ${result.adr} should be in Tier 3 range $720-$995`);
  assert.ok(result.occupancy >= 0.40 && result.occupancy <= 0.55, `Occ ${result.occupancy} should be in Tier 3 range`);
  assert.equal(result.methodologyNotes.length, 0);
});

test("projectMedium sparse-walks 2BR Jordanelle Ridge Tier 3 to 3BR with methodology note", async () => {
  clearMarketKnowledgeCache();
  const k = await loadMarketKnowledge();
  const classification: Classification = {
    market: "Jordanelle",
    subMarket: "Jordanelle Ridge",
    luxuryTier: "tier-3",
    tierConfidence: "high",
    amenities: { primary: [], secondary: [] },
  };
  const result = projectMedium(2, k, classification);
  // Jordanelle Ridge 3BR Tier 3 = $85,000 (1BR/2BR are sparse).
  assert.equal(result.annualRevenue, 85000);
  assert.ok(
    result.methodologyNotes.some((n) => n.includes("3BR tier-3") && n.includes("proxy")),
    `Expected sparse-walk note, got: ${JSON.stringify(result.methodologyNotes)}`,
  );
});

test("projectMedium applies primary amenity diminishing returns (largest + 5 + 5)", () => {
  const k = parseMarketKnowledge(FIXTURE);
  // Anchor A 3BR Tier 3 = $160,000. Lifts: ski 35%, sleep 15%, iconic 20%.
  const base: Omit<Classification, "amenities"> = {
    market: "Test Market",
    subMarket: "Test Anchor A",
    luxuryTier: "tier-3",
    tierConfidence: "high",
  };

  const none = projectMedium(3, k, { ...base, amenities: { primary: [], secondary: [] } });
  assert.equal(none.annualRevenue, 160_000);

  const skiOnly = projectMedium(3, k, { ...base, amenities: { primary: ["Ski-in/ski-out access"], secondary: [] } });
  assert.equal(skiOnly.annualRevenue, Math.round(160_000 * 1.35), "ski only: +35%");

  const skiAndSleep = projectMedium(3, k, {
    ...base,
    amenities: { primary: ["Ski-in/ski-out access", "Exceptional sleeping capacity"], secondary: [] },
  });
  assert.equal(skiAndSleep.annualRevenue, Math.round(160_000 * 1.40), "ski + sleep: largest 35% + 5% = 40% (not 50%)");

  const allThree = projectMedium(3, k, {
    ...base,
    amenities: { primary: ["Ski-in/ski-out access", "Exceptional sleeping capacity", "Iconic/unique"], secondary: [] },
  });
  assert.equal(allThree.annualRevenue, Math.round(160_000 * 1.45), "all three: 35% + 5% + 5% = 45% (not 70%)");

  const sleepIconic = projectMedium(3, k, {
    ...base,
    amenities: { primary: ["Exceptional sleeping capacity", "Iconic/unique"], secondary: [] },
  });
  assert.equal(sleepIconic.annualRevenue, Math.round(160_000 * 1.25), "no ski: largest 20% + 5% = 25%");
});

test("projectMedium applies secondary amenity threshold rule", () => {
  const k = parseMarketKnowledge(FIXTURE);
  const base: Omit<Classification, "amenities"> = {
    market: "Test Market",
    subMarket: "Test Anchor A",
    luxuryTier: "tier-3",
    tierConfidence: "high",
  };

  const two = projectMedium(3, k, { ...base, amenities: { primary: [], secondary: ["Hot tub", "Theater room"] } });
  assert.equal(two.annualRevenue, 160_000, "2 secondaries: no lift");

  const threeNoPrimary = projectMedium(3, k, {
    ...base,
    amenities: { primary: [], secondary: ["Hot tub", "Theater room", "Heated driveway"] },
  });
  assert.equal(threeNoPrimary.annualRevenue, Math.round(160_000 * 1.10), "3 secondaries, no primary: +10%");

  const threeWithPrimary = projectMedium(3, k, {
    ...base,
    amenities: { primary: ["Ski-in/ski-out access"], secondary: ["Hot tub", "Theater room", "Heated driveway"] },
  });
  assert.equal(threeWithPrimary.annualRevenue, Math.round(160_000 * 1.35 * 1.03), "3 secondaries, primary present: +3% on top of primary lift");
});

test("projectMedium falls back to Park City generic when classification is null", async () => {
  clearMarketKnowledgeCache();
  const k = await loadMarketKnowledge();
  const result = projectMedium(3, k, null);
  assert.equal(result.adr, 350);
  assert.equal(result.occupancy, 0.55);
  const expected = Math.round(350 * 0.55 * SEASONALITY_K);
  assert.equal(result.annualRevenue, expected);
  assert.ok(
    result.methodologyNotes.some((n) => /generic/i.test(n)),
    `Expected fallback note, got: ${JSON.stringify(result.methodologyNotes)}`,
  );
});

test("inferAmenities matches primaries and secondaries with qualifiers and scope", async () => {
  clearMarketKnowledgeCache();
  const k = await loadMarketKnowledge();

  // Ski-in/ski-out: keyword present AND in geographic scope (Upper Deer Valley) → match
  const a = inferAmenities(
    { description: "Estate with ski-in/ski-out access and a hot tub, theater room, heated driveway", bedrooms: 5, maxOccupancy: 14 },
    k,
    "Upper Deer Valley",
  );
  assert.ok(a.primary.includes("Ski-in/ski-out access"), "ski-in/ski-out should match in Upper Deer Valley");
  assert.ok(a.primary.includes("Exceptional sleeping capacity"), "5BR sleeping 14 (≥ 5*2+4=14) should match");
  assert.ok(!a.primary.includes("Iconic/unique"), "Iconic/unique never auto-triggers in V1");
  assert.deepEqual(a.secondary.sort(), ["Heated driveway", "Hot tub", "Theater room"]);

  // Same listing but in Lakeside (out of ski-in/ski-out scope) → no primary ski-in/ski-out match
  const b = inferAmenities(
    { description: "ski-in/ski-out and a hot tub", bedrooms: 3, maxOccupancy: 6 },
    k,
    "Lakeside",
  );
  assert.ok(!b.primary.includes("Ski-in/ski-out access"), "Lakeside is not in ski-in/ski-out scope");
  assert.ok(!b.primary.includes("Exceptional sleeping capacity"), "3BR sleeping 6 does not meet bedrooms*2+4=10");
  assert.deepEqual(b.secondary, ["Hot tub"]);
});
