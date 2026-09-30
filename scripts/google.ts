/**
 * Minimal Google Drive + Sheets client over REST (no googleapis dependency).
 *
 * Auth is a user OAuth refresh token (files are created as, and owned by, the
 * Google account that ran scripts/google-auth.ts). A service account would be
 * simpler but cannot create files in a personal My Drive folder — service
 * accounts have no storage quota there.
 *
 * Env: GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_OAUTH_REFRESH_TOKEN
 */

export const GOOGLE_SCOPES = ["https://www.googleapis.com/auth/drive"];

let cachedToken: { value: string; expiresAt: number } | null = null;

function requireEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not set — run scripts/google-auth.ts and add the values to .env.`);
  return value;
}

export async function googleAccessToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: requireEnv("GOOGLE_OAUTH_CLIENT_ID"),
      client_secret: requireEnv("GOOGLE_OAUTH_CLIENT_SECRET"),
      refresh_token: requireEnv("GOOGLE_OAUTH_REFRESH_TOKEN"),
    }),
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (!res.ok || !body.access_token) {
    // invalid_grant = token revoked/expired (e.g. consent screen left in
    // "Testing", which expires refresh tokens after 7 days) → re-run google-auth.
    throw new Error(`Google token refresh failed: ${body.error || res.status} ${body.error_description || ""}`.trim());
  }
  cachedToken = { value: body.access_token, expiresAt: Date.now() + (body.expires_in || 3600) * 1000 };
  return cachedToken.value;
}

async function google<T>(url: string, init: RequestInit = {}): Promise<T> {
  const token = await googleAccessToken();
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Google API ${init.method || "GET"} ${url.split("?")[0]} → ${res.status}: ${text.slice(0, 400)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

export type DriveFile = { id: string; name: string; webViewLink?: string };

const DRIVE = "https://www.googleapis.com/drive/v3/files";
const SHEETS = "https://sheets.googleapis.com/v4/spreadsheets";

/** Exact-name lookup inside one folder (trashed files ignored). */
export async function findDriveFileInFolder(folderId: string, name: string): Promise<DriveFile | null> {
  const q = `'${folderId}' in parents and name = '${name.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}' and trashed = false`;
  const params = new URLSearchParams({
    q,
    fields: "files(id,name,webViewLink)",
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
  });
  const body = await google<{ files?: DriveFile[] }>(`${DRIVE}?${params}`);
  return body.files?.[0] || null;
}

export async function getDriveFolder(folderId: string): Promise<DriveFile & { mimeType?: string }> {
  return await google(`${DRIVE}/${folderId}?fields=id,name,mimeType,webViewLink&supportsAllDrives=true`);
}

export async function createSpreadsheetInFolder(folderId: string, name: string): Promise<DriveFile> {
  return await google<DriveFile>(`${DRIVE}?supportsAllDrives=true&fields=id,name,webViewLink`, {
    method: "POST",
    body: JSON.stringify({ name, mimeType: "application/vnd.google-apps.spreadsheet", parents: [folderId] }),
  });
}

export async function getSheetValues(spreadsheetId: string, range: string, render: "FORMATTED_VALUE" | "FORMULA" = "FORMATTED_VALUE") {
  const params = new URLSearchParams({ valueRenderOption: render });
  const body = await google<{ values?: string[][] }>(`${SHEETS}/${spreadsheetId}/values/${encodeURIComponent(range)}?${params}`);
  return body.values || [];
}

/** Write many ranges in one call; values are parsed as if typed (formulas, $ amounts). */
export async function batchUpdateSheetValues(spreadsheetId: string, data: Array<{ range: string; values: unknown[][] }>) {
  if (data.length === 0) return;
  await google(`${SHEETS}/${spreadsheetId}/values:batchUpdate`, {
    method: "POST",
    body: JSON.stringify({ valueInputOption: "USER_ENTERED", data }),
  });
}

export async function getFirstSheetId(spreadsheetId: string) {
  const body = await google<{ sheets?: Array<{ properties: { sheetId: number; title: string } }> }>(
    `${SHEETS}/${spreadsheetId}?fields=sheets.properties(sheetId,title)`,
  );
  const first = body.sheets?.[0]?.properties;
  if (!first) throw new Error(`Spreadsheet ${spreadsheetId} has no sheets.`);
  return first;
}

export async function batchUpdateSpreadsheet(spreadsheetId: string, requests: unknown[]) {
  if (requests.length === 0) return;
  await google(`${SHEETS}/${spreadsheetId}:batchUpdate`, { method: "POST", body: JSON.stringify({ requests }) });
}
