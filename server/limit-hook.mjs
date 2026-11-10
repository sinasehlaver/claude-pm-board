// "Handoff before usage limit": registers hooks/limit-handoff.mjs in ~/.claude/settings.json
// (UserPromptSubmit + PostToolUse). Writes only `hooks` entries carrying our script path;
// foreign hooks are preserved. settings.json is copied to .bak-<ts> before every write.
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { claudeDir } from "./statusline.mjs";

export const EVENTS = ["UserPromptSubmit", "PostToolUse"];
export const HOOK_SCRIPT = fileURLToPath(new URL("../hooks/limit-handoff.mjs", import.meta.url)).replace(
  /app\.asar([\\/])/,
  "app.asar.unpacked$1",
);
const MARK = "limit-handoff.mjs";
const settingsPath = (env) => join(claudeDir(env), "settings.json");
const command = () => `node "${HOOK_SCRIPT}"`;
const ours = (h) => typeof h?.command === "string" && h.command.includes(MARK);
const ts = () => new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);

function read(env) {
  const f = settingsPath(env);
  if (!existsSync(f)) return {};
  try {
    const j = JSON.parse(readFileSync(f, "utf8"));
    if (j && typeof j === "object" && !Array.isArray(j)) return j;
  } catch {}
  throw Object.assign(new Error("settings.json is not valid JSON; fix it first"), { status: 409 });
}

function write(env, obj) {
  const f = settingsPath(env);
  mkdirSync(dirname(f), { recursive: true });
  if (existsSync(f)) copyFileSync(f, `${f}.bak-${ts()}`);
  writeFileSync(f, JSON.stringify(obj, null, 2) + "\n");
}

const installedIn = (s, ev) => (Array.isArray(s.hooks?.[ev]) ? s.hooks[ev] : []).some((g) => (g?.hooks || []).some(ours));

export function limitHookStatus(env = process.env) {
  const s = read(env);
  return { on: EVENTS.every((ev) => installedIn(s, ev)), script: HOOK_SCRIPT, settings: settingsPath(env) };
}

export function installLimitHook(env = process.env) {
  const s = read(env);
  if (EVENTS.every((ev) => installedIn(s, ev))) return limitHookStatus(env);
  s.hooks = s.hooks && typeof s.hooks === "object" ? s.hooks : {};
  for (const ev of EVENTS) {
    if (installedIn(s, ev)) continue;
    const groups = Array.isArray(s.hooks[ev]) ? s.hooks[ev] : [];
    groups.push({ hooks: [{ type: "command", command: command() }] });
    s.hooks[ev] = groups;
  }
  write(env, s);
  return limitHookStatus(env);
}

export function uninstallLimitHook(env = process.env) {
  const s = read(env);
  if (!EVENTS.some((ev) => installedIn(s, ev))) return limitHookStatus(env);
  for (const ev of EVENTS) {
    if (!Array.isArray(s.hooks?.[ev])) continue;
    const groups = s.hooks[ev]
      .map((g) => (Array.isArray(g?.hooks) ? { ...g, hooks: g.hooks.filter((h) => !ours(h)) } : g))
      .filter((g) => !Array.isArray(g?.hooks) || g.hooks.length);
    if (groups.length) s.hooks[ev] = groups;
    else delete s.hooks[ev];
  }
  if (!Object.keys(s.hooks).length) delete s.hooks;
  write(env, s);
  return limitHookStatus(env);
}

export function setLimitHook(body, env = process.env) {
  if (!body || typeof body.on !== "boolean") throw Object.assign(new Error("body must be {on: boolean}"), { status: 400 });
  return body.on ? installLimitHook(env) : uninstallLimitHook(env);
}
