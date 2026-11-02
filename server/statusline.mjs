// Claude Code status line builder: the user picks segments + label language in Setup, pm
// generates a bash script and (only when asked, or when there is no status line yet) points
// `statusLine` in ~/.claude/settings.json at it. Prefs: .claude/pm/statusline.json (user-owned,
// written only via PUT /api/statusline). Every file pm replaces is copied to <file>.bak-<ts> first.
// Nothing user-typed reaches the script except the separator, and that is single-quoted.
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, chmodSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { PM_DIR } from "./paths.mjs";
import { statuslinePath as rateLimitsPath } from "./fill.mjs";

export const MARKER = "# pm-statusline";
const PREFS = () => join(PM_DIR, "statusline.json");
export const claudeDir = (env = process.env) => env.PM_CLAUDE_DIR || join(homedir(), ".claude");
export const scriptPath = (env = process.env) => join(claudeDir(env), "statusline", "statusline.sh");
const settingsPath = (env = process.env) => join(claudeDir(env), "settings.json");
const USAGE_SRC = join(dirname(fileURLToPath(import.meta.url)), "../claude-config/statusline/usage.py");

// id -> labels + a preview sample. `spend` segments need usage.py (python3) next to the script.
export const SEGMENTS = [
  { id: "model", en: "Model", tr: "Model", sample: "Opus" },
  { id: "dir", en: "Folder", tr: "Klasör", sample: "pm" },
  { id: "branch", en: "Git branch", tr: "Git dalı", sample: "⎇ main" },
  { id: "limit5h", en: "5h limit", tr: "5s limit", label: { en: "5h", tr: "5s" }, sample: "%42 18:30" },
  { id: "limit7d", en: "Weekly limit", tr: "Haftalık limit", label: { en: "wk", tr: "hf" }, sample: { en: "%17 Thu 09:00", tr: "%17 Per 09:00" } },
  { id: "session", en: "Session cost", tr: "Oturum maliyeti", label: { en: "Session", tr: "Oturum" }, sample: "$1.84" },
  { id: "spend5h", en: "5h block spend", tr: "5s blok harcaması", label: { en: "5h", tr: "5s" }, sample: "$6.10", spend: 1 },
  { id: "today", en: "Today's spend", tr: "Bugünkü harcama", label: { en: "Today", tr: "Bugün" }, sample: "$12.40", spend: 1 },
  { id: "week", en: "7-day spend", tr: "7 günlük harcama", label: { en: "7d", tr: "7g" }, sample: "$61.02", spend: 1 },
  { id: "lines", en: "Lines changed", tr: "Değişen satır", sample: "+120 -14" },
  { id: "version", en: "Claude Code version", tr: "Claude Code sürümü", sample: "v2.1.320" },
];
const BY_ID = new Map(SEGMENTS.map((s) => [s.id, s]));
export const DEFAULTS = { segments: ["model", "dir", "limit5h", "limit7d", "session", "today", "week"], lang: "en", sep: " | ", saveLimits: false };

export function validate(b) {
  const bad = (m) => Object.assign(new Error(m), { status: 400 });
  if (!b || typeof b !== "object") throw bad("body must be an object");
  const { segments, lang, sep, saveLimits } = b;
  if (!Array.isArray(segments) || segments.length > SEGMENTS.length) throw bad("segments must be an array of known ids");
  if (segments.some((s) => !BY_ID.has(s)) || new Set(segments).size !== segments.length) throw bad("unknown or duplicate segment");
  if (lang !== "en" && lang !== "tr") throw bad("lang must be en or tr");
  if (typeof sep !== "string" || !sep.length || sep.length > 8 || /[\x00-\x1f\x7f]/.test(sep)) throw bad("sep: 1-8 printable characters");
  return { segments, lang, sep, saveLimits: saveLimits === true };
}

export function readConfig() {
  try {
    const c = JSON.parse(readFileSync(PREFS(), "utf8"));
    return { ...validate({ ...DEFAULTS, ...c }), previous: c.previous ?? null };
  } catch {
    return { ...DEFAULTS, previous: null };
  }
}

const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const DAYS = { en: "Sun Mon Tue Wed Thu Fri Sat", tr: "Paz Pzt Sal Çar Per Cum Cmt" };

// The bash body for one segment; each appends at most one item via `add`.
function segmentSh(id, lang) {
  const L = (s) => sq(BY_ID.get(s).label[lang] + " ");
  switch (id) {
    case "model": return `add "$(j .model.display_name)"`;
    case "dir": return `add "\${dir##*/}"`;
    case "branch": return `b=$(git -C "\${dir:-.}" branch --show-current 2>/dev/null); [ -n "$b" ] && add "⎇ $b"`;
    case "limit5h": return `v=$(limit five_hour 0); [ -n "$v" ] && add ${L(id)}"$v"`;
    case "limit7d": return `v=$(limit seven_day 1); [ -n "$v" ] && add ${L(id)}"$v"`;
    case "session": return `v=$(j .cost.total_cost_usd); add ${L(id)}"$(printf '$%.2f' "\${v:-0}")"`;
    case "spend5h": return `add ${L(id)}"$(printf '$%.2f' "\${block:-0}")"`;
    case "today": return `add ${L(id)}"$(printf '$%.2f' "\${today:-0}")"`;
    case "week": return `add ${L(id)}"$(printf '$%.2f' "\${week:-0}")"`;
    case "lines": return `a=$(j .cost.total_lines_added); r=$(j .cost.total_lines_removed); [ -n "$a$r" ] && add "+\${a:-0} -\${r:-0}"`;
    case "version": return `v=$(j .version); [ -n "$v" ] && add "v$v"`;
  }
}

export function generate(cfg, env = process.env) {
  const c = validate(cfg);
  const spend = c.segments.some((s) => BY_ID.get(s).spend);
  const limits = c.segments.some((s) => s.startsWith("limit"));
  const L = [
    "#!/bin/bash",
    `${MARKER} — generated by pm (claude-pm-board). Change it in pm: Setup → Status line; edits here are overwritten.`,
    `${MARKER}-config ${JSON.stringify({ segments: c.segments, lang: c.lang, sep: c.sep, saveLimits: c.saveLimits })}`,
    "# Needs jq" + (spend ? "; spend segments also need python3 + usage.py next to this script." : "."),
    "input=$(cat)",
    `j() { printf '%s' "$input" | jq -r "$1 // empty" 2>/dev/null; }`,
    "out=(); add() { [ -n \"$1\" ] && out+=(\"$1\"); }",
    "dir=$(j .workspace.current_dir)",
  ];
  if (c.saveLimits) {
    const f = rateLimitsPath(env);
    L.push(`# for pm's Fill: save Claude Code's rate limits where pm reads them`,
      `printf '%s' "$input" | jq -c 'select(.rate_limits) | {at: now, rate_limits}' > ${sq(f + ".tmp")} 2>/dev/null && [ -s ${sq(f + ".tmp")} ] && mv ${sq(f + ".tmp")} ${sq(f)}`);
  }
  if (limits) {
    L.push(`days=(${DAYS[c.lang]})`,
      `when() { date -r "$1" "+$2" 2>/dev/null || date -d "@$1" "+$2"; }`,
      `limit() { pct=$(j ".rate_limits.$1.used_percentage"); at=$(j ".rate_limits.$1.resets_at"); [ -z "$pct" ] && return`,
      `  out1=$(printf '%%%.0f' "$pct"); [ -n "$at" ] && { [ "$2" = 1 ] && out1="$out1 \${days[$(when "$at" %w)]}"; out1="$out1 $(when "$at" %H:%M)"; }; printf '%s' "$out1"; }`);
  }
  if (spend) {
    L.push(`cache=\${TMPDIR:-/tmp}/cc-usage-cache  # 60 s cache: usage.py reads every transcript`,
      `if [ ! -f "$cache" ] || [ $(( $(date +%s) - $(stat -f %m "$cache" 2>/dev/null || stat -c %Y "$cache") )) -gt 60 ]; then`,
      `  python3 "$(dirname "$0")/usage.py" > "$cache" 2>/dev/null`,
      `fi`,
      `read block today week < "$cache"`);
  }
  for (const s of c.segments) L.push(segmentSh(s, c.lang));
  L.push(`sep=${sq(c.sep)}`, `line=""; for x in "\${out[@]}"; do line="\${line:+$line$sep}$x"; done`, `printf '%s\\n' "$line"`);
  return L.join("\n") + "\n";
}

// What the preview strip shows: the same order/labels as the script, with sample values.
export function preview(cfg) {
  const c = validate(cfg);
  return c.segments.map((id) => {
    const s = BY_ID.get(id);
    const v = typeof s.sample === "object" ? s.sample[c.lang] : s.sample;
    return (s.label ? s.label[c.lang] + " " : "") + v;
  }).join(c.sep);
}

const readJson = (f) => {
  try {
    return JSON.parse(readFileSync(f, "utf8"));
  } catch {
    return null;
  }
};
const ts = () => new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
const backup = (f) => existsSync(f) && copyFileSync(f, `${f}.bak-${ts()}`);
const has = (bin) => {
  try {
    execFileSync("which", [bin], { stdio: "ignore", timeout: 3000 });
    return true;
  } catch {
    return false;
  }
};

export const pmCommand = (env = process.env) => `bash "${scriptPath(env)}"`;

export function statuslineStatus(env = process.env) {
  const cfg = readConfig();
  const settings = readJson(settingsPath(env));
  const current = settings?.statusLine ?? null;
  const script = scriptPath(env);
  const body = existsSync(script) ? readFileSync(script, "utf8") : "";
  return {
    config: { segments: cfg.segments, lang: cfg.lang, sep: cfg.sep, saveLimits: cfg.saveLimits },
    canRestore: !!cfg.previous,
    segments: SEGMENTS.map(({ id, en, tr, spend, label, sample }) => ({ id, en, tr, spend: !!spend, label: label ?? null, sample })),
    preview: preview(cfg),
    script,
    scriptByPm: body.includes(MARKER),
    current: current?.command ?? null,
    usesPm: !!current?.command?.includes(script),
    deps: { jq: has("jq"), python3: has("python3") },
    rateLimitsFile: rateLimitsPath(env),
  };
}

function editSettings(fn, env) {
  const f = settingsPath(env);
  const cur = readJson(f) ?? (existsSync(f) ? null : {});
  if (cur === null) throw Object.assign(new Error(`${f} is not valid JSON; fix it first`), { status: 409 });
  const next = fn(structuredClone(cur));
  if (JSON.stringify(next) === JSON.stringify(cur)) return;
  backup(f);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify(next, null, 2) + "\n");
}

// Save prefs + regenerate the script. Points settings.json at it when `apply` is true or when
// there is no status line at all (fresh install); remembers the replaced one for restore.
export function saveStatusline(body, env = process.env) {
  const c = validate(body);
  const prev = readConfig();
  const script = scriptPath(env);
  mkdirSync(dirname(script), { recursive: true });
  const old = existsSync(script) ? readFileSync(script, "utf8") : null;
  const next = generate(c, env);
  if (old !== next) {
    if (old !== null && !old.includes(MARKER)) backup(script);
    writeFileSync(script, next);
    chmodSync(script, 0o755);
  }
  const usage = join(dirname(script), "usage.py");
  if (!existsSync(usage) && existsSync(USAGE_SRC)) copyFileSync(USAGE_SRC, usage);
  let previous = prev.previous;
  const current = readJson(settingsPath(env))?.statusLine ?? null;
  if (body.apply === true || !current) {
    if (current && !current.command?.includes(script)) previous = current;
    editSettings((s) => ({ ...s, statusLine: { type: "command", command: pmCommand(env), padding: 0 } }), env);
  }
  mkdirSync(PM_DIR, { recursive: true });
  writeFileSync(PREFS(), JSON.stringify({ ...c, previous }, null, 2) + "\n");
  return statuslineStatus(env);
}

// Put back the status line pm replaced (or remove pm's if there was none before).
export function restoreStatusline(env = process.env) {
  const cfg = readConfig();
  editSettings((s) => {
    if (cfg.previous) s.statusLine = cfg.previous;
    else if (s.statusLine?.command?.includes(scriptPath(env))) delete s.statusLine;
    return s;
  }, env);
  const { previous, ...rest } = cfg;
  writeFileSync(PREFS(), JSON.stringify({ ...rest, previous: null }, null, 2) + "\n");
  return statuslineStatus(env);
}
