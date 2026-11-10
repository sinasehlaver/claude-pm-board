import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createServer } from "node:net";

const root = mkdtempSync(join(tmpdir(), "pm-start-"));
const outside = mkdtempSync(join(tmpdir(), "pm-start-out-"));
mkdirSync(join(root, ".claude/state"), { recursive: true });
mkdirSync(join(root, ".claude/backlog"), { recursive: true });
for (const s of ["with", "without", "evil"]) {
  writeFileSync(join(root, ".claude/state", `${s}.md`), "");
  mkdirSync(join(root, s), { recursive: true });
}
writeFileSync(join(root, "with/start.sh"), "#!/bin/sh\necho hi\n");
chmodSync(join(root, "with/start.sh"), 0o755);
writeFileSync(join(outside, "start.sh"), "#!/bin/sh\n");
symlinkSync(join(outside, "start.sh"), join(root, "evil/start.sh"));

test("POST /api/projects requires a valid descriptor and writes it as the title", async () => {
  const post = (body) => fetch(B + "/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  for (const descriptor of [undefined, "", 7, "x".repeat(41), "two\nlines", "`code`"])
    assert.equal((await post({ slug: "fresh", descriptor })).status, 400, String(descriptor));
  assert.equal((await post({ slug: "../evil", descriptor: "ok" })).status, 400);
  assert.ok(!existsSync(join(root, ".claude/backlog/fresh.md")));
  const r = await post({ slug: "fresh", descriptor: "a fresh thing" });
  assert.equal(r.status, 201);
  const p = await r.json();
  assert.equal(p.title, "fresh/ — a fresh thing");
  assert.equal(p.adhoc, true);
});

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
const call = (path, headers = {}) =>
  fetch(B + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ bg: "#112233" }) });

async function boot(env) {
  const port = await freePort();
  B = `http://127.0.0.1:${port}`;
  proc = spawn("node", [join(here, "index.mjs")], {
    env: { ...process.env, PORT: String(port), PM_ROOT: root, PM_LAUNCH_DRYRUN: "1", PM_DOCTOR_INTERVAL_MIN: "0", ...env },
    stdio: "ignore",
  });
  for (let i = 0; i < 60; i++) {
    try {
      const h = await fetch(B + "/api/health");
      if (h.ok || h.status === 401) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server did not boot");
}
before(() => boot({}));
after(() => proc?.kill());

test("projects payload flags hasStart only for a real in-dir start.sh", async () => {
  const ps = await (await fetch(B + "/api/projects")).json();
  const by = Object.fromEntries(ps.map((p) => [p.slug, p.hasStart]));
  assert.equal(by.with, true);
  assert.equal(by.without, false);
  assert.equal(by.evil, false);
});

test("single-project payload carries hasStart and running, like the list", async () => {
  const get = async (slug) => (await fetch(`${B}/api/projects/${slug}`)).json();
  const [w, wo, ev] = await Promise.all([get("with"), get("without"), get("evil")]);
  assert.equal(w.hasStart, true);
  assert.ok(Array.isArray(w.running));
  assert.equal(wo.hasStart, false);
  assert.deepEqual(wo.running, []);
  assert.equal(ev.hasStart, false);
});

test("start: dryrun returns fixed command with no client text", async () => {
  const r = await call("/api/projects/with/start");
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.ok(j.dryrun);
  assert.match(j.cmd, /^cd '.*\/with' && \.\/start\.sh$/);
  assert.ok(!j.cmd.includes("#112233"));
});

test("start: 404 unknown slug, missing start.sh, symlink escape; 400 bad slug", async () => {
  assert.equal((await call("/api/projects/nope/start")).status, 404);
  assert.equal((await call("/api/projects/without/start")).status, 404);
  assert.equal((await call("/api/projects/evil/start")).status, 404);
  assert.equal((await call("/api/projects/Bad.Slug/start")).status, 400);
});

test("business verdict route validates and round-trips", async () => {
  const put = (slug, body) => fetch(`${B}/api/projects/${slug}/business`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await put("with", { verdict: "bogus" })).status, 400);
  assert.equal((await put("with", { verdict: "yes", note: "x".repeat(601) })).status, 400);
  assert.equal((await put("with", { verdict: "yes", note: 5 })).status, 400);
  assert.equal((await put("nope", { verdict: "yes" })).status, 404);
  const r = await put("with", { verdict: "maybe", note: "niche" });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).business.verdict, "maybe");
  assert.equal((await (await fetch(`${B}/api/projects/with`)).json()).business.note, "niche");
  await put("with", { verdict: null });
  assert.equal((await (await fetch(`${B}/api/projects/with`)).json()).business, null);
});

test("start: non-loopback client without token is refused", async () => {
  proc.kill();
  await boot({ PM_TOKEN: "s3cret" });
  const r = await call("/api/projects/with/start");
  assert.ok([401, 403].includes(r.status), String(r.status));
  const ok = await call("/api/projects/with/start", { authorization: "Bearer s3cret", "x-pm-token": "s3cret" });
  assert.equal(ok.status, 200);
});
