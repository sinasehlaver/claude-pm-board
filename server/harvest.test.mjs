import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const root = mkdtempSync(join(tmpdir(), "pm-harv-"));
const home = mkdtempSync(join(tmpdir(), "pm-harv-home-"));
after(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});
for (const d of [".claude/state", ".claude/backlog", ".claude/pm", "hub/handoff"]) mkdirSync(join(root, d), { recursive: true });
writeFileSync(join(root, ".claude/state/hub.md"), "# hub — state\nUpdated: 2026-09-07\n\n## Now\n- [ ] x\n\n## Next\n\n## Last failure\nnone\n\n## Blockers\nnone\n");
writeFileSync(join(root, "hub/handoff/hub-20260908.md"), "# Hub handoff\nbody\n");
const git = (...a) => execFileSync("git", ["-C", join(root, "hub"), "-c", "user.email=t@t", "-c", "user.name=t", ...a], { stdio: "pipe" });
git("init", "-q");
writeFileSync(join(root, "hub/a.txt"), "a");
git("add", "a.txt");
git("commit", "-q", "-m", "diet widgets");

// transcript dir the way Claude Code names it: PM_ROOT with non-alphanumerics -> "-"
const tdir = join(home, "projects", root.replace(/[^a-zA-Z0-9]/g, "-"));
mkdirSync(tdir, { recursive: true });
const ts = (m) => new Date(Date.now() - m * 60000).toISOString();
const lines = [
  { type: "user", timestamp: ts(30), cwd: root, message: { role: "user", content: "<command-name>/x</command-name>" } },
  { type: "user", timestamp: ts(29), cwd: root, message: { role: "user", content: [{ type: "text", text: "run the hub benchmark again" }] } },
  { type: "ai-title", aiTitle: "Hub benchmark rerun" },
  { type: "assistant", timestamp: ts(20), message: { role: "assistant", content: [{ type: "tool_use", name: "Edit", input: { file_path: join(root, "hub/bench.py") } }] } },
  { type: "assistant", timestamp: ts(10), message: { role: "assistant", content: [{ type: "text", text: "done" }] } },
];
writeFileSync(join(tdir, "feedface-0000-1111-2222.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
writeFileSync(join(tdir, "empty-0000-1111-2222.jsonl"), "not json\n"); // no user message -> skipped

process.env.PM_ROOT = root;
process.env.CLAUDE_PROJECTS_ROOT = join(home, "projects");
const { harvest } = await import("./harvest.mjs");

test("harvest writes sessions.json (title, first real ask, attribution) and activity.json (commit + handoff)", async () => {
  const r = await harvest();
  assert.equal(r.sessions, 1);
  const sess = JSON.parse(readFileSync(join(root, ".claude/pm/sessions.json"), "utf8"));
  assert.equal(sess[0].id, "feedface-0000-1111-2222");
  assert.equal(sess[0].title, "Hub benchmark rerun");
  assert.equal(sess[0].firstAsk, "run the hub benchmark again"); // the <command-name> wrapper is not the ask
  assert.deepEqual(sess[0].touched, ["hub"]);
  assert.equal(sess[0].guess, "hub");
  assert.equal(sess[0].mins, 20);
  const act = JSON.parse(readFileSync(join(root, ".claude/pm/activity.json"), "utf8"));
  assert.ok(act.some((a) => a.kind === "commit" && a.project === "hub" && a.summary === "diet widgets"));
  assert.ok(act.some((a) => a.kind === "session" && a.project === "hub" && a.summary === "Hub benchmark rerun"));
  assert.ok(act.some((a) => a.kind === "handoff" && a.project === "hub" && a.summary === "Hub handoff"));
});

test("a second harvest re-uses unchanged transcripts and is idempotent", async () => {
  const before = readFileSync(join(root, ".claude/pm/sessions.json"), "utf8");
  await harvest();
  assert.equal(readFileSync(join(root, ".claude/pm/sessions.json"), "utf8"), before);
});
