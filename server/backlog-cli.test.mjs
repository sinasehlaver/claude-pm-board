import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = mkdtempSync(join(tmpdir(), "pm-bcli-"));
mkdirSync(join(root, ".claude/backlog"), { recursive: true });
mkdirSync(join(root, ".claude/state"), { recursive: true });
process.env.PM_ROOT = root;
after(() => rmSync(root, { recursive: true, force: true }));

const bl = join(root, ".claude/backlog/p.md");
const st = join(root, ".claude/state/p.md");
const seed = () => {
  writeFileSync(bl, "# p — backlog\nUpdated: 2020-01-01\n\n## Todo\n- first task\n- second task  p2\n\n");
  writeFileSync(st, "# p — state\nUpdated: 2020-01-01\n\n## Now\n- [ ] old\n\n## Next\n\n## Last failure\nnone\n\n## Blockers\nnone\n");
};

const C = await import("./backlog-cli.mjs");

test("move: by exact title to Done stamps the date and keeps other tasks byte-for-byte", async () => {
  seed();
  await C.moveTask("p", "Done", "first task", "shipped");
  const t = readFileSync(bl, "utf8");
  assert.match(t, /## Todo\n- second task {2}p2\n/);
  assert.match(t, /## Done\n- first task {2}\(\d{4}-\d{2}-\d{2}\)\n {2}shipped\n/);
});

test("move: Blocked carries a note and clears the done date; unknown title / bad state / bad slug throw", async () => {
  seed();
  await C.moveTask("p", "Blocked", "second task", "needs git");
  assert.match(readFileSync(bl, "utf8"), /## Blocked\n- second task {2}p2\n {2}needs git\n/);
  await assert.rejects(C.moveTask("p", "Done", "nope"), /no task with that exact title/);
  await assert.rejects(C.moveTask("p", "Finished", "first task"), /state must be/);
  await assert.rejects(C.moveTask("../x", "Done", "first task"), /bad slug/);
});

test("add + state now round-trip through the real parsers (50-line cap still enforced)", async () => {
  seed();
  await C.addTask("p", "third task");
  assert.match(readFileSync(bl, "utf8"), /- third task\n/);
  await C.setNow("p", "headline", ["one", "two"]);
  assert.match(readFileSync(st, "utf8"), /## Now\n- \[ \] headline\n {2}- one\n {2}- two\n/);
  await assert.rejects(C.setNow("p", "h", Array.from({ length: 60 }, (_, i) => `d${i}`)), /50-line cap/);
});

test("as a real CLI process: exit 0 on success, exit 1 + message on failure", () => {
  seed();
  const cli = fileURLToPath(new URL("./backlog-cli.mjs", import.meta.url));
  const out = execFileSync("node", [cli, "move", "p", "Done", "first task"], { env: { ...process.env, PM_ROOT: root } }).toString();
  assert.match(out, /-> Done/);
  assert.throws(() => execFileSync("node", [cli, "move", "p", "Done", "nope"], { env: { ...process.env, PM_ROOT: root }, stdio: "pipe" }), /no task with that exact title/);
});

test("add: optional note is written indented under the todo; 2-arg call still works", async () => {
  seed();
  await C.addTask("p", "plain");
  await C.addTask("p", "with note", "Done when: x\nTest: y");
  assert.match(readFileSync(bl, "utf8"), /- plain\n- with note\n {2}Done when: x\n {2}Test: y\n/);
});

test("state resume sets one Resume field and rejects unknown fields", async () => {
  seed();
  await C.setResume("p", "re-run", "pytest -k bench");
  await C.setResume("p", "last-result", "3 failed");
  const s = readFileSync(st, "utf8");
  assert.match(s, /## Resume\nLast result: 3 failed\nRe-run: pytest -k bench\nBranch\/variant: \nArtifacts: \n/);
  assert.match(s, /## Now\n- \[ \] old\n/); // the rest of the file is untouched
  await assert.rejects(C.setResume("p", "nope", "x"), /resume field must be one of/);
  await assert.rejects(C.setResume("../x", "branch", "x"), /bad slug/);
});
