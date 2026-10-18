#!/usr/bin/env python3
"""PreToolUse hook: asks for confirmation before the two highest-blast-radius Bash
cases named in retrospectives/lessons-and-action-plan.md pattern 6 (ambiguous `rm`)
and pattern 5 (mutating `git` command run despite the user saying they run git
themselves).

Why this exists: those two mistakes were already covered by written rules (CLAUDE.md,
memory files) that were violated anyway, because a passive rule fades across turns
(same root cause diagnosed for the language rule -> reply_language_reminder.py). This
hook makes the check mechanical instead of relying on Claude noticing in the moment.

Only fires for the Bash tool. Everything else, and any Bash command that doesn't match
the two patterns below, passes through untouched (exit 0, no output).

To disable/edit: .claude/settings.local.json -> hooks.PreToolUse
"""
import json
import re
import sys

# ponytail: naive substring/regex heuristics, not a real shell parser. Good enough to
# catch the common forms seen in the retrospectives; upgrade to shlex-based per-command
# parsing if it starts missing real cases or over-firing on quoted strings.

MUTATING_GIT = re.compile(
    r"\bgit\s+(commit|push|reset|checkout|clean|rebase|merge|cherry-pick|restore"
    r"|branch\s+(-D|--delete)|stash\s+drop|tag\s+-d)\b"
)

RISKY_RM = re.compile(r"\brm\s+(-\w*r\w*f\w*|-\w*f\w*r\w*|-r\b|-rf\b|-fr\b).*[*]")

STANDING_GIT_INSTRUCTION = re.compile(
    r"i\s+(run|will run|do)\s+(all\s+)?git|you\s+do\s+not\s+run\s+any?\s*git"
    r"|i\s+have\s+done\s+them.*git|no\s+you\s+do\s+not\s+run\s+any\s+git",
    re.IGNORECASE,
)


def ask(reason):
    print(
        json.dumps(
            {
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "ask",
                    "permissionDecisionReason": reason,
                }
            }
        )
    )
    sys.exit(0)


def transcript_has_standing_git_instruction(transcript_path):
    if not transcript_path:
        return False
    try:
        with open(transcript_path, "r", errors="ignore") as f:
            text = f.read()
    except OSError:
        return False
    return bool(STANDING_GIT_INSTRUCTION.search(text))


def main():
    payload = json.load(sys.stdin)
    if payload.get("tool_name") != "Bash":
        return

    command = (payload.get("tool_input") or {}).get("command", "")
    if not command:
        return

    if MUTATING_GIT.search(command):
        if transcript_has_standing_git_instruction(payload.get("transcript_path")):
            ask(
                "This session appears to contain an instruction that the user runs git "
                "commands themselves. Confirm before running this mutating git command: "
                f"`{command}`"
            )
        ask(f"Mutating git command about to run — confirm this is intended: `{command}`")

    if RISKY_RM.search(command):
        ask(
            "Wildcard/recursive delete detected — confirm the exact target before running: "
            f"`{command}`"
        )


if __name__ == "__main__":
    main()
