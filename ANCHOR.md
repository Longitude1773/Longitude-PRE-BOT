# ANCHOR — Longitude PRE Bot

> Durable north star for this project. Read on every new session. Stack/architecture
> decisions that rarely change live here; per-session status lives in `HANDOFF.md`.

## Purpose

An operational bot that produces **short-term-rental (STR) revenue evaluations for Park
City, Utah** properties for Longitude Hospitality. It ingests listing data from FlexMLS
(and Zillow / on-demand links), underwrites a revenue projection, posts a review thread
to Slack for human approval, applies threaded feedback, and generates a final PRE PDF
once approved. It is a real revenue tool, not a demo — treat its outputs and Slack
posts as production.

## Runtime topology (two long-lived pieces + two scheduled jobs)

1. **Hermes gateway** — the [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent)
   framework installed at `~/.hermes/hermes-agent`. It connects to Slack via **Socket
   Mode**, loads this repo's `HERMES.md` as its persona/system prompt, and calls the
   repo's TypeScript scripts as tools. This is the conversational brain (answers,
   approvals, adjustments). Its state/memory lives in `.hermes-runtime/` (SQLite
   `state.db`, skills, sessions, memories).
2. **MLS watcher** — `scripts/watch-mls.ts`, a persistent Node/tsx process that keeps a
   warm browser session and scans the FlexMLS hot-sheet on a schedule (Mountain-Time
   window, default 07:00–19:00), plus services on-demand eval requests.

**On the Mini (production) both are supervised by launchd — do NOT start them by hand.**
`npm run str:start` / `npm run hermes:start` would spawn a *second* gateway alongside the
launchd one; two gateways on the same Slack app double-respond and fight each other for
Socket Mode events. Use `launchctl` instead:

```bash
launchctl list | grep longitude.pre-bot                              # status (PID + last exit)
launchctl kickstart -k gui/$(id -u)/com.longitude.pre-bot.gateway    # restart gateway
launchctl kickstart -k gui/$(id -u)/com.longitude.pre-bot.watcher    # restart watcher
launchctl kickstart gui/$(id -u)/com.longitude.pre-bot.open-house    # run the weekly tracker now (no -k: it is not long-lived)
launchctl kickstart gui/$(id -u)/com.longitude.pre-bot.mention-alert  # run the liveness check now
```

Two more agents are loaded, both *scheduled one-shots* rather than services — they run and
exit, so a `-` in the PID column is healthy, not a crash:

- `com.longitude.pre-bot.open-house` — Tue 15:00 / Wed 08:00. See "Scheduled job: the
  weekly open-house tracker" below.
- `com.longitude.pre-bot.mention-alert` — every 5 min. See "Scheduled job: the gateway
  liveness alert" below.

The `npm run` scripts remain the right entry point on a **dev machine** with no launchd
agents loaded. Logs (both cases): `/tmp/str-bot-gateway.log`, `/tmp/str-mls-watch.log`.
See `HANDOFF.md` → "How it runs (launchd-managed)" for the full control surface.

## Stack decisions (the "why")

- **Language/runtime:** TypeScript executed with **tsx** on Node (no build step). CLI
  utilities in `scripts/`, multi-step flows in `scripts/workflows/`.
- **LLM:** a Codex model via the **ChatGPT Codex backend** (`provider: openai-codex`),
  authenticated by `~/.hermes/auth.json` — **not** an `OPENAI_API_KEY`. `.env` holds no
  LLM key by design.
  - **The model name lives in `config.yaml` (`model.default`) — not in any env var.**
    `LLM_MODEL` in `.hermes.env` is **dead config** — the framework stopped reading it in
    March 2026 ("config.yaml is the sole source of truth"; see `cli.py`, and the v12→13
    migration in `hermes_cli/config.py` that clears the var). Do not trust it; it can and
    does disagree with what is actually being sent.
  - Codex model slugs **rotate**, and a stale one is a hard outage: every model call fails
    `HTTP 400 "The '<model>' model is not supported when using Codex with a ChatGPT
    account."` Worse, the framework's `_FORWARD_COMPAT_TEMPLATE_MODELS` invents
    *synthetic* slugs (e.g. `gpt-5.4`) whenever an older relative exists, so a name can be
    written to config that the account never had. Always pick from live discovery — see
    `HANDOFF.md` (2026-09-10) for the one-liner.
  - **Discovery is necessary but NOT sufficient.** A slug can be listed and still be dead:
    on 2026-09-11 the Codex backend *silently* black-holed `gpt-5.5` — connection accepted,
    no stream events, no error, ~17 min timeout — while discovery kept reporting it
    `api: True | vis: list`. So there are two model failure modes, and they look nothing
    alike in the log: a **loud** one (`HTTP 400 "not supported"`) and a **silent** one
    (`stale for NNNs` / `no SSE events`, no HTTP status). Discovery catches only the first.
    Do not trust the silent one's own suggested workaround either — it recommends `gpt-5.4`,
    which is the slug that 400s on this account. See `HANDOFF.md` (2026-09-11).
  - **A third failure mode: the quota cap, which lies about being an auth error.** The
    account is ChatGPT **`plus`**, whose Codex cap is a rolling **5-hour** window
    (`limit_window_minutes: 300`). When it is exhausted, Slack shows
    `⚠️ Provider authentication failed. Check the configured credentials` — which is a
    framework mislabel, not an auth problem. **Never re-authenticate on that message**
    (re-login cannot lift a cap, and the Codex login endpoint 429s on its own, creating a
    second real fault). The authority is `~/.hermes/auth.json` →
    `credential_pool["openai-codex"][0]`: read `last_status`, `last_error_reason`, and
    `last_error_reset_at`. Expect a red herring — that file's mtime updates at the moment
    of the 429, because the framework stamps the `exhausted` marker into it. Full chain and
    line numbers: `HANDOFF.md` (2026-10-12).
  - **There is no fallback LLM credential, by design-so-far.** `fallback_providers: []` in
    both config files and the only model credential on the box is the Codex OAuth in
    `~/.hermes/auth.json` (`.env` / `.hermes.env` / `~/.hermes/.env` hold none). So a quota
    cap or a dead slug is a **hard outage with no graceful degradation** — the gateway
    raises instead of degrading. Populating `fallback_providers` requires adding a new
    credential first.
  - **The eval pipeline is model-free — only the gateway spends quota.** Verified
    2026-10-12: *nothing* under `scripts/` makes an LLM call — no provider SDK, no model
    host URL, no model slug anywhere in the tree. The whole underwrite chain
    (`underwrite.ts`, `underwrite-research.ts`, `underwrite-decision.ts`,
    `process-mls-review-queue.ts`, `handle-new-eval.ts`, `lib.ts`) is deterministic
    TypeScript over `data/market-knowledge.md`, AirDNA/PriceLabs comps, and the locked
    scenario spread. `UNDERWRITE_WEB_RESEARCH_ENABLED` does **not** mean an LLM either — it
    scrapes Brave Search HTML directly (`underwrite-research.ts`, 3.5s timeout, 3 results).
    - **Consequence, and the single most useful triage fact in this repo:** new listings
      keep getting underwritten and posted to Slack during a total model outage, because
      that path never touches the model. Quota and model faults only ever break the
      *conversational* half — replies, adjustments, approvals, anything the agent does on
      your behalf. **Watcher posting fine + bot not answering = gateway/model fault**, every
      time (2026-08-10, 2026-09-10, 2026-09-11, 2026-10-12 all presented this way).
    - So capacity is measured in *Slack conversation*, not evals. The 2026-10-12 window was
      exhausted by ~7 eval requests' worth of agent conversation plus 2 full
      adjustment/approval cycles (one failing call alone carried `msgs=54`,
      `tokens=~53,718`), not by the underwriting math, which was free.
  - The model name is also mirrored into `<repo>/.hermes-runtime/config.yaml` (the
    "Runtime config file" in the gateway's startup banner). They agreed on 2026-09-11, but
    check both if a model change ever appears not to take.
- **Database:** **Supabase Postgres**, 5 tables — `Listings`, `Evaluations`,
  `Monthly Projections`, `Comparables`, `Adjustments`. Accessed via `scripts/sheets.ts`,
  which keeps sheet-style table names for backward compatibility (the project began on
  Google Sheets; the interface names are a legacy of that).
- **File storage:** **Cloudflare R2** for evaluation PDFs and mirrored listing hero
  photos. Local working files live under `data/` (`eval-<id>.json`, `listing-<id>.json`,
  `images/`, `pdfs/`, `inbox/`).
- **Browser automation:** **Playwright** with a **local** browser backend
  (`BROWSER_BACKEND=local`); persistent login profiles under `.playwright/*-profile`
  (gitignored). Optional Cloudflare Browser Run backend exists but is not the default.
- **Comp/market inputs:** AirDNA + PriceLabs APIs when available; otherwise
  `data/market-knowledge.md` (ADR ranges, seasonality, feature bumps) is the fallback
  basis for projections.

## Scheduled job: the gateway liveness alert

`scripts/app-mention-alert.ts`, every 5 minutes
(`deploy/launchd/com.longitude.pre-bot.mention-alert.plist`). Added 2026-10-12, after a
fourth outage that nothing detected.

**Why it exists.** Every outage so far (2026-08-10, 09-10, 09-11, 10-12) looked identical
from Slack and was invisible everywhere else: `launchctl list` showed a healthy PID through
all four, `preflight` returned `ok: true`, and on 09-11 two separate faults left **no log
line at all**. The one signal present in every case is the conversation itself.

**Two independent checks, because the outages come in two shapes:**

1. **Silent** — a human mentions the bot and no reply ever arrives (the 09-11 shape:
   dropped Slack events, silently black-holed model).
2. **Errored** — the bot replies, but with a provider error (the 10-12 shape: the quota cap
   produced a reply 2 seconds later). Check 1 is blind to this by design: it got an answer.
   An alert from this check repeats the "check the Codex quota before re-authenticating"
   rule, since the wording lies.

**Design points that matter if you change it:**
- **It must not depend on the gateway.** It is a short-lived script over the Slack Web API,
  because outbound Slack kept working through all four outages while the gateway did not.
  Residual gap: if outbound Slack breaks, nothing here can reach you.
- **Thread discovery reaches back 14 days, but mentions are judged over 3 hours.**
  `conversations.history` returns only top-level messages, and the common case is an
  adjustment inside an eval thread whose parent is days old — a window sized to the mention
  age would never surface that thread. Threads are only *read* when `latest_reply` falls
  inside the mention window, so the wide discovery costs almost nothing (observed: 99
  top-level messages, 1 thread actually fetched).
- **Answered includes a `⏳ Working…` line and an empty-text file-only reply.** Both mean
  the bot is alive, which is the question being asked.
- Alerts post **top-level, never into the affected thread** — a reply from the bot's own
  token would make the next run read the mention as answered. Quoted text has the bot
  mention defused to `@bot` for the same reason (and so alerts don't ping the bot).
- **First run seeds and alerts on nothing**, so installing it cannot alert-storm on standing
  history. Dedup state: `data/inbox/app-mention-alert-state.json` (delete to re-seed).

Decision logic is in `scripts/app-mention-alert-lib.ts` with 25 tests in
`app-mention-alert-lib.test.ts` (wired into `autoresearch.checks.sh`) — the live channel had
no unanswered mentions to test against, so both failure paths are covered synthetically.
Check by hand without posting: `npm run mention-alert -- --dry-run`.
Log: `/tmp/str-mention-alert.log`.

## Scheduled job: the weekly open-house tracker

Added `054919a` (2026-09-30). A **third** launchd job alongside the gateway and watcher,
but unlike those two it is **not** long-lived: it runs once and exits (no `KeepAlive`).

**What it produces:** a Google **Sheet** (not a Doc) per week, one row per open house on the
upcoming Wednesday — the Park City Board of REALTORS weekly tour. Columns:
`Address · Agent · Brokerage · Open House Time · STR Allowed · List Price · MLS Link ·
Balanced Revenue Projection · PRE Link`. Named `YYYY.MM.DD - Open House Tracker`, created in
the Drive folder *Longitude Master › Longitude Management › Revenue › sales › Open House
Tracker* (`OPEN_HOUSE_TRACKER_FOLDER_ID`, default hard-coded in `open-house-tracker.ts`).
Posts a 📅 summary to Slack (`OPEN_HOUSE_SLACK_CHANNEL_ID`, falling back to
`SLACK_CHANNEL_ID`), and posts a ⚠️ message if the run fails.

**Schedule — two runs per cycle, by design** (`deploy/launchd/com.longitude.pre-bot.open-house.plist`):

| When | Mode | Purpose |
|---|---|---|
| **Tue 15:00** local | `create` | Build the sheet; start evals for STR-eligible listings that have none |
| **Wed 08:00** local | `update` | Append late-entered tours; fill PRE links approved overnight |

The second run exists because tours can be entered until ~4pm Tuesday — i.e. **after** the
first run starts. Verified real: the 2026-10-07 cycle saw 33 entries Tuesday and 39 by
Wednesday, so the update run caught 6 late additions. Note the Tuesday run at 15:00 is
deliberately *before* the 4pm cutoff, so it never sees the final hour; the Wednesday run is
what closes that gap.

**Dependencies, each a hard failure if absent:**
- **The MLS watcher must be running.** The tracker has *no browser of its own* — it asks the
  watcher for a `read_open_house_report` command on the watcher's live signed-in FlexMLS
  session (source: FlexMLS Menu → Public Open Houses, the same report the Board prints).
  It aborts immediately if there is no watcher state file.
- **Google OAuth**: `GOOGLE_OAUTH_CLIENT_ID` / `_CLIENT_SECRET` / `_REFRESH_TOKEN` in `.env`
  (`scripts/google-auth.ts`, `scripts/google.ts`).
- **Local clock must be America/Denver** — `StartCalendarInterval` is wall-clock, not UTC.

**It is idempotent, and that is load-bearing.** Re-running the same command against the same
sheet is safe and expected. It finds an existing sheet by name in the folder before creating
one, tracks state in `data/open-house/<date>.json` (the ledger), and `planSheetMerge` only
writes cells that are blank, hold a known placeholder, or still hold exactly what the bot
last wrote — **so your manual edits in the sheet survive**. Placeholders it manages:
`Unknown – check MLS`, `Not STR-eligible`, `Evaluation in progress`,
`Evaluation failed – see Slack`, `Needs evaluation (no MLS link found)`.

**It does NOT consume model quota.** For each STR-eligible open-house listing with no
existing evaluation it shells out to `scripts/workflows/create-on-demand-eval-manual.ts` — a
full underwrite — **sequentially**, 15-minute timeout each, capped at `--max-evals`
(**default 20**). Observed: 9 evals (2026-09-30, 67 entries) and 3+1 (2026-10-07 cycle).
Those underwrites are deterministic TypeScript and cost **zero** model tokens (see "The
eval pipeline is model-free" below), so a heavy Tuesday cannot by itself exhaust the Codex
window. Its real costs are the watcher's browser time and the AirDNA/PriceLabs/Brave
fetches. Use `--max-evals <n>` to throttle or `--no-evals` to build the sheet only when you
want to limit FlexMLS load, not for quota reasons.

The one indirect quota link: each eval it starts posts a 📅 review thread to Slack, and if
you then work those threads conversationally (adjustments, approvals), *those replies* are
gateway turns and do cost quota. A big Tuesday therefore front-loads a lot of potential
conversational work, even though generating it was free.

**Safe ways to run it by hand:**
```bash
npx tsx scripts/open-house-tracker.ts --dry-run    # FlexMLS + Supabase read only → CSV, writes nothing
npx tsx scripts/open-house-tracker.ts --date 2026-10-14 --no-evals --no-slack
```
Logs: `/tmp/str-open-house.log`. Status: `launchctl list | grep open-house` (a `-` in the
PID column is normal — it only lives for the duration of a run).

## Key invariants — do not violate

- **Locked scenario spread.** Only the **Balanced** (medium) case is underwritten.
  `Optimized = Balanced × 1.35` and `Conservative = Balanced × 0.75`, enforced by
  `SCENARIO_SPREAD` in `scripts/workflows/lib.ts` at generation and on every adjustment.
  Never set Optimized/Conservative independently, and never ask the user for a spread.
- **Adjustments are a training set.** Every review correction is logged to the
  `Adjustments` table with category + reasoning. Read it before underwriting to bake in
  systematic biases; it is how the bot calibrates over time.
- **`data/eval-<id>.json` is the source the workflows read** (with no automatic Supabase
  rehydrate). The DB has the row; the consolidated JSON is local. Keep them in sync.

## Doc index

- `README.md` — what it does, repo guide.
- `ARCHITECTURE.md` — end-to-end flow diagram, data model, script map.
- `SETUP.md` — Supabase / Slack / API keys / Browser Run / Hermes setup.
- `HERMES.md` — the gateway agent's persona + runtime rules (its system prompt).
- `CLAUDE.md` — operating instructions for the analyst agent (pipeline, helper scripts).
- `MIGRATION.md` — moving the bot + gateway to a new machine.
- `deploy/launchd/README.md` — the three launchd agents and how they are installed.
- `HANDOFF.md` — latest session status (read alongside this file).

## Deployment (current)

Runs on a dedicated **Mac mini** (`~/projects/Longitude-PRE-BOT`, user
`erikmikkelsen`), supervised by three **launchd** user agents (plists in
`deploy/launchd/`): `com.longitude.pre-bot.gateway` and `…watcher` (both long-lived, with
`KeepAlive` crash-restart), plus two scheduled one-shots with no `KeepAlive`:
`…open-house` and `…mention-alert`. The Mini's clock must be **America/Denver** — the
open-house schedule is wall-clock. The gateway needs its venv on PATH so its bundled Python (3.11 with
`dotenv`/`firecrawl`/`slack_bolt`) is used — `scripts/hermes/start-gateway.sh` handles
this.

**Deploying code changes:** the Mini does not auto-pull. After pushing from another
machine, run `./scripts/deploy-pull.sh` on the Mini — it fast-forwards `origin/main` and
restarts only the services whose code changed. FileVault is on, so a reboot needs one
password entry at the console before the agents start. See `HANDOFF.md` for details.
