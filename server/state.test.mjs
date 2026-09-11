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

const CANON_MULTILINE = `# hub — state
Updated: 2026-09-11

## Now
- [ ] Fixed the status headline bug
  - stripped the marker per-line, not just the first
  - added sub-bullets for detail points

## Next
- P2 connectors/feeds

## Last failure
none

## Blockers
none
`;

test("Now headline + detail bullets parse into newline-joined lines, markers stripped", () => {
  const s = parseState(CANON_MULTILINE, "hub");
  assert.equal(
    s.now,
    "Fixed the status headline bug\nstripped the marker per-line, not just the first\nadded sub-bullets for detail points",
  );
});

test("multi-line Now round-trips byte-identical", () => {
  assert.equal(serializeState(parseState(CANON_MULTILINE, "hub")), CANON_MULTILINE);
});
