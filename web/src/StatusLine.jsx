import { useEffect, useState } from "react";
import { get, send } from "./api";

// Status line builder (Setup card): pick segments, order, label language; pm writes the script
// and points Claude Code at it on request. Server: server/statusline.mjs.
export default function StatusLine() {
  const [s, setS] = useState(null);
  const [cfg, setCfg] = useState(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const take = (d) => {
    setS(d);
    setCfg(d.config);
  };
  useEffect(() => {
    get("/statusline").then(take).catch((e) => setMsg(e.message));
  }, []);
  if (!s || !cfg) return <li className="doc-card"><p className="doc-suggest muted">{msg || "Loading status line…"}</p></li>;

  const byId = Object.fromEntries(s.segments.map((x) => [x.id, x]));
  const on = cfg.segments;
  const order = [...on, ...s.segments.map((x) => x.id).filter((id) => !on.includes(id))];
  const set = (patch) => setCfg({ ...cfg, ...patch });
  const toggle = (id) => set({ segments: on.includes(id) ? on.filter((x) => x !== id) : [...on, id] });
  const move = (id, d) => {
    const i = on.indexOf(id), j = i + d;
    if (i < 0 || j < 0 || j >= on.length) return;
    const n = [...on];
    [n[i], n[j]] = [n[j], n[i]];
    set({ segments: n });
  };
  const sample = (x) => (typeof x.sample === "object" ? x.sample[cfg.lang] : x.sample);
  const preview = on.map((id) => byId[id]).map((x) => (x.label ? x.label[cfg.lang] + " " : "") + sample(x)).join(cfg.sep);
  const needsPy = on.some((id) => byId[id].spend);
  const dirty = JSON.stringify(cfg) !== JSON.stringify(s.config);

  const act = async (fn, ok) => {
    setBusy(true);
    setMsg("");
    try {
      take(await fn());
      setMsg(ok);
    } catch (e) {
      setMsg(e.message);
    } finally {
      setBusy(false);
    }
  };
  const save = (apply) =>
    act(() => send("PUT", "/statusline", { ...cfg, apply }), apply || !s.current ? "Saved. Claude Code shows it from the next refresh." : "Saved the script. Claude Code still uses your own status line.");
  const restore = () => act(() => send("POST", "/statusline/restore"), "Restored your previous status line.");

  return (
    <li className="doc-card">
      <div className="doc-card-head" style={{ cursor: "default" }}>
        <span className="doc-title">Status line</span>
      </div>
      <p className="doc-suggest muted">
        The one-line bar under Claude Code's prompt. Pick what it shows; pm writes <code>{s.script}</code> and you can change it here any time.
      </p>
      <p className="doc-suggest">
        Claude Code now uses:{" "}
        {s.usesPm ? <b>this status line</b> : s.current ? <><b>your own</b> <code>{s.current}</code></> : <b>none</b>}
      </p>
      <div className="sl-preview" aria-label="Preview">{preview || <span className="muted">(empty)</span>}</div>
      <div className="seg" style={{ maxWidth: 200 }}>
        {["en", "tr"].map((l) => (
          <button key={l} className={cfg.lang === l ? "on" : ""} onClick={() => set({ lang: l })}>
            {l === "en" ? "English" : "Türkçe"}
          </button>
        ))}
      </div>
      <ul className="sl-list">
        {order.map((id) => {
          const x = byId[id], i = on.indexOf(id);
          return (
            <li key={id} className={i < 0 ? "muted" : ""}>
              <label className="row">
                <input type="checkbox" checked={i >= 0} onChange={() => toggle(id)} /> {x[cfg.lang]}
                <span className="muted small">{(x.label ? x.label[cfg.lang] + " " : "") + sample(x)}</span>
              </label>
              {i >= 0 && (
                <span className="sl-move">
                  <button className="link" disabled={i === 0} onClick={() => move(id, -1)} aria-label={`Move ${x.en} left`}>↑</button>
                  <button className="link" disabled={i === on.length - 1} onClick={() => move(id, 1)} aria-label={`Move ${x.en} right`}>↓</button>
                </span>
              )}
            </li>
          );
        })}
      </ul>
      <label className="row">
        Separator <input className="sl-sep" value={cfg.sep} maxLength={8} onChange={(e) => set({ sep: e.target.value })} />
      </label>
      <label className="row" title={s.rateLimitsFile}>
        <input type="checkbox" checked={cfg.saveLimits} onChange={(e) => set({ saveLimits: e.target.checked })} /> Also save rate limits for Fill (keeps its quota live between runs)
      </label>
      {(!s.deps.jq || (needsPy && !s.deps.python3)) && (
        <p className="doc-suggest" style={{ color: "var(--bad)" }}>
          Needs {[!s.deps.jq && "jq", needsPy && !s.deps.python3 && "python3"].filter(Boolean).join(" and ")}: <code>brew install jq python3</code>
        </p>
      )}
      <div className="doc-actions">
        <button className="build" disabled={busy || cfg.sep === ""} onClick={() => save(false)}>
          {dirty ? "Save" : "Rewrite script"}
        </button>
        {!s.usesPm && s.current && (
          <button className="link" disabled={busy || cfg.sep === ""} onClick={() => save(true)} title="settings.json is backed up first; Restore puts yours back">
            Save &amp; use in Claude Code
          </button>
        )}
        {s.canRestore && (
          <button className="link" disabled={busy} onClick={restore}>
            Restore previous
          </button>
        )}
        {msg && <span className="muted">{msg}</span>}
      </div>
    </li>
  );
}
