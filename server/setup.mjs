// Launch setup: which `claude` binary pm launches, plus environment checks that catch
// the failure modes we've hit (a Rosetta shell looking for the wrong native package).
// Prefs live in .claude/pm/prefs.json (user-owned, written only via PUT /api/setup).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, realpathSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { PM_DIR } from "./paths.mjs";

const PREFS = () => join(PM_DIR, "prefs.json");
const TERMINAL = "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal";

const run = (cmd, args) => {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
};

// Apple Silicon hardware, true even when this process itself runs under Rosetta.
export const APPLE_SILICON = process.platform === "darwin" && run("sysctl", ["-n", "hw.optional.arm64"]) === "1";
// Prefix for every launched claude/node: forces native arm64 even from a Rosetta shell.
export const ARCH = APPLE_SILICON ? "arch -arm64 " : "";

export function readPrefs() {
  try {
    return JSON.parse(readFileSync(PREFS(), "utf8"));
  } catch {
    return {};
  }
}

// The binary launches use: the saved pick if it still exists, else `claude` from PATH.
export function claudeBin() {
  const b = readPrefs().claudeBin;
  return b && existsSync(b) ? b : "claude";
}

const archsOf = (f) => run("lipo", ["-archs", f]).split(/\s+/).filter(Boolean);

// Fixed install locations only (native installer, Homebrew, every nvm Node) — never a
// user-supplied path, so PUT /api/setup can only pick one of these.
export function findClaudes(home = homedir()) {
  const c = [join(home, ".local/bin/claude"), join(home, ".claude/local/claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude"];
  const nvm = join(home, ".nvm/versions/node");
  if (existsSync(nvm)) for (const v of readdirSync(nvm)) c.push(join(nvm, v, "bin/claude"));
  const seen = new Set();
  const out = [];
  for (const path of c) {
    if (!existsSync(path)) continue;
    const real = realpathSync(path);
    if (seen.has(real) || !statSync(real).isFile()) continue;
    seen.add(real);
    const archs = archsOf(real);
    // npm installs: bin/claude.exe is only native once the matching platform package is present
    const pkg = real.match(/^(.*\/@anthropic-ai)\/claude-code\/bin\/claude\.exe$/);
    const missing = pkg && APPLE_SILICON && !existsSync(join(pkg[1], "claude-code/node_modules/@anthropic-ai/claude-code-darwin-arm64"))
      && !existsSync(join(pkg[1], "claude-code-darwin-arm64"));
    const version = run(real, ["--version"]).split(/\s/)[0] || null;
    out.push({ path, real, archs, version, ok: !!version && (!APPLE_SILICON || archs.some((a) => a.startsWith("arm64"))) && !missing, missing: !!missing });
  }
  return out;
}

export function checks(claudes = findClaudes()) {
  const out = [];
  const add = (id, ok, title, detail, fix) => out.push({ id, ok, title, detail, ...(ok ? {} : { fix }) });
  if (process.platform !== "darwin") {
    add("mac", false, "macOS", process.platform, "pm opens sessions in Terminal.app, so launching needs macOS.");
    return out;
  }
  const translated = run("sysctl", ["-n", "sysctl.proc_translated"]) === "1";
  add("cpu", true, "Hardware", APPLE_SILICON ? "Apple Silicon (arm64): launches use `arch -arm64`" : "Intel (x86_64)");
  add("rosetta", !translated, "pm runs natively", `node ${process.arch}${translated ? " under Rosetta" : ""}`,
    "pm itself runs under Rosetta. Start it from a native shell (check `uname -m` says arm64), or reinstall an arm64 Node.");
  const tArchs = archsOf(TERMINAL);
  add("terminal", existsSync(TERMINAL) && (!APPLE_SILICON || tArchs.some((a) => a.startsWith("arm64"))), "Terminal.app",
    tArchs.join(" ") || "not found", "Terminal.app is missing or Intel-only. Sessions open there.");
  const prefs = readPrefs();
  const picked = claudes.find((c) => c.path === prefs.claudeBin);
  const using = picked || claudes[0];
  add("claude", !!using?.ok, "Claude Code binary",
    using ? `${using.path}${using.version ? ` · v${using.version}` : ""} · ${using.archs.join(" ") || "?"}${picked ? "" : " (PATH default)"}` : "none found",
    !using ? "Install Claude Code: `curl -fsSL https://claude.ai/install.sh | bash`."
      : using.missing ? "The arm64 platform package is missing (npm installed it from a Rosetta shell). From a native shell, run `npm i -g @anthropic-ai/claude-code`."
      : "This binary doesn't run natively here. Pick another one below, or reinstall from a native shell.");
  return out;
}

export function setupStatus() {
  const claudes = findClaudes();
  const prefs = readPrefs();
  return { firstRun: !existsSync(PREFS()), prefs, claudes, checks: checks(claudes), appleSilicon: APPLE_SILICON };
}

export const MODELS = ["default", "opus", "sonnet", "haiku"];

// `--model` alias for launches; null = no flag (claude's own default).
export function modelArg() {
  const m = readPrefs().model;
  return MODELS.includes(m) && m !== "default" ? m : null;
}

// Merges into the saved prefs: a key left out is kept. claudeBin only accepts a path
// findClaudes() returned (or null = PATH default); model only a MODELS entry.
export function savePrefs(patch = {}) {
  const cur = readPrefs();
  const next = { claudeBin: cur.claudeBin ?? null, model: MODELS.includes(cur.model) ? cur.model : "default" };
  if ("claudeBin" in patch) {
    const b = patch.claudeBin;
    if (b !== null && !findClaudes().some((c) => c.path === b)) {
      const e = new Error("unknown claude binary");
      e.status = 400;
      throw e;
    }
    next.claudeBin = b;
  }
  if ("model" in patch) {
    if (!MODELS.includes(patch.model)) {
      const e = new Error("unknown model");
      e.status = 400;
      throw e;
    }
    next.model = patch.model;
  }
  mkdirSync(dirname(PREFS()), { recursive: true });
  writeFileSync(PREFS(), JSON.stringify(next, null, 2) + "\n");
  return setupStatus();
}
