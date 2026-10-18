// Harvester: derives the two generated sidecars the board reads, from disk, no LLM.
//   pm/sessions.json  Claude Code transcripts of this workspace -> sessions inbox
//   pm/activity.json  git commits per project dir + handoff notes + sessions -> timeline / last activity
// Run in-process by server/index.mjs on boot and every 10 min (or `node server/harvest.mjs`).
import { readdir, readFile, writeFile, rename, stat } from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { PM_ROOT, PM_DIR, SESSIONS_FILE, ACTIVITY_FILE, HANDOFFS_DIR } from "./paths.mjs";
import { discoverSlugs } from "./projects.mjs";
import { entryPaths, entryDir } from "./entries.mjs";

const run = promisify(execFile);
const DAYS = Number(process.env.PM_HARVEST_DAYS) || 30;
const escapePath = (p) => p.replace(/[^a-zA-Z0-9]/g, "-");
const projectsRoot = () => process.env.CLAUDE_PROJECTS_ROOT || join(homedir(), ".claude", "projects");

// ---- attribution (pure) ----------------------------------------------------

// Which project a touched path belongs to: first path segment under `root` (or the
// first segment of a relative path) if it is a known slug; ".claude" for workspace
// bookkeeping; null otherwise.
export function pathToSlug(p, slugs, root) {
  let rel = String(p || "");
  if (rel.startsWith("/")) {
    if (!root || !rel.startsWith(root.replace(/\/$/, "") + "/")) return null;
    rel = rel.slice(root.replace(/\/$/, "").length + 1);
  }
  const seg = rel.split("/")[0];
  return slugs.has(seg) || seg === ".claude" ? seg : null;
}

// Best-guess project for a session: cwd inside an entry's path (benchmark/tool) > cwd inside
// a project dir > most-touched project > a slug named in the title > null.
export function guessProject({ cwd, hits, title, slugs, entries = {} }) {
  const c = String(cwd || "");
  const byEntry = Object.entries(entries).find(([, p]) => c === p || c.startsWith(p + "/"));
  if (byEntry) return byEntry[0];
  const segs = String(cwd || "").split("/").reverse();
  const byCwd = segs.find((s) => slugs.has(s));
  if (byCwd) return byCwd;
  let best = null;
  for (const [slug, n] of hits || []) {
    if (slug !== ".claude" && slugs.has(slug) && (!best || n > best[1])) best = [slug, n];
  }
  if (best) return best[0];
  const words = String(title || "").toLowerCase().split(/[^a-z0-9_-]+/);
  return words.find((w) => slugs.has(w)) ?? null;
}

// ---- sessions --------------------------------------------------------------

const textOf = (content) =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.filter((b) => b?.type === "text").map((b) => b.text).join(" ")
      : "";

async function parseSession(file, id, slugs) {
  let title = "", firstAsk = "", cwd = "", start = null, end = null, msgs = 0;
  const hits = new Map();
  const rl = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of rl) {
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.type === "ai-title" && o.aiTitle) title = o.aiTitle;
    if (o.timestamp) {
      start ??= o.timestamp;
      end = o.timestamp;
    }
    if (!cwd && o.cwd) cwd = o.cwd;
    if (o.type === "user" || o.type === "assistant") msgs++;
    if (o.type === "user" && !firstAsk) {
      const t = textOf(o.message?.content).trim();
      if (t && !t.startsWith("<")) firstAsk = t.replace(/\s+/g, " ").slice(0, 200);
    }
    if (o.type === "assistant" && Array.isArray(o.message?.content))
      for (const b of o.message.content) {
        const p = b?.type === "tool_use" && (b.input?.file_path || b.input?.path);
        const slug = p && pathToSlug(p, slugs, PM_ROOT);
        if (slug) hits.set(slug, (hits.get(slug) || 0) + 1);
      }
  }
  if (!firstAsk || !start) return null;
  title ||= firstAsk.slice(0, 80);
  const mins = Math.max(1, Math.round((Date.parse(end) - Date.parse(start)) / 60000));
  return {
    id, title, firstAsk, start, end, mins, msgs, cwd,
    touched: [...hits.keys()].filter((k) => k !== ".claude"),
    guess: guessProject({ cwd, hits, title, slugs, entries: entryPaths() }),
  };
}

const cache = new Map(); // file -> { sig, session } — re-parse only changed transcripts

async function harvestSessions(slugs) {
  const root = projectsRoot();
  const prefix = escapePath(PM_ROOT);
  const cutoff = Date.now() - DAYS * 86400e3;
  let dirs = [];
  try {
    dirs = (await readdir(root)).filter((d) => d.startsWith(prefix));
  } catch {}
  const out = [];
  for (const d of dirs) {
    let files = [];
    try {
      files = (await readdir(join(root, d))).filter((f) => f.endsWith(".jsonl"));
    } catch {}
    for (const f of files) {
      const file = join(root, d, f);
      const st = await stat(file);
      if (st.mtimeMs < cutoff) continue;
      const sig = `${st.mtimeMs}:${st.size}`;
      let hit = cache.get(file);
      if (!hit || hit.sig !== sig) {
        hit = { sig, session: await parseSession(file, basename(f, ".jsonl"), slugs) };
        cache.set(file, hit);
      }
      if (hit.session) out.push(hit.session);
    }
  }
  return out.sort((a, b) => String(b.start).localeCompare(String(a.start)));
}

// ---- activity --------------------------------------------------------------

async function gitCommits(slug) {
  const dir = entryDir(slug);
  if (!existsSync(join(dir, ".git"))) return [];
  try {
    const { stdout } = await run("git", ["-C", dir, "log", `--since=${DAYS} days ago`, "-n", "30", "--pretty=%h%x09%cI%x09%s"], { timeout: 5000 });
    return stdout.split("\n").filter(Boolean).map((l) => {
      const [ref, date, ...s] = l.split("\t");
      return { project: slug, date, kind: "commit", summary: s.join("\t"), ref };
    });
  } catch {
    return [];
  }
}

// Handoff notes: .claude/handoffs/<slug>-*.md and <slug>/handoff/*.md (the `handoff` skill's path).
async function handoffs(slugs) {
  const found = [];
  const scan = async (dir, project) => {
    let names = [];
    try {
      names = (await readdir(dir)).filter((f) => f.endsWith(".md"));
    } catch {}
    for (const f of names) {
      const file = join(dir, f);
      const head = (await readFile(file, "utf8")).split("\n").find((l) => l.trim()) || f;
      found.push({
        project: project ?? f.slice(0, -3),
        date: (await stat(file)).mtime.toISOString(),
        kind: "handoff",
        summary: head.replace(/^#+\s*/, "").slice(0, 120),
        ref: file,
      });
    }
  };
  await scan(HANDOFFS_DIR, null);
  for (const slug of slugs) await scan(join(PM_ROOT, slug, "handoff"), slug);
  return found;
}

// ---- entry -----------------------------------------------------------------

async function writeJson(path, data) {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2) + "\n");
  await rename(tmp, path); // atomic: readers never see a half-written file
}

export async function harvest() {
  const slugs = new Set((await discoverSlugs()).all);
  const [sessions, commits, notes] = await Promise.all([
    harvestSessions(slugs),
    Promise.all([...slugs].map(gitCommits)).then((a) => a.flat()),
    handoffs(slugs),
  ]);
  // sessions count as activity too: in this workspace they are the main signal of "last touched"
  const worked = sessions
    .filter((s) => s.guess)
    .map((s) => ({ project: s.guess, date: s.end || s.start, kind: "session", summary: s.title, ref: s.id }));
  const activity = [...commits, ...notes, ...worked].sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, 500);
  await writeJson(SESSIONS_FILE, sessions);
  await writeJson(ACTIVITY_FILE, activity);
  return { sessions: sessions.length, activity: activity.length };
}

if (process.argv[1]?.endsWith("harvest.mjs")) {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(PM_DIR, { recursive: true });
  console.log(await harvest());
}
