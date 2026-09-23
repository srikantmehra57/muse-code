#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/../../.." && pwd)"
cd "$ROOT"
npm run build:bridge
cd "$ROOT/apps/desktop"
exec npx vite --port 1420 --strictPort
