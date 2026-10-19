import express from "express";
import { existsSync, watch, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PM_ROOT, CLAUDE, STATE_DIR, BACKLOG_DIR } from "./paths.mjs";
import { listProjects, getProject, discoverSlugs, startScript } from "./projects.mjs";
import { KINDS, entryDir } from "./entries.mjs";
import { readState, writeState } from "./state.mjs";
import { readBacklog, writeBacklog, emptyBacklog, runnableTasks, readArchive, restoreTask } from "./backlog.mjs";
import { listSessions, fileSession, sessionToTask, sessionToNewProject, moveTask } from "./sessions.mjs";
import { seedForTask, seedForSequentialRun, seedForCrossProjectRun, seedForContinue, seedForSecurityAudit, seedForDoctorFinding, seedForDoctorFindings, launchClaude, launchRelay, launchCommand } from "./launch.mjs";
import { listRelayJobs, relayDir, dismissRelay } from "./relay.mjs";
import { latestTodos, resolveCrossItems } from "./todos.mjs";
import { taskTokens } from "./tokens.mjs";
import { openFile } from "./open.mjs";
import { harvest as runHarvest } from "./harvest.mjs";
import { scanEnvs, updateEnv } from "./envs.mjs";
import { listPorts, killPort, stopProject } from "./ports.mjs";
import * as changes from "./changes.mjs";
import { resolveHost, tokenMatches } from "./bind.mjs";
import { readDoctor, scanAndCache, startDoctorTimer, withStatuses, setStatus, verifyFinding, FINDING_STATUSES, NOTE_MAX } from "./doctor.mjs";
import { statuslineUsageCached } from "./statusline-usage.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 4500;
const TOKEN = process.env.PM_TOKEN || "";
const SLUG_RE = /^[a-z0-9][a-z0-9_-]*$/;
const SESSION_ID_RE = /^[a-f0-9][a-f0-9-]{7,}$/i;
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const hasToken = (req) => tokenMatches(req.query.token, TOKEN) || tokenMatches(req.get("x-pm-token"), TOKEN);
const canLaunch = (req) => LOOPBACK.has(req.ip) || hasToken(req);
// Batch runs (run-seq / run-cross) default to the unattended relay; `{unattended:false}`
// opts back into a plain interactive session.
const unattended = (req) => (req.body || {}).unattended !== false;

const app = express();
app.use(express.json());

// optional shared-secret guard (off unless PM_TOKEN is set)
app.use("/api", (req, res, next) => {
  if (TOKEN && !hasToken(req)) return res.status(401).json({ error: "bad token" });
  next();
});

// The board's own project: PM_SELF_SLUG, else "pm" when that project exists. Left out of the card list;
// the hover button opens its page.
app.get("/api/health", async (_req, res, next) => {
  try {
    const self = process.env.PM_SELF_SLUG || ((await discoverSlugs()).all.includes("pm") ? "pm" : null);
    res.json({ ok: true, root: PM_ROOT, self });
  } catch (e) {
    next(e);
  }
});

// listening ports per project (cwd under PM_ROOT), cached so the 30s refetches don't spawn lsof each time
let runCache = { at: 0, map: new Map() };
async function runningBySlug() {
  if (Date.now() - runCache.at < 4000) return runCache.map;
  const map = new Map();
  try {
    for (const r of await listPorts()) {
      if (!r.project || r.self) continue;
      const a = map.get(r.project) || [];
      if (!a.some((x) => x.port === r.port)) a.push({ port: r.port, command: r.command });
      map.set(r.project, a);
    }
  } catch {}
  runCache = { at: Date.now(), map };
  return map;
}

// ?kind=project (default) | tool | all  (see server/entries.mjs)
app.get("/api/projects", async (req, res, next) => {
  try {
    const kind = req.query.kind || "project";
    if (kind !== "all" && !KINDS.includes(kind)) return res.status(400).json({ error: "bad kind" });
    const [list, running] = await Promise.all([listProjects(kind), runningBySlug()]);
    res.json(list.map((p) => ({ ...p, running: running.get(p.slug) || [] })));
  } catch (e) {
    next(e);
  }
});

app.get("/api/projects/:slug", async (req, res, next) => {
  try {
    const p = await getProject(req.params.slug);
    if (!p) return res.status(404).json({ error: "no such project" });
    res.json(p);
  } catch (e) {
    next(e);
  }
});

app.post("/api/projects", async (req, res, next) => {
  try {
    const { slug, title } = req.body || {};
    if (!SLUG_RE.test(slug || "")) return res.status(400).json({ error: "bad slug" });
    const path = join(BACKLOG_DIR, `${slug}.md`);
    if (existsSync(path)) return res.status(409).json({ error: "exists" });
    await writeBacklog(slug, emptyBacklog(slug));
    res.status(201).json(await getProject(slug));
  } catch (e) {
    next(e);
  }
});

app.put("/api/projects/:slug/state", async (req, res, next) => {
  try {
    const { slug } = req.params;
    const cur = (await readState(slug)) || {
      slug,
      title: `${slug} — state`,
      updated: "",
      now: "",
      next: [],
      lastFailure: "none",
      blockers: "none",
      resume: {},
    };
    const b = req.body || {};
    const merged = {
      ...cur,
      now: b.now ?? cur.now,
      next: Array.isArray(b.next) ? b.next : cur.next,
      lastFailure: b.lastFailure ?? cur.lastFailure,
      blockers: b.blockers ?? cur.blockers,
      resume: { ...cur.resume, ...(b.resume && typeof b.resume === "object" ? b.resume : {}) },
    };
    await writeState(slug, merged);
    res.json(await getProject(slug));
  } catch (e) {
    if (/-(line|char) cap/.test(e.message)) return res.status(422).json({ error: e.message });
    next(e);
  }
});

app.post("/api/projects/:slug/tasks", async (req, res, next) => {
  try {
    const { slug } = req.params;
    const bl = (await readBacklog(slug)) || emptyBacklog(slug);
    const { title, state = "Todo", priority = null, note = null } = req.body || {};
    if (!title || !String(title).trim())
      return res.status(400).json({ error: "title required" });
    bl.tasks.push({ title: String(title).trim(), state, priority, note });
    await writeBacklog(slug, bl);
    res.status(201).json(await getProject(slug));
  } catch (e) {
    next(e);
  }
});

app.put("/api/projects/:slug/tasks/:id", async (req, res, next) => {
  try {
    const { slug, id } = req.params;
    const bl = await readBacklog(slug);
    const t = bl && bl.tasks.find((x) => x.id === Number(id));
    if (!t) return res.status(404).json({ error: "no such task" });
    const b = req.body || {};
    if (b.title !== undefined) t.title = String(b.title).trim();
    if (b.state !== undefined) t.state = b.state;
    if (b.priority !== undefined) t.priority = b.priority;
    if (b.seq !== undefined) t.seq = !!b.seq;
    if (b.note !== undefined) t.note = b.note || null;
    if (t.state === "Done" && !t.done) t.done = new Date().toISOString().slice(0, 10);
    if (t.state !== "Done") t.done = null;
    await writeBacklog(slug, bl);
    res.json(await getProject(slug));
  } catch (e) {
    next(e);
  }
});

app.delete("/api/projects/:slug/tasks/:id", async (req, res, next) => {
  try {
    const { slug, id } = req.params;
    const bl = await readBacklog(slug);
    if (!bl) return res.status(404).json({ error: "no backlog" });
    const n = bl.tasks.length;
    bl.tasks = bl.tasks.filter((x) => x.id !== Number(id));
    if (bl.tasks.length === n) return res.status(404).json({ error: "no such task" });
    await writeBacklog(slug, bl);
    res.json(await getProject(slug));
  } catch (e) {
    next(e);
  }
});

// Removal never deletes: writeBacklog archives dropped tasks to backlog-archive/<slug>.md.
app.get("/api/projects/:slug/archive", async (req, res, next) => {
  try {
    if (!SLUG_RE.test(req.params.slug)) return res.status(400).json({ error: "bad slug" });
    res.json({ items: await readArchive(req.params.slug) });
  } catch (e) {
    next(e);
  }
});

app.post("/api/projects/:slug/archive/restore", async (req, res, next) => {
  try {
    const { slug } = req.params;
    if (!SLUG_RE.test(slug)) return res.status(400).json({ error: "bad slug" });
    await restoreTask(slug, String(req.body?.title ?? ""));
    res.json(await getProject(slug));
  } catch (e) {
    if (/no such archived/.test(e.message)) return res.status(404).json({ error: e.message });
    if (/already in backlog/.test(e.message)) return res.status(409).json({ error: e.message });
    next(e);
  }
});

// --- sessions inbox ---------------------------------------------------
app.get("/api/sessions", async (_req, res, next) => {
  try {
    res.json(await listSessions());
  } catch (e) {
    next(e);
  }
});

app.put("/api/sessions/:id", async (req, res, next) => {
  try {
    if (!SESSION_ID_RE.test(req.params.id)) return res.status(400).json({ error: "bad id" });
    const { project, archived } = req.body || {};
    if (project && !SLUG_RE.test(project)) return res.status(400).json({ error: "bad slug" });
    await fileSession(req.params.id, { project, archived });
    res.json(await listSessions());
  } catch (e) {
    next(e);
  }
});

app.post("/api/sessions/:id/task", async (req, res, next) => {
  try {
    if (!SESSION_ID_RE.test(req.params.id)) return res.status(400).json({ error: "bad id" });
    const { project } = req.body || {};
    if (!SLUG_RE.test(project || "")) return res.status(400).json({ error: "bad slug" });
    await sessionToTask(req.params.id, project);
    res.json(await listSessions());
  } catch (e) {
    if (/no such session/.test(e.message)) return res.status(404).json({ error: e.message });
    next(e);
  }
});

app.post("/api/sessions/:id/new-project", async (req, res, next) => {
  try {
    if (!SESSION_ID_RE.test(req.params.id)) return res.status(400).json({ error: "bad id" });
    const slug = await sessionToNewProject(req.params.id, (req.body || {}).name);
    res.status(201).json({ slug, ...(await listSessions()) });
  } catch (e) {
    if (e.code === "BAD_SLUG") return res.status(400).json({ error: e.message });
    if (e.code === "EXISTS") return res.status(409).json({ error: e.message });
    if (/no such session/.test(e.message)) return res.status(404).json({ error: e.message });
    next(e);
  }
});

app.post("/api/sessions/:id/resume", async (req, res, next) => {
  try {
    if (!SESSION_ID_RE.test(req.params.id)) return res.status(400).json({ error: "bad id" });
    if (!canLaunch(req)) return res.status(403).json({ error: "launch needs loopback or PM_TOKEN" });
    res.json({ ok: true, ...(await launchClaude({ cwd: PM_ROOT, resumeId: req.params.id, bg: req.body?.bg })) });
  } catch (e) {
    next(e);
  }
});

// --- build-with-claude / idea promotion ------------------------------
app.post("/api/projects/:slug/tasks/:id/launch", async (req, res, next) => {
  try {
    const { slug, id } = req.params;
    if (!SLUG_RE.test(slug)) return res.status(400).json({ error: "bad slug" });
    if (!canLaunch(req)) return res.status(403).json({ error: "launch needs loopback or PM_TOKEN" });
    const bl = await readBacklog(slug);
    const t = bl && bl.tasks.find((x) => x.id === Number(id));
    if (!t) return res.status(404).json({ error: "no such task" });
    const dir = entryDir(slug);
    const prompt = seedForTask({ slug, title: t.title, note: t.note, adhoc: !existsSync(dir) });
    res.json({ ok: true, ...(await launchClaude({ cwd: dir, prompt, todos: [{ slug, title: t.title }], bg: req.body?.bg })) });
  } catch (e) {
    next(e);
  }
});

// Start: terminal running the project's own ./start.sh. Fixed command, no client text.
app.post("/api/projects/:slug/start", async (req, res, next) => {
  try {
    const { slug } = req.params;
    if (!SLUG_RE.test(slug)) return res.status(400).json({ error: "bad slug" });
    if (!canLaunch(req)) return res.status(403).json({ error: "launch needs loopback or PM_TOKEN" });
    if (!(await readState(slug)) && !(await readBacklog(slug))) return res.status(404).json({ error: "no such project" });
    if (!(await startScript(slug))) return res.status(404).json({ error: "no start.sh" });
    res.json({ ok: true, ...(await launchCommand({ cwd: entryDir(slug), inner: "./start.sh", bg: req.body?.bg })) });
  } catch (e) {
    next(e);
  }
});

// Continue: interactive session that re-orients from the project's state + Resume block.
app.post("/api/projects/:slug/continue", async (req, res, next) => {
  try {
    const { slug } = req.params;
    if (!SLUG_RE.test(slug)) return res.status(400).json({ error: "bad slug" });
    if (!canLaunch(req)) return res.status(403).json({ error: "launch needs loopback or PM_TOKEN" });
    if (!(await readState(slug)) && !(await readBacklog(slug))) return res.status(404).json({ error: "no such project" });
    const dir = entryDir(slug);
    const prompt = seedForContinue({ slug, adhoc: !existsSync(dir) });
    res.json({ ok: true, ...(await launchClaude({ cwd: dir, prompt, bg: req.body?.bg })) });
  } catch (e) {
    next(e);
  }
});

// Security audit: interactive session running the workspace security-guard skill.
app.post("/api/projects/:slug/security-audit", async (req, res, next) => {
  try {
    const { slug } = req.params;
    if (!SLUG_RE.test(slug) || slug === "ideas") return res.status(400).json({ error: "bad slug" });
    if (!canLaunch(req)) return res.status(403).json({ error: "launch needs loopback or PM_TOKEN" });
    const dir = entryDir(slug);
    const prompt = seedForSecurityAudit({ slug, adhoc: !existsSync(dir) });
    res.json({ ok: true, ...(await launchClaude({ cwd: dir, prompt, bg: req.body?.bg })) });
  } catch (e) {
    next(e);
  }
});

// Launch one orchestrator session over the ticked todos (body `titles`, exact-title,
// unknown => 409), or over every Todo/Doing task when none (see runnableTasks).
// Same guard + launchClaude path as the single-task build button; pm doesn't
// supervise the session.
app.post("/api/projects/:slug/tasks/run-seq", async (req, res, next) => {
  try {
    const { slug } = req.params;
    if (!SLUG_RE.test(slug)) return res.status(400).json({ error: "bad slug" });
    if (!canLaunch(req)) return res.status(403).json({ error: "launch needs loopback or PM_TOKEN" });
    const bl = await readBacklog(slug);
    let pick;
    try {
      pick = runnableTasks(bl ? bl.tasks : [], req.body?.titles);
    } catch (e) {
      if (e.status === 400) return res.status(400).json({ error: e.message });
      throw e;
    }
    const { mode, tasks, unknown } = pick;
    if (unknown.length) return res.status(409).json({ error: "selected todos changed, refresh", unknown });
    if (!tasks.length) return res.status(400).json({ error: "no runnable todos" });
    const dir = entryDir(slug);
    const relay = unattended(req);
    const prompt = seedForSequentialRun({ slug, tasks, adhoc: !existsSync(dir), mode, relay });
    const launched = relay
      ? await launchRelay({ cwd: dir, prompt, label: `${slug} (${tasks.length})`, tasks: tasks.map((t) => ({ slug, title: t.title })) })
      : await launchClaude({ cwd: dir, prompt, todos: tasks.map((t) => ({ slug, title: t.title })), bg: req.body?.bg });
    res.json({ ok: true, mode, count: tasks.length, ...launched });
  } catch (e) {
    next(e);
  }
});

// Newest-added open todos across projects (proxy — see latestTodos in todos.mjs).
app.get("/api/todos/latest", async (req, res, next) => {
  try {
    res.json(await latestTodos({ limit: req.query.limit }));
  } catch (e) {
    next(e);
  }
});

// One orchestrator session (cwd = workspace root) over a hand-picked cross-project
// set. Items are re-resolved against the current backlog; any stale id => 409 so the
// client refreshes (ids are positional). `ideas` items are dropped, not run.
app.post("/api/tasks/run-cross", async (req, res, next) => {
  try {
    if (!canLaunch(req)) return res.status(403).json({ error: "launch needs loopback or PM_TOKEN" });
    const items = (req.body || {}).items;
    if (!Array.isArray(items) || !items.length || items.length > 200)
      return res.status(400).json({ error: "items required" });
    if (items.some((i) => !i || !SLUG_RE.test(i.slug || "") || !Number.isInteger(i.id)))
      return res.status(400).json({ error: "bad item" });
    const { tasks, stale, skipped } = await resolveCrossItems(items);
    if (stale.length)
      return res.status(409).json({ error: "todos changed — refresh and pick again", stale });
    if (!tasks.length) return res.status(400).json({ error: "no runnable todos (ideas are excluded)" });
    const relay = unattended(req);
    const prompt = seedForCrossProjectRun({ tasks, relay });
    const projects = new Set(tasks.map((t) => t.slug)).size;
    const launched = relay
      ? await launchRelay({ cwd: PM_ROOT, prompt, label: `${tasks.length} todo(s) / ${projects} project(s)`, tasks })
      : await launchClaude({ cwd: PM_ROOT, prompt, todos: tasks.map((t) => ({ slug: t.slug, title: t.title })) });
    res.json({ ok: true, count: tasks.length, projects, skipped: skipped.length, ...launched });
  } catch (e) {
    next(e);
  }
});

// Per-todo token totals: { slug: { title: { tokens, sessions, split, updatedAt } } }
// (generated sidecar, see server/tokens.mjs).
app.get("/api/tasks/tokens", async (_req, res, next) => {
  try {
    res.json(await taskTokens());
  } catch (e) {
    next(e);
  }
});

// Unattended relay jobs (server/relay.mjs), newest first — the Home strip reads this.
app.get("/api/relay", (_req, res) => {
  res.json(listRelayJobs(PM_ROOT, { limit: 5 }));
});

app.delete("/api/relay/:id", (req, res) => {
  if (!canLaunch(req)) return res.status(403).json({ error: "needs loopback or PM_TOKEN" });
  const ok = dismissRelay(PM_ROOT, req.params.id);
  if (!ok) return res.status(409).json({ error: "job is still running — stop it first" });
  res.json({ ok: true });
});

app.post("/api/tasks/move", async (req, res, next) => {
  try {
    const { fromSlug, id, toSlug } = req.body || {};
    if (!SLUG_RE.test(fromSlug || "") || !SLUG_RE.test(toSlug || ""))
      return res.status(400).json({ error: "bad slug" });
    await moveTask(fromSlug, id, toSlug);
    res.json({ ok: true });
  } catch (e) {
    if (/no such task/.test(e.message)) return res.status(404).json({ error: e.message });
    next(e);
  }
});

// --- usage: the statusline's USD numbers (5h block / today / 7d) ---------
app.get("/api/usage", (_req, res, next) => {
  try {
    res.json(statuslineUsageCached());
  } catch (e) {
    next(e);
  }
});

// --- doctor: LLM-free efficiency scan of transcripts (suggestions only) ---
app.get("/api/doctor", (_req, res) => {
  res.json(withStatuses(readDoctor()) || { generatedAt: null, findings: [] });
});
app.post("/api/doctor/run", async (_req, res, next) => {
  try {
    res.json(withStatuses(await scanAndCache()));
  } catch (e) {
    next(e);
  }
});
// "Fix with Claude": the finding is looked up server-side by id in the cached scan, so the
// client can't inject prompt text. Launch-guarded like the other seed routes.
app.post("/api/doctor/findings/:id/fix", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!/^[a-z0-9-]{1,60}$/.test(id)) return res.status(400).json({ error: "bad finding id" });
    if (!canLaunch(req)) return res.status(403).json({ error: "launch needs loopback or PM_TOKEN" });
    const f = readDoctor()?.findings?.find((x) => x.id === id);
    if (!f) return res.status(404).json({ error: "finding not found — rescan" });
    if (f.severity === "info") return res.status(400).json({ error: "nothing to fix" });
    const launched = await launchClaude({ cwd: PM_ROOT, prompt: seedForDoctorFinding(f) });
    if (!["done", "dismissed"].includes(withStatuses(readDoctor()).findings.find((x) => x.id === id)?.status)) setStatus(id, "fixing");
    res.json({ ok: true, ...launched });
  } catch (e) {
    next(e);
  }
});
// "Fix all": every open (not done/dismissed), non-info finding in ONE session.
app.post("/api/doctor/fix-all", async (req, res, next) => {
  try {
    if (!canLaunch(req)) return res.status(403).json({ error: "launch needs loopback or PM_TOKEN" });
    const fs = (withStatuses(readDoctor())?.findings || []).filter((f) => f.severity !== "info" && !["done", "dismissed"].includes(f.status));
    if (!fs.length) return res.status(400).json({ error: "nothing to fix" });
    const launched = await launchClaude({ cwd: PM_ROOT, prompt: seedForDoctorFindings(fs) });
    for (const f of fs) if (f.status !== "fixing") setStatus(f.id, "fixing");
    res.json({ ok: true, count: fs.length, ...launched });
  } catch (e) {
    next(e);
  }
});
// pm can't see how the launched session ended, so the user records the outcome:
// fixing (set on launch) -> done | dismissed, or back to open. Finding must exist in the cached scan.
app.post("/api/doctor/findings/:id/status", (req, res) => {
  const { id } = req.params;
  const status = req.body?.status;
  if (!/^[a-z0-9-]{1,60}$/.test(id)) return res.status(400).json({ error: "bad finding id" });
  if (typeof status !== "string" || !FINDING_STATUSES.includes(status)) return res.status(400).json({ error: "bad status" });
  if (!readDoctor()?.findings?.some((x) => x.id === id)) return res.status(404).json({ error: "finding not found — rescan" });
  const note = req.body?.note;
  if (note !== undefined && (typeof note !== "string" || note.length > NOTE_MAX)) return res.status(400).json({ error: "bad note" });
  setStatus(id, status, Date.now(), note);
  res.json({ ok: true, id, status });
});
// Re-checks a fixing/done finding against transcripts written after the fix. No client text is used.
app.post("/api/doctor/findings/:id/verify", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!/^[a-z0-9-]{1,60}$/.test(id)) return res.status(400).json({ error: "bad finding id" });
    res.json({ ok: true, id, ...(await verifyFinding(id)) });
  } catch (e) {
    if (e.code === 409) return res.status(409).json({ error: e.message });
    next(e);
  }
});
startDoctorTimer();

// Open a workspace file (pdf/xlsx/ipynb/md/…) in its default app — see server/open.mjs.
app.post("/api/open", async (req, res, next) => {
  try {
    if (!canLaunch(req)) return res.status(403).json({ error: "open needs loopback or PM_TOKEN" });
    const { path, slug } = req.body || {};
    res.json({ ok: true, ...(await openFile(path, slug)) });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    next(e);
  }
});

// --- ports: listening TCP ports + stop the owning process (both need loopback/PM_TOKEN) ---
app.get("/api/ports", async (req, res, next) => {
  try {
    if (!canLaunch(req)) return res.status(403).json({ error: "ports need loopback or PM_TOKEN" });
    res.json({ ports: await listPorts() });
  } catch (e) {
    next(e);
  }
});
app.post("/api/projects/:slug/stop", async (req, res, next) => {
  try {
    const { slug } = req.params;
    if (!SLUG_RE.test(slug)) return res.status(400).json({ error: "bad slug" });
    if (!canLaunch(req)) return res.status(403).json({ error: "stop needs loopback or PM_TOKEN" });
    const out = await stopProject(slug);
    runCache.at = 0;
    res.json({ ok: true, ...out });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    next(e);
  }
});

app.post("/api/ports/kill", async (req, res, next) => {
  try {
    if (!canLaunch(req)) return res.status(403).json({ error: "ports need loopback or PM_TOKEN" });
    const { pid, port } = req.body || {};
    res.json({ ok: true, ...(await killPort(pid, port)) });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    next(e);
  }
});

// --- changes: git edits across repos, keep/discard per hunk, commit, push (all need loopback/PM_TOKEN) ---
const changeRoute = (method, path, fn) =>
  app[method](path, async (req, res, next) => {
    try {
      if (!canLaunch(req)) return res.status(403).json({ error: "changes need loopback or PM_TOKEN" });
      res.json(await fn(req));
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message });
      next(e);
    }
  });
changeRoute("get", "/api/changes", () => changes.listRepos().then((repos) => ({ repos })));
changeRoute("get", "/api/changes/:slug", (req) => changes.repoStatus(req.params.slug));
changeRoute("get", "/api/changes/:slug/diff", (req) => changes.fileDiff(req.params.slug, String(req.query.path ?? ""), req.query.side));
changeRoute("post", "/api/changes/:slug/apply", (req) => changes.applyChange(req.params.slug, req.body || {}));
changeRoute("post", "/api/changes/:slug/stage-all", (req) => changes.stageAll(req.params.slug, req.body?.on !== false, req.body?.tracked === true));
changeRoute("post", "/api/changes/:slug/fetch", (req) => changes.fetchRepo(req.params.slug));
changeRoute("post", "/api/changes/:slug/pull", (req) => changes.pullRepo(req.params.slug));
changeRoute("post", "/api/changes/:slug/init", (req) => changes.initRepo(req.params.slug));
changeRoute("post", "/api/changes/:slug/commit", (req) => changes.commit(req.params.slug, req.body?.message, req.body?.amend === true));
changeRoute("post", "/api/changes/:slug/push", (req) => changes.push(req.params.slug));

// --- env manager (masked values only; read and write need loopback/PM_TOKEN) ---
app.get("/api/envs", async (req, res, next) => {
  try {
    if (!canLaunch(req)) return res.status(403).json({ error: "envs need loopback or PM_TOKEN" });
    res.json({ vars: await scanEnvs() });
  } catch (e) {
    next(e);
  }
});
app.post("/api/envs/update", async (req, res, next) => {
  try {
    if (!canLaunch(req)) return res.status(403).json({ error: "env update needs loopback or PM_TOKEN" });
    const { name, value, files, dryRun } = req.body || {};
    res.json(await updateEnv(name, value, { files, dryRun: !!dryRun }));
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    next(e);
  }
});

// --- live updates: fs.watch on the three dirs/files -> SSE ping -----------
const clients = new Set();
app.get("/api/stream", (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write("retry: 3000\n\n");
  clients.add(res);
  req.on("close", () => clients.delete(res));
});
// fs.watch fires several events per write; collapse them into one ping
let pingT = null;
function ping() {
  if (pingT) return;
  pingT = setTimeout(() => {
    pingT = null;
    for (const res of clients) res.write(`data: ${Date.now()}\n\n`);
  }, 80);
}
try {
  mkdirSync(relayDir(PM_ROOT), { recursive: true });
} catch {}
for (const p of [STATE_DIR, BACKLOG_DIR, join(CLAUDE, "pm"), relayDir(PM_ROOT)]) {
  try {
    watch(p, { persistent: false }, ping);
  } catch {}
}

// --- activity harvester: run on boot + every 10 min ----------------------
function harvest() {
  runHarvest().then(ping, (err) => console.error("[harvest]", err.message));
}
harvest();
// warm the per-file usage cache off the request path so the first /api/usage isn't a ~800ms cold scan
setTimeout(() => { try { statuslineUsageCached(); } catch {} }, 0).unref();
setInterval(harvest, 10 * 60 * 1000).unref();

// --- static SPA (built) ------------------------------------------------
const DIST = join(__dirname, "../web/dist");
if (existsSync(DIST)) {
  app.use(express.static(DIST));
  app.get("*", (_req, res) => res.sendFile(join(DIST, "index.html")));
}

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: String(err.message || err) });
});

let HOST;
try {
  HOST = resolveHost();
} catch (e) {
  console.error(`pm: ${e.message}`);
  process.exit(1);
}
app.listen(PORT, HOST, () => console.log(`pm on http://${HOST}:${PORT}  (root: ${PM_ROOT})`));
