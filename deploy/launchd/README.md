# launchd service (macOS reboot persistence)

Reference copies of the two user **LaunchAgents** that supervise the bot on the
production Mac mini. They keep the stack running and `KeepAlive`-restart it on crash:

- `com.longitude.pre-bot.gateway.plist` — runs `scripts/hermes/start-gateway.sh`
  (the Hermes gateway; foreground, so launchd supervises the real process).
- `com.longitude.pre-bot.watcher.plist` — runs `scripts/hermes/start-mls-watch.sh`
  (the persistent MLS watcher).

These replace running `npm run str:start` by hand. **Do not run `str:start` while the
agents are loaded** — it would spawn a duplicate gateway (double-responds in Slack) and
fight `KeepAlive`.

## Machine-specific values to edit before installing elsewhere

The plists hard-code this machine's layout. On a new machine, update:

- Every `/Users/erikmikkelsen/...` path (repo location + `HOME`) → the new home.
- The `gui/<UID>` domain in the commands below → `gui/$(id -u)`.
- `PATH` assumes Homebrew at `/opt/homebrew/bin` (Apple Silicon). Intel: `/usr/local/bin`.

They depend on `scripts/hermes/start-gateway.sh` prepending the hermes venv to PATH
(so preflight's bare `python3` resolves to the venv with dotenv/firecrawl/slack_bolt).

## Install

```bash
UID_=$(id -u)
cp deploy/launchd/com.longitude.pre-bot.*.plist ~/Library/LaunchAgents/
plutil -lint ~/Library/LaunchAgents/com.longitude.pre-bot.*.plist

# stop any hand-started stack first so we don't double-run
pkill -f gateway.run; pkill -f "tsx scripts/watch-mls.ts"
rm -f /tmp/str-bot-gateway.pid /tmp/str-mls-watch.pid \
      .hermes-runtime/gateway.lock .hermes-runtime/gateway.pid .hermes-runtime/processes.json

for lbl in gateway watcher; do
  launchctl bootstrap gui/$UID_ ~/Library/LaunchAgents/com.longitude.pre-bot.$lbl.plist
  launchctl enable    gui/$UID_/com.longitude.pre-bot.$lbl
done
```

## Manage

```bash
launchctl list | grep longitude.pre-bot                          # status (PID + last exit code)
launchctl kickstart -k gui/$(id -u)/com.longitude.pre-bot.gateway   # restart gateway
launchctl kickstart -k gui/$(id -u)/com.longitude.pre-bot.watcher   # restart watcher
launchctl bootout      gui/$(id -u)/com.longitude.pre-bot.gateway   # stop until next load/reboot
```

Logs: `/tmp/str-bot-gateway.log`, `/tmp/str-mls-watch.log`.

## Reboot behavior (FileVault)

These are **LaunchAgents** (user domain), so they start when the user session starts.
With **FileVault on**, a reboot holds at the disk-unlock screen until the password is
entered — no launchd job (agent *or* daemon) runs before that. After unlock the user
auto-logs-in and the agents start. So: crash recovery is automatic; a reboot needs one
password entry. Fully unattended reboots would require disabling FileVault (not advised
on a machine holding Slack/Codex/Supabase/R2 credentials).
