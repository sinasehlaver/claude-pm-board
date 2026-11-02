import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createServer } from "node:net";

// Temp workspace — never the real .claude/.
const root = mkdtempSync(join(tmpdir(), "pm-compact-"));
const scratch = mkdtempSync(join(tmpdir(), "pm-compact-plan-"));
for (const d of ["backlog", "state"]) mkdirSync(join(root, ".claude", d), { recursive: true });
process.env.PM_ROOT = root;
process.env.PM_LAUNCH_DRYRUN = "1";
after(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
});

const { parseBacklog, serializeBacklog } = await import("./backlog.mjs");
const { candidates, compactDone } = await import("./compact.mjs");
const { main } = await import("./backlog-cli.mjs");
const { seedForCompactDone } = await import("./launch.mjs");

const TODAY = "2026-10-28";
const TEXT = [
  "# p — backlog",
  "Updated: 2026-10-27",
  "",
  "## Todo",
  "- open thing  p2",
  "",
  "## Done",
  "- relay runs headless  (2026-09-01)",
  "  long note about how it was verified",
  "- relay stop button  (2026-09-10)",
  "- ports viewer  (2026-09-05)",
  "- undated old item",
  "- fresh item  (2026-10-25)",
  "",
].join("\n");
const B = () => parseBacklog(TEXT, "p");
const opts = { today: TODAY };

test("candidates: old and undated Done only, never the last 7 days or open tasks", () => {
  assert.deepEqual(
    candidates(B(), opts).map((t) => t.title),
    ["relay runs headless", "relay stop button", "ports viewer", "undated old item"],
  );
});

test("compactDone merges by plan, takes the newest date, keeps everything else byte-identical", () => {
  const out = compactDone(B(), [{ title: "Relay: headless runs + stop", note: "rate limits handled", from: ["relay stop button", "relay runs headless"] }], opts);
  const text = serializeBacklog(out);
  assert.equal(
    text,
    [
      "# p — backlog",
      "Updated: 2026-10-27",
      "",
      "## Todo",
      "- open thing  p2",
      "",
      "## Done",
      "- Relay: headless runs + stop  (2026-09-10)",
      "  rate limits handled",
      "- ports viewer  (2026-09-05)",
      "- undated old item",
      "- fresh item  (2026-10-25)",
      "",
    ].join("\n"),
  );
  assert.equal(serializeBacklog(parseBacklog(text, "p")), text);
});

test("compactDone rejects bad plans", () => {
  const bad = (groups, re) => assert.throws(() => compactDone(B(), groups, opts), re);
  bad([], /non-empty/);
  bad([{ title: "x", from: ["nope"] }], /not a Done item older/);
  bad([{ title: "x", from: ["fresh item", "ports viewer"] }], /not a Done item older/);
  bad([{ title: "x", from: ["open thing", "ports viewer"] }], /not a Done item older/);
  bad([{ title: "x", from: ["ports viewer", "ports viewer"] }], /used twice/);
  bad([{ title: "a", from: ["ports viewer"] }, { title: "b", from: ["ports viewer", "undated old item"] }], /used twice/);
  bad([{ title: "open thing", from: ["ports viewer", "undated old item"] }], /collides/);
  bad([{ title: "x", from: ["ports viewer"] }, { title: "x", from: ["undated old item"] }], /collides/);
  bad([{ title: "a\nb", from: ["ports viewer", "undated old item"] }], /single lines/);
  bad([{ title: "", from: ["ports viewer", "undated old item"] }], /1-120/);
  bad([{ title: "x".repeat(121), from: ["ports viewer", "undated old item"] }], /1-120/);
  bad([{ title: "ok", note: "n".repeat(201), from: ["ports viewer", "undated old item"] }], /<= 200/);
  bad([{ title: "ports viewer, longer", from: ["ports viewer"] }], /must get shorter/);
  bad([{ title: "x", from: [] }], /exact Done titles/);
});

test("control chars in a title are stripped", () => {
  const out = compactDone(B(), [{ title: "a\u0007b  c", from: ["ports viewer", "undated old item"] }], opts);
  assert.ok(out.tasks.some((t) => t.title === "a b c"));
});

test("CLI: candidates is read-only JSON; apply writes and archives the originals", async () => {
  const file = join(root, ".claude/backlog/p.md");
  writeFileSync(file, TEXT);
  const c = JSON.parse(await main(["compact", "p", "candidates"]));
  assert.ok(c.some((t) => t.title === "ports viewer"));
  assert.equal(readFileSync(file, "utf8"), TEXT);

  const plan = join(scratch, "plan.json");
  writeFileSync(plan, JSON.stringify([{ title: "Relay shipped", from: ["relay runs headless", "relay stop button"] }]));
  assert.match(await main(["compact", "p", "apply", plan]), /Done 5 -> 4 items, 2 originals archived/);
  const after = readFileSync(file, "utf8");
  assert.match(after, /- Relay shipped {2}\(2026-09-10\)/);
  assert.doesNotMatch(after, /relay stop button/);
  const archive = readFileSync(join(root, ".claude/backlog-archive/p.md"), "utf8");
  assert.match(archive, /relay runs headless/);
  assert.match(archive, /relay stop button/);

  writeFileSync(plan, JSON.stringify([{ title: "y", from: ["nope", "ports viewer"] }]));
  const before = readFileSync(file, "utf8");
  await assert.rejects(main(["compact", "p", "apply", plan]), /not a Done item/);
  assert.equal(readFileSync(file, "utf8"), before);
  await assert.rejects(main(["compact", "../x", "candidates"]), /bad slug/);
  await assert.rejects(main(["compact", "p", "delete"]), /candidates \| apply/);
});

test("seedForCompactDone points at the shipped skill and the CLI, asks before applying", () => {
  const s = seedForCompactDone({ slug: "p" });
  assert.match(s, /skills\/compact-done\/SKILL\.md/);
  assert.match(s, /backlog-cli\.mjs/);
  assert.match(s, /wait for my OK/);
  assert.match(s, /TOOL NAMES/);
  const skill = readFileSync(fileURLToPath(new URL("../skills/compact-done/SKILL.md", import.meta.url)), "utf8");
  assert.match(skill, /## Gotchas/);
});

// --- route against a real server process, dryrun launcher ---------------
const here = dirname(fileURLToPath(import.meta.url));
let proc;
let base;
const freePort = () =>
  new Promise((res) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });
async function boot(env = {}) {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = spawn("node", [join(here, "index.mjs")], {
    env: { ...process.env, PORT: String(port), PM_ROOT: root, PM_LAUNCH_DRYRUN: "1", PM_DOCTOR_INTERVAL_MIN: "0", ...env },
    stdio: "ignore",
  });
  for (let i = 0; i < 60; i++) {
    try {
      const h = await fetch(base + "/api/health");
      if (h.ok || h.status === 401) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server did not boot");
}
const call = (slug, headers = {}) =>
  fetch(`${base}/api/projects/${slug}/compact-done`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: "{}" });
before(() => boot());
after(() => proc?.kill());

test("POST compact-done: dryrun launch at PM_ROOT; 400 bad slug/ideas; 404 no backlog", async () => {
  writeFileSync(join(root, ".claude/backlog/p.md"), TEXT);
  writeFileSync(join(root, ".claude/backlog/ideas.md"), "# ideas — backlog\nUpdated: 2026-10-01\n\n## Todo\n- x\n");
  const r = await call("p");
  assert.equal(r.status, 200);
  assert.ok((await r.json()).dryrun);
  assert.equal((await call("ideas")).status, 400);
  assert.equal((await call("Bad.Slug")).status, 400);
  assert.equal((await call("nope")).status, 404);
});

test("POST compact-done: refused without the token when PM_TOKEN is set", async () => {
  proc.kill();
  await boot({ PM_TOKEN: "s3cret" });
  assert.ok([401, 403].includes((await call("p")).status));
  assert.equal((await call("p", { authorization: "Bearer s3cret", "x-pm-token": "s3cret" })).status, 200);
});
