# claude-pm-board

One pane over every project in your workspace: status, backlog, and activity, rendered
from plain Markdown files. **The files are the database** — no SQLite, no server DB.

A mobile-first web app (Express + Vite/React), optionally wrapped in a standalone macOS
desktop app. It can also hand batches of todos to [Claude Code](https://claude.com/claude-code)
and let them run unattended.

> Personal tool that grew inside one workspace. Treat it as a reference implementation
> rather than a turnkey product.

## Features

- **Project board** — one card per project with status, open-task count, last activity,
  and a blocked marker. Hide projects with the Filter; light/dark theme.
- **Status** — a short "Now / Next / Last failure / Blockers" note per project (max 40 lines).
- **Backlog** — Doing / Todo / Blocked / Done, with priorities (`p1`–`p3`), notes, and
  moving tasks between projects.
- **Build with Claude** — ▶ on a task opens a terminal running a seeded Claude Code session.
- **Run @seq** — flag todos, then run the whole batch as one orchestrated session that
  fans out to subagents. Runs unattended by default and survives rate limits.
- **Latest todos** — a cross-project list on Home; run any selection in one go.
- **Ideas inbox** — capture a one-liner; ▶ researches it and can promote it to a project.
- **Sessions inbox** — Claude Code conversations harvested from disk; file them to a
  project, turn one into a task, or reopen it.
- **Usage** — token burn rate, rate-limit ceiling, and estimated cost by day and model.

## Quick start

Requires **Node ≥ 20**.

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
| `scripts/start.sh` | Same, but Ctrl+C reliably stops both |
| `npm test` | Unit and integration tests |
| `npm run build` | Build `web/dist` |
| `npm run verify` | Boots against a throwaway workspace and smoke-tests it. Needs the author's outer workspace scripts, so it won't run in a bare clone |
| `npm run app` | **macOS only** — build and run the Electron desktop shell |
| `npm run app:dmg` | **macOS only** — package `release/PM-<ver>.dmg` |

### Platform support

| | macOS | Windows / Linux |
|---|---|---|
| Web app, API, `npm test` | ✅ | ✅ (`npm run verify` needs bash — WSL or Git Bash) |
| Desktop shell (Electron) | ✅ | ❌ not implemented |
| ▶ / Run @seq / reopen session | ✅ via `osascript` (iTerm or Terminal) | ❌ not implemented |
| Unattended relay | ✅ (uses `caffeinate`) | ❌ not implemented |

## How it works

Everything lives under `$PM_ROOT/.claude/`:

| Path | Purpose |
|---|---|
| `state/<slug>.md` | One-glance status, ≤ 40 lines. The API rejects edits past the cap (HTTP 422) |
| `backlog/<slug>.md` | Task list. `## Doing/Todo/Blocked/Done` sections, one `- ` bullet per task |
| `rules/<slug>.md` | Constraints a launched session reads first. Not rendered by the board |
| `handoffs/*.md` | Session handoff notes, shown in the activity timeline |
| `pm/activity.json`, `pm/sessions.json` | Generated — never hand-edit |
| `pm/session-index.json` | Your map of session id → project |
| `pm/relay/` | Live status of unattended runs (pruned after 14 days) |

`ideas.md` in `backlog/` is the pinned Ideas inbox. Session transcripts are read from
`~/.claude/projects/<escaped-PM_ROOT>/*.jsonl`.

The board edits state and backlog; launched sessions read all three files and write
back to state and backlog when done. That is what keeps the board live rather than a copy.

### Backlog format

```md
## Todo
- Add CSV export to the reports page  @seq  p1
- Write onboarding doc  p2
  needs a screenshot of the new flow

## Done
- Fix flaky harvester test  p1  (2026-09-03)
```

Trailing order is `<title>  @seq  p<n>  (date)`. An indented line is the task's note.
Task ids are positional and shift after any write.

## Running Claude Code from the board

Launch buttons work only from the same machine, or with a valid `PM_TOKEN` (see
[Configuration](#configuration)). pm never calls an LLM itself — it only seeds terminal
sessions.

### Single task (▶)

Opens a fresh `claude` session with that task's title and note, told to read
`rules/<slug>.md` and `state/<slug>.md` first, then update the backlog when finished.

### Batches (▶▶ Run @seq)

1. Tap **@seq** on the todos you want in the batch.
2. Tap **▶▶ Run @seq (N)** next to the Backlog heading. With nothing flagged it reads
   **▶▶ Run all (N)** and runs every Todo + Doing task instead.
3. One orchestrator session starts in the project directory. It orders the batch by
   dependency, fans independent todos out to parallel subagents, and paces itself against
   your burn rate. Finished todos move to **Done** and you watch them land on the board.

Home's **Latest todos** panel does the same across projects: tick todos (or none for all
listed) and press **▶▶ Run selected**.

### Unattended relay (macOS only)

Batch runs go through a relay unless you untick **Unattended**. It runs the orchestrator
headless (`claude -p`, `acceptEdits`, `Bash(git *)` denied) and:

- on a rate-limit rejection — or 5-hour usage ≥ 95% / 7-day ≥ 97% — sleeps until the
  reset (+90 s), then resumes the same session;
- decides what's left by re-reading the backlog and matching todos **by title**, and
  nudges a stalled agent a few times before reporting **stalled**;
- shows progress as a strip on Home (running / waiting / done / stalled / failed), with
  ✕ to dismiss finished rows;
- edits backlog and state through one allowlisted helper, `server/backlog-cli.mjs`,
  because headless Claude Code cannot edit anything under `.claude/`. So an unattended
  run can't hand-edit `rules/*.md` or promote ideas — use the interactive path for those.

Keep the Mac plugged in with the lid open. Ctrl-C in the relay terminal stops it.
Tunables (env): `PM_RELAY_STOP_5H` (0.95), `PM_RELAY_STOP_7D` (0.97),
`PM_RELAY_BUFFER_MS` (90000), `PM_RELAY_TICK_MS` (30000), `PM_RELAY_MAX_LIMIT_HITS` (30),
`PM_RELAY_NOTIFY=0` to silence notifications.

## Other views

### Ideas inbox

The 💡 box on Home drops a one-liner into `backlog/ideas.md`. On the Ideas project,
▶ and ▶▶ behave differently: they triage the idea — business concept → `venturemind`;
otherwise `prospector` checks whether to adopt an existing tool or build.

- **Adopt** — stops; verdict and report path are noted on the idea.
- **Build / Adopt + extend** — continues into `atelier`. ▶ researches and promotes the idea
  to a project (state + backlog, no code). ▶▶ also scaffolds `PM_ROOT/<slug>/` and builds.

Use ▸ to move an idea to an existing project by hand.

### Sessions inbox

Lists Claude Code conversations harvested from disk (raw title, first message, touched
files — nothing LLM-summarized). Per row: **file** to a project, **→ task** to create a
`resume: …` todo, **reopen** (`claude --resume`), or **archive**. A project page shows
its own filed sessions.

### Usage

Parses `~/.claude/projects/**/*.jsonl` directly, so it needs nothing else running:
rolling 1h / 5h / 7d token totals, rate-limit ceiling from
`~/.claude/vscode-claude-status-cache.json` (flagged stale after ~15 min), a 14-day
chart, and per-model totals. Cost is an estimate from `web/src/pricing.js`, not a bill.

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
| `PM_TOKEN` | unset | Shared secret for launch routes (`?token=` or `x-pm-token`). Needed to launch from a phone |
| `PM_RELAY_*` | see above | Unattended relay tunables (macOS only) |
| `CONTINUOUS_ROOT` | `$PM_ROOT/continuous` | Location of the optional runner |

## Security

The server binds `0.0.0.0` so a phone on your LAN can reach it, and is
**unauthenticated by default**. Launch routes accept only loopback clients or a valid
`PM_TOKEN`. Set `PM_TOKEN` if the network isn't trusted.

## Contributing

[`CLAUDE.md`](CLAUDE.md) lists the commands and invariants for anyone (or any Claude Code
session) editing pm. When behavior changes, update this README, `CLAUDE.md` if an
invariant moved, and the tests in the same change. Backlog/state format changes must keep
the byte-identical round-trip tests passing.

## License

MIT — see [LICENSE](LICENSE).
