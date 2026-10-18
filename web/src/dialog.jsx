// In-app replacements for window.confirm / prompt / alert. Never call the browser primitives.
//   if (await confirmDialog({ title, body, confirmLabel, danger })) ...
//   const v = await promptDialog({ title, label, value, options? })   // null when cancelled
//   await alertDialog(message)
import { useEffect, useRef, useState } from "react";

let push = null;
const open = (spec) => new Promise((resolve) => (push ? push({ ...spec, resolve }) : resolve(spec.kind === "confirm" ? false : null)));

export const confirmDialog = (o) => open({ kind: "confirm", ...o });
export const promptDialog = (o) => open({ kind: "prompt", ...o });
export const alertDialog = (message) => open({ kind: "alert", title: "Heads up", body: String(message) });

export function DialogHost() {
  const [d, setD] = useState(null);
  const [val, setVal] = useState("");
  const field = useRef(null);
  const okBtn = useRef(null);
  useEffect(() => {
    push = (spec) => {
      setVal(spec.value ?? spec.options?.[0] ?? "");
      setD(spec);
    };
    return () => (push = null);
  }, []);
  useEffect(() => {
    if (d) (field.current || okBtn.current)?.focus();
  }, [d]);
  if (!d) return null;
  const done = (v) => {
    d.resolve(v);
    setD(null);
  };
  const cancel = () => done(d.kind === "confirm" ? false : null);
  const ok = () => done(d.kind === "confirm" ? true : d.kind === "prompt" ? val : true);
  return (
    <div className="sheet-backdrop dlg-backdrop" onMouseDown={(e) => e.target === e.currentTarget && cancel()} onKeyDown={(e) => e.key === "Escape" && cancel()}>
      <div className="sheet dlg" role="dialog" aria-modal="true" aria-label={d.title}>
        <div className="sheet-head">
          <h2>{d.title || (d.kind === "prompt" ? "Enter a value" : "Are you sure?")}</h2>
        </div>
        {d.body && <p className="dlg-body">{d.body}</p>}
        {d.kind === "prompt" && (
          <label className="dlg-field">
            {d.label && <span className="muted">{d.label}</span>}
            {d.options ? (
              <select ref={field} className="env-input" value={val} onChange={(e) => setVal(e.target.value)}>
                {d.options.map((o) => (
                  <option key={o}>{o}</option>
                ))}
              </select>
            ) : (
              <input ref={field} className="env-input" value={val} placeholder={d.placeholder} onChange={(e) => setVal(e.target.value)} onKeyDown={(e) => e.key === "Enter" && val.trim() && ok()} />
            )}
          </label>
        )}
        <div className="dlg-btns">
          {d.kind !== "alert" && (
            <button className="dlg-btn" onClick={cancel}>
              Cancel
            </button>
          )}
          <button ref={okBtn} className={"dlg-btn primary" + (d.danger ? " danger" : "")} disabled={d.kind === "prompt" && !val.trim()} onClick={ok}>
            {d.confirmLabel || (d.kind === "alert" ? "OK" : d.kind === "prompt" ? "Save" : "Confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}
