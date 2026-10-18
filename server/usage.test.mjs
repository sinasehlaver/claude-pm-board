import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFile, tokenSum } from "./usage.mjs";

const dir = mkdtempSync(join(tmpdir(), "pm-usage-"));
const row = (output) =>
  JSON.stringify({
    type: "assistant",
    timestamp: new Date().toISOString(),
    message: { id: "st1", model: "claude-sonnet-5-5", usage: { input_tokens: 2, output_tokens: output } },
  }) + "\n";

test("parseFile keeps the LAST usage snapshot for a repeated streaming message.id, not the first", async () => {
  const f = join(dir, "s.jsonl");
  writeFileSync(f, row(7) + row(7) + row(447));
  const turns = await parseFile(f);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].output, 447);
  assert.equal(tokenSum(turns[0]), 449);
});
