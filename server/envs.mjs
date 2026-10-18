// Env manager: finds every live .env file under PM_ROOT, lists vars grouped by name
// (values masked), and rewrites one var across files. Values never leave this process
// unmasked and are never logged. Skips archive/, backups (.bak/.cpgz), *.example.
import { readdir, readFile, writeFile, copyFile, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { PM_ROOT } from "./paths.mjs";

const SKIP_DIRS = new Set(["archive", "node_modules", ".git", ".venv", "venv", "site-packages", "dist", "__pycache__", ".next"]);
const ENV_FILE_RE = /^\.env(\.(local|test|development|production|staging))?$/;
const LINE_RE = /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)(.*)$/;
const MAX_DEPTH = 5;

const err = (status, message) => Object.assign(new Error(message), { status });

export function mask(v) {
  return v.length >= 12 ? "••••" + v.slice(-4) : v ? "••••" : "(empty)";
}
const hash = (v) => createHash("sha1").update(v).digest("hex").slice(0, 8);

// "abc" / 'abc' / abc  # comment  ->  {quote, value}
function parseValue(raw) {
  const m = raw.match(/^(["'])(.*)\1\s*(#.*)?$/);
  if (m) return { quote: m[1], value: m[2], tail: m[3] ? " " + m[3] : "" };
  const bare = raw.match(/^(.*?)(\s+#.*)?$/);
  return { quote: "", value: bare[1], tail: bare[2] || "" };
}

export async function findEnvFiles(root = PM_ROOT) {
  const out = [];
  async function walk(dir, depth) {
    let ents;
    try { ents = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < MAX_DEPTH && !SKIP_DIRS.has(e.name)) await walk(p, depth + 1);
      } else if (e.isFile() && ENV_FILE_RE.test(e.name)) out.push(p);
    }
  }
  await walk(root, 0);
  return out.sort();
}

// -> [{name, files:[{file, mask, id}], distinct}] ; id = short hash of the value (groups equal values)
export async function scanEnvs(root = PM_ROOT) {
  const byName = new Map();
  for (const f of await findEnvFiles(root)) {
    const rel = relative(root, f);
    for (const line of (await readFile(f, "utf8")).split("\n")) {
      const m = line.match(LINE_RE);
      if (!m || m[1].trim().startsWith("#")) continue;
      const { value } = parseValue(m[4].trimEnd());
      if (!byName.has(m[2])) byName.set(m[2], []);
      byName.get(m[2]).push({ file: rel, mask: mask(value), id: hash(value) });
    }
  }
  return [...byName]
    .map(([name, files]) => ({ name, files, distinct: new Set(files.map((x) => x.id)).size }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Rewrite NAME=<value> in `files` (rel paths; default = every file that has it).
// dryRun -> report only. Each changed file is first copied to <file>.bak-<ts>.
export async function updateEnv(name, value, { files, dryRun = false, root = PM_ROOT } = {}) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name || "")) throw err(400, "bad var name");
  if (typeof value !== "string" || !value || /[\r\n]/.test(value)) throw err(400, "value must be one non-empty line");
  const known = (await findEnvFiles(root)).map((f) => relative(root, f));
  const targets = files ? files.filter((f) => known.includes(f)) : known;
  if (files && targets.length !== files.length) throw err(400, "file is not a managed env file");
  const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const result = [];
  for (const rel of targets) {
    const abs = resolve(root, rel);
    if (!abs.startsWith(resolve(root) + sep)) throw err(400, "path outside root");
    const lines = (await readFile(abs, "utf8")).split("\n");
    let hits = 0, changed = 0;
    const next = lines.map((line) => {
      const m = line.match(LINE_RE);
      if (!m || m[2] !== name || m[1].trim().startsWith("#")) return line;
      hits++;
      const p = parseValue(m[4].trimEnd());
      if (p.value === value) return line;
      changed++;
      return m[1] + m[2] + m[3] + p.quote + value + p.quote + p.tail;
    });
    if (!hits) continue;
    if (changed && !dryRun) {
      await copyFile(abs, `${abs}.bak-${ts}`);
      await writeFile(abs, next.join("\n"), { mode: (await stat(abs)).mode });
    }
    result.push({ file: rel, changed: changed > 0 });
  }
  return { name, dryRun, files: result, changed: result.filter((r) => r.changed).length };
}
