---
name: board-todo-style
description: "How to write todos on the pm board: human voice, each with Done when + Test, phase-prefixed"
metadata:
  type: feedback
---

Todos on the board are human-written: short, first-person plain wording, prefixed `phase N:` when part of a phase plan. Each has an indented note with `Done when:` and `Test:`. Multi-step work = ONE todo per phase pointing at `<board-repo>/phases/phase-N-*.md` (steps + per-step tests live there); never split a phase into per-step todos (too granular).

**Why:** the user picks todos and starts phases from the board themselves, so each must be self-explanatory and checkable without me.
**How to apply:** write through `server/backlog.mjs` parsers or `backlog-cli.mjs` (never hand-edit `.claude/**` headless). Codified in `<board-repo>/CLAUDE.md` and `.claude/rules/board-project.md`. See [[pm-board-plan]].
