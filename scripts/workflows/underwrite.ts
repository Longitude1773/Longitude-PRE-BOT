import type { EvalData, EvalGroundingSource } from "../write-sheet-data.ts";
import { roundProjectionRevenue } from "./lib.ts";
import {
  classify,
  loadMarketKnowledge,
  projectMedium,
  resolveEffectiveGrid,
  TIER_DISPLAY_NAME,
  type Classification,
  type LuxuryTier,
  type ListingFacts,
  type MarketKnowledge,
  type ProjectionResult,
} from "./market-knowledge.ts";
import { inferUnderwriteDecision } from "./underwrite-decision.ts";

export type UnderwriteInput = {
  listingId: string;
  listingSource: string;
  identifierLabel?: string;
  skipMarketGate?: boolean;
  address: string;
  listingUrl: string;
  city?: string;
  state?: string;
  zip?: string;
  price?: number;
  bedrooms?: number;
  bathrooms?: number;
  squareFootage?: number;
  propertyType?: string;
  propertyTypeCode?: string;
  subtypeCode?: string;
  area?: string;
  subdivision?: string;
  nightlyRentalAllowed?: string;
  nightlyRentalAllowedSource?: string;
  strApproved?: boolean;
  photoUrls?: string[];
  openHouses?: Array<{ date: string; time: string; hostedBy: string }>;
  rentZestimate?: number;
  description?: string;
  latitude?: number;
  longitude?: number;
  groundingSummary?: string;
  groundingSources?: EvalGroundingSource[];
};

type EvalScenario = NonNullable<EvalData["projections"]>["high"];

const defaultEligibleCities = ["park city", "hideout", "heber city", "midway", "kamas", "oakley"];
const configuredEligibleCities = new Set(
  String(process.env.STR_ELIGIBLE_CITIES || defaultEligibleCities.join(","))
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean),
);

function round(value: number) {
  return Math.round(value);
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function normalizeNightlyRentalAllowed(raw: string) {
  const value = String(raw || "").trim().toLowerCase();
  if (!value) return "";
  if (["yes", "y", "true", "allowed", "approved", "permitted"].includes(value)) return "Yes";
  if (["no", "n", "false", "not allowed", "not approved", "not permitted", "prohibited"].includes(value)) return "No";
  return raw;
}

function inferPropertyType(input: UnderwriteInput) {
  if (input.propertyType) return input.propertyType;
  if (input.propertyTypeCode === "S") return "Single Family";
  if (input.propertyTypeCode === "C") return input.subtypeCode === "TH" ? "Condominium / Townhouse" : "Condominium";
  if (input.propertyTypeCode === "L") return "Land";
  return "Property";
}

function inferMarketEligibility(input: UnderwriteInput, region: string) {
  const city = String(input.city || "").toLowerCase();
  if (!region) {
    return { marketEligible: false, marketEligibleReason: "no_supported_region_match" };
  }
  if ((input.propertyTypeCode || "") === "L" || /^land$/i.test(input.propertyType || "")) {
    return { marketEligible: false, marketEligibleReason: "land_listing" };
  }
  if (!city) {
    return { marketEligible: true, marketEligibleReason: "matched_region_without_city" };
  }
  if (configuredEligibleCities.has(city)) {
    return { marketEligible: true, marketEligibleReason: "configured_city_match" };
  }
  if (input.area || input.subdivision) {
    return { marketEligible: true, marketEligibleReason: "submarket_metadata_present" };
  }
  return { marketEligible: false, marketEligibleReason: "city_not_in_supported_markets" };
}

function buildScenario(baseAdr: number, baseOcc: number, adrFactor: number, occDelta: number): EvalScenario {
  const monthlyProfiles = [
    ["Jan", 1.32, 1.14, 31],
    ["Feb", 1.26, 1.10, 28],
    ["Mar", 1.12, 1.04, 31],
    ["Apr", 0.46, 0.74, 30],
    ["May", 0.40, 0.72, 31],
    ["Jun", 0.95, 0.86, 30],
    ["Jul", 1.08, 0.93, 31],
    ["Aug", 1.00, 0.91, 31],
    ["Sep", 0.58, 0.78, 30],
    ["Oct", 0.50, 0.75, 31],
    ["Nov", 0.66, 0.84, 30],
    ["Dec", 1.18, 1.10, 31],
  ] as const;

  const scenarioAdr = round(baseAdr * adrFactor);
  const scenarioOcc = clamp(baseOcc + occDelta, 0.18, 0.82);
  const monthly = monthlyProfiles.map(([month, occMult, adrMult, days]) => {
    const occupancy = clamp(scenarioOcc * occMult, 0.18, 0.9);
    const adr = round(scenarioAdr * adrMult);
    return {
      month,
      revenue: round(occupancy * adr * days),
      occupancy: Number(occupancy.toFixed(2)),
      adr,
    };
  });

  return {
    revenue: monthly.reduce((sum, month) => sum + month.revenue, 0),
    occupancy: Number(scenarioOcc.toFixed(2)),
    adr: scenarioAdr,
    monthly,
  };
}

function buildComparables(input: UnderwriteInput, region: string, medium: EvalScenario) {
  const baseAddress = input.address || `${region}, Utah`;
  const bathrooms = input.bathrooms || Math.max(input.bedrooms || 2, 2);
  const factors = [0.86, 1.0, 1.14];
  return factors.map((factor, index) => ({
    source: "market-knowledge",
    title: `${region} benchmark ${index + 1}`,
    address: index === 1 ? baseAddress : `${region}, market benchmark`,
    bedrooms: input.bedrooms || 2,
    bathrooms,
    annualRevenue: round(medium.revenue * factor),
    occupancyRate: Number(clamp(medium.occupancy + (index - 1) * 0.04, 0.35, 0.8).toFixed(2)),
    averageDailyRate: round(medium.adr * factor),
    distanceMiles: Number((0.3 + index * 0.4).toFixed(1)),
  }));
}

function buildSupportedNarrative(input: UnderwriteInput, subMarket: string, propertyType: string, mediumRevenue: number) {
  const areaNote = input.area ? `${input.area} / ${input.subdivision || ""}`.trim() : subMarket;
  return `${propertyType} in ${areaNote} underwritten off the ${subMarket} market-knowledge baseline. This is an initial review-stage projection built from the structured market grid, classification, and amenity framework — not vendor API comps. Balanced revenue comes in around $${mediumRevenue.toLocaleString("en-US")} gross annually before management and operating costs.`;
}

function describeChain(knowledge: MarketKnowledge, classification: Classification): string {
  const eff = resolveEffectiveGrid(knowledge, classification.subMarket);
  if (eff.chain.length === 0) {
    return `${classification.subMarket} (anchor — direct grid lookup)`;
  }
  // chain[0] is the current sub-market; the rest are the path to the anchor.
  const parts: string[] = [];
  let currentName = eff.chain[0];
  for (let i = 0; i < eff.chain.length; i++) {
    const sub = knowledge.subMarkets[eff.chain[i]];
    if (!sub || sub.kind !== "derived") continue;
    const factor = sub.revenueFactor;
    const factorAtTier =
      typeof factor === "number"
        ? factor
        : factor[classification.luxuryTier];
    const factorLabel = factorAtTier !== undefined ? factorAtTier.toFixed(2) : "n/a (tier not defined)";
    parts.push(`${currentName} (×${factorLabel} of ${sub.derivedFrom})`);
    currentName = sub.derivedFrom;
  }
  parts.push(`${eff.anchorName} (anchor)`);
  return parts.join(" → ");
}

function describeAmenityLift(classification: Classification, knowledge: MarketKnowledge): string {
  const lines: string[] = [];
  const primary = classification.amenities.primary;
  const secondary = classification.amenities.secondary;

  if (primary.length === 0) {
    lines.push("- Primary amenities: none detected.");
  } else {
    const lifts = primary
      .map((name) => {
        const def = knowledge.amenityFramework.primaries.find((p) => p.name === name);
        return { name, lift: def?.lift ?? 0 };
      })
      .sort((a, b) => b.lift - a.lift);
    const largest = lifts[0];
    const extras = lifts.length - 1;
    const totalLift = largest.lift + extras * knowledge.amenityFramework.primaryDiminishingReturn;
    const liftDetail = lifts
      .map((l, i) => i === 0 ? `${l.name} (+${(l.lift * 100).toFixed(0)}%)` : `${l.name} (+5% diminishing)`)
      .join(", ");
    lines.push(`- Primary amenities applied (total +${(totalLift * 100).toFixed(0)}%): ${liftDetail}.`);
  }

  // Always surface absence of Iconic/unique per V1 spec
  if (!primary.includes("Iconic/unique")) {
    lines.push("- Iconic/unique: not auto-detected (V1 never auto-triggers). Flag manually if applicable.");
  }

  if (secondary.length === 0) {
    lines.push("- Secondary amenities: none detected.");
  } else {
    const hasPrimary = primary.length > 0;
    const threshold = knowledge.amenityFramework.secondaryThreshold;
    if (secondary.length < threshold) {
      lines.push(`- Secondary amenities (${secondary.length}/${threshold} threshold not met, no lift): ${secondary.join(", ")}.`);
    } else {
      const lift = hasPrimary
        ? knowledge.amenityFramework.secondaryLiftWithPrimary
        : knowledge.amenityFramework.secondaryLiftWithoutPrimary;
      lines.push(`- Secondary amenities (${secondary.length}, +${(lift * 100).toFixed(0)}% ${hasPrimary ? "with" : "without"} primary): ${secondary.join(", ")}.`);
    }
  }

  return lines.join("\n");
}

function buildSupportedMethodology(
  knowledge: MarketKnowledge,
  classification: Classification,
  projection: ProjectionResult,
  input: UnderwriteInput,
): string {
  const lines: string[] = [];

  // Classification
  lines.push(`Market: ${classification.market}.`);
  lines.push(`Sub-market chain: ${describeChain(knowledge, classification)}.`);

  // Tier
  const price = input.price || 0;
  const ppsf = input.squareFootage ? price / input.squareFootage : 0;
  const tierName = TIER_DISPLAY_NAME[classification.luxuryTier];
  lines.push(
    `Tier: ${tierName} — based on price $${price.toLocaleString("en-US")}` +
      (ppsf > 0 ? ` and PPSF $${Math.round(ppsf).toLocaleString("en-US")}` : ""),
  );
  if (classification.tierConfidence === "borderline" && classification.borderlineWith) {
    lines.push(
      `  ⚠ Borderline tier — within 10% of the ${TIER_DISPLAY_NAME[classification.borderlineWith as LuxuryTier]} threshold. Verify on review.`,
    );
  }

  // Amenities
  lines.push("Amenity framework:");
  lines.push(describeAmenityLift(classification, knowledge));

  // Final revenue + back-solve
  lines.push(`Final balanced revenue (after lifts): $${projection.annualRevenue.toLocaleString("en-US")}.`);
  lines.push(
    `Back-solved per-night ADR $${projection.adr} and annual-average occupancy ${(projection.occupancy * 100).toFixed(0)}% against the sub-market's typical ranges for ${tierName}.`,
  );

  // Sparse-walk and stretch notes from projection
  if (projection.methodologyNotes.length > 0) {
    lines.push("Notes:");
    for (const note of projection.methodologyNotes) lines.push(`- ${note}`);
  }

  // Scenario derivation
  lines.push(
    "Scenarios: Optimized = balanced ADR × 1.12 and occupancy + 10pp; Conservative = balanced ADR × 0.88 and occupancy − 12pp (including new-listing ramp penalty).",
  );

  return lines.join("\n");
}

function buildFallbackMediumRevenue(input: UnderwriteInput, propertyType: string, strApproved?: boolean) {
  const bedrooms = input.bedrooms || 2;
  const rentZestimateAnnual = input.rentZestimate ? input.rentZestimate * 12 : 0;
  const rentPremium =
    bedrooms <= 1 ? 1.65 :
    bedrooms === 2 ? 1.95 :
    bedrooms === 3 ? 2.25 :
    bedrooms === 4 ? 2.6 :
    2.95;
  const propertyFactor =
    /single family/i.test(propertyType) ? 1.05 :
    /townhouse/i.test(propertyType) ? 0.98 :
    /condominium|condo/i.test(propertyType) ? 0.94 :
    1;
  const strFactor = strApproved === true ? 1.08 : strApproved === false ? 0.88 : 1;
  if (rentZestimateAnnual > 0) {
    return round(rentZestimateAnnual * rentPremium * propertyFactor * strFactor);
  }

  const price = input.price || 0;
  const grossYield =
    bedrooms >= 5 ? 0.095 :
    bedrooms === 4 ? 0.088 :
    bedrooms === 3 ? 0.081 :
    bedrooms === 2 ? 0.074 :
    0.066;
  return round(price * grossYield * propertyFactor * strFactor);
}

function buildFallbackNarrative(input: UnderwriteInput, propertyType: string, mediumRevenue: number, strApproved?: boolean) {
  const location = [input.city, input.state].filter(Boolean).join(", ");
  const strNote =
    strApproved === true
      ? " Zillow also indicates short-term rentals are allowed."
      : strApproved === false
        ? " Zillow indicates short-term rentals may not be allowed, so treat this as a hypothetical underwriting case."
        : "";
  return `Off-market Zillow evaluation for a ${propertyType.toLowerCase()} in ${location || "this market"}. This is a lower-confidence estimate built from Zillow listing facts${input.rentZestimate ? ", Rent Zestimate," : ""} and generic STR heuristics because this repo does not have a configured local STR comp model for the market.${strNote} Balanced revenue comes in around $${mediumRevenue.toLocaleString("en-US")} gross annually before management and operating costs.`;
}

function buildFallbackMethodology(input: UnderwriteInput, propertyType: string, baseOcc: number) {
  const anchor =
    input.rentZestimate && input.rentZestimate > 0
      ? `Rent Zestimate ($${input.rentZestimate.toLocaleString("en-US")}/mo)`
      : "price-based gross-yield heuristics";
  return `Projections generated from Zillow listing facts using ${anchor} as the anchor, plus bedroom-count, property-type, and STR-permission heuristics. This is not a Park City market-knowledge underwrite and should be treated as a lower-confidence on-demand estimate for a ${propertyType.toLowerCase()}. Balanced occupancy was anchored around ${Math.round(baseOcc * 100)}% with scenario spreads applied above and below that baseline.`;
}

function toolSourceForListingSource(listingSource: string) {
  if (/zillow/i.test(listingSource)) return "zillow_scrape";
  if (/mls|flex/i.test(listingSource)) return "flexmls_scrape";
  if (/new_listing/i.test(listingSource)) return "mls_watcher";
  return "listing_ingest";
}

function buildGrounding(input: UnderwriteInput, region: string, comparableCount: number, usedKnowledge: boolean) {
  const sources: EvalGroundingSource[] = [...(input.groundingSources || [])];
  const listingUrl = String(input.listingUrl || "").trim();
  const listingSource = String(input.listingSource || "").trim();

  if (listingUrl) {
    sources.push({
      kind: "listing",
      label: input.identifierLabel ? `${input.identifierLabel} source listing` : "source listing",
      url: listingUrl,
      note: input.address || "",
    });
  }

  sources.push({
    kind: "tool",
    label: "listing acquisition tool",
    tool: toolSourceForListingSource(listingSource),
    note: listingSource || "listing_input",
  });

  if (region && usedKnowledge) {
    sources.push({
      kind: "market_knowledge",
      label: "Park City market knowledge baseline",
      note: region,
    });
  }

  if (comparableCount > 0) {
    sources.push({
      kind: "tool",
      label: "underwrite comparable synthesis",
      tool: "heuristic_comparable_builder",
      note: `${comparableCount} comparable benchmark${comparableCount === 1 ? "" : "s"}`,
    });
  }

  return {
    summary: input.groundingSummary || sources
      .map((source) => source.kind === "tool"
        ? `${source.label || "tool"} via ${source.tool || "tool"}`
        : source.label || source.kind || "source")
      .join("; "),
    sources,
  };
}

export async function buildUnderwriteBundle(input: UnderwriteInput) {
  const nightlyRentalAllowed = normalizeNightlyRentalAllowed(input.nightlyRentalAllowed || "");
  const strApproved =
    input.strApproved === true ||
    nightlyRentalAllowed === "Yes"
      ? true
      : input.strApproved === false || nightlyRentalAllowed === "No"
        ? false
        : undefined;
  const knowledge = await loadMarketKnowledge();
  const facts: ListingFacts = {
    price: input.price,
    squareFootage: input.squareFootage,
    bedrooms: input.bedrooms,
    area: input.area,
    subdivision: input.subdivision,
    address: input.address,
    city: input.city,
    description: input.description,
  };
  const classification = classify(facts, knowledge);
  const propertyType = inferPropertyType(input);
  const region = classification?.subMarket || "";
  const inferredMarket = inferMarketEligibility(input, region);
  const marketEligible = input.skipMarketGate ? true : inferredMarket.marketEligible;
  const marketEligibleReason = input.skipMarketGate ? "on_demand_override" : inferredMarket.marketEligibleReason;

  let projections: NonNullable<EvalData["projections"]>;
  let comparables: NonNullable<EvalData["comparables"]>;
  let narrative = "";
  let methodology = "";
  let confidence = "medium";

  if (classification) {
    const projection = projectMedium(input.bedrooms || 2, knowledge, classification);
    projections = {
      high: buildScenario(projection.adr, projection.occupancy, 1.12, 0.10),
      medium: buildScenario(projection.adr, projection.occupancy, 1.00, 0.00),
      low: buildScenario(projection.adr, projection.occupancy, 0.88, -0.12),
    };
    comparables = buildComparables(input, classification.subMarket, projections.medium);
    narrative = buildSupportedNarrative(input, classification.subMarket, propertyType, projections.medium.revenue);
    methodology = buildSupportedMethodology(knowledge, classification, projection, input);
    confidence = marketEligible ? "medium" : "low";
  } else {
    const mediumRevenue = buildFallbackMediumRevenue(input, propertyType, strApproved);
    let baseOcc = strApproved === true ? 0.58 : strApproved === false ? 0.46 : 0.52;
    if ((input.bedrooms || 0) >= 4) baseOcc += 0.03;
    if ((input.bedrooms || 0) <= 1) baseOcc -= 0.04;
    baseOcc = clamp(baseOcc, 0.35, 0.72);
    const baseAdr = round(mediumRevenue / (365 * baseOcc || 1));

    projections = {
      high: buildScenario(baseAdr, baseOcc, 1.14, 0.08),
      medium: buildScenario(baseAdr, baseOcc, 1, 0),
      low: buildScenario(baseAdr, baseOcc, 0.84, -0.12),
    };
    comparables = [];
    narrative = buildFallbackNarrative(input, propertyType, projections.medium.revenue, strApproved);
    methodology = buildFallbackMethodology(input, propertyType, baseOcc);
    confidence = input.rentZestimate ? "low" : "very_low";
  }

  const listingData = {
    mlsNumber: input.listingId,
    listingSource: input.listingSource,
    identifierLabel: input.identifierLabel || "MLS#",
    address: input.address,
    listingUrl: input.listingUrl,
    nightlyRentalAllowed,
    nightlyRentalAllowedSource: input.nightlyRentalAllowedSource || "",
    strApproved,
    marketEligible,
    marketEligibleReason,
    city: input.city || "",
    state: input.state || "",
    zip: input.zip || "",
    region,
    market: classification?.market || "",
    subMarket: classification?.subMarket || "",
    luxuryTier: classification?.luxuryTier || "",
    tierConfidence: classification?.tierConfidence,
    borderlineWith: classification?.borderlineWith,
    price: input.price || 0,
    bedrooms: input.bedrooms || 0,
    bathrooms: input.bathrooms || 0,
    squareFootage: input.squareFootage || 0,
    propertyType,
    amenities: classification?.amenities || { primary: [], secondary: [] },
    openHouses: input.openHouses || [],
    rentZestimate: input.rentZestimate || 0,
    strEligible: strApproved === false ? "No" : strApproved === true ? "Yes" : "",
    status: "Active",
    listingDate: new Date().toISOString().slice(0, 10),
    agent: "",
    photos: input.photoUrls || [],
    lat: input.latitude,
    lng: input.longitude,
    confidence,
  };

  const { decision, decisionReason } = inferUnderwriteDecision({
    comparableCount: comparables.length,
    confidence,
    methodology,
    region,
  });

  const evalData: EvalData = {
    address: input.address,
    mlsNumber: input.listingId,
    listingUrl: input.listingUrl,
    listingSource: input.listingSource,
    identifierLabel: input.identifierLabel || "MLS#",
    nightlyRentalAllowed,
    nightlyRentalAllowedSource: input.nightlyRentalAllowedSource || "",
    strApproved,
    price: input.price || 0,
    bedrooms: input.bedrooms || 0,
    bathrooms: input.bathrooms || 0,
    squareFootage: input.squareFootage || 0,
    propertyType,
    narrative,
    methodology,
    decision,
    decisionReason,
    photos: input.photoUrls || [],
    projections,
    comparables,
    rentZestimate: input.rentZestimate || 0,
    region,
    market: classification?.market || "",
    subMarket: classification?.subMarket || "",
    luxuryTier: classification?.luxuryTier || "",
    tierConfidence: classification?.tierConfidence,
    borderlineWith: classification?.borderlineWith,
    amenities: classification?.amenities || { primary: [], secondary: [] },
    confidence,
    grounding: buildGrounding(input, region, comparables.length, !!classification),
  };
  roundProjectionRevenue(evalData);

  return {
    listingData,
    evalData,
    region,
    marketEligible,
    marketEligibleReason,
    confidence,
    strApproved,
    nightlyRentalAllowed,
  };
}
