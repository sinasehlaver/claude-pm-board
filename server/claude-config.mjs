// Read-only review of the Claude Code setup: settings hooks/permissions/env/plugins/MCP, skills,
// agents, commands, and instruction files (CLAUDE.md, rules). Secrets are masked; sizes are capped.
// Previews are by inventory id only, never a caller-supplied path.
import { existsSync, readFileSync, readdirSync, statSync, realpathSync, openSync, readSync, closeSync } from "node:fs";
import { join, resolve, sep, basename } from "node:path";
import { homedir } from "node:os";
import { PM_ROOT } from "./paths.mjs";

export const MAX_FILES = 200;
export const MAX_READ = 64 * 1024;
export const PREVIEW_CHARS = 6000;
const MAX_STR = 300;

const claudeDir = (env) => env.PM_CLAUDE_DIR || join(homedir(), ".claude");
const rootDir = (env) => env.PM_ROOT || PM_ROOT;
const SECRET_KEY = /(key|token|secret|passw|auth|credential|bearer|cookie)/i;
const SECRET_VAL = /\b(sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{12,}|xox[abprs]-[A-Za-z0-9-]{8,}|AKIA[0-9A-Z]{12,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,})/g;

// Mask anything key/token-like inside free text (hook commands, args, previews).
export function redact(s) {
  let t = String(s ?? "");
  t = t.replace(/(--?[\w-]*(?:key|token|secret|passw\w*|auth\w*)[\w-]*)([= ]+)(\S+)/gi, "$1$2***");
  t = t.replace(/\b([A-Za-z_][A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTH|CREDENTIAL)[A-Za-z0-9_]*)=(\S+)/gi, "$1=***");
  t = t.replace(/(Authorization:\s*\w+\s+)\S+/gi, "$1***");
  t = t.replace(/(:\/\/[^\s:/@]+:)[^\s@/]+@/g, "$1***@");
  t = t.replace(SECRET_VAL, "***");
  return t.length > MAX_STR ? t.slice(0, MAX_STR) + "…" : t;
}

function readCapped(p, max = MAX_READ) {
  const fd = openSync(p, "r");
  try {
    const buf = Buffer.alloc(max);
    const n = readSync(fd, buf, 0, max, 0);
    return buf.toString("utf8", 0, n);
  } finally {
    closeSync(fd);
  }
}
const readJson = (p) => {
  try {
    return existsSync(p) ? JSON.parse(readCapped(p)) : null;
  } catch {
    return null;
  }
};
const isObj = (x) => x && typeof x === "object" && !Array.isArray(x);
const short = (p, env) => {
  const h = homedir();
  return p.startsWith(h + sep) ? "~" + p.slice(h.length) : p;
};

export function frontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const out = {};
  if (!m) return out;
  for (const line of m[1].split(/\r?\n/)) {
    const k = /^([\w-]+):\s*(.*)$/.exec(line);
    if (k) out[k[1]] = k[2].replace(/^["']|["']$/g, "").trim();
  }
  return out;
}
const firstHeading = (text) => {
  const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  const m = /^#{1,6}\s+(.+)$/m.exec(body);
  return m ? m[1].trim().slice(0, 120) : "";
};

function settingsOf(env) {
  const dir = claudeDir(env);
  const out = [];
  for (const file of ["settings.json", "settings.local.json"]) {
    const j = readJson(join(dir, file));
    if (!isObj(j)) continue;
    const hooks = [];
    if (isObj(j.hooks)) {
      for (const [event, groups] of Object.entries(j.hooks)) {
        for (const g of Array.isArray(groups) ? groups : []) {
          for (const h of Array.isArray(g?.hooks) ? g.hooks : []) {
            hooks.push({ event, matcher: String(g.matcher ?? "*"), type: String(h.type || "command"), command: redact(h.command ?? h.prompt ?? h.url ?? "") });
          }
        }
      }
    }
    const perm = isObj(j.permissions) ? j.permissions : {};
    const n = (a) => (Array.isArray(a) ? a.length : 0);
    const mcp = isObj(j.mcpServers)
      ? Object.entries(j.mcpServers).map(([name, s]) => ({
          name,
          type: String(s?.type || (s?.url ? "http" : "stdio")),
          command: redact([s?.command, ...(Array.isArray(s?.args) ? s.args : [])].filter(Boolean).join(" ") || s?.url || ""),
          env: isObj(s?.env) ? Object.keys(s.env) : [],
        }))
      : [];
    const plugins = isObj(j.enabledPlugins) ? Object.entries(j.enabledPlugins).map(([name, on]) => ({ name, enabled: !!on })) : [];
    out.push({
      file,
      hooks,
      permissions: { allow: n(perm.allow), deny: n(perm.deny), ask: n(perm.ask), defaultMode: perm.defaultMode ? String(perm.defaultMode) : null },
      env: isObj(j.env) ? Object.keys(j.env).sort() : [],
      plugins,
      mcp,
      model: typeof j.model === "string" ? j.model : null,
    });
  }
  return out;
}

const listDir = (dir) => {
  try {
    return readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
};
const sizeOf = (p) => {
  try {
    return statSync(p).size;
  } catch {
    return 0;
  }
};

// Every file the inventory exposes: {id, group, scope, name, abs, ...}. abs never leaves the server.
function collect(env) {
  const cdir = claudeDir(env), root = rootDir(env);
  const items = [];
  const add = (group, scope, name, abs, extra = {}) => {
    if (items.length >= MAX_FILES || !existsSync(abs)) return;
    let text = "";
    try {
      text = readCapped(abs, 8192);
    } catch {
      return;
    }
    const fm = frontmatter(text);
    items.push({
      id: `${group}:${scope}:${name}`,
      group, scope, name, abs,
      path: short(abs, env),
      size: sizeOf(abs),
      description: redact(fm.description || ""),
      paths: fm.paths || fm.globs || "",
      heading: firstHeading(text),
      ...extra,
    });
  };
  const scopes = [["user", cdir], ["project", join(root, ".claude")]];
  for (const [scope, base] of scopes) {
    for (const d of listDir(join(base, "skills"))) {
      if (d.isDirectory() || d.isSymbolicLink()) add("skill", scope, d.name, join(base, "skills", d.name, "SKILL.md"));
    }
    for (const f of listDir(join(base, "agents"))) if (f.name.endsWith(".md")) add("agent", scope, f.name.slice(0, -3), join(base, "agents", f.name));
    for (const f of listDir(join(base, "commands"))) if (f.name.endsWith(".md")) add("command", scope, f.name.slice(0, -3), join(base, "commands", f.name));
  }
  add("memory", "user", "CLAUDE.md", join(cdir, "CLAUDE.md"));
  add("memory", "project", "CLAUDE.md", join(root, "CLAUDE.md"));
  for (const f of listDir(join(root, ".claude", "rules"))) if (f.name.endsWith(".md")) add("rule", "project", f.name, join(root, ".claude", "rules", f.name));
  return items;
}

const strip = ({ abs, ...rest }) => rest;

export function claudeConfig(env = process.env) {
  const items = collect(env);
  const by = (g) => items.filter((i) => i.group === g).map(strip);
  return {
    dir: short(claudeDir(env), env),
    root: short(rootDir(env), env),
    settings: settingsOf(env),
    skills: by("skill"),
    agents: by("agent"),
    commands: by("command"),
    memory: by("memory"),
    rules: by("rule"),
    truncated: items.length >= MAX_FILES,
  };
}

// Preview by inventory id only. The resolved file must still sit inside ~/.claude or PM_ROOT.
export function previewFile(id, env = process.env) {
  const bad = (m, status = 404) => Object.assign(new Error(m), { status });
  if (typeof id !== "string" || id.length > 300) throw bad("bad id", 400);
  const it = collect(env).find((i) => i.id === id);
  if (!it) throw bad("not in inventory");
  const real = realpathSync(it.abs);
  const ok = [claudeDir(env), rootDir(env)].some((b) => {
    try {
      const rb = realpathSync(resolve(b));
      return real === rb || real.startsWith(rb + sep);
    } catch {
      return false;
    }
  });
  if (!ok) throw bad("outside allowed roots", 403);
  const raw = readCapped(real, PREVIEW_CHARS * 2);
  const text = raw
    .split("\n")
    .map((l) => (SECRET_KEY.test(l) && /[:=]\s*\S{6,}/.test(l) ? redact(l.replace(/([:=]\s*)\S+/, "$1***")) : l.replace(SECRET_VAL, "***")))
    .join("\n");
  return { id, name: basename(it.abs), path: it.path, size: it.size, truncated: it.size > PREVIEW_CHARS || text.length > PREVIEW_CHARS, text: text.slice(0, PREVIEW_CHARS) };
}
