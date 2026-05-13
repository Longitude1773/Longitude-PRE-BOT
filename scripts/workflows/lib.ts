import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { appendSheetRow, appendSheetRows, findSheetRows, readSheet, updateSheetRow } from "../sheets.ts";
import { buildEvaluationRows, type EvalComparable, type EvalData } from "../write-sheet-data.ts";

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
    "📊 *Revenue Projections*",
    `• Optimized:    ${fmtCurrency(data.projections!.high.revenue)}/yr (${fmtPct(data.projections!.high.occupancy)} occ, ${fmtCurrency(data.projections!.high.adr)} ADR)`,
    `• Balanced:     ${fmtCurrency(data.projections!.medium.revenue)}/yr (${fmtPct(data.projections!.medium.occupancy)} occ, ${fmtCurrency(data.projections!.medium.adr)} ADR)`,
    `• Conservative: ${fmtCurrency(data.projections!.low.revenue)}/yr (${fmtPct(data.projections!.low.occupancy)} occ, ${fmtCurrency(data.projections!.low.adr)} ADR)`,
    "",
    comparableLine,
    "",
    "💬 Reply in this thread to request adjustments or ask questions about the underwriting.",
    "Say *approve* when projections look right and I'll generate the PDF.",
  ].filter(Boolean).join("\n");
}

export async function writeEvaluationVersion(data: EvalData, flags: Record<string, string | boolean>) {
  roundProjectionRevenue(data);
  const rows = buildEvaluationRows(data, flags);
  await appendSheetRow("Evaluations", rows.evaluationRow);
  for (const row of rows.monthlyRows) await appendSheetRow("Monthly Projections", row);
  for (const row of rows.comparableRows) await appendSheetRow("Comparables", row);
  return rows;
}

export async function writeEvaluationVersionsBatch(entries: Array<{ data: EvalData; flags: Record<string, string | boolean> }>) {
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

export function computeProjectionDelta(before: EvalData, after: EvalData) {
  const prior = before.projections!.medium.revenue;
  const next = after.projections!.medium.revenue;
  if (!prior) return "";
  return (((next - prior) / prior) * 100).toFixed(1);
}

export function cloneEvalData(data: EvalData) {
  return JSON.parse(JSON.stringify(data)) as EvalData;
}

export function ensureFileExists(path: string) {
  if (!existsSync(path)) throw new Error(`Missing file: ${path}`);
  return path;
}

export async function appendAdjustmentRow(row: Record<string, unknown>) {
  await appendSheetRow("Adjustments", row);
}

export type AdjustmentScenarioKey = "high" | "medium" | "low";
export type AdjustmentField = "adr" | "occupancy" | "revenue" | "numbers";
export type AdjustmentMode = "scale" | "set" | "relative";

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
  propagateScaleTo?: AdjustmentScenarioKey[];
  category: string;
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

  if (!isAdjustmentLike(text) && !lower.includes("premium finish") && !lower.includes("premium finishes") && !lower.includes("higher tier") && !lower.includes("luxury finish")) {
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
        category: "finishes",
        summary: "Applied a premium-finish uplift to all scenarios' ADR and linked revenue while leaving occupancy unchanged.",
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
    const propagateScaleTo = absolute.field === "revenue" &&
      scenarios.length === 1 &&
      scenarios[0] === "medium" &&
      /\boptimized\b[\s\S]*?\bconservative\b[\s\S]*?(?:from there|proportionally|from that baseline)/i.test(text)
        ? ["high", "low"] as AdjustmentScenarioKey[]
        : undefined;

    const summary = propagateScaleTo
      ? `Set Balanced revenue to ${fmtCurrency(absolute.value)} and rescaled Optimized and Conservative ADR/revenue proportionally while leaving occupancy unchanged.`
      : summarizeSet(absolute.field, scenarios, absolute.value);

    return {
      kind: "ok",
      spec: {
        scenarios,
        field: absolute.field,
        mode: "set",
        value: absolute.value,
        constraints,
        propagateScaleTo,
        category: absolute.field === "revenue" ? "targeted-revenue" : "targeted-metric",
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
        category: field === "occupancy" ? "occupancy-relative" : field === "adr" ? "adr-relative" : "anchored-comparison",
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
      category: field === "occupancy" ? "occupancy" : field === "adr" ? "adr" : field === "revenue" ? "revenue" : "general-direction",
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

  if (spec.propagateScaleTo && spec.scenarios.length === 1) {
    const anchor = spec.scenarios[0];
    const beforeScenario = projectionScenario(baseline, anchor);
    const afterScenario = projectionScenario(data, anchor);
    const factor = beforeScenario.revenue > 0 ? afterScenario.revenue / beforeScenario.revenue : 1;
    for (const scenario of spec.propagateScaleTo) {
      scaleScenarioMetric(data, scenario, "revenue", factor);
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
