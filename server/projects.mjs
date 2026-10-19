import { readdir, readFile, stat, realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import { PM_ROOT, RULES_DIR, STATE_DIR, HANDOFFS_DIR } from "./paths.mjs";
import { kindOf, entryDir, readEntries } from "./entries.mjs";
import { readState } from "./state.mjs";
import { readBacklog, listBacklogSlugs } from "./backlog.mjs";
import { readActivity, lastTouched, matchesProject } from "./activity.mjs";
import { sessionsFor } from "./sessions.mjs";


async function mdSlugs(dir) {
  try {
    return (await readdir(dir))
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.slice(0, -3))
      .filter((s) => !s.startsWith("_")); // _-prefixed = _TEMPLATE / cross-project rules, not projects
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
}

export async function discoverSlugs() {
  const [rules, state, backlog] = await Promise.all([
    mdSlugs(RULES_DIR),
    mdSlugs(STATE_DIR),
    listBacklogSlugs(),
  ]);
  // A project = a state or backlog file. rules/*.md alone does not make one: in a shared
  // workspace those are path-scoped guidance docs (evaluation.md, notebooks.md, …).
  return { all: [...new Set([...state, ...backlog])].sort(), rules };
}

// PM_ROOT/<slug>/start.sh exists as a regular file whose real path stays inside the project dir.
export async function startScript(slug) {
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(slug || "")) return null;
  try {
    const dir = await realpath(entryDir(slug));
    const f = await realpath(join(dir, "start.sh"));
    if (!f.startsWith(dir + sep)) return null;
    return (await stat(f)).isFile() ? f : null;
  } catch {
    return null;
  }
}

async function hasDir(slug) {
  try {
    return (await stat(entryDir(slug))).isDirectory();
  } catch {
    return false;
  }
}

async function ruleTitle(slug) {
  try {
    const m = (await readFile(join(RULES_DIR, `${slug}.md`), "utf8")).match(
      /^#\s+(.+?)\s*$/m,
    );
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

// First prose paragraph after the H1 (skips frontmatter, headings, code fences, bare
// `bullet` lists). Pure so it can be tested; capped so a huge paragraph can't bloat the list.
export function extractDescription(md, max = 180) {
  const lines = String(md || "").replace(/^---\n[\s\S]*?\n---\n/, "").split("\n");
  let seenH1 = false;
  let para = [];
  let fence = false;
  for (const raw of lines) {
    const l = raw.trim();
    if (l.startsWith("```")) {
      fence = !fence;
      if (para.length) break;
      continue;
    }
    if (fence) continue;
    if (/^#\s/.test(l) && !seenH1) {
      seenH1 = true;
      continue;
    }
    if (/^#{1,6}\s/.test(l) || /^(\||-{3,}|>|<)/.test(l)) {
      if (para.length) break;
      continue;
    }
    if (!l) {
      if (para.length) break;
      continue;
    }
    para.push(l);
  }
  return clean(para.join(" "), max);
}

const SLUG_RE = /^[a-z0-9][a-z0-9._-]*$/i;

const clean = (t, max) => {
  const text = t.replace(/\*\*|__|`/g, "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/\s+/g, " ").trim();
  const first = text.length > max && text.slice(0, max).match(/^(.{30,}[.!?])(\s|$)/)?.[1];
  const out = first || text;
  return out.length > max ? `${out.slice(0, max - 1).trimEnd()}…` : out;
};

async function description(slug) {
  const read = async (p) => {
    try {
      return await readFile(p, "utf8");
    } catch {
      return "";
    }
  };
  return SLUG_RE.test(slug) ? extractDescription(await read(join(PM_ROOT, slug, "README.md"))) : "";
}

async function newestHandoff(slug) {
  try {
    const hits = (await readdir(HANDOFFS_DIR))
      .filter((f) => f.startsWith(`${slug}-`) && f.endsWith(".md"))
      .sort()
      .reverse();
    return hits[0] ? `.claude/handoffs/${hits[0]}` : null;
  } catch {
    return null;
  }
}

// kind: "project" (default; every slug without an entry), "tool", or "all".
export async function listProjects(kind = "project") {
  const { all: every, rules } = await discoverSlugs();
  const all = kind === "all" ? every : every.filter((s) => kindOf(s) === kind);
  const activity = await readActivity();
  const rulesSet = new Set(rules);
  return Promise.all(
    all.map(async (slug) => {
      const [st, bl, adhocDir] = await Promise.all([
        readState(slug),
        readBacklog(slug),
        hasDir(slug),
      ]);
      const open = bl ? bl.tasks.filter((t) => t.state !== "Done").length : 0;
      const blocked = bl
        ? bl.tasks.some((t) => t.state === "Blocked")
        : st && st.blockers && st.blockers !== "none";
      return {
        slug,
        title: (await ruleTitle(slug)) || slug,
        kind: kindOf(slug),
        description: await description(slug),
        adhoc: slug !== "ideas" && !rulesSet.has(slug) && !adhocDir,
        pinned: slug === "ideas",
        status: st ? st.now : "",
        next: st && st.next.length ? st.next[0] : "",
        lastResult: st ? st.resume.lastResult : "",
        updated: st ? st.updated : "",
        blockers: st ? st.blockers : "none",
        openCount: open,
        blocked: Boolean(blocked),
        lastActivity: lastTouched(activity, slug),
        hasStart: Boolean(await startScript(slug)),
      };
    }),
  );
}

export async function getProject(slug) {
  const { all } = await discoverSlugs();
  if (!all.includes(slug)) return null;
  const [st, bl, activity, handoff, sessions] = await Promise.all([
    readState(slug),
    readBacklog(slug),
    readActivity(),
    newestHandoff(slug),
    sessionsFor(slug),
  ]);
  return {
    slug,
    title: (await ruleTitle(slug)) || slug,
    kind: kindOf(slug),
    path: readEntries()[slug]?.path || null,
    description: await description(slug),
    adhoc: slug !== "ideas" && !(await hasDir(slug)) && !(await ruleTitle(slug)),
    pinned: slug === "ideas",
    state: st,
    backlog: bl,
    activity: activity
      .filter((a) => matchesProject(a, slug))
      .sort((a, b) => String(b.date).localeCompare(String(a.date))),
    handoff,
    sessions,
  };
}
