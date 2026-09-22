// Open a Mac terminal running `claude`, seeded with a task or resuming a session.
// Prompt text is written to a temp file so it never lands on a shell command line.
import { execFile } from "node:child_process";
import { writeFileSync, existsSync, mkdtempSync, mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PM_ROOT } from "./paths.mjs";
import { relayDir, specPathFor, writeJson, pruneRelay, BACKLOG_CLI } from "./relay.mjs";

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
// short of building. You are the idea's future developer, not its builder yet.
// A Build / Adopt+extend verdict auto-promotes the idea into a pm project (state +
// backlog, no scaffold); Adopt / venturemind results stay in Todo with a note.
// Building happens later, from the new project's own Run buttons. Batch promotion
// with a build is still "Run @seq" (seedForIdeaPromotion).
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
    "TRIAGE — ordered, take the first branch that fits:",
    "1. Genuine business/venture concept (a monetizable market play, not just",
    "   \"this could theoretically be a product\") -> invoke the `venturemind`",
    "   skill and run its normal workflow against this idea. Stop there.",
    "2. Otherwise it is a personal-use idea (a tool for the user, not a business).",
    "   Invoke the `prospector` skill FIRST — does this already exist, and should",
    "   the user adopt something or build it? Run its workflow through its verdict",
    "   and its Step 5 save. Then branch on prospector's verdict:",
    "   - Verdict \"Adopt\" (a suitable off-the-shelf tool exists): record the verdict",
    "     and STOP. Do not invoke `atelier`, do not plan or build anything.",
    "   - Verdict \"Build\" or \"Adopt + extend\" (nothing suitable exists, or a gap",
    "     is left to fill): continue into the `atelier` skill and run it through",
    "     Steps 0-5 only (frame, component build-vs-reuse inventory, architecture,",
    "     aesthetic bar, phased plan) — do NOT run its Step 6 (Build). Feed",
    "     prospector's findings in as atelier's Step 0/1 input instead of",
    "     re-searching from scratch.",
    "This is a one-shot session with no follow-up turn, so state assumptions and",
    "proceed rather than stalling on a question nobody can answer (prospector and",
    "atelier both end turns with a question — answer it yourself with your best",
    "assumption and keep going).",
    "",
    "When each skill finishes, proactively write its save artifact to disk yourself",
    "rather than waiting to be asked (venturemind's `.vmind` export to",
    "`venturemind/vmind_saves/`, prospector's report to",
    "`knowledge/prospector/<slug>.md`, atelier's report to",
    "`knowledge/atelier/<slug>.md`).",
    "",
    "Finally, file the result — it depends on the outcome:",
    "- Adopt verdict, or a venturemind (business) idea: add ONE indented note line",
    "  under this idea's bullet in `.claude/backlog/ideas.md` (match it by its title",
    "  text), e.g. \"adopt <tool>, not built — see knowledge/prospector/<slug>.md\" (or",
    "  the venturemind save path). Leave the idea in Todo — the user decides next.",
    "- Build or Adopt + extend verdict (atelier ran Steps 0-5): PROMOTE the idea into",
    "  a real pm project so it shows on the Home board. Do not build it (no Step 6,",
    "  no PM_ROOT/<slug>/ scaffold) — only the pm bookkeeping:",
    "  1. Pick the project slug = a short, memorable kebab-case product name (the",
    "     name you'd suggest for the app, not a sentence from the idea). Check",
    "     .claude/backlog/, .claude/state/ and .claude/rules/ for collisions; on",
    "     collision append -2, -3, ...",
    "  2. Write .claude/state/<slug>.md (<=40 lines, cap enforced; template",
    "     .claude/state/_TEMPLATE.md): one-line summary, \"Full plan:",
    "     knowledge/atelier/<file>.md\", Now = \"researched, ready to build\", Next = the",
    "     phases as one-liners, Blockers = \"none\" (or whatever atelier flagged).",
    "  3. Write .claude/backlog/<slug>.md with one Todo per phase from atelier's plan,",
    "     each with an indented note pointing at the plan; the first Todo's note says",
    "     to scaffold PM_ROOT/<slug>/ (README run/test section per the workspace",
    "     rules). Backlog format: see any existing .claude/backlog/*.md.",
    "  4. Remove the idea's bullet from .claude/backlog/ideas.md entirely (no",
    "     duplicate left behind).",
    "  5. End your final message with the chosen slug, why that name, and that the",
    "     user can rename or move it from the board (the ▸ move-to-project button).",
    "  Nobody can be asked mid-run, so this is the default — say plainly in the",
    "  final message that it was auto-promoted and how to undo it.",
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

// Pacing block for UNATTENDED runs (headless, supervised by server/relay.mjs).
// Differs from PACING on the one point that matters: hitting the rate limit is NOT
// a reason to stop — the relay sleeps until the reset time and resumes this session.
const PACING_RELAY = [
  "UNATTENDED RUN — you are headless under a relay script and the user is away. Nobody",
  "can answer a question or approve a permission prompt: state assumptions and proceed.",
  "Permission mode is acceptEdits and git is denied (do not commit). Edit/Write on",
  "anything under `.claude/` (backlog, state) is BLOCKED in headless mode and will fail —",
  "do not attempt it. Use this one allowed helper instead (run from any directory):",
  `  node ${BACKLOG_CLI} move <slug> <Todo|Doing|Blocked|Done> "<exact title>" ["note"]`,
  `  node ${BACKLOG_CLI} add <slug> "<title>"`,
  `  node ${BACKLOG_CLI} state <slug> now "<headline>" ["detail" ...]`,
  "If a todo needs a denied command or a decision only the user can make, `move` it to",
  "Blocked with a one-line note saying why, and go on to the next.",
  "",
  "PROGRESS — the relay decides what is left by reading each project's",
  ".claude/backlog/<slug>.md and matching todos BY TITLE. `move` a todo to Done (or",
  "Blocked) as soon as it lands and never rename its title, or it will look unfinished",
  "and be handed back to you.",
  "",
  "RATE LIMITS — if the account rate limit stops you, the relay waits for the reset time",
  "and resumes this SAME session with a \"continue\" message, so subagents cut off mid-task",
  "get picked up again. Therefore do NOT stop early, sleep, wait, or reschedule yourself",
  "(no ScheduleWakeup), and do not end the session because usage looks high — just keep",
  "working. Spread the load anyway: keep <=3 concurrent subagents, and if",
  "http://localhost:4310/api/summary?bucket=hour (claude_usage_dashboard) answers and the",
  "last few hourly buckets are rising fast, run smaller batches. Ignore it if it errors.",
].join("\n");

// Pre-launch utilization warning block. Inserted into PACING/PACING_RELAY if
// utilization is already high before starting the batch.
function preLaunchWarning({ window, utilization, resetAt }) {
  const resetLabel = resetAt ? new Date(resetAt).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }) : "unknown";
  return [
    "",
    "⚠ PRE-LAUNCH WARNING — the account is already at high utilization before this batch",
    `starts. The ${window} window shows ${utilization}% usage, with reset around ${resetLabel}.`,
    "You may want to pause here and wait for the window to reset, or proceed at reduced",
    "concurrency (1–2 subagents max) to avoid hitting the hard limit. The relay will",
    "auto-pause if utilization hits the soft limit during the run, so either way you",
    "won't lose work — this is just a heads-up to size your batch accordingly.",
  ].join("\n");
}

// Seed prompt for the "Run @seq" orchestrator launch: one claude session that
// works a batch of backlog todos, fanning them out to subagents and pacing itself
// against the current Claude usage / burn rate.
// `mode` mirrors runnableTasks(): "seq" = the batch is the @seq-flagged todos,
// "all" = run-all fallback (nothing flagged), so the prompt must not say "@seq-flagged".
// `relay` = unattended headless run (PACING_RELAY instead of PACING).
// `prelaunchUtilization` = {window, utilization, resetAt} if already high before launch.
export function seedForSequentialRun({ slug, tasks, adhoc, mode = "seq", relay = false, prelaunchUtilization = null }) {
  if (slug === "ideas") return seedForIdeaPromotion({ tasks, relay, prelaunchUtilization });
  const seqMode = mode !== "all";
  const list = tasks
    .map((t, i) => {
      const head = `${i + 1}. ${t.title}`;
      return t.note ? `${head}\n   ${t.note.split("\n").join("\n   ")}` : head;
    })
    .join("\n");
  const out = [
    `You're the orchestrator for a batch of ${tasks.length} ${seqMode ? "@seq-flagged " : ""}todo(s) from the pm board backlog for "${slug}".`,
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
    `  .claude/backlog/${slug}.md${seqMode ? " and drop its @seq marker" : ""}. Leave a todo in place`,
    `  (${seqMode ? "un-flagged, " : ""}with a note) if it turns out blocked.`,
    "",
    relay ? PACING_RELAY : PACING,
    ...(prelaunchUtilization ? [preLaunchWarning(prelaunchUtilization)] : []),
    "",
    adhoc
      ? `When all todos are done or blocked, update .claude/backlog/${slug}.md and summarise what shipped, what was deferred, and why.`
      : `When all todos are done or blocked, update .claude/state/${slug}.md and .claude/backlog/${slug}.md, then summarise what shipped, what was deferred, and why.`,
  );
  return out.join("\n");
}

// Seed prompt for the Home "Latest todos" cross-project run: ONE orchestrator
// (cwd = workspace root) over a hand-picked set of todos spanning several projects.
// `ideas` never reaches here (filtered server-side; they have their own flow).
// `prelaunchUtilization` = {window, utilization, resetAt} if already high before launch.
export function seedForCrossProjectRun({ tasks, relay = false, prelaunchUtilization = null }) {
  const groups = new Map();
  for (const t of tasks) {
    if (!groups.has(t.slug)) groups.set(t.slug, []);
    groups.get(t.slug).push(t);
  }
  const list = [...groups]
    .map(([slug, ts]) => {
      const rows = ts.map((t, i) => {
        const head = `  ${i + 1}. ${t.title}`;
        return t.note ? `${head}\n     ${t.note.split("\n").join("\n     ")}` : head;
      });
      return `[${slug}]\n${rows.join("\n")}`;
    })
    .join("\n\n");
  const out = [
    `You're the orchestrator for a cross-project batch of ${tasks.length} todo(s) spanning ${groups.size} project(s), picked from the pm board's Home screen.`,
    "You're running from the workspace root; project dirs are <root>/<slug>/.",
    "",
    "TODOS (grouped by project):",
    list,
    "",
    "ORCHESTRATION:",
    "- Before touching a project, read its .claude/rules/<slug>.md and .claude/state/<slug>.md",
    "  (skip whichever doesn't exist - an ad-hoc project has no code dir yet).",
    "- Todos in DIFFERENT projects are disjoint: run them in parallel via subagents.",
    "  Todos in the SAME project run sequentially unless clearly disjoint (different",
    "  files/behaviour). Re-evaluate after every batch.",
    "- Spawn a subagent per todo (the Task tool, per .claude/rules and CLAUDE.md), scoped",
    "  to one todo and one project, working in <root>/<slug>/.",
    "- After a todo lands and its project's verify/tests pass, move it to Done in that",
    "  project's .claude/backlog/<slug>.md (match the bullet by its title; the todo's",
    "  position in the file may have shifted). Leave a todo in place, with a note, if it",
    "  turns out blocked.",
    "- When a project's todos are finished, update its .claude/state/<slug>.md.",
    "",
    relay ? PACING_RELAY : PACING,
    ...(prelaunchUtilization ? [preLaunchWarning(prelaunchUtilization)] : []),
    "",
    "When all todos are done or blocked, summarise per project what shipped, what was deferred, and why.",
  ];
  return out.join("\n");
}

// Seed prompt for "Run @seq" on the Ideas inbox: promote every @seq-flagged
// idea into a real pm project (research + scaffold), instead of orchestrating
// todos within one existing project.
function seedForIdeaPromotion({ tasks, relay = false, prelaunchUtilization = null }) {
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
    "2. TRIAGE — ordered, take the first branch that fits:",
    "   a. Genuine business/venture concept (a monetizable market play, not just",
    "      \"this could theoretically be a product\") -> invoke the `venturemind` skill",
    "      and run its normal workflow against the idea.",
    "   b. Otherwise it is a personal-use idea (a tool for the user, not a business).",
    "      Invoke the `prospector` skill FIRST - does this already exist, adopt or",
    "      build? Run it through its verdict and its Step 5 save",
    "      (knowledge/prospector/<slug>.md). Then branch on its verdict:",
    "      - \"Adopt\" (a suitable off-the-shelf tool exists) -> STOP for this idea.",
    "        Do NOT scaffold a project: no PM_ROOT/<slug>/, no CONTEXT.md, no",
    "        state/backlog files, no atelier. Instead add an indented note line",
    "        under the idea's bullet in .claude/backlog/ideas.md (match by title)",
    "        with the verdict, the tool name, and prospector's report path, e.g.",
    "        \"adopt <tool>, not built - see knowledge/prospector/<slug>.md\". Leave",
    "        the bullet in ideas.md and un-flag it (drop its @seq marker) so it",
    "        isn't re-run. Skip steps 3 and 4 below for this idea and report it in",
    "        your final summary as 'adopt, not built'.",
    "      - \"Build\" or \"Adopt + extend\" (nothing suitable exists, or a gap is left",
    "        to fill) -> continue into the `atelier` skill and run its FULL workflow,",
    "        including Step 6 (Build) below. Feed prospector's findings in as its",
    "        Step 0/1 input rather than re-searching.",
    "   This is a one-shot session with no follow-up turn - state assumptions and",
    "   proceed all the way through rather than stalling on an unanswerable question",
    "   (prospector and atelier both end turns with a question - answer it yourself).",
    "3. Create the project at PM_ROOT/<slug>/ (not for 'adopt' verdicts, see 2b):",
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
    "   promoted into its own project, don't leave a duplicate behind. (Not for",
    "   'adopt' verdicts - those bullets stay, per 2b.)",
    "",
    relay ? PACING_RELAY : PACING,
    ...(prelaunchUtilization ? [preLaunchWarning(prelaunchUtilization)] : []),
    "",
    "When every idea is promoted (or skipped/merged, with a note why), summarise the",
    "new project slugs created, which ideas were 'adopt, not built' (with the tool",
    "named), and what, if anything, was skipped or merged.",
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

// Unattended variant of launchClaude for batch runs: writes a job spec (prompt + the
// todos to track) under .claude/pm/relay/ and opens a terminal running relay-cli.mjs,
// which runs claude headless and auto-resumes it after every rate-limit reset.
// `caffeinate -is` keeps the Mac from idle-sleeping while the relay waits (macOS-only,
// like everything in this file). In the packaged app the script lives in app.asar,
// which plain `node` can't read — package.json `asarUnpack` ships a real copy.
const RELAY_CLI = fileURLToPath(new URL("./relay-cli.mjs", import.meta.url)).replace(
  /app\.asar([\\/])/,
  "app.asar.unpacked$1",
);

export function launchRelay({ cwd, prompt, label, tasks }) {
  const dir = cwd && existsSync(cwd) ? cwd : PM_ROOT;
  pruneRelay(PM_ROOT);
  mkdirSync(relayDir(PM_ROOT), { recursive: true });
  const id = `${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}-${randomBytes(3).toString("hex")}`;
  const specPath = specPathFor(PM_ROOT, id);
  writeJson(specPath, {
    id,
    label,
    root: PM_ROOT,
    cwd: dir,
    prompt,
    tasks: tasks.map((t) => ({ slug: t.slug, title: t.title })),
  });
  return launchCommand({
    cwd: PM_ROOT,
    inner: `PM_ROOT=${shq(PM_ROOT)} caffeinate -is node ${shq(RELAY_CLI)} ${shq(specPath)}`,
  }).then((r) => ({ ...r, relay: true, job: id }));
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
