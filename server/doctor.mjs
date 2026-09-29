// "Doctor": routine, LLM-free efficiency scan over Claude Code transcripts for
// this workspace (~/.claude/projects/<escaped PM_ROOT>*/**.jsonl + subagents).
// Reuses usage.mjs's file discovery + token weighting. Emits text findings only —
// it never edits CLAUDE.md / memory / rules / settings.
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { PM_ROOT, PM_DIR } from "./paths.mjs";
import { projectsRoot, listSessionFiles, tokenSum } from "./usage.mjs";

export const DOCTOR_FILE = () => path.join(PM_DIR, "doctor.json");
const escapePath = (p) => p.replace(/[^a-zA-Z0-9]/g, "-");
const BIG_READ_CHARS = 40_000; // ~10k tokens
const BIG_RESULT_CHARS = 60_000;
const CACHE_MISS_TOKENS = 30_000;
const LONG_SESSION_TURNS = 150;
const FANOUT_MIN = 5;
const REPEAT_FAIL_MIN = 3;
const PERMISSION_RE = /requested permissions|doesn't want to proceed|was blocked|permission (was )?denied|not allowed to use|hook.*denied|sensitive file/i;
const RATE_RE = /rate.?limit|429|overloaded|usage limit|529/i;
const SHELL_READ_RE = /^\s*(cat|head|tail|grep|rg|find|ls|sed|awk)\b/;

const sizeOf = (c) => {
  if (c == null) return 0;
  if (typeof c === "string") return c.length;
  if (Array.isArray(c)) return c.reduce((n, b) => n + (typeof b === "string" ? b.length : (b?.text?.length ?? 0) + (b?.type === "image" ? 2000 : 0)), 0);
  return JSON.stringify(c).length;
};
const textOf = (c) =>
  typeof c === "string" ? c : Array.isArray(c) ? c.map((b) => (typeof b === "string" ? b : b?.text ?? "")).join(" ") : "";
const short = (s, n = 140) => String(s).replace(/\s+/g, " ").trim().slice(0, n);
const bump = (m, k, by = 1) => m.set(k, (m.get(k) || 0) + by);
const fmt = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? Math.round(n / 1e3) + "k" : String(n));
const sid8 = (id) => String(id).slice(0, 8);

function sessionIdFor(filePath, kind) {
  if (kind === "session") return path.basename(filePath, ".jsonl");
  const parts = filePath.split(path.sep);
  const i = parts.lastIndexOf("subagents");
  return i > 0 ? parts[i - 1] : path.basename(filePath, ".jsonl");
}

async function scanFile(filePath, kind, agg, seenIds, sinceMs) {
  const sid = sessionIdFor(filePath, kind);
  const s =
    agg.sessions.get(sid) ||
    { id: sid, tokens: 0, uncached: 0, output: 0, turns: 0, first: null, last: null, compactions: 0, subTokens: 0, subFiles: 0, subModels: new Set(), errors: 0, missTurns: 0, title: null };
  agg.sessions.set(sid, s);
  if (kind === "subagent") s.subFiles++;

  const uses = new Map(); // tool_use id -> {name, input}
  const turnsById = new Map();
  const rl = readline.createInterface({ input: fs.createReadStream(filePath, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = o.timestamp ? Date.parse(o.timestamp) : NaN;
    if (!Number.isNaN(ts) && ts < sinceMs) continue;
    if (!Number.isNaN(ts)) {
      s.first = s.first == null ? ts : Math.min(s.first, ts);
      s.last = s.last == null ? ts : Math.max(s.last, ts);
    }
    if (o.type === "ai-title" && o.aiTitle) s.title = o.aiTitle;
    if (o.type === "system" && (o.subtype === "compact_boundary" || o.compactMetadata)) s.compactions++;
    if (o.type === "user" && o.isCompactSummary) s.compactions++;
    if (o.type === "system" && /api_error|api_retry/.test(o.subtype || "")) {
      agg.apiErrors.push({ sid, text: short(o.error?.message || o.content || o.subtype), rate: RATE_RE.test(JSON.stringify(o.error || o.content || "")) });
    }
    if (o.type === "assistant" && o.message) {
      const m = o.message;
      if (o.isApiErrorMessage) {
        const t = short(textOf(m.content));
        agg.apiErrors.push({ sid, text: t, rate: RATE_RE.test(t) });
        continue;
      }
      if (m.usage) {
        const u = m.usage;
        const t = {
          input: u.input_tokens || 0,
          output: u.output_tokens || 0,
          cr: u.cache_read_input_tokens || 0,
          cw: (u.cache_creation?.ephemeral_1h_input_tokens || 0) + (u.cache_creation?.ephemeral_5m_input_tokens || 0) || u.cache_creation_input_tokens || 0,
          model: m.model || "unknown",
        };
        if (m.id) turnsById.set(m.id, t);
        else turnsById.set(Symbol(), t);
      }
      if (Array.isArray(m.content)) {
        for (const b of m.content) {
          if (b?.type !== "tool_use") continue;
          uses.set(b.id, { name: b.name, input: b.input || {}, sid, sub: kind === "subagent" });
          bump(agg.toolCalls, b.name);
          if (b.name === "Bash" && SHELL_READ_RE.test(b.input?.command || "")) {
            agg.shellReads.n++;
            agg.shellReads.sids.add(sid);
          }
          if (b.name === "Task" || b.name === "Agent") {
            s.spawned = (s.spawned || 0) + 1;
            const model = b.input?.model;
            if (!model) agg.subNoModel++;
            agg.spawns.push({ sid, type: b.input?.subagent_type || "general", model: model || null });
          }
        }
      }
    }
    if (o.type === "user" && Array.isArray(o.message?.content)) {
      for (const b of o.message.content) {
        if (b?.type !== "tool_result") continue;
        const use = uses.get(b.tool_use_id) || { name: "unknown", input: {}, sid };
        const chars = sizeOf(b.content);
        bump(agg.toolChars, use.name, chars);
        if (chars >= BIG_RESULT_CHARS) agg.bigResults.push({ sid, name: use.name, chars, target: short(use.input.file_path || use.input.command || use.input.pattern || "", 100) });
        if (use.name === "Read" && chars >= BIG_READ_CHARS && !use.input.limit) agg.bigReads.push({ sid, file: use.input.file_path || "?", chars });
        if (b.is_error) {
          const txt = short(textOf(b.content));
          s.errors++;
          bump(agg.errByTool, use.name);
          const denied = PERMISSION_RE.test(txt);
          if (denied) agg.denials.push({ sid, tool: use.name, text: txt, target: short(use.input.command || use.input.file_path || "", 100) });
          const key = use.name + "|" + short(JSON.stringify(use.input), 200);
          const r = agg.repeats.get(key) || { tool: use.name, sids: new Set(), n: 0, sample: txt, target: short(use.input.command || use.input.file_path || use.input.pattern || "", 100) };
          r.n++;
          r.sids.add(sid);
          agg.repeats.set(key, r);
          if (RATE_RE.test(txt) && !denied) agg.apiErrors.push({ sid, text: txt, rate: true });
        }
      }
    }
  }
  for (const [id, t] of turnsById) {
    if (typeof id === "string") {
      if (seenIds.has(id)) continue; // main-session copy wins (sessions scanned first)
      seenIds.add(id);
    }
    const sum = tokenSum({ input: t.input, output: t.output, cache_read: t.cr, cache_creation_1h: t.cw, cache_creation_5m: 0 });
    s.tokens += sum;
    s.output += t.output;
    s.uncached += t.input + t.cw;
    s.turns++;
    bump(agg.byModel, t.model, sum);
    if (kind === "subagent") {
      s.subTokens += sum;
      s.subModels.add(t.model);
    }
    if (t.input + t.cw >= CACHE_MISS_TOKENS && t.cr < (t.input + t.cw) * 0.25) {
      s.missTurns++;
      agg.missTurns.push({ sid, uncached: t.input + t.cw });
    }
  }
}

function findings(agg, days) {
  const out = [];
  const add = (f) => out.push(f);
  const sessions = [...agg.sessions.values()].filter((s) => s.tokens > 0 || s.errors > 0);
  const total = sessions.reduce((n, s) => n + s.tokens, 0);
  const ids = (list, n = 5) => [...new Set(list)].slice(0, n).map(sid8);

  // (a) errors
  const sortedRepeats = [...agg.repeats.values()].filter((r) => r.n >= REPEAT_FAIL_MIN).sort((a, b) => b.n - a.n);
  for (const [i, r] of sortedRepeats.slice(0, 3).entries()) {
    add({
      id: `repeat-fail-${i + 1}`,
      severity: r.n >= 8 ? "high" : "medium",
      title: `${r.tool} failed ${r.n}x with identical input`,
      evidence: { sessions: ids(r.sids), count: r.n, tool: r.tool, target: r.target, sample: r.sample },
      suggestion: `Identical retries of a failing ${r.tool} call burn tokens for nothing. Add a rule: after one failure, diagnose (read the error, check path/permissions) instead of retrying the same call.`,
      target: "CLAUDE.md",
    });
  }
  if (agg.denials.length) {
    const byTool = new Map();
    for (const d of agg.denials) bump(byTool, d.tool);
    const top = [...byTool.entries()].sort((a, b) => b[1] - a[1]);
    add({
      id: "permission-denials",
      severity: agg.denials.length >= 10 ? "high" : "medium",
      title: `${agg.denials.length} permission denials/blocks`,
      evidence: { sessions: ids(agg.denials.map((d) => d.sid)), count: agg.denials.length, byTool: Object.fromEntries(top.slice(0, 5)), samples: agg.denials.slice(0, 3).map((d) => `${d.tool}: ${d.target || d.text}`) },
      suggestion: "Allowlist the safe, repeated commands in settings.json permissions (or run /fewer-permission-prompts). For headless relay runs, route .claude/** edits through server/backlog-cli.mjs.",
      target: "settings",
    });
  }
  if (agg.apiErrors.length) {
    const rate = agg.apiErrors.filter((e) => e.rate).length;
    add({
      id: "api-errors",
      severity: rate ? "high" : "medium",
      title: `${agg.apiErrors.length} API errors (${rate} rate-limit/overload)`,
      evidence: { sessions: ids(agg.apiErrors.map((e) => e.sid)), count: agg.apiErrors.length, rateLimit: rate, sample: agg.apiErrors[0].text },
      suggestion: rate
        ? "Rate limits hit: cap concurrent subagents (<=3), prefer smaller models for fan-out, and run big batches via the unattended relay so it can wait out the window."
        : "Investigate the API errors in the listed sessions; transient ones need no rule, systematic ones (context too long, bad tool schema) should be noted in the project's rules file.",
      target: rate ? "rules" : "memory",
    });
  }
  const errTotal = [...agg.errByTool.values()].reduce((a, b) => a + b, 0);
  const worstTool = [...agg.errByTool.entries()].sort((a, b) => b[1] - a[1])[0];
  if (errTotal >= 10 && worstTool) {
    add({
      id: "tool-error-hotspot",
      severity: "low",
      title: `${errTotal} tool errors; most from ${worstTool[0]} (${worstTool[1]})`,
      evidence: { count: errTotal, byTool: Object.fromEntries([...agg.errByTool.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)) },
      suggestion: `Look at the most common ${worstTool[0]} failure and record the fix as a gotcha in .claude/rules/ or memory so sessions stop rediscovering it.`,
      target: "rules",
    });
  }

  // (b) token spend
  const topSessions = [...sessions].sort((a, b) => b.tokens - a.tokens).slice(0, 5);
  if (topSessions[0] && total > 0 && topSessions[0].tokens / total >= 0.3 && sessions.length > 1) {
    const t = topSessions[0];
    add({
      id: "dominant-session",
      severity: "medium",
      title: `One session used ${Math.round((t.tokens / total) * 100)}% of ${fmt(total)} tokens`,
      evidence: { sessions: [sid8(t.id)], tokens: t.tokens, title: t.title, turns: t.turns, top: topSessions.map((x) => ({ id: sid8(x.id), tokens: x.tokens })) },
      suggestion: "Split long tasks into fresh sessions (handoff + /clear) so context is not re-read every turn.",
      target: "CLAUDE.md",
    });
  }
  const longNoCompact = sessions.filter((s) => s.turns >= LONG_SESSION_TURNS && s.compactions === 0).sort((a, b) => b.tokens - a.tokens);
  if (longNoCompact.length) {
    add({
      id: "long-no-compaction",
      severity: "medium",
      title: `${longNoCompact.length} long session(s) never compacted`,
      evidence: { sessions: longNoCompact.slice(0, 5).map((s) => sid8(s.id)), turns: longNoCompact.slice(0, 5).map((s) => s.turns), tokens: longNoCompact.reduce((n, s) => n + s.tokens, 0) },
      suggestion: `Sessions over ${LONG_SESSION_TURNS} turns with no /compact re-read a huge context every turn. Add a rule: /compact or hand off at ~100 turns or a phase boundary.`,
      target: "CLAUDE.md",
    });
  }
  const bigReadTotal = agg.bigReads.reduce((n, r) => n + r.chars, 0);
  if (agg.bigReads.length >= 3) {
    const byFile = new Map();
    for (const r of agg.bigReads) bump(byFile, r.file, r.chars);
    const top = [...byFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    add({
      id: "large-reads",
      severity: bigReadTotal > 1_000_000 ? "high" : "medium",
      title: `${agg.bigReads.length} whole-file Reads over ${fmt(BIG_READ_CHARS)} chars (~${fmt(Math.round(bigReadTotal / 4))} tokens)`,
      evidence: { sessions: ids(agg.bigReads.map((r) => r.sid)), count: agg.bigReads.length, files: top.map(([f, c]) => `${f} (${fmt(c)} chars)`) },
      suggestion: "Grep for the symbol first, then Read with offset/limit. Add a rule capping full-file reads; split or index files that are routinely read whole.",
      target: "CLAUDE.md",
    });
  }
  const bigNonRead = agg.bigResults.filter((r) => r.name !== "Read");
  if (bigNonRead.length >= 3) {
    add({
      id: "large-tool-results",
      severity: "medium",
      title: `${bigNonRead.length} tool results over ${fmt(BIG_RESULT_CHARS)} chars`,
      evidence: { sessions: ids(bigNonRead.map((r) => r.sid)), count: bigNonRead.length, samples: bigNonRead.slice(0, 3).map((r) => `${r.name}: ${r.target} (${fmt(r.chars)})`) },
      suggestion: "Pipe noisy commands through head/tail or a filter, narrow Grep with glob/head_limit, and avoid dumping logs or JSON into context.",
      target: "CLAUDE.md",
    });
  }
  if (agg.shellReads.n >= 10) {
    add({
      id: "shell-instead-of-tools",
      severity: "low",
      title: `${agg.shellReads.n} Bash calls that cat/grep/find/ls instead of Read/Grep/Glob`,
      evidence: { sessions: ids(agg.shellReads.sids), count: agg.shellReads.n },
      suggestion: "Use the dedicated Grep/Glob/Read tools (cheaper, permission-free, capped output). Reinforce in CLAUDE.md and tool-policy.",
      target: "CLAUDE.md",
    });
  }
  const missSessions = sessions.filter((s) => s.missTurns >= 3).sort((a, b) => b.missTurns - a.missTurns);
  if (missSessions.length) {
    add({
      id: "cache-miss-turns",
      severity: "medium",
      title: `${agg.missTurns.length} turns re-sent >${fmt(CACHE_MISS_TOKENS)} uncached input tokens`,
      evidence: { sessions: missSessions.slice(0, 5).map((s) => sid8(s.id)), turns: missSessions.slice(0, 5).map((s) => s.missTurns), uncachedTokens: agg.missTurns.reduce((n, t) => n + t.uncached, 0) },
      suggestion: "Cache misses follow idle gaps (>5min TTL) and edits to CLAUDE.md/system prompt mid-session. Keep stable prefixes stable, avoid resuming long-idle sessions, batch work while the cache is warm.",
      target: "memory",
    });
  }
  const fan = sessions.filter((s) => s.subFiles >= FANOUT_MIN).sort((a, b) => b.subTokens - a.subTokens);
  const subTotal = sessions.reduce((n, s) => n + s.subTokens, 0);
  if (fan.length || (agg.spawns.length >= FANOUT_MIN && agg.subNoModel >= FANOUT_MIN)) {
    add({
      id: "subagent-fanout",
      severity: subTotal > total * 0.5 ? "high" : "medium",
      title: `Subagents used ${fmt(subTotal)} tokens (${total ? Math.round((subTotal / total) * 100) : 0}% of total)`,
      evidence: { sessions: fan.slice(0, 5).map((s) => sid8(s.id)), subagentFiles: fan.slice(0, 5).map((s) => s.subFiles), spawns: agg.spawns.length, spawnsWithoutModel: agg.subNoModel, models: [...new Set(fan.flatMap((s) => [...s.subModels]))] },
      suggestion: "Pass an explicit smaller model (haiku/sonnet) to search/read-only subagents, keep concurrency <=3, and give each a narrow prompt so it returns a short summary instead of file dumps.",
      target: "CLAUDE.md",
    });
  }

  if (!out.length) add({ id: "all-clear", severity: "info", title: "No efficiency problems found in this window", evidence: { sessions: sessions.length, tokens: total }, suggestion: "Nothing to change.", target: "none" });
  const rank = { high: 0, medium: 1, low: 2, info: 3 };
  out.sort((a, b) => rank[a.severity] - rank[b.severity]);
  return out;
}

export async function runDoctor({ days = Number(process.env.PM_DOCTOR_DAYS) || 14, now = Date.now() } = {}) {
  const sinceMs = now - days * 24 * 3600e3;
  const prefix = escapePath(PM_ROOT);
  const root = projectsRoot();
  const files = listSessionFiles()
    .filter((f) => path.relative(root, f.filePath).split(path.sep)[0]?.startsWith(prefix))
    .filter((f) => {
      try {
        return fs.statSync(f.filePath).mtimeMs >= sinceMs;
      } catch {
        return false;
      }
    });
  files.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "session" ? -1 : 1));

  const agg = {
    sessions: new Map(), toolCalls: new Map(), toolChars: new Map(), errByTool: new Map(), byModel: new Map(),
    repeats: new Map(), denials: [], apiErrors: [], bigReads: [], bigResults: [], missTurns: [],
    shellReads: { n: 0, sids: new Set() }, spawns: [], subNoModel: 0,
  };
  const seen = new Set();
  for (const f of files) {
    try {
      await scanFile(f.filePath, f.kind, agg, seen, sinceMs);
    } catch {}
  }
  const sessions = [...agg.sessions.values()].filter((s) => s.tokens > 0);
  const top = (m, n = 8) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
  const result = {
    generatedAt: new Date(now).toISOString(),
    windowDays: days,
    scope: { projectPrefix: prefix, files: files.length, sessions: sessions.length },
    totals: { tokens: sessions.reduce((n, s) => n + s.tokens, 0), errors: [...agg.errByTool.values()].reduce((a, b) => a + b, 0) },
    topSessions: sessions
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, 8)
      .map((s) => ({ id: s.id, title: s.title, tokens: s.tokens, output: s.output, uncached: s.uncached, turns: s.turns, compactions: s.compactions, subagentTokens: s.subTokens, errors: s.errors, last: s.last ? new Date(s.last).toISOString() : null })),
    topTools: top(agg.toolChars).map(([name, chars]) => ({ name, resultChars: chars, calls: agg.toolCalls.get(name) || 0, errors: agg.errByTool.get(name) || 0 })),
    byModel: top(agg.byModel).map(([model, tokens]) => ({ model, tokens })),
    findings: findings(agg, days),
  };
  return result;
}

export function readDoctor() {
  try {
    return JSON.parse(fs.readFileSync(DOCTOR_FILE(), "utf8"));
  } catch {
    return null;
  }
}

let running = null;
// Fresh scan + cache write; concurrent callers share one in-flight scan.
export function scanAndCache(opts) {
  if (!running) {
    running = runDoctor(opts)
      .then((r) => {
        fs.mkdirSync(PM_DIR, { recursive: true });
        fs.writeFileSync(DOCTOR_FILE(), JSON.stringify(r, null, 2));
        return r;
      })
      .finally(() => {
        running = null;
      });
  }
  return running;
}

export function startDoctorTimer(onDone) {
  const min = process.env.PM_DOCTOR_INTERVAL_MIN === undefined ? 360 : Number(process.env.PM_DOCTOR_INTERVAL_MIN);
  if (!(min > 0)) return null;
  const tick = () => scanAndCache().then(() => onDone?.()).catch((e) => console.error("[pm-doctor]", e.message));
  const t = setInterval(tick, min * 60_000);
  t.unref();
  const cached = readDoctor();
  if (!cached || Date.now() - Date.parse(cached.generatedAt) > min * 60_000) setTimeout(tick, 5000).unref();
  return t;
}
