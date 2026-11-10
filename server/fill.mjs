// Fill: spend the part of the weekly Claude quota you'd otherwise leave unused on todos you
// marked "auto". Pace = a cumulative daily share of the weekly window, so a quiet day rolls
// its share forward and the week ends near 100%. Numbers come from Claude Code's own rate
// limits: what relay runs see (`limits.json`) and, optionally, what the statusline saves.
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { PM_ROOT } from "./paths.mjs";
import { readBacklog } from "./backlog.mjs";
import { discoverSlugs } from "./projects.mjs";
import { listRelayJobs, limitsPath, writeJson } from "./relay.mjs";
import { seedForFill, launchRelayDetached } from "./launch.mjs";

const DAY = 86_400_000;
const WEEK = 7 * DAY;
const FIVE_H = 5 * 3_600_000;
const SLUG_RE = /^[a-z0-9][a-z0-9_-]*$/;
export const MAX_TITLE = 500;
export const STOP_5H = 95; // never start a fill run above this 5h %
const RETRY_STATUSES = new Set(["stalled", "failed", "dead", "stopped"]);
export const MAX_TRIES = 2; // fill runs per todo that ended without finishing it (last 7 days)

// pending = a "Fill now" that found no quota: the timer starts it once quota frees up (reset or
// a new day's share), even with fill off or you at the keyboard.
export const DEFAULTS = { enabled: false, idleMin: 20, reservePct: 5, batch: 5, pending: false };
const LIMITS = { idleMin: [0, 720], reservePct: [0, 50], batch: [1, 20] };

const pmDir = (root) => join(root, ".claude", "pm");
const settingsPath = (root) => join(pmDir(root), "fill.json");
const autoPath = (root) => join(pmDir(root), "auto-todos.json");
const autoProjectsPath = (root) => join(pmDir(root), "auto-projects.json");
export const statuslinePath = (env = process.env) => env.PM_RATE_LIMITS_FILE || join(homedir(), ".claude", "rate-limits.json");

const readJson = (p, d) => {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return d;
  }
};

// ---------- settings + auto marks ----------------------------------------

export function readFillSettings(root = PM_ROOT) {
  return { ...DEFAULTS, ...cleanSettings(readJson(settingsPath(root), {})) };
}

// Drops unknown keys and out-of-range values; throws on a wrong type so the route can 400.
export function cleanSettings(patch, strict = false) {
  const out = {};
  if (!patch || typeof patch !== "object") return out;
  for (const k of ["enabled", "pending"]) {
    if (!(k in patch)) continue;
    if (typeof patch[k] === "boolean") out[k] = patch[k];
    else if (strict) throw new Error(`${k} must be true/false`);
  }
  for (const [k, [lo, hi]] of Object.entries(LIMITS)) {
    if (!(k in patch)) continue;
    const v = patch[k];
    if (Number.isInteger(v) && v >= lo && v <= hi) out[k] = v;
    else if (strict) throw new Error(`${k} must be an integer ${lo}-${hi}`);
  }
  return out;
}

export function writeFillSettings(patch, root = PM_ROOT) {
  const next = { ...readFillSettings(root), ...cleanSettings(patch, true) };
  writeJson(settingsPath(root), next);
  return next;
}

// { slug: [title, …] } — keyed by title like task-tokens.json, so a rename drops the mark.
export function readAuto(root = PM_ROOT) {
  const raw = readJson(autoPath(root), {});
  const out = {};
  for (const [slug, titles] of Object.entries(raw || {}))
    if (SLUG_RE.test(slug) && Array.isArray(titles)) out[slug] = titles.filter((t) => typeof t === "string");
  return out;
}

export function setAuto(slug, title, on, root = PM_ROOT) {
  if (!SLUG_RE.test(slug || "")) throw new Error("bad slug");
  if (typeof title !== "string" || !title.trim() || title.length > MAX_TITLE) throw new Error("bad title");
  const all = readAuto(root);
  const set = new Set(all[slug] || []);
  if (on) set.add(title);
  else set.delete(title);
  if (set.size) all[slug] = [...set];
  else delete all[slug];
  writeJson(autoPath(root), all);
  return all;
}

// [slug, …] — every open todo of these projects is auto, including ones added later.
export function readAutoProjects(root = PM_ROOT) {
  const raw = readJson(autoProjectsPath(root), []);
  return Array.isArray(raw) ? [...new Set(raw.filter((s) => typeof s === "string" && SLUG_RE.test(s)))] : [];
}

export function setAutoProject(slug, on, root = PM_ROOT) {
  if (!SLUG_RE.test(slug || "")) throw new Error("bad slug");
  const set = new Set(readAutoProjects(root));
  if (on) set.add(slug);
  else set.delete(slug);
  writeJson(autoProjectsPath(root), [...set]);
  return [...set];
}

// ---------- limits + target (pure) ----------------------------------------

// A window whose reset already passed has rolled over: 0% used, next reset one period later.
// No reset time but the reading is older than a whole period: it has reset too.
function roll(w, periodMs, now, at = 0) {
  if (!w || typeof w.pct !== "number") return null;
  let resetsAt = typeof w.resetsAt === "number" ? w.resetsAt * 1000 : null;
  if (resetsAt === null) return { pct: at && now - at >= periodMs ? 0 : w.pct, resetsAtMs: null };
  if (resetsAt > now) return { pct: w.pct, resetsAtMs: resetsAt };
  while (resetsAt <= now) resetsAt += periodMs;
  return { pct: 0, resetsAtMs: resetsAt };
}

// Statusline stdin shape: { rate_limits: { five_hour|seven_day: { used_percentage, resets_at } } }
export function fromStatusline(raw) {
  const rl = raw?.rate_limits;
  if (!rl) return null;
  const w = (x) => (x && typeof x.used_percentage === "number" ? { pct: x.used_percentage, resetsAt: x.resets_at ?? null } : null);
  return { at: Number(raw.at) * (raw.at < 1e12 ? 1000 : 1) || 0, source: "statusline", fiveHour: w(rl.five_hour), week: w(rl.seven_day) };
}

// The freshest of the two sources, windows rolled forward to `now`. null = never seen.
export function pickLimits(candidates, now = Date.now()) {
  const best = candidates.filter((c) => c && (c.week || c.fiveHour)).sort((a, b) => (b.at || 0) - (a.at || 0))[0];
  if (!best) return null;
  return { at: best.at, source: best.source, fiveHour: roll(best.fiveHour, FIVE_H, now, best.at), week: roll(best.week, WEEK, now, best.at) };
}

export function readLimits(root = PM_ROOT, now = Date.now(), env = process.env) {
  return pickLimits([readJson(limitsPath(root), null), fromStatusline(readJson(statuslinePath(env), null))], now);
}

function endOfLocalDay(now) {
  const d = new Date(now);
  d.setHours(24, 0, 0, 0);
  return d.getTime();
}

// Weekly % that should be used by the end of today: one seventh per day since the window
// opened, minus a reserve kept for your own sessions. null when the weekly reset is unknown.
export function fillTarget(limits, now, { reservePct = DEFAULTS.reservePct } = {}) {
  const resetMs = limits?.week?.resetsAtMs;
  if (!resetMs) return null;
  const frac = Math.min(1, Math.max(0, (endOfLocalDay(now) - (resetMs - WEEK)) / WEEK));
  return Math.round(Math.min(100 - reservePct, 100 * frac) * 10) / 10;
}

// -> { go, why, target, todos, stop7d }
export function decideFill({ settings, limits, now, idleSec, busy, todos, manual = false }) {
  const no = (why, extra = {}) => ({ go: false, why, target: null, todos: [], ...extra });
  if (!manual && !settings.enabled) return no("off");
  if (busy) return no("a relay job is already running");
  if (!todos.length) return no("no open todos marked auto");
  if (!manual && idleSec !== null && idleSec < settings.idleMin * 60) return no(`you're active (idle ${Math.floor(idleSec / 60)} of ${settings.idleMin} min)`);
  const five = limits?.fiveHour;
  // wait: no quota right now, but a reset or tomorrow's share frees some — worth retrying later
  if (five && five.pct >= STOP_5H)
    return no(`5h window at ${Math.round(five.pct)}%${five.resetsAtMs ? ` until ${new Date(five.resetsAtMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}`, { wait: true });
  const target = fillTarget(limits, now, settings);
  if (target === null) {
    // No weekly numbers yet: one todo, capped at the reserve line. The run records the limits.
    return { go: true, why: "no limit data yet — one todo to learn the weekly window", target: null, todos: todos.slice(0, 1), stop7d: (100 - settings.reservePct) / 100 };
  }
  if (limits.week.pct >= target) return no(`today's share is used (weekly ${Math.round(limits.week.pct)}% of ${target}%)`, { target, wait: true });
  return { go: true, why: `weekly ${Math.round(limits.week.pct)}% → ${target}%`, target, todos: todos.slice(0, settings.batch), stop7d: target / 100 };
}

// ---------- IO -----------------------------------------------------------

// Seconds since the last keyboard/mouse input. macOS only (ioreg); null elsewhere = treated as idle.
export function idleSeconds() {
  if (process.platform !== "darwin") return null;
  try {
    const out = execFileSync("ioreg", ["-c", "IOHIDSystem", "-d", "4", "-r", "-k", "HIDIdleTime"], { encoding: "utf8", timeout: 3000 });
    const m = out.match(/"HIDIdleTime"\s*=\s*(\d+)/);
    return m ? Math.floor(Number(m[1]) / 1e9) : null;
  } catch {
    return null;
  }
}

const key = (slug, title) => `${slug}\t${title}`;

// Todos fill runs already tried and didn't finish, so a stuck one isn't relaunched forever.
export function triedTodos(jobs, now = Date.now()) {
  const n = new Map();
  for (const j of jobs) {
    if (!j.fill || !RETRY_STATUSES.has(j.status) || now - (j.startedAt || 0) > WEEK) continue;
    for (const t of j.tasks || []) n.set(key(t.slug, t.title), (n.get(key(t.slug, t.title)) || 0) + 1);
  }
  return n;
}

// Every open (Todo/Doing) todo marked auto (or in an auto project), in backlog order; `skipped` = tried
// MAX_TRIES times. Read live on every pass, so todos added since the last run join the next one.
async function autoEntries(root, jobs) {
  const marks = readAuto(root);
  const projects = new Set(readAutoProjects(root));
  const tried = triedTodos(jobs);
  const { all } = await discoverSlugs();
  const out = [];
  for (const slug of new Set([...projects, ...Object.keys(marks)])) {
    if (!all.includes(slug)) continue;
    const want = new Set(marks[slug] || []);
    const whole = projects.has(slug);
    const bl = await readBacklog(slug);
    for (const t of bl?.tasks || []) {
      if ((t.state !== "Todo" && t.state !== "Doing") || !(whole || want.has(t.title))) continue;
      out.push({ slug, id: t.id, title: t.title, note: t.note, viaProject: whole, skipped: (tried.get(key(slug, t.title)) || 0) >= MAX_TRIES });
    }
  }
  return out;
}

export async function autoTodos(root = PM_ROOT, jobs = listRelayJobs(root, { limit: 100 })) {
  return (await autoEntries(root, jobs)).filter((t) => !t.skipped);
}

const isBusy = (jobs) => jobs.some((j) => j.status === "running" || j.status === "waiting");

export async function fillStatus({ root = PM_ROOT, now = Date.now(), idle = idleSeconds, manual = false } = {}) {
  const settings = readFillSettings(root);
  const jobs = listRelayJobs(root, { limit: 100 });
  const entries = await autoEntries(root, jobs);
  const todos = entries.filter((t) => !t.skipped);
  const limits = readLimits(root, now);
  const idleSec = manual ? null : idle();
  const decision = decideFill({ settings, limits, now, idleSec, busy: isBusy(jobs), todos, manual: manual || settings.pending });
  return {
    settings,
    limits,
    target: fillTarget(limits, now, settings),
    idleSec,
    auto: readAuto(root),
    autoProjects: readAutoProjects(root),
    autoList: entries.map(({ slug, title, viaProject, skipped }) => ({ slug, title, viaProject, skipped })),
    queued: todos.length,
    queuedBySlug: todos.reduce((m, t) => ((m[t.slug] = (m[t.slug] || 0) + 1), m), {}),
    decision: { go: decision.go, why: decision.why, count: decision.todos.length, wait: !!decision.wait },
    _todos: decision.todos,
    _stop7d: decision.stop7d,
    statusline: existsSync(statuslinePath()),
  };
}

// One planner pass; launches a detached relay job when the decision says go.
export async function runFill({ root = PM_ROOT, now = Date.now(), idle = idleSeconds, manual = false, launch = launchRelayDetached } = {}) {
  const s = await fillStatus({ root, now, idle, manual });
  const { _todos: todos, _stop7d: stop7d, ...status } = s;
  if (!s.decision.go) {
    // "Fill now" with no quota: remember it, the timer starts it once quota frees up
    if (manual && s.decision.wait && !s.settings.pending) {
      writeFillSettings({ pending: true }, root);
      status.settings = { ...status.settings, pending: true };
    }
    return { launched: false, pending: !!status.settings.pending && s.decision.wait, status };
  }
  if (s.settings.pending) writeFillSettings({ pending: false }, root);
  const prompt = seedForFill({ tasks: todos });
  const projects = new Set(todos.map((t) => t.slug)).size;
  const r = await launch({
    cwd: root,
    prompt,
    label: `fill: ${todos.length} todo(s) / ${projects} project(s)`,
    tasks: todos.map((t) => ({ slug: t.slug, title: t.title })),
    fill: { stop7d, target: s.target },
  });
  return { launched: true, job: r.job, status };
}
