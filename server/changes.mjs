// Git changes across the workspace's repos: list edits, per-hunk keep (stage) / discard, commit, push.
// Plain git via argv (never a shell); no Claude involved. Every repo is one found under PM_ROOT, and every
// file/hunk must be in the live `git status` / `git diff` right now, so a client can't aim git at an arbitrary
// path. Discards are reversible: the discarded patch is saved under .claude/pm/discarded/ first.
import { spawn } from "node:child_process";
import { readdir, stat, lstat, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";
import { PM_ROOT, PM_DIR } from "./paths.mjs";

const DISCARD_DIR = join(PM_DIR, "discarded");
const KEEP_BACKUPS = 50;
const MAX_FILES = 500;
const MAX_UNTRACKED_BYTES = 256 * 1024;
const MAX_MESSAGE = 5000;
const MAX_OUT = 4e6;

const STARTER_IGNORE = ["node_modules/", ".venv/", "venv/", "__pycache__/", "*.pyc", "dist/", ".DS_Store", ".env", ".env.*", "!.env.example", ""].join("\n");

export class ChangeError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function git(dir, args, { input, readOnly = false, timeout = 30000, net = false } = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" };
    if (readOnly) env.GIT_OPTIONAL_LOCKS = "0";
    if (net && !env.GIT_SSH_COMMAND) env.GIT_SSH_COMMAND = "ssh -o BatchMode=yes"; // never wait on a passphrase/host-key prompt
    const p = spawn("git", ["-C", dir, "-c", "core.quotepath=off", "-c", "color.ui=never", ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    let over = false;
    const timer = setTimeout(() => p.kill("SIGKILL"), timeout);
    p.stdout.on("data", (d) => {
      out += d;
      if (out.length > MAX_OUT) {
        over = true;
        p.kill("SIGKILL");
      }
    });
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) => (clearTimeout(timer), reject(new ChangeError(500, "git not runnable: " + e.message))));
    p.on("close", (code) => {
      clearTimeout(timer);
      if (over) return reject(new ChangeError(413, "git output too large"));
      resolve({ code, out, err: err.trim() });
    });
    p.stdin.on("error", () => {});
    p.stdin.end(input ?? "");
  });
}

async function gitOk(dir, args, opts) {
  const r = await git(dir, args, opts);
  if (r.code !== 0) throw new ChangeError(409, r.err || `git ${args[0]} failed`);
  return r.out;
}

// --- repos ---

export async function findRepos() {
  const out = [];
  const isRepo = async (d) => stat(join(d, ".git")).then(() => true, () => false);
  if (await isRepo(PM_ROOT)) out.push({ slug: "(workspace)", dir: PM_ROOT });
  for (const e of await readdir(PM_ROOT, { withFileTypes: true }).catch(() => [])) {
    if (!e.isDirectory() || e.name.startsWith(".") || e.name === "node_modules") continue;
    const dir = join(PM_ROOT, e.name);
    if (await isRepo(dir)) out.push({ slug: e.name, dir });
  }
  return out;
}

// Top-level workspace dirs that are not git repos yet (candidates for `git init`).
async function findPlainDirs() {
  const out = [];
  for (const e of await readdir(PM_ROOT, { withFileTypes: true }).catch(() => [])) {
    if (!e.isDirectory() || e.name.startsWith(".") || e.name === "node_modules") continue;
    const dir = join(PM_ROOT, e.name);
    if (!(await stat(join(dir, ".git")).then(() => true, () => false))) out.push({ slug: e.name, dir });
  }
  return out;
}

export async function initRepo(slug) {
  const d = (await findPlainDirs()).find((x) => x.slug === slug);
  if (!d) throw new ChangeError(404, "not a folder without a git repo");
  await gitOk(d.dir, ["init", "-q"]);
  // starter ignore list so node_modules / venvs don't flood the first status; never overwrites an existing file
  const created = await writeFile(join(d.dir, ".gitignore"), STARTER_IGNORE, { flag: "wx" }).then(() => true, () => false);
  return { ok: true, gitignore: created };
}

async function repoOf(slug) {
  const r = (await findRepos()).find((x) => x.slug === slug);
  if (!r) throw new ChangeError(404, "unknown repo");
  return r;
}

// `git status --porcelain=v2 --branch -z` -> {branch, upstream, ahead, behind, files[]}
export function parseStatus(text) {
  const res = { branch: "", upstream: "", ahead: 0, behind: 0, files: [] };
  const recs = String(text).split("\0");
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i];
    if (!r) continue;
    if (r.startsWith("# branch.head ")) res.branch = r.slice(14);
    else if (r.startsWith("# branch.upstream ")) res.upstream = r.slice(18);
    else if (r.startsWith("# branch.ab ")) {
      const m = /\+(\d+) -(\d+)/.exec(r);
      if (m) [res.ahead, res.behind] = [Number(m[1]), Number(m[2])];
    } else if (r[0] === "1") {
      const f = r.split(" ");
      res.files.push({ path: f.slice(8).join(" "), x: f[1][0], y: f[1][1] });
    } else if (r[0] === "2") {
      const f = r.split(" ");
      res.files.push({ path: f.slice(9).join(" "), orig: recs[++i], x: f[1][0], y: f[1][1] });
    } else if (r[0] === "u") {
      const f = r.split(" ");
      res.files.push({ path: f.slice(10).join(" "), x: f[1][0], y: f[1][1], conflict: true });
    } else if (r[0] === "?") res.files.push({ path: r.slice(2), x: ".", y: "?", untracked: true });
  }
  return res;
}

async function statusOf(dir) {
  const out = await gitOk(dir, ["status", "--porcelain=v2", "--branch", "-z", "-uall"], { readOnly: true });
  const s = parseStatus(out);
  const truncated = s.files.length > MAX_FILES;
  s.files = s.files.slice(0, MAX_FILES);
  return { ...s, truncated };
}

// Split into the two VS Code groups: staged (index vs HEAD) and changes (worktree vs index, incl. untracked).
function groups(files) {
  const staged = [];
  const changes = [];
  for (const f of files) {
    if (f.conflict) {
      changes.push({ path: f.path, status: "U", conflict: true });
      continue;
    }
    if (f.x !== "." && f.x !== "?") staged.push({ path: f.path, orig: f.orig, status: f.x });
    if (f.y === "?") changes.push({ path: f.path, status: "?", untracked: true });
    else if (f.y !== ".") changes.push({ path: f.path, status: f.y });
  }
  return { staged, changes };
}

export async function listRepos() {
  const repos = await findRepos();
  const rows = await Promise.all(
    repos.map(async ({ slug, dir }) => {
      try {
        const s = await statusOf(dir);
        const g = groups(s.files);
        return { slug, branch: s.branch, upstream: s.upstream, ahead: s.ahead, behind: s.behind, staged: g.staged.length, changes: g.changes.length };
      } catch (e) {
        return { slug, error: e.message, staged: 0, changes: 0 };
      }
    }),
  );
  const plain = (await findPlainDirs()).map((d) => ({ slug: d.slug, git: false, staged: 0, changes: 0 }));
  return [...rows, ...plain].sort((a, b) => a.slug.localeCompare(b.slug));
}

export async function repoStatus(slug) {
  const { dir } = await repoOf(slug);
  const s = await statusOf(dir);
  return { slug, branch: s.branch, upstream: s.upstream, ahead: s.ahead, behind: s.behind, truncated: s.truncated, ...groups(s.files) };
}

// --- diff ---

export function parseDiff(text) {
  const lines = String(text).split("\n");
  const header = [];
  const hunks = [];
  let cur = null;
  let binary = false;
  for (const line of lines) {
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (m) {
      cur = { header: line, oldStart: +m[1], oldLines: m[2] === undefined ? 1 : +m[2], newStart: +m[3], newLines: m[4] === undefined ? 1 : +m[4], lines: [] };
      hunks.push(cur);
    } else if (!cur) {
      if (/^Binary files .* differ$|^GIT binary patch/.test(line)) binary = true;
      if (line) header.push(line);
    } else if (/^[ +\-\\]/.test(line)) cur.lines.push({ t: line[0], s: line.slice(1) });
  }
  return { header, hunks, binary };
}

function hunkPatch(d, h) {
  const body = h.lines.map((l) => l.t + l.s).join("\n");
  return d.header.join("\n") + "\n" + h.header + "\n" + body + "\n";
}

async function inStatus(dir, path, side) {
  if (typeof path !== "string" || !path || path.includes("\0")) throw new ChangeError(400, "bad path");
  const g = groups((await statusOf(dir)).files);
  const f = g[side === "staged" ? "staged" : "changes"].find((x) => x.path === path);
  if (!f) throw new ChangeError(404, "file has no such change (refresh)");
  return f;
}

function safeJoin(dir, path) {
  const p = join(dir, path);
  const rel = relative(dir, p);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new ChangeError(400, "path escapes repo");
  return p;
}

async function untrackedDiff(dir, path) {
  const p = safeJoin(dir, path);
  const st = await lstat(p).catch(() => null);
  const header = [`diff --git a/${path} b/${path}`, "new file mode 100644", "--- /dev/null", `+++ b/${path}`];
  if (!st || !st.isFile()) return { header, hunks: [], binary: false, note: "not a regular file", untracked: true };
  if (st.size > MAX_UNTRACKED_BYTES) return { header, hunks: [], binary: false, note: "new file too large to preview", untracked: true };
  const buf = await readFile(p);
  if (buf.includes(0)) return { header, hunks: [], binary: true, untracked: true };
  const text = buf.toString("utf8");
  const ls = text.split("\n");
  const noEol = ls[ls.length - 1] !== "";
  if (!noEol) ls.pop();
  const lines = ls.map((s) => ({ t: "+", s }));
  if (noEol && ls.length) lines.push({ t: "\\", s: " No newline at end of file" });
  const hunks = ls.length ? [{ header: `@@ -0,0 +1,${ls.length} @@`, oldStart: 0, oldLines: 0, newStart: 1, newLines: ls.length, lines }] : [];
  return { header, hunks, binary: false, untracked: true };
}

async function diffOf(dir, f, side) {
  if (f.untracked) return untrackedDiff(dir, f.path);
  const args = ["diff", "--no-color", "--no-ext-diff", "-U3", ...(side === "staged" ? ["--cached", "-M"] : []), "--", f.path, ...(f.orig ? [f.orig] : [])];
  const d = parseDiff(await gitOk(dir, args, { readOnly: true }));
  return d;
}

export async function fileDiff(slug, path, side) {
  const { dir } = await repoOf(slug);
  const f = await inStatus(dir, path, side);
  const d = await diffOf(dir, f, side);
  return { path, side, status: f.status, orig: f.orig, ...d };
}

// --- actions ---

async function backup(slug, name, patch) {
  await mkdir(DISCARD_DIR, { recursive: true });
  const file = join(DISCARD_DIR, `${new Date().toISOString().replace(/[:.]/g, "-")}-${slug}-${name.replace(/[^\w.-]+/g, "_")}.patch`);
  await writeFile(file, patch, { mode: 0o600 });
  const old = (await readdir(DISCARD_DIR)).filter((n) => n.endsWith(".patch")).sort();
  for (const n of old.slice(0, Math.max(0, old.length - KEEP_BACKUPS))) await rm(join(DISCARD_DIR, n), { force: true });
  return file;
}

async function applyPatch(dir, patch, flags) {
  const r = await git(dir, ["apply", "--whitespace=nowarn", ...flags, "-"], { input: patch });
  if (r.code !== 0) throw new ChangeError(409, r.err || "patch no longer applies (refresh)");
}

// action: keep (stage) | unkeep (unstage) | discard. hunk: {index, header} or omitted for the whole file.
export async function applyChange(slug, { path, side, action, hunk } = {}) {
  const { dir } = await repoOf(slug);
  if (!["keep", "unkeep", "discard"].includes(action)) throw new ChangeError(400, "bad action");
  if ((action === "unkeep") !== (side === "staged")) throw new ChangeError(400, "action does not fit that side");
  const f = await inStatus(dir, path, side);
  const paths = [f.path, ...(f.orig ? [f.orig] : [])];

  if (!hunk) {
    if (action === "keep") await gitOk(dir, ["add", "-A", "--", ...paths]);
    else if (action === "unkeep") await gitOk(dir, ["reset", "-q", "--", ...paths]);
    else if (f.untracked) {
      const d = await untrackedDiff(dir, f.path);
      const file = await backup(slug, f.path, d.hunks.map((h) => hunkPatch(d, h)).join("") || d.header.join("\n") + "\n");
      await rm(safeJoin(dir, f.path), { force: true });
      return { ok: true, backup: relative(PM_ROOT, file) };
    } else {
      const d = await gitOk(dir, ["diff", "--no-color", "--no-ext-diff", "--binary", "--", ...paths], { readOnly: true });
      const file = await backup(slug, f.path, d);
      await gitOk(dir, ["restore", "--", ...paths]);
      return { ok: true, backup: relative(PM_ROOT, file) };
    }
    return { ok: true };
  }

  if (f.untracked) throw new ChangeError(400, "an untracked file is kept or discarded whole");
  const d = await diffOf(dir, f, side);
  const i = Number(hunk.index);
  const h = Number.isInteger(i) ? d.hunks[i] : null;
  if (!h || h.header !== hunk.header) throw new ChangeError(409, "that hunk changed (refresh)");
  const patch = hunkPatch(d, h);
  if (action === "keep") await applyPatch(dir, patch, ["--cached"]);
  else if (action === "unkeep") await applyPatch(dir, patch, ["--cached", "-R"]);
  else {
    const file = await backup(slug, f.path, patch);
    await applyPatch(dir, patch, ["-R"]);
    return { ok: true, backup: relative(PM_ROOT, file) };
  }
  return { ok: true };
}

// tracked: keep only changes to files git already knows (modified/deleted), skipping untracked ones
export async function stageAll(slug, on, tracked = false) {
  const { dir } = await repoOf(slug);
  if (on) await gitOk(dir, tracked ? ["add", "-u"] : ["add", "-A"]);
  else await gitOk(dir, ["reset", "-q"]);
  return { ok: true };
}

// amend: with no message, fold the staged files into the last commit unchanged (`--amend --no-edit`)
export async function commit(slug, message, amend = false) {
  const { dir } = await repoOf(slug);
  const msg = typeof message === "string" ? message.trim() : "";
  if (msg.length > MAX_MESSAGE) throw new ChangeError(400, "commit message too long");
  if (!msg && !amend) throw new ChangeError(400, "commit message is empty");
  if (!groups((await statusOf(dir)).files).staged.length) throw new ChangeError(409, "nothing staged");
  if (!msg) {
    if ((await git(dir, ["rev-parse", "-q", "--verify", "HEAD"], { readOnly: true })).code !== 0) throw new ChangeError(409, "no commit to amend yet");
    await gitOk(dir, ["commit", "-q", "--amend", "--no-edit"], { timeout: 120000 });
  } else await gitOk(dir, ["commit", "-q", "-F", "-"], { input: msg + "\n", timeout: 120000 });
  const hash = (await gitOk(dir, ["rev-parse", "--short", "HEAD"], { readOnly: true })).trim();
  return { ok: true, hash, amended: !msg };
}

export async function push(slug) {
  const { dir } = await repoOf(slug);
  const s = await statusOf(dir);
  if (!s.branch || s.branch === "(detached)") throw new ChangeError(409, "detached HEAD: nothing to push");
  let args = ["push"];
  if (!s.upstream) {
    const remotes = (await gitOk(dir, ["remote"], { readOnly: true })).split("\n").filter(Boolean);
    if (remotes.length !== 1) throw new ChangeError(409, remotes.length ? "no upstream and several remotes: push from a terminal" : "no remote configured");
    args = ["push", "-u", remotes[0], "HEAD"];
  }
  const r = await git(dir, args, { timeout: 120000, net: true });
  if (r.code !== 0) throw new ChangeError(409, r.err || "push failed");
  return { ok: true, output: r.err };
}

// Update remote-tracking refs only; never touches the working tree.
export async function fetchRepo(slug) {
  const { dir } = await repoOf(slug);
  const r = await git(dir, ["fetch", "--quiet"], { timeout: 60000, net: true });
  if (r.code !== 0) throw new ChangeError(409, r.err || "fetch failed");
  const s = await statusOf(dir);
  return { ok: true, behind: s.behind, ahead: s.ahead };
}

// Fast-forward only: if the branches diverged or local edits are in the way, git refuses and nothing changes.
export async function pullRepo(slug) {
  const { dir } = await repoOf(slug);
  const s = await statusOf(dir);
  if (!s.upstream) throw new ChangeError(409, "no upstream branch to pull from");
  const r = await git(dir, ["pull", "--ff-only", "--quiet"], { timeout: 120000, net: true });
  if (r.code !== 0) throw new ChangeError(409, "Pull aborted, nothing changed: " + (r.err || "cannot fast-forward"));
  return { ok: true };
}
