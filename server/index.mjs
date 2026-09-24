import express from "express";
import { execFile } from "node:child_process";
import { existsSync, watch, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PM_ROOT, CLAUDE, STATE_DIR, BACKLOG_DIR } from "./paths.mjs";
import { listProjects, getProject } from "./projects.mjs";
import { readState, writeState } from "./state.mjs";
import { readBacklog, writeBacklog, emptyBacklog, runnableTasks } from "./backlog.mjs";
import { listSessions, fileSession, sessionToTask, sessionToNewProject, moveTask } from "./sessions.mjs";
import { seedForTask, seedForSequentialRun, seedForCrossProjectRun, launchClaude, launchRelay } from "./launch.mjs";
import { listRelayJobs, relayDir, dismissRelay } from "./relay.mjs";
import { latestTodos, resolveCrossItems } from "./todos.mjs";
import {
  burnSnapshot,
  burnBreakdown,
  summary,
  accountRateLimitStatus,
  checkPreLaunchUtilization,
  paceBreakdown,
  PACE_WINDOW_MS,
  writeUsageLimitsWindow,
} from "./usage.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 4500;
const TOKEN = process.env.PM_TOKEN || "";
const SLUG_RE = /^[a-z0-9][a-z0-9_-]*$/;
const SESSION_ID_RE = /^[a-f0-9][a-f0-9-]{7,}$/i;
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const hasToken = (req) => TOKEN && (req.query.token === TOKEN || req.get("x-pm-token") === TOKEN);
const canLaunch = (req) => LOOPBACK.has(req.ip) || hasToken(req);
// Batch runs (run-seq / run-cross) default to the unattended relay; `{unattended:false}`
// opts back into a plain interactive session.
const unattended = (req) => (req.body || {}).unattended !== false;

const app = express();
app.use(express.json());

// optional shared-secret guard (off unless PM_TOKEN is set)
app.use("/api", (req, res, next) => {
  if (TOKEN && req.query.token !== TOKEN && req.get("x-pm-token") !== TOKEN)
    return res.status(401).json({ error: "bad token" });
  next();
});

app.get("/api/health", (_req, res) => res.json({ ok: true, root: PM_ROOT }));

app.get("/api/projects", async (_req, res, next) => {
  try {
    res.json(await listProjects());
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
    };
    const b = req.body || {};
    const merged = {
      ...cur,
      now: b.now ?? cur.now,
      next: Array.isArray(b.next) ? b.next : cur.next,
      lastFailure: b.lastFailure ?? cur.lastFailure,
      blockers: b.blockers ?? cur.blockers,
    };
    await writeState(slug, merged);
    res.json(await getProject(slug));
  } catch (e) {
    if (/40-line cap/.test(e.message)) return res.status(422).json({ error: e.message });
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
    res.json({ ok: true, ...(await launchClaude({ cwd: PM_ROOT, resumeId: req.params.id })) });
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
    const dir = join(PM_ROOT, slug);
    const prompt = seedForTask({ slug, title: t.title, note: t.note, adhoc: !existsSync(dir) });
    res.json({ ok: true, ...(await launchClaude({ cwd: dir, prompt })) });
  } catch (e) {
    next(e);
  }
});

// Launch one orchestrator session over the project's @seq-flagged todos, or —
// when none are flagged — over every Todo/Doing task (see runnableTasks).
// Same guard + launchClaude path as the single-task build button; pm doesn't
// supervise the session.
app.post("/api/projects/:slug/tasks/run-seq", async (req, res, next) => {
  try {
    const { slug } = req.params;
    if (!SLUG_RE.test(slug)) return res.status(400).json({ error: "bad slug" });
    if (!canLaunch(req)) return res.status(403).json({ error: "launch needs loopback or PM_TOKEN" });
    const bl = await readBacklog(slug);
    const { mode, tasks } = runnableTasks(bl ? bl.tasks : []);
    if (!tasks.length) return res.status(400).json({ error: "no runnable todos" });
    const dir = join(PM_ROOT, slug);
    const relay = unattended(req);
    const prelaunchUtilization = await checkPreLaunchUtilization();
    const prompt = seedForSequentialRun({ slug, tasks, adhoc: !existsSync(dir), mode, relay, prelaunchUtilization });
    const launched = relay
      ? await launchRelay({ cwd: dir, prompt, label: `${slug} (${tasks.length})`, tasks: tasks.map((t) => ({ slug, title: t.title })) })
      : await launchClaude({ cwd: dir, prompt });
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
    const prelaunchUtilization = await checkPreLaunchUtilization();
    const prompt = seedForCrossProjectRun({ tasks, relay, prelaunchUtilization });
    const projects = new Set(tasks.map((t) => t.slug)).size;
    const launched = relay
      ? await launchRelay({ cwd: PM_ROOT, prompt, label: `${tasks.length} todo(s) / ${projects} project(s)`, tasks })
      : await launchClaude({ cwd: PM_ROOT, prompt });
    res.json({ ok: true, count: tasks.length, projects, skipped: skipped.length, ...launched });
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

// --- usage / burn rate -------------------------------------------------
app.get("/api/usage/burn", async (_req, res, next) => {
  try {
    const breakdown = await burnBreakdown();
    breakdown.pace = await paceBreakdown();
    res.json({
      ...(await burnSnapshot()),
      breakdown,
      paceWindowMs: PACE_WINDOW_MS,
      limits: await accountRateLimitStatus(),
    });
  } catch (e) {
    next(e);
  }
});

app.get("/api/usage/summary", async (req, res, next) => {
  try {
    const bucket = req.query.bucket === "hour" ? "hour" : "day";
    const days = Math.min(Number(req.query.days) || 14, 90);
    res.json(await summary({ bucket, days }));
  } catch (e) {
    next(e);
  }
});

// window: "5h"|"7d"|"30d"; body: { mode?, manualCapTokens? } — a manual value
// persists exactly as set until this route (or a manual re-edit) changes it,
// unauthenticated like the rest of pm (matches hub/).
app.put("/api/usage/limits/:window", async (req, res, next) => {
  try {
    const { mode, manualCapTokens } = req.body || {};
    const cfg = writeUsageLimitsWindow(req.params.window, { mode, manualCapTokens });
    res.json(cfg);
  } catch (e) {
    res.status(400).json({ error: e.message });
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
function ping() {
  for (const res of clients) res.write(`data: ${Date.now()}\n\n`);
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
const HARVESTER = join(PM_ROOT, ".claude/scripts/pm-activity.mjs");
function harvest() {
  if (!existsSync(HARVESTER)) return;
  execFile("node", [HARVESTER], { env: { ...process.env } }, (err) => {
    if (err) console.error("[pm-activity]", err.message);
    else ping();
  });
}
harvest();
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

app.listen(PORT, "0.0.0.0", () =>
  console.log(`pm on http://0.0.0.0:${PORT}  (root: ${PM_ROOT})`),
);
