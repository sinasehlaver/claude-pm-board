// Installs claude-config/ without overwriting anything of yours. Called by scripts/setup.sh.
//   node scripts/setup-config.mjs <PM_ROOT>
// - ~/.claude/statusline/*          copied if missing; settings.json `statusLine` added only if you have none
// - <PM_ROOT>/.claude/hooks, skills copied if missing
// - <PM_ROOT>/.claude/settings.local.json  the two hooks merged in (absolute paths, de-duplicated)
// Not installed (they hold placeholders you must fill): CLAUDE.md, rules/, memory/.
// Every settings file is copied to <file>.bak-<ts> before it is changed.
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const src = join(dirname(fileURLToPath(import.meta.url)), "../claude-config");
const root = process.argv[2];
if (!root) throw new Error("usage: setup-config.mjs <PM_ROOT>");
const home = join(homedir(), ".claude");
const ws = join(root, ".claude");
const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
const say = (m) => console.log(`  ${m}`);

const copyMissing = (from, to) => {
  if (existsSync(to)) return say(`kept   ${to}`);
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true });
  say(`added  ${to}`);
};

const editJson = (file, fn) => {
  const cur = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  const next = fn(structuredClone(cur));
  if (JSON.stringify(next) === JSON.stringify(cur)) return say(`kept   ${file} (nothing to change)`);
  if (existsSync(file)) copyFileSync(file, `${file}.bak-${ts}`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(next, null, 2) + "\n");
  say(`edited ${file}${existsSync(`${file}.bak-${ts}`) ? ` (backup .bak-${ts})` : ""}`);
};

// statusline (needs jq + python3 at run time)
for (const f of ["statusline.sh", "usage.py"]) copyMissing(join(src, "statusline", f), join(home, "statusline", f));
editJson(join(home, "settings.json"), (s) => {
  s.statusLine ??= { type: "command", command: `bash ${join(home, "statusline/statusline.sh")}` };
  return s;
});

// hooks + skills live in the workspace
for (const f of ["ask_questions_reminder.py", "destructive_command_guard.py"]) copyMissing(join(src, "hooks", f), join(ws, "hooks", f));
for (const d of ["handoff", "retro"]) copyMissing(join(src, "skills", d), join(ws, "skills", d));

const hook = (event, matcher, script) => ({
  event,
  entry: { ...(matcher && { matcher }), hooks: [{ type: "command", command: `python3 "${join(ws, "hooks", script)}"` }] },
});
editJson(join(ws, "settings.local.json"), (s) => {
  s.hooks ??= {};
  for (const { event, entry } of [hook("UserPromptSubmit", null, "ask_questions_reminder.py"), hook("PreToolUse", "Bash", "destructive_command_guard.py")]) {
    const list = (s.hooks[event] ??= []);
    const cmd = entry.hooks[0].command;
    if (!list.some((e) => e.hooks?.some((h) => h.command === cmd))) list.push(entry);
  }
  return s;
});
