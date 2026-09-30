/**
 * Weekly open-house tracker.
 *
 * Builds a Google Sheet of every Wednesday open house (the Park City Board of
 * REALTORS weekly tour) with agent, brokerage, time, STR eligibility, price,
 * MLS link, Balanced revenue and PRE link, in
 * Longitude Master › Longitude Management › Revenue › sales › Open House Tracker,
 * named "YYYY.MM.DD - Open House Tracker".
 *
 * Runs twice per week (launchd, deploy/launchd/com.longitude.pre-bot.open-house-*.plist):
 *   Tue 15:00 MT — creates the sheet and starts evaluations for STR-eligible
 *                  listings that have none (posted to Slack, labeled 📅)
 *   Wed 08:00 MT — same command again: appends late additions (tours may be
 *                  entered until 4pm Tuesday) and fills PRE links approved overnight
 * Every run is idempotent against the same sheet: it only fills blank/placeholder
 * cells or cells still holding what the bot last wrote, so edits in the sheet survive.
 *
 * FlexMLS work goes through the MLS watcher's command queue
 * (`read_open_house_report`), on its live signed-in session — this script has no
 * browser of its own. Source: FlexMLS Menu → Public Open Houses, the same report
 * the Board prints into its PDF.
 *
 * Usage:
 *   npx tsx scripts/open-house-tracker.ts               # the scheduled run (upcoming Wednesday)
 *   npx tsx scripts/open-house-tracker.ts --dry-run     # read FlexMLS + Supabase only → CSV, nothing written
 *   npx tsx scripts/open-house-tracker.ts --date 2026-10-07 --no-evals --no-slack
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { OpenHouseEnrichment, OpenHouseReportResult } from "./flexmls-open-house.ts";
import {
  COL,
  PLACEHOLDERS,
  SHEET_HEADERS,
  buildTrackerRow,
  groupEntries,
  pickEvaluation,
  planSheetMerge,
  strStatusFrom,
  trackerDateFromIso,
  trackerSheetName,
  upcomingWednesday,
  type EvalRow,
  type EvalState,
  type StrStatus,
  type TrackerDate,
} from "./open-house-tracker-lib.ts";
import { openHouseLedgerDir, readOpenHouseLedger, writeOpenHouseLedger, type OpenHouseRunRecord } from "./open-house-ledger.ts";

const repoRoot = resolve(import.meta.dirname, "..");

// Same minimal loader as the other by-hand scripts. Must run before the
// Supabase / Slack modules load — they read credentials at import time — so
// those are imported dynamically below.
try {
  for (const line of readFileSync(resolve(repoRoot, ".env"), "utf8").split("\n")) {
    const i = line.indexOf("=");
    if (i > 0 && !line.trimStart().startsWith("#")) {
      const key = line.slice(0, i).trim();
      if (!process.env[key]) process.env[key] = line.slice(i + 1).trim();
    }
  }
} catch {
  /* env supplied by the environment instead */
}

// Longitude Master › Longitude Management › Revenue › sales › Open House Tracker
const DEFAULT_FOLDER_ID = "1bgsLA7dWRvonPFqvUwStyusaUUV5N_3Z";
const SHEET_TAB_TITLE = "Open Houses";
const EVAL_TIMEOUT_MS = 15 * 60 * 1000;
const REPORT_TIMEOUT_MS = Number(process.env.OPEN_HOUSE_REPORT_TIMEOUT_MS || 30 * 60 * 1000);

function argValue(flag: string) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const args = {
  date: argValue("--date"),
  dryRun: process.argv.includes("--dry-run"),
  noEvals: process.argv.includes("--no-evals"),
  noSlack: process.argv.includes("--no-slack"),
  maxEvals: Number(argValue("--max-evals") || 20),
};

function log(message: string) {
  console.log(`[${new Date().toISOString()}] open-house-tracker: ${message}`);
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}

async function runWatcherReport(date: TrackerDate, enrichMls: string[]): Promise<OpenHouseReportResult> {
  const { enqueueMlsCommand, waitForMlsCommandResult } = await import("./workflows/mls-control.ts");
  const command = await enqueueMlsCommand({ type: "read_open_house_report", date: date.mmddyyyy, enrichMls });
  log(`asked the MLS watcher for the ${date.mmddyyyy} report (command ${command.id}, enriching ${enrichMls.length})`);
  const result = await waitForMlsCommandResult(command.id, REPORT_TIMEOUT_MS);
  if (!result) throw new Error(`MLS watcher did not answer the open-house report command within ${REPORT_TIMEOUT_MS / 60000} min.`);
  if (result.action !== "read_open_house_report") throw new Error(`Unexpected watcher result action ${result.action}.`);
  if (!result.ok) throw new Error(`MLS watcher could not read the open-house report: ${result.error}`);
  return result.data;
}

function runEval(url: string, label: string): Promise<{ ok: boolean; error: string }> {
  return new Promise((done) => {
    const child = spawn("npx", ["tsx", "scripts/workflows/create-on-demand-eval-manual.ts", "--url", url, "--label", label], {
      cwd: repoRoot,
      env: process.env,
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    const timer = setTimeout(() => child.kill("SIGTERM"), EVAL_TIMEOUT_MS);
    child.on("close", (code) => {
      clearTimeout(timer);
      const tail = output.trim().split("\n").slice(-3).join(" ").slice(0, 400);
      done({ ok: code === 0, error: code === 0 ? "" : tail || `exit ${code}` });
    });
  });
}

type ListingFacts = { str: StrStatus; listingUrl: string; address: string };

async function main() {
  const date = args.date ? trackerDateFromIso(args.date) : upcomingWednesday(new Date());
  const sheetName = trackerSheetName(date);
  log(`target ${date.iso} (${date.short}) → "${sheetName}"${args.dryRun ? " [DRY RUN]" : ""}`);

  const ledger = await readOpenHouseLedger(date.iso);
  const run: OpenHouseRunRecord = {
    mode: args.dryRun ? "dry-run" : ledger.sheetId ? "update" : "create",
    startedAt: new Date().toISOString(),
    entries: 0,
    rowsAdded: 0,
    cellsFilled: 0,
    evalsStarted: [],
    evalsFailed: [],
  };
  const warnings: string[] = [];

  const { readSheet } = await import("./sheets.ts");
  const { preSitePropertyUrl } = await import("./workflows/lib.ts");
  const { readMlsState } = await import("./workflows/mls-control.ts");

  const state = await readMlsState();
  if (!text(state.updatedAt)) throw new Error("MLS watcher is not running (no state file) — it does the FlexMLS work for this job.");

  // --- 1. Which open houses? ---------------------------------------------
  let report = await runWatcherReport(date, []);
  run.entries = report.entries.length;
  log(`report: ${report.entries.length} open houses (${report.header})`);
  if (report.entries.length === 0) warnings.push("FlexMLS returned no open houses for this date — worth a manual check.");

  // --- 2. What we already know, and what the watcher must look up --------
  const loadIndex = async () => {
    const listings = (await readSheet("Listings")) as EvalRow[];
    const evaluations = (await readSheet("Evaluations")) as EvalRow[];
    const listingByMls = new Map(listings.map((row) => [text(row["MLS #"]), row]));
    const evalsByMls = new Map<string, EvalRow[]>();
    for (const row of evaluations) {
      const mls = text(row["MLS #"]);
      evalsByMls.set(mls, [...(evalsByMls.get(mls) || []), row]);
    }
    return { listingByMls, evalsByMls };
  };
  let index = await loadIndex();

  const groups = groupEntries(report.entries);
  const needsLookup = groups
    .map((g) => g[0].mlsNumber)
    .filter((mls) => {
      const listing = index.listingByMls.get(mls);
      return !listing || strStatusFrom(listing["STR Eligible"]) === "unknown" || !text(listing["Listing URL"]);
    });

  let enrichments = new Map<string, OpenHouseEnrichment>();
  if (needsLookup.length > 0) {
    report = await runWatcherReport(date, needsLookup);
    enrichments = new Map(report.enrichments.map((e) => [e.mlsNumber, e]));
    if (report.enrichError) warnings.push(`FlexMLS lookup for listings new to the bot failed: ${report.enrichError}`);
    else if (report.enrichments.length < needsLookup.length) {
      warnings.push(`FlexMLS lookup found only ${report.enrichments.length} of ${needsLookup.length} listings new to the bot.`);
    }
    log(`enriched ${report.enrichments.length}/${needsLookup.length} listings not already in Supabase`);
  }

  const factsFor = (mls: string, fallbackAddress: string): ListingFacts => {
    const listing = index.listingByMls.get(mls);
    const fresh = enrichments.get(mls);
    const freshStr = fresh ? strStatusFrom(fresh.strApproved ?? fresh.nightlyRentalAllowed) : "unknown";
    return {
      str: freshStr !== "unknown" ? freshStr : strStatusFrom(listing?.["STR Eligible"]),
      listingUrl: text(fresh?.listingUrl) || text(listing?.["Listing URL"]),
      address: text(listing?.Address) || fallbackAddress,
    };
  };

  // --- 3. Rows ------------------------------------------------------------
  const evalCandidates: Array<{ mls: string; url: string; label: string }> = [];
  const pendingEval = new Set<string>();
  const failedEval = new Set<string>();

  const buildRows = () =>
    groups.map((entries) => {
      const mls = entries[0].mlsNumber;
      const facts = factsFor(mls, entries[0].address);
      const pick = pickEvaluation(index.evalsByMls.get(mls) || []);
      let evalState: EvalState = { kind: "none" };
      if (pick) evalState = { kind: "existing", pick };
      else if (failedEval.has(mls)) evalState = { kind: "failed" };
      else if (pendingEval.has(mls)) evalState = { kind: "in-progress" };
      else if (facts.str === "yes" && !facts.listingUrl) evalState = { kind: "no-link" };
      return buildTrackerRow({
        entries,
        str: facts.str,
        listingUrl: facts.listingUrl,
        evalState,
        preUrl: preSitePropertyUrl({ address: facts.address, mlsNumber: mls }),
      });
    });

  for (const entries of groups) {
    const mls = entries[0].mlsNumber;
    const facts = factsFor(mls, entries[0].address);
    if (facts.str !== "yes" || !facts.listingUrl) continue;
    if ((index.evalsByMls.get(mls) || []).length > 0) continue;
    const time = buildTrackerRow({ entries, str: "yes", listingUrl: "", evalState: { kind: "none" }, preUrl: "" })[COL.time];
    evalCandidates.push({ mls, url: facts.listingUrl, label: `*📅 Open house · ${date.short} · ${time}*` });
  }
  const evalsToRun = args.dryRun || args.noEvals ? [] : evalCandidates.slice(0, args.maxEvals);
  if (evalCandidates.length > evalsToRun.length && !args.dryRun && !args.noEvals) {
    warnings.push(`${evalCandidates.length - evalsToRun.length} STR-eligible listings were not evaluated (cap ${args.maxEvals} per run) — the next run picks them up.`);
  }
  for (const c of evalsToRun) pendingEval.add(c.mls);

  let rows = buildRows();
  const strYes = rows.filter((r) => r[COL.str] === "Yes").length;
  const strUnknown = rows.filter((r) => r[COL.str] === PLACEHOLDERS.strUnknown).length;
  if (strUnknown > 0) warnings.push(`${strUnknown} listing(s) with unknown STR eligibility — marked "${PLACEHOLDERS.strUnknown}".`);

  if (args.dryRun) {
    await mkdir(openHouseLedgerDir, { recursive: true });
    const csvPath = resolve(openHouseLedgerDir, `${date.iso}-dry-run.csv`);
    const csv = [SHEET_HEADERS as readonly string[], ...rows]
      .map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","))
      .join("\n");
    await writeFile(csvPath, `${csv}\n`);
    console.log(
      JSON.stringify(
        {
          ok: true,
          dryRun: true,
          date: date.iso,
          sheetName,
          openHouses: rows.length,
          strEligible: strYes,
          strUnknown,
          lookedUp: needsLookup.length,
          wouldStartEvals: evalCandidates.map((c) => c.mls),
          withPreLink: rows.filter((r) => r[COL.preLink]).length,
          warnings,
          csvPath,
        },
        null,
        2,
      ),
    );
    return;
  }

  // --- 4. Sheet (first pass, with "Evaluation in progress" placeholders) --
  const google = await import("./google.ts");
  const folderId = process.env.OPEN_HOUSE_TRACKER_FOLDER_ID || DEFAULT_FOLDER_ID;

  let created = false;
  if (!ledger.sheetId) {
    const found = await google.findDriveFileInFolder(folderId, sheetName);
    if (found) {
      ledger.sheetId = found.id;
      ledger.sheetUrl = found.webViewLink;
    } else {
      const file = await google.createSpreadsheetInFolder(folderId, sheetName);
      ledger.sheetId = file.id;
      ledger.sheetUrl = file.webViewLink || `https://docs.google.com/spreadsheets/d/${file.id}/edit`;
      created = true;
      const tab = await google.getFirstSheetId(file.id);
      await google.batchUpdateSpreadsheet(file.id, [
        { updateSheetProperties: { properties: { sheetId: tab.sheetId, title: SHEET_TAB_TITLE, gridProperties: { frozenRowCount: 1 } }, fields: "title,gridProperties.frozenRowCount" } },
        { repeatCell: { range: { sheetId: tab.sheetId, startRowIndex: 0, endRowIndex: 1 }, cell: { userEnteredFormat: { textFormat: { bold: true } } }, fields: "userEnteredFormat.textFormat.bold" } },
      ]);
      await google.batchUpdateSheetValues(file.id, [{ range: `'${SHEET_TAB_TITLE}'!A1`, values: [[...SHEET_HEADERS]] }]);
      log(`created sheet ${ledger.sheetUrl}`);
    }
    ledger.sheetName = sheetName;
  }
  const sheetId = ledger.sheetId!;
  const tab = await google.getFirstSheetId(sheetId);

  const sync = async (freshRows: string[][]) => {
    const existing = await google.getSheetValues(sheetId, `'${tab.title}'!A1:I2000`, "FORMULA");
    const plan = planSheetMerge(existing.length ? existing : [[...SHEET_HEADERS]], freshRows, tab.title, ledger.lastWritten || {});
    const writes = [...plan.updates];
    if (plan.appends.length) writes.push({ range: `'${tab.title}'!A${plan.appendAtRow}`, values: plan.appends });
    await google.batchUpdateSheetValues(sheetId, writes);
    if (plan.appends.length) {
      await google.batchUpdateSpreadsheet(sheetId, [
        { autoResizeDimensions: { dimensions: { sheetId: tab.sheetId, dimension: "COLUMNS", startIndex: 0, endIndex: SHEET_HEADERS.length } } },
      ]);
    }
    ledger.lastWritten = plan.lastWritten;
    await writeOpenHouseLedger(ledger);
    return plan;
  };

  const preLinksBefore = Object.values(ledger.lastWritten || {}).filter((r) => r[COL.preLink]).length;
  const first = await sync(rows);
  run.rowsAdded += first.appends.length;
  run.cellsFilled += first.updates.length;
  log(`sheet synced: +${first.appends.length} rows, ${first.updates.length} cells filled`);

  // --- 5. Evaluations, one at a time --------------------------------------
  for (const candidate of evalsToRun) {
    if (!ledger.evalsStarted.includes(candidate.mls)) ledger.evalsStarted.push(candidate.mls);
    await writeOpenHouseLedger(ledger); // before posting, so the HubSpot guard can see it
    log(`starting evaluation for ${candidate.mls}`);
    const result = await runEval(candidate.url, candidate.label);
    pendingEval.delete(candidate.mls);
    if (result.ok) run.evalsStarted.push(candidate.mls);
    else {
      failedEval.add(candidate.mls);
      run.evalsFailed.push({ mlsNumber: candidate.mls, error: result.error });
      log(`evaluation failed for ${candidate.mls}: ${result.error}`);
    }
  }

  if (evalsToRun.length > 0) {
    index = await loadIndex();
    rows = buildRows();
    const second = await sync(rows);
    run.cellsFilled += second.updates.length;
    run.rowsAdded += second.appends.length;
  }

  // --- 6. Report ------------------------------------------------------------
  const preLinksNow = Object.values(ledger.lastWritten || {}).filter((r) => r[COL.preLink]).length;
  run.finishedAt = new Date().toISOString();
  ledger.runs.push(run);
  await writeOpenHouseLedger(ledger);

  if (run.evalsFailed.length) warnings.push(`${run.evalsFailed.length} evaluation(s) failed: ${run.evalsFailed.map((f) => f.mlsNumber).join(", ")}.`);
  const link = `<${ledger.sheetUrl}|${sheetName}>`;
  const lines = created
    ? [
        `📅 *Open House Tracker — ${date.short}*  ${link}`,
        `${rows.length} open houses · ${strYes} STR-eligible · ${preLinksNow} with PRE links · ${run.evalsStarted.length} evaluations started`,
      ]
    : [
        `📅 *Open House Tracker updated — ${date.short}*  ${link}`,
        `${run.rowsAdded} open houses added · ${Math.max(0, preLinksNow - preLinksBefore)} new PRE links · ${run.evalsStarted.length} evaluations started · ${rows.length} total`,
      ];
  for (const warning of warnings) lines.push(`⚠️ ${warning}`);
  log(lines.join(" | "));
  if (!args.noSlack) await postSlack(lines.join("\n"));
}

async function postSlack(message: string) {
  const channel = process.env.OPEN_HOUSE_SLACK_CHANNEL_ID || process.env.SLACK_CHANNEL_ID;
  if (!channel) return log("no SLACK_CHANNEL_ID — skipping Slack post");
  const { post } = await import("./slack.ts");
  await post(channel, message);
}

main().catch(async (error) => {
  const message = error instanceof Error ? error.message : String(error);
  log(`FAILED: ${message}`);
  if (!args.dryRun && !args.noSlack) {
    const date = args.date ? trackerDateFromIso(args.date) : upcomingWednesday(new Date());
    await postSlack(`⚠️ *Open House Tracker run failed — ${date.short}*\n${message}`).catch(() => {});
  }
  process.exit(1);
});
