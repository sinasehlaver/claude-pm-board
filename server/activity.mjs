import { readFile } from "node:fs/promises";
import { ACTIVITY_FILE } from "./paths.mjs";

export async function readActivity() {
  try {
    const arr = JSON.parse(await readFile(ACTIVITY_FILE, "utf8"));
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
}

// an entry belongs to a project if it names the slug exactly or as a prefix
// (handoff files like "hub-diet-widgets" roll up under "hub")
export function matchesProject(entry, slug) {
  return entry.project === slug || entry.project.startsWith(slug + "-");
}

// most recent activity date for a project, or null
export function lastTouched(activity, slug) {
  let latest = null;
  for (const a of activity) {
    if (!matchesProject(a, slug)) continue;
    if (!latest || String(a.date) > latest) latest = String(a.date);
  }
  return latest;
}
