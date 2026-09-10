// Bridge to the `continuous/` runner: render its runtime files + a few controls.
// Reuses the runner's own pure modules in-process (dynamic import so pm still
// boots if continuous/ is absent, and CONTINUOUS_ROOT env is honoured).
import { readFile, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { CONTINUOUS_ROOT, CONTINUOUS_DIR } from "./paths.mjs";
import { launchCommand } from "./launch.mjs";

const CONFIG = join(CONTINUOUS_ROOT, "config.json");
const RUNNER = join(CONTINUOUS_ROOT, "runner.mjs");
const STATE = join(CONTINUOUS_DIR, "state.json");
const LOG = join(CONTINUOUS_DIR, "log.jsonl");
const LOCK = join(CONTINUOUS_DIR, "runner.lock");
const PLANS = join(CONTINUOUS_DIR, "plans");

// only these may be set from the UI
const CONFIG_KEYS = new Set([
  "cap_5h", "cap_7d", "safety", "active_hours_per_day", "min_action_tokens",
  "max_gear", "default_gear", "human_at_keyboard", "pool",
]);

const mod = (rel) => import(pathToFileURL(join(CONTINUOUS_ROOT, rel)).href);

async function readJson(p, fallback) {
  try {
    return JSON.parse(await readFile(p, "utf8"));
  } catch {
    return fallback;
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

async function runnerStatus() {
  const lock = await readJson(LOCK, null);
  if (!lock?.pid) return { alive: false };
  return {
    alive: pidAlive(lock.pid),
    pid: lock.pid,
    since: lock.at ? new Date(lock.at).toISOString() : null,
    stale: Date.now() - (lock.at || 0) > 15 * 60_000,
  };
}

let cache = { at: 0, val: null };

export async function readStatus() {
  if (cache.val && Date.now() - cache.at < 15_000) return cache.val;

  const config = await readJson(CONFIG, null);
  const state = await readJson(STATE, {});
  const runner = await runnerStatus();

  let decision = null;
  let usage = null;
  let caps = null;
  if (config) {
    try {
      const [{ usageSnapshot }, { liveOverride, logThrottleUntil }, { decideTick }] =
        await Promise.all([mod("src/usage.mjs"), mod("src/limits.mjs"), mod("src/pace.mjs")]);
      const eff = { ...config };
      if (state.learned_caps?.cap_5h) eff.cap_5h = Math.min(eff.cap_5h, state.learned_caps.cap_5h);
      if (state.learned_caps?.cap_7d) eff.cap_7d = Math.min(eff.cap_7d, state.learned_caps.cap_7d);

      const [snap, live, throttleUntil] = await Promise.all([
        usageSnapshot(),
        liveOverride(),
        logThrottleUntil(),
      ]);
      const d = decideTick({
        snapshot: snap,
        cfg: eff,
        estNextTokens: eff.min_action_tokens,
        hardSleepUntil: Math.max(live.hardSleepUntil, throttleUntil),
      });
      decision = {
        do: d.do,
        sleepMs: d.sleepMs ?? null,
        reason: d.reason,
        pace: Math.round(d.pace),
        ratio: +(d.ratio ?? 0).toFixed(2),
      };
      usage = { used_5h: snap.used_5h, used_7d: snap.used_7d, spent_1h: snap.spent_1h };
      caps = {
        cap_5h: eff.cap_5h,
        cap_7d: eff.cap_7d,
        config_5h: config.cap_5h,
        config_7d: config.cap_7d,
        learned: state.learned_caps || {},
      };
    } catch (e) {
      decision = { error: String(e.message || e) };
    }
  }

  cache = { at: Date.now(), val: { runner, state, config, decision, usage, caps } };
  return cache.val;
}

export async function readLog(n = 100) {
  let txt;
  try {
    txt = await readFile(LOG, "utf8");
  } catch {
    return [];
  }
  return txt
    .split("\n")
    .filter(Boolean)
    .slice(-n)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .reverse();
}

export async function readQueue() {
  const config = await readJson(CONFIG, null);
  if (!config) return [];
  const { eligibleTasks } = await mod("src/tasks.mjs");
  const tasks = await eligibleTasks(config);
  let planFiles = [];
  try {
    planFiles = await readdir(PLANS);
  } catch {
    /* no plans dir yet */
  }
  const slugify = (s) =>
    s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
  return tasks.map((t) => {
    const f = `${t.slug}--${slugify(t.title)}.json`;
    return {
      slug: t.slug,
      title: t.title,
      priority: t.priority,
      auto: t.auto,
      plan: planFiles.includes(f) ? f : null,
    };
  });
}

export async function writeConfig(patch) {
  const config = await readJson(CONFIG, null);
  if (!config) throw new Error("no continuous config");
  for (const [k, v] of Object.entries(patch || {})) {
    if (CONFIG_KEYS.has(k)) config[k] = v;
  }
  await writeFile(CONFIG, JSON.stringify(config, null, 2) + "\n");
  cache.at = 0;
  return config;
}

export async function clearFailure() {
  const state = await readJson(STATE, null);
  if (!state) return;
  state.last_failure = null;
  await writeFile(STATE, JSON.stringify(state, null, 2));
  cache.at = 0;
}

export async function runnerControl(action) {
  if (action === "tick") {
    if (!existsSync(RUNNER)) throw new Error("no runner.mjs");
    spawn("node", [RUNNER, "--once"], {
      cwd: CONTINUOUS_ROOT,
      detached: true,
      stdio: "ignore",
    }).unref();
    return { ok: true, action };
  }
  if (action === "start") {
    return { ok: true, action, ...(await launchCommand({ cwd: CONTINUOUS_ROOT, inner: "npm start" })) };
  }
  if (action === "stop") {
    const lock = await readJson(LOCK, null);
    if (lock?.pid && pidAlive(lock.pid)) {
      try {
        process.kill(lock.pid, "SIGTERM");
      } catch {
        /* already gone */
      }
      return { ok: true, action, pid: lock.pid };
    }
    return { ok: false, action, error: "runner not running" };
  }
  throw new Error(`bad action: ${action}`);
}
