#!/usr/bin/env node
// Claude Code hook (UserPromptSubmit + PostToolUse): when the 5h/7d usage window is nearly
// full, tell the session ONCE to write a handoff. Reads the statusline's rate-limits.json.
// Self-contained, no network, no shell; any error exits 0 silently.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

try {
  const env = process.env;
  let input = {};
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    process.exit(0);
  }
  const sid = String(input.session_id || "").replace(/[^\w-]/g, "").slice(0, 80);
  if (!sid) process.exit(0);
  const event = input.hook_event_name === "PostToolUse" ? "PostToolUse" : "UserPromptSubmit";
  const file = env.PM_RATE_LIMITS_FILE || join(env.HOME || homedir(), ".claude", "rate-limits.json");
  if (!existsSync(file)) process.exit(0);
  const rl = JSON.parse(readFileSync(file, "utf8"))?.rate_limits;
  if (!rl) process.exit(0);
  const now = Date.now();
  const num = (k, d) => (env[k] !== undefined && env[k] !== "" && Number.isFinite(Number(env[k])) ? Number(env[k]) : d);
  // thresholds are fractions (0.9) like the relay's; values >1 are read as percent
  const frac = (v) => (v > 1 ? v / 100 : v);
  const wins = [
    ["5h", rl.five_hour, frac(num("PM_RELAY_HANDOFF_5H", 0.9))],
    ["7d", rl.seven_day, frac(num("PM_RELAY_HANDOFF_7D", 0.95))],
  ];
  for (const [name, w, limit] of wins) {
    if (!w || typeof w.used_percentage !== "number") continue;
    const resetsAt = typeof w.resets_at === "number" ? w.resets_at : 0;
    if (resetsAt && resetsAt * 1000 <= now) continue; // window already rolled over: stale
    if (w.used_percentage / 100 < limit) continue;
    const state = join(env.PM_HOOK_STATE_DIR || tmpdir(), `pm-limit-handoff-${sid}-${name}-${resetsAt}`);
    if (existsSync(state)) continue;
    writeFileSync(state, String(now));
    const pct = Math.round(w.used_percentage);
    const msg = `Usage limit near (${name} ${pct}%). Finish the current step, then run the \`handoff\` skill (or write a handoff to .claude/handoffs/<topic>.md if no skill), and tell the user: after the reset, \`/clear\` then paste the starter — do not resume this session (cold cache).`;
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: msg } }));
    break;
  }
} catch {}
process.exit(0);
