// Parse / serialize .claude/state/<slug>.md — the 40-line status file defined by
// .claude/knowledge-architecture.md. Format is fixed: an "Updated:" line then four
// H2 sections in order: Now / Next / Last failure / Blockers.
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { STATE_DIR } from "./paths.mjs";

const SECTIONS = ["Now", "Next", "Last failure", "Blockers"];
export const STATE_LINE_CAP = 40;

function splitSections(body) {
  const out = {};
  let cur = null;
  for (const line of body.split("\n")) {
    const m = line.match(/^##\s+(.+?)\s*$/);
    if (m) {
      cur = m[1];
      out[cur] = [];
    } else if (cur) {
      out[cur].push(line);
    }
  }
  for (const k of Object.keys(out)) out[k] = out[k].join("\n").trim();
  return out;
}

// "## Now" is a headline (`- [ ]`/`- [x]` line) optionally followed by indented
// `  - ` detail bullets. Parsed into one string, one point per line, markers
// stripped — serializeState re-adds them so the .md stays readable as a list.
function parseNow(section) {
  return (section || "")
    .split("\n")
    .map((l, i) =>
      i === 0 ? l.replace(/^-\s*\[[ xX]\]\s*/, "") : l.replace(/^\s*-\s*/, ""),
    )
    .map((l) => l.trim())
    .filter(Boolean)
    .join("\n");
}

function serializeNow(now) {
  const lines = (now || "").split("\n").map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return "- [ ] ";
  return [`- [ ] ${lines[0]}`, ...lines.slice(1).map((l) => `  - ${l}`)].join("\n");
}

export function parseState(text, slug) {
  const titleM = text.match(/^#\s+(.+?)\s*$/m);
  const updM = text.match(/^Updated:\s*(.+?)\s*$/m);
  const sec = splitSections(text);
  const now = parseNow(sec["Now"]);
  const next = (sec["Next"] || "")
    .split("\n")
    .map((l) => l.replace(/^-\s+/, "").trim())
    .filter(Boolean);
  return {
    slug,
    title: titleM ? titleM[1] : `${slug} — state`,
    updated: updM ? updM[1] : "",
    now,
    next,
    lastFailure: (sec["Last failure"] || "none").trim() || "none",
    blockers: (sec["Blockers"] || "none").trim() || "none",
  };
}

export function serializeState(s, { refreshDate = false } = {}) {
  const updated = refreshDate ? new Date().toISOString().slice(0, 10) : s.updated;
  const lines = [
    `# ${s.title || `${s.slug} — state`}`,
    `Updated: ${updated}`,
    "",
    "## Now",
    serializeNow(s.now),
    "",
    "## Next",
    ...(s.next && s.next.length ? s.next.map((n) => `- ${n}`) : []),
    "",
    "## Last failure",
    s.lastFailure || "none",
    "",
    "## Blockers",
    s.blockers || "none",
    "",
  ];
  const text = lines.join("\n");
  const count = text.split("\n").length;
  if (count > STATE_LINE_CAP)
    throw new Error(`state file exceeds ${STATE_LINE_CAP}-line cap (${count})`);
  return text;
}

export async function readState(slug) {
  try {
    return parseState(await readFile(join(STATE_DIR, `${slug}.md`), "utf8"), slug);
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

export async function writeState(slug, s) {
  const text = serializeState({ ...s, slug }, { refreshDate: true });
  await writeFile(join(STATE_DIR, `${slug}.md`), text);
  return text;
}

export { SECTIONS };
