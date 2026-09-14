# HANDOFF

> Rolling status from the previous session. Read alongside `ANCHOR.md` (durable
> architecture) at the start of each session. Update the top section when you finish
> meaningful work.

## Current status — 2026-09-11 — gateway outage: silent model rejection + dropped Slack events

> Written 2026-09-14 from the 09-11 session. Two *independent* faults hit the gateway on
> the same day, and they look identical from Slack (the bot goes quiet). Both are fixed;
> the diagnosis took hours mostly because of the logging gotchas in "How to read this log"
> below. Read that part first next time.

**Symptom both times:** mention the bot in a thread, get nothing back — no reply, no
`Working` progress line, no error in-thread. The MLS watcher kept posting new listings
normally throughout, because `handle-new-eval.ts` underwrites with no LLM. **That split
(watcher fine / conversation dead) is the tell for a gateway-side fault**, same as the
2026-08-10 and 2026-09-10 incidents.

### Fault 1 (morning) — Codex silently black-holing `gpt-5.5`

A *second* model failure mode, distinct from 2026-09-10's loud one. Yesterday's was
`HTTP 400 "model is not supported"`. This one accepts the connection and then returns
nothing at all:

```
WARNING agent.chat_completion_helpers: Non-streaming API call stale for 1039s (threshold 600s). model=gpt-5.5 context=~48,164 tokens. Killing connection.
WARNING agent.chat_completion_helpers: Codex stream produced no SSE events for 138s after first byte (threshold 60s, model=gpt-5.5)
... Codex backend appears to be silently rejecting 'gpt-5.5' ... known backend-side pattern
    that has affected ChatGPT Plus accounts intermittently.
```

**Live discovery does not catch this.** The discovery one-liner (2026-09-10 section) still
reported `gpt-5.5 | api: True | vis: list` while every request to it was being dropped.
So "always pick from live discovery" is necessary but **not sufficient** — discovery proves
a slug is *offered*, not that it *answers*.

- **Tell:** `stale for NNNs` / `no SSE events` in the log, with **no** HTTP status.
- **Do NOT follow the error's own advice.** It suggests "try `gpt-5.4`" — that is the exact
  slug that returns HTTP 400 on this account (see 2026-09-10). Wrong for us.
- **Fix applied:** `model.default` → **`gpt-6-astra`** (top of the account's priority list,
  nominated in ANCHOR.md as the next upgrade). Verified: 66s approve→PDF immediately after.

`streaming.enabled: false` in config is **why this was so silent** — with streaming off the
gateway waits for a complete response, so a dead backend costs the full ~17 min timeout
before anything is logged. With streaming on, the `no SSE events` check would surface the
same failure in ~60s. Worth considering; not changed.

**Model config lives in two files and they agreed:** `~/.hermes/config.yaml` *and*
`<repo>/.hermes-runtime/config.yaml` (the "Runtime config file" named in the startup
banner) both hold `model.default`. Editing only the former worked, but check both if a
model change ever appears not to take.

### Fault 2 (afternoon) — Slack Socket Mode dropping events

After the model fix the bot worked 12:00–12:03, then went silent again at 13:33. This was
**not** the model: zero `gpt-6-astra` errors, config correct, single healthy process.

**Slack events were being dropped outright.** The 13:33 adjustment got no reply and left no
log line at all; the *identical text* re-sent after a kickstart was answered in **24s**.
Same gateway, same model, same thread — only a fresh socket differed.

```
WARNING hermes_plugins.slack_platform.adapter: [Slack] Socket Mode unhealthy (transport disconnected); reconnecting
```

4 of these since the 11:57 restart, the most recent being the last line in the log. A
reconnect that fails to re-subscribe silently loses `app_mention` events. **Fix: kickstart
the gateway.** No durable fix yet — see Outstanding.

### ⚠️ How to read this log (three traps that cost hours)

1. **`grep -c 'Session is closed'` is WRONG for this build.** It returns `0` while the
   socket is actively cycling. The 2026-08-10 section and the 2026-07-06 runbook both
   document that string; it gave a false all-clear on 09-11. **The real string is
   `Socket Mode unhealthy`.** Sample it twice 30s apart as before.
2. **The log records only warnings and errors — successful turns write NOTHING.** A
   working PDF generation leaves no trace. So *absence of `tool_executor` / `conversation_loop`
   lines is not evidence that nothing ran.* Several wrong conclusions on 09-11 came from
   exactly this.
3. **The log has no timestamps**, so ordering must be inferred from position in the file.
   Combined with (2) this makes "what happened when" nearly unanswerable. Adding timestamps
   is the highest-value fix on the Outstanding list.

Also: `grep` patterns matching `app_mention` will match the **`missing_scope` spam** (the
scope string literally contains `app_mentions:read`), which floods `tail`. Always filter:

```bash
grep -vE "missing_scope|channel_directory|server responded" /tmp/str-bot-gateway.log | tail -40
```

That `missing_scope: groups:read` line repeats every few seconds forever — a channel-directory
retry against a call the bot token can never satisfy. Harmless but it drowns the log.

### Response-latency baseline (measured across all 356 channel threads)

Useful for judging "is it slow or is it dead" — **it is never slow, it either answers in
seconds or not at all**:

| month | n | median first reply | approve→PDF median |
|---|---|---|---|
| 2026-06 | 351 | 18.5s | 21.1s |
| 2026-07 | 99 | 16.1s | 19.0s |
| 2026-08 | 178 | 13.1s | 15.9s |
| 2026-09 | 19 | 3.2s | 16.9s |

A stalled gateway should be suspected after ~60s of silence, not tolerated for minutes.

### Session auto-reset ate an approval

The 09-11 thread had been idle since 07-06, so `session_reset` (`mode: both`,
`idle_minutes: 1440`) fired and posted the "Session automatically reset" notice. The notice
itself is cosmetic — the message is still processed (`gateway/run.py` ~6192-6250 prepends a
`[System note: …expired…]` and dispatches normally). **But the reset cleared the thread
context**, so the agent had to re-read everything (4.5 min instead of ~15s), and a queued
`evaluate <link>` request from the same window was serviced *after* the user's `approve`,
re-posting the review and flipping the row back to `posted` — **discarding the approval**.

`idle_minutes: 1440` is tuned for chat, not for a review queue where threads legitimately
sit for weeks awaiting approval. Raising it (or setting `session_reset.notify: false`) is on
the Outstanding list, **not yet done**.

### ⚠️ OPEN BUG — approve resolved to the wrong version (`V2` instead of `V3`)

On MLS **12603066** (6542 Purple Poppy Lane) the approve path flipped the **superseded**
row instead of the current one. Current live state, **left as-is pending a decision**:

```
V1  posted    med=130,000  pdf: ''
V2  approved  med= 82,500  pdf: '2026/07/06/6542-purple-poppy-lane-park-city-ut-84098.pdf'   <- WRONG ROW
V3  posted    med= 78,500  pdf: ''                                                            <- the real eval
```

The **PDF itself is correct** ($106,000 / $78,500 / $58,900 — verified by rendering it).
The render reads `data/eval-<mls>.json` via `loadEvalData()`, independent of which row is
resolved, so only the row bookkeeping is wrong. Proof the wrong row was used: the R2 key is
under a `2026/07/06/` prefix, and `r2KeyForEval` builds that from `row["Created At"]` —
only V2 has a July date.

Unexplained: `pickLatestEvaluation` (`lib.ts:307`) sorts by `Version` descending and V3's
`Slack Timestamp` matches the thread, so `resolveEvaluationByThread` should have returned V3.
**This will recur on any multi-version eval.** The adjustment path is fine — a same-day
adjustment on MLS 12604162 versioned correctly (V2 `pending_review`, latest).

Consequence if left: the PRE site reads `pdf_path` off V2 (whose numbers don't match the
document), and V3's empty `pdf_path` reads as "needs regeneration" per the R2 contract.

**Proposed fix (NOT applied, awaiting go-ahead):** set V3 `Status=approved` +
`PDF Path=2026/07/06/6542-purple-poppy-lane-park-city-ut-84098.pdf`; set V2 back to
`pending_review` with empty `PDF Path`. Reuses the existing R2 object (content is right,
only the date prefix is odd).

### Timeline (2026-09-11, MT)

| time | event |
|---|---|
| 11:06 | adjustment → session auto-reset notice; processed anyway |
| 11:11 | projections updated to $78,500 (V3 written) |
| 11:12–11:22 | three `approved` messages — all silently lost to the `gpt-5.5` black-hole |
| ~11:57 | `model.default` → `gpt-6-astra`, gateway kickstart |
| 12:00 | `approved` → PDF in **66s** (filed against V2, see open bug) |
| 12:03 | photo re-fetch + PDF re-render, worked |
| 13:33 | adjustment — **dropped**, no reply, no log line |
| ~13:57 | kickstart; identical message answered in **24s** |

## Previous status — 2026-09-10 — FlexMLS account switch + stalled-listing outreach (in progress)

Two things happened this session: the **FlexMLS credentials moved from Cameron Brockbank to
Erik**, and a new **stalled-listing agent outreach** batch script was started (paused
mid-build, see below).

### FlexMLS credential switch — DONE, verified on both machines

The bot now authenticates as Erik's own PCBR subscription (member `tech_id`
`20260908211722139028000000`, created 2026-09-08). Erik updated `FLEXMLS_USERNAME` /
`FLEXMLS_PASSWORD` in `.env` on **both** the Mini and this laptop — those two vars are the
only place the credentials live (not `.hermes.env`, not the launchd plists).

**The step that actually mattered: deleting the browser profiles.** A persistent profile
holds a live FlexMLS session, so the watcher kept scanning happily **as Cameron** after the
credential change — correct-looking data under the wrong identity, with no error. The Mini's
`.playwright/flexmls-profile` was deleted and the watcher kickstarted, which forced a real
re-login; it hit the 2FA/trusted-device block, posted the Slack alert, and Erik submitted the
code. **If credentials ever change again, deleting the profiles is mandatory, not optional.**

- 2FA now goes to the number ending **9889** (Cameron's was **8899**) — a useful tell for
  which account a login is actually using.
- `.playwright/flexmls-stalled-profile` (this laptop) is re-established and device-trusted.
- `.playwright/flexmls-on-demand-profile` and `zillow-profile` were NOT touched. The
  on-demand profile is 0B/stale and will need the same treatment on first use.
- Stored `listing_url`s were checked and are **safe**: 1,354 of 1,360 use the canonical
  `flexmls.com/share/<code>/…` form, which is not tied to an agent slug. Only 1 row points
  at a `CameronBrockbank` share link. No link-rot cleanup needed.
- Still unconfirmed: a post-restart `heartbeat loggedIn=true` line in `/tmp/str-mls-watch.log`
  on the Mini. Worth a `grep heartbeat /tmp/str-mls-watch.log | tail -3` to close out.

### Gateway model outage — `gpt-5.5` (FIXED, and it will recur)

Mid-session the Slack bot started replying **"The model provider failed after retries"** to
every mention. Initial projections still posted, because `handle-new-eval.ts` underwrites
deterministically from `market-knowledge.md` with no LLM — **only the conversational paths
(adjustments, pasted links) broke.** That split is the tell for a model-layer failure.

The real error, only in `/tmp/str-bot-gateway.log`:

```
provider=openai-codex base_url=https://chatgpt.com/backend-api/codex model=gpt-5.4
HTTP 400: {"detail":"The 'gpt-5.4' model is not supported when using Codex with a ChatGPT account."}
```

Not auth — the token was healthy. Three compounding causes:

1. **`LLM_MODEL` in `.hermes.env` is dead config.** It read `openai/codex-5.4-medium` and
   `ANCHOR.md` documented it as the model, but the framework has not read that var since
   March 2026. `~/.hermes/config.yaml` → `model.default` is authoritative, and it held
   `gpt-5.4`. ANCHOR.md has been corrected.
2. **The framework invents model names.** `_FORWARD_COMPAT_TEMPLATE_MODELS` in
   `hermes_cli/codex_models.py` surfaces a *synthetic* newer slug whenever an older
   relative is present, so `gpt-5.4` could be written to config for an account that never
   had it.
3. **No fallback.** OpenRouter and Nous auxiliary providers are both unavailable
   (`payment / credit error`, `no Nous authentication found`), so a main-model failure is
   fatal rather than degraded. Worth fixing if the bot ever needs to survive this alone.

**Fix: pick from live discovery, never from the framework's list.** Run on the gateway host
(stdlib only — system `python3` has no `httpx`; the venv at
`~/.hermes/hermes-agent/venv/bin/python` does):

```bash
python3 -c "
import json, os, urllib.request, urllib.error
d = json.load(open(os.path.expanduser('~/.hermes/auth.json')))
tok = d['credential_pool']['openai-codex'][0]['access_token']
req = urllib.request.Request(
    'https://chatgpt.com/backend-api/codex/models?client_version=1.0.0',
    headers={'Authorization': 'Bearer ' + tok})
try:
    with urllib.request.urlopen(req, timeout=10) as r:
        for m in json.load(r).get('models', []):
            print(' ', m.get('slug'), '| api:', m.get('supported_in_api'), '| vis:', m.get('visibility'))
except urllib.error.HTTPError as e:
    print('HTTP', e.code, e.read()[:300].decode())
"
```

On 2026-09-10 the account returned: `gpt-6-astra`, `gpt-5.6-sol`, `gpt-5.6-terra`,
`gpt-5.6-luna`, `gpt-5.5` (plus hidden `gpt-reserve` / `codex-auto-review`, which discovery
filters out). Note **none of the framework's built-in Codex names were available** — the
documented `codex-5.4-medium` and the obvious fallback `gpt-5.3-codex` would both have
failed. Discovery is not optional here.

**Chose `gpt-5.5`**: the only available slug with real entries in
`agent/model_metadata.py` (272k context on the Codex path). The `gpt-5.6-*` and
`gpt-6-astra` slugs are newer than this Hermes build and would fall back to a *guessed*
256k context. `gpt-6-astra` is top of the account's priority list and is the upgrade to try
next, as its own change so a regression is attributable.

```bash
cp ~/.hermes/config.yaml ~/.hermes/config.yaml.bak
sed -i '' 's/^  default: gpt-5.4$/  default: gpt-5.5/' ~/.hermes/config.yaml
launchctl kickstart -k gui/$(id -u)/com.longitude.pre-bot.gateway
```

Verified live: an adjustment ("set balanced revenue to 76500") applied correctly with the
locked spread (103,275 / 57,375). The gateway also auto-raised compaction to 85% for the
272k window — informational, opt out with
`hermes config set compression.codex_gpt55_autoraise false`.

**This will recur.** Slugs rotate, `config.yaml` is static, and the symptom is a bot that
talks but cannot think. First move is always the discovery one-liner above.

### ⚠️ Latent bug found in `scripts/watch-mls.ts` — NOT fixed

`looksLoggedIn()` (~line 727) treats a `pc.flexmls.com` hostname match as proof of a session:

```ts
if (url.includes("pc.flexmls.com") || url.includes("mainmenu") || url.includes("search/")) return true;
```

**The sign-in page is served from that same host**, so this returns `true` while the browser
is sitting on the login form. Downstream steps then fail somewhere far from the cause (seen
live: a "could not find the saved search" error when the page was actually the sign-in form).
The fixed version — check for a sign-in form first, treat it as authoritative false, and only
count real in-app markers (`QuickLaunch`, `Change Search Template`, `Results:`,
`private_dashboard`) — is in `scripts/stalled-outreach.ts` and could be ported. Left alone
here because the scanner was explicitly out of scope this session and is working.

### Stalled-listing outreach batch — script written, blocked on the saved search

New workstream, deliberately narrow: find FlexMLS listings active **60+ days** that are
STR-eligible, and produce a CSV for **manual** HubSpot import. The pitch is "rent it while
it's listed". **No revenue evaluations, no HubSpot code, no changes to the scanner or the
approve handler** — all three were explicit constraints from Erik.

`scripts/stalled-outreach.ts` (new, **uncommitted**, typechecks clean) is the only file:

```bash
npx tsx scripts/stalled-outreach.ts --login-check   # verify credentials, report identity
npx tsx scripts/stalled-outreach.ts --discover      # navigate + dump, write nothing
npx tsx scripts/stalled-outreach.ts                 # the monthly run -> CSV
```

CSV columns: `mls_number, address, city, list_price, dom, agent_name, brokerage, agent_email,
agent_phone, prior_evaluation`. Flow: open the saved search → read the grid → join Supabase by
MLS number for agent email/phone we already hold → pull business cards only for the gaps →
write `data/stalled-outreach-<date>.csv`.

Design decisions worth keeping:

- **Own profile** `.playwright/flexmls-stalled-profile`, so it never contends with the
  always-on watcher (Chromium locks a profile dir; two processes cannot share one).
- **Columns are read by `column_<name>` class, not position**, using the header's
  `data-column-name`. Reordering columns in the FlexMLS display template will not break it.
- **`ensureSignedIn()` is an escalating state machine**, not a one-shot login. The PCR portal
  home renders **no FlexMLS link at all** for Erik's account, so direct navigation to
  `FLEXMLS_OPENID_URL` is tried first and the portal click is a fallback. Retrying the portal
  click is a livelock — it was one, for 8 iterations.
- **Never declare a named function expression inside `page.evaluate()`.** tsx/esbuild compiles
  `const clean = (v) => …` into a call to its `__name` helper, which does not exist in the
  page: `ReferenceError: __name is not defined`. Inline the logic instead.
- `watch-mls.ts` exports nothing (it is a process, not a module), so login/surface helpers are
  adapted copies. Same precedent as `normalizeNightlyRentalAllowed`, already duplicated in
  `underwrite.ts` and `process-mls-review-queue.ts`.

**BLOCKED / next step:** saved searches are per-user, so the "Stalled STR" search built under
Cameron's login **did not carry over** and must be rebuilt under Erik's account (the dashboard
Saved Searches gadget currently reads "No results for your criteria"). Erik paused here.

When rebuilding it:

1. Criteria: Status **Active**, **Nightly Rental Allowed = Yes**, our areas. The DOM ≥ 60
   filter is optional — the script can cut in code — but Status and Nightly Rental Allowed
   must be in the search.
2. **Add a DOM column to the display template.** Erik's account has `cdom_enabled = true`,
   `adom_enabled = false`. The first build had neither DOM nor CDOM, which forces the script
   onto its weaker fallback (Supabase `listing_date`, which only covers listings the watcher
   has already seen).
3. Name it exactly `Stalled STR`, confirm it appears in the dashboard gadget, then run
   `--discover`.

**Unresolved from the first discovery run** (9/4, under Cameron's account): the search
reported **446 matches** but only **100 rows** rendered — the grid lazy-loads via a
`#morelistingsbot` sentinel. A patient scroll/`Load More` loop with a match-count cross-check
was written but has **never been exercised against a real multi-page grid**. 446 was also far
above the ~242 Supabase estimate, consistent with the DOM filter not being on the search.

## Previous status — 2026-08-10 — recovered from a 4-day silent stall

> **Related:** the `looksLoggedIn` fix in the 2026-09-10 section above is a third instance
> of the pattern this section describes — a service reporting health while doing no work.
> The watcher logged `heartbeat loggedIn=true` with `hotSheet=0 parsed=0/0` while parked on
> the SSO login page. Worth assuming there are more: a signal that only ever means "the
> process is alive" is not a health check.

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

> ⚠️ **2026-09-11: `Session is closed` no longer appears in this build.** It returns `0`
> while the socket is actively cycling — it gave a false all-clear during the 09-11 outage.
> The current string is **`Socket Mode unhealthy`**; see the 2026-09-11 section.

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
# means the socket is dropping events and only a kickstart will fix it.
# NOTE (2026-09-11): the string is 'Socket Mode unhealthy'. The older 'Session is closed'
# does not appear in this build and returns 0 even while the socket is cycling.
grep -c 'Socket Mode unhealthy' /tmp/str-bot-gateway.log; sleep 30; grep -c 'Socket Mode unhealthy' /tmp/str-bot-gateway.log

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
      - *gateway:* a climbing `Socket Mode unhealthy` count in `/tmp/str-bot-gateway.log`
        (**updated 2026-09-11** — `Session is closed` does not exist in this build and
        returns 0 while the socket is cycling). **Do not** use `gateway_state.json`
        freshness — it only writes on state changes, so a healthy long-lived connection
        looks identical to a dead one.
      - *gateway, stronger signal:* an unanswered `app_mention`. On 09-11 two separate
        faults both presented as mentions that got no reply and left **no log line at all**.
        A check that compares recent mentions against recent bot replies in the same thread
        would have caught both within a minute; nothing else did.

      Both alert via outbound Slack (`scripts/slack.ts`, Web API), which kept working
      through both failures. Residual gap: if outbound Slack itself breaks, nothing can
      reach you — would need email/push, probably not worth it yet.
- [ ] **Timestamp the gateway log** — every 2026-09-11 diagnosis was slowed by an
      untimestamped, warnings-only log; ordering had to be inferred from file position.
      Highest-leverage debuggability fix.
- [ ] **Fix the V2-over-V3 approve resolution bug** — see the 2026-09-11 section. Live
      mis-filed rows on MLS 12603066 are still uncorrected (proposed fix specced there,
      not applied). Will recur on any multi-version eval.
- [ ] **Re-tune `session_reset`** — `idle_minutes: 1440` is chat-tuned and cost an approval
      on 09-11 when a long-idle review thread reset mid-request. Raise it substantially, or
      set `session_reset.notify: false`.
- [ ] **Consider `streaming.enabled: true`** — with streaming off, a silent backend costs
      the full ~17 min timeout before anything is logged; streaming surfaces the same
      failure via the `no SSE events` check in ~60s.
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

- **A credential change is not live until the browser profiles are deleted.** A persistent
  Playwright profile holds the old session, so the bot keeps working as the *previous* user
  with no error to tell you. See the 2026-09-10 section.
- **Never declare a named function expression inside `page.evaluate()`** — tsx/esbuild
  rewrites it into its `__name` helper, which does not exist in the page.
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
