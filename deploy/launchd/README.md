# launchd service (macOS reboot persistence)

Reference copies of the user **LaunchAgents** on the production Mac mini. Two are
long-lived services, kept running and `KeepAlive`-restarted on crash:

- `com.longitude.pre-bot.gateway.plist` — runs `scripts/hermes/start-gateway.sh`
  (the Hermes gateway; foreground, so launchd supervises the real process).
- `com.longitude.pre-bot.watcher.plist` — runs `scripts/hermes/start-mls-watch.sh`
  (the persistent MLS watcher).

Three more are **scheduled one-shots** — they run and exit, so a `-` in the PID column of
`launchctl list` is healthy, not a crash (sections below):

- `com.longitude.pre-bot.open-house.plist` — weekly open-house tracker (Tue/Wed).
- `com.longitude.pre-bot.mention-alert.plist` — gateway liveness alert (every 5 min).
- `com.longitude.pre-bot.pipeline-alert.plist` — pipeline stall alert (every 15 min).

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

## Weekly open-house tracker (`com.longitude.pre-bot.open-house.plist`)

A scheduled job, not a service: runs `scripts/open-house-tracker.ts` at **Tue 15:00** and
**Wed 08:00** local time and exits (no `KeepAlive`). The Mini's clock must be on Mountain
Time. It needs the watcher running (it sends the watcher a `read_open_house_report`
command) and the `GOOGLE_OAUTH_*` values in `.env` (see `scripts/google-auth.ts`).

```bash
cp deploy/launchd/com.longitude.pre-bot.open-house.plist ~/Library/LaunchAgents/
plutil -lint ~/Library/LaunchAgents/com.longitude.pre-bot.open-house.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.longitude.pre-bot.open-house.plist
launchctl kickstart gui/$(id -u)/com.longitude.pre-bot.open-house   # run once now (optional)
```

Log: `/tmp/str-open-house.log`. Run records: `data/open-house/<YYYY-MM-DD>.json`.

## Gateway liveness alert (`com.longitude.pre-bot.mention-alert.plist`)

A scheduled job, not a service: runs `scripts/app-mention-alert.ts` every **5 minutes**
and exits. It watches Slack for the two shapes every past outage took — a mention the bot
never answered, and a bot reply that is a provider error — and DMs/posts an alert. It runs
as its own process on purpose, so it still reports when the gateway it watches is dead.

Needs only `SLACK_BOT_TOKEN` + `SLACK_CHANNEL_ID` from `.env`; see `.env.example` for the
optional `APP_MENTION_*` overrides (watch channels, alert destination, who to @mention,
grace/lookback windows).

```bash
cp deploy/launchd/com.longitude.pre-bot.mention-alert.plist ~/Library/LaunchAgents/
plutil -lint ~/Library/LaunchAgents/com.longitude.pre-bot.mention-alert.plist

# Seed state FIRST so the first scheduled run can't alert on standing history.
npx tsx scripts/app-mention-alert.ts --seed

launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.longitude.pre-bot.mention-alert.plist
launchctl enable    gui/$(id -u)/com.longitude.pre-bot.mention-alert
launchctl kickstart gui/$(id -u)/com.longitude.pre-bot.mention-alert   # run once now (optional)
```

Check it by hand without posting anything: `npm run mention-alert -- --dry-run`.
Log: `/tmp/str-mention-alert.log`. Logic + tests: `scripts/app-mention-alert-lib{,.test}.ts`.

Dedup state: `data/inbox/app-mention-alert-state.json`. Note the two modes — **deleting**
the file makes the next run a *first run*, which re-seeds and alerts on nothing (that is the
safe install path). To force a real alert instead, leave the file in place but empty it:

```bash
echo '{"updatedAt":"1970-01-01T00:00:00.000Z","alertedMentions":[],"alertedErrors":[]}' \
  > data/inbox/app-mention-alert-state.json
npm run mention-alert
```

## Pipeline stall alert (`com.longitude.pre-bot.pipeline-alert.plist`)

A scheduled job, not a service: runs `scripts/pipeline-alert.ts` every **15 minutes** and
exits. The companion to the liveness alert above — that one watches the *conversation*, so
it is blind to a watcher that has quietly stopped producing (nobody mentions the bot, so
nothing looks wrong). This watches *outcomes*.

It reads `data/inbox/mls-watch-state.json`, which the watcher rewrites every cycle, and
alerts on: a stopped heartbeat, listings failing to post, a persistently empty hot sheet,
a persistent logged-out state, a `not-ok` queue run, an active 2FA gate, or the state file
being missing entirely. It runs as its own process on purpose — the watcher is the thing
that can stall, and code inside it cannot report its own silence.

Needs only `SLACK_BOT_TOKEN` + `SLACK_CHANNEL_ID`; see `.env.example` for the optional
`PIPELINE_ALERT_*` overrides. It also reads the watcher's own
`FLEXMLS_WATCH_INTERVAL_SECONDS` / `FLEXMLS_SCAN_WINDOW_*` / `FLEXMLS_SCAN_ENABLED` so its
idea of "late" matches the watcher's schedule.

```bash
cp deploy/launchd/com.longitude.pre-bot.pipeline-alert.plist ~/Library/LaunchAgents/
plutil -lint ~/Library/LaunchAgents/com.longitude.pre-bot.pipeline-alert.plist

# Seed FIRST so the first scheduled run can't alert on a standing condition.
npx tsx scripts/pipeline-alert.ts --seed

launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.longitude.pre-bot.pipeline-alert.plist
launchctl enable    gui/$(id -u)/com.longitude.pre-bot.pipeline-alert
launchctl kickstart gui/$(id -u)/com.longitude.pre-bot.pipeline-alert   # run once now (optional)
```

Check by hand without posting: `npm run pipeline-alert -- --dry-run`.
Log: `/tmp/str-pipeline-alert.log`. State: `data/inbox/pipeline-alert-state.json` (sample
history + per-signal cooldown stamps). Logic + tests: `scripts/pipeline-alert-lib{,.test}.ts`.

**Testing against a fixture** — do not hand-edit the live watcher state, which the watcher
rewrites every cycle and which `create-zillow-eval.ts` reads to decide whether the watcher
is up. Use the override flags, and keep `--dry-run` on:

```bash
npx tsx scripts/pipeline-alert.ts --dry-run --cooldown 0 \
  --state-file tmp/fixture.json --alert-state-file tmp/alert.json
```

Unlike the mention alert, findings here **re-alert on a cooldown** (default 6h) rather than
once: the 2026-08-10 stall lasted four days, and a single message that scrolls away is how
it stayed unnoticed.

## Reboot behavior (FileVault)

These are **LaunchAgents** (user domain), so they start when the user session starts.
With **FileVault on**, a reboot holds at the disk-unlock screen until the password is
entered — no launchd job (agent *or* daemon) runs before that. After unlock the user
auto-logs-in and the agents start. So: crash recovery is automatic; a reboot needs one
password entry. Fully unattended reboots would require disabling FileVault (not advised
on a machine holding Slack/Codex/Supabase/R2 credentials).
