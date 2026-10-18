// Listening-port viewer + "stop the process" backend. Read via `lsof` (argv, no shell). A kill is only
// accepted for a (pid, port) pair that is in the live listing right now, owned by the current user,
// and is not this server or its parent — so a client can't aim SIGTERM at an arbitrary pid.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { relative, isAbsolute, sep } from "node:path";
import { PM_ROOT } from "./paths.mjs";

const run = promisify(execFile);

class PortError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// lsof -F output: one field per line, "p<pid>" starts a process, "n<addr>" one listener of it.
export function parseLsof(text) {
  const out = [];
  let cur = null;
  for (const line of String(text).split("\n")) {
    const k = line[0];
    const v = line.slice(1);
    if (k === "p") cur = { pid: Number(v), command: "", user: "" };
    else if (!cur) continue;
    else if (k === "c") cur.command = v;
    else if (k === "L" || k === "u") cur.user = cur.user || v;
    else if (k === "n") {
      const m = /^(.*):(\d+)$/.exec(v);
      if (m) out.push({ ...cur, address: m[1], port: Number(m[2]) });
    }
  }
  const seen = new Set();
  return out
    .filter((r) => {
      const key = r.pid + ":" + r.port;
      return !seen.has(key) && seen.add(key);
    })
    .sort((a, b) => a.port - b.port || a.pid - b.pid);
}

async function lsofListen() {
  try {
    const { stdout } = await run("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-FpcLn"], { maxBuffer: 4e6 });
    return stdout;
  } catch (e) {
    if (e.stdout) return e.stdout; // lsof exits 1 when it skipped unreadable processes
    if (e.code === 1) return "";
    throw e;
  }
}

// -F output for `-d cwd`: "p<pid>" then "n<path>". -> Map pid -> cwd
export function parseCwds(text) {
  const m = new Map();
  let pid = 0;
  for (const line of String(text).split("\n")) {
    if (line[0] === "p") pid = Number(line.slice(1));
    else if (line[0] === "n" && pid) m.set(pid, line.slice(1));
  }
  return m;
}

async function lsofCwds(pids) {
  if (!pids.length) return "";
  try {
    return (await run("lsof", ["-nP", "-a", "-d", "cwd", "-Fpn", "-p", pids.join(",")], { maxBuffer: 4e6 })).stdout;
  } catch (e) {
    return e.stdout || "";
  }
}

// First folder under PM_ROOT = the project slug; null when the cwd is outside the workspace.
export function projectOf(cwd, root = PM_ROOT) {
  if (!cwd) return null;
  const rel = relative(root, cwd);
  if (!rel || rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) return null;
  const slug = rel.split(sep)[0];
  return slug.startsWith(".") ? null : slug;
}

export async function listPorts({ lister = lsofListen, cwdLister = lsofCwds, root = PM_ROOT } = {}) {
  const rows = parseLsof(await lister());
  const cwds = parseCwds(await cwdLister([...new Set(rows.map((r) => r.pid))]));
  const mine = process.env.USER;
  return rows.map((r) => ({
    ...r,
    cwd: cwds.get(r.pid) || "",
    project: projectOf(cwds.get(r.pid), root),
    self: r.pid === process.pid || r.pid === process.ppid,
    killable: r.pid !== process.pid && r.pid !== process.ppid && r.pid > 1 && (!mine || r.user === mine),
  }));
}

export async function killPort(pid, port, { lister, kill = process.kill.bind(process) } = {}) {
  if (!Number.isInteger(pid) || !Number.isInteger(port) || pid <= 1 || port < 1 || port > 65535) throw new PortError(400, "bad pid/port");
  const hit = (await listPorts({ lister })).find((r) => r.pid === pid && r.port === port);
  if (!hit) throw new PortError(404, "that process no longer listens on that port");
  if (!hit.killable) throw new PortError(403, hit.self ? "refusing to stop the board itself" : "not your process");
  if (process.env.PM_LAUNCH_DRYRUN) return { pid, port, dryRun: true };
  kill(pid, "SIGTERM");
  return { pid, port, command: hit.command };
}
