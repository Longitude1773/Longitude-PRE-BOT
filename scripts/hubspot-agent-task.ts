/**
 * PRE Bot → HubSpot: on an approved listing, upsert the listing agent as a
 * HubSpot contact, stamp evaluation-tracking properties, and create a short
 * reminder task pointing Erik at the matching Sales Template.
 *
 * The email COPY lives in a HubSpot Sales Template now, not here — the bot no
 * longer renders an email body (see scripts/hubspot-task-template.ts).
 *
 * `createAgentTaskForListing()` is the single shared entry point used by both
 * the by-hand CLI (below) and the Slack approve handler
 * (scripts/workflows/approve-eval.ts), so both run identical code.
 *
 * By-hand usage:
 *   npx tsx scripts/hubspot-agent-task.ts --mls 12603349 [--dry-run]
 *   npx tsx scripts/hubspot-agent-task.ts --eval-id <uuid> [--dry-run]
 *   --force   bypass the approved-status and new_listing-source guards (testing)
 *
 * SCOPE GUARD — only listings the MLS watcher found (listing_source =
 * "new_listing") get a task. Manually triggered PREs (mls_on_demand /
 * zillow_on_demand) are excluded by design.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  createContact,
  createTask,
  contactUrl,
  findContactByEmail,
  taskUrl,
  updateContact,
} from "./hubspot.ts";
import { renderTaskBody, renderTaskSubject, type AgentStatus } from "./hubspot-task-template.ts";

const repoRoot = resolve(import.meta.dirname, "..");

// The bot's scripts normally inherit env from launchd/Hermes; a by-hand run
// does not, and the gateway snapshots env at start (set -a; source .env) so a
// token added later would not be visible. Load .env lazily here so the token is
// picked up without a gateway restart.
let envLoaded = false;
function loadEnv() {
  if (envLoaded) return;
  envLoaded = true;
  const path = resolve(repoRoot, ".env");
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const i = line.indexOf("=");
      if (i > 0 && !line.trimStart().startsWith("#")) {
        const key = line.slice(0, i).trim();
        if (!process.env[key]) process.env[key] = line.slice(i + 1).trim();
      }
    }
  } catch {
    // No .env on disk (e.g. env supplied entirely by the launchd/Hermes
    // environment) — rely on whatever process.env already holds.
  }
}

// Erik — task owner in HubSpot.
const TASK_OWNER_ID = process.env.HUBSPOT_TASK_OWNER_ID || "80608210";

// Only MLS-watcher listings get an agent task.
const ALLOWED_LISTING_SOURCE = "new_listing";

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}

/**
 * {{address}} is street + city — "2100 Frostwood Boulevard 4163, Park City".
 * listings.address holds the full one-line address including state + zip, so
 * take the leading street segment and pair it with the city column.
 */
export function buildDisplayAddress(address: unknown, city: unknown): string {
  const street = text(address).split(",")[0].trim();
  const cityName = text(city);
  if (!street) throw new Error("Listing has no address — cannot build the task subject.");
  return cityName ? `${street}, ${cityName}` : street;
}

/** "$54,400 to $97,900" — conservative (low_rev) through optimized (high_rev). */
export function buildRevenueRange(lowRev: unknown, highRev: unknown): string {
  const low = Number(lowRev);
  const high = Number(highRev);
  if (!Number.isFinite(low) || !Number.isFinite(high) || low <= 0 || high <= 0) {
    throw new Error(`Evaluation is missing revenue numbers (low=${lowRev}, high=${highRev}).`);
  }
  const format = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
  return `${format(low)} to ${format(high)}`;
}

/**
 * listing_agent_name is one text field. First token is the given name, last
 * token is the surname; anything between is a middle name/initial and is
 * dropped ("Karen E. March" -> Karen / March), since HubSpot has no middle-name
 * field and "Hi Karen E.," reads wrong in an email.
 */
export function splitAgentName(fullName: unknown): { firstName: string; lastName: string } {
  const parts = text(fullName).split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: "", lastName: "" };
  if (parts.length === 1) return { firstName: parts[0], lastName: "" };
  return { firstName: parts[0], lastName: parts[parts.length - 1] };
}

/** HubSpot date properties take midnight-UTC; YYYY-MM-DD is accepted on v3. */
function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export type CreateAgentTaskOptions = {
  evalId?: string;
  mlsNumber?: string;
  dryRun?: boolean;
  force?: boolean;
  /** When false, suppress per-step console logging (used by the approve handler). */
  log?: boolean;
};

export type CreateAgentTaskResult = {
  ok: boolean;
  /** Present when nothing was created; a reason the caller can surface. */
  skipped?: "already-exists" | "wrong-source" | "not-approved" | "no-agent-email" | "dry-run";
  reason?: string;
  agentStatus?: AgentStatus;
  mlsNumber?: string;
  evalId?: string;
  contactId?: string;
  contactCreated?: boolean;
  taskId?: string;
  taskUrl?: string;
  /** True when the Supabase write-back could not be persisted (columns missing, etc). */
  writeBackFailed?: boolean;
};

/**
 * Shared entry point. Resolves the evaluation + listing from Supabase, upserts
 * the HubSpot contact, sets tracking properties, creates the reminder task, and
 * writes the HubSpot ids back to the evaluation row. Idempotent: if the row
 * already carries a hubspot_task_id it returns { ok:true, skipped:"already-exists" }.
 *
 * Throws only on genuine HubSpot/Supabase failures — the guards (source, status,
 * missing email) return a skipped result instead so callers can decide whether
 * to speak up. The approve handler treats this whole call as best-effort.
 */
export async function createAgentTaskForListing(
  opts: CreateAgentTaskOptions,
): Promise<CreateAgentTaskResult> {
  loadEnv();
  const wantLog = opts.log ?? false;
  const say = (msg: string) => {
    if (wantLog) console.log(msg);
  };

  if (!opts.evalId && !opts.mlsNumber) {
    throw new Error("createAgentTaskForListing: provide evalId or mlsNumber.");
  }

  // Imported lazily: scripts/supabase.ts reads its credentials at import time.
  const { supabase } = await import("./supabase.ts");
  const { preSitePropertyUrl } = await import("./workflows/lib.ts");

  // --- Resolve the evaluation --------------------------------------------
  let evaluation: Record<string, unknown> | null = null;
  if (opts.evalId) {
    const { data, error } = await supabase
      .from("evaluations")
      .select("*")
      .eq("eval_id", opts.evalId)
      .limit(1);
    if (error) throw new Error(`Supabase evaluations lookup failed: ${error.message}`);
    evaluation = data?.[0] ?? null;
    if (!evaluation) throw new Error(`No evaluation with eval_id ${opts.evalId}.`);
  } else {
    const { data, error } = await supabase
      .from("evaluations")
      .select("*")
      .eq("mls_number", opts.mlsNumber)
      .order("version", { ascending: false })
      .order("created_at", { ascending: false });
    if (error) throw new Error(`Supabase evaluations lookup failed: ${error.message}`);
    evaluation = data?.[0] ?? null;
    if (!evaluation) throw new Error(`No evaluation rows for MLS # ${opts.mlsNumber}.`);
  }

  const mlsNumber = text(evaluation.mls_number);
  const evalId = text(evaluation.eval_id);
  const listingSource = text(evaluation.listing_source);
  const status = text(evaluation.status);

  // --- Idempotency: a task already exists for this eval row --------------
  // `hubspot_task_id` may not exist yet if the migration hasn't been run; a
  // missing property simply reads as undefined and we proceed (best-effort).
  const existingTaskId = text(evaluation.hubspot_task_id);
  if (existingTaskId) {
    say(`Skip: eval ${evalId} already has HubSpot task ${existingTaskId}.`);
    return {
      ok: true,
      skipped: "already-exists",
      reason: `HubSpot task ${existingTaskId} already exists for this evaluation.`,
      mlsNumber,
      evalId,
      taskId: existingTaskId,
      taskUrl: taskUrl(existingTaskId),
    };
  }

  // --- Guards (return, don't throw) --------------------------------------
  if (listingSource !== ALLOWED_LISTING_SOURCE && !opts.force) {
    const reason =
      `listing_source "${listingSource}" — agent tasks are only created for ` +
      `MLS-watcher listings ("${ALLOWED_LISTING_SOURCE}").`;
    say(`Skip: ${reason}`);
    return { ok: true, skipped: "wrong-source", reason, mlsNumber, evalId };
  }
  if (status !== "approved" && !opts.force) {
    const reason = `evaluation status is "${status}", not "approved".`;
    say(`Skip: ${reason}`);
    return { ok: true, skipped: "not-approved", reason, mlsNumber, evalId };
  }

  // --- Resolve the listing ------------------------------------------------
  const { data: listings, error: listingError } = await supabase
    .from("listings")
    .select("*")
    .eq("mls_number", mlsNumber)
    .limit(1);
  if (listingError) throw new Error(`Supabase listings lookup failed: ${listingError.message}`);
  const listing = listings?.[0];
  if (!listing) throw new Error(`No listing row for MLS # ${mlsNumber}.`);

  const agentEmail = text(listing.listing_agent_email).toLowerCase();
  if (!agentEmail) {
    const reason =
      `listing ${mlsNumber} has no listing_agent_email (the MLS watcher only ` +
      `captures agent email via the business-card popup) — nobody to match/create.`;
    say(`Skip: ${reason}`);
    return { ok: true, skipped: "no-agent-email", reason, mlsNumber, evalId };
  }

  const { firstName: mlsFirstName, lastName: mlsLastName } = splitAgentName(
    listing.listing_agent_name || listing.agent,
  );
  const displayAddress = buildDisplayAddress(listing.address, listing.city);
  const revenueRange = buildRevenueRange(evaluation.low_rev, evaluation.high_rev);
  const propertyPageUrl = preSitePropertyUrl({ address: listing.address, mlsNumber });

  // --- Find or create the HubSpot contact --------------------------------
  const TRACKING_PROPERTIES = [
    "agent_source",
    "evaluations_sent_count",
    "last_evaluated_property",
    "last_evaluation_url",
    "last_evaluation_revenue_range",
    "last_evaluation_sent_date",
    "phone",
    "company",
  ];
  const existing = await findContactByEmail(agentEmail, TRACKING_PROPERTIES);
  const agentStatus: AgentStatus = existing ? "EXISTING" : "NEW";

  const priorCount = Number(existing?.properties?.evaluations_sent_count ?? 0);
  const nextCount = (Number.isFinite(priorCount) ? priorCount : 0) + 1;

  say("Resolved:");
  say(`  MLS #            ${mlsNumber}  (${listingSource}, status=${status})`);
  say(`  Eval ID          ${evalId}  v${text(evaluation.version)}`);
  say(`  Address          ${displayAddress}`);
  say(`  Revenue range    ${revenueRange}`);
  say(`  Property page    ${propertyPageUrl}`);
  say(
    `  Agent            ${mlsFirstName} ${mlsLastName} <${agentEmail}> ` +
      `${text(listing.listing_agent_phone)} | ${text(listing.listing_brokerage)}`,
  );
  say(
    existing
      ? `  HubSpot contact  ${existing.id} (EXISTING) — ${contactUrl(existing.id)}`
      : "  HubSpot contact  none found — will create (NEW)",
  );

  const subject = renderTaskSubject(displayAddress, agentStatus);
  const body = renderTaskBody(agentStatus);
  say(`  Task subject     ${subject}`);

  if (opts.dryRun) {
    say(`\nDRY RUN — nothing written. evaluations_sent_count would go ${priorCount} → ${nextCount}.`);
    return {
      ok: true,
      skipped: "dry-run",
      reason: "dry run",
      agentStatus,
      mlsNumber,
      evalId,
      contactId: existing?.id,
    };
  }

  // Upsert the contact.
  let contactId: string;
  let contactCreated = false;
  if (existing) {
    contactId = existing.id;
  } else {
    const created = await createContact({
      firstname: mlsFirstName,
      lastname: mlsLastName,
      email: agentEmail,
      phone: text(listing.listing_agent_phone),
      company: text(listing.listing_brokerage),
      lifecyclestage: "lead",
      agent_source: "PRE Bot",
    });
    contactId = created.id;
    contactCreated = true;
    say(`Created contact ${contactId} — ${contactUrl(contactId)}`);
  }

  // Create the reminder task, associated to the contact.
  const task = await createTask(
    {
      hs_task_subject: subject,
      hs_task_body: body,
      hs_timestamp: String(Date.now()),
      hubspot_owner_id: TASK_OWNER_ID,
      hs_task_status: "NOT_STARTED",
      hs_task_type: "EMAIL",
      hs_task_priority: "HIGH",
    },
    contactId,
  );

  // Stamp tracking properties (these feed the HubSpot Sales Template tokens).
  await updateContact(contactId, {
    last_evaluated_property: displayAddress,
    last_evaluation_url: propertyPageUrl,
    last_evaluation_revenue_range: revenueRange,
    last_evaluation_sent_date: todayIsoDate(),
    evaluations_sent_count: nextCount,
  });

  // Write HubSpot ids back to the evaluation row (idempotency + audit). Best-
  // effort: if the columns don't exist yet (migration not run), the task is
  // already created, so log and carry on rather than fail the whole call.
  const createdAtIso = new Date().toISOString();
  let writeBackFailed = false;
  const { error: writeErr } = await supabase
    .from("evaluations")
    .update({
      hubspot_contact_id: contactId,
      hubspot_task_id: task.id,
      hubspot_task_created_at: createdAtIso,
    })
    .eq("eval_id", evalId);
  if (writeErr) {
    writeBackFailed = true;
    console.error(
      `HubSpot task ${task.id} created, but Supabase write-back failed for eval ${evalId}: ` +
        `${writeErr.message}. Run sql/2026-07-24-hubspot-writeback-columns.sql if the columns are missing.`,
    );
  }

  say(
    `\nTask ${task.id} created for ${agentStatus} contact ${contactId} ` +
      `(evaluations_sent_count → ${nextCount}).`,
  );
  say(taskUrl(task.id));

  return {
    ok: true,
    agentStatus,
    mlsNumber,
    evalId,
    contactId,
    contactCreated,
    taskId: task.id,
    taskUrl: taskUrl(task.id),
    writeBackFailed,
  };
}

// --- CLI wrapper ---------------------------------------------------------

type Args = { mls?: string; evalId?: string; dryRun: boolean; force: boolean };

function parseArgs(argv: string[]): Args {
  const args: Args = { dryRun: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--force") args.force = true;
    else if (arg === "--mls") args.mls = argv[++i];
    else if (arg === "--eval-id") args.evalId = argv[++i];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.mls && !args.evalId) {
    throw new Error("Provide --mls <mls-number> or --eval-id <uuid>.");
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await createAgentTaskForListing({
    mlsNumber: args.mls,
    evalId: args.evalId,
    dryRun: args.dryRun,
    force: args.force,
    log: true,
  });
  if (result.skipped && result.skipped !== "dry-run") {
    console.log(`\nSkipped (${result.skipped}): ${result.reason}`);
  }
}

// Only run the CLI when invoked directly, not when imported by the approve handler.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
