// A project's short descriptor ("band merch demand + pre-order tracker") lives in its rules-file
// H1: `# <slug>/ — <descriptor>`, which is what the board shows as the card title.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RULES_DIR } from "./paths.mjs";

export const DESCRIPTOR_MAX = 40;

// parseRuleTitle (projects.mjs) drops headings with these characters, so they are refused here.
export function cleanDescriptor(raw) {
  const d = typeof raw === "string" ? raw.trim() : "";
  const bad = (msg) => Object.assign(new Error(msg), { code: "BAD_DESCRIPTOR" });
  if (!d) throw bad("descriptor is required: a few words on what the project is");
  if (d.length > DESCRIPTOR_MAX) throw bad(`descriptor is ${d.length} characters, the limit is ${DESCRIPTOR_MAX}`);
  if (/[\p{Cc}`{}\[\]]/u.test(d)) throw bad("descriptor can't contain line breaks, backticks or brackets");
  return d;
}

export const ruleHeading = (slug, descriptor) => `# ${slug}/ — ${descriptor}`;

// Create-only: an existing rules file is the user's and already has its own heading.
export async function writeRuleStub(slug, descriptor) {
  await mkdir(RULES_DIR, { recursive: true });
  try {
    await writeFile(join(RULES_DIR, `${slug}.md`), `---\npaths: ${slug}/**\n---\n\n${ruleHeading(slug, descriptor)}\n`, { flag: "wx" });
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
  }
}
