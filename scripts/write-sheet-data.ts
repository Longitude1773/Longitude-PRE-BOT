import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { appendSheetRow } from "./sheets.ts";

type JsonObject = Record<string, unknown>;

export type EvalMonthly = {
  month: string;
  revenue: number;
  occupancy: number;
  adr: number;
};

export type EvalScenario = {
  revenue: number;
  occupancy: number;
  adr: number;
  monthly: EvalMonthly[];
};

export type EvalComparable = {
  source?: string;
  title?: string;
  address?: string;
  bedrooms?: number;
  bathrooms?: number;
  annualRevenue?: number;
  occupancyRate?: number;
  averageDailyRate?: number;
  distanceMiles?: number;
};

export type EvalGroundingSource = {
  kind?: string;
  label?: string;
  url?: string;
  tool?: string;
  note?: string;
};

export type EvalGrounding = {
  summary?: string;
  sources?: EvalGroundingSource[];
};

export type EvalDecision = "estimate" | "escalate";

export type EvalData = {
  address?: string;
  mlsNumber?: string | number;
  listingUrl?: string;
  listingSource?: string;
  identifierLabel?: string;
  nightlyRentalAllowed?: string;
  nightlyRentalAllowedSource?: string;
  strApproved?: boolean;
  price?: number;
  bedrooms?: number;
  bathrooms?: number;
  squareFootage?: number;
  propertyType?: string;
  narrative?: string;
  methodology?: string;
  decision?: EvalDecision;
  decisionReason?: string;
  photos?: string[];
  region?: string;
  confidence?: string;
  rentZestimate?: number;
  grounding?: EvalGrounding;
  projections?: {
    high: EvalScenario;
    medium: EvalScenario;
    low: EvalScenario;
  };
  comparables?: EvalComparable[];
};

function usage() {
  console.error(
    "Usage:\n" +
    '  tsx scripts/write-sheet-data.ts listing <json-file> [--source new_listing] [--status Active] [--dry-run]\n' +
    '  tsx scripts/write-sheet-data.ts evaluation <json-file> [--eval-id <uuid>] [--version 1] [--source new_listing] [--status draft] [--pdf-path data/pdfs/123.pdf] [--dry-run]'
  );
  process.exit(1);
}

function parseArgs(args: string[]) {
  if (args.length < 2) usage();

  const [mode, filePath, ...rest] = args;
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (!token.startsWith("--")) {
      throw new Error(`Unexpected argument: ${token}`);
    }

    const key = token.slice(2);
    const next = rest[i + 1];
    if (!next || next.startsWith("--")) {
      flags[key] = true;
      continue;
    }

    flags[key] = next;
    i += 1;
  }

  return { mode, filePath, flags };
}

function asObject(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a JSON object.");
  }
  return value as JsonObject;
}

function getFirstString(obj: JsonObject, keys: string[]) {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return "";
}

function getFirstNumber(obj: JsonObject, keys: string[]) {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "number") {
      return value;
    }
    if (typeof value === "string" && value.trim() !== "") {
      const parsed = Number(value);
      if (!Number.isNaN(parsed)) {
        return parsed;
      }
    }
  }
  return "";
}

function getJsonField(obj: JsonObject, keys: string[]) {
  for (const key of keys) {
    const value = obj[key];
    if (Array.isArray(value)) {
      return JSON.stringify(value);
    }
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return "[]";
}

function deriveCity(address: string) {
  const parts = address.split(",").map((part) => part.trim()).filter(Boolean);
  return parts[1] ?? "";
}

export function buildListingRow(input: JsonObject, flags: Record<string, string | boolean>) {
  const address = getFirstString(input, ["Address", "address"]);

  return {
    "MLS #": getFirstString(input, ["MLS #", "mlsNumber"]),
    "Listing Source": String(flags.source || getFirstString(input, ["Listing Source", "listingSource"]) || "new_listing"),
    "Listing URL": getFirstString(input, ["Listing URL", "listingUrl"]),
    Address: address,
    City: getFirstString(input, ["City", "city"]) || deriveCity(address),
    Region: getFirstString(input, ["Region", "region"]),
    Price: getFirstNumber(input, ["Price", "price"]),
    BD: getFirstNumber(input, ["BD", "Bed", "bedrooms"]),
    BA: getFirstNumber(input, ["BA", "Bath", "bathrooms"]),
    SqFt: getFirstNumber(input, ["SqFt", "squareFootage"]),
    Type: getFirstString(input, ["Type", "propertyType"]),
    "Amenities (JSON)": getJsonField(input, ["Amenities (JSON)", "amenities"]),
    "STR Eligible": getFirstString(input, ["STR Eligible", "strEligible"]),
    Status: String(flags.status || getFirstString(input, ["Status", "status"]) || "Active"),
    "Listing Date": getFirstString(input, ["Listing Date", "listingDate"]),
    Agent: getFirstString(input, ["Agent", "agent"]),
    "Photos (JSON)": getJsonField(input, ["Photos (JSON)", "photos"]),
    Lat: getFirstNumber(input, ["Lat", "lat"]),
    Lng: getFirstNumber(input, ["Lng", "lng"]),
    "Scraped At": getFirstString(input, ["Scraped At", "scrapedAt"]) || new Date().toISOString(),
    "Open House (JSON)": getJsonField(input, ["Open House (JSON)", "openHouse", "openHouses"]),
  };
}

export function buildEvaluationRows(input: EvalData, flags: Record<string, string | boolean>) {
  if (!input.mlsNumber || !input.projections) {
    throw new Error("Evaluation JSON must include mlsNumber and projections.");
  }

  const evalId = typeof flags["eval-id"] === "string" ? flags["eval-id"] : randomUUID();
  const version = typeof flags.version === "string" ? Number(flags.version) : 1;
  const listingSource = String(flags.source || "new_listing");
  const createdAt = typeof flags["created-at"] === "string" ? flags["created-at"] : new Date().toISOString();
  const pdfPath = typeof flags["pdf-path"] === "string" ? flags["pdf-path"] : `data/pdfs/${input.mlsNumber}.pdf`;
  const slackTimestamp = typeof flags["slack-ts"] === "string" ? flags["slack-ts"] : "";
  const status = typeof flags.status === "string" ? flags.status : "draft";

  const evaluationRow = {
    "Eval ID": evalId,
    "MLS #": String(input.mlsNumber),
    "Listing Source": listingSource,
    BD: input.bedrooms ?? "",
    BA: input.bathrooms ?? "",
    Version: version,
    "High Rev": input.projections.high.revenue,
    "Med Rev": input.projections.medium.revenue,
    "Low Rev": input.projections.low.revenue,
    "High Occ": input.projections.high.occupancy,
    "Med Occ": input.projections.medium.occupancy,
    "Low Occ": input.projections.low.occupancy,
    "High ADR": input.projections.high.adr,
    "Med ADR": input.projections.medium.adr,
    "Low ADR": input.projections.low.adr,
    Status: status,
    "Slack Timestamp": slackTimestamp,
    "PDF Path": pdfPath,
    "Created At": createdAt,
  };

  const monthlyRows = input.projections.high.monthly.map((highMonth, index) => ({
    "Eval ID": evalId,
    Month: highMonth.month,
    "High Rev": highMonth.revenue,
    "Med Rev": input.projections!.medium.monthly[index]?.revenue ?? "",
    "Low Rev": input.projections!.low.monthly[index]?.revenue ?? "",
    "High Occ": highMonth.occupancy,
    "Med Occ": input.projections!.medium.monthly[index]?.occupancy ?? "",
    "Low Occ": input.projections!.low.monthly[index]?.occupancy ?? "",
    "High ADR": highMonth.adr,
    "Med ADR": input.projections!.medium.monthly[index]?.adr ?? "",
    "Low ADR": input.projections!.low.monthly[index]?.adr ?? "",
  }));

  const comparableRows = (input.comparables ?? []).map((comp) => ({
    "Eval ID": evalId,
    Source: comp.source ?? "",
    Title: comp.title ?? "",
    Address: comp.address ?? "",
    BD: comp.bedrooms ?? "",
    BA: comp.bathrooms ?? "",
    Revenue: comp.annualRevenue ?? "",
    "Occ Rate": comp.occupancyRate ?? "",
    ADR: comp.averageDailyRate ?? "",
    "Distance (mi)": comp.distanceMiles ?? "",
  }));

  return { evalId, evaluationRow, monthlyRows, comparableRows };
}

async function readJsonFile(path: string) {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

async function main() {
  const { mode, filePath, flags } = parseArgs(process.argv.slice(2));
  const data = await readJsonFile(filePath);

  if (mode === "listing") {
    const row = buildListingRow(asObject(data), flags);
    if (flags["dry-run"]) {
      console.log(JSON.stringify(row, null, 2));
      return;
    }

    const result = await appendSheetRow("Listings", row);
    console.log(result.message || "Listings row appended");
    return;
  }

  if (mode === "evaluation") {
    const rows = buildEvaluationRows(data as EvalData, flags);

    if (flags["dry-run"]) {
      console.log(JSON.stringify(rows, null, 2));
      return;
    }

    await appendSheetRow("Evaluations", rows.evaluationRow);
    for (const row of rows.monthlyRows) {
      await appendSheetRow("Monthly Projections", row);
    }
    for (const row of rows.comparableRows) {
      await appendSheetRow("Comparables", row);
    }

    console.log(
      `Wrote evaluation ${rows.evalId}: ` +
      `1 evaluation row, ${rows.monthlyRows.length} monthly rows, ${rows.comparableRows.length} comparable rows`
    );
    return;
  }

  usage();
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1])) {
  await main();
}
