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

**On the Mini (production) both are supervised by launchd — do NOT start them by hand.**
`npm run str:start` / `npm run hermes:start` would spawn a *second* gateway alongside the
launchd one; two gateways on the same Slack app double-respond and fight each other for
Socket Mode events. Use `launchctl` instead:

```bash
launchctl list | grep longitude.pre-bot                              # status (PID + last exit)
launchctl kickstart -k gui/$(id -u)/com.longitude.pre-bot.gateway    # restart gateway
launchctl kickstart -k gui/$(id -u)/com.longitude.pre-bot.watcher    # restart watcher
```

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
`erikmikkelsen`), supervised by two **launchd** user agents
(`com.longitude.pre-bot.gateway` / `…watcher`, `KeepAlive` crash-restart; plists in
`deploy/launchd/`). The gateway needs its venv on PATH so its bundled Python (3.11 with
`dotenv`/`firecrawl`/`slack_bolt`) is used — `scripts/hermes/start-gateway.sh` handles
this.

**Deploying code changes:** the Mini does not auto-pull. After pushing from another
machine, run `./scripts/deploy-pull.sh` on the Mini — it fast-forwards `origin/main` and
restarts only the services whose code changed. FileVault is on, so a reboot needs one
password entry at the console before the agents start. See `HANDOFF.md` for details.
