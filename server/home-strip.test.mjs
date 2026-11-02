import test from "node:test";
import assert from "node:assert/strict";
import { formatStrip, cleanPrefs, homeStrip } from "./home-strip.mjs";

const usage = { block: 6.1, today: 12.4, week: 61.019 };
const limits = { fiveHour: { pct: 41.6, resetsAtMs: new Date(2026, 0, 7, 18, 30).getTime() }, week: { pct: 17, resetsAtMs: new Date(2026, 0, 8, 9, 0).getTime() } };

test("keeps order, skips non-live segments, uses lang labels", () => {
  const r = formatStrip({ segments: ["model", "limit5h", "limit7d", "today", "week", "dir"], lang: "en" }, usage, limits);
  assert.deepEqual(r.map((x) => x.id), ["limit5h", "limit7d", "today", "week"]);
  assert.equal(r[0].text, "%42 18:30");
  assert.equal(r[1].text, "%17 Thu 09:00");
  assert.equal(r[3].text, "$61.02");
  assert.equal(formatStrip({ segments: ["today"], lang: "tr" }, usage, null)[0].label, "Bugün");
});
test("missing limits drop their segments", () => {
  assert.deepEqual(formatStrip({ segments: ["limit5h", "week"] }, usage, null).map((x) => x.id), ["week"]);
});
test("cleanPrefs validates", () => {
  assert.deepEqual(cleanPrefs({}), { follow: true });
  assert.deepEqual(cleanPrefs({ follow: false, segments: ["week"] }), { follow: false, segments: ["week"] });
  assert.throws(() => cleanPrefs({ follow: false, segments: ["model"] }));
  assert.throws(() => cleanPrefs({ follow: false, segments: ["week", "week"] }));
});
test("homeStrip follows config unless overridden", () => {
  const cfg = { segments: ["model", "today"], lang: "en", sep: " | " };
  assert.deepEqual(homeStrip({ cfg, prefs: { follow: true }, usage, limits }).items.map((x) => x.id), ["today"]);
  assert.deepEqual(homeStrip({ cfg, prefs: { follow: false, segments: ["week", "today"] }, usage, limits }).items.map((x) => x.id), ["week", "today"]);
});
