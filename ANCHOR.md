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

## Runtime topology (two independent pieces)

1. **Hermes gateway** — the [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent)
   framework installed at `~/.hermes/hermes-agent`. It connects to Slack via **Socket
   Mode**, loads this repo's `HERMES.md` as its persona/system prompt, and calls the
   repo's TypeScript scripts as tools. This is the conversational brain (answers,
   approvals, adjustments). Its state/memory lives in `.hermes-runtime/` (SQLite
   `state.db`, skills, sessions, memories).
2. **MLS watcher** — `scripts/watch-mls.ts`, a persistent Node/tsx process that keeps a
   warm browser session and scans the FlexMLS hot-sheet on a schedule (Mountain-Time
   window, default 07:00–19:00), plus services on-demand eval requests.

Start both with `npm run str:start`; gateway only with `npm run hermes:start`. Logs:
`/tmp/str-bot-gateway.log`, `/tmp/str-mls-watch.log`.

## Stack decisions (the "why")

- **Language/runtime:** TypeScript executed with **tsx** on Node (no build step). CLI
  utilities in `scripts/`, multi-step flows in `scripts/workflows/`.
- **LLM:** `openai/codex-5.4-medium` via the **ChatGPT Codex backend**
  (`provider: openai-codex`), authenticated by `~/.hermes/auth.json` — **not** an
  `OPENAI_API_KEY`. `.env` holds no LLM key by design.
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
- `HANDOFF.md` — latest session status (read alongside this file).

## Deployment (current)

Runs on a dedicated **Mac mini** (`~/projects/Longitude-PRE-BOT`, user
`erikmikkelsen`). The gateway needs its venv on PATH so its bundled Python (3.11 with
`dotenv`/`firecrawl`/`slack_bolt`) is used — `scripts/hermes/start-gateway.sh` handles
this. Not yet a launchd service, so it does not survive reboot; `hermes gateway install`
would make it always-on. See `HANDOFF.md` for machine-specific details.
