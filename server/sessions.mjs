// Sessions inbox: merge the harvester's sessions.json (generated) with
// session-index.json (user filing overrides, written here).
import { readFile, writeFile } from "node:fs/promises";
import { SESSIONS_FILE, SESSION_INDEX_FILE } from "./paths.mjs";
import { readBacklog, writeBacklog, emptyBacklog } from "./backlog.mjs";
import { scaffoldProject } from "./scaffold.mjs";

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return fallback;
    throw e;
  }
}

export async function readIndex() {
  return readJson(SESSION_INDEX_FILE, {});
}
async function writeIndex(idx) {
  await writeFile(SESSION_INDEX_FILE, JSON.stringify(idx, null, 2) + "\n");
}

export async function readSessions() {
  const [gen, idx] = await Promise.all([readJson(SESSIONS_FILE, []), readIndex()]);
  return gen.map((s) => {
    const o = idx[s.id] || {};
    return {
      ...s,
      project: o.project ?? s.guess ?? null,
      filed: !!o.project,
      archived: !!o.archived,
      taskCreated: !!o.taskCreated,
    };
  });
}

export async function listSessions() {
  const all = await readSessions();
  return {
    inbox: all.filter((s) => !s.filed && !s.archived),
    filed: all.filter((s) => s.filed && !s.archived),
  };
}

export async function sessionsFor(slug) {
  return (await readSessions()).filter((s) => s.filed && !s.archived && s.project === slug);
}

export async function fileSession(id, { project, archived } = {}) {
  const idx = await readIndex();
  const cur = { ...(idx[id] || {}) };
  if (project !== undefined) cur.project = project || undefined;
  if (archived !== undefined) cur.archived = archived ? true : undefined;
  for (const k of Object.keys(cur)) if (cur[k] === undefined) delete cur[k];
  if (Object.keys(cur).length) idx[id] = cur;
  else delete idx[id];
  await writeIndex(idx);
}

export async function sessionToTask(id, project) {
  const sess = (await readJson(SESSIONS_FILE, [])).find((s) => s.id === id);
  if (!sess) throw new Error("no such session");
  const bl = (await readBacklog(project)) || emptyBacklog(project);
  const snippet = (sess.firstAsk || sess.title || "").replace(/\s+/g, " ").trim().slice(0, 140);
  bl.tasks.push({
    state: "Todo",
    title: `resume: ${sess.title}`.slice(0, 120),
    priority: null,
    note: `${snippet}\nsession ${id}`,
    done: null,
  });
  await writeBacklog(project, bl);
  const idx = await readIndex();
  idx[id] = { ...(idx[id] || {}), project, taskCreated: true };
  await writeIndex(idx);
}

// Scaffold a brand-new project, file the session to it, and seed a Todo from the session.
export async function sessionToNewProject(id, name) {
  const sess = (await readJson(SESSIONS_FILE, [])).find((s) => s.id === id);
  if (!sess) throw new Error("no such session");
  const slug = await scaffoldProject(name, { title: sess.title });
  await sessionToTask(id, slug);
  return slug;
}

export async function moveTask(fromSlug, id, toSlug) {
  if (fromSlug === toSlug) return;
  const from = await readBacklog(fromSlug);
  const t = from && from.tasks.find((x) => x.id === Number(id));
  if (!t) throw new Error("no such task");
  from.tasks = from.tasks.filter((x) => x.id !== Number(id));
  const to = (await readBacklog(toSlug)) || emptyBacklog(toSlug);
  to.tasks.push({
    state: "Todo",
    title: t.title,
    priority: t.priority ?? null,
    note: t.note ?? null,
    done: null,
  });
  await writeBacklog(fromSlug, from);
  await writeBacklog(toSlug, to);
}
