import { useEffect, useRef, useState } from "react";
// Per-project color, picked from a swatch pane. Each swatch has its own dark- and
// light-theme shade; the choice is per-viewer (localStorage), like the other UI prefs.
const PALETTE = {
  blue: ["#5b9dff", "#1f69c9"],
  teal: ["#3fd0c0", "#0d8577"],
  green: ["#6fd47a", "#2a8a3a"],
  amber: ["#f0a94e", "#c47a0f"],
  red: ["#ff7a7a", "#c93a3a"],
  pink: ["#f78fc3", "#c23d86"],
  purple: ["#b497ff", "#6c47d1"],
  gray: ["#a3acb9", "#5d6673"],
};
const key = (slug) => "pm.color." + slug;

export function loadColor(slug) {
  try {
    const c = localStorage.getItem(key(slug));
    return PALETTE[c] ? c : "";
  } catch {
    return "";
  }
}

// className "pc" + this style => CSS picks --pc by theme (see app.css)
export const colorStyle = (name) => (PALETTE[name] ? { "--pc-d": PALETTE[name][0], "--pc-l": PALETTE[name][1] } : undefined);

// every slug gets its own hue unless the user picked a swatch (hash -> hue, one shade per theme)
export function slugStyle(slug, name) {
  if (PALETTE[name]) return colorStyle(name);
  let h = 0;
  for (const c of slug) h = (h * 31 + c.charCodeAt(0)) % 360;
  return { "--pc-d": `hsl(${h} 70% 65%)`, "--pc-l": `hsl(${h} 60% 42%)` };
}

export function ColorPane({ value, onChange, slug = "" }) {
  const [open, setOpen] = useState(false);
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
  return (
    <div className="color-pick" ref={ref}>
      <button
        className="swatch pc on"
        style={slugStyle(slug, value)}
        aria-haspopup="true"
        aria-expanded={open}
        aria-label="Project color"
        title="Project color"
        onClick={() => setOpen((o) => !o)}
      />
      {open && (
        <div className="color-pane" role="radiogroup" aria-label="Project color">
          {["", ...Object.keys(PALETTE)].map((n) => (
            <button
              key={n || "none"}
              role="radio"
              aria-checked={value === n}
              aria-label={n || "default"}
              title={n || "default"}
              className={"swatch pc" + (value === n ? " on" : "") + (n ? "" : " none")}
              style={colorStyle(n)}
              onClick={() => {
                onChange(n);
                setOpen(false);
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function saveColor(slug, name) {
  try {
    name ? localStorage.setItem(key(slug), name) : localStorage.removeItem(key(slug));
  } catch {}
}

// "#rrggbb" terminal background for this project: its card hue at ~14% brightness (readable text).
export function termBg(slug, name) {
  const hex = (r, g, b) => "#" + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
  if (PALETTE[name]) return hex(...[1, 3, 5].map((i) => parseInt(PALETTE[name][0].slice(i, i + 2), 16) * 0.14));
  let h = 0;
  for (const c of slug) h = (h * 31 + c.charCodeAt(0)) % 360;
  const [s, l] = [0.45, 0.095];
  const f = (n) => {
    const k = (n + h / 30) % 12;
    return 255 * (l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1)));
  };
  return hex(f(0), f(8), f(4));
}
