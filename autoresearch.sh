#!/bin/bash
set -euo pipefail

node --import tsx scripts/autoresearch/benchmark-underwrite.ts "$@"
