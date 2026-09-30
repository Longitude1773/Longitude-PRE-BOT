/**
 * Local record of each Wednesday's open-house tracker runs:
 * data/open-house/<YYYY-MM-DD>.json (gitignored — runtime state, like data/inbox).
 *
 * Two readers:
 *  - the tracker itself (Wednesday run finds Tuesday's sheet + what it started)
 *  - the HubSpot approve step, which creates agent tasks for evaluations the
 *    tracker started even though their listing_source is "mls_on_demand"
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
export const openHouseLedgerDir = resolve(repoRoot, "data/open-house");

export type OpenHouseRunRecord = {
  mode: string;
  startedAt: string;
  finishedAt?: string;
  entries: number;
  rowsAdded: number;
  cellsFilled: number;
  evalsStarted: string[];
  evalsFailed: Array<{ mlsNumber: string; error: string }>;
  error?: string;
};

export type OpenHouseLedger = {
  /** YYYY-MM-DD of the Wednesday. */
  date: string;
  sheetId?: string;
  sheetUrl?: string;
  sheetName?: string;
  /** Every MLS # this tracker started an evaluation for, across runs. */
  evalsStarted: string[];
  /** Per MLS #, the row values the bot last wrote (see planSheetMerge). */
  lastWritten?: Record<string, string[]>;
  runs: OpenHouseRunRecord[];
};

export function openHouseLedgerPath(date: string) {
  return resolve(openHouseLedgerDir, `${date}.json`);
}

export async function readOpenHouseLedger(date: string): Promise<OpenHouseLedger> {
  try {
    const parsed = JSON.parse(await readFile(openHouseLedgerPath(date), "utf8")) as OpenHouseLedger;
    return { ...parsed, evalsStarted: parsed.evalsStarted || [], runs: parsed.runs || [] };
  } catch {
    return { date, evalsStarted: [], runs: [] };
  }
}

export async function writeOpenHouseLedger(ledger: OpenHouseLedger) {
  await mkdir(openHouseLedgerDir, { recursive: true });
  await writeFile(openHouseLedgerPath(ledger.date), `${JSON.stringify(ledger, null, 2)}\n`);
}

/** Did the open-house tracker start the evaluation for this MLS #? */
export async function isOpenHouseTrackerEval(mlsNumber: string) {
  if (!mlsNumber) return false;
  const files = await readdir(openHouseLedgerDir).catch(() => [] as string[]);
  for (const file of files) {
    if (!/^\d{4}-\d{2}-\d{2}\.json$/.test(file)) continue;
    const ledger = await readOpenHouseLedger(file.replace(/\.json$/, ""));
    if (ledger.evalsStarted.includes(mlsNumber)) return true;
  }
  return false;
}
