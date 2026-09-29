import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const pmRoot = mkdtempSync(join(tmpdir(), "pm-doc-root-"));
const projRoot = mkdtempSync(join(tmpdir(), "pm-doc-proj-"));
process.env.PM_ROOT = pmRoot;
process.env.CLAUDE_PROJECTS_ROOT = projRoot;

const { runDoctor, scanAndCache, readDoctor, DOCTOR_FILE } = await import("./doctor.mjs");

const now = Date.now();
const iso = (msAgo) => new Date(now - msAgo).toISOString();
const L = (o) => JSON.stringify(o) + "\n";
const prefix = pmRoot.replace(/[^a-zA-Z0-9]/g, "-");
const dir = join(projRoot, prefix);
mkdirSync(join(dir, "sess1", "subagents"), { recursive: true });
mkdirSync(join(projRoot, "-unrelated-project"), { recursive: true });

let n = 0;
const asst = (content, usage, extra = {}) =>
  L({ type: "assistant", timestamp: iso(60_000 - n++), message: { id: "m" + n, model: "claude-opus-4", content, usage }, ...extra });
const use = (id, name, input) => ({ type: "tool_use", id, name, input });
const res = (id, content, is_error) => ({ type: "tool_result", tool_use_id: id, content, is_error });
const user = (blocks) => L({ type: "user", timestamp: iso(59_000 - n++), message: { content: blocks } });

let main = L({ type: "ai-title", aiTitle: "Big job" });
for (let i = 0; i < 4; i++) {
  main += asst([use("f" + i, "Bash", { command: "npm run nope" })], { input_tokens: 10, output_tokens: 5 });
  main += user([res("f" + i, "command not found: nope", true)]);
}
main += asst([use("p1", "Edit", { file_path: "/x/.claude/a.md" })], { input_tokens: 1, output_tokens: 1 });
main += user([res("p1", "Claude requested permissions to edit /x/.claude/a.md which is a sensitive file", true)]);
for (let i = 0; i < 3; i++) {
  main += asst([use("r" + i, "Read", { file_path: "/x/big" + i + ".txt" })], { input_tokens: 5, output_tokens: 5 });
  main += user([res("r" + i, "y".repeat(50_000), false)]);
}
for (let i = 0; i < 3; i++) main += asst([{ type: "text", text: "hi" }], { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 40_000 } });
main += L({ type: "assistant", isApiErrorMessage: true, timestamp: iso(1000), message: { content: [{ type: "text", text: "API Error: 429 rate limit" }] } });
writeFileSync(join(dir, "sess1.jsonl"), main);

let sub = "";
for (let i = 0; i < 5; i++) {
  writeFileSync(join(dir, "sess1", "subagents", `agent-${i}.jsonl`), asst([{ type: "text", text: "x" }], { input_tokens: 500, output_tokens: 100 }));
}
writeFileSync(join(projRoot, "-unrelated-project", "other.jsonl"), asst([use("z", "Bash", { command: "boom" })], { input_tokens: 99999999, output_tokens: 1 }));

test("scan finds errors, spend, fan-out; scopes to PM_ROOT", async () => {
  const r = await runDoctor({ now });
  assert.equal(r.scope.sessions, 1);
  assert.ok(r.totals.tokens < 1_000_000, "unrelated project excluded");
  const ids = r.findings.map((f) => f.id);
  for (const want of ["repeat-fail-1", "permission-denials", "api-errors", "large-reads", "cache-miss-turns", "subagent-fanout"]) {
    assert.ok(ids.includes(want), `missing ${want}: ${ids}`);
  }
  const rep = r.findings.find((f) => f.id === "repeat-fail-1");
  assert.equal(rep.evidence.count, 4);
  assert.equal(rep.target, "CLAUDE.md");
  assert.equal(r.findings.find((f) => f.id === "api-errors").evidence.rateLimit >= 1, true);
  assert.equal(r.topSessions[0].id, "sess1");
  assert.ok(r.topTools.find((t) => t.name === "Read").resultChars >= 150_000);
  for (const f of r.findings) for (const k of ["id", "severity", "title", "evidence", "suggestion", "target"]) assert.ok(f[k] !== undefined, k);
});

test("scanAndCache writes doctor.json under PM_ROOT/.claude/pm", async () => {
  assert.equal(readDoctor(), null);
  await scanAndCache({ now });
  assert.ok(DOCTOR_FILE().startsWith(pmRoot));
  assert.ok(existsSync(DOCTOR_FILE()));
  assert.equal(JSON.parse(readFileSync(DOCTOR_FILE(), "utf8")).findings.length, readDoctor().findings.length);
});
