import { useState } from "react";
import { ago, send } from "./api";
import Help from "./Help.jsx";

const HIDDEN_KEY = "pm.hiddenSlugs";

function loadHidden() {
  try {
    const raw = localStorage.getItem(HIDDEN_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export default function Home({ projects, inboxCount, onOpen, onSessions, onContinuous, reload }) {
  const [idea, setIdea] = useState("");
  const [hidden, setHidden] = useState(loadHidden);
  const [showFilter, setShowFilter] = useState(false);

  function toggleHidden(slug) {
    setHidden((prev) => {
      const next = prev.includes(slug) ? prev.filter((s) => s !== slug) : [...prev, slug];
      localStorage.setItem(HIDDEN_KEY, JSON.stringify(next));
      return next;
    });
  }

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
  // pinned projects (e.g. ideas) always show, regardless of filter
  const visible = sorted.filter((p) => p.pinned || !hidden.includes(p.slug));

  return (
    <div className="screen">
      <header className="bar">
        <h1>Projects</h1>
        <div className="bar-actions">
          <span className="bar-item">
            <button className="link" onClick={onContinuous}>
              Continuous
            </button>
            <Help text="The autonomous runner that keeps working through a project's backlog on its own, without a live chat session." />
          </span>
          <span className="bar-item">
            <button className="link" onClick={onSessions}>
              Sessions{inboxCount ? <span className="badge">{inboxCount}</span> : null}
            </button>
            <Help text="Recent Claude Code conversations, sorted into ones you haven't filed yet (the inbox) and ones already linked to a project." />
          </span>
          <span className="bar-item">
            <button className={"link" + (hidden.length ? " active" : "")} onClick={() => setShowFilter(true)}>
              Filter{hidden.length ? <span className="badge">{hidden.length}</span> : null}
            </button>
            <Help text="Hide projects you don't want cluttering this list. Hidden projects still exist — you're just not seeing them here." />
          </span>
          <button className="add" onClick={addAdhoc} title="add an ad-hoc project">
            +
          </button>
        </div>
      </header>

      {showFilter && (
        <FilterSheet
          projects={sorted}
          hidden={hidden}
          onToggle={toggleHidden}
          onClose={() => setShowFilter(false)}
        />
      )}

      <form className="capture" onSubmit={captureIdea}>
        <div className="capture-row">
          <input
            placeholder="💡 capture an idea…"
            value={idea}
            onChange={(e) => setIdea(e.target.value)}
          />
          <Help
            text="Quick-drop a thought here without picking a project. It lands in the pinned Ideas list below, for sorting later."
            side="left"
          />
        </div>
      </form>

      {projects === null ? (
        <p className="muted pad">Loading…</p>
      ) : (
        <ul className="cards">
          {visible.map((p) => (
            <li key={p.slug} className="card" onClick={() => onOpen(p.slug)}>
              <div className="card-top">
                <span className="title">
                  {p.pinned ? "💡 " : ""}
                  {p.title}
                  {p.adhoc && <span className="tag">ad-hoc</span>}
                  {p.pinned && (
                    <Help text="Your always-on-top ideas inbox — a catch-all backlog for anything not tied to a specific project yet. Never hidden by the filter." />
                  )}
                </span>
                {p.blocked && <span className="dot" title="blocked" />}
              </div>
              <div className="status clamp">
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

function FilterSheet({ projects, hidden, onToggle, onClose }) {
  const pickable = projects.filter((p) => !p.pinned);
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <span className="block-head-title">
            <h2>Filter projects</h2>
            <Help text="Uncheck a project to hide its card on the home screen. This only affects what you see — nothing is deleted or archived." />
          </span>
          <button className="link" onClick={onClose}>
            done
          </button>
        </div>
        {pickable.length ? (
          <ul className="filter-list">
            {pickable.map((p) => (
              <li key={p.slug} className="filter-row" onClick={() => onToggle(p.slug)}>
                <input type="checkbox" checked={!hidden.includes(p.slug)} readOnly />
                <span>{p.title}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">No projects to filter.</p>
        )}
        <p className="muted small">Pinned projects (💡) always show.</p>
      </div>
    </div>
  );
}
