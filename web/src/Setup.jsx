import { useEffect, useState } from "react";
import { get, send } from "./api";
import ModelPick from "./ModelPick.jsx";
import StatusLine from "./StatusLine.jsx";
import ClaudeConfig from "./ClaudeConfig.jsx";

// Launch setup: environment checks + which Claude Code binary pm opens sessions with.
// Shown automatically on first run (no .claude/pm/prefs.json yet).
export default function Setup({ onBack, onSaved }) {
  const [s, setS] = useState(null);
  const [pick, setPick] = useState(null);
  const [msg, setMsg] = useState("");
  const load = () =>
    get("/setup")
      .then((d) => {
        setS(d);
        setPick(d.prefs.claudeBin ?? null);
      })
      .catch((e) => setMsg(e.message));
  useEffect(() => {
    load();
  }, []);
  const save = async () => {
    setMsg("");
    try {
      const d = await send("PUT", "/setup", { claudeBin: pick });
      setS(d);
      setMsg("Saved. New sessions use this setup.");
      onSaved?.(d);
    } catch (e) {
      setMsg(e.message);
    }
  };
  return (
    <div className="screen">
      <header className="bar">
        <button className="back" onClick={onBack}>
          ‹
        </button>
        <h1>Setup</h1>
        <button className="link" onClick={load}>
          Re-check
        </button>
      </header>
      {!s && !msg && <p className="muted pad">Checking…</p>}
      {s?.firstRun && <p className="pad">Welcome. Check that the items below are green, pick a Claude Code binary, then save.</p>}
      {s && (
        <ul className="doc-list">
          {s.checks.map((c) => (
            <li key={c.id} className="doc-card">
              <div className="doc-card-head" style={{ cursor: "default" }}>
                <span className={c.ok ? "doc-status st-done" : "doc-sev sev-high"}>{c.ok ? "✓" : "✗"}</span>
                <span className="doc-title">{c.title}</span>
              </div>
              <p className="doc-suggest muted">{c.detail}</p>
              {c.fix && <p className="doc-suggest">{c.fix}</p>}
            </li>
          ))}
          <li className="doc-card">
            <div className="doc-card-head" style={{ cursor: "default" }}>
              <span className="doc-title">Terminal</span>
            </div>
            <p className="doc-suggest muted">
              Sessions open in Terminal.app, tinted with the project color, and always run as native arm64 on Apple Silicon.
            </p>
          </li>
          <li className="doc-card">
            <div className="doc-card-head" style={{ cursor: "default" }}>
              <span className="doc-title">Claude Code binary</span>
            </div>
            <fieldset className="doc-fix" style={{ border: 0, padding: 0 }}>
              <label className="row">
                <input type="radio" name="bin" checked={pick === null} onChange={() => setPick(null)} /> First <code>claude</code> on PATH
              </label>
              {s.claudes.map((c) => (
                <label key={c.path} className="row" title={c.real}>
                  <input type="radio" name="bin" checked={pick === c.path} disabled={!c.ok} onChange={() => setPick(c.path)} />{" "}
                  <code>{c.path}</code> <span className="muted">v{c.version || "?"} · {c.archs.join(" ") || "?"}</span>
                  {!c.ok && <span className="doc-sev sev-high">{c.missing ? "arm64 package missing" : "won't run natively"}</span>}
                </label>
              ))}
            </fieldset>
            <div className="doc-actions">
              <button className="build" onClick={save}>
                Save
              </button>
              {msg && <span className="muted">{msg}</span>}
            </div>
          </li>
          <li className="doc-card">
            <div className="doc-card-head" style={{ cursor: "default" }}>
              <span className="doc-title">Model</span>
            </div>
            <p className="doc-suggest muted">Passed as --model to new sessions and unattended runs. Default = Claude Code's own choice.</p>
            <ModelPick />
          </li>
          <StatusLine />
          <ClaudeConfig />
        </ul>
      )}
    </div>
  );
}
