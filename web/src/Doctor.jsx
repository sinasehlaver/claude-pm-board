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

const VERIFY_LABEL = { fixed: "✓ Not seen since the fix", still: "✗ Still happening after the fix", "no-data": "No sessions since the fix — run some work, then check again" };
const STATUS_LABEL = { fixing: "in progress", done: "done", dismissed: "dismissed" };

function Finding({ f, onStatus }) {
  const [open, setOpen] = useState(f.severity === "high");
  const [state, setState] = useState("idle");
  const [msg, setMsg] = useState("");
  const [note, setNote] = useState(f.note || "");
  const [checking, setChecking] = useState(false);
  const tracked = f.status === "fixing" || f.status === "done";
  const saveNote = async () => {
    if (note.trim() === (f.note || "")) return;
    setMsg("");
    try {
      await send("POST", `/doctor/findings/${encodeURIComponent(f.id)}/status`, { status: f.status, note });
      onStatus(f.id, f.status, { note: note.trim() || undefined });
    } catch (e) {
      setMsg(e.message);
    }
  };
  const verify = async () => {
    setChecking(true);
    setMsg("");
    try {
      const v = await send("POST", `/doctor/findings/${encodeURIComponent(f.id)}/verify`);
      onStatus(f.id, f.status, { verify: { at: v.at, result: v.result, sessions: v.sessions } });
    } catch (e) {
      setMsg(e.message);
    }
    setChecking(false);
  };
  const mark = async (status) => {
    setMsg("");
    try {
      await send("POST", `/doctor/findings/${encodeURIComponent(f.id)}/status`, { status });
      onStatus(f.id, status);
    } catch (e) {
      setMsg(e.message);
    }
  };
  const fix = async () => {
    setState("busy");
    setMsg("");
    try {
      await send("POST", `/doctor/findings/${encodeURIComponent(f.id)}/fix`);
      onStatus(f.id, f.status === "done" || f.status === "dismissed" ? f.status : "fixing");
      setState("done");
    } catch (e) {
      setState("idle");
      setMsg(e.message);
    }
  };
  return (
    <li className={"doc-card sev-" + f.severity + (f.status === "done" || f.status === "dismissed" ? " is-resolved" : "")}>
      <button className="doc-card-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className={"doc-sev sev-" + f.severity}>{f.severity}</span>
        <span className="doc-title">{f.title}</span>
        {f.status && <span className={"doc-status st-" + f.status}>{STATUS_LABEL[f.status]}</span>}
        <span className="doc-target">{f.target}</span>
      </button>
      <p className="doc-suggest">{f.suggestion}</p>
      {tracked && (
        <div className="doc-fix">
          <label className="doc-fix-label" htmlFor={"fixnote-" + f.id}>Fix</label>
          <textarea
            id={"fixnote-" + f.id}
            className="doc-fix-note"
            rows={2}
            maxLength={500}
            placeholder="What was changed to fix this?"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onBlur={saveNote}
          />
          {f.verify && (
            <p className={"doc-verify vf-" + f.verify.result}>
              {VERIFY_LABEL[f.verify.result]} · checked {new Date(f.verify.at).toLocaleString()} ({f.verify.sessions} session{f.verify.sessions === 1 ? "" : "s"} since the fix)
            </p>
          )}
        </div>
      )}
      {open && <Evidence ev={f.evidence} />}
      {f.severity !== "info" && (
        <div className="doc-actions">
          <button className="link" onClick={fix} disabled={state === "busy"} title="Opens a Claude Code session that asks you questions, then fixes it">
            {state === "busy" ? "Opening…" : state === "done" ? "Opened — again?" : "💬 Fix with Claude"}
          </button>
          {tracked && (
            <button className="link" onClick={verify} disabled={checking} title="Rescans only sessions after the fix was recorded">
              {checking ? "Checking…" : f.verify ? "↻ Verify again" : "✓ Verify fix"}
            </button>
          )}
          {f.status === "fixing" && (
            <>
              <button className="link" onClick={() => mark("done")}>✓ Mark done</button>
              <button className="link" onClick={() => mark("dismissed")}>Dismiss</button>
            </>
          )}
          {!f.status && <button className="link" onClick={() => mark("dismissed")}>Dismiss</button>}
          {(f.status === "done" || f.status === "dismissed") && <button className="link" onClick={() => mark("open")}>Reopen</button>}
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

  const setFindingStatus = (id, status, extra) =>
    setData((d) => ({
      ...d,
      findings: d.findings.map((x) =>
        x.id !== id ? x : status === "open" ? { ...x, status: undefined, note: undefined, verify: undefined } : { ...x, status, ...(x.status === status ? extra : { verify: undefined, ...extra }) },
      ),
    }));

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
            <Finding key={f.id} f={f} onStatus={setFindingStatus} />
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
