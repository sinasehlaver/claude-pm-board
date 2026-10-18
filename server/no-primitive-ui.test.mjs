import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Browser confirm/prompt/alert are banned: use web/src/dialog.jsx (confirmDialog / promptDialog / alertDialog).
test("web/src never calls window.confirm / prompt / alert", () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "web", "src");
  const bad = [];
  for (const f of readdirSync(dir).filter((n) => /\.jsx?$/.test(n))) {
    readFileSync(join(dir, f), "utf8")
      .split("\n")
      .forEach((l, i) => /(^|[^\w.])(window\.)?(confirm|alert|prompt)\(/.test(l) && !l.trim().startsWith("//") && bad.push(`${f}:${i + 1}`));
  }
  assert.deepEqual(bad, []);
});
