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

test("serialize throws past the 50-line cap", () => {
  const s = parseState(CANON, "hub");
  s.next = Array.from({ length: 40 }, (_, i) => `item ${i}`);
  assert.throws(() => serializeState(s), /50-line cap/);
});

test("serialize throws past the 4000-char cap", () => {
  const s = parseState(CANON, "hub");
  s.next = Array.from({ length: 20 }, () => "x".repeat(300));
  assert.throws(() => serializeState(s), /4000-char cap/);
});

test("serialize throws past the 4000-char cap", () => {
  const s = parseState(CANON, "hub");
  s.now = "x".repeat(4000);
  assert.throws(() => serializeState(s), /4000-char cap/);
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

const WITH_RESUME = CANON + `
## Resume
Last result: 42/50 pass, p50 3.1s
Re-run: python bench.py --variant b
Branch/variant: f-fix-2 / opus
Artifacts: reports/R03.md, nb/ab.ipynb
`;

test("Resume block parses, round-trips byte-identical, and old files get an empty one", () => {
  const s = parseState(WITH_RESUME, "hub");
  assert.deepEqual(s.resume, {
    lastResult: "42/50 pass, p50 3.1s",
    rerun: "python bench.py --variant b",
    branch: "f-fix-2 / opus",
    artifacts: "reports/R03.md, nb/ab.ipynb",
  });
  assert.equal(serializeState(s), WITH_RESUME);
  assert.deepEqual(parseState(CANON, "hub").resume, { lastResult: "", rerun: "", branch: "", artifacts: "" });
});

test("Resume values are flattened to one line; a partly-filled block keeps all four labels", () => {
  const s = parseState(CANON, "hub");
  s.resume = { lastResult: "ok\n## Blockers\nfake", rerun: "", branch: "", artifacts: "" };
  const out = serializeState(s);
  assert.match(out, /Last result: ok ## Blockers fake\nRe-run: \nBranch\/variant: \nArtifacts: \n/);
  assert.equal(parseState(out, "hub").blockers, "none");
});
