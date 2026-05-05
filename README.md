# Longitude PRE Bot

Longitude PRE Bot is an operational bot for Park City short-term rental revenue evaluations. It ingests listing data from FlexMLS or Zillow, stores structured listing and underwriting data in Supabase, posts review-ready projections to Slack, accepts review-thread feedback, and generates final PRE PDFs after approval.

The project is intended to run as a dedicated Hermes gateway bot plus a persistent MLS watcher.

## What It Does

- Scrapes active and on-demand listing data from Park City FlexMLS and Zillow.
- Normalizes and stores listing, evaluation, monthly projection, comparable, and adjustment records in Supabase.
- Uses `data/market-knowledge.md` and prior adjustment history to build high, medium, and low revenue scenarios.
- Posts Slack review threads for human approval or revision.
- Applies thread feedback through workflow scripts and logs it as future calibration data.
- Generates final PRE PDFs from the approved evaluation payload.
- Keeps a persistent MLS browser session warm for scheduled watch windows and on-demand requests.

## Repo Guide

- `SETUP.md` - full setup guide for Supabase, Slack, API keys, Browser Run, and Hermes.
- `ARCHITECTURE.md` - end-to-end flow, data model, and script map.
- `HERMES.md` - runtime contract and Slack behavior for the Hermes gateway agent.
- `CLAUDE.md` - analyst workflow instructions for scheduled/manual evaluation runs.
- `data/market-knowledge.md` - local market assumptions used during underwriting.
- `scripts/workflows/` - main workflow entrypoints for evaluations, review replies, approvals, status, and MLS control.
- `scripts/hermes/` - stack launch, gateway launch, watcher launch, and preflight helpers.
- `templates/` - PDF template assets.
- `sql/` and `supabase/` - database migration and RLS setup SQL.

Generated artifacts such as eval JSON, listing JSON, images, PDFs, browser inbox state, local env files, and runtime logs are intentionally ignored by Git.

## Prerequisites

- Node.js 20 or newer
- npm
- Playwright Chromium
- Supabase project with backend service key access
- Slack app with Socket Mode enabled
- Hermes agent checkout for the Slack gateway runtime
- FlexMLS account credentials
- Optional AirDNA and PriceLabs API keys
- Optional Cloudflare Browser Run credentials for remote browser sessions

## Install

```bash
npm install
npx playwright install chromium
```

Create local env files:

```bash
cp .env.example .env
cp .hermes.env.example .hermes.env
```

Fill in `.env` for the STR bot runtime and `.hermes.env` for the Slack gateway runtime. Do not commit either file.

## Required Environment

Core `.env` values:

- `FLEXMLS_URL`
- `FLEXMLS_USERNAME`
- `FLEXMLS_PASSWORD`
- `SUPABASE_URL`
- `SUPABASE_SECRET_KEY` or `SUPABASE_SERVICE_ROLE_KEY`
- `SLACK_BOT_TOKEN`
- `SLACK_CHANNEL_ID`

Hermes `.hermes.env` values:

- `HERMES_AGENT_DIR`
- `STR_BOT_DIR`
- `SYSTEM_PROMPT_FILE`
- `SLACK_BOT_TOKEN`
- `SLACK_APP_TOKEN`
- `SLACK_ALLOWED_USERS` or `SLACK_ALLOW_ALL_USERS`
- `LLM_MODEL`

Browser backend options:

- `BROWSER_BACKEND=local` uses local Playwright browsers.
- `BROWSER_BACKEND=browser-run` uses Cloudflare Browser Run.
- `FLEXMLS_BROWSER_BACKEND`, `FLEXMLS_ON_DEMAND_BROWSER_BACKEND`, and `ZILLOW_BROWSER_BACKEND` can override the default per surface.
- Browser Run requires `CLOUDFLARE_BROWSER_RUN_ACCOUNT_ID` and `CLOUDFLARE_BROWSER_RUN_API_TOKEN`.

See `SETUP.md` for the complete environment reference.

## Database Setup

Create the Supabase tables documented in `SETUP.md`:

- `listings`
- `evaluations`
- `monthly_projections`
- `comparables`
- `adjustments`
- `on_demand_requests`

Run the SQL files in Supabase SQL Editor:

```sql
-- Adds the on-demand request registry.
-- See sql/2026-04-14-on-demand-requests.sql

-- Enables RLS on operational tables.
-- See supabase/enable_rls.sql
```

Use a backend-only Supabase key for these scripts. The anon or publishable key is not sufficient.

## Launch

Run the preflight check first:

```bash
npm run hermes:preflight
```

Start the full operational stack:

```bash
npm run str:start
```

This launches:

- the Slack-facing Hermes gateway
- the persistent FlexMLS/Zillow watcher

Logs and pid files are written under `/tmp`:

- `/tmp/str-bot-gateway.log`
- `/tmp/str-mls-watch.log`
- `/tmp/str-bot-gateway.pid`
- `/tmp/str-mls-watch.pid`

To run only one component:

```bash
npm run hermes:start
npm run watch:mls
```

## Common Operations

Check service/evaluation status:

```bash
npm run workflow:status
```

Check MLS watcher status:

```bash
npm run workflow:mls-status
```

Create an on-demand eval from a Zillow or FlexMLS URL:

```bash
npm run workflow:create-on-demand-eval -- --url "<listing-url>" --channel "$SLACK_CHANNEL_ID"
```

Create a review thread for a known MLS number:

```bash
npx tsx scripts/workflows/handle-new-eval.ts --mls 12601192 --channel "$SLACK_CHANNEL_ID"
```

Handle an evaluation-thread reply:

```bash
npm run workflow:handle-thread-reply -- --channel "$SLACK_CHANNEL_ID" --thread-ts "$THREAD_TS" --text "approve"
```

Submit an MLS 2FA code to the watcher:

```bash
npx tsx scripts/workflows/submit-mls-2fa.ts --code 123456 --by slack
```

Run a browser smoke test:

```bash
npm run browser:smoke -- https://www.zillow.com/
```

## Maintenance

- Keep `.env`, `.hermes.env`, browser profiles, generated PDFs/images, and runtime logs out of Git.
- Run `npm run hermes:preflight` after changing env, gateway paths, or Hermes dependencies.
- Use `npm run workflow:status` before answering questions about pending reviews, approvals, or pipeline health.
- Use `npm run workflow:mls-status` before answering questions about the watcher.
- Keep `data/market-knowledge.md` current when market assumptions change.
- Log review feedback through the Slack thread workflow so adjustments are written to Supabase and reused in future underwriting.
- Prefer a long-lived `npm run watch:mls` session during active Wednesday watch windows so FlexMLS trusted-device state stays warm.
- If FlexMLS pauses on 2FA, submit the code through `submit-mls-2fa.ts` instead of starting a fresh browser session.
- For Browser Run mode, expect remote browser sessions to be session-scoped; local trusted-device cookies do not persist the same way.

## Testing And Validation

Useful checks before handoff or deployment:

```bash
npm run hermes:preflight
npm run browser:smoke -- https://www.zillow.com/
npx tsc --noEmit
npm run autoresearch:checks
```

Some checks require valid local secrets, reachable Supabase/Slack services, Playwright browser dependencies, or active external accounts.

## Git Remote

The handoff repository is:

```text
https://github.com/Longitude1773/Longitude-PRE-BOT
```

Push the active branch there after reviewing the staged changes:

```bash
git push -u origin main
```
