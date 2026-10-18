import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "pm-arch-"));
mkdirSync(join(root, ".claude/backlog"), { recursive: true });
mkdirSync(join(root, ".claude/state"), { recursive: true });
process.env.PM_ROOT = root;
after(() => rmSync(root, { recursive: true, force: true }));

const B = await import("./backlog.mjs");
const C = await import("./backlog-cli.mjs");
const bl = join(root, ".claude/backlog/p.md");
const arch = join(root, ".claude/backlog-archive/p.md");
const snaps = () => readdirSync(join(root, ".claude/backlog-archive/.snapshots")).filter((f) => f.startsWith("p."));
const seed = () => writeFileSync(bl, "# p — backlog\nUpdated: 2020-01-01\n\n## Doing\n- alpha  @seq  p1\n  a note\n\n## Todo\n- beta\n- gamma  p2\n\n");

test("dropping a task via writeBacklog archives it with state + date, same bullet format", async () => {
  seed();
  const b = await B.readBacklog("p");
  b.tasks = b.tasks.filter((t) => t.title !== "alpha");
  await B.writeBacklog("p", b);
  assert.ok(!readFileSync(bl, "utf8").includes("alpha"));
  const a = readFileSync(arch, "utf8");
  assert.match(a, /- alpha {2}@seq {2}p1\n {2}a note\n {2}<!-- removed: \d{4}-\d{2}-\d{2} from: Doing -->/);
  const items = await B.readArchive("p");
  assert.equal(items.length, 1);
  assert.equal(items[0].from, "Doing");
  assert.equal(items[0].note, "a note");
  assert.equal(items[0].priority, 1);
});

test("overwriting with an empty backlog archives everything; nothing vanishes", async () => {
  seed();
  await B.writeBacklog("p", B.emptyBacklog("p"));
  const titles = (await B.readArchive("p")).map((t) => t.title);
  for (const t of ["alpha", "beta", "gamma"]) assert.ok(titles.includes(t));
});

test("a task in an unknown section is kept, not silently dropped", async () => {
  writeFileSync(bl, "# p — backlog\nUpdated: 2020-01-01\n\n## Later\n- zeta\n\n## Todo\n- beta\n\n");
  const b = await B.readBacklog("p");
  await B.writeBacklog("p", b);
  assert.ok(readFileSync(bl, "utf8").includes("- zeta"));
});

test("restore puts the task back in Todo and removes it from the archive; dup title refused", async () => {
  rmSync(arch, { force: true });
  seed();
  const b = await B.readBacklog("p");
  b.tasks = b.tasks.filter((t) => t.title !== "gamma");
  await B.writeBacklog("p", b);
  await B.restoreTask("p", "gamma");
  const after = await B.readBacklog("p");
  const g = after.tasks.find((t) => t.title === "gamma");
  assert.equal(g.state, "Todo");
  assert.equal(g.priority, 2);
  assert.ok(!(await B.readArchive("p")).some((t) => t.title === "gamma"));
  await assert.rejects(B.restoreTask("p", "nope"), /no such archived/);
  const b2 = await B.readBacklog("p");
  b2.tasks = b2.tasks.filter((t) => t.title !== "gamma");
  await B.writeBacklog("p", b2);
  await B.writeBacklog("p", { ...b2, tasks: [...b2.tasks, { title: "gamma", state: "Todo" }] });
  await assert.rejects(B.restoreTask("p", "gamma"), /already in backlog/);
});

test("snapshots: previous file saved on change, last 20 kept", async () => {
  seed();
  for (let i = 0; i < 25; i++) {
    const b = await B.readBacklog("p");
    b.tasks.push({ title: `t${i}`, state: "Todo" });
    await B.writeBacklog("p", b);
  }
  assert.equal(snaps().length, B.SNAPSHOT_KEEP);
  assert.equal(B.SNAPSHOT_KEEP, 20);
});

test("cli: add refuses duplicate exact title and multi-line titles; move is exact-title only", async () => {
  seed();
  await assert.rejects(C.addTask("p", "beta"), /duplicate/);
  await assert.rejects(C.addTask("p", "a\nb"), /one non-empty line/);
  await C.addTask("p", "delta");
  await assert.rejects(C.moveTask("p", "Done", "bet"), /no task with that exact title/);
  const before = (await B.readBacklog("p")).tasks.map((t) => t.title);
  await C.moveTask("p", "Done", "beta", "n");
  assert.deepEqual((await B.readBacklog("p")).tasks.map((t) => t.title).sort(), before.sort());
});

test("cli: no delete/rename command; list is read-only", async () => {
  seed();
  for (const c of ["delete", "rm", "remove", "rename"]) await assert.rejects(C.main([c, "p", "x"]), /usage/);
  const text = readFileSync(bl, "utf8");
  assert.equal(await C.main(["list", "p", "Todo"]), "Todo\tbeta\nTodo\tgamma");
  assert.match(await C.main(["list", "p"]), /^Doing\talpha/);
  assert.equal(readFileSync(bl, "utf8"), text);
  assert.ok(existsSync(join(root, ".claude")));
});
