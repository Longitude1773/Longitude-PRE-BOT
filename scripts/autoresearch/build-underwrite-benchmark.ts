import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { UnderwriteInput } from "../workflows/underwrite.ts";
import { benchmarkDatasetPath, type BenchmarkDataset, type BenchmarkProjection } from "./underwrite-benchmark.ts";

const repoRoot = resolve(import.meta.dirname, "../..");
const dataDir = resolve(repoRoot, "data");

type ListingRecord = {
  mlsNumber?: string;
  listingSource?: string;
  identifierLabel?: string;
  address?: string;
  listingUrl?: string;
  city?: string;
  state?: string;
  zip?: string;
  price?: number;
  bedrooms?: number;
  bathrooms?: number;
  squareFootage?: number;
  propertyType?: string;
  nightlyRentalAllowed?: string;
  nightlyRentalAllowedSource?: string;
  strApproved?: boolean;
  photos?: string[];
  amenities?: string[];
  openHouses?: Array<{ date: string; time: string; hostedBy: string }>;
  rentZestimate?: number;
  lat?: number;
  lng?: number;
};

type EvalRecord = {
  listingSource?: string;
  identifierLabel?: string;
  address?: string;
  listingUrl?: string;
  region?: string;
  confidence?: string;
  methodology?: string;
  rentZestimate?: number;
  projections?: {
    high?: BenchmarkProjection;
    medium?: BenchmarkProjection;
    low?: BenchmarkProjection;
  };
};

function hasFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function normalizeProjection(raw: BenchmarkProjection | undefined) {
  if (!raw) return null;
  if (!hasFiniteNumber(raw.revenue) || !hasFiniteNumber(raw.occupancy) || !hasFiniteNumber(raw.adr)) {
    return null;
  }
  return {
    revenue: raw.revenue,
    occupancy: raw.occupancy,
    adr: raw.adr,
  };
}

function buildInput(id: string, listing: ListingRecord, evaluation: EvalRecord): UnderwriteInput {
  return {
    listingId: String(listing.mlsNumber || id),
    listingSource: String(listing.listingSource || evaluation.listingSource || ""),
    identifierLabel: String(listing.identifierLabel || evaluation.identifierLabel || "MLS#"),
    skipMarketGate: true,
    address: String(listing.address || evaluation.address || ""),
    listingUrl: String(listing.listingUrl || evaluation.listingUrl || ""),
    city: listing.city,
    state: listing.state,
    zip: listing.zip,
    price: listing.price,
    bedrooms: listing.bedrooms,
    bathrooms: listing.bathrooms,
    squareFootage: listing.squareFootage,
    propertyType: listing.propertyType,
    area: Array.isArray(listing.amenities) ? listing.amenities[0] : undefined,
    subdivision: Array.isArray(listing.amenities) ? listing.amenities[1] : undefined,
    nightlyRentalAllowed: listing.nightlyRentalAllowed,
    nightlyRentalAllowedSource: listing.nightlyRentalAllowedSource,
    strApproved: listing.strApproved,
    openHouses: listing.openHouses,
    rentZestimate: listing.rentZestimate,
    latitude: listing.lat,
    longitude: listing.lng,
  };
}

async function main() {
  const files = await readdir(dataDir);
  const evalFiles = files.filter((file) => /^eval-.*\.json$/.test(file)).sort();
  const dataset: BenchmarkDataset = {
    version: 1,
    generatedAt: new Date().toISOString(),
    description: "Frozen underwriting benchmark built from checked-in listing/eval artifact pairs. Manual thread edits and malformed source data are excluded so the metric stays anchored to initial automatic underwriting.",
    metric: {
      name: "composite_error",
      direction: "lower",
      formula: "mean(revenue_mape) + 0.5 * mean(adr_mape) + 2.0 * mean(occupancy_mae)",
    },
    exclusions: [],
    cases: [],
  };

  for (const evalFile of evalFiles) {
    const id = evalFile.slice(5, -5);
    const listingFile = `listing-${id}.json`;
    const listingPath = resolve(dataDir, listingFile);
    const evalPath = resolve(dataDir, evalFile);

    let listing: ListingRecord;
    let evaluation: EvalRecord;
    try {
      listing = JSON.parse(await readFile(listingPath, "utf8")) as ListingRecord;
      evaluation = JSON.parse(await readFile(evalPath, "utf8")) as EvalRecord;
    } catch {
      dataset.exclusions.push({ id, reason: "missing_pair" });
      continue;
    }

    if (/Manual thread adjustment/i.test(String(evaluation.methodology || ""))) {
      dataset.exclusions.push({ id, reason: "manual_adjustment" });
      continue;
    }

    const rentZestimate = Number(listing.rentZestimate || evaluation.rentZestimate || 0);
    if (rentZestimate > 50_000) {
      dataset.exclusions.push({ id, reason: "malformed_rent_zestimate" });
      continue;
    }

    const high = normalizeProjection(evaluation.projections?.high);
    const medium = normalizeProjection(evaluation.projections?.medium);
    const low = normalizeProjection(evaluation.projections?.low);
    if (!high || !medium || !low) {
      dataset.exclusions.push({ id, reason: "missing_projection_target" });
      continue;
    }

    dataset.cases.push({
      id,
      sourceListingPath: `data/${listingFile}`,
      sourceEvalPath: `data/${evalFile}`,
      input: buildInput(id, listing, evaluation),
      target: {
        region: evaluation.region,
        confidence: evaluation.confidence,
        projections: { high, medium, low },
      },
    });
  }

  dataset.cases.sort((a, b) => a.id.localeCompare(b.id));
  dataset.exclusions.sort((a, b) => a.id.localeCompare(b.id));

  await mkdir(dirname(benchmarkDatasetPath), { recursive: true });
  await writeFile(benchmarkDatasetPath, `${JSON.stringify(dataset, null, 2)}\n`);
  console.log(JSON.stringify({
    benchmarkDatasetPath,
    cases: dataset.cases.length,
    exclusions: dataset.exclusions,
  }, null, 2));
}

await main();
