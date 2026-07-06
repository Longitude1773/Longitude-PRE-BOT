# HANDOFF

> Rolling status from the previous session. Read alongside `ANCHOR.md` (durable
> architecture) at the start of each session. Update the top section when you finish
> meaningful work.

## Current status — 2026-07-06

**The bot is fully migrated from the old laptop to this Mac mini and operational.**
Gateway + MLS watcher run detached and Slack-connected; an end-to-end test passed (the
agent processed a "set balanced revenue" adjustment, applied the locked ×1.35/×0.75
spread, and bumped the eval version).

### How to run / check it

```bash
cd ~/projects/Longitude-PRE-BOT
npm run str:start          # gateway + MLS watcher (both detached; safe to re-run)
# npm run hermes:start     # gateway only

# health check
pgrep -fl gateway.run; pgrep -fl watch-mls.ts
python3 -c "import json;print(json.load(open('.hermes-runtime/gateway_state.json'))['platforms']['slack']['state'])"
tail -f /tmp/str-bot-gateway.log   # and /tmp/str-mls-watch.log
```

Logs stream to `/tmp/str-bot-gateway.log` and `/tmp/str-mls-watch.log`.

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
- [ ] **Reboot persistence** — install a launchd LaunchAgent (`hermes gateway install`);
      the stack currently does not survive a reboot/logout.
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
