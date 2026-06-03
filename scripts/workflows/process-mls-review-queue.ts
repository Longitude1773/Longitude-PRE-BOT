import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { appendSheetRows, readSheet } from "../sheets.ts";
import { buildListingRow, type EvalData } from "../write-sheet-data.ts";
import { inferEvalPath, repoRoot, roundProjectionRevenue, writeEvaluationVersionsBatch } from "./lib.ts";
import { classify, loadMarketKnowledge, type ListingFacts } from "./market-knowledge.ts";

type QueueItem = {
  mlsNumber: string;
  address: string;
  cityStateZip: string;
  displayAddress: string;
  listingUrl?: string;
  nightlyRentalAllowed?: string;
  nightlyRentalAllowedSource?: string;
  strApproved?: boolean;
  priceText: string;
  statusText: string;
  markerText: string;
  area?: string;
  subdivision?: string;
  propertyTypeCode?: string;
  subtypeCode?: string;
  bedrooms?: number;
  bathrooms?: number;
  squareFootage?: number;
  photoUrls?: string[];
  openHouses?: Array<{ date: string; time: string; hostedBy: string }>;
  detectedAt?: string;
};

type AdrBand = {
  standard: [number, number] | null;
  premium: [number, number] | null;
  luxury: [number, number] | null;
};

type Comparable = {
  source: string;
  title: string;
  address: string;
  bedrooms: number;
  bathrooms: number;
  annualRevenue: number;
  occupancyRate: number;
  averageDailyRate: number;
  distanceMiles: number;
};

const queuePath = resolve(repoRoot, "data/inbox/mls-review-queue.json");
const resultsPath = resolve(repoRoot, "data/inbox/mls-review-results.json");
const marketKnowledgePath = resolve(repoRoot, "data/market-knowledge.md");
const defaultEligibleCities = ["park city", "hideout", "heber city", "midway", "kamas", "oakley"];
const configuredEligibleCities = new Set(
  String(process.env.STR_ELIGIBLE_CITIES || defaultEligibleCities.join(","))
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
);

function argValue(flag: string) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function parsePrice(priceText: string) {
  return Number(String(priceText || "").replace(/[^\d]/g, ""));
}

function parseCity(cityStateZip: string) {
  return String(cityStateZip || "").split(",")[0]?.trim() || "";
}

function parseState(cityStateZip: string) {
  return String(cityStateZip || "").split(",")[1]?.trim().split(/\s+/)[0] || "";
}

function parseZip(cityStateZip: string) {
  return String(cityStateZip || "").match(/(\d{5})(?:-\d{4})?$/)?.[1] || "";
}

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

function inferRegion(item: QueueItem) {
  const text = `${item.area || ""} ${item.subdivision || ""} ${item.displayAddress || ""}`.toLowerCase();
  if (text.includes("deer valley")) return "Lower Deer Valley";
  if (text.includes("canyons")) return "Canyons Village";
  if (text.includes("park meadows") || text.includes("old town") || text.includes("main st") || text.includes("prospector")) return "Park City Core (Old Town/Main St)";
  if (text.includes("jeremy") || text.includes("pinebrook") || text.includes("summit park")) return "Pinebrook/Jeremy Ranch";
  if (text.includes("kimball") || text.includes("newpark") || text.includes("silver creek")) return "Kimball Junction";
  if (text.includes("jordanelle") || text.includes("hideout") || text.includes("mayflower")) return "Jordanelle";
  if (text.includes("heber") || text.includes("midway")) return "Heber/Midway";
  if (text.includes("kamas") || text.includes("oakley")) return "Kamas/Oakley";

  const city = parseCity(item.cityStateZip).toLowerCase();
  if (city === "park city") return "Park City Core (Old Town/Main St)";
  if (city === "hideout") return "Jordanelle";
  if (city === "heber city" || city === "midway") return "Heber/Midway";
  if (city === "kamas" || city === "oakley") return "Kamas/Oakley";
  return "";
}

function inferTier(item: QueueItem, price: number, region: string) {
  const ppsf = item.squareFootage ? price / item.squareFootage : 0;
  const text = `${item.area || ""} ${item.subdivision || ""}`.toLowerCase();
  if (price >= 4_000_000 || ppsf >= 1400 || (region.includes("Deer Valley") && (item.bedrooms || 0) >= 4)) return "luxury" as const;
  if (price >= 1_500_000 || ppsf >= 800 || text.includes("estate") || text.includes("mountain") || (item.bedrooms || 0) >= 4) return "premium" as const;
  return "standard" as const;
}

function inferBedroomMultiplier(bedrooms: number) {
  if (bedrooms <= 1) return 0.7;
  if (bedrooms === 2) return 1.0;
  if (bedrooms === 3) return 1.32;
  if (bedrooms === 4) return 1.62;
  return 1.95;
}

function inferPropertyType(item: QueueItem) {
  if (item.propertyTypeCode === "S") return "Single Family";
  if (item.propertyTypeCode === "C") return item.subtypeCode === "TH" ? "Condominium / Townhouse" : "Condominium";
  if (item.propertyTypeCode === "L") return "Land";
  return "Property";
}

function inferMarketEligibility(item: QueueItem, region: string) {
  const city = parseCity(item.cityStateZip).toLowerCase();
  if (!region) {
    return { marketEligible: false, marketEligibleReason: "no_supported_region_match" };
  }
  if ((item.propertyTypeCode || "") === "L") {
    return { marketEligible: false, marketEligibleReason: "land_listing" };
  }
  if (!city) {
    return { marketEligible: true, marketEligibleReason: "matched_region_without_city" };
  }
  if (configuredEligibleCities.has(city)) {
    return { marketEligible: true, marketEligibleReason: "configured_city_match" };
  }
  if (item.area || item.subdivision) {
    return { marketEligible: true, marketEligibleReason: "submarket_metadata_present" };
  }
  return { marketEligible: false, marketEligibleReason: "city_not_in_supported_markets" };
}

function normalizeNightlyRentalAllowed(raw: string) {
  const value = String(raw || "").trim().toLowerCase();
  if (!value) return "";
  if (["yes", "y", "true", "allowed", "approved", "permitted"].includes(value)) return "Yes";
  if (["no", "n", "false", "not allowed", "not approved", "not permitted", "prohibited"].includes(value)) return "No";
  return raw;
}

function buildScenario(baseAdr: number, baseOcc: number, adrFactor: number, occDelta: number) {
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

function buildComparables(item: QueueItem, region: string, medium: { revenue: number; occupancy: number; adr: number }) {
  const baseAddress = item.displayAddress || `${region}, Utah`;
  const bathrooms = item.bathrooms || Math.max(item.bedrooms || 2, 2);
  const factors = [0.86, 1.0, 1.14];
  return factors.map((factor, index): Comparable => ({
    source: "market-knowledge",
    title: `${region} benchmark ${index + 1}`,
    address: index === 1 ? baseAddress : `${region}, Park City area`,
    bedrooms: item.bedrooms || 2,
    bathrooms,
    annualRevenue: round(medium.revenue * factor),
    occupancyRate: Number(clamp(medium.occupancy + (index - 1) * 0.04, 0.35, 0.8).toFixed(2)),
    averageDailyRate: round(medium.adr * factor),
    distanceMiles: Number((0.3 + index * 0.4).toFixed(1)),
  }));
}

function buildNarrative(item: QueueItem, region: string, propertyType: string, mediumRevenue: number) {
  const areaNote = item.area ? `${item.area} / ${item.subdivision || ""}`.trim() : region;
  return `${propertyType} in ${areaNote} underwritten off the ${region} market-knowledge baseline. This is an initial review-stage projection built from live FlexMLS hot-sheet data, bedroom count, price point, and submarket heuristics rather than vendor API comps. Balanced revenue comes in around $${mediumRevenue.toLocaleString("en-US")} gross annually before management and operating costs.`;
}

function buildMethodology(region: string, tier: string) {
  return `Projections generated from data/market-knowledge.md using the ${region} ADR band, bedroom multiplier, Park City seasonality, and the standard review workflow. ${tier === "premium" || tier === "luxury" ? "A premium-tier pricing assumption was used based on price point and positioning. " : "A standard-tier pricing assumption was used. "}High reflects stronger execution, medium reflects the working median case, and low includes a new-listing ramp penalty.`;
}

async function queueItems() {
  const raw = await readFile(queuePath, "utf8").catch(() => "[]");
  return JSON.parse(raw) as QueueItem[];
}

type ExistingState = {
  listingExists: boolean;
  evaluationExists: boolean;
  slackTimestamp: string;
};

async function existingMlsState() {
  const [listings, evaluations] = await Promise.all([
    readSheet("Listings").catch(() => []),
    readSheet("Evaluations").catch(() => []),
  ]);
  const state = new Map<string, ExistingState>();
  for (const row of listings as Array<Record<string, unknown>>) {
    const mls = String(row["MLS #"] || "");
    if (!mls) continue;
    const current = state.get(mls) || { listingExists: false, evaluationExists: false, slackTimestamp: "" };
    current.listingExists = true;
    state.set(mls, current);
  }
  for (const row of evaluations as Array<Record<string, unknown>>) {
    const mls = String(row["MLS #"] || "");
    if (!mls) continue;
    const current = state.get(mls) || { listingExists: false, evaluationExists: false, slackTimestamp: "" };
    current.evaluationExists = true;
    current.slackTimestamp = String(row["Slack Timestamp"] || current.slackTimestamp || "");
    state.set(mls, current);
  }
  return state;
}

async function processQueue() {
  const channel = argValue("--channel") || process.env.SLACK_CHANNEL_ID;
  if (!channel) throw new Error("Missing --channel or SLACK_CHANNEL_ID.");

  const [items, adrBands, existing, knowledge] = await Promise.all([
    queueItems(),
    parseAdrBands(),
    existingMlsState(),
    loadMarketKnowledge(),
  ]);

  const survivors: QueueItem[] = [];
  const results: Record<string, unknown>[] = [];
  const pendingListings: Record<string, unknown>[] = [];
  const pendingEvaluations: Array<{ data: EvalData; flags: Record<string, string | boolean> }> = [];
  const pendingPosts: Array<{
    item: QueueItem;
    address: string;
    region: string;
    mediumRevenue: number;
  }> = [];

  for (const item of items) {
    try {
      const current = existing.get(item.mlsNumber) || { listingExists: false, evaluationExists: false, slackTimestamp: "" };
      if (!item.mlsNumber) {
        results.push({ mlsNumber: item.mlsNumber, action: "skip_missing_mls" });
        continue;
      }
      if (current.evaluationExists && current.slackTimestamp) {
        results.push({ mlsNumber: item.mlsNumber, action: "skip_existing" });
        continue;
      }

      const nightlyRentalAllowed = normalizeNightlyRentalAllowed(item.nightlyRentalAllowed || "");
      const strApproved =
        item.strApproved === true ||
        nightlyRentalAllowed === "Yes";
      const strRejected =
        item.strApproved === false ||
        nightlyRentalAllowed === "No";
      const region = inferRegion(item);
      const city = parseCity(item.cityStateZip);
      const price = parsePrice(item.priceText);
      const propertyType = inferPropertyType(item);
      const { marketEligible, marketEligibleReason } = inferMarketEligibility(item, region);
      const pipelineDisposition =
        strRejected
          ? "skip_not_str_approved"
          : !strApproved
            ? "hold_missing_str_approval"
            : !marketEligible
              ? "skip_not_str_market"
              : "ready_for_review";

      let downloadedPhotos: string[] = [];
      if (pipelineDisposition === "ready_for_review" && Array.isArray(item.photoUrls) && item.photoUrls.length > 0) {
        const imageDownload = spawnSync("npx", ["tsx", "scripts/download-images.ts", item.mlsNumber, JSON.stringify(item.photoUrls), "1"], {
          cwd: repoRoot,
          env: process.env,
          encoding: "utf8",
        });
        if (imageDownload.status === 0) {
          try {
            const parsed = JSON.parse((imageDownload.stdout || "[]").trim() || "[]");
            if (Array.isArray(parsed)) {
              downloadedPhotos = parsed.filter((value): value is string => typeof value === "string" && value.length > 0);
            }
          } catch {
            downloadedPhotos = [];
          }
        }
      }

      const listingData = {
        mlsNumber: item.mlsNumber,
        address: item.displayAddress || [item.address, item.cityStateZip].filter(Boolean).join(", "),
        listingUrl: item.listingUrl || "",
        nightlyRentalAllowed: nightlyRentalAllowed || item.nightlyRentalAllowed || "",
        nightlyRentalAllowedSource: item.nightlyRentalAllowedSource || "",
        strApproved: strRejected ? false : strApproved ? true : undefined,
        marketEligible,
        marketEligibleReason,
        pipelineDisposition,
        city,
        region,
        price,
        bedrooms: item.bedrooms || 0,
        bathrooms: item.bathrooms || 0,
        squareFootage: item.squareFootage || 0,
        propertyType,
        amenities: [item.area, item.subdivision, item.subtypeCode].filter(Boolean),
        openHouses: item.openHouses || [],
        strEligible: pipelineDisposition === "ready_for_review" ? "Yes" : pipelineDisposition === "hold_missing_str_approval" ? "" : "No",
        status: "Active",
        listingDate: item.detectedAt ? item.detectedAt.slice(0, 10) : new Date().toISOString().slice(0, 10),
        agent: "",
        photos: downloadedPhotos.length > 0 ? downloadedPhotos : item.photoUrls || [],
      };

      const listingPath = resolve(repoRoot, `data/listing-${item.mlsNumber}.json`);
      await writeFile(listingPath, `${JSON.stringify(listingData, null, 2)}\n`);

      if (!current.listingExists) {
        pendingListings.push(buildListingRow(listingData, { source: "new_listing", status: "Active" }));
      }

      if (strRejected) {
        results.push({
          mlsNumber: item.mlsNumber,
          action: "skip_not_str_approved",
          address: item.displayAddress || item.address,
          nightlyRentalAllowed: nightlyRentalAllowed || item.nightlyRentalAllowed || "",
        });
        continue;
      }
      if (!strApproved) {
        survivors.push(item);
        results.push({
          mlsNumber: item.mlsNumber,
          action: "hold_missing_str_approval",
          address: item.displayAddress || item.address,
          nightlyRentalAllowed: nightlyRentalAllowed || item.nightlyRentalAllowed || "",
        });
        continue;
      }
      if (!marketEligible) {
        results.push({
          mlsNumber: item.mlsNumber,
          action: "skip_not_str_market",
          address: item.displayAddress || item.address,
          city,
          region,
          marketEligibleReason,
        });
        continue;
      }

      const adrBand = adrBands.get(region) || adrBands.get("Park City Core (Old Town/Main St)");
      const tier = inferTier(item, price, region);
      const bedroomMultiplier = inferBedroomMultiplier(item.bedrooms || 2);
      const baseAdr = midpoint(
        tier === "luxury" ? adrBand?.luxury || adrBand?.premium || adrBand?.standard || null : tier === "premium" ? adrBand?.premium || adrBand?.standard || null : adrBand?.standard || null,
        375,
      ) * bedroomMultiplier * (region.includes("Deer Valley") && tier !== "standard" ? 1.14 : 1);

      let baseOcc = region.includes("Deer Valley") || region.includes("Canyons") ? 0.64 : 0.58;
      if (region.includes("Heber") || region.includes("Kamas")) baseOcc -= 0.06;
      if (region.includes("Kimball") || region.includes("Pinebrook")) baseOcc -= 0.03;
      if (tier === "premium") baseOcc += 0.03;
      if (tier === "luxury") baseOcc += 0.05;
      baseOcc = clamp(baseOcc, 0.42, 0.72);

      const projections = {
        high: buildScenario(baseAdr, baseOcc, 1.12, 0.1),
        medium: buildScenario(baseAdr, baseOcc, 1, 0),
        low: buildScenario(baseAdr, baseOcc, 0.88, -0.12),
      };

      // Classify the listing with the same engine the Zillow / on-demand paths
      // use, so the Slack classification block renders sub-market, market, tier,
      // and amenities instead of always falling back to the low-confidence
      // "sub-market not recognized" warning. Projections still come from the
      // region-based ADR bands above; this only populates the display fields.
      const facts: ListingFacts = {
        price,
        squareFootage: item.squareFootage,
        bedrooms: item.bedrooms,
        area: item.area,
        subdivision: item.subdivision,
        address: item.address,
        city,
      };
      const classification = classify(facts, knowledge);

      const evalData: EvalData = {
        address: listingData.address,
        mlsNumber: item.mlsNumber,
        listingUrl: item.listingUrl || "",
        nightlyRentalAllowed: nightlyRentalAllowed || item.nightlyRentalAllowed || "",
        nightlyRentalAllowedSource: item.nightlyRentalAllowedSource || "",
        strApproved: true,
        price,
        bedrooms: item.bedrooms || 0,
        bathrooms: item.bathrooms || 0,
        squareFootage: item.squareFootage || 0,
        propertyType,
        photos: downloadedPhotos,
        projections,
        comparables: buildComparables(item, region, projections.medium),
        narrative: buildNarrative(item, region, propertyType, projections.medium.revenue),
        methodology: buildMethodology(region, tier),
        region,
        market: classification?.market || "",
        subMarket: classification?.subMarket || "",
        luxuryTier: classification?.luxuryTier || "",
        tierConfidence: classification?.tierConfidence,
        borderlineWith: classification?.borderlineWith,
        amenities: classification?.amenities || { primary: [], secondary: [] },
        confidence: classification ? "medium" : "low",
      };
      roundProjectionRevenue(evalData);
      const evalPath = inferEvalPath(item.mlsNumber);
      await writeFile(evalPath, `${JSON.stringify(evalData, null, 2)}\n`);

      if (!current.evaluationExists) {
        pendingEvaluations.push({
          data: evalData,
          flags: {
            source: "new_listing",
            status: "pending_review",
            version: "1",
            "pdf-path": `data/pdfs/${item.mlsNumber}.pdf`,
          },
        });
      }

      pendingPosts.push({
        item,
        address: evalData.address || item.displayAddress || item.mlsNumber,
        region,
        mediumRevenue: projections.medium.revenue,
      });
    } catch (error) {
      survivors.push(item);
      results.push({
        mlsNumber: item.mlsNumber,
        action: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  try {
    if (pendingListings.length > 0) {
      await appendSheetRows("Listings", pendingListings);
    }
    if (pendingEvaluations.length > 0) {
      await writeEvaluationVersionsBatch(pendingEvaluations);
    }
  } catch (error) {
    for (const pending of pendingPosts) {
      survivors.push(pending.item);
      results.push({
        mlsNumber: pending.item.mlsNumber,
        action: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
    pendingPosts.length = 0;
  }

  for (const pending of pendingPosts) {
    try {
      const reviewPost = spawnSync("npx", ["tsx", "scripts/workflows/handle-new-eval.ts", "--mls", pending.item.mlsNumber, "--channel", channel], {
        cwd: repoRoot,
        env: process.env,
        encoding: "utf8",
      });
      if (reviewPost.status !== 0) {
        throw new Error(reviewPost.stderr || reviewPost.stdout || "review post failed");
      }

      existing.set(pending.item.mlsNumber, { listingExists: true, evaluationExists: true, slackTimestamp: "posted" });
      results.push({
        mlsNumber: pending.item.mlsNumber,
        action: "evaluation_posted",
        address: pending.address,
        region: pending.region,
        mediumRevenue: pending.mediumRevenue,
      });
    } catch (error) {
      survivors.push(pending.item);
      results.push({
        mlsNumber: pending.item.mlsNumber,
        action: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  await writeFile(queuePath, `${JSON.stringify(survivors, null, 2)}\n`);
  await writeFile(resultsPath, `${JSON.stringify(results, null, 2)}\n`);
  const actionCounts = results.reduce<Record<string, number>>((counts, result) => {
    const action = typeof result.action === "string" ? result.action : "unknown";
    counts[action] = (counts[action] || 0) + 1;
    return counts;
  }, {});
  console.log(JSON.stringify({ ok: true, processed: results.length, failed: survivors.length, actionCounts, results }, null, 2));
}

await processQueue();
