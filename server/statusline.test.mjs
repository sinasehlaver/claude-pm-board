import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PM_ROOT = mkdtempSync(join(tmpdir(), "pm-sl-"));
const claude = mkdtempSync(join(tmpdir(), "pm-sl-home-"));
const env = { PM_CLAUDE_DIR: claude, PM_RATE_LIMITS_FILE: join(claude, "rate-limits.json") };
const sl = await import("./statusline.mjs");
const settings = () => JSON.parse(readFileSync(join(claude, "settings.json"), "utf8"));
const hasJq = (() => {
  try {
    execFileSync("which", ["jq"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

test("validate rejects unknown/duplicate segments, bad lang, control chars and long separators", () => {
  const ok = { segments: ["model"], lang: "en", sep: " | " };
  assert.deepEqual(sl.validate(ok), { ...ok, saveLimits: false });
  for (const bad of [
    { ...ok, segments: ["model", "model"] },
    { ...ok, segments: ["$(rm -rf ~)"] },
    { ...ok, segments: "model" },
    { ...ok, lang: "de" },
    { ...ok, sep: "" },
    { ...ok, sep: "123456789" },
    { ...ok, sep: "\n" },
    null,
  ])
    assert.throws(() => sl.validate(bad), (e) => e.status === 400);
});

test("separator is single-quoted in the script (no shell expansion)", () => {
  const s = sl.generate({ segments: ["model"], lang: "en", sep: "'$(x)" }, env);
  assert.match(s, /sep=''\\''\$\(x\)'/);
});

test("fresh install: save creates the script and points settings.json at it", () => {
  const st = sl.saveStatusline({ ...sl.DEFAULTS }, env);
  assert.ok(existsSync(sl.scriptPath(env)));
  assert.equal(settings().statusLine.command, sl.pmCommand(env));
  assert.equal(st.usesPm, true);
  assert.equal(st.scriptByPm, true);
  assert.ok(existsSync(join(claude, "statusline", "usage.py")));
});

test("an existing status line is kept unless apply; apply remembers it, restore puts it back", () => {
  writeFileSync(join(claude, "settings.json"), JSON.stringify({ model: "x", statusLine: { type: "command", command: "sh ~/mine.sh" } }));
  let st = sl.saveStatusline({ ...sl.DEFAULTS, lang: "tr" }, env);
  assert.equal(settings().statusLine.command, "sh ~/mine.sh");
  assert.equal(st.usesPm, false);
  assert.equal(st.config.lang, "tr");
  st = sl.saveStatusline({ ...sl.DEFAULTS, apply: true }, env);
  assert.equal(settings().statusLine.command, sl.pmCommand(env));
  assert.equal(settings().model, "x");
  assert.equal(st.canRestore, true);
  assert.ok(readdirSync(claude).some((f) => f.startsWith("settings.json.bak-")));
  st = sl.restoreStatusline(env);
  assert.equal(settings().statusLine.command, "sh ~/mine.sh");
  assert.equal(st.canRestore, false);
});

test("a hand-written script at the target path is backed up before pm overwrites it", () => {
  const dir = mkdtempSync(join(tmpdir(), "pm-sl-own-"));
  const e = { ...env, PM_CLAUDE_DIR: dir };
  mkdirSync(join(dir, "statusline"));
  writeFileSync(join(dir, "statusline", "statusline.sh"), "echo mine\n");
  sl.saveStatusline({ ...sl.DEFAULTS }, e);
  assert.ok(readdirSync(join(dir, "statusline")).some((f) => f.startsWith("statusline.sh.bak-")));
});

test("generated script renders the stdin JSON (EN + TR) and saves rate limits when asked", { skip: !hasJq && "jq missing" }, () => {
  const input = JSON.stringify({
    model: { display_name: "Opus" },
    workspace: { current_dir: "/x/proj" },
    cost: { total_cost_usd: 1.5, total_lines_added: 3, total_lines_removed: 1 },
    version: "2.1.0",
    rate_limits: { five_hour: { used_percentage: 42.4 } },
  });
  const run = (cfg) => {
    const f = join(claude, `t-${cfg.lang}.sh`);
    writeFileSync(f, sl.generate(cfg, env));
    return execFileSync("bash", [f], { input, encoding: "utf8" }).trim();
  };
  assert.equal(run({ segments: ["model", "dir", "limit5h", "session", "lines", "version", "limit7d"], lang: "en", sep: " | " }), "Opus | proj | 5h %42 | Session $1.50 | +3 -1 | v2.1.0");
  assert.equal(run({ segments: ["session", "limit5h"], lang: "tr", sep: " · ", saveLimits: true }), "Oturum $1.50 · 5s %42");
  assert.equal(JSON.parse(readFileSync(env.PM_RATE_LIMITS_FILE, "utf8")).rate_limits.five_hour.used_percentage, 42.4);
});

test("preview uses the same labels/order as the script", () => {
  assert.equal(sl.preview({ segments: ["model", "session"], lang: "tr", sep: " | " }), "Opus | Oturum $1.84");
});
