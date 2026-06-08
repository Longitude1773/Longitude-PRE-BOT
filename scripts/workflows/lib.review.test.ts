import { test } from "node:test";
import assert from "node:assert/strict";

import { buildClassificationBlock, buildListingAgentBlock } from "./lib.ts";
import type { EvalData } from "../write-sheet-data.ts";

function listingWith(agent: Record<string, unknown>) {
  return { data: agent };
}

test("buildListingAgentBlock: all fields present", () => {
  const block = buildListingAgentBlock(listingWith({
    listingAgentName: "Jane Smith",
    listingAgentEmail: "jane@smithrealty.com",
    listingAgentPhone: "(435) 555-1234",
    listingBrokerage: "Smith Realty",
  }));
  assert.deepEqual(block, [
    "👤 Listing Agent: Jane Smith • jane@smithrealty.com • (435) 555-1234",
    "   Brokerage: Smith Realty",
  ]);
});

test("buildListingAgentBlock: missing email shows the manual-check fallback", () => {
  const block = buildListingAgentBlock(listingWith({
    listingAgentName: "Jane Smith",
    listingAgentPhone: "(435) 555-1234",
    listingBrokerage: "Smith Realty",
  }));
  assert.equal(block[0], "👤 Listing Agent: Jane Smith • email not available — check listing manually • (435) 555-1234");
});

test("buildListingAgentBlock: missing phone is omitted entirely", () => {
  const block = buildListingAgentBlock(listingWith({
    listingAgentName: "Jane Smith",
    listingAgentEmail: "jane@smithrealty.com",
    listingBrokerage: "Smith Realty",
  }));
  assert.equal(block[0], "👤 Listing Agent: Jane Smith • jane@smithrealty.com");
  assert.equal(block[1], "   Brokerage: Smith Realty");
});

test("buildListingAgentBlock: missing brokerage omits the Brokerage line", () => {
  const block = buildListingAgentBlock(listingWith({
    listingAgentName: "Jane Smith",
    listingAgentEmail: "jane@smithrealty.com",
    listingAgentPhone: "(435) 555-1234",
  }));
  assert.deepEqual(block, [
    "👤 Listing Agent: Jane Smith • jane@smithrealty.com • (435) 555-1234",
  ]);
});

test("buildListingAgentBlock: no name returns empty block (section hidden)", () => {
  assert.deepEqual(buildListingAgentBlock(listingWith({ listingBrokerage: "Smith Realty" })), []);
  assert.deepEqual(buildListingAgentBlock(null), []);
});

test("buildClassificationBlock: normal path with primary + secondary, no Iconic", () => {
  const data: EvalData = {
    market: "Park City",
    subMarket: "Lower Deer Valley",
    luxuryTier: "tier-3",
    tierConfidence: "high",
    amenities: {
      primary: ["Ski-in/ski-out access"],
      secondary: ["Hot tub", "Theater room", "Heated driveway"],
    },
  };
  const block = buildClassificationBlock(data);
  assert.deepEqual(block, [
    "📍 Park City • Lower Deer Valley • Tier 3 (Luxury)",
    "✨ Primary: Ski-in/ski-out access",
    "   Iconic/unique: not auto-detected — flag manually if applicable",
    "   Secondary: Hot tub, Theater room, Heated driveway",
  ]);
});

test("buildClassificationBlock: borderline tier shows warning line with both display names", () => {
  const data: EvalData = {
    market: "Park City",
    subMarket: "Old Town / Main St",
    luxuryTier: "tier-2",
    tierConfidence: "borderline",
    borderlineWith: "tier-1",
    amenities: { primary: [], secondary: [] },
  };
  const block = buildClassificationBlock(data);
  assert.equal(block[0], "📍 Park City • Old Town / Main St • Tier 2 (Premium)");
  assert.ok(
    block.some((line) => line.includes("borderline between Tier 2 (Premium) and Tier 1 (Standard)")),
    `Expected borderline warning, got: ${JSON.stringify(block)}`,
  );
  assert.ok(block.includes("✨ Primary: none detected"));
  assert.ok(block.includes("   Iconic/unique: not auto-detected — flag manually if applicable"));
});

test("buildClassificationBlock: fallback when sub-market missing returns just the warning", () => {
  const data: EvalData = {};
  const block = buildClassificationBlock(data);
  assert.deepEqual(block, [
    "⚠ Low confidence — sub-market not recognized, using Park City generic baseline.",
  ]);
});

test("buildClassificationBlock: Iconic/unique present suppresses the absence prompt", () => {
  const data: EvalData = {
    market: "Park City",
    subMarket: "Upper Deer Valley",
    luxuryTier: "tier-4",
    tierConfidence: "high",
    amenities: {
      primary: ["Ski-in/ski-out access", "Iconic/unique"],
      secondary: [],
    },
  };
  const block = buildClassificationBlock(data);
  assert.ok(block.some((l) => l === "✨ Primary: Ski-in/ski-out access, Iconic/unique"));
  assert.ok(!block.some((l) => l.includes("Iconic/unique: not auto-detected")), "Iconic-absence line must NOT appear when Iconic is present");
});
