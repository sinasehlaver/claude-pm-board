import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = mkdtempSync(join(tmpdir(), "ccfg-"));
const cdir = join(base, "claude"), root = join(base, "ws");
process.env.PM_ROOT = root;
process.env.PM_CLAUDE_DIR = cdir;
mkdirSync(join(cdir, "skills", "ponytail"), { recursive: true });
mkdirSync(join(root, ".claude", "rules"), { recursive: true });
mkdirSync(join(root, ".claude", "agents"), { recursive: true });
writeFileSync(join(cdir, "skills", "ponytail", "SKILL.md"), "---\nname: ponytail\ndescription: ties hair\n---\n# Ponytail\nbody");
writeFileSync(join(cdir, "CLAUDE.md"), "# Global\nAPI_KEY=abcdef123456789\n");
writeFileSync(join(root, "CLAUDE.md"), "# Root");
writeFileSync(join(root, ".claude", "rules", "pm.md"), "---\npaths: pm/**\n---\n# PM rules");
writeFileSync(join(root, ".claude", "agents", "a.md"), "---\ndescription: agent a\n---\nx");
writeFileSync(join(base, "secret.md"), "outside");
writeFileSync(join(cdir, "settings.json"), JSON.stringify({
  env: { ANTHROPIC_API_KEY: "sk-ant-supersecretvalue123" },
  permissions: { allow: ["a", "b"], deny: ["c"] },
  enabledPlugins: { "ponytail@x": true },
  hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "guard.sh --token abc123def GH_TOKEN=ghp_abcdefghijklmnop1234" }] }] },
  mcpServers: { s: { command: "npx", args: ["srv", "--api-key", "zzz999"], env: { SECRET: "v" } } },
}));

const { claudeConfig, previewFile, redact } = await import("./claude-config.mjs");

test("inventory covers settings, skills, agents, memory, rules", () => {
  const c = claudeConfig();
  const s = c.settings[0];
  assert.equal(s.hooks[0].event, "PreToolUse");
  assert.equal(s.hooks[0].matcher, "Bash");
  assert.deepEqual(s.permissions, { allow: 2, deny: 1, ask: 0, defaultMode: null });
  assert.deepEqual(s.env, ["ANTHROPIC_API_KEY"]);
  assert.equal(s.plugins[0].name, "ponytail@x");
  assert.deepEqual(s.mcp[0].env, ["SECRET"]);
  assert.equal(c.skills[0].description, "ties hair");
  assert.equal(c.agents.length, 1);
  assert.equal(c.memory.length, 2);
  assert.equal(c.rules[0].paths, "pm/**");
  assert.equal(c.rules[0].heading, "PM rules");
  assert.ok(!("abs" in c.skills[0]));
});

test("secrets are masked everywhere", () => {
  const j = JSON.stringify(claudeConfig());
  for (const v of ["sk-ant-supersecretvalue123", "abc123def", "ghp_abcdefghijklmnop1234", "zzz999"]) assert.ok(!j.includes(v), v);
  assert.equal(redact("x --api-key=hunter22"), "x --api-key=***");
});

test("preview works by id, masks secrets, rejects unknown ids and traversal", () => {
  const p = previewFile("memory:user:CLAUDE.md");
  assert.match(p.text, /# Global/);
  assert.ok(!p.text.includes("abcdef123456789"));
  for (const bad of ["../secret.md", "rule:project:../../secret.md", "/etc/passwd", "memory:user:../secret.md", 5]) {
    assert.throws(() => previewFile(bad), (e) => [400, 404].includes(e.status));
  }
});

test("a symlink escaping the roots is refused", () => {
  symlinkSync(join(base, "secret.md"), join(root, ".claude", "rules", "evil.md"));
  assert.throws(() => previewFile("rule:project:evil.md"), (e) => e.status === 403);
});
