---
paths: <board-repo>/**
---

# <board-repo>

Project instructions: <board-repo>/CLAUDE.md.

- Board todos for the board project live in `.claude/backlog/<board-slug>.md`; write them like a person would (short, first person, no boilerplate), each with a `Done when:` outcome and a `Test:` that says exactly how to check it.
- One todo per phase; steps live in `<board-repo>/phases/phase-N-*.md` (each step has Done when + Test), the todo note points there. Don't split phases into step todos.
- Roadmap decisions live in the phase file's `## Decisions` section. Nothing is built until the user starts a phase from the board.
- Never write `.claude/**` by hand from a headless run; use `server/backlog-cli.mjs`.
