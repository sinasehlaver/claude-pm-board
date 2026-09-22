import test from "node:test";
import assert from "node:assert/strict";
import { parseBacklog, serializeBacklog, runnableTasks } from "./backlog.mjs";

const CANON = `# hub — backlog
Updated: 2026-09-08

## Doing
- Inflation tile for P3 dev-ops  p2
  replaces budget's hand-entered tufeYoY

## Todo
- P2 connectors/feeds  @seq  p1
- Widget designer sandbox (P6)  @seq
- Standalone budget rollover  p3

## Blocked
- Blood-test list widget  — data not transcribed yet

## Done
- P4 diet & self-care, 6 widgets  (2026-09-07)
`;

test("parse pulls title / priority / note / done", () => {
  const b = parseBacklog(CANON, "hub");
  assert.equal(b.tasks.length, 6);
  const doing = b.tasks[0];
  assert.equal(doing.title, "Inflation tile for P3 dev-ops");
  assert.equal(doing.priority, 2);
  assert.equal(doing.note, "replaces budget's hand-entered tufeYoY");
  assert.equal(doing.state, "Doing");
  const done = b.tasks.find((t) => t.state === "Done");
  assert.equal(done.done, "2026-09-07");
  assert.equal(done.title, "P4 diet & self-care, 6 widgets");
  assert.equal(b.tasks[4].title, "Blood-test list widget  — data not transcribed yet".trim());
});

test("parse pulls the @seq flag, alone or with a priority", () => {
  const b = parseBacklog(CANON, "hub");
  const withPri = b.tasks.find((t) => t.title === "P2 connectors/feeds");
  assert.equal(withPri.seq, true);
  assert.equal(withPri.priority, 1);
  const alone = b.tasks.find((t) => t.title === "Widget designer sandbox (P6)");
  assert.equal(alone.seq, true);
  assert.equal(alone.priority, null);
  const neither = b.tasks.find((t) => t.title === "Standalone budget rollover");
  assert.equal(neither.seq, false);
});

test("runnableTasks: flagged non-Done tasks win, else all Todo+Doing", () => {
  const t = (title, state, seq = false) => ({ title, state, seq });
  const tasks = [
    t("doing", "Doing"),
    t("todo", "Todo"),
    t("flagged", "Todo", true),
    t("blocked flagged", "Blocked", true),
    t("done flagged", "Done", true),
    t("blocked", "Blocked"),
    t("done", "Done"),
  ];
  const sel = runnableTasks(tasks);
  assert.equal(sel.mode, "seq");
  assert.deepEqual(sel.tasks.map((x) => x.title), ["flagged", "blocked flagged"]);

  // no live flags (a Done task's stale flag doesn't count) -> fallback to all
  const all = runnableTasks(tasks.filter((x) => !x.seq || x.state === "Done"));
  assert.equal(all.mode, "all");
  assert.deepEqual(all.tasks.map((x) => x.title), ["doing", "todo"]);

  // nothing runnable -> empty (server answers 400)
  assert.deepEqual(runnableTasks([t("b", "Blocked"), t("d", "Done")]).tasks, []);
  assert.deepEqual(runnableTasks([]).tasks, []);
});

test("ids are stable positional", () => {
  const b = parseBacklog(CANON, "hub");
  assert.deepEqual(
    b.tasks.map((t) => t.id),
    [0, 1, 2, 3, 4, 5],
  );
});

test("canonical round-trips byte-identical", () => {
  assert.equal(serializeBacklog(parseBacklog(CANON, "hub")), CANON);
});

test("empty sections are omitted", () => {
  const b = { slug: "x", updated: "2026-01-01", tasks: [{ state: "Todo", title: "a", priority: null, note: null, done: null }] };
  const out = serializeBacklog(b);
  assert.match(out, /## Todo\n- a\n/);
  assert.doesNotMatch(out, /## Doing/);
});
