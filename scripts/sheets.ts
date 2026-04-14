import { fileURLToPath } from "node:url";

import { readTable, insertRow, insertRows, updateByPk, findRows, toDbRow } from "./supabase.ts";

/**
 * Google Sheets utility — now backed by Supabase Postgres.
 *
 * Usage:
 *   tsx scripts/sheets.ts read <SheetName>
 *   tsx scripts/sheets.ts append <SheetName> <json-row-or-object>
 *   tsx scripts/sheets.ts append-batch <SheetName> <json-rows-or-objects>
 *   tsx scripts/sheets.ts update <SheetName> <primary-key-value> <json-row-or-object>
 *   tsx scripts/sheets.ts find <SheetName> <column> <value>
 */

export const SHEET_SCHEMAS: Record<string, string[]> = {
  Listings: [
    "MLS #",
    "Listing Source",
    "Address",
    "City",
    "Region",
    "Price",
    "BD",
    "BA",
    "SqFt",
    "Type",
    "Amenities (JSON)",
    "STR Eligible",
    "Status",
    "Listing Date",
    "Agent",
    "Photos (JSON)",
    "Lat",
    "Lng",
    "Scraped At",
    "Listing URL",
    "Open House (JSON)",
  ],
  Evaluations: [
    "Eval ID",
    "MLS #",
    "Listing Source",
    "BD",
    "BA",
    "Version",
    "High Rev",
    "Med Rev",
    "Low Rev",
    "High Occ",
    "Med Occ",
    "Low Occ",
    "High ADR",
    "Med ADR",
    "Low ADR",
    "Status",
    "Slack Timestamp",
    "PDF Path",
    "Created At",
  ],
  "Monthly Projections": [
    "Eval ID",
    "Month",
    "High Rev",
    "Med Rev",
    "Low Rev",
    "High Occ",
    "Med Occ",
    "Low Occ",
    "High ADR",
    "Med ADR",
    "Low ADR",
  ],
  Comparables: [
    "Eval ID",
    "Source",
    "Title",
    "Address",
    "BD",
    "BA",
    "Revenue",
    "Occ Rate",
    "ADR",
    "Distance (mi)",
  ],
  Adjustments: [
    "Adj ID",
    "Eval ID",
    "MLS #",
    "Timestamp",
    "Requested By",
    "Request Text",
    "Category",
    "Prior High",
    "Prior Med",
    "Prior Low",
    "New High",
    "New Med",
    "New Low",
    "Delta %",
    "Reasoning",
  ],
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeRowData(sheetName: string, row: unknown) {
  if (Array.isArray(row)) {
    // Convert array to object using schema
    const schema = SHEET_SCHEMAS[sheetName];
    if (!schema) throw new Error(`No schema for sheet "${sheetName}".`);
    const obj: Record<string, unknown> = {};
    for (let i = 0; i < schema.length; i++) {
      obj[schema[i]] = row[i] ?? "";
    }
    return obj;
  }

  if (!isPlainObject(row)) {
    throw new Error("Row must be a JSON array or object.");
  }

  return row;
}

function normalizeRow(sheetName: string, rowJson: string) {
  return normalizeRowData(sheetName, JSON.parse(rowJson));
}

export async function readSheet(sheetName: string) {
  return readTable(sheetName);
}

export async function appendSheetRow(sheetName: string, rowData: string | unknown) {
  const row = typeof rowData === "string"
    ? normalizeRow(sheetName, rowData)
    : normalizeRowData(sheetName, rowData);
  return insertRow(sheetName, row as Record<string, unknown>);
}

export async function appendSheetRows(sheetName: string, rowsData: string | unknown[]) {
  const parsedRows = typeof rowsData === "string" ? JSON.parse(rowsData) : rowsData;
  if (!Array.isArray(parsedRows) || parsedRows.length === 0) {
    throw new Error("Batch rows must be a non-empty array.");
  }
  const rows = parsedRows.map((row) => normalizeRowData(sheetName, row) as Record<string, unknown>);
  return insertRows(sheetName, rows);
}

export async function updateSheetRow(sheetName: string, primaryKey: string | number, rowData: string | unknown) {
  const row = typeof rowData === "string"
    ? normalizeRow(sheetName, rowData)
    : normalizeRowData(sheetName, rowData);
  return updateByPk(sheetName, primaryKey, row as Record<string, unknown>);
}

export async function findSheetRows(sheetName: string, column: string, value: string) {
  return findRows(sheetName, column, value);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [, , command, ...args] = process.argv;

  switch (command) {
    case "read":
      console.log(JSON.stringify(await readSheet(args[0]), null, 2));
      break;
    case "append":
      console.log((await appendSheetRow(args[0], args[1])).message || "Appended");
      break;
    case "append-batch":
      console.log((await appendSheetRows(args[0], args[1])).message || "Appended batch");
      break;
    case "update":
      console.log((await updateSheetRow(args[0], args[1], args[2])).message || "Updated");
      break;
    case "find":
      console.log(JSON.stringify(await findSheetRows(args[0], args[1], args[2]), null, 2));
      break;
    default:
      console.error("Usage: tsx scripts/sheets.ts <read|append|append-batch|update|find> ...");
      process.exit(1);
  }
}
