#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$PROJECT_DIR"
export PROJECT_DIR

GATEWAY_LOG_FILE=/tmp/str-bot-gateway.log
WATCHER_LOG_FILE=/tmp/str-mls-watch.log
GATEWAY_PID_FILE=/tmp/str-bot-gateway.pid
WATCHER_PID_FILE=/tmp/str-mls-watch.pid

pid_is_alive() {
  local pid_file="$1"
  local pid

  [[ -f "$pid_file" ]] || return 1
  pid="$(cat "$pid_file" 2>/dev/null || true)"
  [[ -n "$pid" ]] || return 1
  kill -0 "$pid" 2>/dev/null
}

stop_process_group() {
  local pid_file="$1"
  local fallback_pattern="$2"
  local pid=""

  if [[ -f "$pid_file" ]]; then
    pid="$(cat "$pid_file" 2>/dev/null || true)"
  fi

  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    kill -TERM "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true

    for _ in {1..20}; do
      if ! kill -0 "$pid" 2>/dev/null; then
        break
      fi
      sleep 0.25
    done

    if kill -0 "$pid" 2>/dev/null; then
      kill -KILL "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
    fi
  fi

  rm -f "$pid_file"
  pkill -f "$fallback_pattern" 2>/dev/null || true
}

start_detached() {
  local pid_file="$1"
  local log_file="$2"
  shift 2

  python3 - "$PROJECT_DIR" "$pid_file" "$log_file" "$@" <<'PY'
import subprocess
import sys

project_dir, pid_file, log_file, *cmd = sys.argv[1:]

with open(log_file, "ab", buffering=0) as log:
    proc = subprocess.Popen(
        cmd,
        cwd=project_dir,
        stdin=subprocess.DEVNULL,
        stdout=log,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )

with open(pid_file, "w", encoding="utf-8") as handle:
    handle.write(f"{proc.pid}\n")
PY
}

stop_process_group "$GATEWAY_PID_FILE" 'gateway.run'
stop_process_group "$WATCHER_PID_FILE" 'tsx scripts/watch-mls.ts'
sleep 1

start_detached "$GATEWAY_PID_FILE" "$GATEWAY_LOG_FILE" npm run hermes:start
start_detached "$WATCHER_PID_FILE" "$WATCHER_LOG_FILE" npm run watch:mls

sleep 3

gateway_ok=0
watcher_ok=0
if pid_is_alive "$GATEWAY_PID_FILE"; then
  gateway_ok=1
fi
if pid_is_alive "$WATCHER_PID_FILE"; then
  watcher_ok=1
fi

if [[ "$gateway_ok" -ne 1 || "$watcher_ok" -ne 1 ]]; then
  echo "STR stack failed to fully launch."
  echo "Gateway status: $([[ "$gateway_ok" -eq 1 ]] && echo running || echo failed)"
  echo "Watcher status: $([[ "$watcher_ok" -eq 1 ]] && echo running || echo failed)"
  echo
  echo "Recent gateway log:"
  tail -n 40 "$GATEWAY_LOG_FILE" 2>/dev/null || true
  echo
  echo "Recent watcher log:"
  tail -n 40 "$WATCHER_LOG_FILE" 2>/dev/null || true
  exit 1
fi

echo "STR stack launched."
echo "Gateway log: $GATEWAY_LOG_FILE"
echo "Watcher log: $WATCHER_LOG_FILE"
echo "Gateway pid file: $GATEWAY_PID_FILE"
echo "Watcher pid file: $WATCHER_PID_FILE"
echo "Check gateway: ps -ef | grep 'python3 -m gateway.run' | grep -v grep"
echo "Check watcher: ps -ef | grep 'watch-mls.ts\\|flexmls-profile' | grep -v grep"
echo
echo "Streaming logs. Ctrl+C stops log tailing, not the background processes."

tail -f "$GATEWAY_LOG_FILE" | sed 's/^/[gateway] /' &
TAIL_GATEWAY=$!
tail -f "$WATCHER_LOG_FILE" | sed 's/^/[watcher] /' &
TAIL_WATCHER=$!

cleanup() {
  kill "$TAIL_GATEWAY" "$TAIL_WATCHER" 2>/dev/null || true
}

trap cleanup EXIT INT TERM
wait
