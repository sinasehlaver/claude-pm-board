import { useEffect, useState } from "react";
import { get, send } from "./api";
import { confirmDialog } from "./dialog.jsx";

function Row({ v, reload }) {
  const [val, setVal] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [off, setOff] = useState([]); // unchecked files
  const files = v.files.map((f) => f.file).filter((f) => !off.includes(f));
  const toggle = (f) => setOff(off.includes(f) ? off.filter((x) => x !== f) : [...off, f]);
  const run = async () => {
    setBusy(true);
    setMsg("");
    try {
      const pre = await send("POST", "/envs/update", { name: v.name, value: val, files, dryRun: true });
      const list = pre.files.filter((f) => f.changed).map((f) => f.file);
      if (!list.length) setMsg("already that value everywhere");
      else if (await confirmDialog({ title: `Update ${v.name}?`, body: `${list.length} files:\n${list.join("\n")}\n\n(each gets a .bak-<ts> copy)`, confirmLabel: "Update" })) {
        const r = await send("POST", "/envs/update", { name: v.name, value: val, files });
        setMsg(`updated ${r.changed} files`);
        setVal("");
        reload();
      }
    } catch (e) {
      setMsg(e.message);
    }
    setBusy(false);
  };
  return (
    <section className="block">
      <div
        className="block-head env-head"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), setOpen(!open))}
      >
        <span className="block-head-title">
          <span className={`env-chevron${open ? " open" : ""}`}>▸</span>
          <h2>{v.name}</h2>
          <span className="muted">
            {v.files.length} files · {v.distinct} distinct value{v.distinct > 1 ? "s" : ""}
          </span>
        </span>
      </div>
      {open && (
        <>
          <table className="doc-table">
            <tbody>
              {v.files.map((f) => (
                <tr key={f.file}>
                  <td>
                    <label>
                      <input className="envchk" type="checkbox" checked={!off.includes(f.file)} onChange={() => toggle(f.file)} /> {f.file}
                    </label>
                  </td>
                  <td>
                    <code>{f.mask}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="block-head">
            <button className="link" onClick={() => setOff([])}>Select all</button>
            <button className="link" onClick={() => setOff(v.files.map((f) => f.file))}>Deselect all</button>
            <span className="muted">{files.length}/{v.files.length} selected</span>
          </div>
          <div className="block-head">
            <input
              className="env-input env-grow"
              type="password"
              autoComplete="off"
              placeholder={`new ${v.name}`}
              value={val}
              onChange={(e) => setVal(e.target.value)}
            />
            <button className="link" disabled={busy || !val || !files.length} onClick={run}>
              Update {files.length} file{files.length === 1 ? "" : "s"}
            </button>
            {msg && <span className="muted">{msg}</span>}
          </div>
        </>
      )}
    </section>
  );
}

export default function Envs({ onBack }) {
  const [vars, setVars] = useState(null);
  const [error, setError] = useState("");
  const [q, setQ] = useState("");
  const load = () =>
    get("/envs")
      .then((d) => (d.vars ? setVars(d.vars) : setError(d.error || "could not scan")))
      .catch((e) => setError(e.message));
  useEffect(() => {
    load();
  }, []);
  const shown = (vars || []).filter((v) => v.name.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="screen">
      <header className="bar">
        <button className="back" onClick={onBack}>
          ‹
        </button>
        <h1>Env Manager</h1>
        <input className="env-input" placeholder="filter vars" value={q} onChange={(e) => setQ(e.target.value)} />
      </header>
      {error && <p className="muted pad">{error}</p>}
      {!vars && !error && <p className="muted pad">Scanning…</p>}
      {shown.map((v) => (
        <Row key={v.name} v={v} reload={load} />
      ))}
    </div>
  );
}
