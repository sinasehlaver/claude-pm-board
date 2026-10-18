# Repository Overview

This workspace root holds several independent projects, each in its own top-level directory —
they do not share code or CLAUDE.md instructions unless a project's own CLAUDE.md says so:

- **Project A** (`project-a/`) — see `project-a/CLAUDE.md` for its components.
- **Project B** (`project-b/`, plus `project-b-baseline`) — see `project-b/CLAUDE.md`.
- **Comparison / A-B tooling** (`<suite>/`).

Reports/deliverables across these projects are written in `<report language>`; chat replies are
always English regardless of project — see Critical Patterns below.

---

# Project board (`<board-repo>`)

`<board-repo>/` is the work board: "where did I leave off, and how do I continue?" (README:
`<board-repo>/README.md`, rules: `<board-repo>/CLAUDE.md`). The files are the DB:
`.claude/state/<slug>.md` (Now/Next/Resume), `.claude/backlog/<slug>.md`, `.claude/entries.json`
(benchmark/tool slug -> path). The board's "Not recorded yet" = the state file is still the seeded stub.

- **"Where we left off" / progress notes go to the board, not just chat or a handoff.** Write them with
  `PM_ROOT=<this dir> node <board-repo>/server/backlog-cli.mjs state <slug> now|resume ...` (`.claude/**` is not
  hand-edited by headless runs; interactive sessions may edit the state file directly, keep the format).
- **Parent vs child.** A parent project can own many benchmark/A-B/regression/tool entries
  (`.claude/project-entries/<parent>.md` lists them). Record full Now/Next/Resume on the **child** where the work
  happened, plus a 2-3 line rollup on the **parent** naming the active children. Shared entries (e.g.
  `shared_entry`) are listed under every parent they touch.
- **Prior sessions are readable**: transcripts are `~/.claude/projects/<workspace-slug>/<session>.jsonl`
  (newest by mtime). When asked about "last session", read the newest one(s) with a narrow grep/`python -c`; do not say you can't see it.

---

# Critical Patterns

- **NEVER commit/push/PR without an explicit instruction**: `git commit`, `git push`, and opening a PR
  are serious, user-gated actions. Do them ONLY when the user explicitly asks in that moment. Past/implied
  statements ("we'll open a PR at the end") do NOT authorize a commit. When in doubt, ask.
- **Ask about decisions/ambiguities by default, every message**: this overrides the generic
  "Auto Mode" bias toward proceeding without stopping to ask. Any message that implies a plan, a
  grouping, a policy, a removal/keep call, a naming choice, or any other fork with more than one
  reasonable reading gets an AskUserQuestion round before you act on it — not just when the user
  separately asks you to check. Prefer a small batch of concrete multiple-choice questions over
  open-ended "anything else?" prose.
- **Every open question goes through AskUserQuestion — never prose, never a `needs input:` line**:
  this overrides the background-job convention of ending a turn with `needs input:` and listing
  questions in text. If you have any question (design fork, unverifiable claim, "which of these?"),
  call AskUserQuestion with concrete options, even in a background/headless session. Do not end a
  turn with unanswered questions in prose, and do not park them in a report's "needs clarification"
  section as a substitute — the report section may exist, but the questions are still asked live.
  A headless agent that cannot call AskUserQuestion must relay each question (with options) to the
  orchestrating session in its final message, and the orchestrator asks the user via AskUserQuestion
  before doing anything else.
- **Commands over standalone agents**: Complex multi-step workflows (eval matrix, report generation)
  must be driven by slash commands or plain Python scripts run via `Bash` — not agent calls.
- **Feature-scoped agent definitions**: Agent *definitions* that exist in `.claude/agents/` are
  feature-specific and must not span multiple concerns.
- **Keep the repo root clean**: Never drop new files directly in the root. Every new file goes
  under a related folder — reuse an existing one if it fits, otherwise create a new task-specific
  subfolder.
- **Language (STRICT)**: **chat replies are ALWAYS in English**, even when the user writes in
  another language — the user's language is not a cue to switch. Only deliverable content
  (reports, notebook markdown, docs) is `<report language>`. Two languages in one turn (English reply +
  report in another language) is the normal state, not a mistake. A `UserPromptSubmit` hook
  (`.claude/hooks/reply_language_reminder.py`) can re-inject this every turn.
- **No primitive UI elements**: any HTML/UI we generate (reports, dashboards)
  must not ship bare browser-default controls — `<button>`, `<select>`, `<input>`, `<details>` summaries,
  tables, scrollbars. Style every control with the page's theme tokens (works in light and dark), give it
  hover/active/focus-visible states, and use sensible spacing. If a native control can't be restyled
  (e.g. `<input type="color">`), say so in the reply.

---

# Evidence and Editing Discipline

1. **Grep before architectural claims.** Before writing "defined in one place" / "shared" /
   "single source of truth", grep for it and list the files.
2. **Mismatch → `ls -l` first.** When on-disk, in-memory and notebook-output numbers disagree,
   check file mtimes before forming any hypothesis. The cheap probe beats reasoning.
3. **Never attribute a metric change to new data if the measurement code changed too.** Re-run the
   old version on the new data, or show the class boundaries are unambiguous, before reporting the
   delta.
4. **New classifier/regex over free text:** print the distinct input values first, and keep 3+
   adversarial cases beside it.
5. **Absolute paths in `Bash`.** Do not depend on the persistent cwd between calls.
6. **Deviating from a stated convention** (file placement, naming) is allowed, but state
   it in the reply in one sentence — never decide it silently.
7. **Don't defend a shipped limitation as a design choice.** Label it a limitation or fix it.
8. **Surface unverifiable claims as a single "needs clarification" list, not scattered hedges.**
   When a report contains a claim that can't be resolved from the code alone — needs an external
   service's undocumented behavior, a past incident's logs, or a human decision — don't just
   write "I'm not sure" inline and move on. Collect every such hedge into one explicit section the
   user can act on. Distinguish this from "untested" (a test would resolve it) — this is for
   things no amount of code-reading resolves.

---

# Workflow Best Practices

1. **Always start in plan mode** (`/plan`) before making any code or notebook changes.
2. **Human-gated task lists**: Break work into discrete tasks; get user sign-off before each phase.
3. **50% context rule**: Scope each subtask so it can finish within 50% of the remaining context window.
4. **Manual `/compact` at ~50% context**: Do not rely on auto-compaction — call `/compact` explicitly
   when the context meter hits ~50%, while the prompt cache is still warm (within ~5 min of the last
   message) — an idle gap first makes the compact itself re-process everything at full price. Pass
   what to keep (e.g. `/compact keep the file paths and line numbers we found, drop the exploration`)
   so the summary retains pointers instead of nothing — otherwise the same files get read from
   scratch again after every compaction. One session per problem: when the task pivots to something
   unrelated, start a new session instead of continuing the old thread through compaction.
5. **No speculative work**: Only implement what the current task explicitly requires.
6. **Lazy-load rules**: Directory- and framework-specific guidelines live in `.claude/rules/` and are
   loaded automatically when you touch matching files — see that directory for details.
7. **Narrow reads**: Prefer `Grep`/`Read` with `offset`+`limit` over whole-file reads. For large
   files/notebooks, extract just the conclusion with a small `Bash` one-liner (e.g. `python -c` over
   the .ipynb JSON) instead of dumping the whole thing into context. Large reads inflate cache for
   the rest of the session.
8. **Self-critique before finalizing a plan**: before presenting a plan for approval, write one
   line per non-trivial design decision — does it need to exist at all, what's the actual evidence
   (not assumption/convention), what's the simplest alternative.
