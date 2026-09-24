// Scaffold a new project under PM_ROOT: <slug>/ dir + README/CONTEXT stubs and the
// .claude state/backlog/rules files. Never git-inits; never touches the workspace CLAUDE.md.
import { mkdir, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { PM_ROOT, STATE_DIR, BACKLOG_DIR, RULES_DIR } from "./paths.mjs";
import { serializeState } from "./state.mjs";
import { emptyBacklog, writeBacklog } from "./backlog.mjs";

export const NEW_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

// "My Cool App" -> "my-cool-app"; anything else illegal is rejected, not silently mangled
export function slugify(name) {
  const s = String(name ?? "").trim().toLowerCase().replace(/[\s_]+/g, "-");
  if (!NEW_SLUG_RE.test(s) || s.endsWith("-") || s.includes("--")) {
    throw Object.assign(new Error("bad project name (use letters, digits, dashes)"), { code: "BAD_SLUG" });
  }
  return s;
}

const exists = (p) => access(p).then(() => true, () => false);

export async function scaffoldProject(name, { title } = {}) {
  const slug = slugify(name);
  const dir = join(PM_ROOT, slug);
  const files = {
    state: join(STATE_DIR, `${slug}.md`),
    backlog: join(BACKLOG_DIR, `${slug}.md`),
    rules: join(RULES_DIR, `${slug}.md`),
  };
  for (const p of [dir, ...Object.values(files)]) {
    if (await exists(p)) throw Object.assign(new Error("project already exists"), { code: "EXISTS" });
  }
  const label = String(title || slug).replace(/\s+/g, " ").trim().slice(0, 80) || slug;

  await mkdir(dir, { recursive: true });
  await Promise.all([STATE_DIR, BACKLOG_DIR, RULES_DIR].map((d) => mkdir(d, { recursive: true })));
  await writeFile(join(dir, "README.md"), `# ${slug}\n\nTODO: one-paragraph purpose.\n\n## Run & verify\n\nTODO\n`, { flag: "wx" });
  await writeFile(join(dir, "CONTEXT.md"), `# ${slug} — context\n\nTODO: domain terms and settled decisions.\n`, { flag: "wx" });
  await writeFile(
    files.state,
    serializeState(
      {
        slug,
        title: `${slug} — state`,
        now: `Scaffolded from pm${label !== slug ? `: ${label}` : ""}`,
        next: ["Write the README and fill in the rules file"],
        lastFailure: "none",
        blockers: "none",
      },
      { refreshDate: true },
    ),
    { flag: "wx" },
  );
  await writeBacklog(slug, emptyBacklog(slug));
  await writeFile(
    files.rules,
    `---\npaths: ${slug}/**\n---\n\n# ${slug}\n\n## Run & verify\n\nTODO: install, run, the one verify entrypoint, unit tests.\n\n## Gotchas\n\n- (none yet)\n`,
    { flag: "wx" },
  );
  return slug;
}
