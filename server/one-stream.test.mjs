import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Each EventSource holds one of the browser's 6 HTTP/1.1 connections per origin for good;
// one per component per tab starved every other request. api.js owns the only one.
test("only web/src/api.js opens an EventSource, and it is shared across tabs", () => {
  const dir = new URL("../web/src/", import.meta.url).pathname;
  const users = readdirSync(dir)
    .filter((f) => /\.(jsx?|mjs)$/.test(f))
    .filter((f) => /new EventSource\(/.test(readFileSync(join(dir, f), "utf8")));
  assert.deepEqual(users, ["api.js"]);
  const api = readFileSync(join(dir, "api.js"), "utf8");
  assert.equal(api.match(/new EventSource\(/g).length, 1);
  assert.match(api, /navigator\.locks\.request\(/);
  assert.match(api, /BroadcastChannel\(/);
  assert.match(api, /AbortSignal\.timeout\(/);
});
