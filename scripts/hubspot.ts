/**
 * Minimal HubSpot CRM v3 client for the PRE Bot → HubSpot task automation.
 *
 * Auth is a private-app service token (HUBSPOT_PRIVATE_APP_TOKEN) used as a
 * Bearer token. The app has crm.objects.contacts read + write, which also
 * covers engagements/tasks — there is no separate task scope.
 *
 * Kept dependency-free and side-effect-free at import time (the token is read
 * lazily) so callers can load .env before the first API call.
 */

const BASE_URL = "https://api.hubapi.com";

// HubSpot portal (account) id — used to build record URLs. na2 is this
// account's app cluster; app.hubspot.com/... would redirect but not deep-link.
export const HUBSPOT_PORTAL_ID = process.env.HUBSPOT_PORTAL_ID || "242965527";
export const HUBSPOT_APP_HOST = process.env.HUBSPOT_APP_HOST || "https://app-na2.hubspot.com";

// HUBSPOT_DEFINED association: task -> contact. Verified via
// GET /crm/v4/associations/tasks/contacts/labels.
export const TASK_TO_CONTACT_ASSOCIATION_TYPE_ID = 204;

export type HubSpotContact = {
  id: string;
  properties: Record<string, string | null>;
};

export type HubSpotTask = {
  id: string;
  properties: Record<string, string | null>;
};

function token(): string {
  const value = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
  if (!value) {
    throw new Error(
      "Missing HUBSPOT_PRIVATE_APP_TOKEN. Set it in .env (private app service token).",
    );
  }
  return value;
}

export async function hubspotRequest<T = unknown>(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token()}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HubSpot ${method} ${path} failed (${response.status}): ${text}`);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

/**
 * Exact-match lookup on the contact's primary `email`. HubSpot stores/matches
 * email case-insensitively, but we lowercase anyway so the search value matches
 * what the CRM holds (MLS data arrives mixed-case, e.g. Ron@TheWilsteinTeam.com).
 */
export async function findContactByEmail(
  email: string,
  properties: string[] = [],
): Promise<HubSpotContact | null> {
  const normalized = email.trim().toLowerCase();
  if (!normalized) throw new Error("findContactByEmail: empty email.");

  const result = await hubspotRequest<{ results: HubSpotContact[] }>(
    "POST",
    "/crm/v3/objects/contacts/search",
    {
      filterGroups: [
        { filters: [{ propertyName: "email", operator: "EQ", value: normalized }] },
      ],
      properties: Array.from(new Set(["email", "firstname", "lastname", ...properties])),
      limit: 1,
    },
  );
  return result.results?.[0] ?? null;
}

export async function createContact(
  properties: Record<string, string | number>,
): Promise<HubSpotContact> {
  return hubspotRequest<HubSpotContact>("POST", "/crm/v3/objects/contacts", { properties });
}

export async function updateContact(
  contactId: string,
  properties: Record<string, string | number>,
): Promise<HubSpotContact> {
  return hubspotRequest<HubSpotContact>("PATCH", `/crm/v3/objects/contacts/${contactId}`, {
    properties,
  });
}

/** Create a task and associate it to a contact in one call. */
export async function createTask(
  properties: Record<string, string | number>,
  contactId: string,
): Promise<HubSpotTask> {
  return hubspotRequest<HubSpotTask>("POST", "/crm/v3/objects/tasks", {
    properties,
    associations: [
      {
        to: { id: contactId },
        types: [
          {
            associationCategory: "HUBSPOT_DEFINED",
            associationTypeId: TASK_TO_CONTACT_ASSOCIATION_TYPE_ID,
          },
        ],
      },
    ],
  });
}

/** Deep link to a task record (object type 0-27). */
export function taskUrl(taskId: string): string {
  return `${HUBSPOT_APP_HOST}/contacts/${HUBSPOT_PORTAL_ID}/record/0-27/${taskId}/`;
}

/** Deep link to a contact record (object type 0-1). */
export function contactUrl(contactId: string): string {
  return `${HUBSPOT_APP_HOST}/contacts/${HUBSPOT_PORTAL_ID}/record/0-1/${contactId}/`;
}
