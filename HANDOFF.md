# HANDOFF

> Rolling status from the previous session. Read alongside `ANCHOR.md` (durable
> architecture) at the start of each session. Update the top section when you finish
> meaningful work.

## Current status — 2026-08-10 — recovered from a 4-day silent stall

The bot had been queuing listings without evaluating or posting them since **Aug 6**.
Two *independent* failures, neither of which crashed anything — both services stayed
"running" the whole time, so launchd's `KeepAlive` never noticed and nothing alerted.
Both are fixed and the backlog is drained.

### Failure 1 — Supabase 1000-row cap silently truncated every read (the queue backup)

`readTable()` issued a bare `select("*")`. PostgREST caps a single response at **1000
rows**, so once a table crossed that line the extra rows came back missing — which is
indistinguishable from "row doesn't exist" to any caller building a lookup from it.

The cascade:

1. `listings` crossed 1000 rows on **Aug 6 16:13 MDT** (that very batch took it 1001→1017).
2. MLS **12603612** landed at row #1014 → invisible to the dedupe in `existingMlsState()`.
3. It's a `hold_missing_str_approval` item, so it **never leaves the queue** — it got
   re-added to the listings insert batch every single cycle.
4. `insertRows()` is one atomic multi-row insert, so that one duplicate PK aborted the
   **entire** batch; the catch then marked *every* pending post failed and re-queued them.

Net: 15 STR-approved listings stuck, nothing posted for 4 days, queue growing every cycle.

**Fixed in `1c97971`** — `readTable()` pages with `.range()` until a short page comes back,
ordered by each table's PK so page boundaries stay stable. Two tables were truncating far
worse than `listings`:

| Table | True rows | Was returning |
|---|---|---|
| Comparables | 2390 | 1000 |
| Monthly Projections | 9660 | 1000 |

⚠️ **Anything that read comps or monthly projections through `readSheet` before Aug 10 was
working off a partial slice** — including the "read past Adjustments to learn from prior
feedback" step. Worth a look if past projections seem off.

**Hardened in `0969552`** — pagination removed the trigger, but not the fragility:
- Listing writes now use `upsertSheetRows()` (new `upsertRows()` in `supabase.ts`, keyed on
  the sheet PK) so a legitimately-present row can't reject its whole batch.
- The write phase no longer batches across listings. Each ready listing carries its own
  listing row + evaluation and writes them inside the same per-listing `try/catch` that
  already wrapped the Slack post, so **one bad listing re-queues itself and nothing else**.

### Failure 2 — gateway Slack socket died and never recovered

Separately, the gateway's socket-mode connection dropped on **Aug 5 ~10:05 MDT** and spun
in an unrecoverable retry loop (`RuntimeError: Session is closed`, underlying `aiohttp`
connector permanently closed) — **43k+** retries, no reconnect, process never exited.

Outbound posting kept working through Aug 6 because `scripts/slack.ts` uses the Web API
directly. Only **inbound** was dead: thread replies, adjustments, and approvals were
silently dropped for 5 days.

Fixed by `launchctl kickstart -k gui/501/com.longitude.pre-bot.gateway`. It pruned a pile
of stale sessions from the crashed instance and reconnected; retry count then held flat.

**No code fix for this one — if the socket dies again, the symptom is identical and the
remedy is the same kickstart.** A real liveness check (below) is the missing piece.

### ⚠️ The documented health check is misleading

`.hermes-runtime/gateway_state.json` read `"state": "connected"` the entire time the
gateway was deaf. Worse, the file is **useless as a liveness check in either direction**:
it is written only when the connection state *changes*, so `updated_at` being old is the
normal condition for a healthy long-running gateway. (Verified after the fix: gateway
connected and working, `updated_at` unchanged 22 minutes later.)

The signal that actually distinguishes the two states is the reconnect loop in the log:

```bash
# sample twice — a climbing count means the socket is dead and needs a kickstart
grep -c 'Session is closed' /tmp/str-bot-gateway.log; sleep 30; grep -c 'Session is closed' /tmp/str-bot-gateway.log
```

Same trap on the pipeline side: the watcher logs `queue processor { ok: true, ... }` even
when every listing inside failed. **`ok: true` refers to the run, not the listings** — read
`actionCounts` for `failed`.

### Recovery + current state

Ran `process-mls-review-queue.ts` by hand (watcher was idle outside its 7:00–19:00 MT scan
window, so no double-post risk): **15 evaluations posted, 0 failures.** Listings 1017→1032,
Evaluations 805→820. Queue is down to **4 legitimate `hold_missing_str_approval` items**
(12603149, 12603193, 12603345, 12603612) — all held on an empty nightly-rental field, which
is correct behavior, not a failure.

Both services were restarted. The **watcher restart mattered**: it calls
`readSheet("Evaluations")` in its long-lived process, so it was still holding the pre-fix
`readTable` in memory. `evaluations` is at 820 — under the cap today, but it would have hit
the identical stall in a few weeks. **Any change to `scripts/supabase.ts` or
`scripts/sheets.ts` needs a watcher restart**, which `deploy-pull.sh` does not currently
infer (it only watches `watch-mls.ts` / `browser-runtime.ts`).

### Not done / known rough edges

- **Per-listing isolation has not been exercised under a real failure.** Staging one would
  have posted fake evaluations to the live Slack channel. It's structurally sound and
  typechecked, but the next genuine failure is its first live test.
- **`writeEvaluationVersionsBatch` isn't transactional** — three sequential inserts
  (Evaluations → Monthly Projections → Comparables). A failure between them re-queues the
  listing, which regenerates the evaluation with a fresh UUID next cycle and orphans the
  partial rows. Rare, and far better than the old behavior, but not clean.
- **Nothing alerts on a stalled pipeline.** Both failures were invisible until someone
  looked. A check on "listings posted in the last 24h" plus a fresh-`updated_at` assertion
  would have caught both within an hour.

## Previous status — 2026-07-24 — HubSpot agent tasks, Phase 2 (wired into approve)

The HubSpot integration now runs **automatically on the Slack "approve" path**, and the
email copy has **moved out of the bot into a HubSpot Sales Template**. On approve the bot
only: (1) upserts the listing agent as a HubSpot contact, (2) stamps tracking properties
that feed the template's personalization tokens, (3) creates a short reminder task, and
(4) writes the HubSpot ids back to Supabase. It no longer renders any email HTML.

### ⚠️ MANUAL STEP remaining before this is live on the Mini

1. ✅ **DONE — migration run.** `sql/2026-07-24-hubspot-writeback-columns.sql` has been
   applied in Supabase (adds `hubspot_contact_id`, `hubspot_task_id`,
   `hubspot_task_created_at` to `evaluations`). Idempotency + write-back verified live.
2. **Add `HUBSPOT_PRIVATE_APP_TOKEN`** to the **Mini's** `.env` (it's only in this
   laptop's `.env` today). The module lazy-loads `.env`, so no gateway restart needed —
   but without the token every approve posts "⚠️ HubSpot task not created". Add it before
   (or alongside) running `deploy-pull.sh` on the Mini.

Then deploy as usual: commit → push → `./scripts/deploy-pull.sh` on the Mini. The approve
handler is under `scripts/workflows/**`, so **no service restart** is required (each
approve is a fresh `tsx` subprocess).

### Behavior on approve (all best-effort, never blocks the approval/PDF)

Runs LAST in `approve-eval.ts`, after PDF + R2 + status flip + thread context. Operates on
the exact resolved `Eval ID` (no version ambiguity — note **197/424 MLS#s have multiple
eval rows** from re-evals). Idempotent on that row's `hubspot_task_id`.

- **wrong-source** (`listing_source != new_listing`, i.e. manual/on-demand PREs) → skip,
  silent.
- **already-exists** (row has `hubspot_task_id`) → skip, silent.
- **no-agent-email** → skip + posts `⚠️ No HubSpot task — <reason>` (actionable; most
  listings lack agent email — watcher only captures it via the business-card popup).
- **error / write-back-failed** → posts a ⚠️ note; approval still succeeds.

### Shared function (one code path)

`createAgentTaskForListing({ evalId? | mlsNumber?, dryRun?, force? })` in
`scripts/hubspot-agent-task.ts` is called by **both** the by-hand CLI and the approve
handler, so they run identical code. Returns `{ ok, skipped?, reason?, agentStatus,
contactId, taskId, taskUrl, contactCreated, writeBackFailed }`.

```bash
npx tsx scripts/hubspot-agent-task.ts --mls 12603349 --dry-run   # resolve, write nothing
npx tsx scripts/hubspot-agent-task.ts --eval-id <uuid>           # by hand, for real
# --force bypasses the source/status guards (testing only)
```

### Agent status flag (which template to use)

Contact match by exact primary email decides `agent_status`: **EXISTING** if found, **NEW**
if the bot created it. Reflected on the task so Erik picks the right template:
- Subject: `Send revenue evaluation email — <address> · <NEW|EXISTING> agent`
- Body names the template: `New Listing PRE Delivery (New contact)` /
  `… (Existing contact)`.

### Property / field mapping (verified live)

Contact upsert (match `lower(email)`):
- *create-only:* `firstname`/`lastname` (first+last token, middle dropped), `email`,
  `phone`, `company` = brokerage, `lifecyclestage="lead"`, `agent_source="PRE Bot"`.
- *always set:* `last_evaluated_property` = `"<street>, <city>"` · `last_evaluation_url`
  = `preSitePropertyUrl()` · `last_evaluation_revenue_range` = `low_rev→high_rev`
  (`"$54,400 to $97,900"`) · `last_evaluation_sent_date` = today ·
  `evaluations_sent_count` = prior+1.

Task props: `hs_task_status=NOT_STARTED`, `hs_task_type=EMAIL`, `hs_task_priority=HIGH`,
`hubspot_owner_id=80608210`, `hs_timestamp`=now ms, associated to the contact (typeId
**204**).

Supabase write-back (`evaluations` by `eval_id`): `hubspot_contact_id`, `hubspot_task_id`,
`hubspot_task_created_at`.

### Files

- `scripts/hubspot.ts` — CRM v3 client (unchanged from Phase 1): `findContactByEmail` /
  `createContact` / `updateContact` / `createTask` (assoc typeId 204) / `taskUrl` /
  `contactUrl`. Portal 242965527, host **na2**.
- `scripts/hubspot-task-template.ts` — **now just the task subject + body** keyed on
  agent status. The old HTML email builder was removed (copy lives in HubSpot now).
- `scripts/hubspot-agent-task.ts` — the shared `createAgentTaskForListing()` + a thin CLI
  wrapper. Lazy-loads `.env`.
- `scripts/workflows/approve-eval.ts` — best-effort HubSpot call + ⚠️ Slack notes.
- `sql/2026-07-24-hubspot-writeback-columns.sql` — the write-back migration (run by hand).

### Validation (live, 2026-07-24)

- **Existing-agent + new revenue-range property:** approved MLS `12603238` (Ron Wilstein
  `489981101794`). Verified: subject `… · EXISTING agent`, body names the Existing-contact
  template, `NOT_STARTED/EMAIL/HIGH`, owner 80608210, association, and contact
  `last_evaluation_revenue_range="$54,400 to $97,900"` + all tracking props +
  `last_evaluation_sent_date=2026-07-24`.
- **Graceful degradation:** a run before the migration correctly failed-soft (task created,
  write-back logged its reason, no throw) — proves the step is non-blocking.
- **Write-back + idempotency (post-migration):** run 1 created task `385998305982` and
  stamped `hubspot_contact_id/task_id/created_at` on eval `138192cf`; run 2 read the column
  and skipped (`already-exists`). Per-eval-row idempotency confirmed (the MLS's other eval
  row stays untouched).
- **Source gate** returns a soft skip (not a throw) for `mls_on_demand`, so the approve
  path stays clean.
- **Not yet exercised live:** a genuinely **NEW** agent (both earlier test agents now exist
  in HubSpot). The NEW code path is otherwise identical bar the subject/body strings.

**Test-artifact cleanup:** several throwaway tasks now sit on the Ron Wilstein contact
`489981101794` (Phase 1 + Phase 2 runs) — delete them in HubSpot when convenient.

## Earlier status — 2026-07-06

**The bot is fully migrated from the old laptop to this Mac mini and operational.**
Gateway + MLS watcher run detached and Slack-connected; an end-to-end test passed (the
agent processed a "set balanced revenue" adjustment, applied the locked ×1.35/×0.75
spread, and bumped the eval version).

### How it runs (launchd-managed)

The stack is supervised by two **user LaunchAgents** (`~/Library/LaunchAgents/`):
`com.longitude.pre-bot.gateway` and `com.longitude.pre-bot.watcher`. They start on
login and `KeepAlive`-restart on crash. **Do not run `npm run str:start` anymore** — it
would spawn a duplicate gateway (double-respond) and fight launchd.

```bash
# control
launchctl list | grep longitude.pre-bot                          # status (PID + last exit)
launchctl kickstart -k gui/501/com.longitude.pre-bot.gateway     # restart gateway
launchctl kickstart -k gui/501/com.longitude.pre-bot.watcher     # restart watcher
launchctl bootout   gui/501/com.longitude.pre-bot.gateway        # stop until next load/reboot
launchctl bootstrap gui/501 ~/Library/LaunchAgents/com.longitude.pre-bot.gateway.plist  # (re)load

# health check — gateway_state.json is NOT a liveness signal. It is written only on
# state *transitions*, so a healthy gateway that connected weeks ago and a gateway that
# died mid-session look identical: state="connected", updated_at old. It read
# "connected" through the entire 5-day 2026-08-10 outage.
python3 -c "import json;d=json.load(open('.hermes-runtime/gateway_state.json'))['platforms']['slack'];print(d['state'], d['updated_at'])"

# the real check — is it stuck in the reconnect loop? sample twice; a climbing count
# means the socket is dead and only a kickstart will fix it.
grep -c 'Session is closed' /tmp/str-bot-gateway.log; sleep 30; grep -c 'Session is closed' /tmp/str-bot-gateway.log

tail -f /tmp/str-bot-gateway.log   # and /tmp/str-mls-watch.log
```

Logs stream to `/tmp/str-bot-gateway.log` and `/tmp/str-mls-watch.log`.

**Reboot persistence + FileVault:** FileVault is ON, so after a reboot/power-loss the
encrypted disk stays locked until someone enters the FileVault password at the boot
screen — no launchd job (agent or daemon) can run before that. Once entered, the user
auto-logs-in and the agents start. Net: **crash recovery is fully automatic**; a
**reboot needs one password entry**, then everything comes back. Zero-touch reboots would
require disabling FileVault (not recommended on this credentialed machine).

### Updating the Mini after a push from another machine

The Mini does not auto-pull. On the Mini, run:

```bash
cd ~/projects/Longitude-PRE-BOT && ./scripts/deploy-pull.sh
```

It fast-forwards `origin/main` and restarts **only** the services whose code changed:
`scripts/workflows/**` + `lib.ts` → no restart (each eval/review is a fresh `tsx`
subprocess that re-reads the files); `scripts/watch-mls.ts` / `browser-runtime.ts` →
restarts the watcher (long-lived); `HERMES.md` / `scripts/hermes/*` → restarts the
gateway. Refuses to run on a dirty tree; supports `--dry-run`, `--restart-both`,
`--no-restart`. Manual fallback: `git pull --ff-only` then
`launchctl kickstart -k gui/$(id -u)/com.longitude.pre-bot.{gateway,watcher}` as needed.

## What this session did — machine migration (laptop `erik` → mini `erikmikkelsen`)

Followed `MIGRATION.md`, with several machine-specific gaps that doc did not cover.
Everything below is done and verified:

- **Toolchain + Playwright.** `npx playwright install` hangs on this Mac (its Node zip
  extractor deadlocks). Browsers were installed by downloading the CDN zips and
  extracting with `ditto` (0.7s vs. an infinite hang), then writing `INSTALLATION_COMPLETE`
  markers. **Do not run `npx playwright install` here** — use the ditto method.
- **Secrets + agent brain.** Copied `.env`, `.hermes.env`, the whole `.hermes-runtime/`
  (168 MB `state.db` + memories/skills/sessions), and global `~/.hermes/`
  (`auth.json`, `config.yaml`, `.env`, `SOUL.md`).
- **Codex auth.** The model auth is `~/.hermes/auth.json` (Codex/ChatGPT backend); there
  is **no** `~/.codex` on either machine. Do not create one or point `HERMES_AUTH_FILE`
  at it.
- **Path fixups (`/Users/erik` → `/Users/erikmikkelsen`).** Rewrote `.hermes.env`, both
  `.env` files, and re-pointed the `.hermes-runtime/` symlinks (`auth.json`, `hooks`).
- **Symlink shim.** The carried `state.db` has ~14k `/Users/erik/...` references that
  drove wrong-path tool calls even after fixing skills. Created
  `/Users/erik/projects/Longitude-PRE-BOT` → real repo and `/Users/erik/.hermes` →
  `~/.hermes` (root symlinks, needed sudo) so all old paths resolve.
- **Skill path fix.** The agent's learned skill
  `.hermes-runtime/skills/devops/str-revenue-bot-operations/SKILL.md` hard-coded the old
  path; rewritten to the new home.
- **Hermes framework.** Reinstalled fresh via the NousResearch installer to
  `~/.hermes/hermes-agent`. Its venv was **missing `firecrawl` + `slack_bolt`** — added
  via `ensurepip` + pip.
- **`start-gateway.sh` fix (uncommitted).** Added a line to prepend the venv to PATH so
  `npm run str:start` works without manually activating the venv (preflight runs bare
  `python3`, which is system 3.9.6 and lacks the deps). **This edit is in the working
  tree, not yet committed — commit it so a re-clone keeps it.**
- **Eval data backfill.** Enabled Remote Login on the mini and rsync'd the laptop's
  `data/eval-*.json` (→288), `data/listing-*.json` (→616), and `inbox/thread-context` +
  `inbox/posted-reviews` (existing threads ENOENT'd without these).
- **tirith quarantine.** The transfer stamped `com.apple.quarantine` on the carried
  `.hermes-runtime/bin/tirith` binary, so Gatekeeper blocked it → recurring macOS popup +
  log noise. Cleared with `xattr -d com.apple.quarantine`.

## Outstanding / optional (none block operation)

- [x] **Commit `scripts/hermes/start-gateway.sh`** — DONE in `3653e5d` (venv-PATH fix).
- [ ] **Alert on a stalled pipeline** — the 2026-08-10 outage ran 4 days unnoticed because
      nothing checks outcomes. Highest-value item on this list. Two signals, both of which
      were already sitting in files/logs the whole time:
      - *pipeline:* any `action: "failed"` in the queue-processor result, or a ready
        (`strApproved`) queue item older than ~2h. The watcher already parses
        `actionCounts` in `processReviewQueue()`, so this is a few lines there. Dedup via
        the same pattern as `data/inbox/mls-approval-alert-state.json`.
      - *gateway:* a climbing `Session is closed` count in `/tmp/str-bot-gateway.log`.
        **Do not** use `gateway_state.json` freshness — it only writes on state changes,
        so a healthy long-lived connection looks identical to a dead one.

      Both alert via outbound Slack (`scripts/slack.ts`, Web API), which kept working
      through both failures. Residual gap: if outbound Slack itself breaks, nothing can
      reach you — would need email/push, probably not worth it yet.
- [ ] **Teach `deploy-pull.sh` about the data layer** — it infers restarts from
      `watch-mls.ts` / `browser-runtime.ts` only, but the watcher also imports
      `scripts/sheets.ts` → `scripts/supabase.ts` in its long-lived process. A change to
      either currently deploys without the watcher picking it up; restart it by hand until
      this is fixed.
- [x] **Reboot persistence** — DONE. Two user LaunchAgents supervise the stack with
      KeepAlive (see "How it runs" above). Custom agents (not `hermes gateway install`,
      which assumes the default `~/.hermes` home, not our managed `.hermes-runtime`).
      Reboots still need one FileVault password entry (see note above).
- [ ] **Slack scopes** — add `groups:read` (list private channels) and `mpim:history`
      (multi-person DMs), then reinstall the Slack app. Core posting/DMs already work.
- [ ] **Decommission the laptop** — keep its gateway stopped; two gateways on the same
      Slack app double-respond.
- [ ] Optional: clean up `.bak` files left under `.hermes-runtime/`, `~/.hermes/`, and
      `skills/` (safety backups from the path fixups).

## Hero-photo R2 mirror + backfill (2026-07-23)

`96136e5` added the "mirror `photo-0` to `img.longitude.network/<id>/photo-0.jpg`"
step to the manual (`mls_on_demand`) and Zillow (`zillow_on_demand`) eval paths — it
previously only ran in the MLS-review-queue path, so those PRE Site tiles showed a
placeholder. That fix is forward-only, so evals processed before it still needed their
hero pushed to R2. **Backfilled the three affected evals** (12601448, ZPID-111715943,
12602182) — all now 200 at `img.longitude.network/<id>/photo-0.jpg`.

Reusable helper for future gaps: `scripts/backfill-hero-images-r2.ts`. It scans the
Listings table for manual/Zillow rows whose `data/images/<id>/photo-0.jpg` is on disk
but missing on R2, and uploads them (idempotent; `--dry-run` to preview; pass explicit
ids to target). Run it with `.env` loaded:
`set -a; source .env; set +a; ./node_modules/.bin/tsx scripts/backfill-hero-images-r2.ts`.

## Gotchas worth remembering

- Test the bot on **fresh Slack threads**, not ones with a history of failed turns —
  failed-turn memory can re-confuse the agent (seen as `invalid_blocks` / oversized
  approval cards while it thrashed mid-migration; cleared on a clean session).
- **A "running" process is not a working one.** Both halves of the 2026-08-10 outage kept
  their processes alive and their happy-path logs green while doing nothing useful — so
  `launchctl list` and `ok: true` both lied. Verify outcomes (rows written, messages
  posted, timestamps moving), not liveness.
- Business data (Listings/Evaluations/Comparables) is in **Supabase** and PDFs in **R2**,
  so it is safe regardless of which machine runs the bot — a migration mainly moves
  credentials and local caches.
