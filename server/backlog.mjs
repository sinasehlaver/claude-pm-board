// Parse / serialize .claude/backlog/<slug>.md — the richer task list that doesn't
// fit the 40-line state cap. Sections are states; one "- " bullet per task; an
// optional trailing "@seq" flag (part of the "Run @seq" orchestrator run), an
// optional trailing "p1|p2|p3", an optional trailing "(YYYY-MM-DD)" on done items,
// and an indented line is the preceding task's note. Canonical trailing order is
// "<title>  @seq  p<n>  (date)" — serialize emits it in that order, the parser
// strips it in reverse (date, priority, @seq).
import { readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { BACKLOG_DIR } from "./paths.mjs";

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
  for (const state of STATES) {
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

// Which tasks "Run" launches. Any non-Done @seq-flagged task => only those
// (mode "seq", an explicit selection — Blocked included if the user flagged it).
// Otherwise every Todo + Doing task (mode "all"; Blocked and Done are skipped).
// The web client mirrors this in Project.jsx to label the button — keep in sync.
export function runnableTasks(tasks) {
  const seq = tasks.filter((t) => t.seq && t.state !== "Done");
  if (seq.length) return { mode: "seq", tasks: seq };
  return { mode: "all", tasks: tasks.filter((t) => t.state === "Todo" || t.state === "Doing") };
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

export async function writeBacklog(slug, b) {
  const text = serializeBacklog({ ...b, slug }, { refreshDate: true });
  await writeFile(join(BACKLOG_DIR, `${slug}.md`), text);
  return text;
}
