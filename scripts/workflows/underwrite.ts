import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { EvalData } from "../write-sheet-data.ts";
import { repoRoot } from "./lib.ts";

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
};

type AdrBand = {
  standard: [number, number] | null;
  premium: [number, number] | null;
  luxury: [number, number] | null;
};

type EvalScenario = NonNullable<EvalData["projections"]>["high"];

const marketKnowledgePath = resolve(repoRoot, "data/market-knowledge.md");
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

function normalizeRange(text: string) {
  const match = text.match(/\$(\d[\d,]*)-(?:\$)?(\d[\d,]*)/);
  if (!match) return null;
  return [Number(match[1].replace(/,/g, "")), Number(match[2].replace(/,/g, ""))] as [number, number];
}

function midpoint(range: [number, number] | null, fallback: number) {
  return range ? (range[0] + range[1]) / 2 : fallback;
}

function normalizeNightlyRentalAllowed(raw: string) {
  const value = String(raw || "").trim().toLowerCase();
  if (!value) return "";
  if (["yes", "y", "true", "allowed", "approved", "permitted"].includes(value)) return "Yes";
  if (["no", "n", "false", "not allowed", "not approved", "not permitted", "prohibited"].includes(value)) return "No";
  return raw;
}

function inferRegion(input: UnderwriteInput) {
  const text = `${input.area || ""} ${input.subdivision || ""} ${input.address || ""}`.toLowerCase();
  if (text.includes("deer valley")) return "Lower Deer Valley";
  if (text.includes("canyons")) return "Canyons Village";
  if (text.includes("park meadows") || text.includes("old town") || text.includes("main st") || text.includes("prospector")) return "Park City Core (Old Town/Main St)";
  if (text.includes("jeremy") || text.includes("pinebrook") || text.includes("summit park")) return "Pinebrook/Jeremy Ranch";
  if (text.includes("kimball") || text.includes("newpark") || text.includes("silver creek")) return "Kimball Junction";
  if (text.includes("jordanelle") || text.includes("hideout") || text.includes("mayflower")) return "Jordanelle";
  if (text.includes("heber") || text.includes("midway")) return "Heber/Midway";
  if (text.includes("kamas") || text.includes("oakley")) return "Kamas/Oakley";

  const city = String(input.city || "").toLowerCase();
  if (city === "park city") return "Park City Core (Old Town/Main St)";
  if (city === "hideout") return "Jordanelle";
  if (city === "heber city" || city === "midway") return "Heber/Midway";
  if (city === "kamas" || city === "oakley") return "Kamas/Oakley";
  return "";
}

function inferTier(input: UnderwriteInput, price: number, region: string) {
  const ppsf = input.squareFootage ? price / input.squareFootage : 0;
  const text = `${input.area || ""} ${input.subdivision || ""}`.toLowerCase();
  if (price >= 4_000_000 || ppsf >= 1400 || (region.includes("Deer Valley") && (input.bedrooms || 0) >= 4)) return "luxury" as const;
  if (price >= 1_500_000 || ppsf >= 800 || text.includes("estate") || text.includes("mountain") || (input.bedrooms || 0) >= 4) return "premium" as const;
  return "standard" as const;
}

function inferBedroomMultiplier(bedrooms: number) {
  if (bedrooms <= 1) return 0.7;
  if (bedrooms === 2) return 1.0;
  if (bedrooms === 3) return 1.32;
  if (bedrooms === 4) return 1.62;
  return 1.95;
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

function buildSupportedNarrative(input: UnderwriteInput, region: string, propertyType: string, mediumRevenue: number) {
  const areaNote = input.area ? `${input.area} / ${input.subdivision || ""}`.trim() : region;
  return `${propertyType} in ${areaNote} underwritten off the ${region} market-knowledge baseline. This is an initial review-stage projection built from live listing facts, bedroom count, price point, and submarket heuristics rather than vendor API comps. Balanced revenue comes in around $${mediumRevenue.toLocaleString("en-US")} gross annually before management and operating costs.`;
}

function buildSupportedMethodology(region: string, tier: string) {
  return `Projections generated from data/market-knowledge.md using the ${region} ADR band, bedroom multiplier, Park City seasonality, and the standard review workflow. ${tier === "premium" || tier === "luxury" ? "A premium-tier pricing assumption was used based on price point and positioning. " : "A standard-tier pricing assumption was used. "}High reflects stronger execution, medium reflects the working median case, and low includes a new-listing ramp penalty.`;
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

async function parseAdrBands() {
  const raw = await readFile(marketKnowledgePath, "utf8");
  const rows = raw.split("\n").filter((line) => line.startsWith("| ") && line.includes("$"));
  const result = new Map<string, AdrBand>();
  for (const row of rows) {
    const cells = row.split("|").map((cell) => cell.trim()).filter(Boolean);
    if (cells.length < 4 || cells[0] === "Area") continue;
    result.set(cells[0], {
      standard: normalizeRange(cells[1]),
      premium: normalizeRange(cells[2]),
      luxury: normalizeRange(cells[3]),
    });
  }
  return result;
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
  const region = inferRegion(input);
  const propertyType = inferPropertyType(input);
  const inferredMarket = inferMarketEligibility(input, region);
  const marketEligible = input.skipMarketGate ? true : inferredMarket.marketEligible;
  const marketEligibleReason = input.skipMarketGate ? "on_demand_override" : inferredMarket.marketEligibleReason;
  const adrBands = await parseAdrBands();

  let projections: NonNullable<EvalData["projections"]>;
  let comparables: NonNullable<EvalData["comparables"]>;
  let narrative = "";
  let methodology = "";
  let confidence = "medium";

  if (region) {
    const price = input.price || 0;
    const adrBand = adrBands.get(region) || adrBands.get("Park City Core (Old Town/Main St)");
    const tier = inferTier(input, price, region);
    const bedroomMultiplier = inferBedroomMultiplier(input.bedrooms || 2);
    const baseAdr = midpoint(
      tier === "luxury"
        ? adrBand?.luxury || adrBand?.premium || adrBand?.standard || null
        : tier === "premium"
          ? adrBand?.premium || adrBand?.standard || null
          : adrBand?.standard || null,
      375,
    ) * bedroomMultiplier * (region.includes("Deer Valley") && tier !== "standard" ? 1.14 : 1);

    let baseOcc = region.includes("Deer Valley") || region.includes("Canyons") ? 0.64 : 0.58;
    if (region.includes("Heber") || region.includes("Kamas")) baseOcc -= 0.06;
    if (region.includes("Kimball") || region.includes("Pinebrook")) baseOcc -= 0.03;
    if (tier === "premium") baseOcc += 0.03;
    if (tier === "luxury") baseOcc += 0.05;
    baseOcc = clamp(baseOcc, 0.42, 0.72);

    projections = {
      high: buildScenario(baseAdr, baseOcc, 1.12, 0.1),
      medium: buildScenario(baseAdr, baseOcc, 1, 0),
      low: buildScenario(baseAdr, baseOcc, 0.88, -0.12),
    };
    comparables = buildComparables(input, region, projections.medium);
    narrative = buildSupportedNarrative(input, region, propertyType, projections.medium.revenue);
    methodology = buildSupportedMethodology(region, tier);
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
    price: input.price || 0,
    bedrooms: input.bedrooms || 0,
    bathrooms: input.bathrooms || 0,
    squareFootage: input.squareFootage || 0,
    propertyType,
    amenities: [input.area, input.subdivision].filter(Boolean),
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
    photos: input.photoUrls || [],
    projections,
    comparables,
    rentZestimate: input.rentZestimate || 0,
    region,
    confidence,
  };

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
