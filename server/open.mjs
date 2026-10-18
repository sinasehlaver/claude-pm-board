// POST /api/open backend: open a workspace file in its default Mac app. Only files that
// resolve (symlinks followed) inside PM_ROOT, with a document/data extension, are opened —
// `open` would otherwise launch .app/.command files, i.e. run code.
import { existsSync, realpathSync } from "node:fs";
import { execFile } from "node:child_process";
import { isAbsolute, join, relative, sep } from "node:path";
import { PM_ROOT } from "./paths.mjs";
import { entryDir } from "./entries.mjs";

export const OPEN_EXT = /\.(pdf|xlsx|xls|csv|ipynb|html?|md|txt|json|docx|pptx|png|jpe?g|svg)$/i;

class OpenError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// -> real absolute path, or throws OpenError(400|403|404). A relative path is tried under
// PM_ROOT, then under the slug's folder (state files write paths either way).
export function resolveOpenable(p, slug) {
  if (typeof p !== "string" || !p || p.includes("\0")) throw new OpenError(400, "bad path");
  if (!OPEN_EXT.test(p)) throw new OpenError(400, "file type not openable");
  const bases = isAbsolute(p) ? [""] : [PM_ROOT, ...(typeof slug === "string" && /^[a-z0-9][a-z0-9_-]*$/i.test(slug) ? [entryDir(slug)] : [])];
  const hit = bases.map((b) => join(b, p)).find((f) => existsSync(f));
  if (!hit) throw new OpenError(404, "no such file");
  const real = realpathSync(hit);
  const rel = relative(realpathSync(PM_ROOT), real);
  if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) throw new OpenError(403, "outside the workspace");
  return real;
}

export async function openFile(p, slug) {
  const real = resolveOpenable(p, slug);
  if (process.env.PM_LAUNCH_DRYRUN === "1") return Promise.resolve({ dryrun: true, path: real });
  return new Promise((resolve, reject) =>
    execFile("open", [real], (err) => (err ? reject(err) : resolve({ path: real }))),
  );
}
