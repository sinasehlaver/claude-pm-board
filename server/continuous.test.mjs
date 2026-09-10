import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fix = mkdtempSync(join(tmpdir(), "pm-cont-"));
mkdirSync(join(fix, "continuous"), { recursive: true });
mkdirSync(join(fix, ".claude", "continuous", "plans"), { recursive: true });
const CFG = join(fix, "continuous", "config.json");
const STATE = join(fix, ".claude", "continuous", "state.json");
const LOG = join(fix, ".claude", "continuous", "log.jsonl");

writeFileSync(
  CFG,
  JSON.stringify(
    {
      cap_5h: 25e6, cap_7d: 2e8, safety: 0.85, active_hours_per_day: 24,
      min_action_tokens: 2e5, human_at_keyboard: false,
      pool: [{ id: "x", effort: "low", w: 1 }],
      secret: "keep-me",
    },
    null,
    2,
  ),
);
writeFileSync(
  STATE,
  JSON.stringify({ calib_mult: 1, last_failure: { slug: "a", action: "b" }, learned_caps: { cap_5h: 21e6 } }),
);
writeFileSync(
  LOG,
  [
    JSON.stringify({ ts: "2026-09-09T01:00:00Z", slug: "p", action: "one", actual: 1000, over: 1.1, err: false }),
    JSON.stringify({ ts: "2026-09-09T02:00:00Z", slug: "p", action: "two", actual: 2000, over: 2.0, err: true }),
    "",
  ].join("\n"),
);

process.env.PM_ROOT = fix;
process.env.CONTINUOUS_ROOT = join(fix, "continuous");
const c = await import("./continuous.mjs");

test("readLog tails newest-first and skips blank lines", async () => {
  const log = await c.readLog(10);
  assert.equal(log.length, 2);
  assert.equal(log[0].action, "two");
  assert.equal(log[1].action, "one");
});

test("readStatus degrades gracefully when src/ modules are absent", async () => {
  const s = await c.readStatus();
  assert.equal(s.config.cap_5h, 25e6);
  assert.equal(s.runner.alive, false);
  assert.equal(s.state.last_failure.slug, "a");
  assert.ok(s.decision === null || "error" in s.decision); // no src/ -> error, not a throw
});

test("writeConfig merges only whitelisted keys", async () => {
  await c.writeConfig({ cap_5h: 9e6, human_at_keyboard: true, secret: "hacked", bogus: 1 });
  const saved = JSON.parse(readFileSync(CFG, "utf8"));
  assert.equal(saved.cap_5h, 9e6);
  assert.equal(saved.human_at_keyboard, true);
  assert.equal(saved.secret, "keep-me");
  assert.ok(!("bogus" in saved));
});

test("clearFailure nulls state.last_failure", async () => {
  await c.clearFailure();
  assert.equal(JSON.parse(readFileSync(STATE, "utf8")).last_failure, null);
});

test("runnerControl rejects unknown actions", async () => {
  await assert.rejects(() => c.runnerControl("nuke"), /bad action/);
});
