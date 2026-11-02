import test from "node:test";
import assert from "node:assert/strict";
import { fuzzyScore, filterCommands, isTyping } from "../web/src/palette-core.mjs";

const cmds = [
  { id: "home", label: "Go to Home" },
  { id: "doctor", label: "Go to Doctor" },
  { id: "setup", label: "Go to Setup", keywords: "launch checks" },
  { id: "theme", label: "Toggle theme" },
];

test("empty query keeps order", () => assert.deepEqual(filterCommands(cmds, "  "), cmds));
test("substring and subsequence match, non-match drops", () => {
  assert.ok(fuzzyScore("doc", "Go to Doctor") > 0);
  assert.ok(fuzzyScore("gtd", "Go to Doctor") > 0);
  assert.equal(fuzzyScore("xyz", "Go to Doctor"), 0);
});
test("best match first; keywords searchable", () => {
  assert.equal(filterCommands(cmds, "theme")[0].id, "theme");
  assert.equal(filterCommands(cmds, "launch")[0].id, "setup");
  assert.equal(filterCommands(cmds, "hme")[0].id, "home");
});
test("isTyping", () => {
  assert.ok(isTyping({ tagName: "INPUT" }));
  assert.ok(isTyping({ tagName: "DIV", isContentEditable: true }));
  assert.ok(!isTyping({ tagName: "BUTTON" }));
  assert.ok(!isTyping(null));
});
