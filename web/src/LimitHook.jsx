import { useEffect, useState } from "react";
import { get, send } from "./api";

// Setup card: toggles the usage-limit handoff hook in Claude Code's settings.json.
// Server: server/limit-hook.mjs, hook script: hooks/limit-handoff.mjs.
export default function LimitHook() {
  const [s, setS] = useState(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    get("/limit-hook").then(setS).catch((e) => setMsg(e.message));
  }, []);
  const flip = async (on) => {
    setBusy(true);
    setMsg("");
    try {
      setS(await send("PUT", "/limit-hook", { on }));
      setMsg(on ? "On. New Claude Code sessions pick it up." : "Off.");
    } catch (e) {
      setMsg(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="doc-card">
      <div className="doc-card-head" style={{ cursor: "default" }}>
        <span className="doc-title">Handoff before usage limit</span>
      </div>
      <p className="doc-suggest muted">
        When the 5h window hits 90% (or weekly 95%), the session is told once to write a handoff so you continue fresh after the reset. Needs the status line to save rate limits (see above).
      </p>
      <label className="row">
        <input type="checkbox" checked={!!s?.on} disabled={busy || !s} onChange={(e) => flip(e.target.checked)} /> Add the hook to Claude Code
      </label>
      {msg && <p className="doc-suggest muted">{msg}</p>}
    </li>
  );
}
