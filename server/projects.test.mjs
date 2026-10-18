import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "pm-test-"));
const c = join(root, ".claude");
for (const d of ["rules", "state", "backlog", "pm", "handoffs"]) mkdirSync(join(c, d), { recursive: true });
writeFileSync(join(c, "rules", "hub.md"), "# hub — rules\n");
writeFileSync(join(c, "rules", "agent.md"), "# agent — rules\n");
writeFileSync(join(c, "state", "hub.md"), "# hub — state\nUpdated: 2026-09-07\n\n## Now\n- [ ] ship it\n\n## Blockers\nnone\n");
writeFileSync(join(c, "state", "_TEMPLATE.md"), "# tpl\n");
writeFileSync(join(c, "backlog", "hub.md"), "# hub — backlog\nUpdated: 2026-09-08\n\n## Todo\n- a\n- b\n\n## Done\n- c  (2026-09-01)\n");
writeFileSync(join(c, "backlog", "randomidea.md"), "# randomidea — backlog\nUpdated: 2026-09-08\n\n## Todo\n- think\n");
writeFileSync(join(c, "pm", "activity.json"), JSON.stringify([{ project: "hub", date: "2026-09-07", kind: "commit", summary: "x", ref: "abc" }]));

process.env.PM_ROOT = root;
const { discoverSlugs, listProjects, getProject } = await import("./projects.mjs");

test("discovery is the union of state / backlog minus _TEMPLATE; a rules file alone is not a project", async () => {
  const { all } = await discoverSlugs();
  assert.deepEqual(all, ["hub", "randomidea"]); // rules/agent.md alone does not count
});

test("list carries status, open count, last activity, adhoc flag", async () => {
  const list = await listProjects();
  const hub = list.find((p) => p.slug === "hub");
  assert.equal(hub.status, "ship it");
  assert.equal(hub.openCount, 2); // Todo a,b — Done c excluded
  assert.equal(hub.lastActivity, "2026-09-07");
  assert.equal(hub.adhoc, false);
  assert.equal(list.find((p) => p.slug === "randomidea").adhoc, true);
});

test("detail bundles state + backlog + filtered activity", async () => {
  const p = await getProject("hub");
  assert.equal(p.state.now, "ship it");
  assert.equal(p.backlog.tasks.length, 3);
  assert.equal(p.activity.length, 1);
  assert.equal(await getProject("nope"), null);
});

test("extractDescription takes the first prose paragraph after the H1", async () => {
  const { extractDescription } = await import("./projects.mjs");
  const md = "---\npaths: x/**\n---\n\n# x — thing\n\nA **small** tool for `things`.\nSecond line.\n\n```\nnpm i\n```\n\n## Next\nignored\n";
  assert.equal(extractDescription(md), "A small tool for things. Second line.");
  assert.equal(extractDescription("# only heading\n"), "");
  assert.ok(extractDescription(`# t\n\n${"word ".repeat(100)}`).length <= 180);
});
