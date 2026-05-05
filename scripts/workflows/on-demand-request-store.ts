import { randomUUID } from "node:crypto";

import { supabase } from "../supabase.ts";

export type OnDemandRequestCommandType = "scrape_zillow_listing" | "scrape_mls_listing";
export type OnDemandRequestStatus = "queued" | "scraping" | "evaluating" | "posted" | "failed";

type OnDemandRequestRow = {
  id: string;
  request_key: string;
  source_url: string;
  command_type: OnDemandRequestCommandType;
  channel: string;
  thread_ts: string | null;
  listing_id: string | null;
  listing_url: string | null;
  eval_id: string | null;
  version: number | null;
  command_id: string | null;
  status: OnDemandRequestStatus;
  event_path: string | null;
  error: string | null;
  lease_owner: string | null;
  lease_expires_at: string | null;
  created_at: string;
  updated_at: string;
};

export type OnDemandRequestRecord = {
  id: string;
  requestKey: string;
  sourceUrl: string;
  commandType: OnDemandRequestCommandType;
  channel: string;
  threadTs?: string;
  listingId?: string;
  listingUrl?: string;
  evalId?: string;
  version?: number;
  commandId?: string;
  status: OnDemandRequestStatus;
  eventPath?: string;
  error?: string;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  createdAt: string;
  updatedAt: string;
};

type EnsureOnDemandRequestInput = {
  requestKey: string;
  sourceUrl: string;
  commandType: OnDemandRequestCommandType;
  channel: string;
  threadTs?: string;
  eventPath?: string;
};

type OnDemandRequestPatch = {
  sourceUrl?: string | null;
  channel?: string | null;
  threadTs?: string | null;
  listingId?: string | null;
  listingUrl?: string | null;
  evalId?: string | null;
  version?: number | null;
  commandId?: string | null;
  status?: OnDemandRequestStatus;
  eventPath?: string | null;
  error?: string | null;
  leaseOwner?: string | null;
  leaseExpiresAt?: string | null;
};

const tableName = "on_demand_requests";

function isSupabaseError(value: unknown): value is { code?: string; message?: string } {
  return typeof value === "object" && value !== null && ("code" in value || "message" in value);
}

function formatStoreError(action: string, error: unknown): never {
  if (isSupabaseError(error) && error.code === "42P01") {
    throw new Error(
      `Supabase table "${tableName}" is missing. Run sql/2026-04-14-on-demand-requests.sql in the Supabase SQL Editor first.`,
    );
  }
  const message = isSupabaseError(error) ? error.message || String(error.code || error) : String(error);
  throw new Error(`On-demand request store ${action} failed: ${message}`);
}

function toRecord(row: OnDemandRequestRow | null) {
  if (!row) return null;
  return {
    id: row.id,
    requestKey: row.request_key,
    sourceUrl: row.source_url,
    commandType: row.command_type,
    channel: row.channel,
    threadTs: row.thread_ts || undefined,
    listingId: row.listing_id || undefined,
    listingUrl: row.listing_url || undefined,
    evalId: row.eval_id || undefined,
    version: row.version ?? undefined,
    commandId: row.command_id || undefined,
    status: row.status,
    eventPath: row.event_path || undefined,
    error: row.error || undefined,
    leaseOwner: row.lease_owner || undefined,
    leaseExpiresAt: row.lease_expires_at || undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  } satisfies OnDemandRequestRecord;
}

function toRowPatch(patch: OnDemandRequestPatch) {
  const rowPatch: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };
  if (patch.sourceUrl !== undefined) rowPatch.source_url = patch.sourceUrl;
  if (patch.channel !== undefined) rowPatch.channel = patch.channel;
  if (patch.threadTs !== undefined) rowPatch.thread_ts = patch.threadTs;
  if (patch.listingId !== undefined) rowPatch.listing_id = patch.listingId;
  if (patch.listingUrl !== undefined) rowPatch.listing_url = patch.listingUrl;
  if (patch.evalId !== undefined) rowPatch.eval_id = patch.evalId;
  if (patch.version !== undefined) rowPatch.version = patch.version;
  if (patch.commandId !== undefined) rowPatch.command_id = patch.commandId;
  if (patch.status !== undefined) rowPatch.status = patch.status;
  if (patch.eventPath !== undefined) rowPatch.event_path = patch.eventPath;
  if (patch.error !== undefined) rowPatch.error = patch.error;
  if (patch.leaseOwner !== undefined) rowPatch.lease_owner = patch.leaseOwner;
  if (patch.leaseExpiresAt !== undefined) rowPatch.lease_expires_at = patch.leaseExpiresAt;
  return rowPatch;
}

async function readOnDemandRequestRow(requestKey: string) {
  const { data, error } = await supabase
    .from(tableName)
    .select("*")
    .eq("request_key", requestKey)
    .maybeSingle<OnDemandRequestRow>();
  if (error) formatStoreError(`read for ${requestKey}`, error);
  return data ?? null;
}

export async function readOnDemandRequest(requestKey: string) {
  return toRecord(await readOnDemandRequestRow(requestKey));
}

export async function ensureOnDemandRequest(input: EnsureOnDemandRequestInput) {
  const insertPayload = {
    request_key: input.requestKey,
    source_url: input.sourceUrl,
    command_type: input.commandType,
    channel: input.channel,
    thread_ts: input.threadTs ?? null,
    status: "queued" satisfies OnDemandRequestStatus,
    event_path: input.eventPath ?? null,
  };

  const { data, error } = await supabase
    .from(tableName)
    .insert(insertPayload)
    .select("*")
    .maybeSingle<OnDemandRequestRow>();

  if (!error) return toRecord(data);
  if (isSupabaseError(error) && error.code === "23505") {
    return readOnDemandRequest(input.requestKey);
  }
  formatStoreError(`insert for ${input.requestKey}`, error);
}

async function tryClaimLease(
  requestKey: string,
  leaseOwner: string,
  leaseExpiresAt: string,
  mode: "unowned" | "expired" | "owned",
) {
  let query = supabase
    .from(tableName)
    .update(toRowPatch({ leaseOwner, leaseExpiresAt }))
    .eq("request_key", requestKey);

  if (mode === "unowned") {
    query = query.is("lease_owner", null);
  } else if (mode === "expired") {
    query = query.lt("lease_expires_at", new Date().toISOString());
  } else {
    query = query.eq("lease_owner", leaseOwner);
  }

  const { data, error } = await query.select("*").maybeSingle<OnDemandRequestRow>();
  if (error) formatStoreError(`lease claim for ${requestKey}`, error);
  return toRecord(data ?? null);
}

export async function acquireOnDemandRequestLease(params: {
  requestKey: string;
  timeoutMs: number;
  leaseMs: number;
  pollMs?: number;
}) {
  const leaseOwner = randomUUID();
  const deadline = Date.now() + params.timeoutMs;
  const pollMs = params.pollMs ?? 1000;

  while (Date.now() < deadline) {
    const leaseExpiresAt = new Date(Date.now() + params.leaseMs).toISOString();

    const unowned = await tryClaimLease(
      params.requestKey,
      leaseOwner,
      leaseExpiresAt,
      "unowned",
    );
    if (unowned) return { leaseOwner, record: unowned };

    const expired = await tryClaimLease(
      params.requestKey,
      leaseOwner,
      leaseExpiresAt,
      "expired",
    );
    if (expired) return { leaseOwner, record: expired };

    const alreadyOwned = await tryClaimLease(
      params.requestKey,
      leaseOwner,
      leaseExpiresAt,
      "owned",
    );
    if (alreadyOwned) return { leaseOwner, record: alreadyOwned };

    await new Promise((resolvePoll) => setTimeout(resolvePoll, pollMs));
  }

  throw new Error(`Timed out waiting for the on-demand request lease for ${params.requestKey}.`);
}

export async function saveOnDemandRequestState(
  requestKey: string,
  patch: OnDemandRequestPatch,
  options?: { leaseOwner?: string; commandId?: string },
) {
  let query = supabase
    .from(tableName)
    .update(toRowPatch(patch))
    .eq("request_key", requestKey);

  if (options?.leaseOwner) query = query.eq("lease_owner", options.leaseOwner);
  if (options?.commandId) query = query.eq("command_id", options.commandId);

  const { data, error } = await query.select("*").maybeSingle<OnDemandRequestRow>();
  if (error) formatStoreError(`update for ${requestKey}`, error);
  return toRecord(data ?? null);
}

export async function releaseOnDemandRequestLease(
  requestKey: string,
  leaseOwner: string,
  patch?: Omit<OnDemandRequestPatch, "leaseOwner" | "leaseExpiresAt">,
) {
  return saveOnDemandRequestState(
    requestKey,
    {
      ...patch,
      leaseOwner: null,
      leaseExpiresAt: null,
    },
    { leaseOwner },
  );
}

export async function markOnDemandRequestForCommand(params: {
  requestKey: string;
  commandId: string;
  status: OnDemandRequestStatus;
  error?: string | null;
}) {
  return saveOnDemandRequestState(
    params.requestKey,
    {
      status: params.status,
      error: params.error ?? null,
    },
    { commandId: params.commandId },
  );
}
