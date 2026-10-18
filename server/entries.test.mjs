import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "pm-entries-"));
const c = join(root, ".claude");
for (const d of ["state", "backlog", "rules", "pm"]) mkdirSync(join(c, d), { recursive: true });
mkdirSync(join(root, "hub"));
mkdirSync(join(root, "runs/bench1"), { recursive: true });
mkdirSync(join(root, "scripts_x"));
writeFileSync(join(root, "scripts_x/tool.py"), "");
for (const s of ["hub", "bench1", "tool"]) writeFileSync(join(c, "backlog", `${s}.md`), `# ${s} — backlog\nUpdated: 2026-09-08\n\n## Todo\n- a\n`);
writeFileSync(join(c, "rules/notebooks.md"), "# notebooks\n"); // rules only: not a project
writeFileSync(join(c, "entries.json"), JSON.stringify({
  bench1: { kind: "tool", path: "runs/bench1" },
  old: { kind: "benchmark", path: "runs/old" }, // benchmark kind was dropped: ignored
  tool: { kind: "tool", path: "scripts_x/tool.py" },
  bad: { kind: "weird", path: "x" }, // ignored
}));

process.env.PM_ROOT = root;
const { entryDir, kindOf, entryPaths } = await import("./entries.mjs");
const { listProjects, getProject } = await import("./projects.mjs");
const { guessProject } = await import("./harvest.mjs");

test("entries stay out of the project list and are listed by kind; rules-only files are not projects", async () => {
  assert.deepEqual((await listProjects()).map((p) => p.slug), ["hub"]);
  assert.deepEqual((await listProjects("tool")).map((p) => p.slug).sort(), ["bench1", "tool"]);
  assert.equal((await listProjects("all")).length, 3);
  assert.equal(kindOf("bad"), "project");
});

test("cwd: entry path (a file entry -> its folder), else PM_ROOT/slug", () => {
  assert.equal(entryDir("bench1"), join(root, "runs/bench1"));
  assert.equal(entryDir("tool"), join(root, "scripts_x"));
  assert.equal(entryDir("hub"), join(root, "hub"));
});

test("detail carries kind + path; a session whose cwd is inside an entry path lands on it", async () => {
  const p = await getProject("bench1");
  assert.equal(p.kind, "tool");
  assert.equal(p.path, "runs/bench1");
  const slugs = new Set(["hub", "bench1", "tool"]);
  const entries = entryPaths();
  assert.equal(guessProject({ cwd: join(root, "runs/bench1/sub"), slugs, entries }), "bench1");
  assert.equal(guessProject({ cwd: join(root, "runs/bench10"), slugs, entries }), null); // prefix is not inside
  assert.equal(guessProject({ cwd: join(root, "hub"), slugs, entries }), "hub");
});
