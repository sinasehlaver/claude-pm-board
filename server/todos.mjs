// Cross-project todo helpers: the Home "Latest todos" list + resolving a
// cross-project run selection against the CURRENT backlog files.
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { BACKLOG_DIR } from "./paths.mjs";
import { listBacklogSlugs, readBacklog } from "./backlog.mjs";

// Ideas have their own promotion flow (Run @seq on the Ideas card), so they are
// never part of the cross-project list or run.
export const CROSS_EXCLUDED = new Set(["ideas"]);

export const isOpen = (t) => t.state === "Todo" || t.state === "Doing";

// The backlog format stores no created-at date, so "newest added" is a proxy:
// backlog files ordered by mtime (newest first), tasks inside a file last-in-file
// first (the add route appends to the end of Todo).
export async function latestTodos({ limit = 30 } = {}) {
  const cap = Math.max(1, Math.min(Number(limit) || 30, 200));
  const files = [];
  for (const slug of await listBacklogSlugs()) {
    if (CROSS_EXCLUDED.has(slug)) continue;
    let mtime = 0;
    try {
      mtime = (await stat(join(BACKLOG_DIR, `${slug}.md`))).mtimeMs;
    } catch {}
    files.push({ slug, mtime });
  }
  files.sort((a, b) => b.mtime - a.mtime || a.slug.localeCompare(b.slug));
  const out = [];
  for (const { slug } of files) {
    const bl = await readBacklog(slug);
    if (!bl) continue;
    for (const t of bl.tasks.filter(isOpen).reverse()) {
      out.push({
        slug,
        id: t.id,
        title: t.title,
        note: t.note,
        seq: t.seq,
        priority: t.priority,
        state: t.state,
      });
      if (out.length >= cap) return out;
    }
  }
  return out;
}

// Resolve client-sent [{slug,id,title?}] against the backlog as it is NOW.
// Ids are positional and shift after any write, so an item is only accepted when
// its id still points at an open (Todo/Doing) task — and, when the client sent a
// title, at that same title. Otherwise it is reported stale (route => 409, the
// client refreshes and retries); we never guess by title alone.
// Ideas items are dropped (see CROSS_EXCLUDED) and reported as `skipped`.
export async function resolveCrossItems(items) {
  const tasks = [];
  const stale = [];
  const skipped = [];
  const seen = new Set();
  const cache = new Map();
  for (const it of items) {
    const { slug, id, title } = it;
    if (CROSS_EXCLUDED.has(slug)) {
      skipped.push(it);
      continue;
    }
    const key = `${slug}#${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!cache.has(slug)) cache.set(slug, await readBacklog(slug));
    const bl = cache.get(slug);
    const t = bl && bl.tasks.find((x) => x.id === Number(id));
    if (!t || !isOpen(t) || (title !== undefined && title !== t.title)) {
      stale.push(it);
      continue;
    }
    tasks.push({ slug, title: t.title, note: t.note });
  }
  return { tasks, stale, skipped };
}
