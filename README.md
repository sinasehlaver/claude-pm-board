# claude-pm-board

A cross-project PM board: one pane over every project you keep in a workspace —
status, backlog, and an activity timeline — rendered from plain Markdown/JSON files
under a `.claude/` directory. **The files are the database.** No SQLite, no server DB.

It ships as a mobile-first web app (Express API + Vite/React front end) and,
optionally, as a standalone macOS desktop app via a thin Electron shell.

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
- **Latest todos** (below the cards) is a cross-project panel — click anywhere on its
  header row to expand/collapse it — with an "add a todo…" box
  with a project dropdown (remembers your last pick in `localStorage`; posts to the
  normal `POST /api/projects/:slug/tasks`), then the most recently added open
  (Todo/Doing) todos across all projects, newest first, each with a checkbox. **▶▶ Run
  selected (N)** launches ONE orchestrator session at the workspace root over the
  ticked todos (**▶▶ Run all listed (N)** when none are ticked; no confirm dialog — a short inline notice reports the launch);
  todos in different projects run in parallel, same-project ones sequentially. Ideas
  are neither listed nor run here (they have their own flow). Projects hidden via the
  Home **Filter** are also left out of the list, the run, and the add-todo dropdown
  (client-side, so the 30-item fetch is trimmed after fetching). Backed by
  `GET /api/todos/latest?limit=N` and `POST /api/tasks/run-cross` (`{items:[{slug,id,title}]}`,
  same loopback-or-`PM_TOKEN` guard as the other launch routes). Backlog files store
  no created-at date, so "newest" is a proxy: most recently modified backlog file
  first, and inside a file last-in-file first (new todos are appended). Ids are
  positional, so the server re-reads the backlog on run and answers `409` if an
  item's id/title no longer matches an open todo; the panel then refreshes.
- **+ (add an ad-hoc project)** prompts for a short slug (lowercase letters, digits,
  hyphens) and creates an empty `.claude/backlog/<slug>.md` for something that doesn't
  have a code directory yet. Ad-hoc projects are tagged "ad-hoc" on their card.
- **Filter** opens a bottom sheet listing every non-pinned project with a checkbox;
  unchecking one hides its card from the home screen (stored in this browser's
  `localStorage`, so it doesn't affect anyone else's view, and nothing is deleted —
  a hidden project's files are untouched and it still shows up everywhere else, e.g.
  when moving a task). The Filter button shows a badge with the current hidden count.
- **Sessions** and **Usage** are links to the two other top-level views, covered
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

**2. Launching it.** A run button is always shown next to the Backlog heading, and
its label says which mode it's in. If one or more non-Done tasks are `@seq`-flagged
it reads **▶▶ Run @seq (N)** and runs only those. If none are flagged it reads
**▶▶ Run all (N)** and runs every **Todo + Doing** task (Blocked and Done are
skipped; it launches immediately, with no confirmation dialog). It's disabled when nothing is runnable.
Clicking it calls `POST /api/projects/:slug/tasks/run-seq`, which:

- Collects every non-Done `@seq`-flagged task in that project; if there are none,
  falls back to every Todo/Doing task. Returns `{term,count}` (plus `mode`: `seq` or
  `all`); `400` only when nothing is runnable. The seed prompt follows the mode: it says
  "@seq-flagged" only in `seq` mode and just "batch of N todo(s)" in run-all mode.
- Builds one seed prompt for all of them together via `seedForSequentialRun`
  (`server/launch.mjs`) — the todos are listed as one numbered batch, each with its
  note if it has one.
- Opens a new terminal window (iTerm if installed, else Terminal.app) in the
  project's directory and starts a **fresh `claude` session** seeded with that
  prompt — by default via the unattended relay that auto-resumes after rate limits
  (see item 5; send `{"unattended":false}` or untick the checkbox for a plain
  interactive session, which is what items 3–4 below describe). The terminal window that opens is the confirmation; there is no
  popup on the project page (Home's Run selected shows an inline notice with the
  terminal app and todo count).

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

**5. Unattended by default — leave the house.** Every batch run (project
**▶▶ Run @seq / Run all**, Home **▶▶ Run selected**) goes through the **relay**
(`server/relay.mjs`) unless you untick the **Unattended** checkbox next to the run
button. **macOS only** (it opens iTerm/Terminal via `osascript` and wraps itself in
`caffeinate`; no Windows/Linux equivalent is implemented). The relay opens a terminal
running `node server/relay-cli.mjs <job>`, which:

- runs the orchestrator **headless** (`claude -p --output-format stream-json`,
  `--permission-mode acceptEdits`, `Bash(git *)` denied) so nothing stalls on a
  permission prompt — a todo that needs a denied command gets moved to **Blocked**
  with a note instead;
- reads claude's own `rate_limit_event`s: when the account window is rejected — or
  five-hour utilization passes 95% / seven-day 97%, in which case it stops the run
  itself rather than let it hit the wall mid-tool-call — it **sleeps until the
  reported reset time (+90s)**, pops a macOS notification, then **resumes the same
  session** (`--resume`) with a "you were cut off, continue the still-open todos"
  message, so the subagents that were interrupted pick up where they stopped. This
  repeats for as many resets as it takes;
- decides what is left by re-reading each project's backlog file and matching the
  batch's todos **by title** (Todo/Doing = open; Done/Blocked = resolved), so it
  finishes when the agent has moved everything out of Todo. If the agent exits
  cleanly with todos still open it nudges it up to 3 times while progress is being
  made, then reports **stalled**;
- keeps a status file in `.claude/pm/relay/<id>.job.json` that the Home board shows as
  a strip (running / waiting until `<time>` / done / stalled / failed). A finished row
  (anything but running/waiting) has a **✕** to dismiss it — deletes the job/spec files,
  `DELETE /api/relay/:id`, same loopback/`PM_TOKEN` guard as launching;
- updates the backlog/state through **one allowlisted helper**, `server/backlog-cli.mjs`
  (`move` / `add` / `state … now`). Claude Code hard-blocks Edit/Write on anything under
  `.claude/` in headless mode — no allow rule, `--add-dir` or hook overrides it — so
  without the helper a finished todo could never leave Todo and every run would end
  "stalled". The helper goes through pm's own round-trip-safe parsers, so it can't
  corrupt the files; `Bash(git *)` stays denied and nothing else is allowlisted. A
  consequence: an unattended run cannot hand-edit `.claude/rules/*.md` or create new
  project state files (Ideas promotion) — use the interactive path for those.

Leave the Mac plugged in and the lid open — `caffeinate` prevents idle sleep, not
lid-close sleep. Ctrl-C in the relay's terminal stops it for good. Untick
**Unattended** for the old behaviour: a normal interactive `claude` session that stops
cleanly at the limit (leaving todos flagged or noted as blocked-on-rate-limit) and that
you re-launch after the reset. Tunables (env on the pm server): `PM_RELAY_STOP_5H`
(0.95), `PM_RELAY_STOP_7D` (0.97), `PM_RELAY_BUFFER_MS` (90000), `PM_RELAY_TICK_MS`
(30000), `PM_RELAY_MAX_LIMIT_HITS` (30), `PM_RELAY_NOTIFY=0` to silence notifications.

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

- **Triage (both buttons), in order:** a genuine business/venture concept → the
  `venturemind` skill. Otherwise it's a personal-use idea, and the `prospector` skill
  runs **first** to answer "does this already exist — adopt or build?". If prospector's
  verdict is **Adopt** (a suitable off-the-shelf tool exists), the idea stops there:
  the verdict and prospector's report path (`knowledge/prospector/<slug>.md`) are noted
  on the idea's bullet and nothing is built. If the verdict is **Build** or **Adopt +
  extend**, it continues into the `atelier` skill.
- **▶ on a single idea** launches a *research-only* session that follows the triage
  above (`atelier` runs its research steps only, no build). On a **Build** / **Adopt +
  extend** verdict the idea is then **auto-promoted** to a project on the Home board
  under a suggested product name: a `.claude/state/<slug>.md` ("researched, ready to
  build"), a `.claude/backlog/<slug>.md` with one Todo per plan phase (the first one
  scaffolds the code dir), and its bullet is removed from the inbox. Nothing is built.
  Rename or relocate it from the board afterwards (▸ move to project). An **Adopt**
  verdict or a business (`venturemind`) idea stays in Todo with a note line pointing
  at the write-up, since those need your call.
- **▶▶ Run @seq on a batch of `@seq`-flagged ideas** promotes each one into a real pm
  project: a subagent per idea creates `PM_ROOT/<slug>/` with a `CONTEXT.md` (full
  research + implementation plan, and — for personal-tool ideas prospector says to
  build — `atelier`'s actual build, not just a plan), a `.claude/state/<slug>.md`, and
  a `.claude/backlog/<slug>.md` seeded with one Todo per implementation phase, then
  removes the idea's bullet from `ideas.md`. From there the new project behaves like
  any other — its own ▶ / Run @seq buttons pick up where promotion left off. Ideas
  prospector says to **adopt** are *not* scaffolded: the bullet stays in `ideas.md`,
  un-flagged, with the verdict + report path noted, and the final summary lists it as
  "adopt, not built".

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
- Pick **+ New project…** from the dropdown, type a name, hit **create + file** —
  scaffolds a new project (`POST /api/sessions/:id/new-project`, `{name}`): `<name>/`
  with `README.md` + `CONTEXT.md` stubs under the workspace root, plus
  `.claude/state/<slug>.md`, `.claude/backlog/<slug>.md` and `.claude/rules/<slug>.md`
  (with a `## Run & verify` placeholder), then files the session to it and seeds the
  same `resume: …` Todo as **→ task**. The name is lowercased, spaces become dashes;
  only `[a-z0-9-]` (max 40) is accepted, and it 409s if the directory or any of the
  three `.claude` files already exists. No `git init`; adding the project to the
  workspace `CLAUDE.md` table is still a manual step.
- Hit **reopen** — relaunches that exact session via
  `claude --resume <sessionId>` in a new terminal (`POST /api/sessions/:id/resume`,
  loopback-or-`PM_TOKEN` guarded, same as the build buttons).
- Hit **archive** (inbox rows only) — marks it archived so it drops out of both
  lists.

A project's own detail page also shows a **Sessions** block listing sessions already
filed to it, each with its own **reopen** button.

### Usage tab: burn rate and cost

The **Usage** link on the home screen opens a dashboard over your Claude Code token
usage, and the home screen itself shows a compact burn-rate strip that links into it.
This is a self-contained feature — pm parses `~/.claude/projects/**/*.jsonl` directly,
so it works with no other project installed or running (it reuses the calculation
mechanics from `claude_usage_dashboard`, not that app itself):

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

### Web app / desktop shell

The front end is a mobile-first single-page app, with its own URL routing (`/`,
`/project/<slug>`, `/sessions`, `/usage`) so back/forward work as expected. On
macOS, `npm run app` builds it
and wraps it in a minimal Electron shell (`electron/main.cjs`) for a standalone
desktop app instead of a browser tab; `npm run app:dmg` packages a distributable
`.dmg`. Both render the exact same web app against the same live workspace files.

## Requirements

- **Node ≥ 20** (uses `node:test`, `node --watch`, native `fetch`).
- **macOS** for the Electron desktop shell and the "build / resume with Claude"
  terminal-launch buttons (they shell out through `osascript` to iTerm or Terminal).
  The web app itself is platform-agnostic.
- **Windows**: the web app (server + front end) runs unchanged — `npm install`,
  `npm run dev`, `npm test` work as-is in PowerShell or cmd.exe. The Electron
  desktop shell and the build/resume terminal-launch buttons are macOS-only
  (no Windows equivalent is implemented). `npm run verify` shells out to bash
  helper scripts and won't run natively — use WSL or Git Bash for it, or rely
  on `npm test` instead.

## Install / run / test

```
npm install         # once
npm run dev         # server :4500 + vite :4501 (proxies /api)
scripts/start.sh    # same as npm run dev, but Ctrl+C reliably kills both processes
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
| `PM_RELAY_*` | see "Unattended by default" | Thresholds/timings for the unattended run relay (macOS only). |

## Workspace layout it expects

Under `$PM_ROOT/.claude/`:

- `state/<slug>.md` — a ≤40-line status file per project (the app does light edits via
  `PUT /api/projects/:slug/state`).
- `backlog/<slug>.md` — the task list. Section headings are states
  (`Doing` / `Todo` / `Blocked` / `Done`); one `- ` bullet per task, optional trailing
  `p1|p2|p3` priority, optional trailing `(YYYY-MM-DD)` on done items, an indented line
  is the previous task's note. `backlog/ideas.md` is a pinned inbox.
- `rules/<slug>.md` — per-project constraints/gotchas. The board doesn't render these;
  they are read by the Claude Code sessions the board launches ("read the project's
  rules before editing it"), so they are part of how pm works in practice.
- `handoffs/*.md` — session handoff notes; the activity timeline lists them by filename/mtime.
- `pm/activity.json`, `pm/sessions.json` — generated by a harvester pass; never hand-edited.
- `pm/session-index.json` — user-owned map of Claude Code session id → project.
- `pm/relay/<id>.spec.json` / `<id>.job.json` — one unattended run's brief and live
  status, written by the relay; pruned after 14 days.

Session transcripts are read from `~/.claude/projects/<escaped-PM_ROOT>/*.jsonl`.

### How the files relate

`state/<slug>.md` is the one-glance status (what's happening now, what's next), the
`backlog/<slug>.md` is the full task list, and `rules/<slug>.md` is what a session must
know before touching the project. The board edits the first two; launched sessions read
all three and write back to state + backlog when they finish, which is what makes the
board a live view instead of a copy. `state` `## Next` and backlog `## Todo` overlap on
purpose — state stays the short authoritative line, and no divergence check is done.

## Contributing / keeping the docs in sync

[`CLAUDE.md`](CLAUDE.md) at the repo root is the guide for Claude Code sessions working
*on* pm (commands, invariants, conventions); keep it free of machine-specific paths. When
you change behavior — a route, a backlog/state format rule, a launch/relay flag, a UI
control — update in the same change: this README's matching section, `CLAUDE.md` if an
invariant moved, and the tests. Format changes must keep the byte-identical round-trip
tests passing.

This project grew inside one specific workspace and is tuned to its conventions;
treat it as a personal tool / reference implementation rather than a turnkey product.

## Security

The server binds `0.0.0.0` (so a phone on the same LAN can reach it) and is
**unauthenticated by default**. Set `PM_TOKEN` if that matters on your network.

## License

MIT — see [LICENSE](LICENSE).
