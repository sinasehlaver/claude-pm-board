// Shared Claude Code transcript helpers (file discovery, per-turn token parsing,
// billable-token weighting) used by tokens.mjs and doctor.mjs. The usage *numbers*
// pm shows live in statusline-usage.mjs. Reads ~/.claude/projects directly — NOT
// PM_ROOT-scoped, since transcripts are account-wide, not per-workspace.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";

// Overridable for tests only — real usage is always the actual account-wide log dir.
export const projectsRoot = () => process.env.CLAUDE_PROJECTS_ROOT || path.join(os.homedir(), ".claude", "projects");

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

export { listSessionFiles, parseFile, parseFileCached, tokenSum };
