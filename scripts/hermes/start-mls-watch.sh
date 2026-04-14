#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HERMES_ENV_FILE="${HERMES_ENV_FILE:-$PROJECT_DIR/.hermes.env}"
PROJECT_ENV_FILE="${PROJECT_ENV_FILE:-$PROJECT_DIR/.env}"

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

cd "$PROJECT_DIR"
exec npx tsx scripts/watch-mls.ts
