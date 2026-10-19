# claude-pm-board

One pane over every project in your workspace: status, backlog, and activity, rendered
from plain Markdown files. **The files are the database** — no SQLite, no server DB.

A mobile-first web app (Express + Vite/React), optionally wrapped in a standalone macOS
desktop app. It can also hand batches of todos to [Claude Code](https://claude.com/claude-code)
and let them run unattended.

> Personal tool that grew inside one workspace. Treat it as a reference implementation
> rather than a turnkey product.

## Features

- **Project board** — one card per project with a one-line description (the first paragraph of the project's `README.md`),
  status, open-task count, last activity, and a blocked marker. Search, sort (recent by default and remembered / blocked first / stalest / A–Z) and Filter; Ideas is a slim pill above the list, outside the sort; a
  "stale" badge after 7 idle days; a color per project (swatches on the project page, stored in
  your browser); light/dark theme. Two tabs: **Projects** (tool entries from
  `entries.json` sit in a collapsed "tools" group) and **Tools** (Env Manager, Ports, Changes). Sessions and Doctor
  are under **Help**.
- **Side pane** — set `PM_SELF_SLUG=<project>` and a floating button opens that project
  (e.g. the board's own todos) in a right-hand pane next to whatever you are doing.
- **Status** — a short "Now / Next / Last failure / Blockers" note per project (max 50 lines), plus an optional **Resume** block (where to pick it back up).
- **Backlog** — Doing / Todo / Blocked / Done, with notes, and moving tasks between projects.
  Each todo has a checkbox to pick it for a batch.
- **Build with Claude** — ▶ on a task opens a terminal running a seeded Claude Code session.
  ▶ **start** on a project card runs that project's `start.sh` (when it has one).
- **Run selected / Run all** — tick todos, then run the batch as one orchestrated session that
  fans out to subagents. Runs unattended by default and survives rate limits.
- **Latest todos** — a cross-project list on Home; tick any selection and run it in one go.
- **Ideas inbox** — capture a one-liner; ▶ researches it and can promote it to a project.
- **Sessions inbox** — Claude Code conversations harvested from disk; file them to a
  project, turn one into a task, or reopen it.
- **Usage strip** — Home shows estimated Claude Code spend (5h block / today / 7d, USD), the same numbers the statusline shows; `npm run tui` shows it in its footer.

## Quick start

One command, no questions asked (macOS; re-runnable):

```sh
scripts/setup.sh
```

It checks Node ≥ 20 (installs it with Homebrew if missing), runs `npm ci`, builds the web app,
creates `$PM_ROOT/.claude/{state,backlog,rules,handoffs,pm}`, installs [`claude-config/`](claude-config/README.md),
then starts the board on <http://127.0.0.1:4500> and opens it. It never overwrites a file of yours; any
settings file it changes is copied to `<file>.bak-<timestamp>` first. What it installs from `claude-config/`:

| Where | What | Rule |
|---|---|---|
| `~/.claude/statusline/` | spend status line | `statusLine` in `~/.claude/settings.json` is added only if you have none |
| `$PM_ROOT/.claude/hooks/`, `skills/` | ask-via-AskUserQuestion reminder, destructive-command guard, `handoff`, `retro` | copied only if missing |
| `$PM_ROOT/.claude/settings.local.json` | the two hooks, with absolute paths | merged, no duplicates |

Not installed because they contain placeholders to fill in: `claude-config/CLAUDE.md`, `rules/`, `memory/`.

Optional (macOS, needs `sudo`): lock the guard that stops Claude editing board files by installing it as a
managed hook Claude sessions cannot edit: `sudo claude-config/managed/install.sh`
([details](claude-config/README.md#tamper-proof-guard-managed-settings-macos)).
Options: `--no-claude-config` (skip the install), `--no-start` (set up only), `PM_ROOT=<dir>` (pick the workspace).

Manual route:

```sh
npm install
npm run dev      # API on :4500, web on :4501
npm test         # node:test, no external deps
```

Point it at a workspace with `PM_ROOT` (defaults to the parent of this directory):

```sh
PM_ROOT=~/Projects npm run dev
```

| Command | What it does |
|---|---|
| `npm run dev` | Server `:4500` + Vite `:4501` (proxies `/api`) |
| `scripts/setup.sh` | Everything: deps, build, workspace folders, claude-config, start, open browser |
| `scripts/start.sh` | Same as `npm run dev`, but checks the ports first and Ctrl+C reliably stops both |
| `npm test` | Unit and integration tests |
| `npm run build` | Build `web/dist` |
| `npm run verify` | Boots against a throwaway workspace and smoke-tests it. The browser step runs only when the author's outer workspace has `.claude/scripts/browser.mjs`; otherwise it is skipped |
| `npm run app` | **macOS only** — build and run the Electron desktop shell. **⧉ button by the theme toggle** or View → Hover mode (`⌘⇧H`) makes it a compact always-on-top board that follows you across spaces; `⌘⌥P` shows/hides it from anywhere |
| `npm run app:dmg` | **macOS only** — package `release/PM-<ver>.dmg` |

**Hover in the browser:** the ⧉ button next to the theme toggle opens pm's own project page (see `PM_SELF_SLUG`) in a floating always-on-top window (Chrome/Edge Picture-in-Picture; other browsers get a plain small popup). The desktop shell's ⧉ pins the app window itself.

### Platform support

| | macOS | Windows / Linux |
|---|---|---|
| Web app, API, `npm test` | ✅ | ✅ (`npm run verify` needs bash — WSL or Git Bash) |
| Desktop shell (Electron) | ✅ | ❌ not implemented |
| ▶ / Run selected / reopen session | ✅ via `osascript` (iTerm or Terminal) | ❌ not implemented |
| Unattended relay | ✅ (uses `caffeinate`) | ❌ not implemented |

### Terminal colors

Board launches (▶, Run selected, Continue, Doctor fix) open a window with your terminal's **default
profile** — iTerm2 if `/Applications/iTerm.app` exists, else Terminal.app — so colors come from that
profile, not from the board.

- **Truecolor**: iTerm2 and Terminal.app both render 24-bit color. Check with
  `echo $COLORTERM` (expect `truecolor`); if empty, add `export COLORTERM=truecolor` to `~/.zshrc`.
- **Theme**: pick light or dark inside Claude Code with `/theme`, and match the terminal profile
  (iTerm2 → Settings → Profiles → Colors → Color Presets; Terminal.app → Settings → Profiles).
- **Per-project tint**: the swatch you pick on a project page (or its automatic hue) tints the
  background of terminal windows launched from that page (▶, Run selected, Continue, Security audit,
  reopen session) to a dark shade of that color (about 14% brightness), so windows of different
  projects are easy to tell apart. Pick "default" to keep the hue derived from the slug. The tint is
  set on the window through AppleScript (`set background color`), so it overrides the profile's
  background for that window only. A window launched without a tint is set to black (`#000000`)
  in both iTerm2 and Terminal.app. The unattended relay runs headless and is not tinted. If your
  `~/.zshrc` wraps `claude` and repaints the background, remove that wrapper's color line or it will win.
- **`scripts/setup.sh`** only prints this advice. It never modifies your terminal profiles.
- **Turning color off or forcing it**: `NO_COLOR=1` disables ANSI color in most CLIs; `FORCE_COLOR=1`
  forces it when output is piped. The board never sets either.
- **Status line**: `claude-config/statusline/` prints plain text (no escape codes), so it follows your theme.

## How it works

Everything lives under `$PM_ROOT/.claude/`:

| Path | Purpose |
|---|---|
| `state/<slug>.md` | One-glance status, ≤ 50 lines and 4000 chars. The API rejects edits past either cap (HTTP 422) |
| `backlog/<slug>.md` | Task list. `## Doing/Todo/Blocked/Done` sections, one `- ` bullet per task |
| `rules/<slug>.md` | Constraints a launched session reads first. Not rendered by the board. A rules file alone does not make a project (it needs a state or backlog file) |
| `entries.json` | Optional. Tracks tools that live outside `PM_ROOT/<slug>`: `{"<slug>": {"kind": "tool", "path": "<relative to PM_ROOT>"}}`. Launches and `open` use that folder (a file path means its parent folder); `GET /api/projects?kind=tool\|all` lists them, the default list shows projects only |
| `handoffs/*.md` | Session handoff notes, shown in the activity timeline |
| `pm/activity.json`, `pm/sessions.json`, `pm/doctor.json` | Generated — never hand-edit |
| `pm/session-index.json` | Your map of session id → project |
| `pm/relay/` | Live status of unattended runs (pruned after 14 days) |

`ideas.md` in `backlog/` is the pinned Ideas inbox. Session transcripts are read from
`~/.claude/projects/<escaped-PM_ROOT>/*.jsonl`.

**Nothing is hard-deleted.** Removing a todo (or any write that drops one, e.g. a full
overwrite) appends it to `backlog-archive/<slug>.md` (same bullet format plus a
`<!-- removed: date from: State -->` line); each project page has an "Archived" list with
Restore (back to Todo). Every backlog write also keeps a snapshot of the previous file in
`backlog-archive/.snapshots/<slug>.<timestamp>.md` (last 20 per project).
`GET /api/projects/:slug/archive`, `POST /api/projects/:slug/archive/restore {title}`.
`backlog-cli.mjs` is add/move/list only: `list <slug> [state]` is read-only, `add` refuses a
duplicate exact title, `move` matches the exact title and never renames.

The board edits state and backlog; launched sessions read all three files and write
back to state and backlog when done. That is what keeps the board live rather than a copy.

### Backlog format

```md
## Todo
- Add CSV export to the reports page
- Write onboarding doc
  needs a screenshot of the new flow

## Done
- Fix flaky harvester test  (2026-09-03)
```

Trailing order is `<title>  @seq  p<n>  (date)`. An indented line is the task's note. The board
no longer shows or sets the `@seq` and `p<n>` suffixes, but older files keep them as written.
Task ids are positional and shift after any write.

### Resume block

Optional last section of `.claude/state/<slug>.md`: where to pick the project back up. Written
only when a field is set, so state files without it are unchanged.

```md
## Resume
Last result: 42/50 pass, $1.84 total (baseline $2.31)
Re-run: python -m evals.run --variant b --n 50
Branch/variant: f-skill-cost / opus5
Artifacts: reports/R03.md, nb/ab.ipynb
```

- Shown on the project page under "Where you left off" (with a copy button on Re-run); project
  cards show the last result and the first Next item.
- Launched sessions are told to read it first and to update it when they finish. Unattended runs
  can't edit `.claude/`, so they use
  `node server/backlog-cli.mjs state <slug> resume <last-result|re-run|branch|artifacts> "<value>"`.
- The same CLI's `add <slug> "<title>" ["note"]` takes an optional indented note.
- State files are snapshots, not logs: `serializeState` caps them at 50 lines and 4000 chars.

### Open buttons

`POST /api/open {path, slug?}` opens a file in its default Mac app (`open`). The path (absolute, or
relative to `PM_ROOT` / the slug's folder) must resolve — symlinks followed — inside `PM_ROOT` and be a
pdf/xlsx/xls/csv/ipynb/html/md/txt/json/docx/pptx/image; anything else is 4xx (400 type, 403 outside,
404 missing). Loopback or `PM_TOKEN` only; `PM_LAUNCH_DRYRUN=1` answers without opening. In the UI every
such path in a todo note, the Resume block (last result, artifacts), the newest-handoff line and the
handoff rows of the timeline gets an `open` button (`web/src/PathText.jsx`).

## Running Claude Code from the board

Launch buttons work only from the same machine, or with a valid `PM_TOKEN` (see
[Configuration](#configuration)). pm never calls an LLM itself — it only seeds terminal
sessions.

Launched sessions (terminal and relay) get `--settings <PM_ROOT>/.claude/settings.json` (else
`settings.local.json`) so workspace hooks and env load even when the session's cwd is a project
subfolder. Hook commands in that file must use absolute paths (`$CLAUDE_PROJECT_DIR` didn't resolve
from a subfolder when this was added).

### Continue (▶ on "Where you left off")

Opens an interactive session that reads rules + state + Resume, summarises in a few lines, and
waits for your go. It never runs the Re-run command on its own (evals can hit paid APIs).

### Single task (▶)

Opens a fresh `claude` session with that task's title and note, told to read
`rules/<slug>.md` and `state/<slug>.md` first, then update the backlog when finished.

### Security audit (🛡)

Each project page has a **Security audit** button (macOS-only, like the other launch
buttons). It opens a `claude` session running the workspace `security-guard` skill: a
static review against a catalogue of common breach classes, security tests written into
the project's own suite, a report in `knowledge/security/<slug>.md`, and one backlog todo
per confirmed finding. No live probing. Build prompts also carry a one-line
secure-by-default reminder and a port note: pick dev-server ports from a local port
registry (`.claude/ports.md`, if your workspace has one) so projects don't collide.
They also point new web UIs at a workspace `_webapp-defaults.md` rule and `_starter/` kit
(theme, collapsible lists/panels, undo/redo, save/open file, …); both are optional files in
your workspace, and the note does nothing without them.

### Batches (▶▶ Run selected / Run all)

1. Tick the checkbox on the todos you want in the batch.
2. Tap **▶▶ Run selected (N)** next to the Backlog heading. With nothing ticked it reads
   **▶▶ Run all (N)** and runs every Todo + Doing task instead.
3. One orchestrator session starts in the project directory. It orders the batch by
   dependency and fans independent todos out to parallel subagents (≤3 at a time).
   Finished todos move to **Done** and you watch them land on the board.

Home's **Latest todos** panel does the same across projects: tick todos (or none for all
listed) and press **▶▶ Run selected**.

### Unattended relay (macOS only)

Batch runs go through a relay unless you untick **Unattended**. It runs the orchestrator
headless (`claude -p`, `acceptEdits`, `Bash(git *)` denied) and:

- on a rate-limit rejection — or 5-hour usage ≥ 95% / 7-day ≥ 97% — sleeps until the
  reset (+90 s), then resumes the same session;
- decides what's left by re-reading the backlog and matching todos **by title**, and
  nudges a stalled agent a few times before reporting **stalled**;
- shows the agent's latest actions (file read/edited, command, subagent task) on the running row;
- shows progress as a strip on Home (running / waiting / done / stalled / failed), with
  ✕ to dismiss finished rows;
- edits backlog and state through one allowlisted helper, `server/backlog-cli.mjs`,
  because headless Claude Code cannot edit anything under `.claude/`. So an unattended
  run can't hand-edit `rules/*.md` or promote ideas — use the interactive path for those.
- starts lean: no MCP servers, no skill list unless a todo mentions a skill (`--strict-mcp-config --disable-slash-commands`,
  first turn ~14k tokens instead of ~23k), and a system-prompt line asking for no
  narration and a ≤8-line final report.

Every launch (relay and interactive) passes `--settings $PM_ROOT/.claude/settings.json`
when that file exists, so the workspace hooks and env apply even though the session runs
in a project folder. Hook commands in that file need absolute paths — `$CLAUDE_PROJECT_DIR`
is the project folder there.

Keep the Mac plugged in with the lid open. Ctrl-C in the relay terminal stops it.
Tunables (env): `PM_RELAY_STOP_5H` (0.95), `PM_RELAY_STOP_7D` (0.97),
`PM_RELAY_BUFFER_MS` (90000), `PM_RELAY_TICK_MS` (30000), `PM_RELAY_MAX_LIMIT_HITS` (30),
`PM_RELAY_NOTIFY=0` to silence notifications.

## Other views

### Ideas inbox

The 💡 box on Home drops a one-liner into `backlog/ideas.md`. On the Ideas project,
▶ and ▶▶ first check whether the idea asks for research or brainstorming ("find me ideas for…", "how do X do Y")
rather than naming something to build. If so they write a findings doc to `knowledge/research/<slug>.md`,
note it on the idea, and stop — nothing is promoted or built. Otherwise they triage the idea — business concept → `venturemind`;
otherwise `prospector` checks whether to adopt an existing tool or build.

- **Adopt** — stops; verdict and report path are noted on the idea.
- **Build / Adopt + extend** — continues into `atelier`. Prospector states a provisional *form*
  and atelier confirms it: a **project**, a **tool** (single-purpose, about one session; still a
  full project, plus an `entries.json` row so it sits in the Projects tab's "tools" group), or a
  **pm feature** (a part of pm itself — no project, one todo in pm's backlog). ▶ researches and
  promotes the idea (state + backlog, no code). ▶▶ also scaffolds `PM_ROOT/<slug>/` and builds.

Todos written by Claude read like todos you'd write: one per checkpoint ("Build block A, tell
me how to test it, and wait for me to test it"), not one per internal phase. The phase list lives
in the plan and the project's state `Next`.

Use ▸ to move an idea to an existing project by hand.

### Sessions inbox

Lists Claude Code conversations harvested from disk (raw title, first message, touched
files — nothing LLM-summarized). Per row: **file** to a project, **→ task** to create a
`resume: …` todo, **reopen** (`claude --resume`), or **archive**. A project page shows
its own filed sessions.

### Usage

The Home strip and TUI footer show estimated spend computed like the Claude Code statusline's
`usage.py`: the current 5h block, today and the last 7 days (local time, like ccusage), from
`~/.claude/projects/**/*.jsonl` incl. subagents (deduped by message id). Cost is an estimate from the `PRICING`
table in `server/statusline-usage.mjs` (USD per million tokens) — edit it when rates change,
and it's not a bill. There is no rate-limit-percentage view; `GET /api/usage` returns the figures.

### Tokens per todo

Todos launched from pm (▶, Run selected / Run all, Home cross-project run, unattended relay)
show a small `1.2M tok` badge with the tokens their session spent (subagents included).
pm tags each seed prompt with a `pm-run: <id>` line and later matches it in the
transcripts. A batch's total is split evenly across its todos (shown as `~`, an
estimate). Totals live in the generated `.claude/pm/task-tokens.json` and are matched
by title, so renaming a todo starts a new count. Sessions not launched by pm, or started
before this feature, are not counted.

### Doctor

Home → **Doctor**. A no-LLM scan of this workspace's Claude Code transcripts
(`~/.claude/projects/<escaped PM_ROOT>*`, subagents included) that reports where errors
happened (failed/repeated tool calls, permission denials, API/rate-limit errors), what
burned the most tokens (top sessions and tools, whole-file Reads, cache-miss turns, subagent
fan-out, long sessions never compacted), and a suggested fix per finding (CLAUDE.md rule,
memory, settings allowlist, …). Suggestions only — the scan never edits anything.

Each finding has a **💬 Fix with Claude** button: it opens a terminal Claude Code session
seeded with the finding, which investigates read-only, then interviews you with
`AskUserQuestion` about root cause and fix options before changing anything. Same launch
guard as the other build buttons (loopback or `PM_TOKEN`); macOS terminal launch (see above).
With 2+ open findings, **💬 Fix all N with Claude** does the same for every open finding in
one session. That's cheaper than one session per finding, since each new session re-pays its startup context.

pm can't see how that session ends, so the finding is tracked by you: launching marks it
**in progress**, then **✓ Mark done**, **Dismiss**, or **Reopen**. A finding still in progress
or done that a later scan no longer reports is dropped from the tracker (confirmed fixed);
dismissed ones stay until reopened. Stored in `.claude/pm/doctor-status.json`.

In-progress and done findings show a **Fix** note field (what you changed) and a
**✓ Verify fix** button. Verify rescans only sessions written *after* the fix was recorded:
*not seen since the fix*, *still happening*, or *no sessions since* (nothing to judge yet).

Runs every `PM_DOCTOR_INTERVAL_MIN` minutes (default 360, `0` = off) and on **Scan now**;
result cached in `.claude/pm/doctor.json`. `PM_DOCTOR_DAYS` (default 14) sets the window.

### Env Manager

Home → **Envs**. `server/envs.mjs` scans `PM_ROOT` for live `.env`, `.env.local|test|development|production|staging`
files (depth ≤ 5; skips `archive/`, `node_modules`, venvs, `.bak`/`.cpgz` and `*.example`) and groups
variables by name with masked values (last 4 characters). Each variable is a collapsed row with a
checkbox per file (default all). Paste a new value and **Update N files**: a dry-run list, a confirm,
then that variable is rewritten in the checked files (quotes, `export` and trailing comments kept)
after each changed file is copied to `<file>.bak-<ts>`.

API: `GET /api/envs`, `POST /api/envs/update {name, value, files?, dryRun?}`. Both are loopback or
`PM_TOKEN` only; values are never returned unmasked or logged. Tests: `server/envs.test.mjs`.

### Ports

Home → Tools → **Ports**. Lists every TCP port something on this Mac is listening on (port, process, the project
it runs from, PID, bound address) via `lsof`; filter box and Refresh. **Stop** asks for a confirmation, then sends `SIGTERM`.
Only your own processes can be stopped, never the board itself, and the server re-checks that the PID still
listens on that port before signalling. macOS/Linux with `lsof`; no Windows support.

API: `GET /api/ports`, `POST /api/ports/kill {pid, port}`, both loopback or `PM_TOKEN` only. Tests: `server/ports.test.mjs`.

### Changes

Home → Tools → **Changes**, or the floating **Changes** button in Home's top-left corner (it becomes **‹ Back** on the Changes page). Every git repo directly under the workspace, with its uncommitted edits, in a collapsible left panel:
each repo is its own collapsible section (files, commit box, push). Pick a file and its diff opens side by side in the wide centre area. Like VS Code's source control, **Keep** stages a file or a single hunk, **Unkeep**
unstages it (**Keep all** / **Keep tracked** do a whole repo; tracked skips new untracked files), **Discard** reverts it (after a confirmation; the discarded patch is saved under `.claude/pm/discarded/`,
last 50 kept). Then write a message and **Commit** the kept edits (leave the message empty and the button becomes **Amend (no edit)**: the kept files join the last commit, message unchanged; pm never force-pushes, so amending a pushed commit needs a terminal), and **Push** (confirmation first; if git rejects it, the full error shows in a selectable box with **Copy**; a branch without
upstream is pushed with `-u` when there is exactly one remote). The panel has a search box and the same **Filter** list as the Home page (shared hide list). Folders that aren't git repos yet sit in a collapsed "Not git repos" group with a **git init** button (asks first; it adds `.git` plus a starter `.gitignore` if there is none: node_modules, venvs, `.env`, …). Each repo row shows ↑ahead ↓behind before its change counts, with **↻** (re-check local changes), **F** (fetch) and **P** (pull); **Fetch all** (top bar) and F update the ↓ behind count, since pm only knows what the last fetch saw; P is `git pull --ff-only`, so a diverged branch or conflicting local edits abort with nothing changed. Plain `git` only, no Claude involved. Untracked files are
kept or discarded whole; binary files show no hunks. Needs `git` on PATH.

API: `GET /api/changes[/:slug[/diff]]`, `POST /api/changes/:slug/{apply,stage-all,commit,push,fetch,pull,init}`, all loopback or
`PM_TOKEN` only. Tests: `server/changes.test.mjs`.

### Continuous (optional)

If a `continuous/` project sits next to `pm/`, a **Continuous** tab shows and controls its
runner (start/stop, budget, activity, config). pm only reads its state files; without
`continuous/` the tab shows an explainer.

## Configuration

All optional, via environment variables:

| Var | Default | Purpose |
|---|---|---|
| `PM_ROOT` | parent of this package | Workspace root that owns `.claude/` |
| `PM_PORT` / `PORT` | `4500` | Server port |
| `PM_HOST` | `127.0.0.1` | Bind address; non-loopback needs `PM_TOKEN` unless it's a Tailscale `100.x` IP |
| `PM_TOKEN` | unset | Shared secret for the API (`?token=` or `x-pm-token`) and launch routes |
| `PM_DOCTOR_INTERVAL_MIN` / `PM_DOCTOR_DAYS` | `360` / `14` | Doctor scan period (0 = off) and look-back window |
| `PM_RELAY_*` | see above | Unattended relay tunables (macOS only) |
| `CONTINUOUS_ROOT` | `$PM_ROOT/continuous` | Location of the optional runner |
| `PM_SELF_SLUG` | unset | Project shown in the right-hand side pane and opened by the ⧉ hover button, and left out of the card list. Defaults to `pm` when that project exists |

## From your phone (Tailscale + Termius)

Run the board's keyboard UI over SSH — nothing is exposed, no port is opened.

1. On the Mac that holds your workspace: install [Tailscale](https://tailscale.com), enable
   **Remote Login** (macOS: System Settings → General → Sharing; Windows/Linux: run an
   OpenSSH server). Keep the machine awake (macOS: `caffeinate -s`, or Energy settings).
2. On the phone: Tailscale app signed into the same tailnet, then in Termius add a host
   with the Mac's Tailscale name/IP and your usual SSH user (key auth recommended).
3. Connect and run:

```sh
cd path/to/pm && PM_ROOT=path/to/workspace npm run tui
```

| Key | Action |
|---|---|
| `↑↓` / `j k` | move |
| `enter` / `→` / `l` | open project |
| `a` | add a todo (type, `enter`; `esc` cancels) |
| `m` then `1-4` | move task to Doing / Todo / Blocked / Done |
| `d` | show / hide Done |
| `space` | mark / unmark a todo (`◆`) |
| `x`, then `y` | run the marked todos (or the highlighted one) as one unattended Claude job |
| `r` | jobs: status, age, todos left, latest actions; `s` then `y` stops one |
| `←` / `h` / `b` / `esc`, `q` | back, quit |

The line above the footer shows your Claude spend for the current 5h block, today and the last 7 days
(same figures as the Usage strip on Home and the statusline).

It reads and writes the same Markdown files as the web app (per-todo token counts included)
and refreshes every few seconds. Todos owned by a live job show `⟳ running` (or `⏸ waiting`
for a rate-limit pause) in the project view, and `⟳N` in the project list. Runs start as a
background relay job on the Mac (no terminal window; `claude` must be on the PATH of your SSH
shell). Sessions you open by hand in a terminal aren't tracked — only relay jobs are.

To use the **web UI** from the phone instead, bind to the Mac's Tailscale address:
`PM_HOST=100.x.y.z npm start` (after `npm run build`), then open `http://100.x.y.z:4500`.

## Security

The server binds **`127.0.0.1` by default**. `PM_HOST` may be a Tailscale address
(`100.64.0.0/10`, the tailnet authenticates the peer) or, with `PM_TOKEN` set, any other
interface — otherwise it refuses to start. Launch routes accept only loopback clients or a
valid `PM_TOKEN`. Don't put `tailscale serve`/a reverse proxy in front without `PM_TOKEN`:
the proxy connects from loopback, which counts as trusted for launch routes. The web UI
doesn't send a token, so with `PM_TOKEN` set use the TUI or API clients.

## Contributing

[`CLAUDE.md`](CLAUDE.md) lists the commands and invariants for anyone (or any Claude Code
session) editing pm. When behavior changes, update this README, `CLAUDE.md` if an
invariant moved, and the tests in the same change. Backlog/state format changes must keep
the byte-identical round-trip tests passing.

## License

MIT — see [LICENSE](LICENSE).
