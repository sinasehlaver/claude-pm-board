#!/bin/bash
# Claude Code status line: session cost | 5h block | today | 7 days (USD). Needs jq and python3.
# Looks for usage.py next to this script, so copy both files into the same folder.
input=$(cat)
session=$(echo "$input" | jq -r '.cost.total_cost_usd // 0')

cache=${TMPDIR:-/tmp}/cc-usage-cache
# 60 s cache
if [ ! -f "$cache" ] || [ $(( $(date +%s) - $(stat -f %m "$cache" 2>/dev/null || stat -c %Y "$cache") )) -gt 60 ]; then
  python3 "$(dirname "$0")/usage.py" > "$cache"
fi
read block today week < "$cache"

printf "Session \$%.2f | 5h \$%.2f | Today \$%.2f | 7d \$%.2f\n" "$session" "$block" "$today" "$week"
