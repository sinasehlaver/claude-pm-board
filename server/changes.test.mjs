import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, symlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "pm-changes-"));
process.env.PM_ROOT = root;
Object.assign(process.env, { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" });
const C = await import("./changes.mjs");

const sh = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8" });
const repo = join(root, "alpha");
mkdirSync(repo);
sh(repo, "init", "-q", "-b", "main");
const lines = (n, mark = {}) => Array.from({ length: n }, (_, i) => mark[i + 1] ?? `line ${i + 1}`).join("\n") + "\n";
writeFileSync(join(repo, "a.txt"), lines(40));
sh(repo, "add", "-A");
sh(repo, "commit", "-qm", "init");
mkdirSync(join(root, "plain")); // not a repo

test("parseDiff splits hunks and counts", () => {
  const d = C.parseDiff("diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n a\n-b\n+c\n@@ -9 +9 @@\n-x\n+y\n");
  assert.equal(d.hunks.length, 2);
  assert.equal(d.hunks[0].lines.length, 3);
  assert.equal(d.hunks[1].oldLines, 1);
  assert.equal(d.header.length, 3);
});

test("parseStatus reads branch, ahead/behind, renames, untracked", () => {
  const z = ["# branch.head main", "# branch.upstream origin/main", "# branch.ab +2 -1", "1 .M N... 100644 100644 100644 h h a b.txt", "2 R. N... 100644 100644 100644 h h R100 new.txt", "old.txt", "? u.txt", ""].join("\0");
  const s = C.parseStatus(z);
  assert.deepEqual([s.branch, s.upstream, s.ahead, s.behind], ["main", "origin/main", 2, 1]);
  assert.deepEqual(s.files.map((f) => f.path), ["a b.txt", "new.txt", "u.txt"]);
  assert.equal(s.files[1].orig, "old.txt");
});

test("git repos and plain folders are listed; init only works on plain folders", async () => {
  const l = await C.listRepos();
  assert.deepEqual(l.map((r) => [r.slug, r.git !== false]), [["alpha", true], ["plain", false]]);
  await assert.rejects(C.initRepo("alpha"), { status: 404 });
  await assert.rejects(C.initRepo("../x"), { status: 404 });
  assert.equal((await C.initRepo("plain")).gitignore, true);
  assert.match(readFileSync(join(root, "plain", ".gitignore"), "utf8"), /node_modules\//);
  assert.ok(existsSync(join(root, "plain", ".git")));
  assert.equal((await C.listRepos()).find((r) => r.slug === "plain").git, undefined);
  await assert.rejects(C.initRepo("plain"), { status: 404 });
});

test("hunk-level keep / unkeep / discard", async () => {
  writeFileSync(join(repo, "a.txt"), lines(40, { 2: "TWO", 38: "THIRTY-EIGHT" }));
  let s = await C.repoStatus("alpha");
  assert.deepEqual([s.staged.length, s.changes.length], [0, 1]);
  let d = await C.fileDiff("alpha", "a.txt", "changes");
  assert.equal(d.hunks.length, 2);

  await C.applyChange("alpha", { path: "a.txt", side: "changes", action: "keep", hunk: { index: 0, header: d.hunks[0].header } });
  assert.match(sh(repo, "diff", "--cached"), /TWO/);
  assert.doesNotMatch(sh(repo, "diff", "--cached"), /THIRTY-EIGHT/);
  s = await C.repoStatus("alpha");
  assert.deepEqual([s.staged.length, s.changes.length], [1, 1]);

  d = await C.fileDiff("alpha", "a.txt", "staged");
  await C.applyChange("alpha", { path: "a.txt", side: "staged", action: "unkeep", hunk: { index: 0, header: d.hunks[0].header } });
  assert.equal(sh(repo, "diff", "--cached"), "");

  d = await C.fileDiff("alpha", "a.txt", "changes");
  const stale = { index: 0, header: "@@ -1 +1 @@" };
  await assert.rejects(C.applyChange("alpha", { path: "a.txt", side: "changes", action: "discard", hunk: stale }), { status: 409 });
  const r = await C.applyChange("alpha", { path: "a.txt", side: "changes", action: "discard", hunk: { index: 1, header: d.hunks[1].header } });
  assert.match(readFileSync(join(repo, "a.txt"), "utf8"), /TWO/);
  assert.doesNotMatch(readFileSync(join(repo, "a.txt"), "utf8"), /THIRTY-EIGHT/);
  assert.match(readFileSync(join(root, r.backup), "utf8"), /THIRTY-EIGHT/); // discard is recoverable
});

test("file-level keep, discard, untracked", async () => {
  writeFileSync(join(repo, "new.txt"), "hello\nworld");
  const d = await C.fileDiff("alpha", "new.txt", "changes");
  assert.equal(d.untracked, true);
  assert.equal(d.hunks[0].lines.filter((l) => l.t === "+").length, 2);
  await assert.rejects(C.applyChange("alpha", { path: "new.txt", side: "changes", action: "keep", hunk: { index: 0, header: d.hunks[0].header } }), { status: 400 });
  const r = await C.applyChange("alpha", { path: "new.txt", side: "changes", action: "discard" });
  assert.equal(existsSync(join(repo, "new.txt")), false);
  assert.match(readFileSync(join(root, r.backup), "utf8"), /\+hello/);

  const r2 = await C.applyChange("alpha", { path: "a.txt", side: "changes", action: "discard" });
  assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), lines(40));
  assert.ok(existsSync(join(root, r2.backup)));
});

test("commit needs staged files and a message; push goes to the remote", async () => {
  const bare = join(root, "remote.git");
  mkdirSync(bare);
  sh(bare, "init", "-q", "--bare", "-b", "main");
  sh(repo, "remote", "add", "origin", bare);
  writeFileSync(join(repo, "a.txt"), lines(40, { 5: "FIVE" }));
  await assert.rejects(C.commit("alpha", "msg"), { status: 409 }); // nothing staged
  await C.stageAll("alpha", true);
  await assert.rejects(C.commit("alpha", "  "), { status: 400 }); // empty message needs amend=true
  const { hash } = await C.commit("alpha", "-n evil $(touch /tmp/pm-pwn)\n\nbody");
  assert.match(hash, /^[0-9a-f]+$/);
  assert.equal(sh(repo, "log", "-1", "--format=%s"), "-n evil $(touch /tmp/pm-pwn)\n");
  assert.equal((await C.listRepos())[0].upstream, "");
  await C.push("alpha");
  assert.equal(sh(bare, "rev-parse", "main").trim(), sh(repo, "rev-parse", "HEAD").trim());
  assert.equal((await C.listRepos())[0].upstream, "origin/main");
});

test("untrusted input is refused", async () => {
  await assert.rejects(C.repoStatus("../etc"), { status: 404 });
    await assert.rejects(C.fileDiff("alpha", "../../etc/passwd", "changes"), { status: 404 });
  await assert.rejects(C.fileDiff("alpha", "--output=/tmp/x", "changes"), { status: 404 });
  await assert.rejects(C.applyChange("alpha", { path: "a.txt", side: "changes", action: "rm -rf" }), { status: 400 });
  await assert.rejects(C.applyChange("alpha", { path: "a.txt", side: "changes", action: "unkeep" }), { status: 400 });
  await assert.rejects(C.applyChange("alpha", { path: "x\0y", side: "changes", action: "keep" }), { status: 400 });
  await assert.rejects(C.commit("nope", "m"), { status: 404 });
});

test("untracked symlink is not followed", async () => {
  writeFileSync(join(root, "secret.txt"), "TOPSECRET\n");
  symlinkSync(join(root, "secret.txt"), join(repo, "link.txt"));
  const d = await C.fileDiff("alpha", "link.txt", "changes");
  assert.equal(d.hunks.length, 0);
  assert.ok(!JSON.stringify(d).includes("TOPSECRET"));
});

test("stageAll tracked skips untracked files", async () => {
  writeFileSync(join(repo, "a.txt"), lines(40, { 7: "SEVEN" }));
  writeFileSync(join(repo, "fresh.txt"), "x\n");
  await C.stageAll("alpha", true, true);
  const s = await C.repoStatus("alpha");
  assert.deepEqual(s.staged.map((f) => f.path), ["a.txt"]);
  assert.ok(s.changes.every((f) => f.untracked) && s.changes.some((f) => f.path === "fresh.txt"));
});

test("amend with no message folds staged files into the last commit", async () => {
  const before = sh(repo, "rev-list", "--count", "HEAD").trim();
  const subject = sh(repo, "log", "-1", "--format=%s");
  writeFileSync(join(repo, "a.txt"), lines(40, { 9: "NINE" }));
  await C.stageAll("alpha", true, true);
  const r = await C.commit("alpha", "", true);
  assert.equal(r.amended, true);
  assert.equal(sh(repo, "rev-list", "--count", "HEAD").trim(), before);
  assert.equal(sh(repo, "log", "-1", "--format=%s"), subject);
  assert.match(sh(repo, "show", "HEAD", "--", "a.txt"), /NINE/);
  await assert.rejects(C.commit("alpha", "", true), { status: 409 }); // nothing staged
});

test("fetch shows behind; pull is fast-forward only and aborts cleanly", async () => {
  const bare = join(root, "remote.git");
  const other = join(root, "other-clone");
  sh(repo, "push", "-q", "--force"); // earlier tests amended a pushed commit; resync the remote
  sh(root, "clone", "-q", bare, other);
  writeFileSync(join(other, "remote.txt"), "r\n");
  sh(other, "add", "-A");
  sh(other, "commit", "-qm", "remote work");
  sh(other, "push", "-q");
  assert.equal((await C.repoStatus("alpha")).behind, 0); // stale until fetched
  assert.equal((await C.fetchRepo("alpha")).behind, 1);
  assert.equal((await C.repoStatus("alpha")).behind, 1);
  await C.pullRepo("alpha");
  assert.ok(existsSync(join(repo, "remote.txt")));
  assert.equal((await C.repoStatus("alpha")).behind, 0);

  // diverge: one commit on each side -> pull refuses, history untouched
  writeFileSync(join(other, "remote2.txt"), "r2\n");
  sh(other, "add", "-A");
  sh(other, "commit", "-qm", "remote 2");
  sh(other, "push", "-q");
  writeFileSync(join(repo, "local2.txt"), "l\n");
  sh(repo, "add", "-A");
  sh(repo, "commit", "-qm", "local 2");
  const head = sh(repo, "rev-parse", "HEAD");
  await C.fetchRepo("alpha");
  await assert.rejects(C.pullRepo("alpha"), { status: 409, message: /aborted/ });
  assert.equal(sh(repo, "rev-parse", "HEAD"), head);
  assert.equal(sh(repo, "status", "--porcelain", "-uno"), "");
  await assert.rejects(C.fetchRepo("plain-not-a-repo"), { status: 404 });
});
