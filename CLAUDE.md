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
  Unknown `##` sections are preserved, not dropped. `backlog-cli.mjs` stays add/move/list/create (+ `state now|resume|next`):
  `create <slug> "<descriptor>" …` writes a NEW project's state+backlog+rules stub (create-only, refuses an existing slug);
  no delete/rename; `add` rejects duplicate exact titles; `move` is exact-title only.
  `compact <slug> candidates|apply <plan.json>` (`server/compact.mjs`) is the one rewording path: only
  Done items older than 7 days, all-or-nothing validation, written through `writeBacklog` so the
  originals are archived. Driven by `skills/compact-done/SKILL.md` (shipped + `asarUnpack`ed) via
  the launch-guarded `POST /api/projects/:slug/compact-done`.
- **Every project is created with a descriptor** (`server/descriptor.mjs`): the rules-file H1 `# <slug>/ — <descriptor>`,
  max 40 chars, is the card title. `POST /api/projects`, `POST /api/sessions/:id/new-project` and CLI `create` all require it
  (400 / throw before anything is written). Existing rules files are never overwritten. `adhoc` = no project dir, nothing else.
- **Task ids are positional**, shift after any write. Match by title when it must be stable.
- **No LLM calls from pm.** It only seeds terminal Claude Code sessions (`server/launch.mjs`, Terminal.app only).
  The binary comes from `server/setup.mjs` (`pm/prefs.json`, user-owned; `PUT /api/setup` is launch-guarded and
  only accepts a path `findClaudes()` detected). On Apple Silicon every claude/relay launch is prefixed
  `arch -arm64` (`ARCH`) so a Rosetta shell can't pick the wrong native package.
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
  List and single-project payloads carry `hasStart` + `running` for the shared `web/src/StartButton.jsx` (Home cards, project page).
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
  **Handoff near a limit** (`server/relay.mjs`, `PM_RELAY_HANDOFF=0` off, `PM_RELAY_HANDOFF_5H` 0.90, `PM_RELAY_HANDOFF_7D` 0.95):
  SIGINT, one short `--resume` turn asking for plain text, saved to `.claude/pm/relay/<id>.handoff.md` (mechanical
  fallback from job state if rejected or empty). After the reset it starts a FRESH session (`freshPrompt`: brief +
  handoff + open todos), never `--resume` (a resume after a 5h reset re-reads the whole context uncached). `job.json`
  gains `handoff` and `mode:"fresh"`. The old stop + `--resume` path remains for plain rejection and when handoff is off.
  Not live-tested against real claude.
- **Fill** (`server/fill.mjs`): pm still reads no usage itself beyond rate-limit numbers Claude Code
  emits — relay runs write `.claude/pm/limits.json` (`saveLimits`), the user's statusline may write
  `~/.claude/rate-limits.json`. Only todos the user marked auto (`.claude/pm/auto-todos.json`, keyed by
  title, user-owned; `ideas` allowed too, run headless with bookkeeping only via `backlog-cli`) or open todos of an auto project (`auto-projects.json`, `[slug]`,
  re-read every pass) ever run; settings in `.claude/pm/fill.json`. Launches only via
  `launchRelayDetached` with `spec.fill.stop7d`; the relay ends such a job `filled`. All three write routes +
  `POST /api/fill/run` are `canLaunch`-guarded. The timer never launches while any relay job is live.
  A Fill now refused for quota (`decision.wait`) sets `fill.json` `pending` (route 202): the timer then
  decides as if manual (ignores enabled + idle, still respects quota) and clears it on launch. Windows
  roll to 0% past their reset; a reading with no reset time rolls once it is a whole period old.
- **Portability**: no `/Users/<name>` (or other machine-specific) paths in shipped source
  or docs. `PM_ROOT` defaults to `process.cwd()`; the Electron shell passes its own default.
- macOS-only pieces (osascript terminal launch, Electron shell, `caffeinate`) must be
  labelled as macOS-only in the README, with the Windows/Linux story stated.

- **Security audit** (`POST /api/projects/:slug/security-audit`, `seedForSecurityAudit`)
  is a seed prompt like the others — launch-guarded, pm runs no scanner itself.
  `SECURITY_NOTE` and `PORT_NOTE` (read the workspace port registry, no literal path) are appended
  to non-ideas build prompts. `TOOL_NOTE` (tool names are case-sensitive: `Bash`, not `bash`) is
  appended to the task, sequential and cross-project seeds and to the relay's `QUIET_NOTE`.

- **Status line builder** (`server/statusline.mjs`, `web/src/StatusLine.jsx` in Setup, `/api/statusline*`, all three
  `canLaunch`-guarded): writes only `~/.claude/statusline/statusline.sh` (+ copies `usage.py`) and `statusLine` in
  `~/.claude/settings.json` (`PM_CLAUDE_DIR` overrides `~/.claude`; tests set it). Segments are a fixed catalog; the only
  user text in the script is the separator, single-quoted. settings.json is switched only when there is no status line
  or on explicit `apply`; the replaced value is kept in the pm dir's `statusline.json` `previous` for restore. Files pm
  replaces get a `.bak-<ts>` copy (a script without the `# pm-statusline` marker, settings.json).
- **Interactive limit hook** (`hooks/limit-handoff.mjs`, `server/limit-hook.mjs`, `web/src/LimitHook.jsx`, GET/PUT `/api/limit-hook`, `canLaunch`-guarded; PUT `{on:boolean}` else 400): UserPromptSubmit + PostToolUse read `~/.claude/rate-limits.json` (`PM_RATE_LIMITS_FILE`) and emit additionalContext once per session+window at the relay thresholds. It writes only its own `hooks` entries in `~/.claude/settings.json` (`PM_CLAUDE_DIR`), `.bak-<ts>` first; uninstall removes only entries naming `limit-handoff.mjs`. `hooks/**` is in package.json files + asarUnpack. Needs the statusline saving rate limits. Not browser-checked, not live-tested.
- **Home usage strip** (`server/home-strip.mjs`, `web/src/UsageStrip.jsx`): `GET /api/home-strip` is unguarded; `PUT` is `canLaunch`-guarded and validates segment ids (known, no dups, else 400). Prefs live in the pm dir's `home-strip.json`; `/api/usage` is unchanged.
- **Claude config review** (`server/claude-config.mjs`, `web/src/ClaudeConfig.jsx` in Setup): `GET /api/claude-config` is `canLaunch`-guarded and read-only. `?id=` previews only inventory ids; realpath must stay inside `~/.claude` or `PM_ROOT` (escaping symlink 403, unknown/traversal 400/404). Secrets are redacted; env shows names only.

- **One SSE stream for all tabs** (`onStream` in `web/src/api.js`, Web Lock leader + BroadcastChannel).
  Never open an `EventSource` per component: a few tabs exhaust the browser's 6 connections per
  origin and every request hangs.

## Conventions

- **Docs move with the code.** Any behavior change updates, in the same change: the
  matching `README.md` or `docs/guide.md` section, this file if an invariant changed, and tests.
- UI: keep the existing token system in `web/src/app.css` (spacing/radius/shadow/ease
  variables, hover/active/focus-visible states with transitions, light + dark themes).
  New controls must look and feel like the existing ones.
- **Appearance** (`web/src/appearance-core.mjs` pure, `Appearance.jsx` sheet, `appearance.css`, applied from `main.jsx`):
  browser-only localStorage `pm.appearance`, non-defaults only. Never store it on the server.
- **README stays skimmable**: pitch → features → quick start → how it works → config,
  short sections and tables, no route/function dumps. Per-feature detail goes in `docs/guide.md`, internals here or in the rules file.
- No comment noise; add one line only where the *why* is non-obvious.
- **Never run a branch operation without asking first** — no `git checkout -b`/`switch`/
  `branch`/`stash`/`reset`/`rebase`/`merge`, even to "get off `main`". Work on whatever
  branch is checked out; if a commit is wanted and it's on `main`, ask. Commit only when asked.
