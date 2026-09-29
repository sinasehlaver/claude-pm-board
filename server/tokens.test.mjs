import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Temp workspace + temp transcript dir — never the real .claude/ or ~/.claude.
const root = mkdtempSync(join(tmpdir(), "pm-tokens-"));
const proj = join(root, "claude-projects");
process.env.PM_ROOT = root;
process.env.CLAUDE_PROJECTS_ROOT = proj;
process.env.PM_LAUNCH_DRYRUN = "1";
const T = await import("./tokens.mjs");
const { launchClaude } = await import("./launch.mjs");
after(() => rmSync(root, { recursive: true, force: true }));

const pd = join(proj, "-tmp-p");
mkdirSync(pd, { recursive: true });
const jl = (...o) => o.map((x) => JSON.stringify(x)).join("\n") + "\n";
const asst = (id, out, ts = new Date().toISOString(), inp = 100) => ({
  type: "assistant", timestamp: ts, message: { id, model: "m", usage: { input_tokens: inp, output_tokens: out } },
});
const user = (text) => ({ type: "user", message: { role: "user", content: text } });

test("markPrompt/newRunId format is matched by the transcript marker", () => {
  const id = T.newRunId();
  assert.match(T.markPrompt("hello", id), new RegExp(`pm-run: ${id}`));
});

test("launchClaude with todos registers a run and tags the seed prompt", async () => {
  const r = await launchClaude({ cwd: root, prompt: "seed", todos: [{ slug: "hub", title: "t1" }] });
  assert.ok(r.dryrun);
  const runs = T.readRuns();
  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0].todos, [{ slug: "hub", title: "t1" }]);
  const seedPath = /cat '([^']+)'/.exec(r.cmd)[1];
  assert.match(readFileSync(seedPath, "utf8"), new RegExp(`pm-run: ${runs[0].id}`));
  // no todos (or a resume) => nothing registered
  await launchClaude({ cwd: root, prompt: "x" });
  await launchClaude({ cwd: root, resumeId: "abc", todos: [{ slug: "hub", title: "t1" }] });
  assert.equal(T.readRuns().length, 1);
});

test("attributes a session + its subagents, dedups by message id, splits across todos", async () => {
  const id = T.newRunId();
  T.registerRun({ id, todos: [{ slug: "hub", title: "a" }, { slug: "hub", title: "b" }] });
  writeFileSync(
    join(pd, "sess1.jsonl"),
    jl(user(T.markPrompt("do things", id)), asst("m1", 5), asst("m1", 50), asst("m2", 100)), // m1 twice: last wins
  );
  mkdirSync(join(pd, "sess1", "subagents"), { recursive: true });
  writeFileSync(join(pd, "sess1", "subagents", "agent-1.jsonl"), jl(asst("s1", 200), asst("m2", 100))); // m2 dup ignored
  // unrelated session: never attributed
  writeFileSync(join(pd, "other.jsonl"), jl(user("no marker"), asst("o1", 9999)));

  const tasks = await T.refreshTaskTokens();
  // total = m1(100+50) + m2(100+100) + s1(100+200) = 650, split over 2 todos
  assert.equal(tasks.hub.a.tokens, 325);
  assert.equal(tasks.hub.b.tokens, 325);
  assert.equal(tasks.hub.a.split, true);
  assert.deepEqual(tasks.hub.a.sessions, ["sess1"]);
  assert.ok(tasks.hub.t1 === undefined);
  assert.ok(existsSync(join(root, ".claude/pm/task-tokens.json")));
  assert.deepEqual(T.readTaskTokens().hub.a, tasks.hub.a);
});

test("single-todo run is not flagged split; record survives transcript deletion", async () => {
  const id = T.newRunId();
  T.registerRun({ id, todos: [{ slug: "pm", title: "solo" }] });
  writeFileSync(join(pd, "sess2.jsonl"), jl(user(T.markPrompt("x", id)), asst("z1", 400)));
  let tasks = await T.refreshTaskTokens();
  assert.equal(tasks.pm.solo.tokens, 500);
  assert.equal(tasks.pm.solo.split, false);
  rmSync(join(pd, "sess2.jsonl"));
  tasks = await T.refreshTaskTokens();
  assert.equal(tasks.pm.solo.tokens, 500); // frozen, not zeroed
});

test("foldRuns sums several runs for the same title", () => {
  const runs = [
    { id: "r1", todos: [{ slug: "s", title: "t" }] },
    { id: "r2", todos: [{ slug: "s", title: "t" }, { slug: "s", title: "u" }] },
  ];
  const f = T.foldRuns(runs, { r1: { tokens: 10, sessions: ["a"], ts: 1 }, r2: { tokens: 20, sessions: ["b"], ts: 2 } });
  assert.equal(f.s.t.tokens, 20);
  assert.equal(f.s.u.tokens, 10);
  assert.deepEqual(f.s.t.sessions, ["a", "b"]);
});
