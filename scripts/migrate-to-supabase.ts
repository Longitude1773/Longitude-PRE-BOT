/**
 * One-time migration: load exported Google Sheets JSON into Supabase.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/migrate-to-supabase.ts
 *
 * Reads from data/migration/{listings,evaluations,monthly_projections,comparables}.json
 */

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { supabase, toDbRow } from "./supabase.ts";

const migrationDir = resolve(import.meta.dirname, "../data/migration");

async function loadJson(name: string) {
  const path = resolve(migrationDir, `${name}.json`);
  if (!existsSync(path)) {
    console.log(`  Skipping ${name} — file not found`);
    return [];
  }
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>[];
}

function dedup(rows: Record<string, unknown>[], keyField: string) {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = String(row[keyField] ?? "");
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function migrateTable(sheetName: string, tableName: string, jsonName: string, pkField?: string) {
  console.log(`\nMigrating ${sheetName}...`);
  let rows = await loadJson(jsonName);
  if (rows.length === 0) return;

  // Deduplicate by PK if specified
  if (pkField) {
    const before = rows.length;
    rows = dedup(rows, pkField);
    if (rows.length < before) {
      console.log(`  Deduped: ${before} -> ${rows.length} rows (by ${pkField})`);
    }
  }

  const dbRows = rows.map((row) => toDbRow(sheetName, row));

  // Insert in batches of 50
  const batchSize = 50;
  let inserted = 0;
  for (let i = 0; i < dbRows.length; i += batchSize) {
    const batch = dbRows.slice(i, i + batchSize);
    const { error } = await supabase.from(tableName).upsert(batch, { onConflict: pkField ? undefined : undefined });
    if (error) {
      console.error(`  Error inserting batch at row ${i}: ${error.message}`);
      // Try inserting one by one to identify the problematic row
      for (const row of batch) {
        const { error: singleError } = await supabase.from(tableName).insert(row);
        if (singleError) {
          console.error(`  Failed row: ${JSON.stringify(row).slice(0, 200)}`);
          console.error(`  Error: ${singleError.message}`);
        } else {
          inserted++;
        }
      }
    } else {
      inserted += batch.length;
    }
  }

  console.log(`  Inserted ${inserted}/${rows.length} rows into ${tableName}`);
}

async function truncateAll() {
  console.log("Clearing existing data...");
  // Delete in reverse dependency order. Supabase requires a filter, so use gte on a column that always exists.
  for (const [table, col] of [
    ["comparables", "id"],
    ["monthly_projections", "id"],
    ["adjustments", "adj_id"],
    ["evaluations", "eval_id"],
    ["listings", "mls_number"],
  ] as const) {
    const { error } = await supabase.from(table).delete().not(col, "is", null);
    if (error) console.warn(`  Warning clearing ${table}: ${error.message}`);
    else console.log(`  Cleared ${table}`);
  }
}

async function main() {
  console.log("Starting Supabase migration...");
  console.log(`Migration dir: ${migrationDir}`);

  await truncateAll();

  // Order matters: listings first (referenced by evaluations)
  await migrateTable("Listings", "listings", "listings", "MLS #");
  await migrateTable("Evaluations", "evaluations", "evaluations", "Eval ID");
  await migrateTable("Monthly Projections", "monthly_projections", "monthly_projections");
  await migrateTable("Comparables", "comparables", "comparables");

  console.log("\nMigration complete!");
}

await main();
