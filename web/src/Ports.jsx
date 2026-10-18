import { useEffect, useState } from "react";
import { get, send } from "./api";
import { confirmDialog } from "./dialog.jsx";

export default function Ports({ onBack }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState("");
  const [q, setQ] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(0);
  const load = () =>
    get("/ports")
      .then((d) => (d.ports ? (setRows(d.ports), setError("")) : setError(d.error || "could not list ports")))
      .catch((e) => setError(e.message));
  useEffect(() => {
    load();
  }, []);
  const stop = async (r) => {
    if (!(await confirmDialog({ title: "Stop process?", body: `Stop ${r.command}${r.project ? ` of project "${r.project}"` : ""} (pid ${r.pid}) listening on port ${r.port}?\n\nIt gets SIGTERM; unsaved work in it may be lost.`, confirmLabel: "Stop", danger: true }))) return;
    setBusy(r.pid);
    setMsg("");
    try {
      await send("POST", "/ports/kill", { pid: r.pid, port: r.port });
      setMsg(`sent stop to ${r.command} (${r.pid})`);
      setTimeout(load, 600);
    } catch (e) {
      setMsg(e.message);
    }
    setBusy(0);
  };
  const needle = q.toLowerCase();
  const shown = (rows || []).filter((r) => !needle || `${r.port} ${r.command} ${r.pid} ${r.project || ""} ${r.cwd}`.toLowerCase().includes(needle));
  return (
    <div className="screen">
      <header className="bar">
        <button className="back" onClick={onBack}>
          ‹
        </button>
        <h1>Ports</h1>
        <input className="env-input" placeholder="filter port / process" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="link" onClick={load}>
          Refresh
        </button>
      </header>
      {error && <p className="muted pad">{error}</p>}
      {msg && <p className="muted pad">{msg}</p>}
      {!rows && !error && <p className="muted pad">Scanning…</p>}
      {rows && (
        <section className="block">
          <table className="doc-table">
            <thead>
              <tr>
                <th>Port</th>
                <th>Process</th>
                <th>Project</th>
                <th>PID</th>
                <th>Bound to</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.pid + ":" + r.port}>
                  <td>
                    <code>{r.port}</code>
                  </td>
                  <td>{r.command}</td>
                  <td title={r.cwd}>{r.project || <span className="muted">{r.cwd ? r.cwd.split("/").slice(-2).join("/") : "—"}</span>}</td>
                  <td>{r.pid}</td>
                  <td className="muted">{r.address}</td>
                  <td>
                    {r.self ? (
                      <span className="muted">this board</span>
                    ) : r.killable ? (
                      <button className="link" disabled={busy === r.pid} onClick={() => stop(r)}>
                        Stop
                      </button>
                    ) : (
                      <span className="muted">{r.user}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!shown.length && <p className="muted pad">No listening ports.</p>}
        </section>
      )}
    </div>
  );
}
