// Per-todo token totals. The backlog line is untouched: pm tags every session it
// launches with `pm-run: <id>` (last line of the seed prompt), records id -> todos in
// `.claude/pm/task-runs.json`, and later sums that session's transcript tokens
// (subagent files included) into the generated sidecar `.claude/pm/task-tokens.json`.
// A run over N todos splits its total evenly (an estimate, flagged `split`).
// Sessions started before this feature, or not launched by pm, are never attributed.
import { readFileSync, writeFileSync, mkdirSync, renameSync, createReadStream, statSync } from "node:fs";
import { join, basename, sep } from "node:path";
import { randomBytes } from "node:crypto";
import readline from "node:readline";
import { PM_DIR } from "./paths.mjs";
import { listSessionFiles, parseFileCached, tokenSum } from "./usage.mjs";

const RUNS_FILE = () => join(PM_DIR, "task-runs.json");
const TOKENS_FILE = () => join(PM_DIR, "task-tokens.json");
const MARK_RE = /pm-run:\s*(\d{14}-[0-9a-f]{6})/;
const KEEP_RUNS = 400;

export function newRunId() {
  return `${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}-${randomBytes(3).toString("hex")}`;
}

export const markPrompt = (prompt, id) => `${prompt || ""}\n\n(pm-run: ${id} - pm tracking tag, ignore)`;

const readJson = (p, dflt) => {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return dflt;
  }
};

function writeJson(p, obj) {
  mkdirSync(PM_DIR, { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2));
  renameSync(tmp, p);
}

export function readRuns() {
  const j = readJson(RUNS_FILE(), null);
  return Array.isArray(j?.runs) ? j.runs : [];
}

// Record which todos a launched session/relay covers. Never throws (launch must not fail on it).
export function registerRun({ id, todos }) {
  try {
    const list = (todos || []).filter((t) => t?.slug && t?.title).map((t) => ({ slug: t.slug, title: t.title }));
    if (!list.length) return;
    const runs = readRuns().filter((r) => r.id !== id);
    runs.push({ id, at: Date.now(), todos: list });
    writeJson(RUNS_FILE(), { runs: runs.slice(-KEEP_RUNS) });
  } catch {}
}

// filePath -> { mtimeMs, id }  (first user message's pm-run marker, or null)
const markerCache = new Map();

async function markerOf(filePath, mtimeMs) {
  const hit = markerCache.get(filePath);
  if (hit && hit.mtimeMs === mtimeMs) return hit.id;
  let id = null;
  const rl = readline.createInterface({ input: createReadStream(filePath, { encoding: "utf8" }), crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line.includes('"user"')) continue;
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      if (o.type !== "user") continue;
      const c = o.message?.content;
      const text = typeof c === "string" ? c : JSON.stringify(c || "");
      id = text.match(MARK_RE)?.[1] || null;
      break;
    }
  } catch {}
  rl.close();
  markerCache.set(filePath, { mtimeMs, id });
  return id;
}

// <projectDir>/<sessionId>/{subagents,tool-results}/... -> sessionId
function parentSession(filePath) {
  const parts = filePath.split(sep);
  const i = parts.findLastIndex((p) => p === "subagents" || p === "tool-results");
  return i > 0 ? parts[i - 1] : null;
}

// Pure-ish: recompute per-run totals from transcripts. -> Map runId -> {tokens, sessions, ts}
async function scanRuns(runs) {
  const out = new Map();
  if (!runs.length) return out;
  const since = Math.min(...runs.map((r) => r.at)) - 5 * 60_000;
  const wanted = new Set(runs.map((r) => r.id));
  const files = listSessionFiles();
  const bySession = new Map(); // sessionId -> runId
  const mains = [];
  for (const f of files) {
    if (f.kind !== "session") continue;
    let st;
    try {
      st = statSync(f.filePath);
    } catch {
      continue;
    }
    if (st.mtimeMs < since) continue;
    const runId = await markerOf(f.filePath, st.mtimeMs);
    if (!runId || !wanted.has(runId)) continue;
    const sid = basename(f.filePath, ".jsonl");
    bySession.set(sid, runId);
    mains.push({ ...f, runId, sid });
  }
  const members = [...mains];
  for (const f of files) {
    if (f.kind !== "subagent") continue;
    const runId = bySession.get(parentSession(f.filePath));
    if (runId) members.push({ ...f, runId, sid: parentSession(f.filePath) });
  }
  members.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "session" ? -1 : 1));
  const seen = new Set(); // message ids, main sessions win over subagent copies
  for (const m of members) {
    let turns;
    try {
      turns = await parseFileCached(m.filePath);
    } catch {
      continue;
    }
    const r = out.get(m.runId) || { tokens: 0, sessions: [], ts: 0 };
    if (!r.sessions.includes(m.sid)) r.sessions.push(m.sid);
    for (const t of turns) {
      if (t.id) {
        if (seen.has(t.id)) continue;
        seen.add(t.id);
      }
      r.tokens += tokenSum(t);
      r.ts = Math.max(r.ts, t.ts);
    }
    out.set(m.runId, r);
  }
  return out;
}

// Fold per-run totals into slug -> title -> {tokens, sessions, split, updatedAt}.
export function foldRuns(runs, totals) {
  const tasks = {};
  for (const run of runs) {
    const t = totals[run.id];
    if (!t || !t.tokens) continue;
    const n = run.todos.length;
    for (const todo of run.todos) {
      const e = ((tasks[todo.slug] ||= {})[todo.title] ||= { tokens: 0, sessions: [], split: false, updatedAt: null });
      e.tokens += Math.round(t.tokens / n);
      for (const s of t.sessions) if (!e.sessions.includes(s)) e.sessions.push(s);
      if (n > 1) e.split = true;
      const at = t.ts ? new Date(t.ts).toISOString() : null;
      if (at && (!e.updatedAt || at > e.updatedAt)) e.updatedAt = at;
    }
  }
  return tasks;
}

// Recompute + persist the sidecar. A run's stored total never shrinks (Claude Code
// prunes old transcripts; the sidecar is the durable record), so Done/old tasks keep theirs.
export async function refreshTaskTokens() {
  const runs = readRuns();
  const prev = readJson(TOKENS_FILE(), {}).runs || {};
  const scanned = await scanRuns(runs);
  const totals = {};
  for (const run of runs) {
    const s = scanned.get(run.id);
    const p = prev[run.id];
    if (s && (!p || s.tokens >= p.tokens)) totals[run.id] = { tokens: s.tokens, sessions: s.sessions, ts: s.ts };
    else if (p) totals[run.id] = p;
  }
  const tasks = foldRuns(runs, totals);
  const next = { runs: totals, tasks };
  if (JSON.stringify(next) !== JSON.stringify({ runs: prev, tasks: readJson(TOKENS_FILE(), {}).tasks })) writeJson(TOKENS_FILE(), next);
  return tasks;
}

export function readTaskTokens() {
  return readJson(TOKENS_FILE(), {}).tasks || {};
}

let memo = { at: 0, p: null };
export function taskTokens({ maxAgeMs = 10_000 } = {}) {
  if (memo.p && Date.now() - memo.at < maxAgeMs) return memo.p;
  const p = refreshTaskTokens().catch(() => readTaskTokens());
  memo = { at: Date.now(), p };
  return p;
}
