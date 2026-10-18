---
name: pm-board-plan
description: "The board is itself a project on its own board: the agreed roadmap lives as phase todos in its backlog, steps in phases/phase-N-*.md; never start a phase unprompted"
metadata:
  type: project
---

The pm board is itself a project on its own board. The agreed roadmap is logged as one todo per phase in `<workspace>/.claude/backlog/<board-slug>.md` (status in `<workspace>/.claude/state/<board-slug>.md`). Each todo's note points at `<board-repo>/phases/phase-N-<name>.md`, which holds the steps, each with its own Done when + Test. The user picks todos and starts phases from the board; do not start a phase unprompted.

Roadmap decisions go into the phase file's `## Decisions` section (with the date), not into this memory. Keep this memory to the working rules.

**Why:** the board is the single place that answers "where did I leave off, and how do I continue?"; a roadmap kept only in chat or memory goes stale.
**How to apply:** read the backlog and the state file for current status instead of trusting this file. Before any move/rename of files that has no version control, make a backup first. Add todos only through the board's backlog CLI (`server/backlog-cli.mjs`) from headless runs. See [[ask-questions-via-askuserquestion]], [[board-todo-style]].
