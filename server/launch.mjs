// Open a Mac terminal running `claude`, seeded with a task or resuming a session.
// Prompt text is written to a temp file so it never lands on a shell command line.
import { execFile } from "node:child_process";
import { writeFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PM_ROOT } from "./paths.mjs";

const DRYRUN = process.env.PM_LAUNCH_DRYRUN === "1";
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const osaStr = (s) => `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

// The launched window would otherwise inherit CLAUDE_CODE_CHILD_SESSION from the
// pm server's process tree and start as a nested child (transcript saving off).
const CLEAN_ENV = "unset CLAUDE_CODE_CHILD_SESSION CLAUDECODE CLAUDE_CODE_ENTRYPOINT CLAUDE_CODE_SSE_PORT; ";

// Open a Mac terminal running `inner` (a shell command line). iTerm's `command`
// param does NOT go through a shell (naive execvp tokenization — `&&` breaks it),
// so create the window then `write text`, which the session's shell evaluates.
function termOsa(rawInner) {
  const inner = CLEAN_ENV + rawInner;
  const iterm = existsSync("/Applications/iTerm.app");
  const osa = iterm
    ? `tell application "iTerm"\n  activate\n  create window with default profile\n  tell current session of current window to write text ${osaStr(inner)}\nend tell`
    : `tell application "Terminal"\n  activate\n  do script ${osaStr(inner)}\nend tell`;
  return { osa, term: iterm ? "iterm" : "terminal" };
}

export function seedForTask({ slug, title, note, adhoc }) {
  if (slug === "ideas") return seedForIdeaResearch({ title, note });
  const out = [`You're picking up a task from the pm board backlog for "${slug}".`, "", `TASK: ${title}`];
  if (note) out.push("", note);
  out.push("");
  if (adhoc)
    out.push(`Ad-hoc item (no code dir yet). When done, mark it Done in .claude/backlog/${slug}.md.`);
  else
    out.push(
      `First read .claude/rules/${slug}.md and .claude/state/${slug}.md for context.`,
      `When done, update .claude/state/${slug}.md and move this task to Done in .claude/backlog/${slug}.md.`,
    );
  return out.join("\n");
}

// Seed prompt for a single ▶ Run on an Ideas-inbox item: research only, stop
// short of building. You are the idea's future developer, not its builder yet
// — actual project creation happens later via "Run @seq" (seedForIdeaPromotion).
function seedForIdeaResearch({ title, note }) {
  const out = [
    `You're picking up an idea from the pm board's Ideas inbox. You are being`,
    `stationed as this idea's future developer — the one who will eventually`,
    `build it — but right now your job is research only, not building.`,
    "",
    `IDEA: ${title}`,
  ];
  if (note) out.push("", note);
  out.push(
    "",
    "TRIAGE — pick exactly one:",
    "- If this is a genuine business/venture concept (a monetizable market play,",
    "  not just \"this could theoretically be a product\"), invoke the `venturemind`",
    "  skill and run its normal workflow against this idea.",
    "- Otherwise (a personal tool for the user, not a business), invoke the",
    "  `atelier` skill and run it through Steps 0-5 only (frame, component",
    "  build-vs-reuse inventory, architecture, aesthetic bar, phased plan) —",
    "  do NOT run its Step 6 (Build). This is a one-shot session with no",
    "  follow-up turn, so state assumptions and proceed rather than stalling on",
    "  a question nobody can answer.",
    "",
    "When the skill finishes, this is a one-shot session — proactively write its",
    "save artifact to disk yourself rather than waiting to be asked (venturemind's",
    "`.vmind` export to `venturemind/vmind_saves/`, or atelier's report to",
    "`knowledge/atelier/<slug>.md`).",
    "",
    "Finally, add ONE indented note line under this idea's bullet in",
    "`.claude/backlog/ideas.md` (match it by its title text) pointing at the",
    "artifact you just saved, e.g. \"researched — see knowledge/atelier/<slug>.md\".",
    "Leave the idea itself in Todo — do not move, promote, or delete it. Promoting",
    "it into a real pm project happens later, in a batch, via Run @seq.",
  );
  return out.join("\n");
}

// Shared burn-rate-pacing block for any orchestrator prompt that fans out to
// several WebSearch/build-heavy subagents in one one-shot session. Used by
// both the normal-project "Run @seq" orchestrator and the Ideas-promotion one.
const PACING = [
  "PACING — before each batch, size parallelism against the current burn rate.",
  "NOTE: this is a ONE-SHOT terminal session, not a /loop session — do NOT call the",
  "ScheduleWakeup tool for pacing (its schema requires a `prompt` unless `stop: true`,",
  "and it doesn't apply here anyway).",
  "  1. PRIMARY: GET http://localhost:4310/api/summary?bucket=hour (claude_usage_dashboard).",
  "     Use the last few hourly buckets as a trailing tokens/hour signal — rising = fewer",
  "     concurrent subagents / smaller batches, quiet = widen. On any connection error,",
  "     fall through to source 2 and stay conservative (<=2 concurrent subagents).",
  "  2. SECONDARY, rate-limit ceiling only: ~/.claude/vscode-claude-status-cache.json —",
  "     fields utilization5h, utilization7d, limitStatus, reset5hAt/reset7dAt, updatedAt.",
  "     Check updatedAt FIRST: if it is more than ~15 min old the file is stale — ignore it.",
  "     This file reports the account's rate-limit percentage, NOT how many Claude Code",
  '     sessions are running, so utilization 0 with limitStatus "allowed" is normal and',
  "     just means you are nowhere near a limit — it is not a bug and not evidence the",
  "     system is idle. Act on it only when the file is fresh AND (limitStatus is not",
  '     "allowed" OR utilization5h >= ~85): if so, stop working this batch for now —',
  "     leave remaining @seq todos in place (un-flagged or noted as blocked-on-rate-limit",
  "     with the reset time), update state/backlog with that note, and end the session",
  "     normally (exit). Do not try to sleep, wait, or reschedule yourself — a human will",
  '     re-launch "Run @seq" later once the limit resets.',
].join("\n");

// Seed prompt for the "Run @seq" orchestrator launch: one claude session that
// works a batch of backlog todos, fanning them out to subagents and pacing itself
// against the current Claude usage / burn rate.
export function seedForSequentialRun({ slug, tasks, adhoc }) {
  if (slug === "ideas") return seedForIdeaPromotion({ tasks });
  const list = tasks
    .map((t, i) => {
      const head = `${i + 1}. ${t.title}`;
      return t.note ? `${head}\n   ${t.note.split("\n").join("\n   ")}` : head;
    })
    .join("\n");
  const out = [
    `You're the orchestrator for a batch of ${tasks.length} @seq-flagged todo(s) from the pm board backlog for "${slug}".`,
    "",
    "TODOS:",
    list,
    "",
  ];
  if (!adhoc)
    out.push(
      `First read .claude/rules/${slug}.md and .claude/state/${slug}.md for context.`,
      "",
    );
  out.push(
    "ORCHESTRATION:",
    "- Work out a dependency order. Todos that touch disjoint files/behaviour run in",
    "  parallel via subagents; todos that depend on each other run sequentially.",
    "  Re-evaluate after every batch (a completed todo can unblock or conflict with the rest).",
    "- Spawn a subagent per todo (the Task tool, per .claude/rules and CLAUDE.md).",
    "  Keep each subagent scoped to one todo.",
    "- After a todo lands and its project's verify/tests pass, move it to Done in",
    `  .claude/backlog/${slug}.md and drop its @seq marker. Leave a todo in place`,
    "  (un-flagged, with a note) if it turns out blocked.",
    "",
    PACING,
    "",
    adhoc
      ? `When all todos are done or blocked, update .claude/backlog/${slug}.md and summarise what shipped, what was deferred, and why.`
      : `When all todos are done or blocked, update .claude/state/${slug}.md and .claude/backlog/${slug}.md, then summarise what shipped, what was deferred, and why.`,
  );
  return out.join("\n");
}

// Seed prompt for "Run @seq" on the Ideas inbox: promote every @seq-flagged
// idea into a real pm project (research + scaffold), instead of orchestrating
// todos within one existing project.
function seedForIdeaPromotion({ tasks }) {
  const list = tasks
    .map((t, i) => {
      const head = `${i + 1}. ${t.title}`;
      return t.note ? `${head}\n   ${t.note.split("\n").join("\n   ")}` : head;
    })
    .join("\n");
  const out = [
    `You're the orchestrator promoting a batch of ${tasks.length} @seq-flagged idea(s)`,
    "from the pm board's Ideas inbox into real pm projects.",
    "",
    "IDEAS:",
    list,
    "",
    "For EACH idea, spawn a subagent (the Task tool) scoped to just that idea. Ideas",
    "that clearly become disjoint projects run in parallel; if two ideas look like",
    "they'd become the same project, merge them into one subagent instead of creating",
    "duplicates and say so in your final summary.",
    "",
    "Each subagent must:",
    "1. Pick a kebab-case slug from the idea's title. Check .claude/backlog/ and",
    "   .claude/state/ for collisions; on collision append -2, -3, ...",
    "2. TRIAGE — pick exactly one:",
    "   - Genuine business/venture concept (a monetizable market play, not just",
    "     \"this could theoretically be a product\") -> invoke the `venturemind` skill",
    "     and run its normal workflow against the idea.",
    "   - Otherwise (a personal tool, not a business) -> invoke the `atelier` skill",
    "     and run its FULL workflow against the idea, including Step 6 (Build) below.",
    "   This is a one-shot session with no follow-up turn - state assumptions and",
    "   proceed all the way through rather than stalling on an unanswerable question.",
    "3. Create the project at PM_ROOT/<slug>/:",
    "   - mkdir PM_ROOT/<slug>/ and write PM_ROOT/<slug>/CONTEXT.md with the full",
    "     research writeup: problem framing, findings (atelier's component",
    "     build-vs-reuse table, or venturemind's market/legal findings - whichever",
    "     skill ran), the verdict, and a concrete phased implementation plan",
    "     (architecture, stack, phases). If atelier ran its Step 6, this also",
    "     documents what got scaffolded/built and what's deferred.",
    "   - If atelier ran Step 6, its scaffolded project files live at",
    "     PM_ROOT/<slug>/ alongside CONTEXT.md. If venturemind ran instead (a",
    "     business idea), still scaffold a minimal starting structure for the",
    "     chosen technical architecture from its Phase 3, and fold any KVKK/legal",
    "     constraints it found into CONTEXT.md and this project's Blockers.",
    "   - Write .claude/state/<slug>.md (<=40 lines - the cap is enforced, do not",
    "     exceed it): Now = \"researched, ready to build\" (or \"scaffolded, phase N",
    "     next\" if atelier's Step 6 ran); Next = the top implementation phases as",
    "     one-liners, pointing at CONTEXT.md for detail; Blockers = any",
    "     compliance/legal flags from venturemind, else \"none\".",
    "   - Write .claude/backlog/<slug>.md with one Todo task per remaining",
    "     implementation phase from the plan, sized so a later Run / Run @seq on",
    "     this new project can pick them off one at a time.",
    "4. Remove the idea's bullet from .claude/backlog/ideas.md entirely - it's now",
    "   promoted into its own project, don't leave a duplicate behind.",
    "",
    PACING,
    "",
    "When every idea is promoted (or skipped/merged, with a note why), summarise the",
    "new project slugs created and what, if anything, was skipped or merged.",
  ];
  return out.join("\n");
}

// Open a Mac terminal running an arbitrary command in `cwd`. Same osascript /
// iTerm-else-Terminal path as launchClaude; `PM_LAUNCH_DRYRUN=1` returns the
// command instead of spawning. Used to start `continuous`'s runner loop in a
// visible window (pm stays out of process supervision).
export function launchCommand({ cwd, inner: cmd }) {
  const dir = cwd && existsSync(cwd) ? cwd : PM_ROOT;
  const inner = `cd ${shq(dir)} && ${cmd}`;
  const { osa, term } = termOsa(inner);
  if (DRYRUN) return Promise.resolve({ dryrun: true, term, cmd: inner, osa });
  return new Promise((resolve, reject) =>
    execFile("osascript", ["-e", osa], (err) => (err ? reject(err) : resolve({ term }))),
  );
}

export function launchClaude({ cwd, prompt, resumeId }) {
  const dir = cwd && existsSync(cwd) ? cwd : PM_ROOT;
  let inner;
  if (resumeId) {
    inner = `cd ${shq(dir)} && claude --resume ${shq(resumeId)}`;
  } else {
    const seed = join(mkdtempSync(join(tmpdir(), "pm-seed-")), "prompt.txt");
    writeFileSync(seed, prompt || "");
    inner = `cd ${shq(dir)} && claude "$(cat ${shq(seed)})"`;
  }
  const { osa, term } = termOsa(inner);
  if (DRYRUN) return Promise.resolve({ dryrun: true, term, cmd: inner, osa });
  return new Promise((resolve, reject) =>
    execFile("osascript", ["-e", osa], (err) => (err ? reject(err) : resolve({ term }))),
  );
}
