import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToSlug, guessProject } from "../../.claude/scripts/pm-activity.mjs";

// ---- attribution (pure, from the harvester) ----------------------------
test("pathToSlug maps abs + relative paths", () => {
  const slugs = new Set(["pm", "hub"]);
  assert.equal(pathToSlug("/root/pm/web/x.js", slugs, "/root"), "pm");
  assert.equal(pathToSlug("hub/server/a.mjs", slugs), "hub");
  assert.equal(pathToSlug(".claude/state/pm.md", slugs), ".claude");
  assert.equal(pathToSlug("/other/place/x", slugs, "/root"), null);
  assert.equal(pathToSlug("/root/unknownproj/x", slugs, "/root"), null);
});

test("guessProject ranking: cwd-slug > most-touched > keyword > null", () => {
  const slugs = new Set(["pm", "hub", "checker"]);
  assert.equal(guessProject({ cwd: "/x/hub", hits: new Map(), slugs }), "hub");
  assert.equal(
    guessProject({ cwd: "/x/Projects", hits: new Map([["pm", 5], ["hub", 2], [".claude", 9]]), slugs }),
    "pm",
  );
  assert.equal(
    guessProject({ cwd: "", hits: new Map(), title: "Fix the checker monitor", slugs }),
    "checker",
  );
  assert.equal(guessProject({ cwd: "", hits: new Map(), title: "random musings", slugs }), null);
});

// ---- sessions.mjs (fixture-backed) ------------------------------------
const root = mkdtempSync(join(tmpdir(), "pm-sess-"));
const pm = join(root, ".claude", "pm");
mkdirSync(pm, { recursive: true });
mkdirSync(join(root, ".claude", "backlog"), { recursive: true });
writeFileSync(
  join(pm, "sessions.json"),
  JSON.stringify([
    { id: "aaaa1111-2222-3333", title: "Build hub widget", firstAsk: "make a widget", start: "2026-09-08T10:00:00Z", end: "2026-09-08T10:30:00Z", mins: 30, msgs: 40, cwd: "/x", touched: ["hub"], guess: "hub" },
    { id: "bbbb1111-2222-3333", title: "Loose idea", firstAsk: "what if", start: "2026-09-07T10:00:00Z", end: "2026-09-07T10:05:00Z", mins: 5, msgs: 12, cwd: "/x", touched: [], guess: null },
  ]),
);
writeFileSync(join(root, ".claude", "backlog", "hub.md"), "# hub — backlog\nUpdated: 2026-09-08\n\n## Todo\n- existing\n");

process.env.PM_ROOT = root;
const s = await import("./sessions.mjs");

test("readSessions applies guess when unfiled, split into inbox/filed", async () => {
  const { inbox, filed } = await s.listSessions();
  assert.equal(inbox.length, 2);
  assert.equal(filed.length, 0);
  assert.equal(inbox[0].project, "hub"); // from guess
  assert.equal(inbox[0].filed, false);
});

test("fileSession writes session-index.json and moves the session to filed", async () => {
  await s.fileSession("bbbb1111-2222-3333", { project: "checker" });
  const idx = JSON.parse(readFileSync(join(pm, "session-index.json"), "utf8"));
  assert.equal(idx["bbbb1111-2222-3333"].project, "checker");
  const { inbox, filed } = await s.listSessions();
  assert.equal(inbox.length, 1);
  assert.equal(filed.length, 1);
  assert.equal(filed[0].project, "checker");
});

test("sessionToTask appends a resume bullet and marks taskCreated", async () => {
  await s.sessionToTask("aaaa1111-2222-3333", "hub");
  const bl = readFileSync(join(root, ".claude", "backlog", "hub.md"), "utf8");
  assert.match(bl, /- resume: Build hub widget/);
  assert.match(bl, /session aaaa1111-2222-3333/);
  const idx = JSON.parse(readFileSync(join(pm, "session-index.json"), "utf8"));
  assert.equal(idx["aaaa1111-2222-3333"].taskCreated, true);
});

test("moveTask relocates a bullet between backlog files", async () => {
  await s.moveTask("hub", 0, "checker");
  assert.doesNotMatch(readFileSync(join(root, ".claude", "backlog", "hub.md"), "utf8"), /- existing/);
  assert.match(readFileSync(join(root, ".claude", "backlog", "checker.md"), "utf8"), /- existing/);
  assert.ok(existsSync(join(root, ".claude", "backlog", "checker.md")));
});

// ---- new-project scaffold ----------------------------------------------
test("sessionToNewProject scaffolds files, files the session, seeds a Todo", async () => {
  const slug = await s.sessionToNewProject("aaaa1111-2222-3333", "Cool App");
  assert.equal(slug, "cool-app");
  for (const p of ["cool-app/README.md", "cool-app/CONTEXT.md", ".claude/state/cool-app.md", ".claude/backlog/cool-app.md", ".claude/rules/cool-app.md"])
    assert.ok(existsSync(join(root, p)), p);
  assert.match(readFileSync(join(root, ".claude", "rules", "cool-app.md"), "utf8"), /## Run & verify/);
  assert.ok(readFileSync(join(root, ".claude", "state", "cool-app.md"), "utf8").split("\n").length <= 40);
  assert.match(readFileSync(join(root, ".claude", "backlog", "cool-app.md"), "utf8"), /- resume: Build hub widget/);
  const idx = JSON.parse(readFileSync(join(pm, "session-index.json"), "utf8"));
  assert.equal(idx["aaaa1111-2222-3333"].project, "cool-app");
  assert.ok(!existsSync(join(root, "cool-app", ".git")));
});

test("scaffold rejects existing, traversal, bad names, unknown session", async () => {
  await assert.rejects(s.sessionToNewProject("aaaa1111-2222-3333", "cool-app"), { code: "EXISTS" });
  await assert.rejects(s.sessionToNewProject("aaaa1111-2222-3333", "hub"), { code: "EXISTS" }); // backlog file only
  for (const bad of ["../evil", "a/b", "", "-x", "a--b", "x".repeat(50), "ünï"])
    await assert.rejects(s.sessionToNewProject("aaaa1111-2222-3333", bad), { code: "BAD_SLUG" }, bad);
  await assert.rejects(s.sessionToNewProject("dead0000-0000", "fresh"), /no such session/);
  assert.ok(!existsSync(join(root, "fresh")));
});
