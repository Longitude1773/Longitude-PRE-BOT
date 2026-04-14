#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export STR_BOT_DIR="${STR_BOT_DIR:-$PROJECT_DIR}"

HERMES_ENV_FILE="${HERMES_ENV_FILE:-$PROJECT_DIR/.hermes.env}"
PROJECT_ENV_FILE="${PROJECT_ENV_FILE:-$PROJECT_DIR/.env}"
DEFAULT_HERMES_HOME="${HOME}/.hermes"
DEFAULT_CODEX_HOME="${HOME}/.codex"
MANAGED_HERMES_HOME=0

resolve_auth_source() {
  local candidate
  local candidates=()

  if [[ -n "${HERMES_AUTH_FILE:-}" ]]; then
    candidates+=("$HERMES_AUTH_FILE")
  fi

  candidates+=(
    "$DEFAULT_HERMES_HOME/auth.json"
    "$DEFAULT_CODEX_HOME/auth.json"
  )

  for candidate in "${candidates[@]}"; do
    if [[ -f "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  return 1
}

if [[ ! -f "$HERMES_ENV_FILE" ]]; then
  echo "Missing Hermes env file: $HERMES_ENV_FILE"
  echo "Copy .hermes.env.example to .hermes.env and fill it in."
  exit 1
fi

if [[ ! -f "$PROJECT_ENV_FILE" ]]; then
  echo "Missing project env file: $PROJECT_ENV_FILE"
  echo "Copy .env.example to .env and fill it in."
  exit 1
fi

set -a
source "$HERMES_ENV_FILE"
source "$PROJECT_ENV_FILE"
set +a

export STR_BOT_DIR="${STR_BOT_DIR:-$PROJECT_DIR}"

if [[ -z "${HERMES_HOME:-}" ]]; then
  export HERMES_HOME="$PROJECT_DIR/.hermes-runtime"
  MANAGED_HERMES_HOME=1
fi

if [[ -z "${HERMES_AGENT_DIR:-}" ]]; then
  echo "Missing HERMES_AGENT_DIR in $HERMES_ENV_FILE"
  exit 1
fi

if [[ -z "${SYSTEM_PROMPT_FILE:-}" ]]; then
  echo "Missing SYSTEM_PROMPT_FILE in $HERMES_ENV_FILE"
  exit 1
fi

if [[ ! -f "$SYSTEM_PROMPT_FILE" ]]; then
  echo "Missing system prompt file: $SYSTEM_PROMPT_FILE"
  exit 1
fi

if [[ "$MANAGED_HERMES_HOME" == "1" ]]; then
  mkdir -p "$HERMES_HOME"

  if AUTH_SOURCE_FILE="$(resolve_auth_source)"; then
    ln -sfn "$AUTH_SOURCE_FILE" "$HERMES_HOME/auth.json"
  else
    rm -f "$HERMES_HOME/auth.json"
    echo "Warning: no live Hermes/Codex auth file found. Checked HERMES_AUTH_FILE, $DEFAULT_HERMES_HOME/auth.json, and $DEFAULT_CODEX_HOME/auth.json."
  fi

  for name in hooks plugins slack_tokens.json; do
    if [[ -e "$DEFAULT_HERMES_HOME/$name" ]]; then
      ln -sfn "$DEFAULT_HERMES_HOME/$name" "$HERMES_HOME/$name"
    fi
  done

  RUNTIME_ENV_FILE="$HERMES_HOME/.env"
  : > "$RUNTIME_ENV_FILE"
  if [[ -f "$DEFAULT_HERMES_HOME/.env" ]]; then
    cat "$DEFAULT_HERMES_HOME/.env" >> "$RUNTIME_ENV_FILE"
    printf '\n' >> "$RUNTIME_ENV_FILE"
  fi
  cat "$HERMES_ENV_FILE" >> "$RUNTIME_ENV_FILE"
  printf '\n' >> "$RUNTIME_ENV_FILE"
fi

npm run hermes:preflight --prefix "$PROJECT_DIR"

cd "$HERMES_AGENT_DIR"
export PYTHONUNBUFFERED=1
export HERMES_EPHEMERAL_SYSTEM_PROMPT="$(cat "$SYSTEM_PROMPT_FILE")"
PYTHON_BIN="$HERMES_AGENT_DIR/venv/bin/python"
if [[ ! -x "$PYTHON_BIN" ]]; then
  PYTHON_BIN="$(command -v python3)"
fi

if [[ "$MANAGED_HERMES_HOME" == "1" ]]; then
  RUNTIME_CONFIG_FILE="$HERMES_HOME/config.yaml"
  DEFAULT_CONFIG_FILE="$DEFAULT_HERMES_HOME/config.yaml"
  "$PYTHON_BIN" - "$DEFAULT_CONFIG_FILE" "$RUNTIME_CONFIG_FILE" <<'PY'
from pathlib import Path
import sys

try:
    import yaml
except Exception as exc:
    raise SystemExit(f"PyYAML is required to build the Hermes runtime config: {exc}")

src = Path(sys.argv[1])
dst = Path(sys.argv[2])
data = {}
if src.exists():
    loaded = yaml.safe_load(src.read_text(encoding="utf-8")) or {}
    if isinstance(loaded, dict):
        data = loaded

display = data.setdefault("display", {})
if not isinstance(display, dict):
    display = {}
    data["display"] = display
display["tool_progress"] = "off"
display["background_process_notifications"] = "error"
display["tool_progress_command"] = False
display["show_reasoning"] = False
display["tool_preview_length"] = 0

streaming = data.setdefault("streaming", {})
if not isinstance(streaming, dict):
    streaming = {}
    data["streaming"] = streaming
streaming["enabled"] = False
streaming["transport"] = "off"

dst.write_text(yaml.safe_dump(data, sort_keys=False, allow_unicode=True), encoding="utf-8")
PY
fi

STATUS_FILE="$HERMES_HOME/gateway_state.json"
echo "Hermes home: $HERMES_HOME"
echo "Gateway status file: $STATUS_FILE"
echo "System prompt file: $SYSTEM_PROMPT_FILE"
if [[ -n "${AUTH_SOURCE_FILE:-}" ]]; then
  echo "Auth file: $AUTH_SOURCE_FILE"
fi
if [[ -n "${RUNTIME_CONFIG_FILE:-}" ]]; then
  echo "Runtime config file: $RUNTIME_CONFIG_FILE"
fi
echo "Starting gateway with: $PYTHON_BIN -u -m gateway.run"

"$PYTHON_BIN" -u -m gateway.run
STATUS=$?

echo "gateway.run exited with status $STATUS"
if [[ -f "$STATUS_FILE" ]]; then
  echo "Gateway runtime status:"
  cat "$STATUS_FILE"
fi

exit "$STATUS"
