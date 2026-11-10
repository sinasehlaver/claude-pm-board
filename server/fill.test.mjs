import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createServer } from "node:net";

// Temp workspace — never the real .claude/.
const root = mkdtempSync(join(tmpdir(), "pm-fill-"));
mkdirSync(join(root, ".claude/backlog"), { recursive: true });
mkdirSync(join(root, ".claude/state"), { recursive: true });
mkdirSync(join(root, ".claude/pm"), { recursive: true });
writeFileSync(
  join(root, ".claude/backlog/hub.md"),
  "# hub — backlog\nUpdated: 2026-10-01\n\n## Todo\n- auto one\n  a note\n- auto two\n- manual only\n\n## Done\n- auto done  (2026-10-01)\n",
);
process.env.PM_ROOT = root;
process.env.PM_LAUNCH_DRYRUN = "1";
process.env.PM_RATE_LIMITS_FILE = join(root, "rate-limits.json");
const fill = await import("./fill.mjs");
const relay = await import("./relay.mjs");

after(() => rmSync(root, { recursive: true, force: true }));

const H = 3_600_000;
const D = 24 * H;
const settings = { ...fill.DEFAULTS, enabled: true };

test("fillTarget: cumulative daily share of the week, capped by the reserve", () => {
  const now = new Date(2026, 9, 28, 10).getTime();
  const endOfDay = new Date(2026, 9, 29).getTime();
  // window opened 2 days before today's midnight -> 3/7 of the week by tonight
  const reset = endOfDay - 3 * D + 7 * D;
  const t = fill.fillTarget({ week: { pct: 10, resetsAtMs: reset } }, now, { reservePct: 5 });
  assert.equal(t, Math.round((300 / 7) * 10) / 10);
  // reset day: whole week allowed, minus reserve
  assert.equal(fill.fillTarget({ week: { pct: 0, resetsAtMs: now + H } }, now, { reservePct: 5 }), 95);
  assert.equal(fill.fillTarget({ week: { pct: 0, resetsAtMs: null } }, now), null);
  assert.equal(fill.fillTarget(null, now), null);
});

test("pickLimits: freshest source wins, past resets roll over to 0%", () => {
  const now = 10_000_000_000_000 / 10; // fixed ms
  const relayRec = { at: now - 60_000, source: "relay", fiveHour: { pct: 50, resetsAt: (now + H) / 1000 }, week: { pct: 30, resetsAt: (now + 2 * D) / 1000 } };
  const sl = fill.fromStatusline({ at: (now - 10_000) / 1000, rate_limits: { five_hour: { used_percentage: 99, resets_at: (now - 1000) / 1000 }, seven_day: { used_percentage: 40, resets_at: (now + 2 * D) / 1000 } } });
  const l = fill.pickLimits([relayRec, sl], now);
  assert.equal(l.source, "statusline");
  assert.equal(l.fiveHour.pct, 0); // its reset already passed
  assert.ok(l.fiveHour.resetsAtMs > now);
  assert.equal(l.week.pct, 40);
  assert.equal(fill.pickLimits([null, fill.fromStatusline({})], now), null);
});

test("decideFill: off / busy / active / 5h full / share used / go / no data", () => {
  const now = Date.now();
  const limits = { fiveHour: { pct: 20, resetsAtMs: now + H }, week: { pct: 10, resetsAtMs: now + 3 * D } };
  const todos = [1, 2, 3, 4, 5, 6, 7].map((i) => ({ slug: "hub", title: `t${i}` }));
  const base = { settings, limits, now, idleSec: 3600, busy: false, todos };
  assert.equal(fill.decideFill({ ...base, settings: { ...settings, enabled: false } }).why, "off");
  assert.equal(fill.decideFill({ ...base, settings: { ...settings, enabled: false }, manual: true }).go, true);
  assert.equal(fill.decideFill({ ...base, busy: true }).go, false);
  assert.equal(fill.decideFill({ ...base, todos: [] }).go, false);
  assert.match(fill.decideFill({ ...base, idleSec: 60 }).why, /active/);
  assert.equal(fill.decideFill({ ...base, idleSec: 60, manual: true }).go, true);
  assert.equal(fill.decideFill({ ...base, idleSec: null }).go, true); // unknown idle (non-mac) = idle
  assert.match(fill.decideFill({ ...base, limits: { ...limits, fiveHour: { pct: 96, resetsAtMs: now + H } } }).why, /5h/);
  assert.match(fill.decideFill({ ...base, limits: { ...limits, week: { pct: 99, resetsAtMs: now + 3 * D } } }).why, /share is used/);
  const go = fill.decideFill(base);
  assert.equal(go.go, true);
  assert.equal(go.todos.length, 5);
  assert.equal(go.stop7d, go.target / 100);
  const probe = fill.decideFill({ ...base, limits: null });
  assert.equal(probe.go, true);
  assert.equal(probe.todos.length, 1);
  assert.equal(probe.stop7d, 0.95);
});

test("cleanSettings: strict rejects bad types and ranges", () => {
  assert.throws(() => fill.cleanSettings({ enabled: "yes" }, true));
  assert.throws(() => fill.cleanSettings({ idleMin: -1 }, true));
  assert.throws(() => fill.cleanSettings({ batch: 1.5 }, true));
  assert.deepEqual(fill.cleanSettings({ enabled: true, batch: 3, junk: 1 }, true), { enabled: true, batch: 3 });
  assert.deepEqual(fill.cleanSettings({ batch: 99 }), {});
});

test("setAuto: validates slug/title, refuses ideas, round-trips", () => {
  assert.throws(() => fill.setAuto("../x", "t", true));
  assert.doesNotThrow(() => fill.setAuto("ideas", "t", false));
  assert.throws(() => fill.setAuto("hub", "", true));
  assert.throws(() => fill.setAuto("hub", "x".repeat(501), true));
  fill.setAuto("hub", "auto one", true);
  fill.setAuto("hub", "x", true);
  fill.setAuto("hub", "x", false);
  assert.deepEqual(fill.readAuto(), { hub: ["auto one"] });
  fill.setAuto("hub", "auto one", false);
  assert.deepEqual(fill.readAuto(), {});
});

test("autoTodos: open marked todos only; a todo fill tried twice is skipped", async () => {
  for (const t of ["auto one", "auto two", "auto done", "gone"]) fill.setAuto("hub", t, true);
  assert.deepEqual((await fill.autoTodos(root, [])).map((t) => t.title), ["auto one", "auto two"]);
  const job = (status) => ({ fill: { stop7d: 0.5 }, status, startedAt: Date.now(), tasks: [{ slug: "hub", title: "auto one" }] });
  assert.equal((await fill.autoTodos(root, [job("stalled")])).length, 2);
  assert.deepEqual((await fill.autoTodos(root, [job("stalled"), job("failed")])).map((t) => t.title), ["auto two"]);
  // a non-fill job, or one that stopped on its target, doesn't count
  assert.equal((await fill.autoTodos(root, [job("filled"), job("filled"), { ...job("failed"), fill: null }, job("failed")])).length, 2);
});

test("auto project: every open todo, including ones added after it was switched on", async () => {
  assert.deepEqual(fill.setAutoProject("ideas", true), ["ideas"]);
  assert.deepEqual(fill.setAutoProject("ideas", false), []);
  assert.throws(() => fill.setAutoProject("../x", true));
  const file = join(root, ".claude/backlog/hub.md");
  const orig = readFileSync(file, "utf8");
  assert.deepEqual(fill.setAutoProject("hub", true), ["hub"]);
  assert.deepEqual((await fill.autoTodos(root, [])).map((t) => t.title), ["auto one", "auto two", "manual only"]);
  writeFileSync(file, orig.replace("- manual only\n", "- manual only\n- added mid-run\n"));
  assert.deepEqual((await fill.autoTodos(root, [])).map((t) => t.title), ["auto one", "auto two", "manual only", "added mid-run"]);
  writeFileSync(file, orig);
  assert.deepEqual(fill.setAutoProject("hub", false), []);
  assert.deepEqual(fill.readAutoProjects(root), []);
  assert.equal((await fill.autoTodos(root, [])).length, 2);
});

test("fillStatus autoList: shows what's queued, how it got there, and tried-out todos", async () => {
  const titles = (l) => l.map((t) => t.title);
  fill.setAutoProject("hub", true);
  let s = await fill.fillStatus({ root, idle: () => null });
  assert.deepEqual(titles(s.autoList), ["auto one", "auto two", "manual only"]);
  assert.ok(s.autoList.every((t) => t.viaProject && !t.skipped));
  assert.equal(s.queued, 3);
  fill.setAutoProject("hub", false);
  s = await fill.fillStatus({ root, idle: () => null });
  assert.deepEqual(titles(s.autoList), ["auto one", "auto two"]);
  assert.ok(s.autoList.every((t) => !t.viaProject));
  assert.deepEqual(Object.keys(s.autoList[0]).sort(), ["skipped", "slug", "title", "viaProject"]);
});

test("pickLimits: a reading with no reset time counts as reset once a whole window has passed", () => {
  const now = 1_000_000_000_000;
  const rec = (age) => ({ at: now - age, source: "relay", fiveHour: { pct: 99, resetsAt: null }, week: { pct: 80, resetsAt: null } });
  assert.equal(fill.pickLimits([rec(H)], now).fiveHour.pct, 99);
  assert.equal(fill.pickLimits([rec(6 * H)], now).fiveHour.pct, 0);
  assert.equal(fill.pickLimits([rec(6 * H)], now).week.pct, 80);
  assert.equal(fill.pickLimits([rec(8 * D)], now).week.pct, 0);
});

test("Fill now with no quota waits, then starts by itself once quota frees up (fill off, user active)", async () => {
  fill.setAuto("hub", "auto one", true);
  writeFileSync(join(root, ".claude/pm/fill.json"), JSON.stringify({ ...fill.DEFAULTS, enabled: false }));
  const launched = [];
  const launch = async (spec) => (launched.push(spec), { job: "j1" });
  const active = () => 10; // at the keyboard
  const now = Date.now();
  const full = { at: now, source: "relay", fiveHour: { pct: 99, resetsAt: (now + H) / 1000 }, week: { pct: 10, resetsAt: (now + 3 * D) / 1000 } };
  writeFileSync(relay.limitsPath(root), JSON.stringify(full));
  const r = await fill.runFill({ root, now, idle: active, manual: true, launch });
  assert.equal(r.launched, false);
  assert.equal(r.pending, true);
  assert.equal(fill.readFillSettings(root).pending, true);
  // timer pass before the reset: still waiting
  assert.equal((await fill.runFill({ root, now: now + 30 * 60_000, idle: active, launch })).launched, false);
  // after the 5h reset the timer launches it and clears pending
  const later = await fill.runFill({ root, now: now + H + 60_000, idle: active, launch });
  assert.equal(later.launched, true);
  assert.equal(launched.length, 1);
  assert.equal(fill.readFillSettings(root).pending, false);
  // no pending + fill off: the timer does nothing
  assert.equal((await fill.runFill({ root, now: now + H + 60_000, idle: active, launch })).launched, false);
  // a refusal that isn't about quota (nothing marked) doesn't arm it
  const marks = fill.readAuto(root);
  for (const t of marks.hub || []) fill.setAuto("hub", t, false);
  const none = await fill.runFill({ root, now: now + H + 60_000, idle: active, manual: true, launch });
  assert.equal(none.launched, false);
  assert.equal(none.pending, false);
  for (const t of marks.hub || []) fill.setAuto("hub", t, true);
  assert.equal(fill.readFillSettings(root).pending, false);
  rmSync(relay.limitsPath(root));
  rmSync(join(root, ".claude/pm/fill.json"));
});

test("relay fillStop + saveLimits", () => {
  const st = relay.emptyRun();
  relay.foldEvent(st, { type: "rate_limit_event", rate_limit_info: { unifiedWindows: { seven_day: { utilization: 0.42, resetsAt: 2e9 }, five_hour: { utilization: 0.1, resetsAt: 2e9 } } } });
  assert.equal(relay.fillStop(st, { fill: { stop7d: 0.4 } }), true);
  assert.equal(relay.fillStop(st, { fill: { stop7d: 0.5 } }), false);
  assert.equal(relay.fillStop(st, {}), false);
  relay.saveLimits(root, st.windows, 123);
  const saved = JSON.parse(readFileSync(relay.limitsPath(root), "utf8"));
  assert.deepEqual(saved, { at: 123, source: "relay", fiveHour: { pct: 10, resetsAt: 2e9 }, week: { pct: 42, resetsAt: 2e9 } });
});

// --- routes against a real server ---------------------------------------
const here = dirname(fileURLToPath(import.meta.url));
let proc;
let B;
const freePort = () =>
  new Promise((res) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });
before(async () => {
  const port = await freePort();
  B = `http://127.0.0.1:${port}`;
  proc = spawn("node", [join(here, "index.mjs")], {
    env: { ...process.env, PORT: String(port), PM_ROOT: root, PM_LAUNCH_DRYRUN: "1", PM_FILL_INTERVAL_MIN: "0" },
    stdio: "ignore",
  });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(B + "/api/health")).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
});
after(() => proc?.kill());
const put = (p, body) => fetch(B + p, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("routes: settings + auto validation, Fill now launches a fill relay job", async () => {
  assert.equal((await put("/api/fill/settings", { batch: 0 })).status, 400);
  assert.equal((await put("/api/fill/settings", { enabled: 1 })).status, 400);
  assert.deepEqual(await (await put("/api/fill/settings", { batch: 1 })).json(), { ...fill.DEFAULTS, batch: 1 });
  assert.equal((await put("/api/fill/auto", { slug: "hub", title: "auto two" })).status, 400);
  assert.equal((await put("/api/fill/auto", { slug: "../etc", title: "x", on: true })).status, 400);
  assert.equal((await put("/api/fill/auto-project", { slug: "hub" })).status, 400);
  assert.equal((await put("/api/fill/auto-project", { slug: "ideas", on: true })).status, 200);
  assert.equal((await put("/api/fill/auto-project", { slug: "ideas", on: false })).status, 200);
  assert.equal((await put("/api/fill/auto-project", { slug: "../etc", on: true })).status, 400);
  assert.deepEqual(await (await put("/api/fill/auto-project", { slug: "hub", on: true })).json(), ["hub"]);
  assert.deepEqual((await (await fetch(B + "/api/fill")).json()).autoProjects, ["hub"]);
  assert.deepEqual(await (await put("/api/fill/auto-project", { slug: "hub", on: false })).json(), []);
  fill.setAuto("hub", "auto one", false);
  fill.setAuto("hub", "auto done", false);
  fill.setAuto("hub", "gone", false);
  assert.equal((await put("/api/fill/auto", { slug: "hub", title: "auto two", on: true })).status, 200);

  writeFileSync(process.env.PM_RATE_LIMITS_FILE, JSON.stringify({ at: Date.now(), rate_limits: { five_hour: { used_percentage: 5, resets_at: Date.now() / 1000 + 3600 }, seven_day: { used_percentage: 1, resets_at: Date.now() / 1000 + 3 * 86400 } } }));
  const s = await (await fetch(B + "/api/fill")).json();
  assert.equal(s.queued, 1);
  assert.deepEqual(s.queuedBySlug, { hub: 1 });
  assert.equal(s.limits.source, "statusline");
  assert.equal(s._todos, undefined);

  const r = await fetch(B + "/api/fill/run", { method: "POST" });
  assert.equal(r.status, 200);
  const { job } = await r.json();
  const spec = JSON.parse(readFileSync(join(root, ".claude/pm/relay", `${job}.spec.json`), "utf8"));
  assert.deepEqual(spec.tasks, [{ slug: "hub", title: "auto two" }]);
  assert.ok(spec.fill.stop7d > 0 && spec.fill.stop7d <= 0.95);
  assert.match(spec.prompt, /auto two/);
  assert.ok(readdirSync(join(root, ".claude/pm/relay")).length >= 1);

  fill.setAuto("hub", "auto two", false);
  const none = await fetch(B + "/api/fill/run", { method: "POST" });
  assert.equal(none.status, 409);
  assert.match((await none.json()).error, /no open todos/);
});

test("ideas: an auto idea is picked up and fill's prompt is the relay idea brief", async () => {
  mkdirSync(join(root, ".claude/backlog"), { recursive: true });
  writeFileSync(join(root, ".claude/backlog/ideas.md"), "# ideas — backlog\nUpdated: 2026-10-01\n\n## Todo\n- a fine idea\n  its note\n");
  fill.setAuto("ideas", "a fine idea", true);
  try {
    const got = await fill.autoTodos(root, []);
    assert.ok(got.some((t) => t.slug === "ideas" && t.title === "a fine idea"));
    const { seedForFill } = await import("./launch.mjs");
    const p = seedForFill({ tasks: got.filter((t) => t.slug === "ideas") });
    assert.match(p, /IDEA: a fine idea/);
    assert.match(p, /backlog-cli\.mjs create /);
    assert.match(p, /move ideas Done/);
    assert.doesNotMatch(p, /Remove the idea's bullet from/);
  } finally {
    fill.setAuto("ideas", "a fine idea", false);
  }
});
