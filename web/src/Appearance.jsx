import { useState } from "react";
import { APPEARANCE_KEY, DEFAULTS, FONTS, RANGES, isDefault, normalize, parse, serialize, toStyle } from "./appearance-core.mjs";

export function loadAppearance() {
  try {
    return parse(localStorage.getItem(APPEARANCE_KEY) || "");
  } catch {
    return normalize(null);
  }
}

export function applyAppearance(settings) {
  const { vars, attrs } = toStyle(settings);
  const el = document.documentElement;
  for (const [k, v] of Object.entries(vars)) v == null ? el.style.removeProperty(k) : el.style.setProperty(k, v);
  for (const [k, v] of Object.entries(attrs)) v == null ? el.removeAttribute(k) : el.setAttribute(k, v);
}

function Slider({ label, k, value, onChange, step = 0.05, fmt = (v) => Math.round(v * 100) + "%" }) {
  return (
    <label className="ap-row">
      <span>{label}</span>
      <input type="range" min={RANGES[k][0]} max={RANGES[k][1]} step={step} value={value} onChange={(e) => onChange(k, parseFloat(e.target.value))} />
      <span className="muted small ap-val">{fmt(value)}</span>
    </label>
  );
}

export default function AppearancePanel({ onClose }) {
  const [s, setS] = useState(loadAppearance);
  const set = (patch) => {
    const next = normalize({ ...s, ...patch });
    setS(next);
    applyAppearance(next);
    try {
      const out = serialize(next);
      out ? localStorage.setItem(APPEARANCE_KEY, out) : localStorage.removeItem(APPEARANCE_KEY);
    } catch {}
  };
  const num = (k, v) => set({ [k]: v });
  return (
    <div className="sheet-backdrop" onClick={onClose} onKeyDown={(e) => e.key === "Escape" && onClose()}>
      <div className="sheet ap-sheet" role="dialog" aria-modal="true" aria-label="Appearance" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <h2>Appearance</h2>
          <button className="link" onClick={onClose} autoFocus>done</button>
        </div>
        <fieldset className="form-group">
          <legend className="muted small">Colour</legend>
          <Slider label="Project tint" k="tint" value={s.tint} onChange={num} />
          <Slider label="Background glow" k="dim" value={s.dim} onChange={num} />
          <div className="ap-row">
            <span>Accent</span>
            <span className="ap-inline">
              <input type="color" aria-label="Accent colour" value={s.accent || "#5b9dff"} onChange={(e) => set({ accent: e.target.value })} />
              <button className="link" disabled={!s.accent} onClick={() => set({ accent: "" })}>theme default</button>
            </span>
          </div>
        </fieldset>
        <fieldset className="form-group">
          <legend className="muted small">Text</legend>
          <div className="ap-row">
            <span>Font</span>
            <select value={s.font} onChange={(e) => set({ font: e.target.value })} aria-label="Font">
              {Object.entries(FONTS).map(([k, f]) => <option key={k} value={k}>{f.label}</option>)}
            </select>
          </div>
          <Slider label="Text size" k="textScale" value={s.textScale} onChange={num} step={0.05} />
        </fieldset>
        <fieldset className="form-group">
          <legend className="muted small">Layout</legend>
          <div className="ap-row">
            <span>Density</span>
            <select value={s.density} onChange={(e) => set({ density: e.target.value })} aria-label="Density">
              <option value="comfortable">Comfortable</option>
              <option value="compact">Compact</option>
            </select>
          </div>
          <Slider label="Corner radius" k="radius" value={s.radius} onChange={num} />
          <label className="ap-row">
            <span>Reduce motion</span>
            <input type="checkbox" checked={s.reduceMotion} onChange={(e) => set({ reduceMotion: e.target.checked })} />
          </label>
        </fieldset>
        <div className="ap-foot">
          <button className="link" disabled={isDefault(s)} onClick={() => set(DEFAULTS)}>Reset to defaults</button>
        </div>
      </div>
    </div>
  );
}
