#!/bin/bash
# PreToolUse/Edit|Write|Bash — pm's backlog/state/archive/generated files are written ONLY by pm's own
# functions (pm server, `node pm/server/backlog-cli.mjs add|move|state`). Direct edits are denied.
# Install as a managed (root-owned) hook so sessions cannot edit it: sudo claude-config/managed/install.sh
# selftest: echo '{"tool_name":"Edit","tool_input":{"file_path":"/x/.claude/backlog/a.md"}}' | ./guard-pm-files.sh -> deny
# selftest: echo '{"tool_name":"Bash","tool_input":{"command":"sed -i s/a/b/ .claude/backlog/a.md"}}' | ./guard-pm-files.sh -> deny
# selftest: echo '{"tool_name":"Bash","tool_input":{"command":"grep -n x .claude/backlog/a.md"}}' | ./guard-pm-files.sh -> {}
input=$(cat)
tool=$(echo "$input" | jq -r '.tool_name // empty')
PROT='\.claude/(backlog|backlog-archive|state)/|\.claude/pm/[A-Za-z0-9_.-]+\.json'

deny() {
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":%s}}\n' "$(jq -Rn --arg r "$1" '$r')"
  exit 0
}
MSG="pm-owned files (.claude/backlog, backlog-archive, state, pm/*.json) are never edited directly and todos are never deleted. Use: node pm/server/backlog-cli.mjs create <slug> \"<summary>\" \"<plan path>\" \"<next1|next2>\" \"<todo>\"... (NEW project only) | add <slug> \"<title>\" | move <slug> <Todo|Doing|Blocked|Done> \"<exact title>\" [note] | state <slug> now|resume ... (run from the workspace root). Removing/renaming/rewording a todo is the user's job in the board."

if [[ "$tool" == "Edit" || "$tool" == "Write" || "$tool" == "NotebookEdit" ]]; then
  path=$(echo "$input" | jq -r '.tool_input.file_path // empty')
  [[ "$path" =~ $PROT ]] && deny "$path — $MSG"
  echo '{}'; exit 0
fi

if [[ "$tool" == "Bash" ]]; then
  cmd=$(echo "$input" | jq -r '.tool_input.command // empty')
  # pm HTTP mutation routes (board API): Claude must not call them.
  if [[ "$cmd" =~ (curl|wget|http|fetch\() && "$cmd" =~ /api/(projects|tasks|sessions|doctor|ports|envs) ]]; then
    if [[ "$cmd" =~ (-X[[:space:]]*(PUT|POST|DELETE|PATCH)|--request|-d[[:space:]]|--data|--json|method.*(PUT|POST|DELETE|PATCH)) ]]; then
      deny "Mutating pm board API calls are the user's path. $MSG"
    fi
  fi
  # Loose match closes path-splitting bypasses (`cd .claude && echo > backlog/x`, `cd .claude/state; node -e ...`):
  # any command naming `.claude` together with a protected dir word counts as touching it.
  LOOSE_A='\.claude([^[:alnum:]_]|$)'
  LOOSE_B='(^|[^[:alnum:]_-])(backlog-archive|backlog|state)([^[:alnum:]_-]|$)'
  touches=0
  [[ "$cmd" =~ $PROT ]] && touches=1
  [[ "$cmd" =~ $LOOSE_A && "$cmd" =~ $LOOSE_B ]] && touches=1
  # building the path at runtime (`p=.cl""aude`, base64, eval) next to a write verb is also refused
  if [[ "$cmd" =~ (eval[[:space:]]|base64|printf[[:space:]]+.*\\\\x) && "$cmd" =~ (\>|tee|mv|rm|cp|node|python) && "$cmd" =~ (backlog|state|\.claude) ]]; then touches=1; fi
  if [[ $touches == 1 ]]; then
    # the one allowed writer: a lone `node .../backlog-cli.mjs ...` with no chaining/substitution
    if [[ "$cmd" =~ ^[[:space:]]*(cd[[:space:]]+[^\;\&\|]+\&\&[[:space:]]*)?node[[:space:]]+[^[:space:]]*backlog-cli\.mjs[[:space:]]+[^\;\&\|\<\>\`\$\(\)]*$ ]] && [[ "$cmd" != *$'\n'* ]]; then
      echo '{}'; exit 0
    fi
    c=$(echo "$cmd" | sed -E 's#[0-9]*>[[:space:]]*/dev/null##g; s#[0-9]*>&[0-9]##g')
    if [[ "$c" == *">"* || "$c" =~ (^|[^A-Za-z_-])(tee|mv|rm|cp|ln|truncate|dd|install|rsync|python3?|node|perl|ruby|osascript|sponge|chmod|touch)([[:space:]]|$) || "$c" =~ (^|[[:space:]])-(delete|fprint0?|fprintf|fls)([[:space:]]|$) || "$c" =~ sed[[:space:]]+(-[A-Za-z]*i|--in-place) || "$c" =~ git[[:space:]]+(checkout|restore|stash|reset) ]]; then
      deny "Bash write touching a pm-owned file. $MSG"
    fi
  fi
fi
echo '{}'
