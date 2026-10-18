#!/bin/bash
# Exit 1 with a readable message when the board's ports are already taken.
# Usage: scripts/check-port.sh [port ...]   (default: server $PORT/4500 and vite 4501)
ports=("$@")
[ ${#ports[@]} -eq 0 ] && ports=("${PORT:-4500}" 4501)
for p in "${ports[@]}"; do
  pid=$(lsof -ti "tcp:$p" -sTCP:LISTEN 2>/dev/null | head -1 || true)
  if [ -n "$pid" ]; then
    echo "port $p is already in use by pid $pid ($(ps -o comm= -p "$pid" 2>/dev/null))." >&2
    echo "  stop it with: kill $pid   (or set PORT=<other> for the server)" >&2
    exit 1
  fi
done
