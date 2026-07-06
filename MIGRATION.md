# Migrating the STR Bot to a New Machine

This guide moves the Longitude STR Bot (and its Hermes gateway) from one Mac to
another. It is written to be followed step by step — by a person or by Claude
Code running on the **destination** machine.

Read [HERMES.md](./HERMES.md) and [SETUP.md](./SETUP.md) for the full runtime
picture; this doc only covers the move.

---

## The mental model: two separate codebases

The bot is **two** independent pieces of software:

| Layer | What it is | Where it lives | On GitHub? |
|---|---|---|---|
| **STR bot** (this repo) | Scrapers, evaluation workflows, PDF/Slack scripts, `HERMES.md` persona | `~/projects/Longitude-PRE-BOT` | `github.com/Longitude1773/Longitude-PRE-BOT` (private) |
| **Hermes gateway** | The [Nous Research](https://github.com/NousResearch/hermes-agent) agent framework that connects to Slack (Socket Mode) and runs the bot | `~/.hermes/hermes-agent` | `github.com/NousResearch/hermes-agent` (public) |

**"Where does the Hermes code live?"** → `~/.hermes/hermes-agent`, a clone of
`github.com/NousResearch/hermes-agent`. It is **not** vendored into this repo.
You do **not** copy it from the old machine — you reinstall it fresh (below).
`HERMES_AGENT_DIR` in `.hermes.env` points at it.

### What is source-controlled vs. hand-carried

- **In git** (reinstall on the new machine): this repo, `node_modules` (via
  `npm install`), the hermes-agent framework (via its installer).
- **NOT in git** (must be copied): all secrets and the gateway's accumulated
  state — see [Payload](#the-payload-what-to-copy). These are the only
  irreplaceable bits. Losing them means re-issuing tokens and starting the
  agent's memory from scratch.

Most of the bot's *business data* (Listings, Evaluations, Comparables) lives in
**Supabase**, and PDFs are moving to **R2**, so that data is safe regardless of
which laptop is running — you are mainly moving credentials and local caches.

---

## Prerequisites on the new Mac

Keep the **same username and home layout** if at all possible. `.hermes.env`
hardcodes absolute paths and `.hermes-runtime/` contains symlinks into
`~/.hermes/`. If the new machine's user is also `erik`, everything resolves with
zero edits. If it is **not** `erik`, see [Path fixups](#path-fixups-only-if-the-username-differs).

Install the toolchain:

```bash
# Node (match the old machine — currently Node 25.x). Homebrew or nvm both fine.
node -v   # expect v25.x
# Python 3 (Hermes needs it; 3.9+ works, 3.11+ preferred)
python3 -V
# git, and gh if you use it
```

---

## Step 1 — Clone this repo

```bash
mkdir -p ~/projects
cd ~/projects
git clone https://github.com/Longitude1773/Longitude-PRE-BOT.git
cd Longitude-PRE-BOT
npm install
npx playwright install        # browser binaries — .playwright/ is gitignored & platform-specific
```

## Step 2 — Install the Hermes gateway

Use the official installer (handles the Python venv + deps). It installs into
`~/.hermes/hermes-agent` by default, matching `HERMES_AGENT_DIR`:

```bash
curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash
```

Confirm the checkout exists and `gateway/run.py` is present:

```bash
ls ~/.hermes/hermes-agent/gateway/run.py
```

## Step 3 — Copy the payload (secrets + state)

**Stop the gateway on the OLD machine first** (see
[Stopping cleanly](#stopping-the-old-machine-cleanly)). `state.db` is a live
SQLite database with a write-ahead log; copying it while the gateway is running
will corrupt it.

Then, from the **old** machine, rsync the four gitignored payloads, preserving
paths:

```bash
# 1) repo-level secrets
rsync -av ~/projects/Longitude-PRE-BOT/.env \
          ~/projects/Longitude-PRE-BOT/.hermes.env \
          NEWMAC:~/projects/Longitude-PRE-BOT/

# 2) live gateway runtime state (the agent's "brain": sessions, memories, skills)
#    includes state.db + its -shm/-wal sidecars — rsync of the whole dir gets them
rsync -av ~/projects/Longitude-PRE-BOT/.hermes-runtime/ \
          NEWMAC:~/projects/Longitude-PRE-BOT/.hermes-runtime/

# 3) global Hermes config + auth
rsync -av ~/.hermes/auth.json ~/.hermes/.env ~/.hermes/config.yaml ~/.hermes/SOUL.md \
          NEWMAC:~/.hermes/

# 4) local artifact caches (optional — regenerable, but saves re-downloading)
rsync -av ~/projects/Longitude-PRE-BOT/data/images \
          ~/projects/Longitude-PRE-BOT/data/pdfs \
          NEWMAC:~/projects/Longitude-PRE-BOT/data/
```

> **Codex model auth — read carefully, this is the #1 migration trap.**
> `LLM_MODEL` is a Codex model (`openai/codex-5.4-medium`, `provider: openai-codex`),
> so the model credential is a Codex login token, **not** an API key — there is no
> `OPENAI_API_KEY` in `.env` by design. The loader looks for that token at
> `~/.codex/auth.json` **first, then falls through to `~/.hermes/auth.json`.**
>
> On this deployment **`~/.codex` does not exist** — the live credential is
> `~/.hermes/auth.json` (carried by rsync #3 above). So:
> - **Do not** go hunting for `~/.codex/` or make a special trip for it. If it
>   isn't on the source machine, it was never the source of truth.
> - **Do not** set `HERMES_AUTH_FILE=~/.codex/auth.json` — pointing at a
>   non-existent path makes the gateway fail to find a token even though the real
>   one is present in `~/.hermes/`. Leave `HERMES_AUTH_FILE` unset (default
>   fall-through finds it) or point it explicitly at `$HOME/.hermes/auth.json`.
> - **Verify** `~/.hermes/auth.json` (~3.3 KB) landed on the new machine — that
>   file *is* the model login.
>
> If a future deployment *does* keep its token at `~/.codex/auth.json`, copy that
> folder too; the point is to bring whichever of the two actually exists on the
> source machine, not to assume the default path.

## Step 4 — Clear stale runtime locks (on the NEW machine)

The copied `.hermes-runtime/` still references the old machine's process. Remove
the stale lock/PID files so the gateway can start fresh:

```bash
cd ~/projects/Longitude-PRE-BOT/.hermes-runtime
rm -f gateway.lock gateway.pid processes.json
```

Also clear the stack-script PID files if present:

```bash
rm -f /tmp/str-bot-gateway.pid /tmp/str-mls-watch.pid
```

## Step 5 — Preflight

Run the built-in checker. It verifies required env vars, required files
(`HERMES_AGENT_DIR/gateway/run.py`, `SYSTEM_PROMPT_FILE`), and the Hermes Python
modules (`dotenv`, `firecrawl`, `slack_bolt`):

```bash
cd ~/projects/Longitude-PRE-BOT
npm run hermes:preflight
```

Fix anything it flags before continuing. Common misses: a Python module not
installed by the Hermes venv, or an env var that didn't copy.

## Step 6 — Start

Gateway only:

```bash
npm run hermes:start
```

Or the full stack (gateway **+** MLS watcher):

```bash
npm run str:start
```

Then verify in Slack: DM or mention the bot and confirm it replies as **Longitude
STR Bot** and that it can see recent eval threads. Logs stream to
`/tmp/str-bot-gateway.log` (and `/tmp/str-mls-watch.log` for the watcher).

## Step 7 — Decommission the old machine

Once the new machine is confirmed working, **stop the gateway on the old machine
and leave it stopped** — two gateways on the same Slack app will both consume
Socket Mode events and double-respond.

---

## Reference

### Stopping the old machine cleanly

```bash
cd ~/projects/Longitude-PRE-BOT/.hermes-runtime
kill "$(cat gateway.pid)" 2>/dev/null || true   # graceful
# wait a few seconds, confirm the process is gone:
ps -p "$(cat gateway.pid)" 2>/dev/null || echo "stopped"
```

If you started via `npm run str:start`, `scripts/hermes/start-str-stack.sh` also
manages `/tmp/str-bot-gateway.pid` and stops the process group on re-run.

### The payload (what to copy)

Everything below is gitignored and irreplaceable-if-lost:

| Path | What it is | Lose it → |
|---|---|---|
| `Longitude-PRE-BOT/.env` | API keys (Supabase, AirDNA, PriceLabs, R2, Slack) | re-issue every key |
| `Longitude-PRE-BOT/.hermes.env` | Gateway config + paths + Slack app tokens | re-configure gateway |
| `Longitude-PRE-BOT/.hermes-runtime/state.db` (+ `-shm`, `-wal`) | Agent sessions, memories, learned skills — 150+ MB | agent forgets everything |
| `Longitude-PRE-BOT/.hermes-runtime/memories/`, `kanban.db`, `config.yaml`, `channel_directory.json` | Gateway working state | lose context/board |
| `~/.hermes/auth.json`, `.env`, `config.yaml`, `SOUL.md` | Global Hermes auth + identity. **`auth.json` is also the Codex model login** (see Step 3 note) on deployments without `~/.codex` | re-auth Hermes + lose model access |
| `~/.codex/` **only if it exists on the source machine** | Codex model login token (loader prefers this over `~/.hermes/auth.json`) | model can't authenticate |
| `Longitude-PRE-BOT/data/images/`, `data/pdfs/` | Local artifact cache (regenerable) | re-download/regenerate |

### Path fixups (only if the username differs)

If the new machine's home is **not** `/Users/erik`, update these before Step 5:

1. `.hermes.env` — `HERMES_AGENT_DIR`, `STR_BOT_DIR`, `SYSTEM_PROMPT_FILE`
   (and `HERMES_AUTH_FILE` if set).
2. `.hermes-runtime/` symlinks, which point at absolute `/Users/erik/.hermes/...`:
   ```bash
   cd ~/projects/Longitude-PRE-BOT/.hermes-runtime
   ls -la auth.json hooks    # auth.json -> ~/.hermes/auth.json, hooks -> ~/.hermes/hooks
   ln -sfn "$HOME/.hermes/auth.json" auth.json
   ln -sfn "$HOME/.hermes/hooks" hooks
   ```
3. Grep the runtime `config.yaml` files for any remaining `/Users/erik` absolute
   paths and update them.

### Why `state.db` must be copied with the gateway stopped

It's SQLite in WAL mode. A live copy can capture a half-written transaction and
the `-wal`/`-shm` sidecars out of sync, producing a database that fails to open
or silently loses recent memory. Always stop the gateway, then copy all three
`state.db*` files together (an `rsync` of the whole directory does this).
