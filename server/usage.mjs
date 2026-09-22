// Local Claude Code usage / burn-rate. Reuses the *mechanics* of two sibling
// projects (never the apps themselves — pm can't assume either is installed):
//   - claude_usage_dashboard/server/parse.js: per-turn token parsing, the
//     1h/5m cache-write split, subagent/tool-results transcripts, cross-file
//     message.id dedupe (main sessions win ties over subagent copies).
//   - continuous/src/usage.mjs: rolling 1h/5h/7d "burn" windows over the same
//     turns, which is what "burn rate" means in this workspace (rate-limit
//     consumption, not just $ cost).
// Reads directly from ~/.claude/projects — NOT PM_ROOT-scoped, since usage is
// account-wide, not per-workspace.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";

// Overridable for tests only — real usage is always the actual account-wide log dir.
// Read via env lookup (not a frozen module-level const) so tests can point at a
// different fixture file per-test without re-importing the module.
const projectsRoot = () => process.env.CLAUDE_PROJECTS_ROOT || path.join(os.homedir(), ".claude", "projects");
const statusCachePath = () =>
  process.env.CLAUDE_STATUS_CACHE || path.join(os.homedir(), ".claude", "vscode-claude-status-cache.json");
const usageLimitsPath = () =>
  process.env.PM_USAGE_LIMITS_PATH || path.join(os.homedir(), ".claude", "pm-usage-limits.json");
const STALE_MS = 15 * 60_000;

// The three rate-limit windows the ceiling UI tracks. rateLimitType is what a
// real quotaLimits rejection (see scanQuotaRejections) would carry for that
// window — Anthropic has no published 30-day tier, so "thirty_day" realistically
// never appears and that window stays on its placeholder/manual cap forever,
// which is expected, not a bug.
const WINDOWS = [
  { key: "5h", ms: 5 * 3600e3, fallbackCap: 25_000_000, rateLimitType: "five_hour" },
  { key: "7d", ms: 7 * 24 * 3600e3, fallbackCap: 200_000_000, rateLimitType: "seven_day" },
  { key: "30d", ms: 30 * 24 * 3600e3, fallbackCap: 800_000_000, rateLimitType: "thirty_day" },
];
const WINDOW_KEYS = WINDOWS.map((w) => w.key);
const MODES = ["synced", "estimated", "manual"];

function emptyTokens() {
  return { input: 0, output: 0, cache_read: 0, cache_creation_1h: 0, cache_creation_5m: 0 };
}

// Billable weight for one turn's tokens — matches continuous/src/usage.mjs's
// turnTokens(): rate limits bill cache_read + cache writes too, not just input/output.
function tokenSum(t) {
  return t.input + t.output + t.cache_read + t.cache_creation_1h + t.cache_creation_5m;
}

function* collectJsonlDeep(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (ent.name.startsWith(".")) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) yield* collectJsonlDeep(full);
    else if (ent.isFile() && ent.name.endsWith(".jsonl")) yield full;
  }
}

function listSessionFiles() {
  const files = [];
  const root = projectsRoot();
  if (!fs.existsSync(root)) return files;
  for (const projectDir of fs.readdirSync(root)) {
    const fullDir = path.join(root, projectDir);
    if (!fs.statSync(fullDir).isDirectory()) continue;
    for (const entry of fs.readdirSync(fullDir)) {
      if (entry.startsWith(".")) continue;
      const entryPath = path.join(fullDir, entry);
      const st = fs.statSync(entryPath);
      if (st.isFile() && entry.endsWith(".jsonl")) {
        files.push({ filePath: entryPath, kind: "session" });
        continue;
      }
      if (st.isDirectory()) {
        for (const sub of ["subagents", "tool-results"]) {
          const subDir = path.join(entryPath, sub);
          if (!fs.existsSync(subDir)) continue;
          for (const filePath of collectJsonlDeep(subDir)) files.push({ filePath, kind: "subagent" });
        }
      }
    }
  }
  return files;
}

async function parseFile(filePath) {
  const turns = [];
  // Streaming assistant turns write the SAME message.id multiple times as the
  // response fills in, each with a growing usage.output_tokens (e.g. 7, then
  // 447 tokens for the identical id) — the LAST line for an id carries the
  // final, complete usage. Index by id so a later line for the same id
  // overwrites (not skips) the earlier partial one; keeping the first-seen
  // copy silently undercounted output tokens on every streamed turn.
  const indexById = new Map();
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.type !== "assistant" || !o.message?.usage) continue;
    const id = o.message.id || null;
    const ts = o.timestamp ? Date.parse(o.timestamp) : NaN;
    if (Number.isNaN(ts)) continue;
    const usage = o.message.usage;
    const tokens = emptyTokens();
    tokens.input = usage.input_tokens || 0;
    tokens.output = usage.output_tokens || 0;
    tokens.cache_read = usage.cache_read_input_tokens || 0;
    tokens.cache_creation_1h = usage.cache_creation?.ephemeral_1h_input_tokens || 0;
    tokens.cache_creation_5m = usage.cache_creation?.ephemeral_5m_input_tokens || 0;
    const turn = { id, ts, model: o.message.model || "unknown", ...tokens };
    if (id && indexById.has(id)) {
      turns[indexById.get(id)] = turn;
    } else {
      if (id) indexById.set(id, turns.length);
      turns.push(turn);
    }
  }
  return turns;
}

// filePath -> { mtimeMs, turns }; only re-parses files that changed since last read.
const fileCache = new Map();

async function parseFileCached(filePath) {
  const mtimeMs = fs.statSync(filePath).mtimeMs;
  const hit = fileCache.get(filePath);
  if (hit && hit.mtimeMs === mtimeMs) return hit.turns;
  const turns = await parseFile(filePath);
  fileCache.set(filePath, { mtimeMs, turns });
  return turns;
}

export async function allTurns() {
  const files = listSessionFiles();
  // sessions before subagents, so a message.id that appears in both keeps the
  // main-session copy and drops the subagent duplicate (never double-counted).
  files.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "session" ? -1 : 1));

  const globalSeen = new Set();
  const turns = [];
  for (const { filePath, kind } of files) {
    let fileTurns;
    try {
      fileTurns = await parseFileCached(filePath);
    } catch {
      continue;
    }
    for (const t of fileTurns) {
      if (t.id) {
        if (globalSeen.has(t.id)) continue;
        globalSeen.add(t.id);
      }
      turns.push(t);
    }
  }
  return turns;
}

// Rolling-window burn snapshot — same windows continuous/src/pace.mjs paces
// "Run @seq" batches against, but computed independently here so this panel
// works even when the continuous/ project isn't present on this machine.
export async function burnSnapshot(now = Date.now()) {
  const turns = await allTurns();
  const sumSince = (ms) => {
    let s = 0;
    for (const t of turns) if (t.ts >= ms) s += tokenSum(t);
    return s;
  };
  return {
    now,
    used_1h: sumSince(now - 3600e3),
    used_5h: sumSince(now - 5 * 3600e3),
    used_7d: sumSince(now - 7 * 24 * 3600e3),
  };
}

// Groups `turns` into rows keyed by (groupKey(turn), model), summing token
// fields — shared by summary()'s day/hour buckets and burnBreakdown()'s
// rolling windows so both report the same per-model token shape (the shape
// web/src/pricing.js's costFor()/tokensFor() expect).
function groupByModel(turns, groupKeyFor) {
  const buckets = new Map();
  for (const t of turns) {
    const key = groupKeyFor(t);
    if (key == null) continue;
    const groupKey = `${key}::${t.model}`;
    if (!buckets.has(groupKey)) {
      buckets.set(groupKey, {
        bucket: key,
        model: t.model,
        input: 0,
        output: 0,
        cache_read: 0,
        cache_creation_1h: 0,
        cache_creation_5m: 0,
      });
    }
    const b = buckets.get(groupKey);
    b.input += t.input;
    b.output += t.output;
    b.cache_read += t.cache_read;
    b.cache_creation_1h += t.cache_creation_1h;
    b.cache_creation_5m += t.cache_creation_5m;
  }
  return Array.from(buckets.values()).sort((a, b) => a.bucket.localeCompare(b.bucket));
}

// Per-bucket, per-model token breakdown — the mechanics behind
// claude_usage_dashboard's /api/summary, ported so pm never needs that app running.
export async function summary({ bucket = "day", days = 14 } = {}) {
  const turns = await allTurns();
  const since = Date.now() - days * 24 * 3600e3;
  return groupByModel(
    turns.filter((t) => t.ts >= since),
    (t) => (bucket === "hour" ? new Date(t.ts).toISOString().slice(0, 13) : new Date(t.ts).toISOString().slice(0, 10)),
  );
}

// Per-model token rows for each of the three rolling burn windows — lets the
// client compute a $ estimate (web/src/pricing.js) for the same 1h/5h/7d
// numbers burnSnapshot() sums as raw tokens, without pm doing cost math itself.
export async function burnBreakdown(now = Date.now()) {
  const turns = await allTurns();
  const windows = { win1h: now - 3600e3, win5h: now - 5 * 3600e3, win7d: now - 7 * 24 * 3600e3 };
  const out = {};
  for (const [key, since] of Object.entries(windows)) {
    out[key] = groupByModel(
      turns.filter((t) => t.ts >= since),
      () => "w",
    );
  }
  return out;
}

// The 1h/5h/7d windows above are SUMS — a burst from an hour ago stays fully
// counted until it ages out, which reads as "stuck" the moment you actually
// stop. This is the fast-responding companion: tokens seen in just the last
// PACE_WINDOW_MS, in the same per-model row shape (client extrapolates to a
// per-hour rate by scaling by 3600e3/PACE_WINDOW_MS, same as it already does
// cost math via pricing.js — no separate pace-specific client code needed).
export const PACE_WINDOW_MS = 5 * 60_000;

export async function paceBreakdown(now = Date.now(), windowMs = PACE_WINDOW_MS) {
  const turns = await allTurns();
  const since = now - windowMs;
  return groupByModel(
    turns.filter((t) => t.ts >= since),
    () => "w",
  );
}

// Real throttle events Claude Code itself records on a session's assistant
// turn when a request is rejected: { status:"rejected", rateLimitType:
// "five_hour"|"seven_day", resetsAt:<unix s> }. Definitive "we got throttled"
// signal, independent of whatever client (VS Code, terminal, pm) sent the
// request. Ported from continuous/src/limits.mjs's scanRejections/calibrateCaps.
async function scanQuotaRejections(sinceMs) {
  const hits = [];
  for (const { filePath } of listSessionFiles()) {
    let mtimeMs;
    try {
      mtimeMs = fs.statSync(filePath).mtimeMs;
    } catch {
      continue;
    }
    if (mtimeMs < sinceMs) continue;
    let text;
    try {
      text = fs.readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line.includes('"quotaLimits"')) continue;
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      const q = o.quotaLimits;
      if (!q || q.status !== "rejected") continue;
      const ts = o.timestamp ? Date.parse(o.timestamp) : NaN;
      if (Number.isNaN(ts) || ts < sinceMs) continue;
      hits.push({ ts, resetsAt: q.resetsAt, rateLimitType: q.rateLimitType });
    }
  }
  return hits;
}

// The real cap = rolling-window token sum at the moment a throttle of that
// type fired, learned once from up to 60d of history; falls back to the
// placeholder for a window that's never actually been hit. Returns one entry
// per WINDOWS key: { cap, learned }.
export async function learnedCaps(now = Date.now()) {
  const rejections = await scanQuotaRejections(now - 60 * 24 * 3600e3);
  const turns = rejections.length ? await allTurns() : [];
  const out = {};
  for (const w of WINDOWS) {
    const hits = rejections.filter((r) => r.rateLimitType === w.rateLimitType);
    if (!hits.length) {
      out[w.key] = { cap: w.fallbackCap, learned: false };
      continue;
    }
    let cap = 0;
    for (const r of hits) {
      let s = 0;
      for (const t of turns) if (t.ts >= r.ts - w.ms && t.ts <= r.ts) s += tokenSum(t);
      cap = Math.max(cap, s);
    }
    out[w.key] = cap > 0 ? { cap, learned: true } : { cap: w.fallbackCap, learned: false };
  }
  return out;
}

// User-editable per-window settings, persisted outside PM_ROOT (usage is
// account-wide, matches the rest of this file) so they're stable across pm
// restarts and don't get silently overridden by auto-detection once set.
//   mode: "synced" (real VS Code cache % when live, else unavailable — 30d
//     has no cache field so is always unavailable here) | "estimated"
//     (token burn against learnedCaps()) | "manual" (token burn against a
//     user-entered cap, never touched by auto-detection).
function defaultLimitsConfig() {
  const cfg = {};
  for (const key of WINDOW_KEYS) cfg[key] = { mode: "estimated", manualCapTokens: null };
  return cfg;
}

export function readUsageLimitsConfig() {
  const cfg = defaultLimitsConfig();
  let raw;
  try {
    raw = fs.readFileSync(usageLimitsPath(), "utf8");
  } catch {
    return cfg;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return cfg;
  }
  for (const key of WINDOW_KEYS) {
    const w = parsed?.[key];
    if (!w || typeof w !== "object") continue;
    if (MODES.includes(w.mode)) cfg[key].mode = w.mode;
    if (typeof w.manualCapTokens === "number" && w.manualCapTokens > 0) cfg[key].manualCapTokens = w.manualCapTokens;
  }
  return cfg;
}

// Merges one window's { mode, manualCapTokens } into the persisted config —
// the other windows' settings are untouched (read-modify-write, single file).
export function writeUsageLimitsWindow(key, patch) {
  if (!WINDOW_KEYS.includes(key)) throw new Error(`unknown usage-limits window "${key}"`);
  if (patch.mode !== undefined && !MODES.includes(patch.mode)) throw new Error(`bad mode "${patch.mode}"`);
  const cfg = readUsageLimitsConfig();
  if (patch.mode !== undefined) cfg[key].mode = patch.mode;
  if (patch.manualCapTokens !== undefined) {
    cfg[key].manualCapTokens =
      patch.manualCapTokens == null || !(Number(patch.manualCapTokens) > 0) ? null : Number(patch.manualCapTokens);
  }
  const p = usageLimitsPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2));
  return cfg;
}

// Only meaningful once actually over the cap: projects the future moment your
// own historical turns would age out of the rolling window enough to bring
// the sum back at/under the cap, assuming zero further activity from now.
// This is NOT Anthropic's real reset clock (no such single moment exists for
// a pure rolling window below the cap) — a local projection, always surfaced
// to the client labeled "estimated"/"projected", never confused with the
// genuine resetsAt the VS Code cache reports when it's live.
function projectedResetMs(turns, now, windowMs, usedTokens, cap) {
  if (usedTokens <= cap) return null;
  const inWindow = turns.filter((t) => t.ts >= now - windowMs && t.ts <= now).sort((a, b) => a.ts - b.ts);
  let remaining = usedTokens;
  for (const t of inWindow) {
    remaining -= tokenSum(t);
    if (remaining <= cap) return t.ts + windowMs;
  }
  return null;
}

// Cache-reported %/reset for a window, only when the cache is fresh and
// actually looks like it's seen a real request — a fresh *timestamp* with 0%
// doesn't mean the account is idle, it means nothing VS-Code-routed has
// happened lately (terminal sessions, incl. pm's own launch buttons, never
// touch this file — confirmed the CLI binary itself contains no code that
// writes it, it's extension-only).
function liveCacheFor(cache, key) {
  if (!cache || cache.stale) return null;
  if (key === "5h") return { utilization: cache.utilization5h, resetAt: cache.reset5hAt };
  if (key === "7d") return { utilization: cache.utilization7d, resetAt: cache.reset7dAt };
  return null; // the cache has no 30d field at all
}

// Account-wide rate-limit ceiling for all three windows, each independently
// resolved per its configured mode (readUsageLimitsConfig/writeUsageLimitsWindow):
//   "synced"    — the VS Code cache's real %/reset when live (same numbers
//                 claude.ai's Usage page shows); otherwise reported
//                 unavailable rather than silently substituting an estimate.
//   "estimated" — local token burn against learnedCaps() (learned from a real
//                 throttle, else a placeholder), with a *projected* reset.
//   "manual"    — token burn against a user-entered cap that never changes on
//                 its own (set it once via writeUsageLimitsWindow and it stays
//                 exactly as set until edited again). Same rolling-sum math as
//                 estimated — an earlier version reconstructed Anthropic's
//                 rate-limit windows as a fixed reset grid instead, which
//                 looked plausible in isolation but measurably undercounted
//                 against real references (claude.ai's own Usage page,
//                 claude_usage_dashboard): rolling sum is what actually
//                 tracks them.
export async function accountRateLimitStatus(now = Date.now()) {
  const cache = rateLimitStatus();
  const cfg = readUsageLimitsConfig();
  const [turns, caps] = await Promise.all([allTurns(), learnedCaps(now)]);
  const sumSince = (ms) => {
    let s = 0;
    for (const t of turns) if (t.ts >= ms) s += tokenSum(t);
    return s;
  };

  const windows = {};
  for (const w of WINDOWS) {
    const used = sumSince(now - w.ms);
    const mode = cfg[w.key].mode;
    let entry;

    if (mode === "synced") {
      const live = liveCacheFor(cache, w.key);
      if (live && live.utilization != null) {
        const capTokens = caps[w.key].cap; // Anthropic gives % only — back tokens out for display
        entry = {
          available: true,
          utilization: live.utilization,
          capTokens,
          usedTokens: Math.round((live.utilization / 100) * capTokens),
          resetAt: live.resetAt,
          resetProjected: false,
          limitStatus: cache.limitStatus,
        };
      } else {
        entry = { available: false, utilization: null, capTokens: null, usedTokens: used, resetAt: null, resetProjected: false, limitStatus: null };
      }
    } else if (mode === "manual") {
      // Previously computed against a reconstructed Anthropic fixed reset
      // grid (see git history / removed fixedGridBlock/fixedWindowUsage).
      // That theory read believable in isolation but under real comparison —
      // claude.ai's own Usage page and the separate claude_usage_dashboard
      // app — it undercounted: e.g. it reported 5h at 55% while claude.ai
      // reported 99%, because the reconstructed "current block" doesn't
      // reliably track when Anthropic's real window opened (its start can
      // only be pinned exactly at a real quotaLimits rejection, which is
      // rare). The plain rolling sum below, checked against both of those
      // real references, tracks them far more closely. Manual mode is now
      // just "estimated mode's math against a cap you type in yourself."
      const capTokens = cfg[w.key].manualCapTokens;
      if (capTokens) {
        const r = projectedResetMs(turns, now, w.ms, used, capTokens);
        entry = {
          available: true,
          utilization: Math.round((used / capTokens) * 100),
          capTokens,
          usedTokens: used,
          resetAt: r ? new Date(r).toISOString() : null,
          resetProjected: true,
          limitStatus: null,
        };
      } else {
        entry = { available: false, utilization: null, capTokens: null, usedTokens: used, resetAt: null, resetProjected: true, limitStatus: null };
      }
    } else {
      const capTokens = caps[w.key].cap;
      const r = projectedResetMs(turns, now, w.ms, used, capTokens);
      entry = {
        available: true,
        utilization: Math.round((used / capTokens) * 100),
        capTokens,
        usedTokens: used,
        resetAt: r ? new Date(r).toISOString() : null,
        resetProjected: true,
        limitStatus: null,
      };
    }

    windows[w.key] = { mode, capLearned: caps[w.key].learned, ...entry };
  }

  return { updatedAt: cache?.updatedAt ?? null, cacheStale: cache?.stale ?? null, windows };
}

// Account-wide rate-limit ceiling (VS Code extension's own cache file) — a
// cross-check on top of the token-based burn numbers above, not a replacement:
// it reports %-of-limit, not tokens, and goes stale fast when Code isn't running.
export function rateLimitStatus() {
  let raw;
  try {
    raw = fs.readFileSync(statusCachePath(), "utf8");
  } catch {
    return null;
  }
  let j;
  try {
    j = JSON.parse(raw);
  } catch {
    return null;
  }
  const u = j.usageData || {};
  const updatedAt = j.updatedAt || null;
  const stale = !updatedAt || Date.now() - Date.parse(updatedAt) > STALE_MS;
  // reset*At look like unix seconds (fractional) rather than ms — normalize.
  const toIso = (v) => (v ? new Date(v > 1e12 ? v : v * 1000).toISOString() : null);
  return {
    updatedAt,
    stale,
    utilization5h: u.utilization5h ?? null,
    utilization7d: u.utilization7d ?? null,
    limitStatus: u.limitStatus ?? null,
    reset5hAt: toIso(u.reset5hAt),
    reset7dAt: toIso(u.reset7dAt),
  };
}

// Check if utilization is already high before starting a batch run.
// Mirrors the relay's soft-stop thresholds (PM_RELAY_STOP_5H=0.95, PM_RELAY_STOP_7D=0.97).
// Returns null if launch is safe, or { window, utilization, resetAt } if too high.
export async function checkPreLaunchUtilization(thresholds = { "5h": 0.95, "7d": 0.97 }) {
  try {
    const status = await accountRateLimitStatus();
    for (const [windowKey, threshold] of Object.entries(thresholds)) {
      const entry = status.windows?.[windowKey];
      if (entry?.available && entry.utilization != null && entry.utilization >= threshold * 100) {
        return { window: windowKey, utilization: entry.utilization, resetAt: entry.resetAt };
      }
    }
  } catch {
    // On error, allow launch to proceed (don't block on usage check failure)
  }
  return null;
}
