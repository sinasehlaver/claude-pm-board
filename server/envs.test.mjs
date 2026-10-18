import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "pm-envs-"));
const w = (p, s) => { mkdirSync(join(root, p, ".."), { recursive: true }); writeFileSync(join(root, p), s); };
w("app-a/.env", 'ANTHROPIC_API_KEY=sk-ant-OLDOLDOLD1234\nOTHER="keep me"\n# ANTHROPIC_API_KEY=commented\n');
w("app-a-baseline/.env", 'export ANTHROPIC_API_KEY="sk-ant-OLDOLDOLD1234" # note\n');
w("app-b/.env.local", "ANTHROPIC_API_KEY=sk-ant-DIFFERENT9999\n");
w("app-b/.env.bak", "ANTHROPIC_API_KEY=backup\n");
w("app-b/.env.example", "ANTHROPIC_API_KEY=example\n");
w("archive/app-a-old/.env", "ANTHROPIC_API_KEY=archived\n");
w("app-a/node_modules/x/.env", "ANTHROPIC_API_KEY=nm\n");

const { scanEnvs, updateEnv, mask } = await import("./envs.mjs");
const NEW = "sk-ant-NEWNEWNEW7777";

test("scan finds live files only, groups by name, masks values", async () => {
  const k = (await scanEnvs(root)).find((e) => e.name === "ANTHROPIC_API_KEY");
  assert.deepEqual(k.files.map((f) => f.file).sort(), ["app-a-baseline/.env", "app-a/.env", "app-b/.env.local"]);
  assert.equal(k.distinct, 2);
  assert.ok(k.files.every((f) => !JSON.stringify(f).includes("OLDOLD")));
  assert.equal(mask("short"), "••••");
});

test("dry run changes nothing", async () => {
  const r = await updateEnv("ANTHROPIC_API_KEY", NEW, { dryRun: true, root });
  assert.equal(r.changed, 3);
  assert.match(readFileSync(join(root, "app-a/.env"), "utf8"), /OLDOLD/);
});

test("files subset updates only the chosen file", async () => {
  const r = await updateEnv("ANTHROPIC_API_KEY", NEW, { files: ["app-b/.env.local"], root });
  assert.deepEqual(r.files, [{ file: "app-b/.env.local", changed: true }]);
  assert.match(readFileSync(join(root, "app-a/.env"), "utf8"), /OLDOLD/);
  assert.match(readFileSync(join(root, "app-a-baseline/.env"), "utf8"), /OLDOLD/);
  await updateEnv("ANTHROPIC_API_KEY", "sk-ant-DIFFERENT9999", { files: ["app-b/.env.local"], root });
});

test("update rewrites every live file, keeps quotes/export/comments, backs up, spares the rest", async () => {
  const r = await updateEnv("ANTHROPIC_API_KEY", NEW, { root });
  assert.equal(r.changed, 3);
  assert.equal(readFileSync(join(root, "app-a/.env"), "utf8"), `ANTHROPIC_API_KEY=${NEW}\nOTHER="keep me"\n# ANTHROPIC_API_KEY=commented\n`);
  assert.equal(readFileSync(join(root, "app-a-baseline/.env"), "utf8"), `export ANTHROPIC_API_KEY="${NEW}" # note\n`);
  assert.equal(readFileSync(join(root, "app-b/.env.bak"), "utf8"), "ANTHROPIC_API_KEY=backup\n");
  assert.equal(readFileSync(join(root, "archive/app-a-old/.env"), "utf8"), "ANTHROPIC_API_KEY=archived\n");
  assert.ok(readdirSync(join(root, "app-a")).some((f) => f.startsWith(".env.bak-")));
  assert.equal((await updateEnv("ANTHROPIC_API_KEY", NEW, { root })).changed, 0);
});

test("rejects bad input and files outside the managed set", async () => {
  await assert.rejects(updateEnv("A B", "x", { root }), { status: 400 });
  await assert.rejects(updateEnv("X", "a\nb", { root }), { status: 400 });
  await assert.rejects(updateEnv("X", "v", { files: ["../etc/passwd"], root }), { status: 400 });
  await assert.rejects(updateEnv("X", "v", { files: ["app-b/.env.bak"], root }), { status: 400 });
});
