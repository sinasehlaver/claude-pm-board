import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { RULES_DIR, STATE_DIR, HANDOFFS_DIR } from "./paths.mjs";
import { kindOf, entryDir, readEntries } from "./entries.mjs";
import { readState } from "./state.mjs";
import { readBacklog, listBacklogSlugs } from "./backlog.mjs";
import { readActivity, lastTouched, matchesProject } from "./activity.mjs";
import { sessionsFor } from "./sessions.mjs";

const IGNORE = new Set(["_TEMPLATE"]);

async function mdSlugs(dir) {
  try {
    return (await readdir(dir))
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.slice(0, -3))
      .filter((s) => !IGNORE.has(s));
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

// kind: "project" (default; every slug without an entry), "benchmark", "tool", or "all".
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
