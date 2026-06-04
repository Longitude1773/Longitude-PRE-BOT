# Setup Guide

See also: [ARCHITECTURE.md](/Users/spencerlee/projects/str-revenue-bot/ARCHITECTURE.md) for the end-to-end system flow.

## 1. Supabase Database

The project uses Supabase (hosted Postgres) for data storage. The Supabase Table Editor serves as the auditing/visibility UI.

### Setup
1. Create a Supabase project at [supabase.com](https://supabase.com)
2. Create the 6 tables in `public`: `listings`, `evaluations`, `monthly_projections`, `comparables`, `adjustments`, `on_demand_requests`
3. In the Supabase SQL Editor, run [sql/2026-04-14-on-demand-requests.sql](/Users/spencerlee/projects/str-revenue-bot/sql/2026-04-14-on-demand-requests.sql) to add the on-demand request registry. That table is the single-flight control plane for on-demand Zillow and MLS evals, with a unique `request_key` plus lease fields for cross-process ownership.
4. In the Supabase SQL Editor, run [`supabase/enable_rls.sql`](/Users/spencerlee/projects/str-revenue-bot/supabase/enable_rls.sql) to keep those tables private:
   ```sql
   ALTER TABLE public.listings ENABLE ROW LEVEL SECURITY;
   ALTER TABLE public.evaluations ENABLE ROW LEVEL SECURITY;
   ALTER TABLE public.monthly_projections ENABLE ROW LEVEL SECURITY;
   ALTER TABLE public.comparables ENABLE ROW LEVEL SECURITY;
   ALTER TABLE public.adjustments ENABLE ROW LEVEL SECURITY;
   ALTER TABLE public.on_demand_requests ENABLE ROW LEVEL SECURITY;
   ```
5. Copy your project URL and backend-only key from **Settings → API** into `.env`:
   ```
   SUPABASE_URL=https://your-project.supabase.co
   SUPABASE_SECRET_KEY=your-secret-key
   # or, for older projects:
   SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
   ```
6. Do not use the anon or publishable key for these server-side scripts. They need a backend-only key so RLS can remain enabled.
7. If you are loading historical data, source `.env` and run:
   ```bash
   set -a && source .env && set +a
   npx tsx scripts/migrate-to-supabase.ts
   ```

Use `Listing Source` values:
- `new_listing` for active/new inventory being evaluated
- `closed_deal` for closed MLS sales captured as reference data

## 2. Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From scratch**
2. Name it "STR Evaluator", select your workspace
3. Under **OAuth & Permissions**, add Bot Token Scopes:
   - `chat:write` — Post messages
   - `files:write` — Upload PDFs/images
   - `files:read` — Read file info
   - `channels:history` — Read channel messages (for polling)
   - `groups:history` — Read private channel messages
   - `reactions:read` — Read reactions
4. **Install to Workspace**
5. Copy the **Bot User OAuth Token** (`xoxb-...`)
6. Copy the **Signing Secret**
7. Invite the bot to your target channel: `/invite @STR Evaluator`
8. Get the channel ID (right-click channel → Copy link → the `C...` part)

## 3. API Keys

### AirDNA
- Sign up at [airdna.co](https://www.airdna.co)
- Get an API key from your account settings or contact their sales for API access

### PriceLabs
- Sign up at [pricelabs.co](https://www.pricelabs.co)
- Get API access from your account or contact support

## 4. Environment Variables

Copy `.env.example` to `.env` and fill in all values:
```bash
cp .env.example .env
```

Operationally relevant tuning:
- `FLEXMLS_SCAN_ENABLED`
  When `false`, the watcher stays running for Slack commands but never auto-scrapes the hot sheet. Default `true`.
- `FLEXMLS_SCAN_WINDOW_START_HOUR` / `FLEXMLS_SCAN_WINDOW_END_HOUR`
  Mountain Time window (DST-aware) during which the hot-sheet scan runs. Start inclusive, end exclusive. Defaults `7` and `19` (7:00am MT through 6:59:59pm MT). Outside the window the watcher still processes Slack commands and logs an `outside scan window` heartbeat each tick.
- `FLEXMLS_WATCH_INTERVAL_SECONDS`
  Seconds between scan attempts. Default `1800` (30 minutes).
- `ON_DEMAND_REQUEST_LEASE_MS`
  How long one workflow runner owns an on-demand request before another runner may reclaim it.
- `ON_DEMAND_REQUEST_LEASE_POLL_MS`
  How often duplicate runners poll the request registry while waiting on the active owner.
- `BROWSER_BACKEND`
  Set to `browser-run` to use Cloudflare Browser Run instead of local Playwright browsers.
- `FLEXMLS_BROWSER_BACKEND`, `FLEXMLS_ON_DEMAND_BROWSER_BACKEND`, and `ZILLOW_BROWSER_BACKEND`
  Optional per-surface overrides. Use these when you want to keep the FlexMLS watcher local but send only on-demand MLS fetches or Zillow to Browser Run.
- `FLEXMLS_ON_DEMAND_BROWSER_RUN_REUSE_SESSION`
  When `true`, the watcher saves the dedicated MLS on-demand Browser Run `sessionId` locally and attempts to reconnect to the same remote browser on restart while it is still alive.
- `CLOUDFLARE_BROWSER_RUN_ACCOUNT_ID` and `CLOUDFLARE_BROWSER_RUN_API_TOKEN`
  Required whenever any backend is set to `browser-run`. Create a Cloudflare API token with `Browser Rendering - Edit` permission.
- `CLOUDFLARE_BROWSER_RUN_KEEP_ALIVE_MS`
  How long Cloudflare should keep the remote browser session alive between watcher actions. Default is `600000` (10 minutes).
- `ZILLOW_BROWSER_RUN_REUSE_SESSION`
  When `true`, the watcher saves the Zillow Browser Run `sessionId` locally and attempts to reconnect to the same remote browser on restart while it is still alive.

Browser Run notes:
- The watcher currently uses local Playwright profile dirs for FlexMLS and Zillow. In `browser-run` mode those become remote, session-scoped browsers, so cookies and trusted-device state do not survive process restarts the way local profile directories do.
- The upside is you can debug the remote session with Cloudflare Live View / Human in the Loop while keeping the repo code on plain Playwright.
- With Zillow specifically, the watcher now attempts session reuse before falling back to a fresh Browser Run browser. The saved session record lives under `data/inbox/zillow-browser-run-session.json`.
- With FlexMLS on-demand specifically, the watcher can keep the hot-sheet scanner local while lazily creating a separate Browser Run session only when a `scrape_mls_listing` command arrives. The saved session record lives under `data/inbox/flexmls-on-demand-browser-run-session.json`.

## 5. Install Dependencies

```bash
cd ~/projects/str-revenue-bot
npm install
npx playwright install chromium
```

## 6. Test

```bash
# Test Supabase connection
tsx scripts/sheets.ts read "Listings"

# Test sheet writer without writing
tsx scripts/write-sheet-data.ts evaluation data/eval-12601192.json --dry-run

# Test Slack connection
tsx scripts/slack.ts post "$SLACK_CHANNEL_ID" "Hello from STR Bot!"
```

## 7. Schedule the Daily Pipeline

In Claude Code, run:
```
/schedule daily-str-pipeline
```
Set it to run daily at 7:00 AM Mountain Time.

## 8. Start Slack Polling

In Claude Code, run:
```
/loop 5m check-slack-threads
```
This polls Slack threads every 5 minutes for new user messages.

## 9. Run Through Hermes Gateway

This repo is designed to run cleanly as a dedicated Hermes gateway bot.

1. Copy the gateway env template:
```bash
cp .hermes.env.example .hermes.env
```
2. Fill in:
   - `HERMES_AGENT_DIR`
   - `SLACK_BOT_TOKEN`
   - `SLACK_APP_TOKEN`
   - `STR_BOT_DIR`
   - `SYSTEM_PROMPT_FILE`
   - `LLM_MODEL` for the gateway's actual inference model
   - optionally `HERMES_AUTH_FILE` if your live Codex login is not under `~/.codex/auth.json`
   - optionally `HERMES_INFERENCE_PROVIDER` and `HERMES_BASE_URL` if you want a direct non-auto provider
3. Make sure your repo `.env` is also complete.
4. Run the preflight check:
```bash
npm run hermes:preflight
```
5. Start the full STR stack:
```bash
npm run str:start
```
This launches both the Slack-facing STR bot gateway and the persistent MLS watcher.

If you only need the gateway by itself:
```bash
npm run hermes:start
```

Useful workflow commands:
```bash
npm run workflow:status
npx tsx scripts/workflows/handle-new-eval.ts --mls 12601192 --channel "$SLACK_CHANNEL_ID"
npx tsx scripts/workflows/post-review.ts --mls 12601192 --channel "$SLACK_CHANNEL_ID"
npx tsx scripts/workflows/handle-thread-reply.ts --thread-ts "$THREAD_TS" --channel "$SLACK_CHANNEL_ID" --text "approve"
npx tsx scripts/workflows/update-market-knowledge.ts --instruction "update market knowledge: Pinebrook standard ADR should be $300-400"
npm run workflow:mls-status
npx tsx scripts/workflows/submit-mls-2fa.ts --code 123456 --by slack
npm run watch:mls
npm run browser:smoke -- https://www.zillow.com/
```
`watch:mls` now loads both `.env` and `.hermes.env` automatically, same as `hermes:start`.

For MLS watcher alerts, set `SLACK_ALERT_USER_ID` in `.hermes.env` to your Slack DM channel ID or Slack user ID. To prepend an actual Slack @mention in 2FA request messages, also set `SLACK_ALERT_MENTION_USER_ID` to the user ID you want mentioned. If unset, the watcher falls back to the first ID in `SLACK_ALLOWED_USERS`, then `REVIEW_BUFFER_CHANNEL_ID`.
If the watcher hits a 2FA page, the intended product behavior is: STR bot asks you for the code in Slack, then STR bot queues it through `submit-mls-2fa.ts` so the persistent watcher can enter it.
Until Slack inbound handling is fully reliable, you can still run `submit-mls-2fa.ts` manually as the fallback.

Expected behavior:
- Hermes connects to Slack via Socket Mode
- `HERMES.md` acts as the runtime contract
- Hermes uses the repo scripts directly for Sheets, Slack, PDFs, and local evaluation files
- Slack thread replies become live operational actions, not manual follow-up work
- Wednesday MLS monitoring can be layered on as a recurring scheduled sweep starting at 8:00 AM Mountain
- Current default cadence: every 5 minutes on Wednesdays from 8:00 through 23:55 Mountain
