import test from "node:test";
import assert from "node:assert/strict";

process.env.PM_LAUNCH_DRYRUN = "1";
const { seedForTask, seedForSequentialRun, seedForCrossProjectRun, launchClaude } = await import("./launch.mjs");

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
  assert.match(s, /Leave the idea in Todo/);
  // Build / Adopt + extend promotes to a real project (bookkeeping only, no build)
  assert.match(s, /PROMOTE the idea into\s+a real pm project/);
  assert.match(s, /\.claude\/state\/<slug>\.md/);
  assert.match(s, /\.claude\/backlog\/<slug>\.md/);
  assert.match(s, /Remove the idea's bullet from \.claude\/backlog\/ideas\.md/);
  assert.match(s, /no Step 6/);
  assert.doesNotMatch(s, /TASK:/);
});

test("ideas research triage is ordered: venturemind, then prospector first, adopt stops before atelier", () => {
  const s = seedForTask({ slug: "ideas", title: "a cool idea" });
  assert.match(s, /prospector/);
  assert.ok(s.indexOf("venturemind") < s.indexOf("prospector"));
  assert.ok(s.indexOf("prospector") < s.indexOf("atelier"));
  assert.match(s, /FIRST/);
  assert.match(s, /Verdict "Adopt"[^\n]*\n[^\n]*STOP\. Do not invoke `atelier`/);
  assert.match(s, /adopt <tool>, not built/);
  assert.match(s, /knowledge\/prospector\/<slug>\.md/);
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

test("seedForSequentialRun words the batch by mode: @seq-flagged only in seq mode", () => {
  const tasks = [{ title: "a" }, { title: "b" }, { title: "c" }];
  const seq = seedForSequentialRun({ slug: "hub", tasks });
  assert.match(seq, /batch of 3 @seq-flagged todo\(s\)/);
  assert.match(seq, /drop its @seq marker/);
  const all = seedForSequentialRun({ slug: "hub", tasks, mode: "all" });
  assert.match(all, /batch of 3 todo\(s\)/);
  assert.doesNotMatch(all, /@seq-flagged/);
  assert.doesNotMatch(all, /drop its @seq marker/);
  assert.match(all, /localhost:4310\/api\/summary/);
});

test("seedForCrossProjectRun groups by project and carries pacing + read-first rules", () => {
  const s = seedForCrossProjectRun({
    tasks: [
      { slug: "hub", title: "hub one", note: "hub note" },
      { slug: "pm", title: "pm one", note: null },
      { slug: "hub", title: "hub two", note: null },
    ],
  });
  assert.match(s, /3 todo\(s\) spanning 2 project\(s\)/);
  // grouped: both hub todos under one [hub] header, before [pm]
  assert.match(s, /\[hub\]\n {2}1\. hub one\n {5}hub note\n {2}2\. hub two\n\n\[pm\]\n {2}1\. pm one/);
  assert.match(s, /\.claude\/rules\/<slug>\.md and \.claude\/state\/<slug>\.md/);
  assert.match(s, /DIFFERENT projects[^\n]*\n?[^\n]*parallel/);
  assert.match(s, /SAME project run sequentially/);
  assert.match(s, /move it to Done/);
  assert.match(s, /localhost:4310\/api\/summary/);
  assert.match(s, /vscode-claude-status-cache\.json/);
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

test("seedForSequentialRun on ideas runs prospector first and stops on an adopt verdict", () => {
  const s = seedForSequentialRun({ slug: "ideas", tasks: [{ title: "idea one", note: null }] });
  assert.match(s, /prospector/);
  assert.ok(s.indexOf("venturemind") < s.indexOf("prospector"));
  assert.ok(s.indexOf("prospector") < s.indexOf("`atelier` skill and run its FULL workflow"));
  assert.match(s, /"Adopt" \(a suitable off-the-shelf tool exists\) -> STOP/);
  assert.match(s, /Do NOT scaffold a project/);
  assert.match(s, /adopt <tool>, not built - see knowledge\/prospector\/<slug>\.md/);
  assert.match(s, /un-flag it/);
  assert.match(s, /'adopt, not built'/);
});

test("launchClaude dryrun builds a resume command", async () => {
  const r = await launchClaude({ cwd: "/tmp", resumeId: "abcd-1234" });
  assert.equal(r.dryrun, true);
  // default provider is plain Claude Code: no OpenRouter env vars, no --model flag
  assert.match(r.cmd, /^cd '\/tmp' && claude --resume 'abcd-1234'$/);
  assert.ok(r.osa.includes(r.term === "iterm" ? "iTerm" : "Terminal"));
});

test("launchClaude dryrun writes the prompt to a file, not the command line", async () => {
  const r = await launchClaude({ cwd: "/tmp", prompt: 'weird "quotes" and $(rm -rf /) here' });
  assert.match(r.cmd, /^cd '\/tmp' && claude "\$\(cat '\/.*prompt\.txt'\)"$/);
  assert.doesNotMatch(r.cmd, /rm -rf/); // prompt text never on the command line
});

test("osa wraps the command in an escaped AppleScript string literal", async () => {
  const r = await launchClaude({ cwd: "/tmp", resumeId: "x1" });
  assert.ok(r.osa.startsWith("tell application"));
  // inner `claude "$(cat ...)"` double-quotes must be backslash-escaped for AppleScript
  const r2 = await launchClaude({ cwd: "/tmp", prompt: "hi" });
  assert.match(r2.osa, /\\"\$\(cat /);
});
