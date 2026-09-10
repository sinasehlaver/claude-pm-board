import test from "node:test";
import assert from "node:assert/strict";
import { parseState, serializeState } from "./state.mjs";

const CANON = `# hub — state
Updated: 2026-09-07

## Now
- [ ] Nothing active. Last shipped: P4 diet.

## Next
- P2 connectors/feeds
- P3 dev-ops

## Last failure
Pre-existing test bugs, not from P4.

## Blockers
none
`;

test("parse extracts the four sections", () => {
  const s = parseState(CANON, "hub");
  assert.equal(s.now, "Nothing active. Last shipped: P4 diet.");
  assert.deepEqual(s.next, ["P2 connectors/feeds", "P3 dev-ops"]);
  assert.match(s.lastFailure, /Pre-existing/);
  assert.equal(s.blockers, "none");
});

test("canonical round-trips byte-identical", () => {
  assert.equal(serializeState(parseState(CANON, "hub")), CANON);
});

test("serialize throws past the 40-line cap", () => {
  const s = parseState(CANON, "hub");
  s.next = Array.from({ length: 40 }, (_, i) => `item ${i}`);
  assert.throws(() => serializeState(s), /40-line cap/);
});

test("missing sections default to 'none'", () => {
  const s = parseState("# x — state\nUpdated: 2026-01-01\n\n## Now\n- [ ] go\n", "x");
  assert.equal(s.lastFailure, "none");
  assert.equal(s.blockers, "none");
  assert.deepEqual(s.next, []);
});
