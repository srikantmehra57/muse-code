#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/../../.." && pwd)"
cd "$ROOT"
npm run build:bridge
npm run build:sidecar -w @muse/bridge
cd "$ROOT/apps/desktop"
npx tsc
npx vite build
