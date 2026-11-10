import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PM_ROOT = mkdtempSync(join(tmpdir(), "pm-lh-"));
const claude = mkdtempSync(join(tmpdir(), "pm-lh-home-"));
const env = { PM_CLAUDE_DIR: claude };
const lh = await import("./limit-hook.mjs");
const settings = () => JSON.parse(readFileSync(join(claude, "settings.json"), "utf8"));

test("install/uninstall round-trip keeps foreign hooks, writes .bak, idempotent", () => {
  const foreign = { hooks: { PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo hi" }] }], Stop: [{ hooks: [{ type: "command", command: "x" }] }] }, model: "opus" };
  writeFileSync(join(claude, "settings.json"), JSON.stringify(foreign));
  assert.equal(lh.limitHookStatus(env).on, false);
  assert.equal(lh.setLimitHook({ on: true }, env).on, true);
  lh.setLimitHook({ on: true }, env);
  const s = settings();
  assert.equal(s.model, "opus");
  assert.equal(s.hooks.UserPromptSubmit.length, 1);
  assert.equal(s.hooks.PostToolUse.length, 2);
  assert.match(s.hooks.UserPromptSubmit[0].hooks[0].command, /^node ".*limit-handoff\.mjs"$/);
  assert.ok(readdirSync(claude).some((f) => f.startsWith("settings.json.bak-")));
  assert.equal(lh.setLimitHook({ on: false }, env).on, false);
  assert.deepEqual(settings(), foreign);
});

test("bad body is a 400", () => {
  for (const b of [null, {}, { on: "yes" }, { on: 1 }])
    assert.throws(() => lh.setLimitHook(b, env), (e) => e.status === 400);
});

const run = (stdin, rl, extra = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "pm-lh-run-"));
  const f = join(dir, "rate-limits.json");
  if (rl !== undefined) writeFileSync(f, typeof rl === "string" ? rl : JSON.stringify(rl));
  const r = spawnSync("node", [lh.HOOK_SCRIPT], {
    input: stdin,
    encoding: "utf8",
    env: { ...process.env, PM_RATE_LIMITS_FILE: f, PM_HOOK_STATE_DIR: dir, ...extra },
  });
  return { r, again: () => spawnSync("node", [lh.HOOK_SCRIPT], { input: stdin, encoding: "utf8", env: { ...process.env, PM_RATE_LIMITS_FILE: f, PM_HOOK_STATE_DIR: dir, ...extra } }) };
};
const soon = Math.floor(Date.now() / 1000) + 3600;
const input = JSON.stringify({ session_id: "s1", hook_event_name: "PostToolUse" });

test("hook emits once above threshold", () => {
  const { r, again } = run(input, { rate_limits: { five_hour: { used_percentage: 92, resets_at: soon } } });
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout).hookSpecificOutput;
  assert.equal(out.hookEventName, "PostToolUse");
  assert.match(out.additionalContext, /Usage limit near \(5h 92%\)/);
  assert.equal(again().stdout, "");
});

test("hook is silent below threshold, when stale, and on garbage", () => {
  assert.equal(run(input, { rate_limits: { five_hour: { used_percentage: 50, resets_at: soon } } }).r.stdout, "");
  assert.equal(run(input, { rate_limits: { five_hour: { used_percentage: 99, resets_at: 100 } } }).r.stdout, "");
  assert.equal(run("not json", { rate_limits: { five_hour: { used_percentage: 99, resets_at: soon } } }).r.status, 0);
  assert.equal(run("not json", {}).r.stdout, "");
  const g = run(input, "{{garbage");
  assert.equal(g.r.status, 0);
  assert.equal(g.r.stdout, "");
  assert.equal(run(input, undefined).r.stdout, "");
});
