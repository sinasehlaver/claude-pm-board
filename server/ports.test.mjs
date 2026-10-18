import test from "node:test";
import assert from "node:assert/strict";

process.env.USER = "sina";
const { parseLsof, parseCwds, projectOf, listPorts, killPort } = await import("./ports.mjs");

const SAMPLE = ["p100", "cnode", "Lsina", "n127.0.0.1:4500", "n[::1]:4500", "p200", "cControlCe", "Lroot", "n*:7000", `p${process.pid}`, "cnode", "Lsina", "n*:9999", ""].join("\n");
const lister = async () => SAMPLE;

test("parseLsof groups listeners per process and dedupes", () => {
  const r = parseLsof(SAMPLE);
  assert.deepEqual(r.map((x) => [x.pid, x.port]), [[100, 4500], [200, 7000], [process.pid, 9999]]);
  assert.equal(r[0].command, "node");
});

test("listPorts flags self and other users' processes", async () => {
  const r = await listPorts({ lister });
  assert.equal(r.find((x) => x.pid === 100).killable, true);
  assert.equal(r.find((x) => x.pid === 200).killable, false);
  assert.equal(r.find((x) => x.pid === process.pid).self, true);
});

test("killPort signals only a live, owned, non-self pid/port pair", async () => {
  const calls = [];
  const kill = (pid, sig) => calls.push([pid, sig]);
  assert.deepEqual((await killPort(100, 4500, { lister, kill })).pid, 100);
  assert.deepEqual(calls, [[100, "SIGTERM"]]);
  const code = (p, q) => killPort(p, q, { lister, kill }).then(() => 200, (e) => e.status);
  assert.equal(await code(100, 7000), 404); // wrong pair
  assert.equal(await code(200, 7000), 403); // other user
  assert.equal(await code(process.pid, 9999), 403); // self
  assert.equal(await code(1, 4500), 400);
  assert.equal(await code("100", 4500), 400);
  assert.equal(calls.length, 1);
});

test("cwd -> project slug from the first folder under the root", async () => {
  assert.equal(projectOf("/ws/hub/server", "/ws"), "hub");
  assert.equal(projectOf("/ws", "/ws"), null);
  assert.equal(projectOf("/elsewhere/x", "/ws"), null);
  assert.equal(projectOf("/ws/.claude/pm", "/ws"), null);
  assert.equal(projectOf("/wsx/hub", "/ws"), null);
  assert.equal(parseCwds("p100\nn/ws/hub\np200\nn/\n").get(100), "/ws/hub");
  const r = await listPorts({ lister, root: "/ws", cwdLister: async () => "p100\nn/ws/pm/server\n" });
  assert.equal(r.find((x) => x.pid === 100).project, "pm");
  assert.equal(r.find((x) => x.pid === 200).project, null);
});
