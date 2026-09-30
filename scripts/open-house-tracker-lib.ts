/**
 * Pure logic for the weekly open-house tracker (scripts/open-house-tracker.ts):
 * which Wednesday, what each sheet row says, and how a re-run merges into a
 * sheet a human may already have edited. No I/O here — it is all unit-tested.
 */
import type { OpenHouseReportEntry } from "./flexmls-open-house.ts";

export const SHEET_HEADERS = [
  "Address",
  "Agent",
  "Brokerage",
  "Open House Time",
  "STR Allowed",
  "List Price",
  "MLS Link",
  "Balanced Revenue Projection",
  "PRE Link",
] as const;

export const COL = {
  address: 0,
  agent: 1,
  brokerage: 2,
  time: 3,
  str: 4,
  price: 5,
  mlsLink: 6,
  balanced: 7,
  preLink: 8,
} as const;

/**
 * Cell values the bot writes as stand-ins. A later run may replace these;
 * anything else a cell holds (including a human's edit) is left alone.
 */
export const PLACEHOLDERS = {
  strUnknown: "Unknown – check MLS",
  notStr: "Not STR-eligible",
  evalInProgress: "Evaluation in progress",
  evalFailed: "Evaluation failed – see Slack",
  evalNoLink: "Needs evaluation (no MLS link found)",
} as const;

const REPLACEABLE = new Set<string>(["", PLACEHOLDERS.strUnknown, PLACEHOLDERS.evalInProgress, PLACEHOLDERS.evalFailed, PLACEHOLDERS.evalNoLink]);

// ---------------------------------------------------------------- dates ----

const MT = "America/Denver";

function mtParts(now: Date) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: MT, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" })
    .formatToParts(now)
    .reduce<Record<string, string>>((acc, p) => ({ ...acc, [p.type]: p.value }), {});
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), weekday: parts.weekday };
}

export type TrackerDate = {
  /** 2026-10-07 */
  iso: string;
  /** 10/07/2026 — what the FlexMLS form takes */
  mmddyyyy: string;
  /** Wed 10/7 */
  short: string;
};

export function trackerDateFromIso(iso: string): TrackerDate {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw new Error(`Expected YYYY-MM-DD, got "${iso}".`);
  const weekday = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).toLocaleDateString("en-US", {
    weekday: "short",
    timeZone: "UTC",
  });
  return { iso, mmddyyyy: `${m[2]}/${m[3]}/${m[1]}`, short: `${weekday} ${Number(m[2])}/${Number(m[3])}` };
}

/** The next Wednesday on or after today in Mountain Time: tomorrow on a Tuesday, today on a Wednesday. */
export function upcomingWednesday(now: Date): TrackerDate {
  const today = mtParts(now);
  const order = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const ahead = (3 - order.indexOf(today.weekday) + 7) % 7;
  const target = new Date(Date.UTC(today.year, today.month - 1, today.day + ahead));
  const iso = target.toISOString().slice(0, 10);
  return trackerDateFromIso(iso);
}

/** "2026.10.07 - Open House Tracker" */
export function trackerSheetName(date: TrackerDate) {
  return `${date.iso.replace(/-/g, ".")} - Open House Tracker`;
}

// ----------------------------------------------------------- formatting ----

/** "01:00 PM" → "1:00 PM" */
function tidyTime(value: string) {
  return value.replace(/^0(\d)/, "$1").trim();
}

export function formatTimeRange(start: string, end: string) {
  if (!start) return "";
  return end ? `${tidyTime(start)} – ${tidyTime(end)}` : tidyTime(start);
}

export function formatUsd(value: number) {
  return `$${Math.round(value).toLocaleString("en-US")}`;
}

function quoteFormulaString(value: string) {
  return `"${value.replace(/"/g, '""')}"`;
}

export function hyperlink(url: string, label: string) {
  return `=HYPERLINK(${quoteFormulaString(url)},${quoteFormulaString(label)})`;
}

/** MLS # out of a MLS Link cell, whether it holds the HYPERLINK formula or a bare number. */
export function mlsFromLinkCell(cell: unknown) {
  const value = String(cell ?? "").trim();
  return value.match(/,\s*"(\d{8})"\s*\)\s*$/)?.[1] || value.match(/^(\d{8})$/)?.[1] || "";
}

// ---------------------------------------------------------- evaluations ----

export type EvalRow = Record<string, unknown>;

export type EvalPick = {
  balanced?: number;
  approved: boolean;
  status: string;
};

function num(value: unknown) {
  const n = typeof value === "number" ? value : Number(String(value ?? "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

/**
 * The evaluation a tracker row should show. An approved version wins even if a
 * later version exists — its Balanced number is the one on the published PRE.
 * (Guards the known approve-resolution bug where approval lands on V2 while V3
 * is newer; see HANDOFF 2026-09-11.) Otherwise the newest version.
 */
export function pickEvaluation(rows: EvalRow[]): EvalPick | null {
  if (rows.length === 0) return null;
  const byVersion = [...rows].sort((a, b) => num(b.Version) - num(a.Version));
  const approved = byVersion.find((row) => String(row.Status) === "approved");
  const chosen = approved || byVersion[0];
  const balanced = num(chosen["Med Rev"]);
  return { balanced: balanced > 0 ? balanced : undefined, approved: Boolean(approved), status: String(chosen.Status ?? "") };
}

// ------------------------------------------------------------------ rows ----

export type StrStatus = "yes" | "no" | "unknown";

export function strStatusFrom(value: unknown): StrStatus {
  if (value === true) return "yes";
  if (value === false) return "no";
  const text = String(value ?? "").trim().toLowerCase();
  if (["yes", "y", "true", "allowed", "approved", "permitted"].includes(text)) return "yes";
  if (["no", "n", "false", "not allowed", "not approved", "not permitted"].includes(text)) return "no";
  return "unknown";
}

export type EvalState =
  | { kind: "existing"; pick: EvalPick }
  | { kind: "in-progress" }
  | { kind: "failed" }
  | { kind: "no-link" }
  | { kind: "none" };

export type TrackerRowInput = {
  entries: OpenHouseReportEntry[]; // all report entries for one MLS # (usually 1)
  str: StrStatus;
  listingUrl: string;
  evalState: EvalState;
  /** PRE site URL — only used when the chosen evaluation is approved. */
  preUrl: string;
};

export function buildTrackerRow(input: TrackerRowInput): string[] {
  const first = input.entries[0];
  const row = new Array<string>(SHEET_HEADERS.length).fill("");
  row[COL.address] = first.address;
  row[COL.agent] = first.agentName;
  row[COL.brokerage] = first.brokerage;
  row[COL.time] = input.entries.map((e) => formatTimeRange(e.startTime, e.endTime)).filter(Boolean).join("; ");
  row[COL.str] = input.str === "yes" ? "Yes" : input.str === "no" ? "No" : PLACEHOLDERS.strUnknown;
  row[COL.price] = first.price ? formatUsd(first.price) : "";
  row[COL.mlsLink] = input.listingUrl ? hyperlink(input.listingUrl, first.mlsNumber) : first.mlsNumber;

  if (input.str === "no") {
    row[COL.balanced] = PLACEHOLDERS.notStr;
  } else if (input.evalState.kind === "existing") {
    const { pick } = input.evalState;
    row[COL.balanced] = pick.balanced ? formatUsd(pick.balanced) : "";
    if (pick.approved && input.preUrl) row[COL.preLink] = hyperlink(input.preUrl, "View PRE");
  } else if (input.evalState.kind === "in-progress") {
    row[COL.balanced] = PLACEHOLDERS.evalInProgress;
  } else if (input.evalState.kind === "failed") {
    row[COL.balanced] = PLACEHOLDERS.evalFailed;
  } else if (input.evalState.kind === "no-link") {
    row[COL.balanced] = PLACEHOLDERS.evalNoLink;
  }
  return row;
}

/** Group report entries by MLS #, ordered by start time then address. */
export function groupEntries(entries: OpenHouseReportEntry[]) {
  const minutes = (t: string) => {
    const m = t.match(/(\d{1,2}):(\d{2})\s*([AP]M)/i);
    if (!m) return 24 * 60;
    return ((Number(m[1]) % 12) + (m[3].toUpperCase() === "PM" ? 12 : 0)) * 60 + Number(m[2]);
  };
  const groups = new Map<string, OpenHouseReportEntry[]>();
  for (const entry of entries) {
    const list = groups.get(entry.mlsNumber) || [];
    list.push(entry);
    groups.set(entry.mlsNumber, list);
  }
  return [...groups.values()].sort(
    (a, b) => minutes(a[0].startTime) - minutes(b[0].startTime) || a[0].address.localeCompare(b[0].address),
  );
}

// ----------------------------------------------------------------- merge ----

export type SheetMergePlan = {
  /** Single-cell writes into existing rows, A1 ranges. */
  updates: Array<{ range: string; values: string[][] }>;
  /** Rows for MLS #s the sheet doesn't have yet, in order. */
  appends: string[][];
  /** First empty row number (1-based) where appends start. */
  appendAtRow: number;
  /** What the bot has written per MLS # after this plan applies — persist for the next run. */
  lastWritten: Record<string, string[]>;
};

/**
 * Compare cell values the way Sheets stores them: "$64,000" typed in reads
 * back as 64000 under valueRenderOption=FORMULA.
 */
function canon(value: unknown) {
  const text = String(value ?? "").trim();
  if (/^\$?-?[\d,]+(\.\d+)?$/.test(text)) return String(Number(text.replace(/[$,]/g, "")));
  return text;
}

function columnLetter(index: number) {
  return String.fromCharCode("A".charCodeAt(0) + index);
}

/**
 * Merge freshly built rows into what the sheet holds now (read with
 * valueRenderOption=FORMULA, header row included). Existing rows are matched by
 * MLS #. A cell is rewritten only when it is blank, holds a bot placeholder, or
 * still holds exactly what the bot wrote last run (`lastWritten`) — so a
 * Balanced number that moved after an adjustment follows it, but any cell a
 * human changed is left alone. A bare MLS # in the link column may be upgraded
 * to a link. Rows no longer on the report are left alone.
 */
export function planSheetMerge(
  existing: unknown[][],
  fresh: string[][],
  sheetTitle: string,
  lastWritten: Record<string, string[]> = {},
): SheetMergePlan {
  const rowByMls = new Map<string, number>();
  let lastUsedRow = 1;
  existing.forEach((cells, index) => {
    if (index === 0) return; // header
    if (cells.some((c) => String(c ?? "").trim() !== "")) lastUsedRow = index + 1;
    const mls = mlsFromLinkCell(cells[COL.mlsLink]);
    if (mls && !rowByMls.has(mls)) rowByMls.set(mls, index + 1);
  });

  const updates: SheetMergePlan["updates"] = [];
  const appends: string[][] = [];
  const nextWritten: Record<string, string[]> = { ...lastWritten };
  const quotedTitle = `'${sheetTitle.replace(/'/g, "''")}'`;

  for (const row of fresh) {
    const mls = mlsFromLinkCell(row[COL.mlsLink]);
    const rowNumber = rowByMls.get(mls);
    if (!rowNumber) {
      appends.push(row);
      nextWritten[mls] = [...row];
      continue;
    }
    const current = existing[rowNumber - 1] || [];
    const prior = lastWritten[mls] || [];
    const written = [...prior];
    row.forEach((value, col) => {
      if (!value) return;
      const now = String(current[col] ?? "").trim();
      if (canon(now) === canon(value)) return;
      const replaceable =
        REPLACEABLE.has(now) ||
        (prior[col] !== undefined && prior[col] !== "" && canon(now) === canon(prior[col])) ||
        (col === COL.mlsLink && now === mls && value.startsWith("=HYPERLINK("));
      if (!replaceable) return;
      updates.push({ range: `${quotedTitle}!${columnLetter(col)}${rowNumber}`, values: [[value]] });
      written[col] = value;
    });
    nextWritten[mls] = written;
  }
  return { updates, appends, appendAtRow: lastUsedRow + 1, lastWritten: nextWritten };
}
