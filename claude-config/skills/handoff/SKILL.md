---
name: handoff
description: Produce a self-contained handoff brief that lets a fresh agent/session pick up the current conversation with no prior context. Use when the user asks to hand off, switch agents, start a new session/chat, or says "handoff", "el değiştir", "başka agent'a devret", "yeni sohbete taşı".
---

# Conversation Handoff

Writes a compact brief a brand-new agent (no memory of this conversation) can
read once and continue the work correctly — nothing more, nothing less.

## Steps

1. Re-read this conversation (not memory, not the repo — the actual turns)
   and pull out only what a fresh agent needs:
   - **Goal** — what the user actually wants, in their words if precise.
   - **State** — what's done and verified so far.
   - **In progress** — what's mid-flight, including the exact next action.
   - **Key decisions** — choices made and why, only the non-obvious ones
     (a fresh agent will otherwise re-litigate them).
   - **Files touched** — paths, with a one-clause note on what changed in
     each. Skip files only read, not changed, unless they're load-bearing
     context.
   - **Open questions / risks** — anything unresolved, unverified, or that
     needs a human call. Don't invent one if there isn't any.
   - **Do NOT** — dead ends already tried and ruled out, so the new agent
     doesn't repeat them.
   - **Debugging/repro infra** — when the work involves an active bug or investigation, actively
     identify (don't just recall) any logs, trace flags, or repro harnesses relevant to it, and
     spell out exact paths and how to enable them. This is the one category where "go find it" is
     the point — the goal is that the next agent never has to hunt for what already exists.

2. Skip any section that's empty — an empty "Risks" section says nothing an
   absent one doesn't. Never pad.

3. Write the brief to a file — not into the chat reply. This is the point:
   the new agent reads it directly instead of it round-tripping through the
   user's clipboard and getting echoed into this transcript first.
   - Path: `<current task's own folder>/handoff/<slug>-YYYYMMDD.md` — never
     the repo root. If the current work isn't scoped to a folder yet, ask
     once where to put it rather than guessing a new top-level folder.
   - Write it in English regardless of the conversation's language — it's
     addressed to an agent, not a report deliverable.
   - Keep it tight: a briefing, not a transcript — no blow-by-blow of turns
     taken, only what changes the next agent's behavior.

4. Reply with only: the file path, and one line on where things stand (e.g.
   "ready to hand off — nothing paused mid-edit"). Do not also paste the
   brief's contents into the chat reply — that defeats the token saving.
   Tell the new agent/session to open with: `Read <path>, then continue.`

## Notes

- This produces a file only — it does not invoke, spawn, or message another
  agent itself (no Agent/Workflow calls, no exceptions).
- Uncommitted file edits/state carry over only if the new agent runs in the
  same working directory — say so if it's not obviously the case.
