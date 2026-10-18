import { test } from "node:test";
import assert from "node:assert/strict";
import { wrap, usageLine, createApp, parseKeys, sanitizeTitle, groupTasks, TITLE_MAX } from "./tui-core.mjs";
import { resolveHost, tokenMatches, isTailscaleIp } from "./bind.mjs";

const mk = () => {
  const calls = [];
  const tasks = [
    { state: "Todo", title: "first", note: null, priority: 1 },
    { state: "Doing", title: "second \x1b[31mevil", note: "n\x1b[2Jote", priority: null },
    { state: "Done", title: "old", note: null, priority: null },
  ];
  const deps = {
    listProjects: async () => [{ slug: "pm", openCount: 2, blocked: false, status: "ok\x1b[2J" }],
    readBacklog: async () => ({ tasks }),
    addTask: async (s, t) => (calls.push(["add", s, t]), "added"),
    moveTask: async (s, to, t) => (calls.push(["move", s, to, t]), "moved"),
    listJobs: async () => [{ id: "j1", status: "running", label: "job\x1b[2J", tasks: [{ slug: "pm", title: "first" }], open: 1, startedAt: Date.now() - 125000, activity: [{ text: "did\x1b]0;x\x07" }] }],
    tokens: () => ({}),
    runTodos: async (s, titles) => (calls.push(["run", s, titles]), "started"),
    stopJob: async (id) => (calls.push(["stop", id]), "stopped"),
  };
  return { app: createApp(deps), calls };
};
const press = async (app, keys) => {
  for (const k of parseKeys(keys)) await app.key(k);
};
const strip = (s) => s.join("\n");

test("usageLine shows 5h/today/7d USD, tolerates none", () => {
  const line = usageLine({ block: 4.256, today: 10, week: 55.5 }).replace(/\x1b\[[0-9;]*m/g, "");
  assert.equal(line, "claude 5h $4.26 · today $10.00 · 7d $55.50");
  assert.equal(usageLine(null), null);
  assert.equal(usageLine({}), null);
});

test("view footer carries the usage line only when deps.usage yields data", () => {
  const { app } = mk();
  assert.ok(!app.view(80, 24).join("\n").includes("claude 5h"));
  const app2 = createApp({ listProjects: async () => [], readBacklog: async () => null, listJobs: async () => [], usage: () => ({ block: 1, today: 2, week: 3 }) });
  const v = app2.view(80, 24);
  assert.equal(v.length, 24);
  assert.match(v.join("\n").replace(/\x1b\[[0-9;]*m/g, ""), /claude 5h \$1\.00 · today \$2\.00 · 7d \$3\.00/);
});

test("wrap breaks at word boundaries and splits overlong words", () => {
  assert.deepEqual(wrap("aaa bbb ccc", 7), ["aaa bbb", "ccc"]);
  assert.deepEqual(wrap("abcdefghij", 4), ["abcd", "efgh", "ij"]);
  assert.ok(wrap("x ".repeat(100).trim(), 20).every((l) => l.length <= 20));
});

test("parseKeys keeps arrow sequences whole and splits pastes", () => {
  assert.deepEqual(parseKeys("\x1b[Aab"), ["\x1b[A", "a", "b"]);
});

test("sanitizeTitle strips control chars, newlines, and caps length", () => {
  assert.equal(sanitizeTitle("a\nb\x1b[2Jc"), "a b [2Jc");
  assert.equal(sanitizeTitle("x".repeat(999)).length, TITLE_MAX);
});

test("groupTasks hides Done unless asked, ordered by state", () => {
  const t = [{ state: "Todo" }, { state: "Done" }, { state: "Doing" }];
  assert.deepEqual(groupTasks(t, false).map((x) => x.state), ["Doing", "Todo"]);
  assert.equal(groupTasks(t, true).length, 3);
});

test("navigate, add a multi-line paste as one clean title, move a task", async () => {
  const { app, calls } = mk();
  await app.refresh();
  await press(app, "\r");
  assert.equal(app.m.screen, "project");
  await press(app, "a");
  await press(app, "do\nthing\x1b[2J");
  assert.equal(app.m.mode, "add");
  await press(app, "\r");
  assert.deepEqual(calls[0], ["add", "pm", "do thing"]);
  await press(app, "m");
  await press(app, "4");
  assert.deepEqual(calls[1].slice(0, 3), ["move", "pm", "Done"]);
});

test("move mode ignores keys that are not a state number", async () => {
  const { app, calls } = mk();
  await app.refresh();
  await press(app, "\r");
  await press(app, "m");
  await press(app, "9");
  assert.equal(calls.length, 0);
  assert.equal(app.m.mode, "nav");
});

test("rendered output never contains raw escapes from file-derived text", async () => {
  const { app } = mk();
  await app.refresh();
  const clean = (v) => strip(v).replace(/\x1b\[[0-9;]*m/g, "");
  assert.ok(!/\x1b/.test(clean(app.view(80, 24))));
  await press(app, "\r");
  assert.ok(!/\x1b/.test(clean(app.view(80, 24))));
  await press(app, "r");
  assert.equal(app.m.screen, "jobs");
  assert.ok(!/[\x1b\x07]/.test(clean(app.view(80, 24))));
});

test("view never exceeds the terminal size", async () => {
  const { app } = mk();
  await app.refresh();
  assert.ok(app.view(40, 10).length <= 10);
});

test("bind: loopback default, tailscale ok, public host needs a token", () => {
  assert.equal(resolveHost({}), "127.0.0.1");
  assert.equal(resolveHost({ PM_HOST: "100.101.2.3" }), "100.101.2.3");
  assert.throws(() => resolveHost({ PM_HOST: "0.0.0.0" }), /PM_TOKEN/);
  assert.throws(() => resolveHost({ PM_HOST: "192.168.1.5" }), /PM_TOKEN/);
  assert.equal(resolveHost({ PM_HOST: "0.0.0.0", PM_TOKEN: "s" }), "0.0.0.0");
  assert.ok(!isTailscaleIp("100.128.0.1") && !isTailscaleIp("100.63.0.1") && isTailscaleIp("100.64.0.1"));
});

test("tokenMatches: exact only, never on empty", () => {
  assert.ok(tokenMatches("abc", "abc"));
  assert.ok(!tokenMatches("abd", "abc"));
  assert.ok(!tokenMatches("ab", "abc"));
  assert.ok(!tokenMatches("", ""));
  assert.ok(!tokenMatches(undefined, "abc"));
  assert.ok(!tokenMatches(["abc"], "abc"));
});

test("running todos get a badge; x asks first, y runs the marked set", async () => {
  const { app, calls } = mk();
  await app.refresh();
  await press(app, "\r");
  assert.match(strip(app.view(80, 24)), /running/);
  // cursor 0 = Doing "second", 1 = Todo "first" (already running -> not runnable)
  await press(app, "x");
  assert.equal(app.m.mode, "confirm");
  await press(app, "n");
  assert.equal(calls.length, 0);
  await press(app, "j");
  await press(app, "x");
  assert.equal(app.m.mode, "nav");
  assert.match(app.m.msg, /nothing runnable/);
  await press(app, "k");
  await press(app, " xy");
  assert.deepEqual(calls[0].slice(0, 2), ["run", "pm"]);
  assert.equal(calls[0][2].length, 1);
  assert.equal(app.m.marked.size, 0);
});

test("done/blocked todos are never launched", async () => {
  const { app, calls } = mk();
  await app.refresh();
  await press(app, "\r");
  await press(app, "d");
  await press(app, "jjx");
  assert.equal(calls.length, 0);
});

test("jobs screen shows age + open count and stop needs confirm", async () => {
  const { app, calls } = mk();
  await app.refresh();
  await press(app, "r");
  const v = strip(app.view(80, 24));
  assert.match(v, /2m/);
  assert.match(v, /1\/1 open/);
  await press(app, "s");
  assert.equal(calls.length, 0);
  await press(app, "y");
  assert.deepEqual(calls[0], ["stop", "j1"]);
});

test("right arrow opens a project, left arrow goes back", async () => {
  const { app } = mk();
  await app.refresh();
  await press(app, "\x1b[C");
  assert.equal(app.m.screen, "project");
  await press(app, "\x1b[D");
  assert.equal(app.m.screen, "projects");
  await press(app, "r\x1b[D");
  assert.equal(app.m.screen, "projects");
});
