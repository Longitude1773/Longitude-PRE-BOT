/**
 * FlexMLS "Public Open Houses" report — navigation + parsing.
 *
 * This is the report the Park City Board of REALTORS prints into its weekly
 * Wednesday open-house PDF (Menu → Daily Functions → Public Open Houses →
 * date range → Next). Each entry carries MLS #, scheduled time, listing agent
 * + brokerage, address and price — everything the open-house tracker needs
 * except STR eligibility.
 *
 * Kept free of watcher state so the watcher (which runs it on its live,
 * logged-in session via the `read_open_house_report` command) and by-hand
 * harnesses share one implementation. Parsing is a pure function so it can be
 * tested against a captured report.
 */
import type { Frame, Page } from "playwright";

export const FLEXMLS_OPEN_HOUSE_REPORT_URL =
  process.env.FLEXMLS_OPEN_HOUSE_REPORT_URL ||
  "https://pc.flexmls.com/cgi-bin/mainmenu.cgi?cmd=url+reports/touropen/index.html";

export type OpenHouseReportEntry = {
  mlsNumber: string;
  /** As printed, e.g. "Wednesday, September 30, 2026". */
  date: string;
  /** As printed, e.g. "10:00 AM". */
  startTime: string;
  endTime: string;
  /** e.g. "In-Person Public Open House". */
  type: string;
  agentName: string;
  brokerage: string;
  agentPhone: string;
  hostedBy: string;
  address: string;
  price?: number;
  bedrooms?: number;
  bathrooms?: number;
};

export type OpenHouseReport = {
  /** The date range the report header printed, e.g. "9/30/2026 To 9/30/2026". */
  header: string;
  entries: OpenHouseReportEntry[];
};

/** Per-listing facts the watcher resolves from the results grid. */
export type OpenHouseEnrichment = {
  mlsNumber: string;
  listingUrl: string;
  /** Normalized "Yes" / "No" / "" as the watcher reads it off the detail page. */
  nightlyRentalAllowed: string;
  strApproved?: boolean;
};

/** What the watcher's `read_open_house_report` command returns. */
export type OpenHouseReportResult = OpenHouseReport & {
  enrichments: OpenHouseEnrichment[];
  /** Set when enrichment failed as a whole; the report itself is still good. */
  enrichError?: string;
};

// Field labels in the order FlexMLS prints them. Values run from the end of
// one label to the start of the next one found, so a missing optional field
// (e.g. no Hosted Phone) doesn't swallow its neighbour.
const LABELS = [
  "Scheduled Time:",
  "Type:",
  "Listed by:",
  "Hosted By:",
  "Hosted Phone:",
  "Address:",
  "Price:",
  "Total Bathrooms:",
  "Total Bedrooms:",
  "Directions:",
  "Comments:",
] as const;

function collapse(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function toNumber(value: string) {
  const n = Number(value.replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) && value.trim() !== "" ? n : undefined;
}

function splitFields(block: string) {
  const fields: Partial<Record<(typeof LABELS)[number], string>> = {};
  let cursor = 0;
  const found: Array<{ label: (typeof LABELS)[number]; start: number; end: number }> = [];
  for (const label of LABELS) {
    const at = block.indexOf(label, cursor);
    if (at < 0) continue;
    found.push({ label, start: at, end: at + label.length });
    cursor = at + label.length;
  }
  for (let i = 0; i < found.length; i += 1) {
    const stop = i + 1 < found.length ? found[i + 1].start : block.length;
    fields[found[i].label] = collapse(block.slice(found[i].end, stop));
  }
  return fields;
}

/**
 * "Matthew J Magnotta of Christie's Int. RE VUE (4501) (435) 649-0891"
 *   → agent "Matthew J Magnotta", brokerage "Christie's Int. RE VUE", phone "(435) 649-0891"
 * Splits on the FIRST " of " — agent names don't contain it, brokerage names
 * sometimes do. Then peels from the END: phone, then the office code in
 * parentheses. Brokerages carry their own parentheticals ("ERA Brokers
 * Consolidated (SLC) (4023)", "Summit Sotheby's International Realty (545 Main)
 * (…)"), so only the LAST one before the phone is the office code.
 */
export function parseListedBy(raw: string) {
  const value = collapse(raw);
  const of = value.indexOf(" of ");
  if (of < 0) return { agentName: value, brokerage: "", agentPhone: "" };
  const agentName = value.slice(0, of).trim();
  let rest = value.slice(of + 4).trim();
  let agentPhone = "";
  const phone = rest.match(/\s*(\(?\d{3}\)?[\s.-]*\d{3}[\s.-]?\d{4})$/);
  if (phone) {
    agentPhone = phone[1].trim();
    rest = rest.slice(0, phone.index).trim();
  }
  rest = rest.replace(/\s*\([A-Z0-9]{2,8}\)$/, "").trim();
  return { agentName, brokerage: rest, agentPhone };
}

/** "Wednesday, September 30, 2026 10:00 AM to 01:00 PM" */
export function parseScheduledTime(raw: string) {
  const value = collapse(raw);
  const m = value.match(/^(.*?\d{4})\s+(\d{1,2}:\d{2}\s*[AP]M)\s+to\s+(\d{1,2}:\d{2}\s*[AP]M)/i);
  if (!m) return { date: value, startTime: "", endTime: "" };
  return { date: m[1].trim(), startTime: m[2].toUpperCase(), endTime: m[3].toUpperCase() };
}

export function parseOpenHouseReportText(text: string): OpenHouseReport {
  const body = collapse(text);
  const header = body.match(/Public Open House From\s+(\S+\s+To\s+\S+)/i)?.[1] || "";
  // Every entry starts with the 8-digit MLS # immediately followed by the
  // first field label.
  const starts = [...body.matchAll(/\b(\d{8})\s+Scheduled Time:/g)];
  const entries: OpenHouseReportEntry[] = [];
  for (let i = 0; i < starts.length; i += 1) {
    const from = starts[i].index ?? 0;
    const to = i + 1 < starts.length ? starts[i + 1].index ?? body.length : body.length;
    const block = body.slice(from + starts[i][1].length, to);
    const f = splitFields(block);
    const when = parseScheduledTime(f["Scheduled Time:"] || "");
    const who = parseListedBy(f["Listed by:"] || "");
    entries.push({
      mlsNumber: starts[i][1],
      date: when.date,
      startTime: when.startTime,
      endTime: when.endTime,
      type: f["Type:"] || "",
      agentName: who.agentName,
      brokerage: who.brokerage,
      agentPhone: who.agentPhone,
      hostedBy: f["Hosted By:"] || "",
      address: f["Address:"] || "",
      price: toNumber(f["Price:"] || ""),
      bedrooms: toNumber(f["Total Bedrooms:"] || ""),
      bathrooms: toNumber(f["Total Bathrooms:"] || ""),
    });
  }
  return { header, entries };
}

async function frameText(frame: Frame) {
  return (await frame.locator("body").innerText().catch(() => "")) || "";
}

async function findFrame(page: Page, test: (frame: Frame) => Promise<boolean>) {
  for (const frame of page.frames()) {
    if (await test(frame)) return frame;
  }
  return null;
}

/**
 * Run the Public Open Houses report for a single day on an already-signed-in
 * FlexMLS page. `date` is MM/DD/YYYY. Throws (with the page URL) when the form
 * or the report can't be found — callers treat that as a failed run, never as
 * "no open houses".
 */
export async function readOpenHouseReport(page: Page, date: string): Promise<OpenHouseReport & { text: string }> {
  if (!/^\d{2}\/\d{2}\/\d{4}$/.test(date)) throw new Error(`Expected MM/DD/YYYY, got "${date}".`);

  await page.goto(FLEXMLS_OPEN_HOUSE_REPORT_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  let form: Frame | null = null;
  for (let i = 0; i < 20 && !form; i += 1) {
    await page.waitForTimeout(1000);
    form = await findFrame(page, (f) => f.locator("#from_date").first().isVisible().catch(() => false));
  }
  if (!form) {
    throw new Error(`Public Open Houses form (#from_date) not found at ${page.url()} — is the session signed in?`);
  }

  await form.locator("#from_date").fill(date);
  await form.locator("#to_date").fill(date);
  const next = form.locator('input[value="Next"], button:has-text("Next"), a:has-text("Next")').first();
  await next.click();

  for (let i = 0; i < 45; i += 1) {
    await page.waitForTimeout(1000);
    const report = await findFrame(page, async (f) => /Public Open House From/i.test(await frameText(f)));
    if (!report) continue;
    // Let the list finish rendering: wait until the entry count stops moving.
    let text = await frameText(report);
    for (let settle = 0; settle < 5; settle += 1) {
      await page.waitForTimeout(1000);
      const again = await frameText(report);
      if (again.length === text.length) break;
      text = again;
    }
    return { ...parseOpenHouseReportText(text), text };
  }
  throw new Error(`Public Open Houses report did not render for ${date} (url ${page.url()}).`);
}
