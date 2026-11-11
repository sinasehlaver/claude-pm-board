import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PM_ROOT = mkdtempSync(join(tmpdir(), "pm-setup-"));
const { findClaudes, savePrefs, claudeBin, setupStatus } = await import("./setup.mjs");

test("findClaudes finds nvm installs under a fake home and reads --version", () => {
  const home = mkdtempSync(join(tmpdir(), "pm-home-"));
  const bin = join(home, ".nvm/versions/node/v1/bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "claude"), "#!/bin/sh\necho '9.9.9 (Claude Code)'\n");
  chmodSync(join(bin, "claude"), 0o755);
  const [c] = findClaudes(home);
  assert.equal(c.path, join(bin, "claude"));
  assert.equal(c.version, "9.9.9");
});

test("savePrefs refuses a path that isn't a detected install; null = PATH default", () => {
  assert.equal(setupStatus().firstRun, true);
  assert.throws(() => savePrefs({ claudeBin: "/bin/sh" }), /unknown claude binary/);
  savePrefs({ claudeBin: null });
  assert.equal(claudeBin(), "claude");
  assert.equal(setupStatus().firstRun, false);
});

test("model pref: whitelist-validated, merged without losing claudeBin, drives modelArg", async () => {
  const { modelArg, readPrefs } = await import("./setup.mjs");
  assert.equal(modelArg(), "sonnet"); // no pick saved = sonnet, never the account default
  assert.equal(setupStatus().prefs.maxBudgetUsd, 25);
  assert.throws(() => savePrefs({ model: "gpt-9; rm -rf /" }), /unknown model/);
  savePrefs({ model: "opus" });
  assert.equal(modelArg(), "opus");
  assert.equal(readPrefs().claudeBin, null);
  savePrefs({ model: "default" });
  assert.equal(modelArg(), null);
  savePrefs({ model: "fable" });
  assert.equal(modelArg(), "fable");
  assert.throws(() => savePrefs({ maxBudgetUsd: -1 }), /bad maxBudgetUsd/);
  assert.throws(() => savePrefs({ maxBudgetUsd: "5" }), /bad maxBudgetUsd/);
  savePrefs({ maxBudgetUsd: null });
  assert.equal(setupStatus().prefs.maxBudgetUsd, null);
  assert.equal(readPrefs().model, "fable"); // budget save kept the model
});

test("resolvedDefault reads ANTHROPIC_MODEL, then ~/.claude/settings.json", async () => {
  const { resolvedDefault } = await import("./setup.mjs");
  const dir = mkdtempSync(join(tmpdir(), "pm-cdir-"));
  assert.deepEqual(resolvedDefault({ PM_CLAUDE_DIR: dir }), { model: null, from: null });
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ model: "opus" }));
  assert.equal(resolvedDefault({ PM_CLAUDE_DIR: dir }).model, "opus");
  assert.equal(resolvedDefault({ PM_CLAUDE_DIR: dir, ANTHROPIC_MODEL: "fable" }).model, "fable");
});
