#!/bin/bash
# Run pm for real (server :4500 + vite :4501), Ctrl+C kills both.
# Usage: scripts/start.sh
set -euo pipefail
cd "$(dirname "$0")/.."

./scripts/check-port.sh

pids=()
cleanup() {
  trap - INT TERM EXIT
  echo
  echo "stopping pm..."
  for pid in "${pids[@]}"; do
    kill -TERM "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
}
trap cleanup INT TERM EXIT

node --watch server/index.mjs &
pids+=("$!")

./node_modules/.bin/vite --config web/vite.config.js &
pids+=("$!")

echo "pm: server http://127.0.0.1:${PORT:-4500}  |  web http://127.0.0.1:4501"
wait
