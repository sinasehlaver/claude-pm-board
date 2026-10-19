// Claude Code spend, matching the ccusage-based statusline (usage.py math + subagents + local days): USD for the
// current 5h block, today and the last 7 local days, from ~/.claude/projects
// transcripts (subagents included). Costs are an estimate from PRICING (USD per million
// tokens) — edit it when rates change.
import fs from "node:fs";
import path from "node:path";
import { projectsRoot } from "./usage.mjs";

export const PRICING = {
  "claude-fable-5-1": { input: 10.0, output: 50.0, cache_write_5m: 12.5, cache_write_1h: 20.0, cache_read: 0.25 },
  "claude-opus-5-5": { input: 4.0, output: 20.0, cache_write_5m: 5.0, cache_write_1h: 8.0, cache_read: 0.2 },
  "claude-sonnet-5-5": { input: 2.0, output: 10.0, cache_write_5m: 2.5, cache_write_1h: 4.0, cache_read: 0.1 },
  "claude-haiku-5-5": { input: 0.5, output: 2.5, cache_write_5m: 0.625, cache_write_1h: 1.0, cache_read: 0.05 },
  other: { input: 3.0, output: 15.0, cache_write_5m: 3.75, cache_write_1h: 6.0, cache_read: 0.3 },
};

const HOUR = 3600e3;
const DAY = 24 * HOUR;
const CACHE_MS = 30_000;

function messageCost(m) {
  const u = m.usage;
  const r = PRICING[m.model] || PRICING.other;
  const cc = u.cache_creation || {};
  return (
    ((u.input_tokens || 0) * r.input +
      (u.output_tokens || 0) * r.output +
      (u.cache_read_input_tokens || 0) * r.cache_read +
      (cc.ephemeral_1h_input_tokens || 0) * r.cache_write_1h +
      (cc.ephemeral_5m_input_tokens || 0) * r.cache_write_5m) /
    1e6
  );
}

function sessionFiles(root, now) {
  const files = [];
  const walk = (dir) => {
    let ents;
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".jsonl")) {
        try {
          if (fs.statSync(p).mtimeMs >= now - 8 * DAY) files.push(p);
        } catch {}
      }
    }
  };
  walk(root);
  return files;
}

// ccusage (what the statusline runs) buckets days in local time.
const localDay = (ms) => {
  const d = new Date(ms);
  return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY);
};

// path -> { mtimeMs, size, rows: [[id, ts, cost]] }; unchanged transcripts are never re-read or re-parsed
// (a cold scan of ~500 files took ~800ms of blocked event loop, which stalled every request).
const fileRows = new Map();

function rowsOf(p) {
  let st;
  try {
    st = fs.statSync(p);
  } catch {
    return [];
  }
  const hit = fileRows.get(p);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.rows;
  let text;
  try {
    text = fs.readFileSync(p, "utf8");
  } catch {
    return [];
  }
  const rows = [];
  for (const line of text.split("\n")) {
    if (!line || !line.includes('"usage"')) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const m = o?.message;
    const ts = Date.parse(o?.timestamp);
    if (!m?.usage || Number.isNaN(ts)) continue;
    rows.push([m.id, ts, messageCost(m)]);
  }
  fileRows.set(p, { mtimeMs: st.mtimeMs, size: st.size, rows });
  return rows;
}

export function statuslineUsage(now = Date.now()) {
  const weekStart = localDay(now) - 6;
  const seen = new Set();
  const msgs = []; // [ts, cost]
  const files = sessionFiles(projectsRoot(), now);
  for (const k of fileRows.keys()) if (!files.includes(k)) fileRows.delete(k);
  for (const p of files) {
    for (const [id, ts, cost] of rowsOf(p)) {
      if (localDay(ts) < weekStart || (id && seen.has(id))) continue;
      seen.add(id);
      msgs.push([ts, cost]);
    }
  }
  msgs.sort((a, b) => a[0] - b[0]);

  let blockStart = null;
  let block = 0;
  let last = now;
  for (const [ts, c] of msgs) {
    if (blockStart === null || ts >= blockStart + 5 * HOUR || ts - last >= 5 * HOUR) {
      blockStart = Math.floor(ts / HOUR) * HOUR;
      block = 0;
    }
    block += c;
    last = ts;
  }
  const active = blockStart !== null && now < blockStart + 5 * HOUR && now - last < 5 * HOUR;
  const today = msgs.reduce((s, [ts, c]) => (localDay(ts) === localDay(now) ? s + c : s), 0);
  const week = msgs.reduce((s, [, c]) => s + c, 0);
  return {
    block: active ? block : 0,
    today,
    week,
    blockEndsAt: active ? new Date(blockStart + 5 * HOUR).toISOString() : null,
    updatedAt: new Date(now).toISOString(),
  };
}

let cached = null;
export function statuslineUsageCached(now = Date.now()) {
  if (!cached || now - cached.at > CACHE_MS) cached = { at: now, value: statuslineUsage(now) };
  return cached.value;
}
