// Parse / serialize .claude/backlog/<slug>.md — the richer task list that doesn't
// fit the 50-line state cap. Sections are states; one "- " bullet per task; an
// optional trailing "@seq" flag (part of the "Run @seq" orchestrator run), an
// optional trailing "p1|p2|p3", an optional trailing "(YYYY-MM-DD)" on done items,
// and an indented line is the preceding task's note. Canonical trailing order is
// "<title>  @seq  p<n>  (date)" — serialize emits it in that order, the parser
// strips it in reverse (date, priority, @seq).
import { readFile, writeFile, readdir, mkdir, appendFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { BACKLOG_DIR, BACKLOG_ARCHIVE_DIR } from "./paths.mjs";

export const STATES = ["Doing", "Todo", "Blocked", "Done"];

function parseTaskLine(rest) {
  let title = rest;
  let priority = null;
  let done = null;
  const dm = title.match(/\s*\((\d{4}-\d{2}-\d{2})\)\s*$/);
  if (dm) {
    done = dm[1];
    title = title.slice(0, dm.index);
  }
  const pm = title.match(/\s+p([123])\s*$/);
  if (pm) {
    priority = Number(pm[1]);
    title = title.slice(0, pm.index);
  }
  let seq = false;
  const qm = title.match(/\s+@seq\s*$/);
  if (qm) {
    seq = true;
    title = title.slice(0, qm.index);
  }
  return { title: title.trim(), priority, done, seq };
}

export function parseBacklog(text, slug) {
  const updM = text.match(/^Updated:\s*(.+?)\s*$/m);
  const tasks = [];
  let section = null;
  let cur = null;
  let id = 0;
  for (const line of text.split("\n")) {
    const sm = line.match(/^##\s+(.+?)\s*$/);
    if (sm) {
      section = sm[1];
      cur = null;
      continue;
    }
    const bm = line.match(/^-\s+(.*)$/);
    if (bm && section) {
      cur = { id: id++, state: section, note: null, ...parseTaskLine(bm[1]) };
      tasks.push(cur);
      continue;
    }
    const nm = line.match(/^\s{2,}(\S.*)$/);
    if (nm && cur) cur.note = cur.note ? `${cur.note}\n${nm[1]}` : nm[1];
  }
  return { slug, updated: updM ? updM[1] : "", tasks };
}

export function serializeBacklog(b, { refreshDate = false } = {}) {
  const updated = refreshDate ? new Date().toISOString().slice(0, 10) : b.updated;
  const out = [`# ${b.slug} — backlog`, `Updated: ${updated}`, ""];
  // Unknown section names are kept (after the known ones), never silently dropped.
  const extra = [...new Set(b.tasks.map((t) => t.state))].filter((s) => !STATES.includes(s));
  for (const state of [...STATES, ...extra]) {
    const rows = b.tasks.filter((t) => t.state === state);
    if (!rows.length) continue;
    out.push(`## ${state}`);
    for (const t of rows) {
      let line = `- ${t.title}`;
      if (t.seq) line += `  @seq`;
      if (t.priority) line += `  p${t.priority}`;
      if (t.done) line += `  (${t.done})`;
      out.push(line);
      if (t.note) for (const nl of t.note.split("\n")) out.push(`  ${nl}`);
    }
    out.push("");
  }
  return out.join("\n");
}

export const MAX_RUN_TITLES = 200;

// Which tasks "Run" launches. `titles` (the UI's ticked rows) => exactly those
// open (Todo/Doing) tasks, matched by exact title (mode "selected"); any title that
// isn't a live open task lands in `unknown` (route answers 409). No titles => every
// Todo + Doing task (mode "all"; Blocked and Done skipped). The legacy @seq flag is
// no longer consulted. Throws on a malformed `titles`.
export function runnableTasks(tasks, titles) {
  const open = tasks.filter((t) => t.state === "Todo" || t.state === "Doing");
  if (titles === undefined || titles === null) return { mode: "all", tasks: open, unknown: [] };
  if (!Array.isArray(titles) || titles.length > MAX_RUN_TITLES || titles.some((x) => typeof x !== "string"))
    throw Object.assign(new Error("titles must be an array of strings (max " + MAX_RUN_TITLES + ")"), { status: 400 });
  if (!titles.length) return { mode: "all", tasks: open, unknown: [] };
  const want = new Set(titles);
  const picked = open.filter((t) => want.has(t.title));
  const have = new Set(picked.map((t) => t.title));
  return { mode: "selected", tasks: picked, unknown: [...want].filter((x) => !have.has(x)) };
}

export function emptyBacklog(slug) {
  return { slug, updated: new Date().toISOString().slice(0, 10), tasks: [] };
}

export async function listBacklogSlugs() {
  try {
    return (await readdir(BACKLOG_DIR))
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.slice(0, -3));
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
}

export async function readBacklog(slug) {
  try {
    return parseBacklog(
      await readFile(join(BACKLOG_DIR, `${slug}.md`), "utf8"),
      slug,
    );
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

// --- never hard-delete -------------------------------------------------
// Removed tasks are appended to backlog-archive/<slug>.md (same bullet format, plus a
// trailing marker line with the removal date + original state). Every writeBacklog also
// snapshots the previous file under backlog-archive/.snapshots (last SNAPSHOT_KEEP kept).
export const SNAPSHOT_KEEP = 20;
const MARK = /^\s*<!-- removed: (\d{4}-\d{2}-\d{2}) from: (.*?) -->\s*$/;
const archivePath = (slug) => join(BACKLOG_ARCHIVE_DIR, `${slug}.md`);
const snapDir = () => join(BACKLOG_ARCHIVE_DIR, ".snapshots");

function archiveBlock(t) {
  const lines = serializeBacklog({ slug: "x", updated: "", tasks: [{ ...t, state: "Archived" }] })
    .split("\n")
    .slice(4); // header, Updated, blank, "## Archived"
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  lines.push(`  <!-- removed: ${new Date().toISOString().slice(0, 10)} from: ${t.state} -->`);
  return lines.join("\n") + "\n";
}

export async function archiveTasks(slug, tasks) {
  if (!tasks.length) return;
  await mkdir(BACKLOG_ARCHIVE_DIR, { recursive: true });
  let head = "";
  try {
    await readFile(archivePath(slug));
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    head = `# ${slug} — archive\nRemoved tasks; restore from the board.\n\n## Archived\n`;
  }
  await appendFile(archivePath(slug), head + tasks.map(archiveBlock).join(""));
}

export async function readArchive(slug) {
  let text;
  try {
    text = await readFile(archivePath(slug), "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
  return parseBacklog(text, slug).tasks.map((t, i) => {
    const lines = (t.note || "").split("\n");
    const mk = lines.length ? lines[lines.length - 1].match(MARK) : null;
    if (mk) lines.pop();
    return { ...t, id: i, note: lines.join("\n") || null, removed: mk ? mk[1] : null, from: mk ? mk[2] : null };
  });
}

// Move the newest archived task with this exact title back to Todo.
export async function restoreTask(slug, title) {
  const items = await readArchive(slug);
  const idx = items.map((t) => t.title).lastIndexOf(title);
  if (idx < 0) throw new Error("no such archived task");
  const bl = (await readBacklog(slug)) || emptyBacklog(slug);
  if (bl.tasks.some((t) => t.title === title)) throw new Error("title already in backlog");
  const { priority, seq, note } = items[idx];
  bl.tasks.push({ title, state: "Todo", priority, seq, note, done: null });
  await writeBacklog(slug, bl);
  const rest = items.filter((_, i) => i !== idx);
  const head = `# ${slug} — archive\nRemoved tasks; restore from the board.\n\n## Archived\n`;
  await writeFile(
    archivePath(slug),
    head + rest.map((t) => archiveBlock({ ...t, state: t.from || "Todo" }).replace(/removed: \S+/, `removed: ${t.removed || "unknown"}`)).join(""),
  );
}

async function snapshot(slug, prev) {
  const dir = snapDir();
  await mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  for (let n = 0; ; n++) {
    const name = `${slug}.${stamp}${n ? `-${n}` : ""}.md`;
    try {
      await writeFile(join(dir, name), prev, { flag: "wx" });
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
  }
  const mine = (await readdir(dir)).filter((f) => f.startsWith(`${slug}.2`) && f.endsWith(".md")).sort();
  for (const f of mine.slice(0, Math.max(0, mine.length - SNAPSHOT_KEEP))) await unlink(join(dir, f));
}

export async function writeBacklog(slug, b) {
  const text = serializeBacklog({ ...b, slug }, { refreshDate: true });
  let prev = null;
  try {
    prev = await readFile(join(BACKLOG_DIR, `${slug}.md`), "utf8");
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  if (prev !== null) {
    // Diff what is on disk against what will be on disk (reparsed, so anything the
    // serializer would lose counts as dropped): a title missing, or fewer copies, is archived.
    const left = new Map();
    for (const t of parseBacklog(text, slug).tasks) left.set(t.title, (left.get(t.title) || 0) + 1);
    const dropped = [];
    for (const t of parseBacklog(prev, slug).tasks) {
      const n = left.get(t.title) || 0;
      if (n > 0) left.set(t.title, n - 1);
      else dropped.push(t);
    }
    await archiveTasks(slug, dropped);
    if (prev !== text) await snapshot(slug, prev);
  }
  await writeFile(join(BACKLOG_DIR, `${slug}.md`), text);
  return text;
}
