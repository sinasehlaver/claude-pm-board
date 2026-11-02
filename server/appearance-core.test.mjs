import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULTS, normalize, parse, serialize, isDefault, toStyle } from "../web/src/appearance-core.mjs";

test("garbage input yields defaults", () => {
  assert.deepEqual(normalize(null), DEFAULTS);
  assert.deepEqual(normalize([1]), DEFAULTS);
  assert.deepEqual(parse("{nope"), DEFAULTS);
  assert.deepEqual(parse(""), DEFAULTS);
});

test("values are clamped and validated", () => {
  const s = normalize({ tint: 99, dim: -3, textScale: "1.1", radius: "x", font: "comic", density: "tight", accent: "red", reduceMotion: "yes" });
  assert.equal(s.tint, 2);
  assert.equal(s.dim, 0);
  assert.equal(s.textScale, 1.1);
  assert.equal(s.radius, 1);
  assert.equal(s.font, "inter");
  assert.equal(s.density, "comfortable");
  assert.equal(s.accent, "");
  assert.equal(s.reduceMotion, false);
});

test("serialize stores only non-defaults and round-trips", () => {
  assert.equal(serialize(DEFAULTS), "");
  assert.ok(isDefault({}));
  const s = normalize({ tint: 0.5, font: "mono", accent: "#AABBCC", reduceMotion: true });
  assert.deepEqual(JSON.parse(serialize(s)), { tint: 0.5, font: "mono", accent: "#aabbcc", reduceMotion: true });
  assert.deepEqual(parse(serialize(s)), s);
});

test("toStyle removes defaults and derives accent + radii", () => {
  const d = toStyle(DEFAULTS);
  assert.ok(Object.values(d.vars).every((v) => v === null));
  assert.ok(Object.values(d.attrs).every((v) => v === null));
  const t = toStyle({ accent: "#ff0000", radius: 0, density: "compact", font: "serif", textScale: 1.2 });
  assert.equal(t.vars["--accent-tint"], "rgba(255, 0, 0, 0.17)");
  assert.equal(t.vars["--radius"], "0px");
  assert.equal(t.vars["--text-scale"], "1.2");
  assert.match(t.vars["--font-text"], /Charter/);
  assert.equal(t.attrs["data-density"], "compact");
});
