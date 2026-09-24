import { useState } from "react";
import { ago, send } from "./api";

const NEW = "__new__";

export default function Sessions({ data, projects, onBack, reload }) {
  const [showFiled, setShowFiled] = useState(false);
  const slugs = projects.map((p) => p.slug);
  const inbox = data.inbox || [];
  const filed = data.filed || [];

  return (
    <div className="screen">
      <header className="bar">
        <button className="back" onClick={onBack}>
          ‹
        </button>
        <h1>Sessions</h1>
        <span style={{ width: 32 }} />
      </header>

      <section className="block">
        <div className="block-head">
          <h2>Inbox ({inbox.length})</h2>
        </div>
        {inbox.length === 0 && <p className="muted">Nothing to file.</p>}
        {inbox.map((s) => (
          <Row key={s.id} s={s} slugs={slugs} reload={reload} />
        ))}
      </section>

      <section className="block">
        <div className="block-head">
          <button className="link" onClick={() => setShowFiled((v) => !v)}>
            {showFiled ? "▾" : "▸"} Filed ({filed.length})
          </button>
        </div>
        {showFiled &&
          filed.map((s) => (
            <Row key={s.id} s={s} slugs={slugs} reload={reload} filed />
          ))}
      </section>
    </div>
  );
}

function Row({ s, slugs, reload, filed }) {
  const [pick, setPick] = useState(s.project || "");
  const [name, setName] = useState("");
  const isNew = pick === NEW;
  const create = () => call("POST", `/sessions/${s.id}/new-project`, { name });
  const call = async (method, path, body) => {
    try {
      await send(method, path, body);
      reload();
    } catch (e) {
      alert(e.message);
    }
  };
  return (
    <div className="task">
      <div className="task-main">
        <span className="ttitle" style={{ cursor: "default" }}>
          {s.title}
        </span>
        <span className="d">{ago(s.start)}</span>
      </div>
      {s.firstAsk && <div className="tnote clamp">{s.firstAsk}</div>}
      <div className="chips">
        <span className="muted small">
          {s.mins}m · {s.msgs} msg
        </span>
        {s.touched.map((t) => (
          <span key={t} className="tag">
            {t}
          </span>
        ))}
      </div>
      <div className="srow">
        <select value={pick} onChange={(e) => setPick(e.target.value)}>
          <option value="">— project —</option>
          {slugs.map((sl) => (
            <option key={sl} value={sl}>
              {sl}
            </option>
          ))}
          <option value={NEW}>+ New project…</option>
        </select>
        {isNew ? (
          <>
            <input
              value={name}
              placeholder="new project name"
              autoFocus
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && name.trim() && create()}
            />
            <button disabled={!name.trim()} onClick={create}>
              create + file
            </button>
          </>
        ) : (
          <>
            <button
              disabled={!pick}
              onClick={() => call("PUT", `/sessions/${s.id}`, { project: pick })}
            >
              file
            </button>
            <button
              disabled={!pick}
              onClick={() => call("POST", `/sessions/${s.id}/task`, { project: pick })}
            >
              → task
            </button>
          </>
        )}
        <button onClick={() => call("POST", `/sessions/${s.id}/resume`)}>reopen</button>
        {!filed && (
          <button onClick={() => call("PUT", `/sessions/${s.id}`, { archived: true })}>
            archive
          </button>
        )}
      </div>
    </div>
  );
}
