# Hermes Gateway Integration Plan

> For Hermes: use this plan to turn the STR repo into an ops-first service running through a dedicated Hermes gateway instance.

Goal: Run Longitude STR Bot through Hermes gateway so Slack messages can trigger real repo actions end to end.

Architecture: Hermes is the always-on Slack-facing analyst/operator. This repo stays the deterministic execution layer for sheets, Slack, PDF generation, and file-backed evaluation state. Phase 1 uses the current scripts directly with a dedicated gateway prompt and startup path; later phases add workflow commands and reliability layers.

Tech stack: Hermes gateway, Slack Socket Mode, TypeScript CLI scripts, Google Sheets via Apps Script, Playwright PDF rendering, local JSON/files.

---

## Phase breakdown

### Phase 1: Get it working
- Run a dedicated Hermes gateway instance for Longitude STR Bot.
- Point that instance at this repo via `STR_BOT_DIR`.
- Use `HERMES.md` as the runtime contract.
- Keep using the existing repo scripts directly.
- Add a clean startup path, env template, and preflight checks.
- Add the first scheduled MLS-watch requirement: every Wednesday starting at 8:00 AM Mountain, poll FlexMLS for new listings on a recurring cadence. Current default: every 5 minutes from 8:00 through 23:55 Mountain on Wednesdays.

### Phase 2: Reduce fragility
- Add workflow entrypoints for the main business actions:
  - `handle-new-eval.ts`
  - `handle-thread-reply.ts`
  - `approve-eval.ts`
  - `adjust-eval.ts`
  - `update-market-knowledge.ts`
- Standardize JSON output for all workflow scripts.
- Make thread-to-eval lookup canonical.
- Add local event logging / replay.

### Phase 3: Make it operationally strong
- Add scheduled ingestion.
- Add periodic missed-message sweep.
- Add a status snapshot command.
- Add failure reporting to a private ops channel.

---

## Phase 1 implementation tasks

### Task 1: Add gateway startup and preflight tooling

Objective: Make the repo directly runnable as a dedicated Hermes bot without manual shell glue.

Files:
- Create: `scripts/hermes/start-gateway.sh`
- Create: `scripts/hermes/preflight.ts`
- Modify: `package.json`
- Modify: `.gitignore`
- Create: `.hermes.env.example`

Steps:
1. Add a shell entrypoint that:
   - resolves repo root
   - loads `.hermes.env`
   - loads `.env`
   - exports `STR_BOT_DIR`
   - runs preflight
   - starts `python -m gateway.run` from `HERMES_AGENT_DIR`
2. Add a preflight script that validates:
   - `HERMES_AGENT_DIR`
   - `STR_BOT_DIR`
   - `SYSTEM_PROMPT_FILE`
   - `SLACK_BOT_TOKEN`
   - `SLACK_APP_TOKEN`
   - project files needed for the bot contract
3. Add package scripts for preflight and gateway start.
4. Ignore `.hermes.env` and commit `.hermes.env.example`.

Verification:
- `npm run hermes:preflight`
- `bash scripts/hermes/start-gateway.sh` reaches gateway startup when env is complete

### Task 2: Tighten the runtime contract in `HERMES.md`

Objective: Make the gateway behavior explicit enough that Hermes can operate reliably without hidden assumptions.

Files:
- Modify: `HERMES.md`

Steps:
1. Add a startup section that tells the bot to operate from `STR_BOT_DIR`.
2. Add a repo-runtime section listing the exact scripts Hermes should use first.
3. Add a lightweight routing model for:
   - top-level evaluation request
   - thread reply on existing evaluation
   - market knowledge update
   - general STR question
4. Keep it ops-first: no platform rewrite, no fake abstraction.

Verification:
- Read `HERMES.md` top-to-bottom and confirm a fresh operator could run the service from it.

### Task 3: Document the production-ish setup path

Objective: Make setup obvious for the dedicated gateway instance.

Files:
- Modify: `SETUP.md`

Steps:
1. Add a Hermes gateway section with:
   - `.hermes.env` creation
   - required env vars
   - startup command
   - expected runtime behavior
2. Keep the setup path narrow and concrete.

Verification:
- A developer with the repo and Hermes installed can follow `SETUP.md` without tribal knowledge.

### Task 4: Verify Phase 1 end to end

Objective: Prove the startup path is valid.

Files:
- No new files required unless fixes are discovered.

Steps:
1. Run preflight.
2. If env allows, start the gateway process.
3. Capture any missing-env or path failures and fix them.
4. Leave Phase 1 in a runnable state even if external credentials prevent full live validation.

Verification:
- Preflight passes or fails with sharp actionable errors.
- Gateway startup command is in-repo and repeatable.

---

## Design decisions

1. Hermes is the operator, not the script runner alone.
   The value is intent classification and judgment from messy Slack language into the right repo action.

2. This repo remains a task-specific toolbelt.
   We do not move sheets/PDF/Slack logic into gateway code.

3. Phase 1 stays deliberately thin.
   No queues, no DB, no over-abstracted orchestration yet.

4. Prompt contract over application complexity.
   We keep orchestration mostly in `HERMES.md` plus a small amount of startup glue.

---

## Acceptance criteria for Phase 1

- The repo contains a committed Hermes gateway integration plan.
- The repo contains a committed startup script for the dedicated gateway instance.
- The repo contains a committed preflight check for required env/runtime assumptions.
- The repo contains a committed env template for gateway-specific settings.
- `HERMES.md` clearly describes how Hermes should operate this service.
- `SETUP.md` shows how to start the dedicated bot.

---

## Phase 2 next moves

After Phase 1 lands, implement these in order:
1. `scripts/workflows/handle-thread-reply.ts`
2. `scripts/workflows/approve-eval.ts`
3. `scripts/workflows/update-market-knowledge.ts`
4. `scripts/workflows/status.ts`
5. event log under `data/inbox/slack-events/`
6. `scripts/workflows/post-review.ts` so new evals get canonical Slack thread timestamps

Current repo state:
- implemented: `handle-thread-reply.ts`, `approve-eval.ts`, `update-market-knowledge.ts`, `status.ts`, `post-review.ts`
- implemented: local event logging under `data/inbox/slack-events/`
- implemented: `handle-new-eval.ts` for canonical new-listing -> review-thread intake
- implemented: `scripts/watch-mls.ts` for a single long-lived FlexMLS browser session during active watch windows
- implemented: local command bridge (`mls-commands.jsonl`) so STR bot can hand 2FA codes directly into the persistent MLS watcher
- still thin: richer question-answering over comps

That is the right shape: Hermes for judgment, repo scripts for deterministic execution.