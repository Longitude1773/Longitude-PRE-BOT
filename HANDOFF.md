# HANDOFF

> Rolling status from the previous session. Read alongside `ANCHOR.md` (durable
> architecture) at the start of each session. Update the top section when you finish
> meaningful work.

## Current status — 2026-07-06

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

# health check
python3 -c "import json;print(json.load(open('.hermes-runtime/gateway_state.json'))['platforms']['slack']['state'])"
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

- [ ] **Commit `scripts/hermes/start-gateway.sh`** — the venv-PATH fix (currently
      uncommitted working-tree change).
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

## Gotchas worth remembering

- Test the bot on **fresh Slack threads**, not ones with a history of failed turns —
  failed-turn memory can re-confuse the agent (seen as `invalid_blocks` / oversized
  approval cards while it thrashed mid-migration; cleared on a clean session).
- Business data (Listings/Evaluations/Comparables) is in **Supabase** and PDFs in **R2**,
  so it is safe regardless of which machine runs the bot — a migration mainly moves
  credentials and local caches.
