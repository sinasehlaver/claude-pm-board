import { useEffect, useState } from "react";
import { get, send, ago } from "./api";
import Help from "./Help.jsx";

const k = (n) => (n == null ? "—" : n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1000 ? Math.round(n / 1000) + "k" : String(n));

function Evidence({ ev }) {
  const rows = Object.entries(ev || {}).filter(([, v]) => v != null && !(Array.isArray(v) && !v.length));
  return (
    <dl className="doc-ev">
      {rows.map(([key, v]) => (
        <div key={key}>
          <dt>{key}</dt>
          <dd>{Array.isArray(v) ? v.map((x) => (typeof x === "object" ? JSON.stringify(x) : String(x))).join(", ") : typeof v === "object" ? JSON.stringify(v) : typeof v === "number" ? k(v) : String(v)}</dd>
        </div>
      ))}
    </dl>
  );
}

function Finding({ f }) {
  const [open, setOpen] = useState(f.severity === "high");
  const [state, setState] = useState("idle");
  const [msg, setMsg] = useState("");
  const fix = async () => {
    setState("busy");
    setMsg("");
    try {
      await send("POST", `/doctor/findings/${encodeURIComponent(f.id)}/fix`);
      setState("done");
    } catch (e) {
      setState("idle");
      setMsg(e.message);
    }
  };
  return (
    <li className={"doc-card sev-" + f.severity}>
      <button className="doc-card-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className={"doc-sev sev-" + f.severity}>{f.severity}</span>
        <span className="doc-title">{f.title}</span>
        <span className="doc-target">{f.target}</span>
      </button>
      <p className="doc-suggest">{f.suggestion}</p>
      {open && <Evidence ev={f.evidence} />}
      {f.severity !== "info" && (
        <div className="doc-actions">
          <button className="link" onClick={fix} disabled={state === "busy"} title="Opens a Claude Code session that asks you questions, then fixes it">
            {state === "busy" ? "Opening…" : state === "done" ? "Opened — again?" : "💬 Fix with Claude"}
          </button>
          {msg && <span className="doc-err">{msg}</span>}
        </div>
      )}
    </li>
  );
}

export default function Doctor({ onBack }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    get("/doctor").then(setData).catch((e) => setErr(String(e.message || e)));
  }, []);

  const run = async () => {
    setBusy(true);
    setErr("");
    try {
      setData(await send("POST", "/doctor/run"));
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const findings = data?.findings || [];
  return (
    <div className="screen">
      <header className="bar">
        <button className="back" onClick={onBack}>
          ‹
        </button>
        <h1>Doctor</h1>
        <button className="link" onClick={run} disabled={busy}>
          {busy ? "Scanning…" : "Scan now"}
        </button>
      </header>

      <section className="block">
        <div className="block-head">
          <span className="block-head-title">
            <h2>Efficiency findings</h2>
            <Help text="LLM-free scan of this workspace's Claude Code transcripts (incl. subagents): errors, token hogs, and suggested fixes. Suggestions only — nothing is edited. Runs on a timer (PM_DOCTOR_INTERVAL_MIN, default 360; 0 = off)." />
          </span>
          <span className="muted">{data?.generatedAt ? `scanned ${ago(data.generatedAt)} · last ${data.windowDays}d` : "never scanned"}</span>
        </div>
        {err && <p className="doc-err">{err}</p>}
        {!data?.generatedAt && !busy && <p className="muted doc-empty">No scan yet — press “Scan now”.</p>}
        {data?.generatedAt && (
          <p className="muted doc-sum">
            {data.scope.sessions} sessions · {k(data.totals.tokens)} tokens · {data.totals.errors} tool errors
          </p>
        )}
        <ul className="doc-list">
          {findings.map((f) => (
            <Finding key={f.id} f={f} />
          ))}
        </ul>
      </section>

      {data?.topSessions?.length > 0 && (
        <section className="block">
          <div className="block-head">
            <span className="block-head-title">
              <h2>Top sessions</h2>
            </span>
          </div>
          <table className="doc-table">
            <thead>
              <tr>
                <th>Session</th>
                <th>Tokens</th>
                <th>Turns</th>
                <th>Sub</th>
                <th>Err</th>
              </tr>
            </thead>
            <tbody>
              {data.topSessions.map((s) => (
                <tr key={s.id}>
                  <td title={s.id}>{s.title || s.id.slice(0, 8)}</td>
                  <td>{k(s.tokens)}</td>
                  <td>{s.turns}</td>
                  <td>{k(s.subagentTokens)}</td>
                  <td>{s.errors}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {data?.topTools?.length > 0 && (
        <section className="block">
          <div className="block-head">
            <span className="block-head-title">
              <h2>Top tools by result size</h2>
            </span>
          </div>
          <table className="doc-table">
            <thead>
              <tr>
                <th>Tool</th>
                <th>Chars</th>
                <th>Calls</th>
                <th>Err</th>
              </tr>
            </thead>
            <tbody>
              {data.topTools.map((t) => (
                <tr key={t.name}>
                  <td>{t.name}</td>
                  <td>{k(t.resultChars)}</td>
                  <td>{t.calls}</td>
                  <td>{t.errors}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
