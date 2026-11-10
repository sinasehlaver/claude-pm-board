# claude-pm-board

A local board for running Claude Code across many projects, kept in plain Markdown files that you and your agents both read and write.

Once you have a dozen projects and short Claude Code sessions, the real status of each one ends up
in your head or in old transcripts. pm keeps it in small files next to your code: what's happening,
what's next, and where to pick up. You see every project on one page. When you start work from the
board, the session is told to read those files first and update them before it stops, so the next
session, or you a week later, doesn't start from zero.

> A personal tool that grew inside one workspace, shared as a working reference rather than a
> polished product. Launching sessions is macOS-only for now.

## Features

**See where everything stands**

- **One page, every project:** status, open todos, last activity, stale and blocked markers.
- **Status and Resume notes:** a short, size-capped note per project, including the exact command to re-run.
- **Backlog:** Doing, Todo, Blocked and Done in Markdown; a removed todo is archived, never lost.
- **Usage:** Claude Code spend and rate limits on Home, tokens per todo, and a status line builder.

**Hand work to Claude Code** (macOS)

- **▶ on a todo:** opens a terminal with a Claude Code session already briefed on that task.
- **Run selected:** one session works through the todos you ticked, using subagents.
- **Unattended runs:** headless batches that hand off near a limit and continue in a fresh session after the reset.
- **Fill unused quota:** todos (and ideas) you mark "auto" run while you're away, up to today's share of your weekly limit.
- **Handoff before the limit (opt-in):** a Setup card that tells an open session to write a handoff before a usage limit.

**Look after the workspace**

- **Doctor:** scans your transcripts for wasteful patterns and suggests fixes; it never calls an LLM.
- **Sessions inbox:** finds past conversations on disk so you can file them, turn them into todos or reopen them.
- **Tools:** Changes (commit and discard by hunk), Ports, Env Manager, Ideas inbox and a ⌘K palette.
- **Optional macOS app:** an Electron shell with a compact always-on-top hover mode.

**From your phone:** `npm run tui` is a keyboard UI you use over SSH (for example Tailscale and
Termius). It can add and move todos, and start or stop unattended runs, without opening a port.

## Quick start

You need Node 20 or newer and, to launch sessions, [Claude Code](https://claude.com/claude-code).

macOS, one command that you can safely re-run:

```sh
scripts/setup.sh
```

It installs dependencies, builds the app, creates the workspace folders, installs the optional
[Claude Code config](claude-config/README.md), then opens <http://127.0.0.1:4500>. It never
overwrites your files, and any settings file it changes is backed up first.

Any platform, by hand:

```sh
npm install
PM_ROOT=~/Projects npm run dev    # API on :4500, web on :4501
```

| | macOS | Windows / Linux |
|---|---|---|
| Board, API, TUI editing, tests | ✅ | ✅ |
| Launching sessions, unattended runs | ✅ | ❌ not implemented |
| Desktop shell | ✅ | ❌ not implemented |

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Runs the server and Vite with live reload |
| `scripts/start.sh` | Same, but checks the ports first and stops cleanly on Ctrl+C |
| `npm test` | Runs the unit and integration tests |
| `npm run build` | Builds `web/dist` |
| `npm run verify` | Smoke-tests against a throwaway workspace |
| `npm run tui` | Opens the keyboard UI for SSH |
| `npm run app` | Runs the desktop shell (macOS only) |

## Configuration

All optional. The full list is in the [guide](docs/guide.md#configuration).

| Variable | Default | Purpose |
|---|---|---|
| `PM_ROOT` | parent of this folder | Workspace that owns `.claude/` |
| `PM_PORT` | `4500` | Server port |
| `PM_HOST` | `127.0.0.1` | Bind address; non-loopback needs `PM_TOKEN` unless it's a Tailscale address |
| `PM_TOKEN` | unset | Shared secret for the API and launch routes |

## How it works

There is no database. Everything lives in `$PM_ROOT/.claude/`, and the server only watches and edits these files:

| File | Holds | Read by |
|---|---|---|
| `state/<slug>.md` | Now, Next, Blockers, Resume (max 4000 chars) | You and launched sessions |
| `backlog/<slug>.md` | Todos by status | You and launched sessions |
| `rules/<slug>.md` | Constraints and gotchas for that project | Launched sessions |

```
board ──▶ you press ▶ ──▶ Claude Code: read state + rules, do the task
  ▲                                         │
  └───────── state and backlog updated ◀────┘
```

**pm calls no LLM and adds nothing to Claude Code by itself.** The handoff comes from the prompt pm
launches a session with. A `claude` you start by hand won't read these files unless your `CLAUDE.md`
tells it to, so add that line if you work that way. [`claude-config/`](claude-config/README.md) has
a template, plus optional hooks and `handoff` and `retro` skills.

Details on every feature are in the **[guide](docs/guide.md)**.

## Security

The server binds to `127.0.0.1` by default and refuses a wider bind without `PM_TOKEN`, unless the
address is on Tailscale. Launch routes only accept loopback clients or a valid token. Everything
else is unauthenticated by design, so don't expose it to a network you don't trust. See the
[guide](docs/guide.md#security) before putting a proxy in front.

## Contributing

[`CLAUDE.md`](CLAUDE.md) lists the commands and invariants for anyone, or any Claude Code session,
editing pm. When behaviour changes, update the docs and tests in the same change.

## License

MIT, see [LICENSE](LICENSE).
