// Unattended "relay": run ONE orchestrator prompt headless (`claude -p`, stream-json)
// and, when the account rate limit stops it, sleep until the window resets and resume
// the SAME session so the subagents that were cut off carry on. Started by
// `relay-cli.mjs` in a visible terminal; pm never supervises it — the job file under
// `.claude/pm/relay/<id>.job.json` is just the status the UI reads.
//
// Signals (all from claude's own stream, no polling of usage files):
//   rate_limit_event.rate_limit_info = { status, resetsAt, rateLimitType,
//     unifiedWindows: { five_hour|seven_day: { utilization 0..1, resetsAt } } }
//   status "rejected" => hard stop with a real reset time. Utilization above the
//   soft threshold => stop the child ourselves and wait, rather than hit the wall
//   mid tool-call.
import { spawn, execFile } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseBacklog } from "./backlog.mjs";

export const relayDir = (root) => join(root, ".claude", "pm", "relay");

// Claude Code hard-blocks Edit/Write on `.claude/**` in headless mode, so the agent
// gets exactly one allowlisted command for backlog/state changes. Packaged app:
// plain `node` can't read app.asar, hence the unpacked path (see package.json asarUnpack).
export const BACKLOG_CLI = fileURLToPath(new URL("./backlog-cli.mjs", import.meta.url)).replace(
  /app\.asar([\\/])/,
  "app.asar.unpacked$1",
);

export function relayConfig(env = process.env) {
  const n = (k, d) => (env[k] !== undefined && env[k] !== "" ? Number(env[k]) : d);
  return {
    claudeBin: env.CLAUDE_BIN || "claude",
    stop5h: n("PM_RELAY_STOP_5H", 0.95), // utilization fraction at which we stop and wait
    stop7d: n("PM_RELAY_STOP_7D", 0.97),
    bufferMs: n("PM_RELAY_BUFFER_MS", 90_000), // slack after the reset moment
    tickMs: n("PM_RELAY_TICK_MS", 30_000), // sleep granularity (survives Mac sleep/wake)
    unknownResetMs: n("PM_RELAY_UNKNOWN_RESET_MS", 15 * 60_000), // limit hit, no reset time known
    maxLimitHits: n("PM_RELAY_MAX_LIMIT_HITS", 30), // consecutive, with no progress
    maxErrors: n("PM_RELAY_MAX_ERRORS", 3),
    maxNudges: n("PM_RELAY_MAX_NUDGES", 3),
    killGraceMs: n("PM_RELAY_KILL_GRACE_MS", 15_000),
    notify: env.PM_RELAY_NOTIFY !== "0",
  };
}

// ---------- pure logic (unit-tested) --------------------------------------

export const emptyRun = () => ({ sessionId: null, windows: {}, rejected: null, result: null });

const frac = (u) => (typeof u !== "number" ? 0 : u > 1 ? u / 100 : u);

// Fold one parsed stream-json event into the run state.
export function foldEvent(st, ev) {
  if (!ev || typeof ev !== "object") return st;
  if (ev.session_id) st.sessionId = ev.session_id;
  if (ev.type === "rate_limit_event" && ev.rate_limit_info) {
    const info = ev.rate_limit_info;
    for (const [k, w] of Object.entries(info.unifiedWindows || {}))
      st.windows[k] = { utilization: frac(w.utilization), resetsAt: w.resetsAt };
    if (info.status === "rejected")
      st.rejected = { type: info.rateLimitType || "five_hour", resetsAt: info.resetsAt };
  } else if (ev.type === "result") {
    st.result = { isError: !!ev.is_error, text: String(ev.result ?? ""), subtype: ev.subtype || "" };
  }
  return st;
}

// Utilization already past our soft threshold while the window is still open?
export function softStop(st, cfg, now = Date.now()) {
  const checks = [
    ["five_hour", cfg.stop5h],
    ["seven_day", cfg.stop7d],
  ];
  for (const [type, limit] of checks) {
    const w = st.windows[type];
    if (w && w.utilization >= limit && w.resetsAt * 1000 > now) return { type, resetsAtMs: w.resetsAt * 1000 };
  }
  return null;
}

const LIMIT_TEXT = /(hit your|reached your|usage|rate)[^.]{0,30}limit|limit reached|rate_limit/i;

// Did this run end because of the rate limit? -> { type, resetsAtMs|null } | null
export function limitHit(st) {
  if (st.rejected) return { type: st.rejected.type, resetsAtMs: st.rejected.resetsAt ? st.rejected.resetsAt * 1000 : null };
  if (st.result?.isError && LIMIT_TEXT.test(st.result.text)) {
    const w = st.windows.five_hour;
    return { type: "five_hour", resetsAtMs: w?.resetsAt ? w.resetsAt * 1000 : null };
  }
  return null;
}

// What to do after a child exits. `open`/`prevOpen` = open-task counts after/before
// this run; `c` = mutable counters { limitHits, errors, nudges }.
//   -> { kind: "done" | "stalled" | "fail" | "wait" | "nudge", until?, why }
export function decide({ st, softStopped, open, prevOpen, now, cfg, c }) {
  if (open === 0) return { kind: "done", why: "all todos resolved" };
  const progress = open < prevOpen;
  if (progress) {
    c.limitHits = 0;
    c.errors = 0;
  }
  const limit = softStopped || limitHit(st);
  if (limit) {
    c.limitHits += 1;
    if (c.limitHits > cfg.maxLimitHits) return { kind: "fail", why: `rate-limited ${c.limitHits}x with no progress` };
    const at = limit.resetsAtMs && limit.resetsAtMs > now ? limit.resetsAtMs : now + cfg.unknownResetMs;
    return { kind: "wait", until: at + cfg.bufferMs, why: `${limit.type} limit`, type: limit.type, known: !!limit.resetsAtMs };
  }
  if (st.result && !st.result.isError) {
    if (progress && c.nudges < cfg.maxNudges) {
      c.nudges += 1;
      return { kind: "nudge", why: `${open} todo(s) still open after a clean exit` };
    }
    return { kind: "stalled", why: `${open} todo(s) still open; the agent stopped without finishing them` };
  }
  c.errors += 1;
  if (c.errors > cfg.maxErrors) return { kind: "fail", why: st.result?.text?.slice(0, 200) || "claude exited without a result" };
  return { kind: "wait", until: now + 60_000 * c.errors, why: "claude error, retrying", type: "error", known: true };
}

// Todos from the job spec that are still Todo/Doing in the CURRENT backlog files.
// Matched by title (ids are positional). A title that vanished counts as resolved.
export function openTasks(root, tasks) {
  const cache = new Map();
  const out = [];
  for (const t of tasks) {
    if (!cache.has(t.slug)) {
      try {
        cache.set(t.slug, parseBacklog(readFileSync(join(root, ".claude", "backlog", `${t.slug}.md`), "utf8"), t.slug));
      } catch {
        cache.set(t.slug, null);
      }
    }
    const bl = cache.get(t.slug);
    if (bl?.tasks.some((x) => x.title === t.title && (x.state === "Todo" || x.state === "Doing"))) out.push(t);
  }
  return out;
}

const fmtTime = (ms) =>
  new Date(ms).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false });

const openList = (open) => open.map((t) => `- [${t.slug}] ${t.title}`).join("\n");

export function continuePrompt({ reason, open, limitType, at }) {
  if (reason === "limit")
    return [
      `The account rate limit${limitType ? ` (${limitType.replace("_", "-")} window)` : ""} interrupted this session${at ? ` around ${fmtTime(at)}` : ""}; it has now reset. Resume the batch where you stopped.`,
      "",
      "Subagents you had running were probably cut off mid-task. Re-check each todo from the original brief against its .claude/backlog/<slug>.md (match by title): Done stays done. For each still-open todo, look at what is already on disk from the interrupted attempt and CONTINUE from there — do not redo finished work or start over. Same pacing rules as before; if the limit hits again you will be resumed again automatically, so keep working and do not try to sleep, wait or reschedule yourself.",
      "",
      "Still open:",
      openList(open),
    ].join("\n");
  if (reason === "error")
    return ["The previous attempt ended with an error. Continue the batch where it stopped.", "", "Still open:", openList(open)].join("\n");
  return [
    "You stopped but these todos are still open:",
    openList(open),
    "",
    "Continue with them. If one is genuinely blocked, move it to Blocked in its .claude/backlog/<slug>.md with a one-line note saying why, and move on. Do not stop while a todo is still open and workable.",
  ].join("\n");
}

// ---------- job file -------------------------------------------------------

export function writeJson(path, obj) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2));
  renameSync(tmp, path);
}

// Jobs newest-first; a "running"/"waiting" job whose pid is gone is reported "dead".
export function listRelayJobs(root, { limit = 10 } = {}) {
  const dir = relayDir(root);
  let files = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".job.json"));
  } catch {
    return [];
  }
  const jobs = [];
  for (const f of files) {
    try {
      const j = JSON.parse(readFileSync(join(dir, f), "utf8"));
      if ((j.status === "running" || j.status === "waiting") && !pidAlive(j.pid)) j.status = "dead";
      jobs.push(j);
    } catch {}
  }
  jobs.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  return jobs.slice(0, limit);
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

// Drop spec/job files older than `days` (called on each new launch).
export function pruneRelay(root, days = 14) {
  const dir = relayDir(root);
  try {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (Date.now() - statSync(p).mtimeMs > days * 86400e3) unlinkSync(p);
    }
  } catch {}
}

// Dismiss a finished job from the Home strip (delete its job/spec files). Refuses a
// still-live job (running/waiting with a live pid) — stop it first.
export function dismissRelay(root, id) {
  const dir = relayDir(root);
  const jobPath = join(dir, `${id}.job.json`);
  let job;
  try {
    job = JSON.parse(readFileSync(jobPath, "utf8"));
  } catch {
    return false;
  }
  if ((job.status === "running" || job.status === "waiting") && pidAlive(job.pid)) return false;
  try {
    unlinkSync(jobPath);
  } catch {}
  try {
    unlinkSync(specPathFor(root, id));
  } catch {}
  return true;
}

// ---------- the loop -------------------------------------------------------

function alert(cfg, title, message) {
  process.stdout.write("\x07");
  if (!cfg.notify || process.platform !== "darwin") return;
  const esc = (s) => String(s).replace(/["\\]/g, "\\$&");
  execFile("osascript", ["-e", `display notification "${esc(message)}" with title "${esc(title)}"`], () => {});
}

const say = (msg) => console.log(`[relay ${new Date().toLocaleTimeString([], { hour12: false })}] ${msg}`);

// One child run. Resolves { st, softStopped } once claude has exited.
function runChild({ cfg, spec, prompt, resumeId, onEvent, onChild, note }) {
  const args = [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--permission-mode", "acceptEdits",
    "--disallowed-tools", "Bash(git *)",
    "--allowed-tools", `Bash(node ${BACKLOG_CLI} *)`,
  ];
  if (spec.modelArg) args.push("--model", spec.modelArg);
  if (resumeId) args.push("--resume", resumeId);
  const child = spawn(cfg.claudeBin, args, {
    cwd: spec.cwd,
    env: { ...process.env, PM_ROOT: spec.root, ...(spec.modelEnv || {}) },
    stdio: ["pipe", "pipe", "inherit"],
  });
  child.stdin.end(prompt);

  const st = emptyRun();
  let softStopped = null;
  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  rl.on("line", (line) => {
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      return;
    }
    foldEvent(st, ev);
    onEvent?.(ev, st);
    if (!softStopped) {
      const s = softStop(st, cfg);
      if (s) {
        softStopped = s;
        note(`${s.type} utilization ${Math.round(st.windows[s.type].utilization * 100)}% — stopping until it resets`);
        child.kill("SIGINT");
        setTimeout(() => child.kill("SIGKILL"), cfg.killGraceMs).unref();
      }
    }
  });
  onChild?.(child);
  return new Promise((resolve) => {
    child.on("error", (e) => {
      st.result = { isError: true, text: `spawn failed: ${e.message}`, subtype: "spawn" };
    });
    child.on("close", () => resolve({ st, softStopped }));
  });
}

// One-line terminal echo of what the agent is doing.
function echo(ev) {
  if (ev.type !== "assistant") return;
  const tag = ev.parent_tool_use_id ? "  ↳ " : "";
  for (const b of ev.message?.content || []) {
    if (b.type === "text" && b.text.trim()) say(`${tag}${b.text.trim().replace(/\s+/g, " ").slice(0, 160)}`);
    else if (b.type === "tool_use") say(`${tag}· ${b.name}`);
  }
}

async function sleepUntil(ms, cfg, beat, halted) {
  while (Date.now() < ms && !halted()) {
    beat();
    await new Promise((r) => setTimeout(r, Math.min(cfg.tickMs, Math.max(1, ms - Date.now()))));
  }
}

// Drive a job to completion. Returns the final job record.
export async function runRelay(specPath, env = process.env) {
  const cfg = relayConfig(env);
  const spec = JSON.parse(readFileSync(specPath, "utf8"));
  const dir = relayDir(spec.root);
  mkdirSync(dir, { recursive: true });
  const jobPath = join(dir, `${spec.id}.job.json`);
  const job = {
    id: spec.id,
    label: spec.label,
    cwd: spec.cwd,
    tasks: spec.tasks,
    status: "running",
    pid: process.pid,
    startedAt: Date.now(),
    sessionId: null,
    attempt: 0,
    open: spec.tasks.length,
    resumeAt: null,
    waitReason: null,
    events: [],
  };
  const save = () => {
    job.updatedAt = Date.now();
    writeJson(jobPath, job);
  };
  const log = (msg) => {
    say(msg);
    job.events = [...job.events.slice(-19), { at: Date.now(), msg }];
  };
  const finish = (status, msg) => {
    job.status = status;
    job.resumeAt = null;
    job.waitReason = null;
    log(msg);
    save();
    alert(cfg, `pm relay — ${status}`, `${spec.label}: ${msg}`);
    return job;
  };

  const c = { limitHits: 0, errors: 0, nudges: 0 };
  let prompt = spec.prompt;
  let resumeId = null;
  let open = openTasks(spec.root, spec.tasks);
  log(`started: ${spec.tasks.length} todo(s) — ${spec.label}`);
  save();
  // Ctrl-C / kill ends the whole relay (the terminal also SIGINTs the child directly);
  // it must never fall through to "resume".
  let stopping = false;
  let current = null;
  const onSignal = () => {
    stopping = true;
    current?.kill("SIGINT");
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  const stopped = () => finish("stopped", "stopped by user");

  for (;;) {
    if (stopping) return stopped();
    job.attempt += 1;
    job.status = "running";
    job.resumeAt = null;
    job.waitReason = null;
    job.open = open.length;
    save();
    log(job.attempt === 1 ? "run 1: launching" : `run ${job.attempt}: resuming session ${resumeId ? resumeId.slice(0, 8) : "(new)"}`);
    const prevOpen = open.length;
    const { st, softStopped } = await runChild({
      cfg,
      spec,
      prompt,
      resumeId,
      onEvent: echo,
      onChild: (ch) => (current = ch),
      note: log,
    });
    current = null;
    if (stopping) return stopped();
    if (st.sessionId) {
      resumeId = st.sessionId;
      job.sessionId = st.sessionId;
    }
    open = openTasks(spec.root, spec.tasks);
    job.open = open.length;
    const d = decide({ st, softStopped, open: open.length, prevOpen, now: Date.now(), cfg, c });

    if (d.kind === "done") return finish("done", d.why);
    if (d.kind === "stalled") return finish("stalled", d.why);
    if (d.kind === "fail") return finish("failed", d.why);

    if (d.kind === "wait") {
      job.status = "waiting";
      job.resumeAt = d.until;
      job.waitReason = d.why;
      log(`${d.why} — ${open.length} todo(s) open, resuming ${fmtTime(d.until)}${d.known ? "" : " (reset time unknown, probing)"}`);
      save();
      alert(cfg, "pm relay — waiting", `${spec.label}: ${d.why}. Resuming ${fmtTime(d.until)}.`);
      await sleepUntil(d.until, cfg, save, () => stopping);
      if (stopping) return stopped();
      alert(cfg, "pm relay — resuming", `${spec.label}: ${open.length} todo(s) left.`);
      prompt = continuePrompt({ reason: d.type === "error" ? "error" : "limit", open, limitType: d.type, at: Date.now() });
    } else {
      prompt = continuePrompt({ reason: "nudge", open });
    }
    if (!resumeId) prompt = spec.prompt; // died before a session existed: start over
  }
}

export const specPathFor = (root, id) => join(relayDir(root), `${id}.spec.json`);
