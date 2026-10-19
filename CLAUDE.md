# CLAUDE.md — pm (claude-pm-board)

Cross-project PM board: mobile-first web app + Express API over plain Markdown files.
**The files are the database** — no SQLite. Node ESM, Vite/React, optional Electron shell.
User-facing behavior is documented in `README.md`; this file is what a session needs
before editing the code.

## Commands

```
npm install
npm run dev      # server :4500 + vite :4501
npm test         # node:test, server/*.test.mjs — the check that works in a bare clone
npm run build    # web/dist (verify serves dist: rebuild before verifying UI changes)
npm run verify   # temp fixture workspace + browser check; needs a browser-check helper
                 # from an optional parent workspace, so skip it in a bare clone
```

## Invariants — don't break these

- **`pm/` has no `.claude/` of its own.** `.claude/` (state, backlog, rules) lives in the
  workspace that contains `pm/` (`$PM_ROOT/.claude/`), not inside `pm/` itself.

- **Source of truth is `$PM_ROOT/.claude/`**: `state/<slug>.md` (hard 40-line + 4000-char cap —
  `serializeState` throws past it; don't loosen it), `backlog/<slug>.md` (sections =
  Doing/Todo/Blocked/Done, one `- ` bullet per task, indented line = note),
  `rules/<slug>.md` (read by launched sessions, not rendered). `pm/task-runs.json` and
  `pm/task-tokens.json` (per-todo tokens, keyed slug -> title) are generated too;
  the backlog line format is NOT extended for tokens. `pm/activity.json` and
  `pm/sessions.json` and `pm/doctor.json` (server/doctor.mjs, suggestions-only, no LLM)
  are generated — never hand-edit. `pm/session-index.json` is user-owned.
- **Parsers round-trip canonical input byte-identically** (`server/backlog.mjs`,
  `server/state.mjs`); tests enforce it. Canonical trailing order on a backlog line:
  `<title>  @seq  p<n>  (date)`.
- **Never hard-delete a todo.** `writeBacklog` (server/backlog.mjs) diffs the file on disk
  against what it will write and appends every dropped title to
  `$PM_ROOT/.claude/backlog-archive/<slug>.md`, and snapshots the previous file to
  `backlog-archive/.snapshots/` (keep 20/slug). Don't write backlog files any other way.
  Unknown `##` sections are preserved, not dropped. `backlog-cli.mjs` stays add/move/list/create:
  `create <slug> …` writes a NEW project's state+backlog (create-only, refuses an existing slug);
  no delete/rename; `add` rejects duplicate exact titles; `move` is exact-title only.
- **Task ids are positional**, shift after any write. Match by title when it must be stable.
- **No LLM calls from pm.** It only seeds terminal Claude Code sessions (`server/launch.mjs`).
  Prompt text goes through a temp file / spec file, **never** interpolated into a shell command.
- **Bind is loopback by default** (`server/bind.mjs`): `PM_HOST` non-loopback needs
  `PM_TOKEN` unless it's a Tailscale `100.64/10` address; server exits otherwise. Never
  restore a blanket `0.0.0.0`. Token compares are timing-safe.
- **`npm run tui`** (`server/tui.mjs` + pure `tui-core.mjs`) is the phone path (SSH via
  Tailscale/Termius): opens no port, edits backlog only through `backlog-cli.mjs`
  (`addTask`/`moveTask`), sanitizes titles and strips control chars from all rendered text. `x` runs via
  `tui-run.mjs` -> `launchRelayDetached` (argv spawn, prompt only via spec file; titles
  re-resolved against the live backlog, `ideas` refused, max 20); `s` stops a job through
  `stopRelay` (job-id regex + pid must be alive AND a `relay-cli` process).
- **Changes tool** (`server/changes.mjs`) runs plain git (argv, stdin message) on repos under `PM_ROOT`, no Claude. Files/hunks must
  match live `git status`/`diff`; Discard saves a patch to `.claude/pm/discarded/` first. Don't add branch ops or force-push.
- **Launch routes are guarded**: loopback client or valid `PM_TOKEN`. Everything else is
  unauthenticated by design (meant for a trusted LAN or loopback). `POST /api/projects/:slug/start`
  is one of them: it runs only the fixed `./start.sh` in the project dir, and only when `start.sh`
  is a regular file whose realpath stays inside that dir (`startScript` in `projects.mjs`).
  `projects` payload carries `hasStart` for the Home ▶ start button.
- **Run selected** (`POST …/tasks/run-seq`) takes optional `titles`: exact titles among Todo/Doing.
  Unknown → 409 `{unknown}`; malformed or over 200 → 400; empty/absent = all. `runnableTasks(tasks, titles)`
  is the single selector.
- **Never write to a real `.claude/` in tests.** Tests and `verify` set `PM_ROOT` to a temp
  dir before importing anything from `server/paths.mjs`.
- **Unattended relay** (`server/relay.mjs`): headless `claude -p`. Edit/Write under
  `.claude/**` is hard-blocked there, so agents change backlog/state only via
  `server/backlog-cli.mjs` (the single allowlisted command). `Bash(git *)` stays denied;
  don't switch to `bypassPermissions`. Todos are matched **by title** — never rename one.
  Relay args also carry `--strict-mcp-config --append-system-prompt QUIET_NOTE` (+ `TOOL_NOTE`), plus
  `--disable-slash-commands` unless the prompt mentions "skill"; relay and `launchClaude` add `--settings $PM_ROOT/.claude/settings.json` when it
  exists (a project-dir cwd doesn't load it otherwise).
- **Portability**: no `/Users/<name>` (or other machine-specific) paths in shipped source
  or docs. `PM_ROOT` defaults to `process.cwd()`; the Electron shell passes its own default.
- macOS-only pieces (osascript terminal launch, Electron shell, `caffeinate`) must be
  labelled as macOS-only in the README, with the Windows/Linux story stated.

- **Security audit** (`POST /api/projects/:slug/security-audit`, `seedForSecurityAudit`)
  is a seed prompt like the others — launch-guarded, pm runs no scanner itself.
  `SECURITY_NOTE` and `PORT_NOTE` (read the workspace port registry, no literal path) are appended
  to non-ideas build prompts. `TOOL_NOTE` (tool names are case-sensitive: `Bash`, not `bash`) is
  appended to the task, sequential and cross-project seeds and to the relay's `QUIET_NOTE`.

## Conventions

- **Docs move with the code.** Any behavior change updates, in the same change: the
  matching `README.md` section, this file if an invariant changed, and tests.
- UI: keep the existing token system in `web/src/app.css` (spacing/radius/shadow/ease
  variables, hover/active/focus-visible states with transitions, light + dark themes).
  New controls must look and feel like the existing ones.
- **README stays skimmable**: pitch → features → quick start → how it works → config,
  short sections and tables, no route/function dumps. Internals go here or in the rules file.
- No comment noise; add one line only where the *why* is non-obvious.
- **Never run a branch operation without asking first** — no `git checkout -b`/`switch`/
  `branch`/`stash`/`reset`/`rebase`/`merge`, even to "get off `main`". Work on whatever
  branch is checked out; if a commit is wanted and it's on `main`, ask. Commit only when asked.
