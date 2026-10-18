#!/bin/bash
# One command, no questions: checks tools, installs deps, builds the web app, creates the
# workspace folders, installs claude-config (never overwrites; backs up settings), starts the
# board and opens it in the browser. Safe to re-run.
# Usage: scripts/setup.sh [--no-claude-config] [--no-start]     (PM_ROOT=<dir> to pick the workspace)
set -euo pipefail
cd "$(dirname "$0")/.."
repo=$(pwd)

config=1; start=1
for a in "$@"; do
  case "$a" in
    --no-claude-config) config=0 ;;
    --no-start) start=0 ;;
    *) echo "unknown option: $a" >&2; exit 2 ;;
  esac
done

step() { printf '\n\033[1m▸ %s\033[0m\n' "$1"; }
fail() { printf '\033[31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

step "Node"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  command -v brew >/dev/null || fail "Node >= 20 is required. Install it from https://nodejs.org and re-run."
  echo "installing Node via Homebrew..."
  brew install node
fi
echo "node $(node -v)"

step "Dependencies"
npm ci --no-audit --no-fund

step "Build web app"
npm run build --silent

export PM_ROOT="${PM_ROOT:-$(cd .. && pwd)}"
step "Workspace: $PM_ROOT"
mkdir -p "$PM_ROOT/.claude"/{state,backlog,rules,handoffs,pm}

if [ "$config" = 1 ]; then
  step "Claude config (existing files are kept)"
  for t in jq python3; do command -v "$t" >/dev/null || echo "  note: '$t' not found; the statusline needs it (brew install $t)"; done
  node scripts/setup-config.mjs "$PM_ROOT"
fi

step "Terminal"
echo "  truecolor: ${COLORTERM:-not set in this shell} (iTerm2 and Terminal.app handle it; see README, Terminal colors)"

[ "$start" = 1 ] || { echo; echo "done. start with: scripts/start.sh"; exit 0; }

step "Start"
port="${PORT:-${PM_PORT:-4500}}"
"$repo/scripts/check-port.sh" "$port"
url="http://127.0.0.1:$port"
# open the browser once the server answers (the server also serves web/dist)
( for _ in $(seq 1 60); do curl -fs "$url/api/projects" >/dev/null 2>&1 && { open "$url" 2>/dev/null || true; break; }; sleep 0.5; done ) &
echo "pm on $url  (Ctrl+C stops it)"
exec node server/index.mjs
