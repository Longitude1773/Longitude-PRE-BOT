# Setup Guide

See also: [ARCHITECTURE.md](/Users/spencerlee/projects/str-revenue-bot/ARCHITECTURE.md) for the end-to-end system flow.

## 1. Supabase Database

The project uses Supabase (hosted Postgres) for data storage. The Supabase Table Editor serves as the auditing/visibility UI.

### Setup
1. Create a Supabase project at [supabase.com](https://supabase.com)
2. Run the DDL from `scripts/migrate-to-supabase.ts` (or the SQL in the migration plan) in the Supabase SQL Editor to create the 5 tables: `listings`, `evaluations`, `monthly_projections`, `comparables`, `adjustments`
3. Disable RLS on all tables (private bot, no public API):
   ```sql
   ALTER TABLE listings DISABLE ROW LEVEL SECURITY;
   ALTER TABLE evaluations DISABLE ROW LEVEL SECURITY;
   ALTER TABLE monthly_projections DISABLE ROW LEVEL SECURITY;
   ALTER TABLE comparables DISABLE ROW LEVEL SECURITY;
   ALTER TABLE adjustments DISABLE ROW LEVEL SECURITY;
   ```
4. Copy your project URL and anon key from **Settings → API** into `.env`:
   ```
   SUPABASE_URL=https://your-project.supabase.co
   SUPABASE_ANON_KEY=your-anon-key
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
```
`watch:mls` now loads both `.env` and `.hermes.env` automatically, same as `hermes:start`.

For MLS watcher alerts, set `SLACK_ALERT_USER_ID` in `.hermes.env` to your Slack DM channel ID or Slack user ID. If unset, the watcher falls back to the first ID in `SLACK_ALLOWED_USERS`, then `REVIEW_BUFFER_CHANNEL_ID`.
If the watcher hits a 2FA page, the intended product behavior is: STR bot asks you for the code in Slack, then STR bot queues it through `submit-mls-2fa.ts` so the persistent watcher can enter it.
Until Slack inbound handling is fully reliable, you can still run `submit-mls-2fa.ts` manually as the fallback.

Expected behavior:
- Hermes connects to Slack via Socket Mode
- `HERMES.md` acts as the runtime contract
- Hermes uses the repo scripts directly for Sheets, Slack, PDFs, and local evaluation files
- Slack thread replies become live operational actions, not manual follow-up work
- Wednesday MLS monitoring can be layered on as a recurring scheduled sweep starting at 8:00 AM Mountain
- Current default cadence: every 5 minutes on Wednesdays from 8:00 through 23:55 Mountain
