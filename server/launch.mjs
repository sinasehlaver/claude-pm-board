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

// Seed prompt for the "Run @seq" orchestrator launch: one claude session that
// works a batch of backlog todos, fanning them out to subagents and pacing itself
// against the current Claude usage / burn rate.
export function seedForSequentialRun({ slug, tasks, adhoc }) {
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
    "PACING — before each batch, size parallelism against the current burn rate:",
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
    '     "allowed" OR utilization5h >= ~85): then stop and wait until the reset time',
    "     before the next batch.",
    "",
    adhoc
      ? `When all todos are done or blocked, update .claude/backlog/${slug}.md and summarise what shipped, what was deferred, and why.`
      : `When all todos are done or blocked, update .claude/state/${slug}.md and .claude/backlog/${slug}.md, then summarise what shipped, what was deferred, and why.`,
  );
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
