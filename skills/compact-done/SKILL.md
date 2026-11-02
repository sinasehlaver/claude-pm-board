---
name: compact-done
description: Merge a project's old Done backlog items into fewer, shorter ones by theme. Proposes first, applies only after the user's OK; originals go to the backlog archive. Launched by pm's "Compact" button on a project page.
---

# compact-done

Old Done items are often long, wordy notes about how something shipped. Sessions that read
the backlog pay for every word. This skill groups them by theme into a few short Done items.
Nothing is lost: pm's `writeBacklog` moves every replaced original to
`backlog-archive/<slug>.md` (the project page's Archived list, restorable) and snapshots the file.

The seed prompt gives you the slug and the absolute path of `backlog-cli.mjs` (`CLI` below).
Run it from the workspace root (the directory that contains `.claude/`).

## Steps

1. **List candidates.** `node CLI compact <slug> candidates` prints JSON `[{title, done, note}]`:
   the Done items finished more than 7 days ago (undated ones count as old). Items from the last
   7 days are not eligible and the CLI rejects them, so don't propose them. If the list has fewer than 4
   items, say so and stop.
2. **Group by theme.** Put related work in one group, e.g. "Relay: headless runs, auto-resume,
   stop button". Aim for roughly a quarter as many items as you started with. Unrelated one-offs may stay as
   single-item groups only if you shorten them; otherwise leave them out of the plan.
3. **Write each merged item.** Title: ≤ ~80 chars, outcome first, plain words, no file paths, no
   phase ids, no dates. Note (optional): one line, ≤200 chars, only what a future reader needs
   (a gotcha, a decision). Drop "how it was verified" detail.
4. **Show the proposal.** A table per group: new title (+ note) ← the original titles. Then the
   totals: Done items before → after, and the approximate characters saved.
5. **Ask for the OK** with `AskUserQuestion` (Apply / Change something / Cancel). On "change",
   revise and show it again. Never apply without an explicit OK.
6. **Apply.** Write the plan as JSON to the session scratch dir (not under `.claude/`):
   `[{"title": "...", "note": "...", "from": ["exact original title", ...]}, ...]`, then run
   `node CLI compact <slug> apply <that file>`. It validates everything and refuses the whole plan on
   any error. Read the error, fix the plan, and rerun.
7. **Report** the CLI's one-line result, and say that the originals are in the project page's Archived list.

## Gotchas

- `from` titles must match the candidates' `title` field exactly (copy them, don't retype).
  Each original may be used once.
- Only old Done items. Todo/Doing/Blocked and recent Done items are off-limits; the CLI enforces it.
- Never edit the backlog file directly: always go through `compact … apply`, which archives the originals.
- A merged title must not equal any other task's title.
- One backlog-cli call per Bash command; keep `.claude/` out of the plan file's path (workspace hooks
  block Bash writes that mention pm-owned paths).
- Merged items lose their per-todo token badges (pm's token sidecar is keyed by title). The originals'
  counts stay in the sidecar.
- Restoring an archived original from the board puts it back as a Todo, next to the merged item.
