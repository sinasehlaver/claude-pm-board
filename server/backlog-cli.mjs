// Tiny CLI for headless (relay) agents. Claude Code hard-blocks Edit/Write on
// `.claude/**` in non-interactive mode (no allow rule, --add-dir or hook overrides
// it), so the relay allowlists ONLY `node <this file> *` and the agent updates the
// backlog/state through pm's own round-trip-safe parsers instead.
//   node backlog-cli.mjs move  <slug> <Todo|Doing|Blocked|Done> "<exact title>" ["note"]
//   node backlog-cli.mjs add   <slug> "<title>"
//   node backlog-cli.mjs state <slug> now "<headline>" ["detail" ...]
// Root = $PM_ROOT, else the current directory (server/paths.mjs).
import { readBacklog, writeBacklog, STATES } from "./backlog.mjs";
import { readState, writeState } from "./state.mjs";

const today = () => new Date().toISOString().slice(0, 10);
const SLUG = /^[a-z0-9][a-z0-9_-]*$/i;

export async function moveTask(slug, state, title, note) {
  if (!SLUG.test(slug)) throw new Error(`bad slug "${slug}"`);
  if (!STATES.includes(state)) throw new Error(`state must be one of ${STATES.join("|")}`);
  const b = await readBacklog(slug);
  if (!b) throw new Error(`no backlog for "${slug}"`);
  const t = b.tasks.find((x) => x.title === title.trim());
  if (!t) throw new Error(`no task with that exact title in ${slug}`);
  t.state = state;
  t.done = state === "Done" ? t.done || today() : null;
  if (note) t.note = note;
  await writeBacklog(slug, b);
  return `${slug}: "${t.title.slice(0, 60)}" -> ${state}`;
}

export async function addTask(slug, title) {
  if (!SLUG.test(slug)) throw new Error(`bad slug "${slug}"`);
  const b = await readBacklog(slug);
  if (!b) throw new Error(`no backlog for "${slug}"`);
  b.tasks.push({ id: b.tasks.length, state: "Todo", title: title.trim(), note: null, priority: null, done: null, seq: false });
  await writeBacklog(slug, b);
  return `${slug}: added "${title.trim().slice(0, 60)}" to Todo`;
}

export async function setNow(slug, headline, details = []) {
  if (!SLUG.test(slug)) throw new Error(`bad slug "${slug}"`);
  const s = await readState(slug);
  if (!s) throw new Error(`no state for "${slug}"`);
  s.now = [headline, ...details].join("\n");
  await writeState(slug, s);
  return `${slug}: state Now updated`;
}

export async function main(argv) {
  const [cmd, slug, ...rest] = argv;
  if (cmd === "move" && rest.length >= 2) return moveTask(slug, rest[0], rest[1], rest[2]);
  if (cmd === "add" && rest.length === 1) return addTask(slug, rest[0]);
  if (cmd === "state" && rest[0] === "now" && rest.length >= 2) return setNow(slug, rest[1], rest.slice(2));
  throw new Error(
    'usage: move <slug> <Todo|Doing|Blocked|Done> "<exact title>" ["note"] | add <slug> "<title>" | state <slug> now "<headline>" ["detail"...]',
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
