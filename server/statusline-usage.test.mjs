import test from "node:test";
process.env.TZ = "UTC"; // ccusage buckets days in local time
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "pm-sl-usage-"));
process.env.CLAUDE_PROJECTS_ROOT = root;
const { statuslineUsage } = await import("./statusline-usage.mjs");

const now = Date.parse("2026-10-18T15:30:00Z");
const row = (id, agoMs, usage, model = "claude-sonnet-5-5") =>
  JSON.stringify({ timestamp: new Date(now - agoMs).toISOString(), message: { id, model, usage } }) + "\n";
const H = 3600e3;

mkdirSync(join(root, "p1"));
writeFileSync(
  join(root, "p1", "a.jsonl"),
  [
    row("a", 1 * H, { input_tokens: 1_000_000 }), // $2.00, inside the 5h block
    row("a", 1 * H, { input_tokens: 1_000_000 }), // duplicate id, ignored
    row("b", 20 * H, { output_tokens: 1_000_000 }), // $10, yesterday UTC, outside the block
    row("c", 3 * 24 * H, { cache_read_input_tokens: 10_000_000, cache_creation: { ephemeral_1h_input_tokens: 1_000_000 } }), // 1 + 4
    row("old", 9 * 24 * H, { input_tokens: 99_000_000 }), // beyond 7 UTC days
    "not json\n",
  ].join(""),
);

test("statuslineUsage: 5h block, today and 7d match the statusline math", () => {
  const u = statuslineUsage(now);
  assert.equal(u.block.toFixed(2), "2.00");
  assert.equal(u.today.toFixed(2), "2.00");
  assert.equal(u.week.toFixed(2), "17.00");
  assert.equal(u.blockEndsAt, "2026-10-18T19:00:00.000Z");
});

test("statuslineUsage: block is 0 once 5h pass with no new messages", () => {
  const u = statuslineUsage(now + 6 * H);
  assert.equal(u.block, 0);
  assert.equal(u.blockEndsAt, null);
});

test("statuslineUsage: per-file cache picks up appended rows and dropped files", () => {
  const f = join(root, "p1", "b.jsonl");
  const before = statuslineUsage(now).week;
  writeFileSync(f, row("z", 1 * H, { input_tokens: 1_000_000 })); // +$2
  assert.equal((statuslineUsage(now).week - before).toFixed(2), "2.00");
  writeFileSync(f, row("z", 1 * H, { input_tokens: 1_000_000 }) + row("y", 1 * H, { input_tokens: 1_000_000 })); // grew
  assert.equal((statuslineUsage(now).week - before).toFixed(2), "4.00");
  assert.equal(statuslineUsage(now).week, statuslineUsage(now).week); // unchanged files hit the cache
});
