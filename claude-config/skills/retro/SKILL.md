---
name: retro
description: Brutally and honestly reviews the current conversation for mistakes Claude made — wrong assumptions, ignored instructions, unnecessary or wasteful actions, incorrect technical claims — and writes each confirmed one to a feedback memory so it doesn't recur. Use when the user asks for a retro, post-mortem, or says "review your mistakes", "what did you get wrong", "brutal review", "retro this conversation".
---

# Conversation Retro

Reviews Claude's own conduct in this conversation — not the user's, not the
code's correctness (that's `code-review`'s job) — and turns every real
mistake into a standing feedback memory.

## Steps

1. Re-read the actual conversation from the start — every turn, every tool
   call, every user correction — not a summary of it, not memory.

2. Find every mistake, not only the ones the user caught and called out:
   - Places the user corrected, redirected, or had to repeat themselves.
   - Actions that violated a stated rule (CLAUDE.md, a memory, an explicit
     instruction) even if the user didn't notice or complain in the moment.
   - Wrong technical claims, guesses presented as fact, unverified
     assertions stated with confidence.
   - Wasteful or unnecessary actions: redundant tool calls, doing something
     explicitly forbidden, over-reading files, ignoring a "don't do X."
   - Style/scope violations: wrong language, unrequested files, unrequested
     abstractions, verbosity, scope creep beyond what was asked.
   - Anything a strict senior reviewer would flag as sloppy, even if the
     user let it slide.

3. Be brutal, not diplomatic. Do not soften a real mistake into "a
   reasonable judgment call given ambiguity" if it wasn't one. If genuinely
   torn on whether something counts, count it. Do not pad the list to look
   thorough — skip anything that was actually fine in hindsight.

4. For each confirmed mistake, before writing anything: check MEMORY.md's
   index for an existing entry that already covers it.
   - Already covered, nothing new to add → skip it, note in the report that
     it's a repeat of an existing memory (that itself is worth calling out —
     it means the memory isn't being applied).
   - Already covered but this occurrence adds a sharper "why" or a new edge
     case → update that memory file in place, don't create a duplicate.
   - Not covered → write a new memory: pick `feedback` type, follow the
     standard frontmatter (`name`, `description`, `metadata.type: feedback`),
     body = the rule, a **Why:** line grounded in what actually happened
     this conversation (not a hypothetical), and a **How to apply:** line.
     Add one index line to MEMORY.md.

5. If nothing rises to the level of a real mistake, say so plainly. Do not
   invent one just to justify having run the skill.

6. Reply in the chat — this is for the user to read directly, unlike
   `handoff`'s file-only output:
   - A numbered list, one line per mistake: what happened, why it was wrong.
   - For each: new memory written / existing memory updated / repeat of an
     unapplied memory (call this out explicitly).

## Notes

- Scope is this conversation only — not a sweep of older sessions.
- Positive confirmations ("that approach was right, keep doing it") are
  already captured ambiently by the standing auto-memory rules; this skill
  only hunts the negative side.
