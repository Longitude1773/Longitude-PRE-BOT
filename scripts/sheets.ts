import { fileURLToPath } from "node:url";

/**
 * Google Sheets utility — calls your Apps Script web app to read/write sheet data.
 *
 * Usage:
 *   tsx scripts/sheets.ts read <SheetName>
 *   tsx scripts/sheets.ts append <SheetName> <json-row-or-object>
 *   tsx scripts/sheets.ts update <SheetName> <row-number> <json-row-or-object>
 *   tsx scripts/sheets.ts find <SheetName> <column> <value>
 */

const APPS_SCRIPT_URL = process.env.GOOGLE_APPS_SCRIPT_URL!;
const SHEETS_TOKEN = process.env.GOOGLE_SHEETS_TOKEN!;

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

if (!APPS_SCRIPT_URL || !SHEETS_TOKEN) {
  console.error("Missing GOOGLE_APPS_SCRIPT_URL or GOOGLE_SHEETS_TOKEN env var");
  process.exit(1);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeRowData(sheetName: string, row: unknown) {
  if (Array.isArray(row)) {
    return row;
  }

  if (!isPlainObject(row)) {
    throw new Error("Row must be a JSON array or object.");
  }

  const schema = SHEET_SCHEMAS[sheetName];
  if (!schema) {
    throw new Error(
      `Object writes are not configured for sheet "${sheetName}". ` +
      `Use a JSON array or add a schema in scripts/sheets.ts.`
    );
  }

  return schema.map((header) => row[header] ?? "");
}

function normalizeRow(sheetName: string, rowJson: string) {
  return normalizeRowData(sheetName, JSON.parse(rowJson));
}

export async function callSheet(action: string, params: Record<string, string>) {
  const url = new URL(APPS_SCRIPT_URL);
  url.searchParams.set("action", action);
  url.searchParams.set("token", SHEETS_TOKEN);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }

  const res = await fetch(url.toString(), { redirect: "follow" });
  if (!res.ok) {
    console.error(`Apps Script error: ${res.status} ${res.statusText}`);
    process.exit(1);
  }
  const data = await res.json();
  if (data.error) {
    console.error(`Sheet error: ${data.error}`);
    process.exit(1);
  }
  return data;
}

export async function readSheet(sheetName: string) {
  const data = await callSheet("read", { sheet: sheetName });
  return data.rows;
}

export async function appendSheetRow(sheetName: string, rowData: string | unknown) {
  const row = typeof rowData === "string" ? normalizeRow(sheetName, rowData) : normalizeRowData(sheetName, rowData);
  const res = await fetch(APPS_SCRIPT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "append", sheet: sheetName, row, token: SHEETS_TOKEN }),
    redirect: "follow",
  });
  return await res.json();
}

export async function updateSheetRow(sheetName: string, rowNumber: string | number, rowData: string | unknown) {
  const row = typeof rowData === "string" ? normalizeRow(sheetName, rowData) : normalizeRowData(sheetName, rowData);
  const res = await fetch(APPS_SCRIPT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "update", sheet: sheetName, rowNumber: parseInt(String(rowNumber)), row, token: SHEETS_TOKEN }),
    redirect: "follow",
  });
  return await res.json();
}

export async function findSheetRows(sheetName: string, column: string, value: string) {
  const data = await callSheet("find", { sheet: sheetName, column, value });
  return data.matches;
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
    case "update":
      console.log((await updateSheetRow(args[0], args[1], args[2])).message || "Updated");
      break;
    case "find":
      console.log(JSON.stringify(await findSheetRows(args[0], args[1], args[2]), null, 2));
      break;
    default:
      console.error("Usage: tsx scripts/sheets.ts <read|append|update|find> ...");
      process.exit(1);
  }
}
