import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "pm-tuirun-"));
process.env.PM_ROOT = root;
mkdirSync(join(root, ".claude", "backlog"), { recursive: true });
writeFileSync(join(root, ".claude", "backlog", "demo.md"), "# demo — backlog\n\n## Todo\n- one\n- two\n\n## Blocked\n- stuck\n\n## Done\n");
writeFileSync(join(root, ".claude", "backlog", "ideas.md"), "# ideas\n\n## Todo\n- idea\n\n## Done\n");
const { runTodos, stopJob, MAX_RUN } = await import("./tui-run.mjs");
const { stopRelay } = await import("./relay.mjs");

const fake = () => {
  const calls = [];
  return { calls, launch: async (a) => (calls.push(a), { job: "J" }) };
};

test("runTodos launches only open titles, prompt kept off the label/tasks", async () => {
  const f = fake();
  const msg = await runTodos("demo", ["one", "two"], { launch: f.launch, root });
  assert.match(msg, /2 todo/);
  assert.deepEqual(f.calls[0].tasks, [{ slug: "demo", title: "one" }, { slug: "demo", title: "two" }]);
  assert.match(f.calls[0].prompt, /1\. one/);
});

test("runTodos rejects stale/blocked titles, ideas, bad slugs, empty and oversized input", async () => {
  const f = fake();
  const o = { launch: f.launch, root };
  await assert.rejects(runTodos("demo", ["gone"], o), /changed/);
  await assert.rejects(runTodos("demo", ["stuck"], o), /changed/);
  await assert.rejects(runTodos("ideas", ["idea"], o), /ideas/);
  await assert.rejects(runTodos("../etc", ["x"], o), /bad slug/);
  await assert.rejects(runTodos("demo", [], o), /no todos/);
  await assert.rejects(runTodos("demo", Array(MAX_RUN + 1).fill("one"), o), /too many/);
  assert.equal(f.calls.length, 0);
});

test("stopRelay refuses bad ids, finished jobs, and pids that are not a relay", () => {
  const dir = join(root, ".claude", "pm", "relay");
  mkdirSync(dir, { recursive: true });
  const id = "20260101000000-abcdef";
  const put = (j) => writeFileSync(join(dir, `${id}.job.json`), JSON.stringify(j));
  assert.equal(stopRelay(root, "../../etc/passwd"), false);
  put({ status: "done", pid: process.pid });
  assert.equal(stopRelay(root, id, { isRelayPid: () => true }), false);
  put({ status: "running", pid: process.pid });
  assert.equal(stopRelay(root, id, { isRelayPid: () => false }), false);
  put({ status: "running", pid: 1 });
  assert.equal(stopRelay(root, id, { isRelayPid: () => true }), false);
});

test("stopJob reports failure text", async () => {
  assert.match(await stopJob("nope", { stop: () => false, root }), /could not stop/);
});
