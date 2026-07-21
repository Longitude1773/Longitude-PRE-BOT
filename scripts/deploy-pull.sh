#!/usr/bin/env bash
#
# deploy-pull.sh — pull origin/main on the Mac mini and restart only the
# services whose code actually changed.
#
# Why this exists: the bot does not auto-pull. After you push from another
# machine, run this ON THE MINI:
#
#     cd ~/projects/Longitude-PRE-BOT && ./scripts/deploy-pull.sh
#
# Restart logic (see ANCHOR.md / HANDOFF.md):
#   - scripts/workflows/**, lib.ts ....... NO restart (each eval/review runs as
#                                          a fresh `tsx` subprocess that re-reads
#                                          the files from disk).
#   - scripts/watch-mls.ts, browser-runtime.ts ... restart the WATCHER (long-lived).
#   - HERMES.md, scripts/hermes/** ....... restart the GATEWAY (loaded at start).
#   - docs / tests / *.example ........... no runtime effect.
#   - anything else that looks like runtime code (*.ts/*.sh/*.py) ... restart BOTH,
#                                          to be safe.
#
# Flags: --restart-both (force), --no-restart (pull only), --dry-run.
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_DIR"

GUI_DOMAIN="gui/$(id -u)"
GATEWAY_LABEL="com.longitude.pre-bot.gateway"
WATCHER_LABEL="com.longitude.pre-bot.watcher"

FORCE_BOTH=0; NO_RESTART=0; DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --restart-both) FORCE_BOTH=1 ;;
    --no-restart)   NO_RESTART=1 ;;
    --dry-run)      DRY_RUN=1 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

# --- refuse to run on a dirty tree (tracked modifications) -------------------
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "✗ Working tree has uncommitted tracked changes — commit/stash them first:" >&2
  git status --short | grep -E '^[ MADRC]' >&2
  exit 1
fi

BEFORE="$(git rev-parse HEAD)"
echo "→ Fetching + fast-forwarding origin/main (currently at ${BEFORE:0:7})…"
git pull --ff-only origin main
AFTER="$(git rev-parse HEAD)"

if [[ "$BEFORE" == "$AFTER" ]]; then
  echo "✓ Already up to date at ${AFTER:0:7} — nothing to deploy."
  exit 0
fi

CHANGED="$(git diff --name-only "$BEFORE" "$AFTER")"
echo "→ Updated ${BEFORE:0:7} → ${AFTER:0:7}. Changed files:"
echo "$CHANGED" | sed 's/^/    /'

# --- classify the changes ----------------------------------------------------
restart_watcher=0; restart_gateway=0; unknown=0
while IFS= read -r f; do
  [[ -z "$f" ]] && continue
  case "$f" in
    scripts/watch-mls.ts|scripts/browser-runtime.ts)      restart_watcher=1 ;;
    HERMES.md|scripts/hermes/*)                            restart_gateway=1 ;;
    scripts/workflows/*)                                   : ;;  # fresh subprocess; no restart
    *.md|*.example|*/__tests__/*|*.test.ts|deploy/*|data/*) : ;; # no runtime effect
    *.ts|*.sh|*.py|*.mjs|*.cjs)                            unknown=1 ;;  # runtime-ish, be safe
    *)                                                     : ;;
  esac
done <<< "$CHANGED"

if [[ "$FORCE_BOTH" == 1 ]]; then restart_watcher=1; restart_gateway=1; fi
if [[ "$unknown" == 1 ]]; then
  echo "⚠ Some changed files aren't classified — restarting BOTH to be safe."
  restart_watcher=1; restart_gateway=1
fi

kick() {
  local label="$1"
  if [[ "$DRY_RUN" == 1 ]]; then echo "    [dry-run] would restart $label"; return; fi
  launchctl kickstart -k "$GUI_DOMAIN/$label" && echo "    restarted $label"
}

echo "→ Restart plan:"
if [[ "$NO_RESTART" == 1 ]]; then
  echo "    --no-restart: skipping restarts. Restart manually if needed."
elif [[ "$restart_watcher" == 0 && "$restart_gateway" == 0 ]]; then
  echo "    none needed — workflow/doc changes only (picked up by the next fresh eval)."
else
  [[ "$restart_gateway" == 1 ]] && kick "$GATEWAY_LABEL"
  [[ "$restart_watcher" == 1 ]] && kick "$WATCHER_LABEL"
fi

echo "✓ Deployed. Now at: $(git log --oneline -1)"
