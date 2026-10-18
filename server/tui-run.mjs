// Actions behind the TUI's "run" and "stop" keys. Titles are re-resolved against the
// CURRENT backlog (ids are positional, and the file may have changed since the screen
// was drawn); only open Todo/Doing tasks of a non-`ideas` project can be launched.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { PM_ROOT } from "./paths.mjs";
import { readBacklog } from "./backlog.mjs";
import { seedForSequentialRun, launchRelayDetached } from "./launch.mjs";
import { stopRelay } from "./relay.mjs";

const SLUG_RE = /^[a-z0-9][a-z0-9_-]*$/;
export const MAX_RUN = 20;

export async function runTodos(slug, titles, { launch = launchRelayDetached, root = PM_ROOT } = {}) {
  if (!SLUG_RE.test(slug)) throw new Error("bad slug");
  if (slug === "ideas") throw new Error("ideas are not run from here");
  if (!Array.isArray(titles) || !titles.length) throw new Error("no todos");
  if (titles.length > MAX_RUN) throw new Error(`too many todos (max ${MAX_RUN})`);
  const bl = await readBacklog(slug);
  const open = (bl?.tasks || []).filter((t) => t.state === "Todo" || t.state === "Doing");
  const tasks = titles.map((title) => open.find((t) => t.title === title));
  if (tasks.some((t) => !t)) throw new Error("a selected todo changed or is no longer open — reload");
  const dir = join(root, slug);
  const prompt = seedForSequentialRun({ slug, tasks, adhoc: !existsSync(dir), mode: "all", relay: true });
  const r = await launch({
    cwd: dir,
    prompt,
    label: `${slug} (${tasks.length})`,
    tasks: tasks.map((t) => ({ slug, title: t.title })),
  });
  return `started job ${r.job} — ${tasks.length} todo(s); watch with r`;
}

export async function stopJob(id, { stop = stopRelay, root = PM_ROOT } = {}) {
  return stop(root, id) ? `stop signal sent to ${id}` : "could not stop (not running, or pid is not a relay)";
}
