import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Temp workspace — never the real .claude/. Must be set before launch.mjs loads.
const root = mkdtempSync(join(tmpdir(), "pm-relay-"));
mkdirSync(join(root, ".claude/backlog"), { recursive: true });
process.env.PM_ROOT = root;
process.env.PM_LAUNCH_DRYRUN = "1";
after(() => rmSync(root, { recursive: true, force: true }));

const R = await import("./relay.mjs");
const { launchRelay, seedForSequentialRun, seedForCrossProjectRun } = await import("./launch.mjs");
const cfg = R.relayConfig({});

const ev = (o) => o;
const rl = (status, type, resetsAt, windows) => ({
  type: "rate_limit_event",
  rate_limit_info: { status, rateLimitType: type, resetsAt, unifiedWindows: windows },
});

test("foldEvent: tracks session, windows, rejection, result", () => {
  const st = R.emptyRun();
  R.foldEvent(st, ev({ type: "system", session_id: "abc" }));
  R.foldEvent(st, rl("allowed", "five_hour", 100, { five_hour: { utilization: 0.74, resetsAt: 100 }, seven_day: { utilization: 9, resetsAt: 200 } }));
  assert.equal(st.sessionId, "abc");
  assert.equal(st.windows.five_hour.utilization, 0.74);
  assert.equal(st.windows.seven_day.utilization, 0.09); // percent-looking values are normalised
  assert.equal(st.rejected, null);
  R.foldEvent(st, rl("rejected", "five_hour", 500));
  assert.deepEqual(st.rejected, { type: "five_hour", resetsAt: 500 });
  R.foldEvent(st, ev({ type: "result", is_error: true, result: "boom" }));
  assert.equal(st.result.isError, true);
});

test("limitHit: rejected event wins; error text is a fallback; a clean run is not a limit", () => {
  const st = R.emptyRun();
  assert.equal(R.limitHit(st), null);
  R.foldEvent(st, ev({ type: "result", is_error: false, result: "You've hit your limit" }));
  assert.equal(R.limitHit(st), null);
  const st2 = R.emptyRun();
  R.foldEvent(st2, rl("allowed", "five_hour", 100, { five_hour: { utilization: 0.5, resetsAt: 100 } }));
  R.foldEvent(st2, ev({ type: "result", is_error: true, result: "You've hit your limit · resets 3pm" }));
  assert.deepEqual(R.limitHit(st2), { type: "five_hour", resetsAtMs: 100_000 });
  const st3 = R.emptyRun();
  R.foldEvent(st3, rl("rejected", "seven_day", 900));
  assert.deepEqual(R.limitHit(st3), { type: "seven_day", resetsAtMs: 900_000 });
});

test("softStop: only above threshold and only while the window is still open", () => {
  const now = 1_000_000;
  const st = R.emptyRun();
  R.foldEvent(st, rl("allowed", "five_hour", 2000, { five_hour: { utilization: 0.94, resetsAt: 2000 } }));
  assert.equal(R.softStop(st, cfg, now), null);
  R.foldEvent(st, rl("allowed", "five_hour", 2000, { five_hour: { utilization: 0.96, resetsAt: 2000 } }));
  assert.deepEqual(R.softStop(st, cfg, now), { type: "five_hour", resetsAtMs: 2_000_000 });
  assert.equal(R.softStop(st, cfg, 3_000_000), null); // window already reset
});

test("decide: done / wait-with-buffer / unknown reset / nudge / stalled / fail", () => {
  const now = 10_000;
  const c = () => ({ limitHits: 0, errors: 0, nudges: 0 });
  const st = (fn) => fn(R.emptyRun());
  assert.equal(R.decide({ st: R.emptyRun(), open: 0, prevOpen: 2, now, cfg, c: c() }).kind, "done");

  const limited = st((s) => R.foldEvent(s, rl("rejected", "five_hour", 60)));
  const w = R.decide({ st: limited, open: 2, prevOpen: 2, now, cfg, c: c() });
  assert.equal(w.kind, "wait");
  assert.equal(w.until, 60_000 + cfg.bufferMs);
  assert.equal(w.known, true);

  // reset time already in the past / missing -> probe later, never a tight loop
  const stale = st((s) => R.foldEvent(s, rl("rejected", "five_hour", 1)));
  const p = R.decide({ st: stale, open: 2, prevOpen: 2, now, cfg, c: c() });
  assert.equal(p.until, now + cfg.unknownResetMs + cfg.bufferMs);

  const clean = st((s) => R.foldEvent(s, ev({ type: "result", is_error: false, result: "ok" })));
  const cc = c();
  assert.equal(R.decide({ st: clean, open: 1, prevOpen: 2, now, cfg, c: cc }).kind, "nudge");
  assert.equal(R.decide({ st: clean, open: 1, prevOpen: 1, now, cfg, c: cc }).kind, "stalled"); // no progress

  const hits = c();
  for (let i = 0; i < cfg.maxLimitHits; i++) assert.equal(R.decide({ st: limited, open: 2, prevOpen: 2, now, cfg, c: hits }).kind, "wait");
  assert.equal(R.decide({ st: limited, open: 2, prevOpen: 2, now, cfg, c: hits }).kind, "fail");
  // progress resets the no-progress counter
  assert.equal(R.decide({ st: limited, open: 1, prevOpen: 2, now, cfg, c: hits }).kind, "wait");
  assert.equal(hits.limitHits, 1);

  const errs = c();
  const bad = st((s) => R.foldEvent(s, ev({ type: "result", is_error: true, result: "kaboom" })));
  for (let i = 0; i < cfg.maxErrors; i++) assert.equal(R.decide({ st: bad, open: 1, prevOpen: 1, now, cfg, c: errs }).kind, "wait");
  assert.equal(R.decide({ st: bad, open: 1, prevOpen: 1, now, cfg, c: errs }).kind, "fail");
});

test("openTasks: title match, Todo/Doing only, missing/renamed/Blocked/Done count as resolved", () => {
  writeFileSync(
    join(root, ".claude/backlog/p.md"),
    "# p — backlog\nUpdated: 2026-09-20\n\n## Doing\n- doing one\n\n## Todo\n- todo one  @seq  p2\n\n## Blocked\n- blocked one\n\n## Done\n- done one  (2026-09-20)\n",
  );
  const tasks = ["doing one", "todo one", "blocked one", "done one", "gone"].map((title) => ({ slug: "p", title }));
  assert.deepEqual(R.openTasks(root, tasks).map((t) => t.title), ["doing one", "todo one"]);
  assert.deepEqual(R.openTasks(root, [{ slug: "nofile", title: "x" }]), []);
});

test("continuePrompt names the limit window and lists what is still open", () => {
  const open = [{ slug: "hub", title: "wire feeds" }];
  const limit = R.continuePrompt({ reason: "limit", open, limitType: "five_hour", at: Date.now() });
  assert.match(limit, /five-hour window/);
  assert.match(limit, /CONTINUE from there/);
  assert.match(limit, /- \[hub\] wire feeds/);
  assert.match(R.continuePrompt({ reason: "nudge", open }), /still open/);
});

test("relay seeds: unattended pacing replaces the stop-and-exit pacing", () => {
  const tasks = [{ slug: "hub", title: "t1" }];
  for (const s of [
    seedForSequentialRun({ slug: "hub", tasks, relay: true }),
    seedForCrossProjectRun({ tasks, relay: true }),
  ]) {
    assert.match(s, /UNATTENDED RUN/);
    assert.match(s, /resumes this SAME session/);
    assert.match(s, /do NOT stop early/i);
    assert.doesNotMatch(s, /a human will/);
  }
  assert.match(seedForSequentialRun({ slug: "hub", tasks }), /a human will/); // interactive path unchanged
});

test("launchRelay (dryrun): writes a spec and builds a caffeinate + node relay-cli command", async () => {
  const r = await launchRelay({ cwd: root, prompt: "do it $(rm -rf /)", label: "hub (1)", tasks: [{ slug: "hub", title: "t1", note: "x" }] });
  assert.equal(r.relay, true);
  assert.match(r.cmd, /caffeinate -is node '.*relay-cli\.mjs' '.*\.spec\.json'/);
  assert.match(r.cmd, new RegExp(`PM_ROOT='${root}'`));
  assert.doesNotMatch(r.cmd, /rm -rf/); // prompt text never reaches the command line
  const spec = JSON.parse(readFileSync(R.specPathFor(root, r.job), "utf8"));
  assert.equal(spec.prompt, "do it $(rm -rf /)");
  assert.deepEqual(spec.tasks, [{ slug: "hub", title: "t1" }]); // only slug+title are tracked
});

// ---- end to end against a fake `claude` -----------------------------------

function fakeClaude(dir) {
  const bin = join(dir, "fake-claude.mjs");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
const args = process.argv.slice(2);
const resume = args.includes("--resume") ? args[args.indexOf("--resume") + 1] : null;
let prompt = ""; for await (const c of process.stdin) prompt += c;
appendFileSync(process.env.FAKE_LOG, JSON.stringify({ args, prompt, model: process.env.ANTHROPIC_MODEL }) + "\\n");
const out = (o) => console.log(JSON.stringify(o));
const sid = "sess-1234";
out({ type: "system", subtype: "init", session_id: sid });
const soon = Math.ceil(Date.now() / 1000) + 2;
if (!resume && process.env.FAKE_MODE === "reject") {
  out({ type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "five_hour", resetsAt: soon }, session_id: sid });
  out({ type: "result", subtype: "success", is_error: true, result: "You've hit your limit", session_id: sid });
  process.exit(1);
}
if (!resume && process.env.FAKE_MODE === "soft") {
  out({ type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", rateLimitType: "five_hour", resetsAt: soon, unifiedWindows: { five_hour: { utilization: 0.97, resetsAt: soon } } }, session_id: sid });
  setInterval(() => {}, 1000); // hang until the relay stops us
} else {
  const p = process.env.FAKE_BACKLOG;
  writeFileSync(p, readFileSync(p, "utf8").replace("## Todo\\n- ship it", "## Done\\n- ship it  (2026-09-20)"));
  out({ type: "result", subtype: "success", is_error: false, result: "done", session_id: sid });
}
`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

async function e2e(mode) {
  const dir = mkdtempSync(join(root, "e2e-"));
  const backlog = join(root, ".claude/backlog/e2e.md");
  writeFileSync(backlog, "# e2e — backlog\nUpdated: 2026-09-20\n\n## Todo\n- ship it\n");
  const log = join(dir, "calls.jsonl");
  writeFileSync(log, "");
  const specPath = join(dir, "spec.json");
  writeFileSync(specPath, JSON.stringify({ id: `e2e-${mode}`, label: "e2e", root, cwd: root, prompt: "original prompt", tasks: [{ slug: "e2e", title: "ship it" }] }));
  const t0 = Date.now();
  // the fake claude inherits process.env, exactly like the real one would
  Object.assign(process.env, {
    CLAUDE_BIN: fakeClaude(dir),
    FAKE_MODE: mode,
    FAKE_LOG: log,
    FAKE_BACKLOG: backlog,
    PM_RELAY_BUFFER_MS: "0",
    PM_RELAY_TICK_MS: "100",
    PM_RELAY_KILL_GRACE_MS: "2000",
    PM_RELAY_NOTIFY: "0",
  });
  const job = await R.runRelay(specPath, process.env);
  const calls = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  return { job, calls, ms: Date.now() - t0, jobFile: JSON.parse(readFileSync(join(R.relayDir(root), `e2e-${mode}.job.json`), "utf8")) };
}

test("e2e: rate-limit rejection -> waits for the reset time -> resumes the same session -> done", async () => {
  const { job, calls, ms, jobFile } = await e2e("reject");
  assert.equal(job.status, "done");
  assert.equal(job.attempt, 2);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].prompt, "original prompt");
  assert.ok(!calls[0].args.includes("--resume"));
  assert.deepEqual(calls[1].args.slice(calls[1].args.indexOf("--resume")), ["--resume", "sess-1234"]);
  assert.match(calls[1].prompt, /rate limit/i);
  assert.match(calls[1].prompt, /- \[e2e\] ship it/);
  for (const a of ["--permission-mode", "acceptEdits", "--disallowed-tools", "Bash(git *)"]) assert.ok(calls[0].args.includes(a), a);
  // Edit/Write on .claude/** is hard-blocked headless: the ONLY extra allowance is the backlog helper.
  assert.deepEqual(calls[0].args.filter((a, i) => calls[0].args[i - 1] === "--allowed-tools"), [`Bash(node ${R.BACKLOG_CLI} *)`]);
  assert.ok(!calls[0].args.includes("bypassPermissions"));
  assert.ok(ms >= 900, `should have waited for the reset (took ${ms}ms)`);
  assert.equal(jobFile.status, "done");
  assert.ok(jobFile.events.some((e) => /five_hour limit/.test(e.msg)));
});

test("e2e: utilization past the soft threshold stops the child and waits instead of hitting the wall", async () => {
  const { job, calls } = await e2e("soft");
  assert.equal(job.status, "done");
  assert.equal(calls.length, 2);
  assert.ok(job.events.some((e) => /utilization 97%/.test(e.msg)));
});

test("listRelayJobs: newest first; a live-looking job with a dead pid is reported dead", () => {
  R.writeJson(join(R.relayDir(root), "old.job.json"), { id: "old", status: "running", pid: 2 ** 22 + 1, startedAt: 1 });
  R.writeJson(join(R.relayDir(root), "new.job.json"), { id: "new", status: "done", pid: 1, startedAt: 2 });
  const jobs = R.listRelayJobs(root, { limit: 50 });
  const ids = jobs.map((j) => j.id);
  assert.ok(ids.indexOf("new") < ids.indexOf("old"));
  assert.equal(jobs.find((j) => j.id === "old").status, "dead");
  assert.equal(jobs.find((j) => j.id === "new").status, "done");
  assert.ok(existsSync(R.specPathFor(root, "x")) === false);
});

test("dismissRelay: deletes a finished job's files, refuses a live one", () => {
  const dir = R.relayDir(root);
  R.writeJson(join(dir, "done1.job.json"), { id: "done1", status: "stopped", pid: 1, startedAt: 1 });
  R.writeJson(join(dir, "done1.spec.json"), { id: "done1" });
  R.writeJson(join(dir, "live1.job.json"), { id: "live1", status: "running", pid: process.pid, startedAt: 1 });

  assert.equal(R.dismissRelay(root, "live1"), false, "still running with a live pid: refused");
  assert.ok(existsSync(join(dir, "live1.job.json")));

  assert.equal(R.dismissRelay(root, "done1"), true);
  assert.ok(!existsSync(join(dir, "done1.job.json")));
  assert.ok(!existsSync(join(dir, "done1.spec.json")));

  assert.equal(R.dismissRelay(root, "missing"), false, "no such job");
});

test("relay seed prompt tells the agent to use the backlog helper, not Edit/Write, for .claude/", () => {
  const seed = seedForSequentialRun({ slug: "p", tasks: [{ title: "ship it", note: null }], adhoc: false, relay: true });
  assert.ok(seed.includes(`node ${R.BACKLOG_CLI} move`), "helper command with absolute path");
  assert.match(seed, /BLOCKED in headless mode/);
});
