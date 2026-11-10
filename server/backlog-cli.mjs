// Tiny CLI for headless (relay) agents. Claude Code hard-blocks Edit/Write on
// `.claude/**` in non-interactive mode (no allow rule, --add-dir or hook overrides
// it), so the relay allowlists ONLY `node <this file> *` and the agent updates the
// backlog/state through pm's own round-trip-safe parsers instead.
//   node backlog-cli.mjs move  <slug> <Todo|Doing|Blocked|Done> "<exact title>" ["note"]
//   node backlog-cli.mjs add   <slug> "<title>" ["note"]
//   node backlog-cli.mjs create <slug> "<descriptor>" "<summary>" "<plan path>" "<next1|next2|...>" "<todo>" ["<todo>"...]
//                                                        (NEW project's state+backlog; refuses if it exists; no delete)
//   node backlog-cli.mjs list  <slug> [state]            (read-only)
//   node backlog-cli.mjs state <slug> now "<headline>" ["detail" ...]
//   node backlog-cli.mjs state <slug> resume <last-result|re-run|branch|artifacts> "<value>"
//   node backlog-cli.mjs state <slug> next add "<item>" ["<item>" ...]   (append to Next; skips exact duplicates)
//   node backlog-cli.mjs state <slug> next remove "<exact item>"
//   node backlog-cli.mjs compact <slug> candidates          (read-only: Done items older than 7 days, JSON)
//   node backlog-cli.mjs compact <slug> apply <plan.json>   (merge them; originals go to the archive)
// Root = $PM_ROOT, else the current directory (server/paths.mjs).
import { readFile } from "node:fs/promises";
import { readBacklog, writeBacklog, emptyBacklog, STATES } from "./backlog.mjs";
import { readState, writeState } from "./state.mjs";
import { candidates, compactDone } from "./compact.mjs";
import { cleanDescriptor, writeRuleStub } from "./descriptor.mjs";

// CLI field name -> state.resume key
const RESUME_KEYS = { "last-result": "lastResult", "re-run": "rerun", branch: "branch", artifacts: "artifacts" };

const today = () => new Date().toISOString().slice(0, 10);
const SLUG = /^[a-z0-9][a-z0-9_-]*$/i;

export async function moveTask(slug, state, title, note) {
  if (!SLUG.test(slug)) throw new Error(`bad slug "${slug}"`);
  if (!STATES.includes(state)) throw new Error(`state must be one of ${STATES.join("|")}`);
  const b = await readBacklog(slug);
  if (!b) throw new Error(`no backlog for "${slug}"`);
  // exact match only: move never renames, and never creates a task
  const t = b.tasks.find((x) => x.title === title);
  if (!t) throw new Error(`no task with that exact title in ${slug}`);
  t.state = state;
  t.done = state === "Done" ? t.done || today() : null;
  if (note) t.note = note;
  await writeBacklog(slug, b);
  return `${slug}: "${t.title.slice(0, 60)}" -> ${state}`;
}

export async function addTask(slug, title, note) {
  if (!SLUG.test(slug)) throw new Error(`bad slug "${slug}"`);
  const b = await readBacklog(slug);
  if (!b) throw new Error(`no backlog for "${slug}"`);
  title = String(title).trim();
  if (!title || /[\r\n]/.test(title)) throw new Error("title must be one non-empty line");
  if (b.tasks.some((x) => x.title === title)) throw new Error(`duplicate title in ${slug}: "${title.slice(0, 60)}"`);
  b.tasks.unshift({ id: b.tasks.length, state: "Todo", title, note: note?.trim() || null, priority: null, done: null, seq: false });
  await writeBacklog(slug, b);
  return `${slug}: added "${title.slice(0, 60)}" to Todo`;
}

export async function listTasks(slug, state) {
  if (!SLUG.test(slug)) throw new Error(`bad slug "${slug}"`);
  if (state && !STATES.includes(state)) throw new Error(`state must be one of ${STATES.join("|")}`);
  const b = await readBacklog(slug);
  if (!b) throw new Error(`no backlog for "${slug}"`);
  return b.tasks.filter((t) => !state || t.state === state).map((t) => `${t.state}\t${t.title}`).join("\n");
}

export async function setNow(slug, headline, details = []) {
  if (!SLUG.test(slug)) throw new Error(`bad slug "${slug}"`);
  const s = await readState(slug);
  if (!s) throw new Error(`no state for "${slug}"`);
  s.now = [headline, ...details].join("\n");
  await writeState(slug, s);
  return `${slug}: state Now updated`;
}

export async function setResume(slug, field, value) {
  if (!SLUG.test(slug)) throw new Error(`bad slug "${slug}"`);
  const key = RESUME_KEYS[field];
  if (!key) throw new Error(`resume field must be one of ${Object.keys(RESUME_KEYS).join("|")}`);
  const s = await readState(slug);
  if (!s) throw new Error(`no state for "${slug}"`);
  s.resume = { ...s.resume, [key]: value };
  await writeState(slug, s);
  return `${slug}: resume ${field} updated`;
}

export async function editNext(slug, op, items) {
  if (!SLUG.test(slug)) throw new Error(`bad slug "${slug}"`);
  if (op !== "add" && op !== "remove") throw new Error("next op must be add|remove");
  items = items.map((i) => String(i).trim());
  if (!items.length || items.some((i) => !i || /[\r\n]/.test(i))) throw new Error("items must be non-empty single lines");
  if (op === "remove" && items.length !== 1) throw new Error("remove takes exactly one exact item");
  const s = await readState(slug);
  if (!s) throw new Error(`no state for "${slug}"`);
  const next = s.next || [];
  if (op === "add") {
    s.next = [...next, ...items.filter((i, k) => !next.includes(i) && items.indexOf(i) === k)];
  } else {
    if (!next.includes(items[0])) throw new Error(`no Next item with that exact text in ${slug}`);
    s.next = next.filter((n) => n !== items[0]);
  }
  await writeState(slug, s);
  return `${slug}: Next ${op} ok (${s.next.length} items)`;
}

// Promote an idea to a project: writes the NEW state + backlog files. Create-only by design:
// refuses if either file exists, and there is no delete/rename counterpart (that is the user's job).
export async function createProject(slug, descriptor, summary, plan, nexts, todos) {
  if (!SLUG.test(slug)) throw new Error(`bad slug "${slug}"`);
  if (await readBacklog(slug) || await readState(slug)) throw new Error(`project "${slug}" already exists`);
  const desc = cleanDescriptor(descriptor);
  if (![summary, plan, ...todos].every((s) => s && !/[\r\n]/.test(s))) throw new Error("summary, plan and todos must be non-empty single lines");
  await writeState(slug, {
    title: `${slug} — state`,
    now: `Researched, ready to build\n${summary}\nFull plan: ${plan}`,
    next: nexts,
    lastFailure: "none",
    blockers: "none",
    resume: {},
  });
  const b = emptyBacklog(slug);
  todos.forEach((t, i) => b.tasks.push({ id: i, state: "Todo", title: t, note: i === 0 ? `Plan: ${plan}. First step scaffolds ${slug}/ with a README run/test section.` : null, priority: null, done: null, seq: false }));
  await writeBacklog(slug, b);
  await writeRuleStub(slug, desc);
  return `${slug}: created state + backlog + rules heading (${todos.length} todos)`;
}

export async function compactCmd(slug, op, planPath) {
  if (!SLUG.test(slug)) throw new Error(`bad slug "${slug}"`);
  const b = await readBacklog(slug);
  if (!b) throw new Error(`no backlog for "${slug}"`);
  if (op === "candidates") return JSON.stringify(candidates(b), null, 2);
  if (op !== "apply" || !planPath) throw new Error("compact op must be candidates | apply <plan.json>");
  const plan = JSON.parse(await readFile(planPath, "utf8"));
  const next = compactDone(b, plan);
  const done = (x) => x.tasks.filter((t) => t.state === "Done").length;
  await writeBacklog(slug, next);
  return `${slug}: Done ${done(b)} -> ${done(next)} items, ${plan.reduce((n, g) => n + g.from.length, 0)} originals archived`;
}

export async function main(argv) {
  const [cmd, slug, ...rest] = argv;
  if (cmd === "create" && rest.length >= 5) {
    const nexts = rest[3].split("|").map((s) => s.trim()).filter(Boolean);
    return createProject(slug, rest[0], rest[1], rest[2], nexts, rest.slice(4));
  }
  if (cmd === "move" && rest.length >= 2) return moveTask(slug, rest[0], rest[1], rest[2]);
  if (cmd === "add" && (rest.length === 1 || rest.length === 2)) return addTask(slug, rest[0], rest[1]);
  if (cmd === "list" && rest.length <= 1) return listTasks(slug, rest[0]);
  if (cmd === "state" && rest[0] === "now" && rest.length >= 2) return setNow(slug, rest[1], rest.slice(2));
  if (cmd === "state" && rest[0] === "next" && rest.length >= 3) return editNext(slug, rest[1], rest.slice(2));
  if (cmd === "state" && rest[0] === "resume" && rest.length === 3) return setResume(slug, rest[1], rest[2]);
  if (cmd === "compact" && (rest.length === 1 || rest.length === 2)) return compactCmd(slug, rest[0], rest[1]);
  throw new Error(
    'usage: create <slug> "<descriptor, max 40 chars>" "<summary>" "<plan path>" "<next1|next2>" "<todo>"... | list <slug> [state] | move <slug> <Todo|Doing|Blocked|Done> "<exact title>" ["note"] | add <slug> "<title>" ["note"] | state <slug> now "<headline>" ["detail"...] | state <slug> next <add|remove> "<item>"... | state <slug> resume <last-result|re-run|branch|artifacts> "<value>" | compact <slug> candidates | compact <slug> apply <plan.json>',
  );
}

if (process.argv[1]?.endsWith("backlog-cli.mjs")) {
  main(process.argv.slice(2)).then(
    (m) => console.log(m),
    (e) => {
      console.error(`backlog-cli: ${e.message}`);
      process.exit(1);
    },
  );
}
