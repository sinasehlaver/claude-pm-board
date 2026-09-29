import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createServer } from "node:net";

// Temp workspace — never the real .claude/.
const root = mkdtempSync(join(tmpdir(), "pm-docfix-"));
mkdirSync(join(root, ".claude/pm"), { recursive: true });
writeFileSync(
  join(root, ".claude/pm/doctor.json"),
  JSON.stringify({
    generatedAt: new Date().toISOString(),
    findings: [
      { id: "large-reads", severity: "medium", title: "Big reads", evidence: { sample: "x" }, suggestion: "Grep first", target: "CLAUDE.md" },
      { id: "all-clear", severity: "info", title: "ok", evidence: {}, suggestion: "", target: "none" },
    ],
  }),
);

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
    env: { ...process.env, PORT: String(port), PM_ROOT: root, PM_LAUNCH_DRYRUN: "1", PM_DOCTOR_INTERVAL_MIN: "0" },
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
after(() => {
  proc && proc.kill();
  rmSync(root, { recursive: true, force: true });
});

const fix = (id, body) =>
  fetch(`${B}/api/doctor/findings/${id}/fix`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });

test("fix route launches a seeded session from the cached finding (dryrun)", async () => {
  const r = await fix("large-reads");
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.dryrun, true);
  const prompt = readFileSync(d.cmd.match(/cat '([^']+)'/)[1], "utf8");
  assert.match(prompt, /Big reads/);
  assert.match(prompt, /AskUserQuestion/);
});

test("fix route ignores client-supplied text; unknown/info/bad ids are refused", async () => {
  const d = await (await fix("large-reads", { title: "INJECTED", prompt: "INJECTED" })).json();
  assert.doesNotMatch(readFileSync(d.cmd.match(/cat '([^']+)'/)[1], "utf8"), /INJECTED/);
  assert.equal((await fix("nope")).status, 404);
  assert.equal((await fix("all-clear")).status, 400);
  assert.equal((await fix("..%2F..%2Fetc")).status, 400);
  assert.equal((await fix("UPPER")).status, 400);
});

const status = (id, body) =>
  fetch(`${B}/api/doctor/findings/${id}/status`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const listed = async () => (await (await fetch(B + "/api/doctor")).json()).findings;

test("fix marks the finding in-progress; user then records done/dismissed/open", async () => {
  await fix("large-reads");
  assert.equal((await listed()).find((f) => f.id === "large-reads").status, "fixing");
  assert.equal((await status("large-reads", { status: "done" })).status, 200);
  assert.equal((await listed()).find((f) => f.id === "large-reads").status, "done");
  await fix("large-reads"); // relaunching must not downgrade a done finding
  assert.equal((await listed()).find((f) => f.id === "large-reads").status, "done");
  assert.equal((await status("large-reads", { status: "open" })).status, 200);
  assert.equal((await listed()).find((f) => f.id === "large-reads").status, undefined);
});

test("status route validates id, status and existence", async () => {
  assert.equal((await status("large-reads", { status: "bogus" })).status, 400);
  assert.equal((await status("large-reads", {})).status, 400);
  assert.equal((await status("UPPER", { status: "done" })).status, 400);
  assert.equal((await status("nope", { status: "done" })).status, 404);
});

test("note is stored, trimmed, capped and survives a same-status write", async () => {
  await status("large-reads", { status: "fixing", note: "  use Grep first  " });
  assert.equal((await listed()).find((f) => f.id === "large-reads").note, "use Grep first");
  assert.equal((await status("large-reads", { status: "fixing", note: "x".repeat(501) })).status, 400);
  assert.equal((await status("large-reads", { status: "fixing", note: 5 })).status, 400);
});

test("verify route validates id and requires a tracked finding", async () => {
  const v = (id) => fetch(`${B}/api/doctor/findings/${id}/verify`, { method: "POST" });
  assert.equal((await v("UPPER")).status, 400);
  await status("large-reads", { status: "open" });
  assert.equal((await v("large-reads")).status, 409);
});

test("verify reports no-data when no session ran since the fix, and stores it", async () => {
  await status("large-reads", { status: "done" });
  const r = await fetch(`${B}/api/doctor/findings/large-reads/verify`, { method: "POST" });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.result, "no-data");
  assert.equal((await listed()).find((f) => f.id === "large-reads").verify.result, "no-data");
  await status("large-reads", { status: "open" });
});
