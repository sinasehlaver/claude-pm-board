import test from "node:test";
import assert from "node:assert/strict";

process.env.PM_LAUNCH_DRYRUN = "1";
const { seedForTask, seedForSequentialRun, launchClaude } = await import("./launch.mjs");

test("seedForTask includes rules pointers for real projects, not ad-hoc", () => {
  const real = seedForTask({ slug: "hub", title: "do X", note: "the note" });
  assert.match(real, /TASK: do X/);
  assert.match(real, /the note/);
  assert.match(real, /\.claude\/rules\/hub\.md/);

  const adhoc = seedForTask({ slug: "someidea", title: "sketch it", adhoc: true });
  assert.doesNotMatch(adhoc, /\.claude\/rules\//);
  assert.match(adhoc, /\.claude\/backlog\/someidea\.md/);
});

test("seedForTask routes Ideas items to research-only atelier/venturemind triage", () => {
  const s = seedForTask({ slug: "ideas", title: "a cool idea", note: "some context" });
  assert.match(s, /IDEA: a cool idea/);
  assert.match(s, /some context/);
  assert.match(s, /venturemind/);
  assert.match(s, /atelier/);
  assert.match(s, /do NOT run its Step 6/);
  assert.match(s, /Leave the idea itself in Todo/);
  assert.doesNotMatch(s, /TASK:/);
});

test("seedForSequentialRun lists every todo, the burn-rate sources, and rules pointer", () => {
  const s = seedForSequentialRun({
    slug: "hub",
    tasks: [
      { title: "todo one", note: "a note" },
      { title: "todo two", note: null },
    ],
  });
  assert.match(s, /2 @seq-flagged todo/);
  assert.match(s, /1\. todo one/);
  assert.match(s, /a note/);
  assert.match(s, /2\. todo two/);
  assert.match(s, /vscode-claude-status-cache\.json/);
  assert.match(s, /localhost:4310\/api\/summary/);
  // the status cache is secondary and only trustworthy when fresh
  assert.match(s, /updatedAt/);
  assert.match(s, /utilization 0 .* is normal|not a bug/);
  assert.match(s, /\.claude\/rules\/hub\.md/);

  const adhoc = seedForSequentialRun({ slug: "someidea", tasks: [{ title: "x" }], adhoc: true });
  assert.doesNotMatch(adhoc, /\.claude\/rules\//);
  assert.match(adhoc, /\.claude\/backlog\/someidea\.md/);
});

test("seedForSequentialRun on ideas promotes each into a real pm project", () => {
  const s = seedForSequentialRun({
    slug: "ideas",
    tasks: [
      { title: "idea one", note: "note one" },
      { title: "idea two", note: null },
    ],
  });
  assert.match(s, /2 @seq-flagged idea/);
  assert.match(s, /1\. idea one/);
  assert.match(s, /note one/);
  assert.match(s, /2\. idea two/);
  assert.match(s, /venturemind/);
  assert.match(s, /atelier/);
  assert.match(s, /CONTEXT\.md/);
  assert.match(s, /mkdir PM_ROOT\/<slug>\//);
  assert.match(s, /Remove the idea's bullet from \.claude\/backlog\/ideas\.md/);
  // still shares the burn-rate pacing block
  assert.match(s, /localhost:4310\/api\/summary/);
  assert.match(s, /vscode-claude-status-cache\.json/);
});

test("launchClaude dryrun builds a resume command", async () => {
  const r = await launchClaude({ cwd: "/tmp", resumeId: "abcd-1234" });
  assert.equal(r.dryrun, true);
  assert.match(r.cmd, /cd '\/tmp' && claude --resume 'abcd-1234'/);
  assert.ok(r.osa.includes(r.term === "iterm" ? "iTerm" : "Terminal"));
});

test("launchClaude dryrun writes the prompt to a file, not the command line", async () => {
  const r = await launchClaude({ cwd: "/tmp", prompt: 'weird "quotes" and $(rm -rf /) here' });
  assert.match(r.cmd, /claude "\$\(cat '\/.*prompt\.txt'\)"/);
  assert.doesNotMatch(r.cmd, /rm -rf/); // prompt text never on the command line
});

test("osa wraps the command in an escaped AppleScript string literal", async () => {
  const r = await launchClaude({ cwd: "/tmp", resumeId: "x1" });
  assert.ok(r.osa.startsWith("tell application"));
  // inner `claude "$(cat ...)"` double-quotes must be backslash-escaped for AppleScript
  const r2 = await launchClaude({ cwd: "/tmp", prompt: "hi" });
  assert.match(r2.osa, /\\"\$\(cat /);
});
