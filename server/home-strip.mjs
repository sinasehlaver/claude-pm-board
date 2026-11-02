// Home "Claude Code usage" strip: renders the statusline builder's segments (same labels, order,
// separator, language) with live values. Segments with no live data on Home are skipped.
// Pref: <pm dir>/home-strip.json (pm-owned) = { follow: true } | { follow: false, segments: [ids] }.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { PM_DIR } from "./paths.mjs";
import { SEGMENTS, readConfig } from "./statusline.mjs";
import { readLimits } from "./fill.mjs";
import { statuslineUsageCached } from "./statusline-usage.mjs";

export const LIVE = ["spend5h", "today", "week", "limit5h", "limit7d"];
const PREFS = () => join(PM_DIR, "home-strip.json");
const DAYS = { en: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], tr: ["Paz", "Pzt", "Sal", "Çar", "Per", "Cum", "Cmt"] };
const pad = (n) => String(n).padStart(2, "0");
const usd = (n) => "$" + (Number(n) || 0).toFixed(2);

function limitText(w, withDay, lang) {
  if (!w || typeof w.pct !== "number") return null;
  let t = "%" + Math.round(w.pct);
  const at = w.resetsAtMs ?? (typeof w.resetsAt === "number" ? w.resetsAt * (w.resetsAt < 1e12 ? 1000 : 1) : null);
  if (at) {
    const d = new Date(at);
    if (withDay) t += " " + DAYS[lang][d.getDay()];
    t += ` ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  return t;
}

// Pure: -> [{ id, label, text }] in order; unknown/no-data segments dropped.
export function formatStrip({ segments, lang = "en" }, usage, limits) {
  const by = new Map(SEGMENTS.map((s) => [s.id, s]));
  const out = [];
  for (const id of segments) {
    const s = by.get(id);
    if (!s || !LIVE.includes(id)) continue;
    let text = null;
    if (id === "spend5h") text = usage ? usd(usage.block) : null;
    else if (id === "today") text = usage ? usd(usage.today) : null;
    else if (id === "week") text = usage ? usd(usage.week) : null;
    else if (id === "limit5h") text = limitText(limits?.fiveHour, false, lang);
    else if (id === "limit7d") text = limitText(limits?.week, true, lang);
    if (text == null) continue;
    out.push({ id, label: s.label?.[lang] ?? "", text });
  }
  return out;
}

export function cleanPrefs(b) {
  const bad = (m) => Object.assign(new Error(m), { status: 400 });
  if (!b || typeof b !== "object") throw bad("body must be an object");
  if (b.follow !== false) return { follow: true };
  const { segments } = b;
  if (!Array.isArray(segments) || segments.length > LIVE.length) throw bad("segments must be an array of known ids");
  if (segments.some((s) => !LIVE.includes(s)) || new Set(segments).size !== segments.length) throw bad("unknown or duplicate segment");
  return { follow: false, segments };
}

export function readPrefs() {
  try {
    return cleanPrefs(JSON.parse(readFileSync(PREFS(), "utf8")));
  } catch {
    return { follow: true };
  }
}

export function writePrefs(b) {
  const p = cleanPrefs(b);
  mkdirSync(PM_DIR, { recursive: true });
  writeFileSync(PREFS(), JSON.stringify(p, null, 2) + "\n");
  return p;
}

export function homeStrip({ cfg = readConfig(), prefs = readPrefs(), usage = statuslineUsageCached(), limits = readLimits() } = {}) {
  const segments = prefs.follow ? cfg.segments : prefs.segments;
  return {
    prefs,
    sep: cfg.sep,
    lang: cfg.lang,
    items: formatStrip({ segments, lang: cfg.lang }, usage, limits),
    available: SEGMENTS.filter((s) => LIVE.includes(s.id)).map((s) => ({ id: s.id, name: s[cfg.lang] || s.en })),
    followed: cfg.segments.filter((s) => LIVE.includes(s)),
  };
}
