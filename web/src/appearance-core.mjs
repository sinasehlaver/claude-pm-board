// Pure logic for the Appearance panel: defaults, clamping, (de)serialising, and the CSS vars / data-attrs to apply.
export const APPEARANCE_KEY = "pm.appearance";

export const FONTS = {
  inter: { label: "Inter", text: '"Inter", -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif', display: '"Space Grotesk", "Inter", -apple-system, BlinkMacSystemFont, system-ui, sans-serif' },
  system: { label: "System", text: '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif', display: '-apple-system, BlinkMacSystemFont, "SF Pro Display", system-ui, sans-serif' },
  serif: { label: "Serif", text: 'Charter, "Iowan Old Style", Georgia, "Times New Roman", serif', display: 'Charter, "Iowan Old Style", Georgia, "Times New Roman", serif' },
  mono: { label: "Mono", text: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace', display: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace' },
};

export const DEFAULTS = Object.freeze({
  tint: 1, // project colour tint strength multiplier (0 = none)
  dim: 1, // background glow multiplier
  font: "inter",
  textScale: 1,
  density: "comfortable", // comfortable | compact
  radius: 1,
  accent: "", // "" = theme accent
  reduceMotion: false,
});

export const RANGES = {
  tint: [0, 2],
  dim: [0, 2],
  textScale: [0.85, 1.3],
  radius: [0, 1.8],
};

export const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const num = (v, key) => {
  const n = typeof v === "number" ? v : parseFloat(v);
  const [lo, hi] = RANGES[key];
  return Number.isFinite(n) ? clamp(n, lo, hi) : DEFAULTS[key];
};
export const isHex = (s) => typeof s === "string" && /^#[0-9a-f]{6}$/i.test(s);

// Any input (parsed JSON, garbage, null) -> a complete, valid settings object.
export function normalize(raw) {
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  return {
    tint: num(r.tint, "tint"),
    dim: num(r.dim, "dim"),
    font: Object.hasOwn(FONTS, r.font) ? r.font : DEFAULTS.font,
    textScale: num(r.textScale, "textScale"),
    density: r.density === "compact" ? "compact" : "comfortable",
    radius: num(r.radius, "radius"),
    accent: isHex(r.accent) ? r.accent.toLowerCase() : "",
    reduceMotion: r.reduceMotion === true,
  };
}

export function parse(text) {
  try {
    return normalize(JSON.parse(text));
  } catch {
    return normalize(null);
  }
}

// Only non-default values are stored, so a reset leaves nothing behind.
export function serialize(settings) {
  const s = normalize(settings);
  const out = {};
  for (const k of Object.keys(DEFAULTS)) if (s[k] !== DEFAULTS[k]) out[k] = s[k];
  return Object.keys(out).length ? JSON.stringify(out) : "";
}

export const isDefault = (settings) => serialize(settings) === "";

const rgba = (hex, a) => `rgba(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(", ")}, ${a})`;
const px = (n) => `${Math.round(n * 100) / 100}px`;
const BASE_RADII = { "--radius-xs": 8, "--radius-sm": 10, "--radius": 13, "--radius-lg": 17 };

// -> { vars: {name: value|null}, attrs: {name: value|null} }; null = remove, so defaults fall back to app.css.
export function toStyle(settings) {
  const s = normalize(settings);
  const vars = {
    "--tint": s.tint === 1 ? null : String(s.tint),
    "--dim": s.dim === 1 ? null : String(s.dim),
    "--text-scale": s.textScale === 1 ? null : String(s.textScale),
    "--font-text": s.font === "inter" ? null : FONTS[s.font].text,
    "--font-display": s.font === "inter" ? null : FONTS[s.font].display,
    "--accent": s.accent || null,
    "--accent-tint": s.accent ? rgba(s.accent, 0.17) : null,
    "--accent-ink": s.accent || null,
  };
  for (const [k, base] of Object.entries(BASE_RADII)) vars[k] = s.radius === 1 ? null : px(base * s.radius);
  return {
    vars,
    attrs: { "data-density": s.density === "compact" ? "compact" : null, "data-reduce-motion": s.reduceMotion ? "on" : null },
  };
}
