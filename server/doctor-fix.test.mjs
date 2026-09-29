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
