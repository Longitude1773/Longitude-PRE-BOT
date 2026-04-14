import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY!;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_ANON_KEY env var");
  process.exit(1);
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Sheet tab name -> Postgres table name
const TABLE_MAP: Record<string, string> = {
  Listings: "listings",
  Evaluations: "evaluations",
  "Monthly Projections": "monthly_projections",
  Comparables: "comparables",
  Adjustments: "adjustments",
};

// Sheet header -> Postgres column name, per table
const COLUMN_MAP: Record<string, Record<string, string>> = {
  Listings: {
    "MLS #": "mls_number",
    "Listing Source": "listing_source",
    Address: "address",
    City: "city",
    Region: "region",
    Price: "price",
    BD: "bd",
    BA: "ba",
    SqFt: "sqft",
    Type: "type",
    "Amenities (JSON)": "amenities",
    "STR Eligible": "str_eligible",
    Status: "status",
    "Listing Date": "listing_date",
    Agent: "agent",
    "Photos (JSON)": "photos",
    Lat: "lat",
    Lng: "lng",
    "Scraped At": "scraped_at",
    "Listing URL": "listing_url",
    "Open House (JSON)": "open_house",
  },
  Evaluations: {
    "Eval ID": "eval_id",
    "MLS #": "mls_number",
    "Listing Source": "listing_source",
    BD: "bd",
    BA: "ba",
    Version: "version",
    "High Rev": "high_rev",
    "Med Rev": "med_rev",
    "Low Rev": "low_rev",
    "High Occ": "high_occ",
    "Med Occ": "med_occ",
    "Low Occ": "low_occ",
    "High ADR": "high_adr",
    "Med ADR": "med_adr",
    "Low ADR": "low_adr",
    Status: "status",
    "Slack Timestamp": "slack_timestamp",
    "PDF Path": "pdf_path",
    "Created At": "created_at",
  },
  "Monthly Projections": {
    "Eval ID": "eval_id",
    Month: "month",
    "High Rev": "high_rev",
    "Med Rev": "med_rev",
    "Low Rev": "low_rev",
    "High Occ": "high_occ",
    "Med Occ": "med_occ",
    "Low Occ": "low_occ",
    "High ADR": "high_adr",
    "Med ADR": "med_adr",
    "Low ADR": "low_adr",
  },
  Comparables: {
    "Eval ID": "eval_id",
    Source: "source",
    Title: "title",
    Address: "address",
    BD: "bd",
    BA: "ba",
    Revenue: "revenue",
    "Occ Rate": "occ_rate",
    ADR: "adr",
    "Distance (mi)": "distance_mi",
  },
  Adjustments: {
    "Adj ID": "adj_id",
    "Eval ID": "eval_id",
    "MLS #": "mls_number",
    Timestamp: "timestamp",
    "Requested By": "requested_by",
    "Request Text": "request_text",
    Category: "category",
    "Prior High": "prior_high",
    "Prior Med": "prior_med",
    "Prior Low": "prior_low",
    "New High": "new_high",
    "New Med": "new_med",
    "New Low": "new_low",
    "Delta %": "delta_pct",
    Reasoning: "reasoning",
  },
};

// Reverse maps: Postgres column -> sheet header
const REVERSE_MAP: Record<string, Record<string, string>> = {};
for (const [sheet, map] of Object.entries(COLUMN_MAP)) {
  REVERSE_MAP[sheet] = Object.fromEntries(
    Object.entries(map).map(([k, v]) => [v, k]),
  );
}

// Primary key column (sheet header name) per table
const PK_MAP: Record<string, string> = {
  Listings: "MLS #",
  Evaluations: "Eval ID",
  "Monthly Projections": "id",
  Comparables: "id",
  Adjustments: "Adj ID",
};

// Columns that store JSON as strings in the old interface but are JSONB in Postgres
const JSONB_FIELDS: Record<string, Set<string>> = {
  Listings: new Set(["amenities", "photos", "open_house"]),
};

// Columns with NUMERIC type — empty strings must become null
const NUMERIC_FIELDS: Record<string, Set<string>> = {
  Listings: new Set(["price", "bd", "ba", "sqft", "lat", "lng"]),
  Evaluations: new Set(["bd", "ba", "version", "high_rev", "med_rev", "low_rev", "high_occ", "med_occ", "low_occ", "high_adr", "med_adr", "low_adr"]),
  "Monthly Projections": new Set(["high_rev", "med_rev", "low_rev", "high_occ", "med_occ", "low_occ", "high_adr", "med_adr", "low_adr"]),
  Comparables: new Set(["bd", "ba", "revenue", "occ_rate", "adr", "distance_mi"]),
  Adjustments: new Set(["prior_high", "prior_med", "prior_low", "new_high", "new_med", "new_low"]),
};

function tableName(sheetName: string) {
  const name = TABLE_MAP[sheetName];
  if (!name) throw new Error(`Unknown sheet: ${sheetName}`);
  return name;
}

function colMap(sheetName: string) {
  const map = COLUMN_MAP[sheetName];
  if (!map) throw new Error(`No column map for sheet: ${sheetName}`);
  return map;
}

function revMap(sheetName: string) {
  return REVERSE_MAP[sheetName]!;
}

function pkDbCol(sheetName: string) {
  const sheetKey = PK_MAP[sheetName];
  if (!sheetKey) throw new Error(`No PK defined for sheet: ${sheetName}`);
  const map = colMap(sheetName);
  return map[sheetKey] || sheetKey;
}

/** Convert a sheet-key object to a Postgres-key object */
export function toDbRow(sheetName: string, obj: Record<string, unknown>): Record<string, unknown> {
  const map = colMap(sheetName);
  const jsonbFields = JSONB_FIELDS[sheetName];
  const numericFields = NUMERIC_FIELDS[sheetName];
  const result: Record<string, unknown> = {};

  for (const [sheetKey, value] of Object.entries(obj)) {
    const dbCol = map[sheetKey];
    if (!dbCol) continue; // skip unknown columns (e.g. _rowNumber)

    if (jsonbFields?.has(dbCol)) {
      // Parse JSON strings into objects for JSONB columns
      if (typeof value === "string") {
        try {
          result[dbCol] = JSON.parse(value);
        } catch {
          result[dbCol] = value;
        }
      } else {
        result[dbCol] = value;
      }
    } else if (value === undefined) {
      result[dbCol] = null;
    } else if (value === "" && numericFields?.has(dbCol)) {
      result[dbCol] = null;
    } else {
      result[dbCol] = value;
    }
  }

  return result;
}

/** Convert a Postgres-key row to a sheet-key object */
export function toSheetRow(sheetName: string, dbRow: Record<string, unknown>): Record<string, unknown> {
  const rev = revMap(sheetName);
  const jsonbFields = JSONB_FIELDS[sheetName];
  const result: Record<string, unknown> = {};

  for (const [dbCol, value] of Object.entries(dbRow)) {
    const sheetKey = rev[dbCol];
    if (!sheetKey) continue; // skip synthetic columns like id

    if (jsonbFields?.has(dbCol)) {
      // Stringify JSONB back to string for compat
      result[sheetKey] = typeof value === "string" ? value : JSON.stringify(value ?? []);
    } else {
      result[sheetKey] = value ?? "";
    }
  }

  return result;
}

/** Read all rows from a table, returned in sheet-key format */
export async function readTable(sheetName: string) {
  const table = tableName(sheetName);
  const { data, error } = await supabase.from(table).select("*");
  if (error) throw new Error(`Supabase read error (${sheetName}): ${error.message}`);
  return (data ?? []).map((row) => toSheetRow(sheetName, row));
}

/** Insert a single row (sheet-key object) */
export async function insertRow(sheetName: string, row: Record<string, unknown>) {
  const table = tableName(sheetName);
  const dbRow = toDbRow(sheetName, row);
  const { error } = await supabase.from(table).insert(dbRow);
  if (error) throw new Error(`Supabase insert error (${sheetName}): ${error.message}`);
  return { message: "Row appended" };
}

/** Insert multiple rows (sheet-key objects) */
export async function insertRows(sheetName: string, rows: Record<string, unknown>[]) {
  if (rows.length === 0) return { message: "0 rows appended" };
  const table = tableName(sheetName);
  const dbRows = rows.map((row) => toDbRow(sheetName, row));
  const { error } = await supabase.from(table).insert(dbRows);
  if (error) throw new Error(`Supabase batch insert error (${sheetName}): ${error.message}`);
  return { message: `${rows.length} rows appended` };
}

/** Update a row by primary key value (sheet-key object for the update data) */
export async function updateByPk(sheetName: string, pkValue: string | number, row: Record<string, unknown>) {
  const table = tableName(sheetName);
  const pk = pkDbCol(sheetName);
  const dbRow = toDbRow(sheetName, row);
  // Don't include synthetic identity PKs in the update payload
  delete dbRow.id;
  const { error } = await supabase.from(table).update(dbRow).eq(pk, pkValue);
  if (error) throw new Error(`Supabase update error (${sheetName}): ${error.message}`);
  return { message: `Row updated` };
}

/** Find rows by column value (sheet header name for column), returned in sheet-key format */
export async function findRows(sheetName: string, column: string, value: string) {
  const table = tableName(sheetName);
  const map = colMap(sheetName);
  const dbCol = map[column];
  if (!dbCol) throw new Error(`Unknown column "${column}" in sheet "${sheetName}"`);
  const { data, error } = await supabase.from(table).select("*").eq(dbCol, value);
  if (error) throw new Error(`Supabase find error (${sheetName}): ${error.message}`);
  return (data ?? []).map((row) => toSheetRow(sheetName, row));
}
