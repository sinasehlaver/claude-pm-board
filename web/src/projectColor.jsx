import { useEffect, useRef, useState } from "react";
// Per-project color: a named swatch or a custom "#rrggbb" from the editor. Each color has its own
// dark- and light-theme shade; the choice is per-viewer (localStorage), like the other UI prefs.
// Vibrant by design: every hue at high saturation (dark shade bright, light shade deep); gray is the one neutral.
const HUES = [
  ["red", 355], ["coral", 8], ["orange", 24], ["amber", 38], ["yellow", 50], ["lime", 84], ["chartreuse", 100],
  ["green", 130], ["emerald", 150], ["mint", 162], ["teal", 174], ["cyan", 186], ["sky", 198], ["blue", 214],
  ["indigo", 232], ["violet", 252], ["purple", 268], ["magenta", 292], ["fuchsia", 312], ["pink", 326], ["rose", 342],
];
const PALETTE = Object.fromEntries([
  ...HUES.map(([n, h]) => [n, [hslToHex(h, 100, h >= 210 && h <= 290 ? 70 : 62), hslToHex(h, 90, h >= 40 && h <= 110 ? 33 : 40)]]),
  ["gray", ["#a3acb9", "#5d6673"]],
]);
const HEX = /^#[0-9a-f]{6}$/i;
const key = (slug) => "pm.color." + slug;
const RECENT = "pm.colors.recent";
const valid = (c) => !!PALETTE[c] || HEX.test(c || "");

const hexes = (arr) => [...new Set(arr.filter((c) => HEX.test(c || "")).map((c) => c.toLowerCase()))];

function readRecent() {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT) || "[]");
    return Array.isArray(list) ? hexes(list) : [];
  } catch {
    return [];
  }
}

function writeRecent(list) {
  try {
    localStorage.setItem(RECENT, JSON.stringify(list.slice(0, 16)));
  } catch {}
}

// "Yours": custom colors you applied (newest first) plus any custom color a project uses now.
// In-use ones can't be removed (they'd come straight back).
function yourColors() {
  const inUse = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith("pm.color.")) inUse.push(localStorage.getItem(k));
    }
  } catch {}
  const used = new Set(hexes(inUse));
  return hexes([...readRecent(), ...used]).slice(0, 24).map((hex) => ({ hex, inUse: used.has(hex) }));
}

const rememberColor = (hex) => writeRecent(hexes([hex, ...readRecent()]));
const forgetColor = (hex) => writeRecent(readRecent().filter((c) => c !== hex));

export function loadColor(slug) {
  try {
    const c = localStorage.getItem(key(slug));
    return valid(c) ? c.toLowerCase() : "";
  } catch {
    return "";
  }
}

export function saveColor(slug, name) {
  try {
    valid(name) ? localStorage.setItem(key(slug), name) : localStorage.removeItem(key(slug));
  } catch {}
}

const hashHue = (slug) => {
  let h = 0;
  for (const c of slug) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
};

function hexToHsl(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min, l = (max + min) / 2;
  const s = d ? d / (1 - Math.abs(2 * l - 1)) : 0;
  const h = !d ? 0 : max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [Math.round(h * 60), Math.round(s * 100), Math.round(l * 100)];
}

function hslToHex(h, s, l) {
  s /= 100;
  l /= 100;
  const f = (n) => {
    const k = (n + h / 30) % 12;
    return 255 * (l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1)));
  };
  return "#" + [f(0), f(8), f(4)].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Custom hex -> [dark, light] shades: keep hue/saturation, pull lightness into a readable band per theme.
function customShades(hex) {
  const [h, s, l] = hexToHsl(hex);
  return [hslToHex(h, s, clamp(l, 55, 80)), hslToHex(h, s, clamp(l, 25, 42))];
}

function shades(name) {
  if (PALETTE[name]) return PALETTE[name];
  if (HEX.test(name || "")) return customShades(name);
  return null;
}

const styleOf = (pair) => ({ "--pc-d": pair[0], "--pc-l": pair[1] });

// className "pc" + this style => CSS picks --pc by theme (see app.css)
export const colorStyle = (name) => (shades(name) ? styleOf(shades(name)) : undefined);

// every slug gets its own hue unless the user picked a color (hash -> hue, one shade per theme)
export function slugStyle(slug, name) {
  if (shades(name)) return colorStyle(name);
  const h = hashHue(slug);
  return { "--pc-d": `hsl(${h} 100% 62%)`, "--pc-l": `hsl(${h} 90% 40%)` };
}

// "#rrggbb" terminal background for this project: its card hue at ~14% brightness (readable text).
export function termBg(slug, name) {
  const pair = shades(name);
  if (pair) {
    return "#" + [1, 3, 5].map((i) => Math.round(parseInt(pair[0].slice(i, i + 2), 16) * 0.14).toString(16).padStart(2, "0")).join("");
  }
  return hslToHex(hashHue(slug), 45, 9.5);
}

// The base color the editor starts from: the custom hex, the swatch's dark shade, or the slug hue.
const baseHex = (slug, value) => (HEX.test(value || "") ? value : PALETTE[value] ? PALETTE[value][0] : hslToHex(hashHue(slug), 100, 62));

function Editor({ slug, value, onChange }) {
  const [hsl, setHsl] = useState(() => hexToHsl(baseHex(slug, value)));
  const [text, setText] = useState(() => baseHex(slug, value));
  const hex = hslToHex(...hsl);
  const [d, l] = customShades(hex);
  const setFromHex = (h) => {
    setText(h);
    if (HEX.test(h)) setHsl(hexToHsl(h.toLowerCase()));
  };
  const slider = (i, label, max, track) => (
    <label className="ce-row">
      <span>{label}</span>
      <input
        type="range"
        min="0"
        max={max}
        value={hsl[i]}
        style={{ "--track": track }}
        aria-label={label}
        onChange={(e) => {
          const next = hsl.slice();
          next[i] = +e.target.value;
          setHsl(next);
          setText(hslToHex(...next));
        }}
      />
      <b>{hsl[i]}</b>
    </label>
  );
  const [h, s] = hsl;
  return (
    <div className="color-editor">
      {slider(0, "Hue", 359, "linear-gradient(90deg,#f00,#ff0,#0f0,#0ff,#00f,#f0f,#f00)")}
      {slider(1, "Saturation", 100, `linear-gradient(90deg,hsl(${h} 0% 50%),hsl(${h} 100% 50%))`)}
      {slider(2, "Lightness", 100, `linear-gradient(90deg,#000,hsl(${h} ${s}% 50%),#fff)`)}
      <div className="ce-hex">
        <input type="color" value={hex} aria-label="System color picker" onChange={(e) => setFromHex(e.target.value)} />
        <input
          className="env-input ce-text"
          value={text}
          maxLength={7}
          spellCheck={false}
          aria-label="Hex color"
          aria-invalid={!HEX.test(text)}
          onChange={(e) => setFromHex(e.target.value.trim().replace(/^([0-9a-f])/i, "#$1"))}
        />
      </div>
      <div className="ce-preview" aria-label="Preview">
        <span className="ce-chip dark" style={{ "--c": d }}>Dark</span>
        <span className="ce-chip light" style={{ "--c": l }}>Light</span>
        <span className="ce-chip term" style={{ "--c": termBg(slug, hex) }}>Terminal</span>
      </div>
      <div className="dlg-btns">
        <button className="dlg-btn" onClick={() => onChange(value, true)}>Cancel</button>
        <button className="dlg-btn primary" disabled={!HEX.test(text)} onClick={() => onChange(text.toLowerCase(), true)}>Use color</button>
      </div>
    </div>
  );
}

// align="left" opens the pane rightwards from the dot (for dots at a card's left edge).
export function ColorPane({ value, onChange, slug = "", align = "right" }) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const down = (e) => ref.current && !ref.current.contains(e.target) && setOpen(false);
    const key = (e) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key);
    };
  }, [open]);
  const pick = (n) => {
    onChange(n);
    setOpen(false);
  };
  const [yours, setYours] = useState([]);
  useEffect(() => {
    if (open) setYours(yourColors());
  }, [open, value]);
  return (
    <div className={"color-pick" + (open ? " open" : "") + (align === "left" ? " left" : "")} ref={ref}>
      <button
        className="swatch pc on"
        style={slugStyle(slug, value)}
        aria-haspopup="true"
        aria-expanded={open}
        aria-label="Project color"
        title="Project color"
        onClick={() => {
          setEditing(false);
          setOpen((o) => !o);
        }}
      />
      {open && (
        <div className="color-pane">
          <div className="color-grid" role="radiogroup" aria-label="Project color">
            {["", ...Object.keys(PALETTE)].map((n) => (
              <button
                key={n || "none"}
                role="radio"
                aria-checked={value === n}
                aria-label={n || "default"}
                title={n || "default (from the project name)"}
                className={"swatch pc" + (value === n ? " on" : "") + (n ? "" : " none")}
                style={colorStyle(n)}
                onClick={() => pick(n)}
              />
            ))}
            <button
              aria-label="new custom color"
              aria-expanded={editing}
              title="New custom color…"
              className={"swatch custom" + (editing ? " on" : "")}
              onClick={() => setEditing((e) => !e)}
            />
          </div>
          {yours.length > 0 && (
            <>
              <div className="color-sub">Yours</div>
              <div className="color-grid" role="radiogroup" aria-label="Your colors">
                {yours.map(({ hex, inUse }) => (
                  <span key={hex} className="your-swatch">
                    <button
                      role="radio"
                      aria-checked={value === hex}
                      aria-label={hex}
                      title={hex + (inUse ? " (in use by a project)" : "")}
                      className={"swatch pc" + (value === hex ? " on" : "")}
                      style={colorStyle(hex)}
                      onClick={() => pick(hex)}
                    />
                    {!inUse && (
                      <button
                        className="your-x"
                        aria-label={`Remove ${hex}`}
                        title="Remove from your colors"
                        onClick={() => {
                          forgetColor(hex);
                          setYours(yourColors());
                        }}
                      >
                        ×
                      </button>
                    )}
                  </span>
                ))}
              </div>
            </>
          )}
          {editing && (
            <Editor
              slug={slug}
              value={value}
              onChange={(n, close) => {
                setEditing(false);
                if (HEX.test(n || "")) rememberColor(n);
                if (n !== value) onChange(n);
                if (close && n !== value) setOpen(false);
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}
