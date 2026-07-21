import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { appendSheetRow, appendSheetRows, findSheetRows, readSheet, updateSheetRow } from "../sheets.ts";
import { buildEvaluationRows, type EvalComparable, type EvalData, type EvalScenario } from "../write-sheet-data.ts";
import { TIER_DISPLAY_NAME, type LuxuryTier } from "./market-knowledge.ts";

export const repoRoot = resolve(import.meta.dirname, "../..");

export type EvalSheetRow = {
  "Eval ID": string | number;
  "MLS #": string | number;
  "Version": string | number;
  "Status": string;
  "Slack Timestamp": string;
  "PDF Path": string;
  "Created At": string;
  "BD"?: string | number;
  "BA"?: string | number;
  "High Rev"?: string | number;
  "Med Rev"?: string | number;
  "Low Rev"?: string | number;
  "High Occ"?: string | number;
  "Med Occ"?: string | number;
  "Low Occ"?: string | number;
  "High ADR"?: string | number;
  "Med ADR"?: string | number;
  "Low ADR"?: string | number;
};

export type ThreadContextEvent = {
  at: string;
  kind: string;
  action?: string;
  user?: string;
  text?: string;
  note?: string;
  status?: string;
  version?: number;
  eventPath?: string;
};

export type ThreadContextRecord = {
  threadTs: string;
  evalId: string;
  mlsNumber: string;
  version: number;
  status: string;
  slackChannelId?: string;
  address: string;
  listingUrl?: string;
  propertyType: string;
  bedrooms: string | number;
  bathrooms: string | number;
  pdfPath: string;
  narrative: string;
  methodology: string;
  projections: {
    high: { revenue: number; occupancy: number; adr: number };
    medium: { revenue: number; occupancy: number; adr: number };
    low: { revenue: number; occupancy: number; adr: number };
  };
  comparables: Array<{
    title: string;
    address: string;
    revenue: number | "";
    occupancyRate: number | "";
    averageDailyRate: number | "";
    distanceMiles: number | "";
  }>;
  recentEvents: ThreadContextEvent[];
  updatedAt: string;
};

export function asNumber(value: unknown, fallback = 0) {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

export function asString(value: unknown, fallback = "") {
  return typeof value === "string" ? value : value == null ? fallback : String(value);
}

export function fmtCurrency(value: number) {
  return value.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

export function fmtPct(value: number) {
  return `${Math.round(value * 100)}%`;
}

function fmtWholeNumber(value: number) {
  return Math.round(value).toLocaleString("en-US");
}

function formatOpenHouseEntry(entry: { date?: unknown; time?: unknown; hostedBy?: unknown }) {
  const date = asString(entry.date).trim();
  const time = asString(entry.time).trim();
  const hostedBy = asString(entry.hostedBy).trim();
  return [date, time, hostedBy ? `(Host: ${hostedBy})` : ""].filter(Boolean).join(" ");
}

function buildOpenHouseLine(openHouses: unknown) {
  if (!Array.isArray(openHouses) || openHouses.length === 0) return "";
  const entries = openHouses
    .map((entry) => formatOpenHouseEntry((entry || {}) as { date?: unknown; time?: unknown; hostedBy?: unknown }))
    .filter(Boolean);
  if (entries.length === 0) return "";
  return entries.length === 1
    ? `Open House: ${entries[0]}`
    : `Open Houses: ${entries.join(" | ")}`;
}

export function inferEvalPath(mlsNumber: string | number) {
  return resolve(repoRoot, `data/eval-${String(mlsNumber)}.json`);
}

export function inferListingPath(mlsNumber: string | number) {
  return resolve(repoRoot, `data/listing-${String(mlsNumber)}.json`);
}

// Slugify the street portion of an address (everything before the city — i.e.
// the first comma-delimited segment: house number, street name, and unit if
// present) into a filesystem/Slack-safe filename stem. Falls back to the
// provided id (MLS#/ZPID) when no usable street is available.
export function pdfBaseName(address: unknown, fallbackId: string | number | undefined = "") {
  const street = String(address ?? "").split(",")[0]?.trim() ?? "";
  const slug = street.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || String(fallbackId ?? "").trim() || "evaluation";
}

// Canonical PDF path for an evaluation, named after the listing's street
// address so the generated file and Slack attachment match the property.
export function pdfPathForEval(data: { address?: unknown; mlsNumber?: string | number }) {
  return `data/pdfs/${pdfBaseName(data.address, data.mlsNumber)}.pdf`;
}

// --- R2 object keys -------------------------------------------------------
// Distinct from pdfBaseName (which stays capitalized + street-only for local
// filenames). R2 keys are LOWERCASE and use the FULL address, e.g.
// "1583 Three Kings Drive, Park City, UT 84060" -> "1583-three-kings-drive-park-city-ut-84060".

// Lowercase slug of the full address for use in R2 object keys.
export function r2AddressSlug(address: unknown): string {
  return String(address ?? "")
    .toLowerCase()
    .replace(/['’`",.#&/()]/g, "") // strip apostrophes/quotes, commas, periods, #, &, /, parens
    .replace(/[^a-z0-9]+/g, "-") // any remaining non-alnum (incl. spaces) -> hyphen
    .replace(/-+/g, "-") // collapse repeated hyphens
    .replace(/^-+|-+$/g, ""); // trim leading/trailing hyphens
}

// Fallback slug when no usable address is available: "zpid-<id>" for Zillow
// evals (mls_number like "ZPID-123"), otherwise "mls-<id>".
export function r2FallbackSlug(mlsNumber: string | number | undefined): string {
  const s = String(mlsNumber ?? "").trim();
  if (/^zpid-/i.test(s)) return `zpid-${s.replace(/^zpid-/i, "")}`.toLowerCase();
  return s ? `mls-${s}`.toLowerCase() : "evaluation";
}

// The address slug, or the id-based fallback when the address yields nothing.
export function r2KeySlug(address: unknown, mlsNumber?: string | number): string {
  const slug = r2AddressSlug(address);
  if (slug) return slug;
  const fallback = r2FallbackSlug(mlsNumber);
  if (fallback === "evaluation") {
    console.warn(
      `r2KeySlug: no address and no MLS#/ZPID available; falling back to "evaluation". ` +
        `This will collide across properties — check the calling evaluation.`,
    );
  }
  return fallback;
}

// year/month/day prefix derived from the eval's created_at (UTC date portion).
export function r2DatePrefix(createdAt: string): string {
  const m = String(createdAt).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) throw new Error(`Cannot derive R2 date prefix from createdAt: "${createdAt}"`);
  return `${m[1]}/${m[2]}/${m[3]}`;
}

// Canonical R2 object key for an evaluation: {year}/{month}/{day}/{slug}.pdf
export function r2KeyForEval(o: {
  address?: unknown;
  mlsNumber?: string | number;
  createdAt: string;
}): string {
  return `${r2DatePrefix(o.createdAt)}/${r2KeySlug(o.address, o.mlsNumber)}.pdf`;
}

// Base URL of the public PRE site (agents browse/download completed evals here).
// Overridable via PRE_SITE_URL; defaults to the live custom domain. No trailing slash.
export function preSiteBaseUrl(): string {
  return (process.env.PRE_SITE_URL || "https://evaluations.longitude.network").replace(/\/+$/, "");
}

// Canonical /properties/<slug> URL for one evaluation. The slug reproduces the
// bot's r2KeySlug() byte-for-byte, matching the PRE site's agent_site_listings
// view; the site also accepts the MLS number here and 301s to this slug, so the
// link resolves once the eval is approved and its PDF exists on the site.
export function preSitePropertyUrl(o: { address?: unknown; mlsNumber?: string | number }): string {
  return `${preSiteBaseUrl()}/properties/${r2KeySlug(o.address, o.mlsNumber)}`;
}

function normalizeThreadTs(threadTs: string) {
  return threadTs.replace(/[^0-9A-Za-z._-]/g, "_");
}

function normalizePostingKeyPart(value: string) {
  return value.replace(/[^0-9A-Za-z._-]/g, "_");
}

export function inferThreadContextPath(threadTs: string) {
  return resolve(repoRoot, "data/inbox/thread-context", `${normalizeThreadTs(threadTs)}.json`);
}

export function inferPostedReviewPath(channel: string, mlsNumber: string) {
  return resolve(
    repoRoot,
    "data/inbox/posted-reviews",
    `${normalizePostingKeyPart(channel)}-${normalizePostingKeyPart(mlsNumber)}.json`,
  );
}

export async function loadEvalData(mlsNumber: string | number) {
  const path = inferEvalPath(mlsNumber);
  const raw = await readFile(path, "utf8");
  return { path, data: JSON.parse(raw) as EvalData };
}

export async function loadListingData(mlsNumber: string | number) {
  const path = inferListingPath(mlsNumber);
  if (!existsSync(path)) return null;
  const raw = await readFile(path, "utf8");
  return { path, data: JSON.parse(raw) as Record<string, unknown> };
}

export async function readPostedReviewRecord(channel: string, mlsNumber: string) {
  const path = inferPostedReviewPath(channel, mlsNumber);
  if (!existsSync(path)) return null;
  const raw = await readFile(path, "utf8");
  return {
    path,
    record: JSON.parse(raw) as {
      channel: string;
      mlsNumber: string;
      threadTs: string;
      postedAt: string;
      source?: string;
      eventPath?: string;
      evalId?: string;
      version?: number;
    },
  };
}

export async function savePostedReviewRecord(record: {
  channel: string;
  mlsNumber: string;
  threadTs: string;
  postedAt?: string;
  source?: string;
  eventPath?: string;
  evalId?: string;
  version?: number;
}) {
  const path = inferPostedReviewPath(record.channel, record.mlsNumber);
  await mkdir(dirname(path), { recursive: true });
  const payload = {
    postedAt: new Date().toISOString(),
    ...record,
  };
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`);
  return { path, record: payload };
}

function roundToNearestHundred(n: number) {
  return Math.round(n / 100) * 100;
}

export function roundProjectionRevenue(data: EvalData) {
  if (!data.projections) return;
  for (const scenario of [data.projections.high, data.projections.medium, data.projections.low]) {
    scenario.revenue = roundToNearestHundred(scenario.revenue);
    scenario.monthly = scenario.monthly.map((month) => ({
      ...month,
      revenue: roundToNearestHundred(month.revenue),
    }));
  }
}

export async function saveEvalData(path: string, data: EvalData) {
  roundProjectionRevenue(data);
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`);
}

export async function getEvaluationRows() {
  return (await readSheet("Evaluations")) as EvalSheetRow[];
}

export function pickLatestEvaluation(rows: EvalSheetRow[]) {
  return [...rows].sort((a, b) => {
    const versionDiff = asNumber(b.Version) - asNumber(a.Version);
    if (versionDiff !== 0) return versionDiff;
    return asString(b["Created At"]).localeCompare(asString(a["Created At"]));
  })[0] || null;
}

export async function resolveEvaluationByThread(threadTs: string) {
  const rows = await getEvaluationRows();
  const matches = rows.filter((row) => asString(row["Slack Timestamp"]) === threadTs);
  const row = pickLatestEvaluation(matches);
  if (!row) {
    const threadContext = await readThreadContext(threadTs);
    if (!threadContext?.context.mlsNumber) return null;
    return resolveEvaluationByMls(threadContext.context.mlsNumber);
  }
  const mlsNumber = asString(row["MLS #"]);
  const evalData = await loadEvalData(mlsNumber);
  return { row, ...evalData };
}

export async function resolveEvaluationByMls(mlsNumber: string) {
  const rows = await getEvaluationRows();
  const matches = rows.filter((row) => asString(row["MLS #"]) === String(mlsNumber));
  const row = pickLatestEvaluation(matches);
  if (!row) return null;
  const evalData = await loadEvalData(mlsNumber);
  return { row, ...evalData };
}

function summarizeComparable(comp: EvalComparable) {
  return {
    title: asString(comp.title),
    address: asString(comp.address),
    revenue: typeof comp.annualRevenue === "number" ? comp.annualRevenue : "" as const,
    occupancyRate: typeof comp.occupancyRate === "number" ? comp.occupancyRate : "" as const,
    averageDailyRate: typeof comp.averageDailyRate === "number" ? comp.averageDailyRate : "" as const,
    distanceMiles: typeof comp.distanceMiles === "number" ? comp.distanceMiles : "" as const,
  };
}

export function buildThreadContextRecord(
  threadTs: string,
  row: EvalSheetRow,
  data: EvalData,
  extras?: {
    slackChannelId?: string;
    recentEvents?: ThreadContextEvent[];
  },
): ThreadContextRecord {
  return {
    threadTs,
    evalId: asString(row["Eval ID"]),
    mlsNumber: asString(data.mlsNumber || row["MLS #"]),
    version: asNumber(row.Version),
    status: asString(row.Status),
    slackChannelId: extras?.slackChannelId,
    address: asString(data.address),
    listingUrl: asString(data.listingUrl),
    propertyType: asString(data.propertyType),
    bedrooms: data.bedrooms ?? "",
    bathrooms: data.bathrooms ?? "",
    pdfPath: asString(row["PDF Path"]),
    narrative: asString(data.narrative),
    methodology: asString(data.methodology),
    projections: {
      high: {
        revenue: asNumber(data.projections?.high.revenue),
        occupancy: asNumber(data.projections?.high.occupancy),
        adr: asNumber(data.projections?.high.adr),
      },
      medium: {
        revenue: asNumber(data.projections?.medium.revenue),
        occupancy: asNumber(data.projections?.medium.occupancy),
        adr: asNumber(data.projections?.medium.adr),
      },
      low: {
        revenue: asNumber(data.projections?.low.revenue),
        occupancy: asNumber(data.projections?.low.occupancy),
        adr: asNumber(data.projections?.low.adr),
      },
    },
    comparables: (data.comparables ?? []).slice(0, 5).map(summarizeComparable),
    recentEvents: extras?.recentEvents ?? [],
    updatedAt: new Date().toISOString(),
  };
}

export async function readThreadContext(threadTs: string) {
  const path = inferThreadContextPath(threadTs);
  if (!existsSync(path)) return null;
  const raw = await readFile(path, "utf8");
  return { path, context: JSON.parse(raw) as ThreadContextRecord };
}

export async function upsertThreadContext(params: {
  threadTs: string;
  row: EvalSheetRow;
  data: EvalData;
  slackChannelId?: string;
  event?: Omit<ThreadContextEvent, "at"> & { at?: string };
}) {
  const dir = dirname(inferThreadContextPath(params.threadTs));
  await mkdir(dir, { recursive: true });

  const existing = await readThreadContext(params.threadTs);
  const nextEvents = [...(existing?.context.recentEvents ?? [])];
  if (params.event) {
    nextEvents.push({
      at: params.event.at || new Date().toISOString(),
      kind: params.event.kind,
      action: params.event.action,
      user: params.event.user,
      text: params.event.text,
      note: params.event.note,
      status: params.event.status,
      version: params.event.version,
      eventPath: params.event.eventPath,
    });
  }

  const context = buildThreadContextRecord(params.threadTs, params.row, params.data, {
    slackChannelId: params.slackChannelId || existing?.context.slackChannelId,
    recentEvents: nextEvents.slice(-12),
  });
  const path = inferThreadContextPath(params.threadTs);
  await writeFile(path, `${JSON.stringify(context, null, 2)}\n`);
  return { path, context };
}

export function buildProjectionReply(data: EvalData, reasoning?: string) {
  const projections = data.projections!;
  return [
    "Updated projections:",
    `- Optimized:    ${fmtCurrency(projections.high.revenue)}/yr (${fmtPct(projections.high.occupancy)} occ, ${fmtCurrency(projections.high.adr)} ADR)`,
    `- Balanced:     ${fmtCurrency(projections.medium.revenue)}/yr (${fmtPct(projections.medium.occupancy)} occ, ${fmtCurrency(projections.medium.adr)} ADR)`,
    `- Conservative: ${fmtCurrency(projections.low.revenue)}/yr (${fmtPct(projections.low.occupancy)} occ, ${fmtCurrency(projections.low.adr)} ADR)`,
    "",
    reasoning || "Updated with the requested adjustment.",
    "",
    "Say approve to generate the PDF, or keep adjusting.",
  ].join("\n");
}

export async function resolveListingUrl(data: EvalData) {
  const fromEval = asString(data.listingUrl);
  if (fromEval) return fromEval;
  if (!data.mlsNumber) return "";
  const listing = await loadListingData(data.mlsNumber);
  return listing ? asString(listing.data.listingUrl) : "";
}

export function buildListingAgentBlock(listing: { data: Record<string, unknown> } | null): string[] {
  const name = asString(listing?.data.listingAgentName).trim();
  if (!name) return [];
  const email = asString(listing?.data.listingAgentEmail).trim();
  const phone = asString(listing?.data.listingAgentPhone).trim();
  const brokerage = asString(listing?.data.listingBrokerage).trim();
  const contact = [
    name,
    email || "email not available — check listing manually",
    phone, // omitted when empty
  ].filter(Boolean).join(" • ");
  const lines = [`👤 Listing Agent: ${contact}`];
  if (brokerage) lines.push(`   Brokerage: ${brokerage}`);
  return lines;
}

export function buildClassificationBlock(data: EvalData): string[] {
  const subMarket = asString(data.subMarket);
  const market = asString(data.market);
  const tierSlug = asString(data.luxuryTier);
  const amenities = data.amenities ?? { primary: [], secondary: [] };

  if (!subMarket) {
    return ["⚠ Low confidence — sub-market not recognized, using Park City generic baseline."];
  }

  const isKnownTier = tierSlug in TIER_DISPLAY_NAME;
  const tierName = isKnownTier ? TIER_DISPLAY_NAME[tierSlug as LuxuryTier] : "";
  const locationLine = [market, subMarket, tierName].filter(Boolean).join(" • ");
  const lines: string[] = [`📍 ${locationLine}`];

  if (data.tierConfidence === "borderline" && data.borderlineWith) {
    const otherSlug = String(data.borderlineWith);
    const otherName = otherSlug in TIER_DISPLAY_NAME
      ? TIER_DISPLAY_NAME[otherSlug as LuxuryTier]
      : otherSlug;
    lines.push(`⚠ Tier classification is borderline between ${tierName} and ${otherName} — please verify.`);
  }

  const primary = amenities.primary || [];
  lines.push(primary.length > 0 ? `✨ Primary: ${primary.join(", ")}` : "✨ Primary: none detected");

  if (!primary.includes("Iconic/unique")) {
    lines.push("   Iconic/unique: not auto-detected — flag manually if applicable");
  }

  const secondary = amenities.secondary || [];
  if (secondary.length > 0) {
    lines.push(`   Secondary: ${secondary.join(", ")}`);
  }

  return lines;
}

export async function buildReviewMessage(data: EvalData) {
  const listingUrl = await resolveListingUrl(data);
  const listing = data.mlsNumber ? await loadListingData(data.mlsNumber) : null;
  const region = asString(listing?.data.region);
  const listingSource = asString(data.listingSource || listing?.data.listingSource).toLowerCase();
  const identifierLabel =
    asString(data.identifierLabel || listing?.data.identifierLabel) ||
    (asString(data.mlsNumber).toUpperCase().startsWith("ZPID-") ? "ZPID" : "MLS#");
  const price = typeof data.price === "number" ? data.price : asNumber(listing?.data.price, 0);
  const squareFootage = typeof data.squareFootage === "number" ? data.squareFootage : asNumber(listing?.data.squareFootage, 0);
  const openHouseLine = buildOpenHouseLine((data as { openHouses?: unknown }).openHouses ?? listing?.data.openHouses);
  const listingLinkLabel = listingSource.startsWith("zillow") || listingUrl.includes("zillow.com") ? "View Zillow listing" : "View MLS listing";
  const headline = [
    region,
    price > 0 ? fmtCurrency(price) : "",
    `${data.bedrooms || "?"} BD / ${data.bathrooms || "?"} BA`,
    squareFootage > 0 ? `${fmtWholeNumber(squareFootage)} sqft` : "",
    data.propertyType || "Property",
  ].filter(Boolean).join(" | ");
  const comparableCount = Array.isArray(data.comparables) ? data.comparables.length : 0;
  const maxDistance = comparableCount > 0
    ? Math.max(...data.comparables!.map((comp) => typeof comp.distanceMiles === "number" ? comp.distanceMiles : 0))
    : 0;
  const comparableLine = comparableCount > 0
    ? `Based on ${comparableCount} comparable propert${comparableCount === 1 ? "y" : "ies"} within ${maxDistance.toFixed(1)} mi | ${identifierLabel} ${data.mlsNumber}`
    : `${identifierLabel} ${data.mlsNumber}`;

  return [
    `🏠 *New STR Listing: ${data.address || `MLS ${data.mlsNumber}`}*`,
    headline,
    openHouseLine,
    listingUrl ? `<${listingUrl}|${listingLinkLabel}>` : "",
    "",
    ...buildClassificationBlock(data),
    "",
    "📊 *Revenue Projections*",
    `• Optimized:    ${fmtCurrency(data.projections!.high.revenue)}/yr (${fmtPct(data.projections!.high.occupancy)} occ, ${fmtCurrency(data.projections!.high.adr)} ADR)`,
    `• Balanced:     ${fmtCurrency(data.projections!.medium.revenue)}/yr (${fmtPct(data.projections!.medium.occupancy)} occ, ${fmtCurrency(data.projections!.medium.adr)} ADR)`,
    `• Conservative: ${fmtCurrency(data.projections!.low.revenue)}/yr (${fmtPct(data.projections!.low.occupancy)} occ, ${fmtCurrency(data.projections!.low.adr)} ADR)`,
    "",
    comparableLine,
    `<${preSitePropertyUrl(data)}|View on PRE site> (live once approved)`,
    "",
    ...buildListingAgentBlock(listing),
    "",
    "💬 Reply to adjust projections OR correct the tier / market / amenity assessment.",
    "Say *approve* when projections look right and I'll generate the PDF.",
  ].filter(Boolean).join("\n");
}

export async function writeEvaluationVersion(data: EvalData, flags: Record<string, string | boolean | undefined>) {
  roundProjectionRevenue(data);
  const rows = buildEvaluationRows(data, flags);
  await appendSheetRow("Evaluations", rows.evaluationRow);
  for (const row of rows.monthlyRows) await appendSheetRow("Monthly Projections", row);
  for (const row of rows.comparableRows) await appendSheetRow("Comparables", row);
  return rows;
}

export async function writeEvaluationVersionsBatch(entries: Array<{ data: EvalData; flags: Record<string, string | boolean | undefined> }>) {
  for (const entry of entries) roundProjectionRevenue(entry.data);
  const rowSets = entries.map((entry) => buildEvaluationRows(entry.data, entry.flags));
  if (rowSets.length === 0) return rowSets;

  await appendSheetRows("Evaluations", rowSets.map((rowSet) => rowSet.evaluationRow));

  const monthlyRows = rowSets.flatMap((rowSet) => rowSet.monthlyRows);
  if (monthlyRows.length > 0) {
    await appendSheetRows("Monthly Projections", monthlyRows);
  }

  const comparableRows = rowSets.flatMap((rowSet) => rowSet.comparableRows);
  if (comparableRows.length > 0) {
    await appendSheetRows("Comparables", comparableRows);
  }

  return rowSets;
}

export async function updateEvaluationSummaryRow(row: EvalSheetRow, patch: Partial<Record<string, unknown>>) {
  const evalId = asString(row["Eval ID"]);
  if (!evalId) throw new Error("Missing Eval ID for evaluation row update.");

  const nextRow = { ...row, ...patch };
  await updateSheetRow("Evaluations", evalId, nextRow);
  return nextRow;
}

export async function logSlackEvent(kind: string, payload: unknown) {
  const dir = resolve(repoRoot, "data/inbox/slack-events");
  await mkdir(dir, { recursive: true });
  const safeTimestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = resolve(dir, `${safeTimestamp}-${kind}.json`);
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`);
  return path;
}

export function applyScenarioMultiplier(data: EvalData, multiplier: number) {
  for (const scenario of [data.projections!.high, data.projections!.medium, data.projections!.low]) {
    scenario.revenue = Math.round(scenario.revenue * multiplier);
    scenario.adr = Math.round(scenario.adr * multiplier);
    scenario.monthly = scenario.monthly.map((month) => ({
      ...month,
      revenue: Math.round(month.revenue * multiplier),
      adr: Math.round(month.adr * multiplier),
    }));
  }
  return data;
}

export function cloneEvalData(data: EvalData) {
  return JSON.parse(JSON.stringify(data)) as EvalData;
}

export function ensureFileExists(path: string) {
  if (!existsSync(path)) throw new Error(`Missing file: ${path}`);
  return path;
}

export type AdjustmentCategory =
  | "revenue"
  | "adr"
  | "occupancy"
  | "classification-tier"
  | "classification-market"
  | "classification-amenities"
  | "general-direction";

export async function upsertAdjustmentForMls(params: {
  evalId: string;
  mlsNumber: string;
  requestedBy: string;
  requestText: string;
  category: AdjustmentCategory;
  reasoning: string;
  after: EvalData;
  fallbackBefore: EvalData;
  classification?: {
    market: string;
    subMarket: string;
    luxuryTier: string;
    amenities: { primary: string[]; secondary: string[] };
  };
}) {
  const afterHigh = params.after.projections!.high.revenue;
  const afterMed = params.after.projections!.medium.revenue;
  const afterLow = params.after.projections!.low.revenue;
  const now = new Date().toISOString();
  const stampedReasoning = `[${now}] ${params.reasoning}`;

  const classificationFields = {
    Market: params.classification?.market ?? "",
    "Sub-Market": params.classification?.subMarket ?? "",
    "Luxury Tier": params.classification?.luxuryTier ?? "",
    "Amenities (JSON)": JSON.stringify(params.classification?.amenities ?? { primary: [], secondary: [] }),
  };

  const existing = (await findSheetRows("Adjustments", "MLS #", params.mlsNumber))[0];

  if (!existing) {
    const priorHigh = params.fallbackBefore.projections!.high.revenue;
    const priorMed = params.fallbackBefore.projections!.medium.revenue;
    const priorLow = params.fallbackBefore.projections!.low.revenue;
    await appendSheetRow("Adjustments", {
      "Adj ID": randomUUID(),
      "Eval ID": params.evalId,
      "MLS #": params.mlsNumber,
      Timestamp: now,
      "Requested By": params.requestedBy,
      "Request Text": params.requestText,
      Category: params.category,
      "Prior High": priorHigh,
      "Prior Med": priorMed,
      "Prior Low": priorLow,
      "New High": afterHigh,
      "New Med": afterMed,
      "New Low": afterLow,
      "Delta %": priorMed ? (((afterMed - priorMed) / priorMed) * 100).toFixed(1) : "",
      Reasoning: stampedReasoning,
      ...classificationFields,
    });
    return;
  }

  const priorMed = Number(existing["Prior Med"]) || 0;
  const existingReasoning = asString(existing.Reasoning);
  const accumulatedReasoning = existingReasoning ? `${existingReasoning}\n\n${stampedReasoning}` : stampedReasoning;
  await updateSheetRow("Adjustments", asString(existing["Adj ID"]), {
    "Adj ID": asString(existing["Adj ID"]),
    "Eval ID": params.evalId,
    "MLS #": params.mlsNumber,
    Timestamp: now,
    "Requested By": params.requestedBy,
    "Request Text": params.requestText,
    Category: params.category,
    "Prior High": existing["Prior High"],
    "Prior Med": existing["Prior Med"],
    "Prior Low": existing["Prior Low"],
    "New High": afterHigh,
    "New Med": afterMed,
    "New Low": afterLow,
    "Delta %": priorMed ? (((afterMed - priorMed) / priorMed) * 100).toFixed(1) : "",
    Reasoning: accumulatedReasoning,
    ...classificationFields,
  });
}

export type AdjustmentScenarioKey = "high" | "medium" | "low";
export type AdjustmentField = "adr" | "occupancy" | "revenue" | "numbers";
export type AdjustmentMode = "scale" | "set" | "relative";

// Locked scenario spread. Optimized and Conservative are always derived from
// Balanced revenue by these multipliers — never set independently, never
// specified per-request. Tune here if the spread ever needs to change.
export const SCENARIO_SPREAD = { OPTIMIZED: 1.35, CONSERVATIVE: 0.75 } as const;

export type AdjustmentConstraint = {
  scenarios: AdjustmentScenarioKey[];
  field: Exclude<AdjustmentField, "numbers">;
  mode: "set";
  value: number;
};

export type AdjustmentSpec = {
  scenarios: AdjustmentScenarioKey[];
  field: AdjustmentField;
  mode: AdjustmentMode;
  value: number;
  constraints: AdjustmentConstraint[];
  anchorScenario?: AdjustmentScenarioKey;
  category: AdjustmentCategory;
  summary: string;
};

export type AdjustmentParseResult =
  | { kind: "ok"; spec: AdjustmentSpec }
  | { kind: "clarify"; message: string }
  | { kind: "none" };

const scenarioAliases: Array<{ key: AdjustmentScenarioKey; label: string; patterns: RegExp[] }> = [
  { key: "high", label: "Optimized", patterns: [/\boptimized\b/i, /\bhigh\b/i] },
  { key: "medium", label: "Balanced", patterns: [/\bbalanced\b/i, /\bmedium\b/i] },
  { key: "low", label: "Conservative", patterns: [/\bconservative\b/i, /\blow\b/i] },
];

const adjustmentVerbPattern = /\b(?:adjust|bring|drop|lower|reduce|decrease|increase|raise|bump|set|put|make)\b/i;
const scenarioClauseSplitPattern = /\b(?:but|except|while keeping|while leaving|and keep|and leave|but keep|but leave)\b|\band\b(?=\s+(?:adjust|bring|drop|lower|reduce|decrease|increase|raise|bump|set|put|make)\b)|[.;]\s*/i;
const affirmativeClausePattern = /\b(?:looks?\s+(?:good|fine|right|okay|ok|solid)|(?:is|are)\s+(?:good|fine|right|okay|ok|solid)|(?:leave|keep)\b[\s\S]*?\b(?:alone|as is|where (?:it|they) (?:is|are)|the same))\b/i;

function scenarioLabel(key: AdjustmentScenarioKey) {
  return scenarioAliases.find((candidate) => candidate.key === key)?.label || key;
}

function scenarioListLabel(keys: AdjustmentScenarioKey[]) {
  const labels = keys.map((key) => scenarioLabel(key));
  if (labels.length === 0) return "All scenarios";
  if (labels.length === 1) return labels[0];
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(", ")}, and ${labels.at(-1)}`;
}

function fieldLabel(field: Exclude<AdjustmentField, "numbers">) {
  return field === "adr" ? "ADR" : field === "occupancy" ? "occupancy" : "revenue";
}

function scenarioKeysFromText(text: string) {
  const keys = scenarioAliases
    .filter((candidate) => candidate.patterns.some((pattern) => pattern.test(text)))
    .map((candidate) => candidate.key);
  return Array.from(new Set(keys));
}

function splitScenarioClauses(text: string) {
  return text
    .split(scenarioClauseSplitPattern)
    .map((part) => part.trim())
    .filter(Boolean);
}

function affirmedScenariosFromText(text: string) {
  const clauses = splitScenarioClauses(text).filter((clause) => affirmativeClausePattern.test(clause));
  return Array.from(new Set(clauses.flatMap((clause) => scenarioKeysFromText(clause))));
}

function inferTargetScenarios(text: string, field: AdjustmentField): AdjustmentScenarioKey[] {
  const clauses = splitScenarioClauses(text);
  const targetedFromClauses = Array.from(new Set(
    clauses
      .filter((clause) =>
        !affirmativeClausePattern.test(clause) &&
        !/^\s*(?:leave|keep)\b/i.test(clause) &&
        (parseAbsoluteMetricRequest(clause) !== null || parseSignedFactor(clause) !== null || adjustmentVerbPattern.test(clause))
      )
      .flatMap((clause) => scenarioKeysFromText(clause)),
  ));
  if (targetedFromClauses.length > 0) return targetedFromClauses;

  const explicit = scenarioKeysFromText(text);
  const affirmed = affirmedScenariosFromText(text);
  const filtered = explicit.filter((scenario) => !affirmed.includes(scenario));
  if (filtered.length > 0) return filtered;
  if (explicit.length > 0) return explicit;
  if (field === "numbers") return ["high", "medium", "low"] as AdjustmentScenarioKey[];
  return [];
}

function inferField(text: string): AdjustmentField | null {
  if (/\boccupancy\b|\bocc\b/i.test(text)) return "occupancy";
  if (/\badr\b/i.test(text)) return "adr";
  if (/\brevenue\b/i.test(text)) return "revenue";
  if (/\bnumbers\b|\bprojections\b/i.test(text)) return "numbers";
  return null;
}

function primaryAdjustmentClause(text: string) {
  const parts = text.split(/\b(?:and adjust|and rescale|while keeping|while leaving|and leave|but leave)\b/i);
  return parts[0]?.trim() || text;
}

function parseSignedFactor(text: string) {
  const lower = text.toLowerCase();
  const percentMatch = lower.match(/(\d+(?:\.\d+)?)\s?%/);
  if (percentMatch) {
    const value = Number(percentMatch[1]) / 100;
    if (lower.includes("down") || lower.includes("decrease") || lower.includes("drop") || lower.includes("lower") || lower.includes("reduce")) {
      return 1 - value;
    }
    if (lower.includes("up") || lower.includes("increase") || lower.includes("raise") || lower.includes("bump")) {
      return 1 + value;
    }
  }

  if (lower.includes("far too high")) return 0.85;
  if (lower.includes("too high") || lower.includes("bump numbers down") || lower.includes("bump down")) return 0.9;
  if (lower.includes("far too low")) return 1.15;
  if (lower.includes("too low") || lower.includes("bump numbers up") || lower.includes("bump up")) return 1.1;

  if ((lower.includes("down") || lower.includes("decrease") || lower.includes("drop") || lower.includes("lower") || lower.includes("reduce")) && !lower.match(/\d+(?:\.\d+)?\s?%/)) {
    return 0.9;
  }

  if ((lower.includes("up") || lower.includes("increase") || lower.includes("raise")) && !lower.match(/\d+(?:\.\d+)?\s?%/)) {
    return 1.1;
  }

  return null;
}

function parseMagnitudeNumber(rawValue: string, rawSuffix = "") {
  const numeric = Number(String(rawValue || "").replace(/,/g, ""));
  if (!Number.isFinite(numeric)) return null;
  if (/^k$/i.test(rawSuffix)) return numeric * 1_000;
  if (/^m$/i.test(rawSuffix)) return numeric * 1_000_000;
  return numeric;
}

// Permissive match for an absolute *Balanced* revenue target. Fires before the
// general absolute matcher so balanced-revenue sets always lock the spread and
// any "optimized X% up / conservative Y% down" phrasing is ignored (structural).
// Requires balanced/medium + a preposition OR a literal $ before the number, so
// "balanced 25% down" (a scale) and relative phrasings don't get captured.
function parseBalancedRevenueTarget(text: string): number | null {
  const m = text.match(
    /\b(?:balanced|medium)\b(?:\s+revenue)?[\s\S]{0,24}?(?:\b(?:to(?:\s+be)?|should\s+be|of|at)\b\s*\$?|=\s*\$?|\$)\s*([\d,]+(?:\.\d+)?)\s*([km])?/i,
  );
  if (!m) return null;
  const value = parseMagnitudeNumber(m[1], m[2] || "");
  if (value === null || !Number.isFinite(value) || value <= 0) return null;
  return value;
}

function parseAbsoluteMetricRequest(text: string): {
  field: Exclude<AdjustmentField, "numbers">;
  value: number;
  scenarios: AdjustmentScenarioKey[];
} | null {
  const clause = primaryAdjustmentClause(text);
  const metricFirstMatch = clause.match(/\b(?:set|put|make|bring|drop|lower|reduce|decrease|increase|raise|bump)\b[\s\S]*?\b(revenue|adr|occupancy|occ)\b[\s\S]*?\b(?:at|to)\s*\$?([\d,]+(?:\.\d+)?)\s*([km])?\s*(%)?/i);
  const scenarioFieldMatch = clause.match(/\b(?:set|put|make|bring|drop|lower|reduce|decrease|increase|raise|bump)\b[\s\S]*?\b(optimized|balanced|conservative|high|medium|low)\b[\s\S]*?\b(revenue|adr|occupancy|occ)\b[\s\S]*?\b(?:at|to)\s*\$?([\d,]+(?:\.\d+)?)\s*([km])?\s*(%)?/i);
  const match = scenarioFieldMatch || metricFirstMatch;
  if (!match) return null;
  const explicitScenarioText = scenarioFieldMatch ? match[1] || "" : "";
  const rawField = String(scenarioFieldMatch ? match[2] : match[1]).toLowerCase();
  const field = rawField === "occ" ? "occupancy" : rawField;
  const numericIndex = scenarioFieldMatch ? 3 : 2;
  const suffixIndex = scenarioFieldMatch ? 4 : 3;
  const percentIndex = scenarioFieldMatch ? 5 : 4;
  const numeric = parseMagnitudeNumber(String(match[numericIndex] || ""), String(match[suffixIndex] || ""));
  if (numeric === null || !Number.isFinite(numeric)) return null;
  const value = field === "occupancy" && match[percentIndex] ? numeric / 100 : numeric;
  return {
    field: field as Exclude<AdjustmentField, "numbers">,
    value,
    scenarios: explicitScenarioText ? inferTargetScenarios(explicitScenarioText, field as AdjustmentField) : [],
  };
}

function parseConstraints(text: string, defaultScenarios: AdjustmentScenarioKey[]) {
  const matches = [...text.matchAll(/\b(?:leave|keep)\b[\s\S]*?\b(optimized|balanced|conservative|high|medium|low)?[\s\S]*?\b(adr|occupancy|occ|revenue)\b[\s\S]*?\b(?:at|to)\s*\$?([\d,]+(?:\.\d+)?)\s*([km])?\s*(%)?/gi)];
  const constraints: AdjustmentConstraint[] = [];
  for (const match of matches) {
    const explicitScenarioText = match[1] || "";
    const scenarios = explicitScenarioText
      ? inferTargetScenarios(explicitScenarioText, "adr")
      : defaultScenarios;
    if (scenarios.length === 0) {
      return { kind: "clarify" as const, message: "Say which scenario to keep fixed: optimized, balanced, or conservative." };
    }

    const rawField = String(match[2] || "").toLowerCase();
    const field = (rawField === "occ" ? "occupancy" : rawField) as Exclude<AdjustmentField, "numbers">;
    const numeric = parseMagnitudeNumber(String(match[3] || ""), String(match[4] || ""));
    if (numeric === null || !Number.isFinite(numeric)) continue;
    const value = field === "occupancy" && match[5] ? numeric / 100 : numeric;
    constraints.push({ scenarios, field, mode: "set", value });
  }
  return { kind: "ok" as const, constraints };
}

function isAdjustmentLike(text: string) {
  return /\b(adjust|bring|drop|lower|reduce|decrease|increase|raise|bump|set|put|make|keep|leave)\b/i.test(text) &&
    (/\b(adr|occupancy|occ|revenue|numbers|projections)\b/i.test(text) || /\d+(?:\.\d+)?\s?%/.test(text) || /\$\s*[\d,]+/.test(text));
}

function summarizeScale(field: AdjustmentField, scenarios: AdjustmentScenarioKey[], factor: number) {
  const direction = factor >= 1 ? "increase" : "decrease";
  const pct = Math.abs((factor - 1) * 100).toFixed(1);
  if (field === "numbers") {
    return `Applied a ${pct}% ${direction} to ${scenarioListLabel(scenarios)} ADR and linked revenue while leaving occupancy unchanged.`;
  }
  if (field === "adr") {
    return `Applied a ${pct}% ${direction} to ${scenarioListLabel(scenarios)} ADR and linked revenue while leaving occupancy unchanged.`;
  }
  if (field === "occupancy") {
    return `Applied a ${pct}% ${direction} to ${scenarioListLabel(scenarios)} occupancy while leaving ADR unchanged.`;
  }
  return `Applied a ${pct}% ${direction} to ${scenarioListLabel(scenarios)} revenue and linked ADR while leaving occupancy unchanged.`;
}

function summarizeSet(field: Exclude<AdjustmentField, "numbers">, scenarios: AdjustmentScenarioKey[], value: number) {
  const rendered = field === "occupancy" ? fmtPct(value) : fmtCurrency(value);
  return `Set ${scenarioListLabel(scenarios)} ${fieldLabel(field)} to ${rendered}.`;
}

function appendConstraintSummary(summary: string, constraints: AdjustmentConstraint[]) {
  if (constraints.length === 0) return summary;
  const parts = constraints.map((constraint) => {
    const rendered = constraint.field === "occupancy" ? fmtPct(constraint.value) : fmtCurrency(constraint.value);
    return `kept ${scenarioListLabel(constraint.scenarios)} ${fieldLabel(constraint.field)} at ${rendered}`;
  });
  return `${summary} Also ${parts.join(" and ")}.`;
}

function parseRelativeScenarioAdjustment(
  text: string,
  field: AdjustmentField,
  scenarios: AdjustmentScenarioKey[],
) {
  const anchorScenarios = affirmedScenariosFromText(text);
  if (anchorScenarios.length !== 1) return null;

  const factor = parseSignedFactor(text);
  if (!factor) return null;

  const anchorScenario = anchorScenarios[0];
  const targetScenarios = scenarios.filter((scenario) => scenario !== anchorScenario);
  if (targetScenarios.length === 0) return null;

  if (field === "occupancy" || field === "adr" || field === "revenue" || field === "numbers") {
    return { anchorScenario, targetScenarios, factor };
  }

  return null;
}

function summarizeRelative(field: AdjustmentField, scenarios: AdjustmentScenarioKey[], anchorScenario: AdjustmentScenarioKey, factor: number) {
  const pct = Math.abs((factor - 1) * 100).toFixed(1);
  const relation = factor >= 1 ? "above" : "below";
  const anchorLabel = scenarioLabel(anchorScenario);
  const targetLabel = scenarioListLabel(scenarios);

  if (field === "occupancy") {
    return `Kept ${anchorLabel} where you had it and moved ${targetLabel} to ${pct}% ${relation} ${anchorLabel} occupancy while leaving ADR unchanged.`;
  }

  if (field === "adr") {
    return `Kept ${anchorLabel} where you had it and moved ${targetLabel} to ${pct}% ${relation} ${anchorLabel} ADR while leaving occupancy unchanged.`;
  }

  return `Kept ${anchorLabel} where you had it and moved ${targetLabel} to ${pct}% ${relation} ${anchorLabel} revenue, with ${targetLabel} ADR scaled ${factor >= 1 ? "up" : "down"} and occupancy left unchanged.`;
}

export function parseAdjustmentRequest(text: string): AdjustmentParseResult {
  const lower = text.toLowerCase();
  const balancedTarget = parseBalancedRevenueTarget(text);

  if (balancedTarget === null && !isAdjustmentLike(text) && !lower.includes("premium finish") && !lower.includes("premium finishes") && !lower.includes("higher tier") && !lower.includes("luxury finish")) {
    return { kind: "none" };
  }

  if (lower.includes("premium finish") || lower.includes("premium finishes") || lower.includes("higher tier") || lower.includes("luxury finish")) {
    return {
      kind: "ok",
      spec: {
        scenarios: ["high", "medium", "low"],
        field: "numbers",
        mode: "scale",
        value: 1.14,
        constraints: [],
        category: "general-direction",
        summary: "Applied a premium-finish uplift to all scenarios' ADR and linked revenue while leaving occupancy unchanged.",
      },
    };
  }

  if (balancedTarget !== null) {
    return {
      kind: "ok",
      spec: {
        scenarios: ["medium"],
        field: "revenue",
        mode: "set",
        value: balancedTarget,
        constraints: [],
        category: "revenue",
        summary:
          `Set Balanced revenue to ${fmtCurrency(balancedTarget)}; ` +
          `Optimized auto-derived to ${fmtCurrency(Math.round(balancedTarget * SCENARIO_SPREAD.OPTIMIZED))} ` +
          `(×${SCENARIO_SPREAD.OPTIMIZED}) and Conservative to ` +
          `${fmtCurrency(Math.round(balancedTarget * SCENARIO_SPREAD.CONSERVATIVE))} (×${SCENARIO_SPREAD.CONSERVATIVE}).`,
      },
    };
  }

  const absolute = parseAbsoluteMetricRequest(text);
  const field = absolute?.field || inferField(text);
  if (!field) {
    return { kind: "clarify", message: "Say what to change: ADR, occupancy, revenue, or all projections." };
  }

  const scenarios = absolute?.scenarios?.length ? absolute.scenarios : inferTargetScenarios(text, field);
  if (scenarios.length === 0) {
    return { kind: "clarify", message: "Say which scenario to adjust: optimized, balanced, conservative, or all three." };
  }

  const constraintResult = parseConstraints(text, scenarios);
  if (constraintResult.kind === "clarify") return constraintResult;
  const constraints = constraintResult.constraints;

  if (absolute) {
    const summary = summarizeSet(absolute.field, scenarios, absolute.value);

    return {
      kind: "ok",
      spec: {
        scenarios,
        field: absolute.field,
        mode: "set",
        value: absolute.value,
        constraints,
        category: absolute.field,
        summary: appendConstraintSummary(summary, constraints),
      },
    };
  }

  const factor = parseSignedFactor(text);
  if (!factor) {
    return { kind: "clarify", message: "I can handle percentage-based ADR, occupancy, revenue, or projection changes. Rephrase with the metric and amount you want changed." };
  }

  const relative = parseRelativeScenarioAdjustment(text, field, scenarios);
  if (relative) {
    return {
      kind: "ok",
      spec: {
        scenarios: relative.targetScenarios,
        field,
        mode: "relative",
        value: relative.factor,
        constraints,
        anchorScenario: relative.anchorScenario,
        category: field === "occupancy" ? "occupancy" : field === "adr" ? "adr" : "revenue",
        summary: appendConstraintSummary(
          summarizeRelative(field, relative.targetScenarios, relative.anchorScenario, relative.factor),
          constraints,
        ),
      },
    };
  }

  const summary = appendConstraintSummary(summarizeScale(field, scenarios, factor), constraints);
  return {
    kind: "ok",
    spec: {
      scenarios,
      field,
      mode: "scale",
      value: factor,
      constraints,
      category: field === "occupancy" ? "occupancy" : field === "adr" ? "adr" : "revenue",
      summary,
    },
  };
}

function projectionScenario(data: EvalData, scenario: AdjustmentScenarioKey) {
  return scenario === "high" ? data.projections!.high : scenario === "medium" ? data.projections!.medium : data.projections!.low;
}

function clampOccupancy(value: number) {
  return Math.max(0.05, Math.min(0.95, value));
}

// Derive one spread scenario from the balanced/medium case. Revenue is locked
// to `multiplier × balanced`; the multiplier is split across ADR (^0.4) and
// occupancy (^0.6) so neither swings alone, matching the historical generation
// spread while pinning revenue exactly. The monthly series scales the same way.
function spreadScenario(medium: EvalScenario, multiplier: number): EvalScenario {
  const adrFactor = Math.pow(multiplier, 0.4);
  const occFactor = multiplier / adrFactor; // adrFactor * occFactor === multiplier
  return {
    revenue: Math.round(medium.revenue * multiplier),
    occupancy: Number(clampOccupancy(medium.occupancy * occFactor).toFixed(4)),
    adr: Math.round(medium.adr * adrFactor),
    monthly: medium.monthly.map((m) => ({
      month: m.month,
      revenue: Math.round(m.revenue * multiplier),
      occupancy: Number(clampOccupancy(m.occupancy * occFactor).toFixed(4)),
      adr: Math.round(m.adr * adrFactor),
    })),
  };
}

// Lock Optimized & Conservative to Balanced. Used at generation time and
// whenever an adjustment changes Balanced revenue.
export function deriveSpreadScenarios(medium: EvalScenario): {
  high: EvalScenario;
  medium: EvalScenario;
  low: EvalScenario;
} {
  return {
    high: spreadScenario(medium, SCENARIO_SPREAD.OPTIMIZED),
    medium,
    low: spreadScenario(medium, SCENARIO_SPREAD.CONSERVATIVE),
  };
}

function scaleScenarioMetric(data: EvalData, scenarioKey: AdjustmentScenarioKey, field: AdjustmentField, factor: number) {
  const scenario = projectionScenario(data, scenarioKey);
  if (field === "numbers" || field === "adr") {
    scenario.adr = Math.round(scenario.adr * factor);
    scenario.revenue = Math.round(scenario.revenue * factor);
    scenario.monthly = scenario.monthly.map((month) => ({
      ...month,
      adr: Math.round(month.adr * factor),
      revenue: Math.round(month.revenue * factor),
    }));
    return;
  }

  if (field === "occupancy") {
    scenario.occupancy = Number(clampOccupancy(scenario.occupancy * factor).toFixed(4));
    scenario.revenue = Math.round(scenario.revenue * factor);
    scenario.monthly = scenario.monthly.map((month) => ({
      ...month,
      occupancy: Number(clampOccupancy(month.occupancy * factor).toFixed(4)),
      revenue: Math.round(month.revenue * factor),
    }));
    return;
  }

  scenario.revenue = Math.round(scenario.revenue * factor);
  scenario.adr = Math.round(scenario.adr * factor);
  scenario.monthly = scenario.monthly.map((month) => ({
    ...month,
    adr: Math.round(month.adr * factor),
    revenue: Math.round(month.revenue * factor),
  }));
}

function setScenarioMetric(data: EvalData, scenarioKey: AdjustmentScenarioKey, field: Exclude<AdjustmentField, "numbers">, value: number) {
  const scenario = projectionScenario(data, scenarioKey);
  if (field === "occupancy") {
    if (scenario.occupancy <= 0) {
      throw new Error(`Cannot set ${scenarioLabel(scenarioKey)} occupancy because the current value is zero.`);
    }
    scaleScenarioMetric(data, scenarioKey, "occupancy", value / scenario.occupancy);
    scenario.occupancy = Number(clampOccupancy(value).toFixed(4));
    scenario.monthly = scenario.monthly.map((month) => ({
      ...month,
      occupancy: Number(clampOccupancy(month.occupancy).toFixed(4)),
    }));
    return;
  }

  const current = field === "adr" ? scenario.adr : scenario.revenue;
  if (!current) {
    throw new Error(`Cannot set ${scenarioLabel(scenarioKey)} ${fieldLabel(field)} because the current value is zero.`);
  }
  scaleScenarioMetric(data, scenarioKey, field, value / current);
  if (field === "adr") {
    scenario.adr = Math.round(value);
    scenario.monthly = scenario.monthly.map((month) => ({ ...month, adr: Math.round(month.adr) }));
    return;
  }
  scenario.revenue = Math.round(value);
}

function approximatelyEqual(left: number, right: number, tolerance: number) {
  return Math.abs(left - right) <= tolerance;
}

export function applyStructuredAdjustment(data: EvalData, spec: AdjustmentSpec) {
  if (spec.field === "revenue" && spec.constraints.some((constraint) => constraint.field !== "revenue")) {
    throw new Error("Revenue targets cannot yet be combined with fixed ADR or occupancy constraints.");
  }

  const baseline = cloneEvalData(data);

  for (const scenario of spec.scenarios) {
    if (spec.mode === "scale") {
      scaleScenarioMetric(data, scenario, spec.field, spec.value);
    } else if (spec.mode === "relative") {
      if (!spec.anchorScenario) {
        throw new Error("Relative adjustments require an anchor scenario.");
      }
      const anchor = projectionScenario(baseline, spec.anchorScenario);
      if (spec.field === "occupancy") {
        setScenarioMetric(data, scenario, "occupancy", anchor.occupancy * spec.value);
      } else if (spec.field === "adr") {
        setScenarioMetric(data, scenario, "adr", anchor.adr * spec.value);
      } else {
        setScenarioMetric(data, scenario, "revenue", anchor.revenue * spec.value);
      }
    } else {
      setScenarioMetric(data, scenario, spec.field as Exclude<AdjustmentField, "numbers">, spec.value);
    }
  }

  for (const constraint of spec.constraints) {
    for (const scenario of constraint.scenarios) {
      setScenarioMetric(data, scenario, constraint.field, constraint.value);
    }
  }

  for (const scenario of spec.scenarios) {
    const afterScenario = projectionScenario(data, scenario);
    const beforeScenario = projectionScenario(baseline, scenario);

    if (spec.mode === "scale") {
      if (spec.field === "occupancy" && !approximatelyEqual(afterScenario.occupancy, clampOccupancy(beforeScenario.occupancy * spec.value), 0.005)) {
        throw new Error(`Adjustment validation failed for ${scenarioLabel(scenario)} occupancy.`);
      }
      if (spec.field === "adr" && !approximatelyEqual(afterScenario.adr, Math.round(beforeScenario.adr * spec.value), 1)) {
        throw new Error(`Adjustment validation failed for ${scenarioLabel(scenario)} ADR.`);
      }
      if (spec.field === "revenue" && !approximatelyEqual(afterScenario.revenue, Math.round(beforeScenario.revenue * spec.value), 1)) {
        throw new Error(`Adjustment validation failed for ${scenarioLabel(scenario)} revenue.`);
      }
    } else if (spec.mode === "relative") {
      if (!spec.anchorScenario) {
        throw new Error("Relative adjustments require an anchor scenario.");
      }
      const anchor = projectionScenario(baseline, spec.anchorScenario);
      if (spec.field === "occupancy" && !approximatelyEqual(afterScenario.occupancy, clampOccupancy(anchor.occupancy * spec.value), 0.005)) {
        throw new Error(`Adjustment validation failed for ${scenarioLabel(scenario)} occupancy relative target.`);
      }
      if (spec.field === "adr" && !approximatelyEqual(afterScenario.adr, Math.round(anchor.adr * spec.value), 1)) {
        throw new Error(`Adjustment validation failed for ${scenarioLabel(scenario)} ADR relative target.`);
      }
      if ((spec.field === "revenue" || spec.field === "numbers") && !approximatelyEqual(afterScenario.revenue, Math.round(anchor.revenue * spec.value), 1)) {
        throw new Error(`Adjustment validation failed for ${scenarioLabel(scenario)} revenue relative target.`);
      }
    } else {
      const target = spec.value;
      if (spec.field === "occupancy" && !approximatelyEqual(afterScenario.occupancy, clampOccupancy(target), 0.005)) {
        throw new Error(`Adjustment validation failed for ${scenarioLabel(scenario)} occupancy target.`);
      }
      if (spec.field === "adr" && !approximatelyEqual(afterScenario.adr, Math.round(target), 1)) {
        throw new Error(`Adjustment validation failed for ${scenarioLabel(scenario)} ADR target.`);
      }
      if (spec.field === "revenue" && !approximatelyEqual(afterScenario.revenue, Math.round(target), 1)) {
        throw new Error(`Adjustment validation failed for ${scenarioLabel(scenario)} revenue target.`);
      }
    }
  }

  for (const constraint of spec.constraints) {
    for (const scenario of constraint.scenarios) {
      const afterScenario = projectionScenario(data, scenario);
      if (constraint.field === "occupancy" && !approximatelyEqual(afterScenario.occupancy, clampOccupancy(constraint.value), 0.005)) {
        throw new Error(`Constraint validation failed for ${scenarioLabel(scenario)} occupancy.`);
      }
      if (constraint.field === "adr" && !approximatelyEqual(afterScenario.adr, Math.round(constraint.value), 1)) {
        throw new Error(`Constraint validation failed for ${scenarioLabel(scenario)} ADR.`);
      }
      if (constraint.field === "revenue" && !approximatelyEqual(afterScenario.revenue, Math.round(constraint.value), 1)) {
        throw new Error(`Constraint validation failed for ${scenarioLabel(scenario)} revenue.`);
      }
    }
  }

  // Locked spread: any change to Balanced revenue re-derives Optimized &
  // Conservative from SCENARIO_SPREAD. Absolute lock — a direct Optimized/
  // Conservative edit holds only until the next Balanced change.
  if (
    data.projections &&
    baseline.projections &&
    data.projections.medium.revenue !== baseline.projections.medium.revenue
  ) {
    const relocked = deriveSpreadScenarios(data.projections.medium);
    data.projections.high = relocked.high;
    data.projections.low = relocked.low;
  }

  return { data, reasoning: spec.summary };
}

export function maybeParsePercentAdjustment(text: string) {
  const lower = text.toLowerCase();
  const percentMatch = lower.match(/(\d+(?:\.\d+)?)\s?%/);
  if (!percentMatch) return null;
  const value = Number(percentMatch[1]) / 100;
  if (lower.includes("down") || lower.includes("decrease") || lower.includes("drop") || lower.includes("lower") || lower.includes("reduce")) {
    return 1 - value;
  }
  if (lower.includes("up") || lower.includes("increase") || lower.includes("raise") || lower.includes("bump")) {
    return 1 + value;
  }
  return null;
}

export function maybeDirectionalAdjustment(text: string) {
  const lower = text.toLowerCase();

  if (lower.includes("far too high")) return 0.85;
  if (lower.includes("too high") || lower.includes("bump numbers down") || lower.includes("bump down")) return 0.9;
  if (lower.includes("far too low")) return 1.15;
  if (lower.includes("too low") || lower.includes("bump numbers up") || lower.includes("bump up")) return 1.1;

  if ((lower.includes("down") || lower.includes("decrease") || lower.includes("drop") || lower.includes("lower") || lower.includes("reduce")) && !lower.match(/\d+(?:\.\d+)?\s?%/)) {
    return 0.9;
  }

  if ((lower.includes("up") || lower.includes("increase") || lower.includes("raise")) && !lower.match(/\d+(?:\.\d+)?\s?%/)) {
    return 1.1;
  }

  return null;
}

export function maybePremiumFinishesAdjustment(text: string) {
  const lower = text.toLowerCase();
  if (lower.includes("premium finish") || lower.includes("premium finishes") || lower.includes("higher tier") || lower.includes("luxury finish")) {
    return 1.14;
  }
  return null;
}

export function summarizeStatusRows(rows: EvalSheetRow[]) {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = asString(row.Status, "unknown") || "unknown";
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return Object.fromEntries([...counts.entries()].sort((a, b) => a[0].localeCompare(b[0])));
}

export function shortEvaluationLine(row: EvalSheetRow) {
  return `MLS ${asString(row["MLS #"])} v${asNumber(row.Version)} — ${asString(row.Status)} — ${fmtCurrency(asNumber(row["Med Rev"]))} med rev`;
}
