/**
 * One-time backfill: upload existing local PDFs in data/pdfs/ to Cloudflare R2
 * and reconcile the evaluations.pdf_path column.
 *
 * Semantics (post Add-R2-PDF-storage): pdf_path holds the R2 object key when a
 * downloadable PDF exists, NULL otherwise.
 *
 *   - Matched local file  -> upload to {year}/{month}/{day}/{slug}.pdf, set that
 *                            key on ALL eval rows for the property.
 *   - Property w/ no file  -> set pdf_path = NULL on rows that still hold a stale
 *                            local "data/pdfs/..." path (orphans).
 *   - Unmatched local file -> never touched; logged for manual review.
 *
 * Idempotent + decisions independent:
 *   - upload happens iff the R2 object is missing (HEAD check)
 *   - a row is updated iff its pdf_path differs from the target
 *   - rows already holding an R2 key (e.g. from a live approval) are left alone
 *
 * Usage:
 *   tsx scripts/migrations/backfill-pdfs-to-r2.ts --dry-run   # report only, no writes
 *   tsx scripts/migrations/backfill-pdfs-to-r2.ts             # execute
 */
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { supabase } from "../supabase.ts";
import { pdfBaseName, r2KeyForEval, repoRoot } from "../workflows/lib.ts";
import { r2ObjectExists, uploadPdfToR2 } from "../r2.ts";

type EvalRow = { eval_id: string; mls_number: string; created_at: string; pdf_path: string | null };

const DRY_RUN = process.argv.includes("--dry-run");
const PDF_DIR = resolve(repoRoot, "data/pdfs");

const isLocalPath = (p: string | null | undefined) => typeof p === "string" && p.startsWith("data/pdfs/");
const isR2Key = (p: string | null | undefined) => typeof p === "string" && /^\d{4}\/\d{2}\/\d{2}\//.test(p);

function classifyFile(stem: string): { kind: "zpid" | "mls" | "address"; mls?: string; slug?: string } {
  if (/^zpid-/i.test(stem)) return { kind: "zpid", mls: `ZPID-${stem.replace(/^zpid-/i, "")}` };
  if (/^\d+$/.test(stem)) return { kind: "mls", mls: stem };
  return { kind: "address", slug: stem.toLowerCase() };
}

function earliestCreatedAt(rows: EvalRow[]): string {
  return rows
    .map((r) => r.created_at)
    .filter(Boolean)
    .sort()[0] ?? rows[0]?.created_at;
}

async function main() {
  console.log(`\n=== Backfill PDFs -> R2 ${DRY_RUN ? "(DRY RUN — no writes/uploads)" : "(EXECUTE)"} ===\n`);

  // --- Load DB state -----------------------------------------------------
  const { data: evalsRaw, error: evalErr } = await supabase
    .from("evaluations")
    .select("eval_id,mls_number,created_at,pdf_path");
  if (evalErr) throw new Error(`Read evaluations failed: ${evalErr.message}`);
  const evals = (evalsRaw ?? []) as EvalRow[];

  const { data: listingsRaw, error: listErr } = await supabase.from("listings").select("mls_number,address");
  if (listErr) throw new Error(`Read listings failed: ${listErr.message}`);
  const listings = (listingsRaw ?? []) as Array<{ mls_number: string; address: string | null }>;

  // mls_number -> eval rows
  const byMls = new Map<string, EvalRow[]>();
  for (const e of evals) {
    const k = String(e.mls_number);
    if (!byMls.has(k)) byMls.set(k, []);
    byMls.get(k)!.push(e);
  }

  // mls_number -> address; and street-slug -> mls (null = ambiguous collision)
  const addressByMls = new Map<string, string>();
  const slugToMls = new Map<string, string | null>();
  for (const l of listings) {
    const mls = String(l.mls_number);
    const address = String(l.address ?? "");
    addressByMls.set(mls, address);
    if (!address.trim()) continue;
    const slug = pdfBaseName(address).toLowerCase(); // matches how address PDFs were named (street-only)
    if (!slug || slug === "evaluation") continue;
    if (slugToMls.has(slug) && slugToMls.get(slug) !== mls) slugToMls.set(slug, null);
    else if (!slugToMls.has(slug)) slugToMls.set(slug, mls);
  }

  // --- Walk local PDFs ---------------------------------------------------
  const files = (await readdir(PDF_DIR)).filter((f) => f.toLowerCase().endsWith(".pdf"));

  const matched: Array<{ file: string; mls: string; key: string; rows: number; uploaded: boolean; rowsUpdated: number }> = [];
  const unmatched: Array<{ file: string; reason: string }> = [];
  const matchedMls = new Set<string>();

  for (const file of files) {
    const stem = file.replace(/\.pdf$/i, "");
    const c = classifyFile(stem);

    let mls: string | undefined;
    if (c.kind === "address") {
      const hit = slugToMls.get(c.slug!);
      if (hit === undefined) { unmatched.push({ file, reason: "no listing with matching address slug" }); continue; }
      if (hit === null) { unmatched.push({ file, reason: "ambiguous: address slug maps to multiple listings" }); continue; }
      mls = hit;
    } else {
      mls = c.mls!;
    }

    const rows = byMls.get(mls);
    if (!rows || rows.length === 0) {
      unmatched.push({ file, reason: `no evaluation row for mls_number "${mls}"` });
      continue;
    }

    const createdAt = earliestCreatedAt(rows);
    const address = addressByMls.get(mls) ?? "";
    const key = r2KeyForEval({ address, mlsNumber: mls, createdAt });
    matchedMls.add(mls);

    const localPath = `data/pdfs/${file}`;
    const rowsNeedingUpdate = rows.filter((r) => r.pdf_path !== key);

    let uploaded = false;
    let rowsUpdated = 0;
    if (!DRY_RUN) {
      if (!(await r2ObjectExists(key))) {
        await uploadPdfToR2(key, resolve(repoRoot, localPath));
        uploaded = true;
      }
      for (const r of rowsNeedingUpdate) {
        const { error } = await supabase.from("evaluations").update({ pdf_path: key }).eq("eval_id", r.eval_id);
        if (error) throw new Error(`Update ${r.eval_id} failed: ${error.message}`);
        rowsUpdated++;
      }
    } else {
      rowsUpdated = rowsNeedingUpdate.length; // would-update count
    }

    matched.push({ file, mls, key, rows: rows.length, uploaded, rowsUpdated });
  }

  // --- Orphans: properties with no matched file --------------------------
  const orphans: Array<{ mls: string; rows: number; nulled: number }> = [];
  let leftAloneR2 = 0;
  for (const [mls, rows] of byMls) {
    if (matchedMls.has(mls)) continue;
    const stale = rows.filter((r) => isLocalPath(r.pdf_path));
    const alreadyR2 = rows.filter((r) => isR2Key(r.pdf_path));
    leftAloneR2 += alreadyR2.length;
    if (stale.length === 0) continue;
    let nulled = 0;
    if (!DRY_RUN) {
      for (const r of stale) {
        const { error } = await supabase.from("evaluations").update({ pdf_path: null }).eq("eval_id", r.eval_id);
        if (error) throw new Error(`Null ${r.eval_id} failed: ${error.message}`);
        nulled++;
      }
    } else {
      nulled = stale.length;
    }
    orphans.push({ mls, rows: rows.length, nulled });
  }

  // --- Report ------------------------------------------------------------
  const summary = {
    dryRun: DRY_RUN,
    localFiles: files.length,
    matchedFiles: matched.length,
    matchedProperties: matchedMls.size,
    filesUploaded: matched.filter((m) => m.uploaded).length,
    evalRowsStampedWithKey: matched.reduce((n, m) => n + m.rowsUpdated, 0),
    unmatchedFiles: unmatched.length,
    orphanProperties: orphans.length,
    orphanRowsNulled: orphans.reduce((n, o) => n + o.nulled, 0),
    rowsLeftAloneAlreadyR2: leftAloneR2,
  };

  const reportDir = resolve(repoRoot, "data/migrations");
  await mkdir(reportDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reportPath = resolve(reportDir, `backfill-report-${DRY_RUN ? "dryrun-" : ""}${stamp}.json`);
  await writeFile(reportPath, JSON.stringify({ summary, matched, unmatched, orphans }, null, 2));

  console.log(JSON.stringify(summary, null, 2));
  console.log(`\nUnmatched files (${unmatched.length}) — review manually:`);
  for (const u of unmatched) console.log(`  - ${u.file}  (${u.reason})`);
  console.log(`\nFull report written to: ${reportPath}\n`);
}

await main();
