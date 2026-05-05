#!/bin/bash
set -euo pipefail

export SUPABASE_URL="${SUPABASE_URL:-https://example.com}"
export SUPABASE_SECRET_KEY="${SUPABASE_SECRET_KEY:-dummy}"

node --import tsx --test \
  scripts/workflows/lib.adjustment.test.ts \
  scripts/workflows/underwrite-research.test.ts \
  scripts/autoresearch/underwrite-benchmark.test.ts \
  scripts/autoresearch/review-reward-benchmark.test.ts
