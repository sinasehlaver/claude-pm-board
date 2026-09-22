import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createServer } from "node:net";

// Temp workspace — never the real .claude/.
const root = mkdtempSync(join(tmpdir(), "pm-todos-"));
const bdir = join(root, ".claude/backlog");
mkdirSync(bdir, { recursive: true });
mkdirSync(join(root, ".claude/state"), { recursive: true });
const file = (slug, body, mtimeSec) => {
  const p = join(bdir, `${slug}.md`);
  writeFileSync(p, body);
  utimesSync(p, mtimeSec, mtimeSec);
};
// hub: oldest file, pm: newest, ideas: newest of all but must be excluded
file("hub", "# hub — backlog\nUpdated: 2026-09-01\n\n## Doing\n- hub doing\n\n## Todo\n- hub first  @seq\n- hub second  p2\n  hub note\n\n## Blocked\n- hub blocked\n\n## Done\n- hub done  (2026-09-01)\n", 1_000_000);
file("pm", "# pm — backlog\nUpdated: 2026-09-05\n\n## Todo\n- pm first\n- pm second\n", 2_000_000);
file("ideas", "# ideas — backlog\nUpdated: 2026-09-09\n\n## Todo\n- an idea\n", 3_000_000);

process.env.PM_ROOT = root;
process.env.PM_LAUNCH_DRYRUN = "1";
const { latestTodos, resolveCrossItems } = await import("./todos.mjs");

after(() => rmSync(root, { recursive: true, force: true }));

test("latestTodos: newest file first, last-in-file first, open only, ideas excluded", async () => {
  const l = await latestTodos();
  assert.deepEqual(
    l.map((t) => `${t.slug}:${t.title}`),
    ["pm:pm second", "pm:pm first", "hub:hub second", "hub:hub first", "hub:hub doing"],
  );
  const s = l.find((t) => t.title === "hub second");
  assert.equal(s.note, "hub note");
  assert.equal(s.priority, 2);
  assert.equal(s.seq, false);
  assert.equal(l.find((t) => t.title === "hub first").seq, true);
  assert.equal(typeof s.id, "number");
});

test("latestTodos honours limit", async () => {
  assert.equal((await latestTodos({ limit: 2 })).length, 2);
  assert.equal((await latestTodos({ limit: "3" })).length, 3);
});

test("resolveCrossItems: ok / stale id / stale title / done / ideas / dupes", async () => {
  const l = await latestTodos();
  const pick = (title) => l.find((t) => t.title === title);
  const item = (t) => ({ slug: t.slug, id: t.id, title: t.title });

  const ok = await resolveCrossItems([item(pick("pm first")), item(pick("pm first")), item(pick("hub second"))]);
  assert.deepEqual(ok.tasks.map((t) => t.title), ["pm first", "hub second"]);
  assert.equal(ok.tasks[1].note, "hub note");
  assert.equal(ok.stale.length, 0);

  // id points at another task now (positional shift) => stale, never guessed
  const shifted = await resolveCrossItems([{ slug: "pm", id: pick("pm first").id, title: "pm second" }]);
  assert.equal(shifted.tasks.length, 0);
  assert.equal(shifted.stale.length, 1);
  // id past the end / unknown project
  assert.equal((await resolveCrossItems([{ slug: "pm", id: 99 }])).stale.length, 1);
  assert.equal((await resolveCrossItems([{ slug: "nosuch", id: 0 }])).stale.length, 1);
  // Blocked/Done are not runnable => stale
  const doneId = 4; // hub: doing(0) first(1) second(2) blocked(3) done(4)... ids follow file order
  const r = await resolveCrossItems([{ slug: "hub", id: doneId }]);
  assert.equal(r.stale.length, 1);
  // ideas dropped as skipped, not stale
  const idea = await resolveCrossItems([{ slug: "ideas", id: 0 }]);
  assert.equal(idea.skipped.length, 1);
  assert.equal(idea.stale.length, 0);
  assert.equal(idea.tasks.length, 0);
});

// --- HTTP routes against a real server process, dryrun launcher -----------
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
    env: { ...process.env, PORT: String(port), PM_ROOT: root, PM_LAUNCH_DRYRUN: "1" },
    stdio: "ignore",
  });
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(B + "/api/health")).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server did not boot");
});
after(() => proc && proc.kill());

const post = (p, body) =>
  fetch(B + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("GET /api/todos/latest returns the proxy-ordered list", async () => {
  const d = await (await fetch(B + "/api/todos/latest?limit=3")).json();
  assert.equal(d.length, 3);
  assert.deepEqual(d.map((t) => t.title), ["pm second", "pm first", "hub second"]);
  assert.ok(["slug", "id", "title", "note", "seq", "priority"].every((k) => k in d[0]));
});

test("POST /api/tasks/run-cross defaults to the unattended relay (dryrun)", async () => {
  const l = await (await fetch(B + "/api/todos/latest")).json();
  const items = l
    .filter((t) => ["pm first", "hub second"].includes(t.title))
    .map(({ slug, id, title }) => ({ slug, id, title }));
  const r = await post("/api/tasks/run-cross", { items });
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.relay, true);
  assert.equal(d.count, 2);
  assert.match(d.cmd, /caffeinate -is node '.*relay-cli\.mjs' '.*\.spec\.json'/);
  const spec = JSON.parse(readFileSync(d.cmd.match(/'([^']+\.spec\.json)'/)[1], "utf8"));
  assert.equal(spec.cwd, root);
  assert.deepEqual(spec.tasks.map((t) => `${t.slug}:${t.title}`).sort(), ["hub:hub second", "pm:pm first"]);
  assert.match(spec.prompt, /UNATTENDED RUN/);
  // GET /api/relay lists nothing until a relay process has actually started the job
  assert.deepEqual(await (await fetch(B + "/api/relay")).json(), []);
});

test("POST /api/tasks/run-cross {unattended:false} launches one interactive root-cwd session (dryrun)", async () => {
  const l = await (await fetch(B + "/api/todos/latest")).json();
  const items = l
    .filter((t) => ["pm first", "hub second"].includes(t.title))
    .map(({ slug, id, title }) => ({ slug, id, title }));
  const r = await post("/api/tasks/run-cross", { unattended: false, items: [...items, { slug: "ideas", id: 0 }] });
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.ok, true);
  assert.equal(d.dryrun, true);
  assert.equal(d.count, 2);
  assert.equal(d.projects, 2);
  assert.equal(d.skipped, 1);
  assert.match(d.cmd, /cd '\/.*' && claude "\$\(cat '\/.*prompt\.txt'\)"/, d.cmd);
  // the seed prompt was written to a file, ideas excluded from it
  const seedPath = d.cmd.match(/cat '([^']+)'/)[1];
  const prompt = readFileSync(seedPath, "utf8");
  assert.match(prompt, /\[pm\]/);
  assert.match(prompt, /\[hub\]/);
  assert.match(prompt, /hub second/);
  assert.doesNotMatch(prompt, /an idea/);
});

test("POST /api/tasks/run-cross: stale => 409, ideas-only/empty/bad => 400", async () => {
  const stale = await post("/api/tasks/run-cross", { items: [{ slug: "pm", id: 0, title: "not that one" }] });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).stale.length, 1);
  assert.equal((await post("/api/tasks/run-cross", { items: [{ slug: "ideas", id: 0 }] })).status, 400);
  assert.equal((await post("/api/tasks/run-cross", { items: [] })).status, 400);
  assert.equal((await post("/api/tasks/run-cross", { items: [{ slug: "../x", id: 0 }] })).status, 400);
  assert.equal((await post("/api/tasks/run-cross", {})).status, 400);
});
