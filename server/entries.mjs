// .claude/entries.json: { "<slug>": { "kind": "benchmark"|"tool", "path": "<rel to PM_ROOT>" } }.
// Benchmarks/tools are tracked like projects (state + backlog) but live anywhere under
// PM_ROOT, so their slug need not equal a folder name. A slug with no entry is a project
// whose folder is PM_ROOT/<slug>.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { PM_ROOT, CLAUDE } from "./paths.mjs";

export const KINDS = ["project", "benchmark", "tool"];

export function readEntries() {
  try {
    const raw = JSON.parse(readFileSync(join(CLAUDE, "entries.json"), "utf8"));
    return Object.fromEntries(
      Object.entries(raw).filter(([, e]) => ["benchmark", "tool"].includes(e?.kind) && typeof e.path === "string"),
    );
  } catch {
    return {};
  }
}

export const kindOf = (slug) => readEntries()[slug]?.kind || "project";

// Where claude should run for this slug: the entry's path (a file entry -> its folder).
export function entryDir(slug) {
  const e = readEntries()[slug];
  if (!e) return join(PM_ROOT, slug);
  const p = resolve(PM_ROOT, e.path);
  return /\.[a-z0-9]+$/i.test(e.path) ? resolve(p, "..") : p;
}

// Absolute path of each entry (a file entry keeps its file path), for session attribution.
export const entryPaths = () =>
  Object.fromEntries(Object.entries(readEntries()).map(([s, e]) => [s, resolve(PM_ROOT, e.path)]));
