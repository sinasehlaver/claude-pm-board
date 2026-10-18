import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const { sanitizePrefs, hoverBounds, HOVER_SIZE } = createRequire(import.meta.url)("../electron/hover.cjs");

test("sanitizePrefs drops junk and keeps valid bounds", () => {
  assert.deepEqual(sanitizePrefs(null), { hover: false, hoverBounds: null });
  assert.deepEqual(sanitizePrefs({ hover: "yes", hoverBounds: { x: "a" } }), { hover: false, hoverBounds: null });
  assert.deepEqual(sanitizePrefs({ hover: true, hoverBounds: { x: 1.4, y: 2, width: 100, height: 100 } }).hoverBounds, null);
  const ok = sanitizePrefs({ hover: true, hoverBounds: { x: 10, y: 20, width: 400, height: 500 } });
  assert.deepEqual(ok, { hover: true, hoverBounds: { x: 10, y: 20, width: 400, height: 500 } });
});

test("hoverBounds defaults top-right and rejects off-screen saved spots", () => {
  const areas = [{ x: 0, y: 0, width: 1000, height: 800 }];
  const d = hoverBounds(null, areas);
  assert.equal(d.x, 1000 - HOVER_SIZE.width - 16);
  assert.equal(d.y, 16);
  const off = { x: 5000, y: 5000, width: 400, height: 500 };
  assert.deepEqual(hoverBounds(off, areas), d);
  const on = { x: 100, y: 100, width: 400, height: 500 };
  assert.deepEqual(hoverBounds(on, areas), on);
});
