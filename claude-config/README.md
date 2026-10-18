# claude-config

Sanitized Claude Code helper files used alongside the board. Nothing here is loaded automatically:
copy what you want into your workspace (`<workspace>` = the folder that holds your projects and
`.claude/`). Placeholders: `<board-repo>`, `<board-slug>`, `<report language>`, `<suite>`.

## Files

| File | What it does | Copy to |
|---|---|---|
| `CLAUDE.md` | Workspace rules: ask via AskUserQuestion, no commits without asking, board conventions, evidence discipline | `<workspace>/CLAUDE.md` (merge, then replace the placeholders) |
| `rules/board-project.md` | Lazy-loaded rules for working on the board repo itself (`paths: <board-repo>/**`) | `<workspace>/.claude/rules/` |
| `hooks/ask_questions_reminder.py` | `UserPromptSubmit`: re-injects "ask open questions via AskUserQuestion, never in prose" | `<workspace>/.claude/hooks/` |
| `hooks/destructive_command_guard.py` | `PreToolUse` on Bash: asks before mutating git commands and wildcard `rm -rf` | `<workspace>/.claude/hooks/` |
| `skills/handoff/` | Writes a handoff note so the next session can resume | `<workspace>/.claude/skills/` |
| `skills/retro/` | Reviews the conversation for Claude's own mistakes and saves each as a feedback memory | `<workspace>/.claude/skills/` |
| `memory/` | Starter memories: `ask-questions-via-askuserquestion`, `pm-board-plan`, `board-todo-style` (+ `MEMORY.md` index) | `~/.claude/projects/<workspace-slug>/memory/` |
| `retrospectives/lessons-and-action-plan.md` | The recurring failure patterns behind the hooks and rules, each with a prevention action | anywhere you keep notes |
| `statusline/` | Status line showing session / 5h / today / 7d spend | see [Tools I use](#tools-i-use) |

## Hook wiring

Hook commands live in `<workspace>/.claude/settings.local.json`. Use `$CLAUDE_PROJECT_DIR` so the
paths are not tied to one machine.

Caveat: the board launches sessions with `--settings <workspace>/.claude/settings.json` (else
`settings.local.json`), and `$CLAUDE_PROJECT_DIR` did not resolve when such a session's cwd was a
project subfolder. If you launch from the board into subfolders, use absolute paths for the hook
commands in that file (not verified beyond that one observation).

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [
        { "type": "command", "command": "python3 \"$CLAUDE_PROJECT_DIR/.claude/hooks/ask_questions_reminder.py\"" }
      ] }
    ],
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [
        { "type": "command", "command": "python3 \"$CLAUDE_PROJECT_DIR/.claude/hooks/destructive_command_guard.py\"" }
      ] }
    ]
  }
}
```

## Tools I use

Things that cut tokens or improve the Claude Code work environment. Install pointers only; check
each project's own README for current details.

| Tool | What it does | Why |
|---|---|---|
| `ponytail` plugin | Forces the smallest solution that works (stdlib/native first, shortest diff) | Less output, less code to review |
| `pyright-lsp` plugin | Python code intelligence through LSP | Diagnostics and type errors without a separate run |
| `statusline/` | Status line with running spend: session, 5h block, today, 7 days | See cost while you work |

### ponytail

```bash
claude plugin marketplace add DietrichGebert/ponytail
```

```bash
claude plugin install ponytail@ponytail
```

Note: `hooks/ask_questions_reminder.py` mentions ponytail because ponytail's "question it in the
same response" line can read as permission to ask in prose. Drop that sentence if you don't use it.

### pyright-lsp

```bash
claude plugin install pyright-lsp@claude-plugins-official
```

### statusline

Needs `jq` and `python3`. `statusline.sh` looks for `usage.py` in its own folder. Edit `PRICING` in
`usage.py` when rates change; the cost is an estimate from your local session logs, not a bill.

```bash
mkdir -p ~/.claude/statusline && cp statusline/statusline.sh statusline/usage.py ~/.claude/statusline/
```

Then add this to `~/.claude/settings.json`:

```json
{
  "statusLine": { "type": "command", "command": "bash ~/.claude/statusline/statusline.sh" }
}
```

## Adding your own tool to this list

1. Install it in your own environment first and use it for a few sessions; list only what you
   actually kept using.
2. Add one row to the Tools table: name, one-line what it does, one-line why (what it saves).
3. Add a `### <tool>` section with the install command in its own fenced `bash` block (one block
   per step). Link the tool's own README rather than copying its docs.
4. If it needs a hook or a setting, show the exact `settings.json` snippet with `$CLAUDE_PROJECT_DIR`
   or `~`, never an absolute path with your username.
5. If it is a script you wrote, put it in its own folder here (like `statusline/`), keep it
   self-contained (no imports from your private projects), and smoke-test it once.
6. Run the sanitize scan from the repo guide over `claude-config/` before committing; it must be empty.
