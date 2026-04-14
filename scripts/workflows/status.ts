import { readSheet } from "../sheets.ts";
import { shortEvaluationLine, summarizeStatusRows, type EvalSheetRow } from "./lib.ts";

async function readSheetSafe(sheet: string) {
  try {
    const rows = await readSheet(sheet);
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

async function main() {
  const evaluations = (await readSheetSafe("Evaluations")) as EvalSheetRow[];
  const adjustments = await readSheetSafe("Adjustments");
  const listings = await readSheetSafe("Listings");

  const latestByMls = new Map<string, EvalSheetRow>();
  for (const row of evaluations) {
    const key = String(row["MLS #"]);
    const current = latestByMls.get(key);
    if (!current || Number(row.Version) >= Number(current.Version)) latestByMls.set(key, row);
  }

  const latestRows = Array.from(latestByMls.values());
  const pendingReview = latestRows.filter((row) => ["pending_review", "posted", "draft"].includes(String(row.Status)));
  const approved = latestRows.filter((row) => String(row.Status) === "approved");

  console.log(JSON.stringify({
    ok: true,
    listings: listings.length,
    evaluations: evaluations.length,
    latestEvaluationStatuses: summarizeStatusRows(latestRows),
    approvedCount: approved.length,
    pendingReviewCount: pendingReview.length,
    adjustmentsCount: adjustments.length,
    pendingReview: pendingReview.slice(0, 10).map(shortEvaluationLine),
  }, null, 2));
}

await main();
