import { useState } from "react";
import { ago, send } from "./api";

export default function Home({ projects, inboxCount, onOpen, onSessions, onContinuous, reload }) {
  const [idea, setIdea] = useState("");

  async function addAdhoc() {
    const raw = prompt("New ad-hoc item — short slug (a-z, 0-9, -):");
    if (!raw) return;
    const slug = raw.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-");
    try {
      await send("POST", "/projects", { slug });
      reload();
      onOpen(slug);
    } catch (e) {
      alert(e.message);
    }
  }

  async function captureIdea(e) {
    e.preventDefault();
    if (!idea.trim()) return;
    try {
      await send("POST", "/projects/ideas/tasks", { title: idea.trim() });
      setIdea("");
      reload();
    } catch (e) {
      alert(e.message);
    }
  }

  const sorted = (projects || [])
    .slice()
    .sort(
      (a, b) =>
        Number(b.pinned) - Number(a.pinned) ||
        Number(b.blocked) - Number(a.blocked) ||
        String(b.lastActivity || "").localeCompare(String(a.lastActivity || "")),
    );

  return (
    <div className="screen">
      <header className="bar">
        <h1>Projects</h1>
        <div className="bar-actions">
          <button className="link" onClick={onContinuous}>
            Continuous
          </button>
          <button className="link" onClick={onSessions}>
            Sessions{inboxCount ? <span className="badge">{inboxCount}</span> : null}
          </button>
          <button className="add" onClick={addAdhoc}>
            +
          </button>
        </div>
      </header>

      <form className="capture" onSubmit={captureIdea}>
        <input
          placeholder="💡 capture an idea…"
          value={idea}
          onChange={(e) => setIdea(e.target.value)}
        />
      </form>

      {projects === null ? (
        <p className="muted pad">Loading…</p>
      ) : (
        <ul className="cards">
          {sorted.map((p) => (
            <li key={p.slug} className="card" onClick={() => onOpen(p.slug)}>
              <div className="card-top">
                <span className="title">
                  {p.pinned ? "💡 " : ""}
                  {p.title}
                  {p.adhoc && <span className="tag">ad-hoc</span>}
                </span>
                {p.blocked && <span className="dot" title="blocked" />}
              </div>
              <div className="status">
                {p.status || <em className="muted">no status</em>}
              </div>
              <div className="meta">
                <span>{p.openCount} open</span>
                <span>{ago(p.lastActivity)}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
