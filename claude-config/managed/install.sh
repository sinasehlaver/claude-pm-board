#!/bin/bash
# Installs the pm-file guard as a *managed* Claude Code hook (macOS). Run once with sudo:
#   sudo pm/claude-config/managed/install.sh
# Why: hooks registered in <workspace>/.claude/settings*.json and the hook script itself are writable by
# the user, so any Claude session (running as you) could edit them away. Managed settings live in a
# root-owned directory and outrank project/user settings, so a session cannot remove or edit this guard.
# Re-run after changing hooks/guard-pm-files.sh (the root-owned copy is what actually runs).
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "run with sudo" >&2; exit 1; }
command -v jq >/dev/null || { echo "jq is required by the hook (brew install jq)" >&2; exit 1; }

src="$(cd "$(dirname "$0")/.." && pwd)/hooks/guard-pm-files.sh"
dir="/Library/Application Support/ClaudeCode"
hook="$dir/hooks/guard-pm-files.sh"
cfg="$dir/managed-settings.json"

# the command runs through /bin/sh, and "Application Support" has a space: quote the path
entry=$(jq -nc --arg h "'$hook'" '{matcher:"Bash|Edit|Write|NotebookEdit",hooks:[{type:"command",command:$h}]}')

install -d -m 755 -o root -g wheel "$dir/hooks"
install -m 755 -o root -g wheel "$src" "$hook"   # always refreshed: re-run after editing the repo copy
echo "installed: $hook"

if [[ -e "$cfg" ]]; then
  if grep -q "$hook" "$cfg"; then
    if grep -qF "\"'$hook'\"" "$cfg"; then echo "already registered in $cfg"; exit 0; fi
    # older installs registered the path unquoted -> "/bin/sh: /Library/Application: No such file"
    tmp=$(mktemp)
    jq --arg h "$hook" --arg q "'$hook'" '(.hooks.PreToolUse[]?.hooks[]? | select(.command == $h)).command = $q' "$cfg" > "$tmp"
    install -m 644 -o root -g wheel "$tmp" "$cfg"; rm -f "$tmp"
    echo "fixed unquoted hook path in $cfg"; exit 0
  fi
  echo "$cfg exists; never overwritten. Add this to its hooks.PreToolUse array by hand:" >&2
  echo "$entry" >&2
  exit 2
fi
jq -n --argjson e "$entry" '{hooks:{PreToolUse:[$e]}}' > "$cfg"
chown root:wheel "$cfg"; chmod 644 "$cfg"
echo "registered: $cfg"
echo "check: ls -l '$dir' '$dir/hooks'   (owner must be root; start a new Claude session to load it)"
