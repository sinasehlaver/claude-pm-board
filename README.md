# claude-pm-board

A cross-project PM board: one pane over every project you keep in a workspace —
status, backlog, and an activity timeline — rendered from plain Markdown/JSON files
under a `.claude/` directory. **The files are the database.** No SQLite, no server DB.

It ships as a mobile-first PWA (Express API + Vite/React front end) and, optionally,
as a standalone macOS desktop app via a thin Electron shell.

## Features

### Home: the project board

The home screen shows one card per tracked project — a title, a one-line status
preview (truncated), an open-task count, a "last activity" timestamp, and a red dot
if the project is blocked. Cards are sorted pinned-first, then blocked-first, then
by most recent activity.

- **Ideas** is an always-pinned card (marked with a 💡) that never disappears behind
  the filter — it's a catch-all backlog for anything not yet tied to a specific
  project. The input at the top of the home screen ("💡 capture an idea…") drops a
  one-line task straight into the Ideas backlog without you having to pick a project
  first; sort it into a real project later (see "Ideas inbox" below).
- **+ (add an ad-hoc project)** prompts for a short slug (lowercase letters, digits,
  hyphens) and creates an empty `.claude/backlog/<slug>.md` for something that doesn't
  have a code directory yet. Ad-hoc projects are tagged "ad-hoc" on their card.
- **Filter** opens a bottom sheet listing every non-pinned project with a checkbox;
  unchecking one hides its card from the home screen (stored in this browser's
  `localStorage`, so it doesn't affect anyone else's view, and nothing is deleted —
  a hidden project's files are untouched and it still shows up everywhere else, e.g.
  when moving a task). The Filter button shows a badge with the current hidden count.
- **Sessions** and **Continuous** are links to the two other top-level views, covered
  below.
- A light/dark **theme toggle** (☀/☾, top-right) persists your choice in
  `localStorage`; absent a stored choice it follows the OS's `prefers-color-scheme`.

### Project detail: Status

Each project has a **Status** section showing a one-line preview of "Now" (what's
actively being worked on). Tapping "view / edit" (or "add", if there's no state file
yet) opens a bottom sheet with the full status:

- **Now** — a single current-focus line.
- **Next** — a short queue, one item per line.
- **Last failure** — what broke most recently, or "none".
- **Blockers** — anything stuck, or "none".

Tapping "edit" inside the sheet swaps it for a form (the fields above) and "Save"
writes it back via `PUT /api/projects/:slug/state`. This is backed by
`.claude/state/<slug>.md`, a hand-maintained status file capped at 40 lines total —
the API rejects an update that would push it over the cap (`server/state.mjs`'s
`serializeState` throws; the server returns HTTP 422).

### Project detail: Backlog

The Backlog section lists every task, grouped under up to four headings —
**Doing / Todo / Blocked / Done** — matching the sections of
`.claude/backlog/<slug>.md`. A plain text box ("Add a task…") appends a new `Todo`
item. Each task row has:

- Its title — tap it to edit in place (a prompt dialog).
- **▶** ("build with Claude") — launches a single-task Claude Code session for just
  this task (see "Build with Claude" below).
- **@seq** — a toggle button that flags/unflags this task for the batch orchestrator
  (lit up when on). Covered in full in the next section.
- A priority pill (**–** / **p1** / **p2** / **p3**) — tapping it cycles
  `– → p1 → p2 → p3 → –`.
- **×** — deletes the task.
- A row of state buttons (**Doing / Todo / Blocked / Done**) — tapping one moves the
  task into that state; tapping **Done** stamps it with today's date.
- In the Ideas project only, a **▸** ("move to project") button prompts for a
  destination project slug and moves the task there as a new `Todo` item.

A task can also carry a **note** — a free-text line (or several) shown indented
under the title. Notes come from elsewhere (e.g. filing a session to a task, see
below) rather than from a UI field on the add-row itself.

The **Done** group is collapsed by default (shown as `Done (N)`, with a `▸`/`▾`
chevron) so finished work doesn't clutter the active list — click the heading to
expand or collapse it.

On disk, one backlog line looks like:

```
## Todo
- Write onboarding doc  p2
  needs a screenshot of the new flow
## Done
- Fix flaky session harvester test  p1  (2026-09-03)
```

i.e. `- <title>  p<priority>` while open, and `- <title>  p<priority>  (<done-date>)`
once moved to Done; an indented line underneath is that task's note.

### The sequential selection workflow — "Run @seq"

This is the flagship feature: a way to hand a *batch* of backlog todos to Claude Code
in one go and have it work through all of them autonomously, instead of you
launching and babysitting one task at a time.

**1. Flagging todos.** On any task row, the **@seq** button is a toggle. Tapping it
marks that specific todo as part of the next orchestrated batch; tapping it again
un-flags it. On disk this is a trailing `@seq` marker on the backlog line, parsed and
serialized by `server/backlog.mjs`. The canonical trailing order on a line is:

```
<title>  @seq  p<priority>  (<done-date>)
```

(date only appears once the task is Done). For example, after flagging three todos
for orchestration, `.claude/backlog/myproject.md` might contain:

```
## Todo
- Add CSV export to the reports page  @seq  p1
- Wire up retry logic for the webhook sender  @seq  p2
- Rename `utils/format.js` to `utils/formatting.js`  @seq
```

**2. Launching it.** As soon as one or more non-Done todos in a project are
`@seq`-flagged, a **▶▶ Run @seq** button appears next to the Backlog heading.
Clicking it calls `POST /api/projects/:slug/tasks/run-seq`, which:

- Collects every `@seq`-flagged todo in that project that isn't already Done.
- Builds one seed prompt for all of them together via `seedForSequentialRun`
  (`server/launch.mjs`) — the todos are listed as one numbered batch, each with its
  note if it has one.
- Opens a new terminal window (iTerm if installed, else Terminal.app) in the
  project's directory and starts a **fresh `claude` session** seeded with that
  prompt. An alert confirms which terminal app it used and how many todos were
  included (e.g. "Orchestrator launched in iterm for 3 @seq todo(s).").

**3. What the orchestrator session actually does**, per the instructions baked into
the seed prompt:

- It works out a dependency order across the batch: todos that touch disjoint
  files/behavior are treated as independent and fanned out **in parallel to
  subagents** (one subagent per todo, via the Task tool); todos that depend on each
  other run sequentially instead. It re-evaluates after every batch, since a
  completed todo can unblock — or conflict with — the ones still pending.
- Before sizing each batch, it paces its own concurrency against a live burn-rate
  signal: primarily `GET http://localhost:4310/api/summary?bucket=hour` (the
  `claude_usage_dashboard` project, if running) — rising trailing tokens/hour means
  fewer concurrent subagents / smaller batches, a quiet signal means it can widen.
  If that's unreachable, it falls back to
  `~/.claude/vscode-claude-status-cache.json` as a rate-limit **ceiling check only**
  (not a liveness signal) — it only throttles on that file when the file is fresh
  (updated within ~15 minutes) and either the limit status isn't "allowed" or the
  5-hour utilization is ≥ ~85%.
- As each todo lands and its project's verify/tests pass, the orchestrator moves it
  to **Done** in the backlog file and drops its `@seq` marker — so tasks visibly
  migrate into the Done group as you refresh the pm board or re-open the backlog
  file, with no further input from you.
- When the whole batch is done (or everything remaining is blocked), it updates
  `.claude/state/<slug>.md` and `.claude/backlog/<slug>.md` and writes a summary of
  what shipped, what was deferred, and why.

**4. Worked example.** Flag three todos with @seq as shown above, then click
**▶▶ Run @seq**. You'll see a new terminal window open running `claude`, already
working from the seeded prompt — no further typing needed. Leave it running and check
back later: refresh the pm board (or just wait for the next auto-update — the UI
polls live file changes over SSE) and you'll see the flagged todos disappear from
Todo and reappear under Done, one by one as the orchestrator finishes each.

**5. It's one-shot, not a loop.** The orchestrator session is a normal, single
`claude` invocation — not a `/loop` session. If it hits the rate-limit ceiling
mid-batch, it stops cleanly: any todos it hasn't gotten to are left in place (still
flagged, or noted as blocked-on-rate-limit with the reset time), and it exits rather
than trying to sleep or reschedule itself. You re-launch **Run @seq** again later
once the limit resets; already-Done todos won't re-run since they're no longer
`@seq`-flagged.

**6. Remote launch needs auth.** Like the single-task build button, `Run @seq` is
guarded: it only works from a loopback client (i.e. the same machine) or a request
carrying a valid `PM_TOKEN` (`?token=…` or an `x-pm-token` header). If you want to
tap **Run @seq** from your phone, set `PM_TOKEN` (see Configuration below).

### Build / resume with Claude (single task)

Every individual task row also has its own **▶** ("build with Claude") button,
independent of `@seq`. Clicking it calls
`POST /api/projects/:slug/tasks/:id/launch`, which opens a terminal running a fresh
`claude` session seeded by `seedForTask` (`server/launch.mjs`) with just that one
task's title and note, plus a pointer to read `.claude/rules/<slug>.md` and
`.claude/state/<slug>.md` first (skipped for ad-hoc projects, which have no code
directory) and an instruction to update state/backlog and move the task to Done when
finished. This is the same loopback-or-`PM_TOKEN` guard as `Run @seq`.

### Ideas inbox

The home screen's "💡 capture an idea…" box appends a one-line task straight to
`.claude/backlog/ideas.md` via `POST /api/projects/ideas/tasks` — no project
selection required. The Ideas card on the home screen is pinned (always visible,
never hidden by the Filter sheet) and flagged via a `pinned` API field so it sorts to
the top. Once you know which project an idea belongs to, open the Ideas project and
use its tasks' **▸** ("move to project") button to relocate it — this moves the
backlog entry to the target project's `Todo` section (`POST /api/tasks/move`).

The Ideas project's **▶** and **▶▶ Run @seq** buttons behave differently from every
other project's, because `server/launch.mjs` branches on `slug === "ideas"`:

- **▶ on a single idea** launches a *research-only* session: it triages the idea
  (genuine business/venture concept → the `venturemind` skill; otherwise a personal
  tool → the `atelier` skill, research steps only, no build) and leaves a note on the
  idea's bullet pointing at the resulting write-up. The idea itself stays in Todo —
  nothing gets built or promoted yet.
- **▶▶ Run @seq on a batch of `@seq`-flagged ideas** promotes each one into a real pm
  project: a subagent per idea creates `PM_ROOT/<slug>/` with a `CONTEXT.md` (full
  research + implementation plan, and — for personal-tool ideas — `atelier`'s actual
  build, not just a plan), a `.claude/state/<slug>.md`, and a `.claude/backlog/<slug>.md`
  seeded with one Todo per implementation phase, then removes the idea's bullet from
  `ideas.md`. From there the new project behaves like any other — its own ▶ / Run @seq
  buttons pick up where promotion left off.

### Sessions inbox

The **Sessions** view lists Claude Code conversations harvested from
`~/.claude/projects/<workspace>/*.jsonl` (a background harvester writes
`.claude/pm/sessions.json`; nothing here is LLM-summarized — title, first message,
and touched files are all raw fields). It's split into:

- **Inbox** — sessions not yet filed to a project.
- **Filed** — sessions already linked to one (collapsed by default, tap
  "▸ Filed (N)" to expand).

Each row shows the session's title, how long ago it started, its duration/message
count, a snippet of the first user message, and chips for any project slugs its
touched files matched. From a row you can:

- Pick a project from the dropdown and hit **file** — links the session to that
  project (`PUT /api/sessions/:id`) without creating a task.
- Hit **→ task** — creates a new `Todo` task in the chosen project titled
  `resume: <session title>`, with a note containing the session's first message and
  its id (`POST /api/sessions/:id/task`), so you can pick the conversation back up
  from the backlog later.
- Hit **reopen** — relaunches that exact session via
  `claude --resume <sessionId>` in a new terminal (`POST /api/sessions/:id/resume`,
  loopback-or-`PM_TOKEN` guarded, same as the build buttons).
- Hit **archive** (inbox rows only) — marks it archived so it drops out of both
  lists.

A project's own detail page also shows a **Sessions** block listing sessions already
filed to it, each with its own **reopen** button.

### Continuous tab (optional)

If a `continuous/` project exists alongside `pm/` (the autonomous backlog runner —
see `CONTINUOUS_ROOT` in Configuration), the **Continuous** link on the home screen
opens a dashboard over its runtime state:

- **Runner** — whether the runner process is alive (with its pid) or stopped, plus
  what it would do right now ("▶ would run" / "⏸ sleeping" and why). Three controls:
  **Tick now** (runs one action immediately), **Start loop** (opens a terminal
  running `npm start` in the `continuous/` directory), **Stop** (sends `SIGTERM` to
  the running process). If the last run failed, a **clear** button resets that
  failure flag.
- **Budget** — usage meters against the configured 5-hour and 7-day token caps, plus
  the current pace (tokens/hour) versus target.
- **Now** — the action currently in progress, if any.
- **Activity** — a recent-actions log (timestamp, project, action, model, tokens
  used, over-estimate ratio, cost, pass/fail).
- **Config** — an editable form for the runner's tunables (`cap_5h`, `cap_7d`,
  `safety`, `active_hours_per_day`, `min_action_tokens`, the `human_at_keyboard`
  on/off toggle, and the raw `pool` JSON).

Importantly, **pm does not supervise the runner process itself** — "Start" just opens
a visible terminal running it, and pm only reads/displays its state files
(`.claude/continuous/{state.json,log.jsonl,plans/,runner.lock}`) and a few of its pure
logic modules in-process. If `continuous/` isn't present, pm boots fine and the tab
shows a short explainer instead.

### Usage tab: burn rate and cost

The **Usage** link on the home screen opens a dashboard over your Claude Code token
usage, and the home screen itself shows a compact burn-rate strip that links into it.
This is a self-contained feature — pm parses `~/.claude/projects/**/*.jsonl` directly,
so it works with no other project installed or running (it reuses the calculation
mechanics from `claude_usage_dashboard` and `continuous`, not those apps themselves):

- **Burn rate** — rolling token totals over the last 1h/5h/7d, across every session on
  the machine (main sessions + subagent/tool-result transcripts, deduped by message id).
  These are the same windows the "Run @seq" orchestrator paces its batches against.
- **Rate-limit ceiling** — your account's %-of-limit from
  `~/.claude/vscode-claude-status-cache.json` (the same file the VS Code extension
  writes), flagged **stale** if it's more than ~15 minutes old.
- **Last 14 days** — a per-day token/cost bar chart plus a total estimate.
- **By model** — token and cost totals grouped by model.

Cost is an estimate from a hardcoded per-model pricing table in `web/src/pricing.js`
(ported from `claude_usage_dashboard`'s pricing grid) — cross-check against
anthropic.com for current rates, not a billing statement.

### Progressive web app / desktop shell

The front end is a mobile-first PWA — installable to your phone's home screen like a
native app, with its own URL routing (`/`, `/project/<slug>`, `/sessions`,
`/continuous`) so back/forward work as expected. On macOS, `npm run app` builds it
and wraps it in a minimal Electron shell (`electron/main.cjs`) for a standalone
desktop app instead of a browser tab; `npm run app:dmg` packages a distributable
`.dmg`. Both render the exact same web app against the same live workspace files.

## Requirements

- **Node ≥ 20** (uses `node:test`, `node --watch`, native `fetch`).
- **macOS** for the Electron desktop shell and the "build / resume with Claude"
  terminal-launch buttons (they shell out through `osascript` to iTerm or Terminal).
  The web app itself is platform-agnostic.
- **Windows**: the web app (server + PWA) runs unchanged — `npm install`,
  `npm run dev`, `npm test` work as-is in PowerShell or cmd.exe. The Electron
  desktop shell and the build/resume terminal-launch buttons are macOS-only
  (no Windows equivalent is implemented). `npm run verify` shells out to bash
  helper scripts and won't run natively — use WSL or Git Bash for it, or rely
  on `npm test` instead.

## Install / run / test

```
npm install         # once
npm run dev         # server :4500 + vite :4501 (proxies /api)
npm test            # node:test, server/*.test.mjs
npm run app         # build web/ + run the desktop shell (electron/main.cjs)
npm run app:dmg     # package release/PM-<ver>.dmg  (app:pack = unpacked .app only)
```

`npm run verify` boots the server on a free port against a throwaway fixture
workspace and smoke-tests the API. It depends on helper scripts from the author's
outer workspace (`../.claude/scripts/*`) and will not run in a bare clone — use
`npm test` there instead (pure `node:test`, no external deps).

## Configuration

All optional, via environment variables:

| Var | Default | Purpose |
|---|---|---|
| `PM_ROOT` | parent directory of this package | Workspace root that owns the `.claude/` dir to read & write. `pm/` is expected to live directly under the workspace it manages; set this to override (tests and `npm run verify` always do). |
| `PM_PORT` / `PORT` | `4500` | Server port. |
| `PM_TOKEN` | _(unset)_ | Optional shared secret. When set, launch/resume routes require `?token=` or an `x-pm-token` header. Needed to use the build button from a phone. |
| `CONTINUOUS_ROOT` | `$PM_ROOT/continuous` | Location of the optional autonomous-runner project the Continuous tab drives. pm boots fine without it. |

## Workspace layout it expects

Under `$PM_ROOT/.claude/`:

- `state/<slug>.md` — a ≤40-line status file per project (the app does light edits via
  `PUT /api/projects/:slug/state`).
- `backlog/<slug>.md` — the task list. Section headings are states
  (`Doing` / `Todo` / `Blocked` / `Done`); one `- ` bullet per task, optional trailing
  `p1|p2|p3` priority, optional trailing `(YYYY-MM-DD)` on done items, an indented line
  is the previous task's note. `backlog/ideas.md` is a pinned inbox.
- `pm/activity.json`, `pm/sessions.json` — generated by a harvester pass; never hand-edited.
- `pm/session-index.json` — user-owned map of Claude Code session id → project.

Session transcripts are read from `~/.claude/projects/<escaped-PM_ROOT>/*.jsonl`.

This project grew inside one specific workspace and is tuned to its conventions;
treat it as a personal tool / reference implementation rather than a turnkey product.

## Security

The server binds `0.0.0.0` (so a phone on the same LAN can reach it) and is
**unauthenticated by default**. Set `PM_TOKEN` if that matters on your network.

## License

MIT — see [LICENSE](LICENSE).
