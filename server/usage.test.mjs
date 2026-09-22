import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "pm-usage-"));
process.env.CLAUDE_PROJECTS_ROOT = root;

const now = Date.now();
const iso = (msAgo) => new Date(now - msAgo).toISOString();

function line(obj) {
  return JSON.stringify(obj) + "\n";
}

function turn({ id, tsMsAgo, model = "claude-sonnet-5", usage }) {
  return line({
    type: "assistant",
    timestamp: iso(tsMsAgo),
    message: { id, model, usage },
  });
}

const projDir = join(root, "-Users-sina-Projects-hub");
mkdirSync(projDir, { recursive: true });
writeFileSync(
  join(projDir, "main-session.jsonl"),
  [
    turn({ id: "m1", tsMsAgo: 30 * 60_000, usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 200 } }),
    turn({ id: "m2", tsMsAgo: 3 * 3600_000, usage: { input_tokens: 2000, output_tokens: 1000 } }),
    turn({ id: "m3", tsMsAgo: 6 * 24 * 3600_000, usage: { input_tokens: 5000, output_tokens: 2000 } }),
    turn({ id: "old", tsMsAgo: 10 * 24 * 3600_000, usage: { input_tokens: 999999, output_tokens: 999999 } }),
  ].join(""),
);

// a subagent turn that duplicates a main-session message.id must not double-count
const subDir = join(projDir, "main-session", "subagents");
mkdirSync(subDir, { recursive: true });
writeFileSync(
  join(subDir, "sub.jsonl"),
  [
    turn({ id: "m1", tsMsAgo: 30 * 60_000, usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 200 } }),
    turn({ id: "s1", tsMsAgo: 20 * 60_000, usage: { input_tokens: 300, output_tokens: 100 } }),
  ].join(""),
);

// Streaming assistant turns write the same message.id multiple times as the
// response fills in, each with a growing usage.output_tokens snapshot — only
// the LAST line for an id is the final, complete usage. Own fixture root so
// it never perturbs the rolling-window sums above.
const streamRoot = mkdtempSync(join(tmpdir(), "pm-usage-stream-"));
const streamDir = join(streamRoot, "-Users-sina-Projects-stream");
mkdirSync(streamDir, { recursive: true });
writeFileSync(
  join(streamDir, "stream-session.jsonl"),
  [
    turn({ id: "st1", tsMsAgo: 30 * 60_000, usage: { input_tokens: 2, output_tokens: 7 } }),
    turn({ id: "st1", tsMsAgo: 30 * 60_000, usage: { input_tokens: 2, output_tokens: 7 } }),
    turn({ id: "st1", tsMsAgo: 30 * 60_000, usage: { input_tokens: 2, output_tokens: 447 } }),
  ].join(""),
);

// A real quotaLimits throttle from 20 days ago, in its own fixture root (kept
// separate from `root` above so it never perturbs the other tests' turn counts
// or rolling-window sums) — only exercised by the cap-learning tests below,
// which swap CLAUDE_PROJECTS_ROOT onto it for the duration of the test.
function rejection({ tsMsAgo, rateLimitType }) {
  return line({
    type: "assistant",
    timestamp: iso(tsMsAgo),
    message: { id: `rej-${tsMsAgo}`, model: "claude-sonnet-5", usage: { input_tokens: 0, output_tokens: 0 } },
    quotaLimits: { status: "rejected", rateLimitType, resetsAt: (now - tsMsAgo) / 1000 + 3600 },
  });
}

const capRoot = mkdtempSync(join(tmpdir(), "pm-usage-caps-"));
const capDir = join(capRoot, "-Users-sina-Projects-caps");
mkdirSync(capDir, { recursive: true });
writeFileSync(
  join(capDir, "cap-session.jsonl"),
  [
    turn({
      id: "capturn",
      tsMsAgo: 20 * 24 * 3600_000 + 3600_000, // 1h before the rejection, inside its 5h window
      usage: { input_tokens: 10000, output_tokens: 5000 },
    }),
    turn({ id: "recent1", tsMsAgo: 30 * 60_000, usage: { input_tokens: 3000, output_tokens: 2100 } }),
    rejection({ tsMsAgo: 20 * 24 * 3600_000, rateLimitType: "five_hour" }),
  ].join(""),
);

const {
  allTurns,
  burnSnapshot,
  burnBreakdown,
  summary,
  rateLimitStatus,
  learnedCaps,
  accountRateLimitStatus,
  paceBreakdown,
  readUsageLimitsConfig,
  writeUsageLimitsWindow,
} = await import("./usage.mjs");

// Every accountRateLimitStatus/limits-config test gets its own usage-limits
// file so "manual" settings from one test never leak into another.
function freshLimitsPath(dir) {
  const p = join(dir, "usage-limits.json");
  process.env.PM_USAGE_LIMITS_PATH = p;
  return p;
}

test("allTurns dedupes a subagent turn that repeats a main-session message.id", async () => {
  const turns = await allTurns();
  const ids = turns.map((t) => t.id);
  assert.equal(ids.filter((id) => id === "m1").length, 1);
  assert.ok(ids.includes("s1"));
  assert.equal(turns.length, 5); // m1, m2, m3, old, s1 (dup m1 dropped)
});

test("parseFile keeps the LAST usage snapshot for a repeated streaming message.id, not the first", async () => {
  const prevRoot = process.env.CLAUDE_PROJECTS_ROOT;
  process.env.CLAUDE_PROJECTS_ROOT = streamRoot;
  try {
    const turns = await allTurns();
    assert.equal(turns.length, 1);
    assert.equal(turns[0].id, "st1");
    assert.equal(turns[0].output, 447); // final streamed value, not the first partial 7
  } finally {
    process.env.CLAUDE_PROJECTS_ROOT = prevRoot;
  }
});

test("burnSnapshot sums rolling windows correctly", async () => {
  const snap = await burnSnapshot(now);
  // 1h window: m1 (1700) + s1 (400) = 2100
  assert.equal(snap.used_1h, 2100);
  // 5h window: + m2 (3000) = 5100
  assert.equal(snap.used_5h, 5100);
  // 7d window: + m3 (7000), excludes "old" at 10d = 12100
  assert.equal(snap.used_7d, 12100);
});

test("burnBreakdown returns per-model rows matching burnSnapshot's window sums", async () => {
  const snap = await burnSnapshot(now);
  const bd = await burnBreakdown(now);
  const tokensOf = (rows) =>
    rows.reduce((s, r) => s + r.input + r.output + r.cache_read + r.cache_creation_1h + r.cache_creation_5m, 0);
  assert.equal(tokensOf(bd.win1h), snap.used_1h);
  assert.equal(tokensOf(bd.win5h), snap.used_5h);
  assert.equal(tokensOf(bd.win7d), snap.used_7d);
  assert.ok(bd.win1h.every((r) => r.model === "claude-sonnet-5"));
});

test("summary buckets by day and model, excluding old data past the window", async () => {
  const rows = await summary({ bucket: "day", days: 7 });
  const total = rows.reduce((s, r) => s + r.input + r.output, 0);
  // excludes the 10-day-old 999999+999999 turn
  assert.ok(total < 900000);
  assert.ok(rows.every((r) => r.model === "claude-sonnet-5"));
});

test("rateLimitStatus returns null without a status cache file", () => {
  process.env.CLAUDE_STATUS_CACHE = join(root, "no-such-file.json");
  assert.equal(rateLimitStatus(), null);
});

test("rateLimitStatus flags stale data and normalizes reset timestamps", () => {
  const cachePath = join(root, "status-cache.json");
  writeFileSync(
    cachePath,
    JSON.stringify({
      updatedAt: new Date(now - 20 * 60_000).toISOString(),
      usageData: { utilization5h: 42, utilization7d: 10, limitStatus: "allowed", reset5hAt: now / 1000 + 3600 },
    }),
  );
  process.env.CLAUDE_STATUS_CACHE = cachePath;
  const s = rateLimitStatus();
  assert.equal(s.stale, true); // >15 min old
  assert.equal(s.utilization5h, 42);
  assert.ok(s.reset5hAt.startsWith(new Date(now + 3600_000).toISOString().slice(0, 10)));
});

test("learnedCaps learns the 5h cap from a real quotaLimits rejection, falls back to placeholders for 7d/30d", async () => {
  const prevRoot = process.env.CLAUDE_PROJECTS_ROOT;
  process.env.CLAUDE_PROJECTS_ROOT = capRoot;
  try {
    const caps = await learnedCaps(now);
    assert.equal(caps["5h"].cap, 15000); // capturn's 10000+5000, the only turn inside the rejection's 5h lookback
    assert.equal(caps["5h"].learned, true);
    assert.equal(caps["7d"].learned, false); // no seven_day rejection ever recorded
    assert.equal(caps["30d"].learned, false);
    assert.ok(caps["7d"].cap > 0 && caps["30d"].cap > 0);
  } finally {
    process.env.CLAUDE_PROJECTS_ROOT = prevRoot;
  }
});

test("readUsageLimitsConfig defaults every window to estimated/no-manual-value without a file", () => {
  const dir = mkdtempSync(join(tmpdir(), "pm-usage-limitscfg-"));
  freshLimitsPath(dir);
  try {
    const cfg = readUsageLimitsConfig();
    assert.deepEqual(Object.keys(cfg).sort(), ["30d", "5h", "7d"]);
    for (const key of ["5h", "7d", "30d"]) {
      assert.equal(cfg[key].mode, "estimated");
      assert.equal(cfg[key].manualCapTokens, null);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeUsageLimitsWindow persists a single window's mode/value and leaves the others untouched", () => {
  const dir = mkdtempSync(join(tmpdir(), "pm-usage-limitscfg-"));
  freshLimitsPath(dir);
  try {
    writeUsageLimitsWindow("5h", { mode: "manual", manualCapTokens: 12_000_000 });
    const cfg = readUsageLimitsConfig();
    assert.equal(cfg["5h"].mode, "manual");
    assert.equal(cfg["5h"].manualCapTokens, 12_000_000);
    assert.equal(cfg["7d"].mode, "estimated"); // untouched
    assert.throws(() => writeUsageLimitsWindow("5h", { mode: "bogus" }));
    assert.throws(() => writeUsageLimitsWindow("60d", { mode: "manual" }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("accountRateLimitStatus (mode=estimated, default) uses token burn against the learned cap when the vscode cache is absent", async () => {
  const prevRoot = process.env.CLAUDE_PROJECTS_ROOT;
  const dir = mkdtempSync(join(tmpdir(), "pm-usage-limitscfg-"));
  freshLimitsPath(dir);
  process.env.CLAUDE_PROJECTS_ROOT = capRoot;
  process.env.CLAUDE_STATUS_CACHE = join(capRoot, "no-such-file.json");
  try {
    const s = await accountRateLimitStatus(now);
    const w5h = s.windows["5h"];
    assert.equal(w5h.mode, "estimated");
    assert.equal(w5h.available, true);
    assert.equal(w5h.capLearned, true);
    assert.equal(w5h.utilization, 34); // recent1's 5100 tokens / 15000 learned cap, rounded
    assert.equal(w5h.resetAt, null); // not over cap -> nothing to project
    assert.equal(w5h.resetProjected, true);
  } finally {
    process.env.CLAUDE_PROJECTS_ROOT = prevRoot;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("accountRateLimitStatus (mode=synced) reports the real vscode cache % + reset when live", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pm-usage-limitscfg-"));
  freshLimitsPath(dir);
  writeUsageLimitsWindow("5h", { mode: "synced" });
  const cachePath = join(root, "live-cache.json");
  writeFileSync(
    cachePath,
    JSON.stringify({
      updatedAt: new Date(now - 1000).toISOString(),
      usageData: { utilization5h: 77, utilization7d: 5, limitStatus: "allowed", reset5hAt: now / 1000 + 3600 },
    }),
  );
  process.env.CLAUDE_STATUS_CACHE = cachePath;
  try {
    const s = await accountRateLimitStatus(now);
    assert.equal(s.windows["5h"].mode, "synced");
    assert.equal(s.windows["5h"].available, true);
    assert.equal(s.windows["5h"].utilization, 77);
    assert.equal(s.windows["5h"].resetProjected, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("accountRateLimitStatus (mode=synced) is unavailable rather than silently estimating when the cache is stale/absent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pm-usage-limitscfg-"));
  freshLimitsPath(dir);
  writeUsageLimitsWindow("5h", { mode: "synced" });
  process.env.CLAUDE_STATUS_CACHE = join(dir, "no-such-file.json");
  try {
    const s = await accountRateLimitStatus(now);
    assert.equal(s.windows["5h"].available, false);
    assert.equal(s.windows["5h"].utilization, null);
    // 30d has no cache field at all, so synced there is always unavailable
    writeUsageLimitsWindow("30d", { mode: "synced" });
    const s2 = await accountRateLimitStatus(now);
    assert.equal(s2.windows["30d"].available, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("accountRateLimitStatus (mode=manual) uses the user-entered cap and never changes on its own", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pm-usage-limitscfg-"));
  freshLimitsPath(dir);
  process.env.CLAUDE_STATUS_CACHE = join(dir, "no-such-file.json");
  writeUsageLimitsWindow("5h", { mode: "manual", manualCapTokens: 10_200 }); // recent1's 5100 tokens -> 50%
  try {
    const s1 = await accountRateLimitStatus(now);
    assert.equal(s1.windows["5h"].mode, "manual");
    assert.equal(s1.windows["5h"].capTokens, 10_200);
    assert.equal(s1.windows["5h"].utilization, 50);
    // re-reading later must not have drifted — no auto-sync/estimate ever touches a manual value
    const s2 = await accountRateLimitStatus(now + 60_000);
    assert.equal(s2.windows["5h"].capTokens, 10_200);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("accountRateLimitStatus (mode=manual) is unavailable until a value is actually set", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pm-usage-limitscfg-"));
  freshLimitsPath(dir);
  writeUsageLimitsWindow("5h", { mode: "manual" }); // no manualCapTokens yet
  try {
    const s = await accountRateLimitStatus(now);
    assert.equal(s.windows["5h"].available, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("paceBreakdown only counts turns inside the pace window, not the full hour", async () => {
  const paceRoot = mkdtempSync(join(tmpdir(), "pm-usage-pace-"));
  const dir = join(paceRoot, "-Users-sina-Projects-pace");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "pace-session.jsonl"),
    [
      turn({ id: "inpace", tsMsAgo: 2 * 60_000, usage: { input_tokens: 600, output_tokens: 300 } }),
      turn({ id: "outpace", tsMsAgo: 20 * 60_000, usage: { input_tokens: 9000, output_tokens: 9000 } }),
    ].join(""),
  );
  const prevRoot = process.env.CLAUDE_PROJECTS_ROOT;
  process.env.CLAUDE_PROJECTS_ROOT = paceRoot;
  try {
    const rows = await paceBreakdown(now);
    const total = rows.reduce((s, r) => s + r.input + r.output, 0);
    assert.equal(total, 900); // only "inpace"'s 600+300; "outpace" is outside the 5-min window
  } finally {
    process.env.CLAUDE_PROJECTS_ROOT = prevRoot;
    rmSync(paceRoot, { recursive: true, force: true });
  }
});

test("accountRateLimitStatus projects a reset time once estimated usage exceeds the learned cap", async () => {
  const overRoot = mkdtempSync(join(tmpdir(), "pm-usage-over-"));
  const dir = join(overRoot, "-Users-sina-Projects-over");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "over-session.jsonl"),
    [
      // teaches a cap of 1000 via a rejection 15 days ago
      turn({ id: "capturn2", tsMsAgo: 15 * 24 * 3600_000 + 3600_000, usage: { input_tokens: 700, output_tokens: 300 } }),
      rejection({ tsMsAgo: 15 * 24 * 3600_000, rateLimitType: "five_hour" }),
      // current 5h window: two turns totalling 1400 > the 1000 cap
      turn({ id: "cur1", tsMsAgo: 4 * 3600_000 + 50 * 60_000, usage: { input_tokens: 700, output_tokens: 0 } }),
      turn({ id: "cur2", tsMsAgo: 10 * 60_000, usage: { input_tokens: 700, output_tokens: 0 } }),
    ].join(""),
  );
  const prevRoot = process.env.CLAUDE_PROJECTS_ROOT;
  const prevCache = process.env.CLAUDE_STATUS_CACHE;
  freshLimitsPath(overRoot);
  process.env.CLAUDE_PROJECTS_ROOT = overRoot;
  process.env.CLAUDE_STATUS_CACHE = join(overRoot, "no-such-file.json");
  try {
    const s = await accountRateLimitStatus(now);
    const w5h = s.windows["5h"];
    assert.equal(w5h.mode, "estimated");
    assert.equal(w5h.capTokens, 1000);
    assert.equal(w5h.usedTokens, 1400);
    assert.ok(w5h.utilization > 100);
    assert.ok(w5h.resetAt); // over cap -> a projected reset is reported
    // cur1 ages out of the 5h window at cur1.ts + 5h, ~10 min from now
    const resetMs = Date.parse(w5h.resetAt) - now;
    assert.ok(resetMs > 0 && resetMs < 15 * 60_000);
  } finally {
    process.env.CLAUDE_PROJECTS_ROOT = prevRoot;
    process.env.CLAUDE_STATUS_CACHE = prevCache;
    rmSync(overRoot, { recursive: true, force: true });
  }
});

test("accountRateLimitStatus (mode=manual) uses a plain rolling sum, same as estimated — not a reconstructed reset grid", async () => {
  // An earlier version computed manual mode against a reconstructed
  // Anthropic reset grid; that measurably undercounted against real
  // references (claude.ai's own Usage page, claude_usage_dashboard) because
  // the reconstructed "current block" doesn't reliably track when
  // Anthropic's real window actually opened. A turn just outside the window
  // must not count, and one just inside must, exactly like sumSince.
  const winRoot = mkdtempSync(join(tmpdir(), "pm-usage-manualroll-"));
  const dir = join(winRoot, "-Users-sina-Projects-manualroll");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "manualroll-session.jsonl"),
    [
      turn({ id: "outside5h", tsMsAgo: 5 * 3600_000 + 60_000, usage: { input_tokens: 999, output_tokens: 999 } }),
      turn({ id: "inside5h", tsMsAgo: 4 * 3600_000, usage: { input_tokens: 100, output_tokens: 0 } }),
    ].join(""),
  );
  const prevRoot = process.env.CLAUDE_PROJECTS_ROOT;
  freshLimitsPath(winRoot);
  process.env.CLAUDE_PROJECTS_ROOT = winRoot;
  writeUsageLimitsWindow("5h", { mode: "manual", manualCapTokens: 1_000_000 });
  try {
    const s = await accountRateLimitStatus(now);
    assert.equal(s.windows["5h"].usedTokens, 100); // only "inside5h"
    assert.equal(s.windows["5h"].resetAt, null); // under cap -> nothing to project
  } finally {
    process.env.CLAUDE_PROJECTS_ROOT = prevRoot;
    rmSync(winRoot, { recursive: true, force: true });
  }
});

test("accountRateLimitStatus (mode=manual) 30d and 7d sum independently — an old turn outside 7d still counts toward 30d", async () => {
  const winRoot = mkdtempSync(join(tmpdir(), "pm-usage-30d-"));
  const dir = join(winRoot, "-Users-sina-Projects-30d");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "thirtyd-session.jsonl"),
    [
      turn({ id: "old20d", tsMsAgo: 20 * 24 * 3600_000, usage: { input_tokens: 50000, output_tokens: 0 } }),
      turn({ id: "recent3d", tsMsAgo: 3 * 24 * 3600_000, usage: { input_tokens: 100, output_tokens: 0 } }),
    ].join(""),
  );
  const prevRoot = process.env.CLAUDE_PROJECTS_ROOT;
  freshLimitsPath(winRoot);
  process.env.CLAUDE_PROJECTS_ROOT = winRoot;
  writeUsageLimitsWindow("30d", { mode: "manual", manualCapTokens: 1_000_000 });
  writeUsageLimitsWindow("7d", { mode: "manual", manualCapTokens: 1_000_000 });
  try {
    const s = await accountRateLimitStatus(now);
    assert.equal(s.windows["30d"].usedTokens, 50100); // both turns, 20d one included
    assert.equal(s.windows["7d"].usedTokens, 100); // only the 3d-old turn
  } finally {
    process.env.CLAUDE_PROJECTS_ROOT = prevRoot;
    rmSync(winRoot, { recursive: true, force: true });
  }
});

test.after(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(capRoot, { recursive: true, force: true });
});
