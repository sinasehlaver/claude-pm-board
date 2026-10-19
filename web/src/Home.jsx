import { useEffect, useRef, useState } from "react";
import { ago, get, send } from "./api";
import Help from "./Help.jsx";
import LatestTodos from "./LatestTodos.jsx";
import { RelayStrip } from "./relay.jsx";
import { loadColor, slugStyle, termBg } from "./projectColor.jsx";
import { alertDialog, promptDialog } from "./dialog.jsx";

const usd = (n) => (n == null ? "—" : "$" + n.toFixed(2));

export const HIDDEN_KEY = "pm.hiddenSlugs";
const SORT_KEY = "pm.sort";
const TAB_KEY = "pm.tab";
const TOOLS_OPEN_KEY = "pm.toolsGroupOpen";
const TABS = [["project", "Projects"], ["tool", "Tools"]];
const STALE_DAYS = 7;

// remembered UI pref; localStorage can throw (private window), so fall back
function loadPref(key, ok, fallback) {
  try {
    const v = localStorage.getItem(key);
    return ok(v) ? v : fallback;
  } catch {
    return fallback;
  }
}
const savePref = (key, v) => {
  try {
    localStorage.setItem(key, v);
  } catch {}
};

// when a project was last touched: harvested activity, else the state file's Updated date
const touched = (p) => p.lastActivity || p.updated || null;
const ageDays = (iso) => (iso ? (Date.now() - Date.parse(iso)) / 86400e3 : Infinity);
const byRecent = (a, b) => String(touched(b) || "").localeCompare(String(touched(a) || ""));
const SORTS = {
  focus: ["Blocked, then recent", (a, b) => Number(b.blocked) - Number(a.blocked) || byRecent(a, b)],
  recent: ["Most recent", byRecent],
  stale: ["Stalest first", (a, b) => byRecent(b, a)],
  name: ["A–Z", (a, b) => a.title.localeCompare(b.title)],
};

export function loadHidden() {
  try {
    const raw = localStorage.getItem(HIDDEN_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export default function Home({ projects, inboxCount, selfSlug, onOpen, onSessions, onDoctor, onEnvs, onPorts, onChanges, reload }) {
  const [idea, setIdea] = useState("");
  const [ideaMsg, setIdeaMsg] = useState({});
  const ideaTimer = useRef(null);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState(() => loadPref(SORT_KEY, (v) => v in SORTS, "recent"));
  const [tab, setTab] = useState(() => loadPref(TAB_KEY, (v) => TABS.some(([k]) => k === v), "project"));
  const [toolsOpen, setToolsOpen] = useState(() => loadPref(TOOLS_OPEN_KEY, (v) => v === "1", "0") === "1");
  const [hidden, setHidden] = useState(loadHidden);
  const [showFilter, setShowFilter] = useState(false);
  const [burn, setBurn] = useState(null);

  useEffect(() => {
    const load = () => get("/usage").then(setBurn).catch(() => {});
    load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, []);

  function toggleHidden(slug) {
    setHidden((prev) => {
      const next = prev.includes(slug) ? prev.filter((s) => s !== slug) : [...prev, slug];
      localStorage.setItem(HIDDEN_KEY, JSON.stringify(next));
      return next;
    });
  }

  async function addAdhoc() {
    const raw = await promptDialog({ title: "New ad-hoc item", label: "Short slug (a-z, 0-9, -)", confirmLabel: "Create" });
    if (!raw) return;
    const slug = raw.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-");
    try {
      await send("POST", "/projects", { slug });
      reload();
      onOpen(slug);
    } catch (e) {
      alertDialog(e.message);
    }
  }

  async function captureIdea(e) {
    e.preventDefault();
    const title = idea.trim();
    if (!title || ideaMsg.busy) return;
    // optimistic: show "saved" and clear the box now; restore the text if the POST fails
    setIdea("");
    setIdeaMsg({ ok: `Saved to Ideas: “${title.length > 60 ? title.slice(0, 57) + "…" : title}”` });
    clearTimeout(ideaTimer.current);
    ideaTimer.current = setTimeout(() => setIdeaMsg({}), 3500);
    try {
      await send("POST", "/projects/ideas/tasks", { title });
      reload();
    } catch (err) {
      clearTimeout(ideaTimer.current);
      setIdea((cur) => cur || title);
      setIdeaMsg({ err: err.message });
    }
  }

  function setAllHidden(slugs, hide) {
    setHidden((prev) => {
      const next = hide ? [...new Set([...prev, ...slugs])] : prev.filter((s) => !slugs.includes(s));
      localStorage.setItem(HIDDEN_KEY, JSON.stringify(next));
      return next;
    });
  }

  const changeTab = (v) => (setTab(v), savePref(TAB_KEY, v));
  const changeSort = (v) => (setSort(v), savePref(SORT_KEY, v));
  const toggleTools = () => (setToolsOpen(!toolsOpen), savePref(TOOLS_OPEN_KEY, toolsOpen ? "0" : "1"));

  // Projects tab = projects, plus a collapsible group for tool entries (entries.json).
  // Tools tab = in-app tools (Env Manager). The self project (PM_SELF_SLUG) lives in the side pane.
  const sorted = (projects || [])
    .filter((p) => p.slug !== selfSlug)
    .sort((a, b) => SORTS[sort][1](a, b));
  const ideasProj = tab === "project" ? sorted.find((p) => p.pinned) : null;
  const q = query.trim().toLowerCase();
  // pinned projects (e.g. ideas) always show, regardless of filter and search
  const match = (p) =>
    p.pinned ||
    (!hidden.includes(p.slug) &&
      (!q || [p.slug, p.title, p.status, p.next, p.lastResult].some((t) => (t || "").toLowerCase().includes(q))));
  const visible = tab === "project" ? sorted.filter((p) => !p.pinned && (p.kind || "project") === "project" && match(p)) : [];
  const entries = tab === "project" ? sorted.filter((p) => (p.kind || "project") !== "project" && match(p)) : [];

  const renderCard = (p) => {
    const when = touched(p);
    const stale = !p.pinned && ageDays(when) > STALE_DAYS;
    return (
      <li
        key={p.slug}
        className={"card pc has-pc" + (p.blocked ? " is-blocked" : "")}
        style={slugStyle(p.slug, loadColor(p.slug))}
        onClick={() => onOpen(p.slug)}
      >
        <div className="card-top">
          <span className="title">
            {p.pinned ? "💡 " : ""}
            {p.title}
            {p.adhoc && <span className="tag">ad-hoc</span>}
            {p.pinned && (
              <Help text="Your always-on-top ideas inbox — a catch-all backlog for anything not tied to a specific project yet. Never hidden by the filter." />
            )}
          </span>
          {p.hasStart && (
            <span className="start-wrap">
            <button
              className={"start-btn" + (p.running?.length ? " is-running" : "")}
              title={p.running?.length ? "Running — click to stop it" : "Run ./start.sh in a terminal"}
              aria-label={`${p.running?.length ? "Stop" : "Start"} ${p.title}`}
              onClick={(e) => {
                e.stopPropagation();
                const req = p.running?.length
                  ? send("POST", `/projects/${p.slug}/stop`).then(() => (reload(), setTimeout(reload, 1500)))
                  : send("POST", `/projects/${p.slug}/start`, { bg: termBg(p.slug, loadColor(p.slug)) });
                req.catch((err) => alertDialog(err.message));
              }}
            >
              <span className="start-ico">{p.running?.length ? "■" : "▶"}</span>
              <span className="start-txt">
                <b>{p.running?.length ? "Stop" : "Start"}</b>
                <small>{p.running?.length ? p.running.slice(0, 3).map((r) => ":" + r.port).join(" ") : "./start.sh"}</small>
              </span>
            </button>
              {p.running?.length > 0 && (
                <a
                  className="open-btn"
                  href={`http://127.0.0.1:${p.running[0].port}`}
                  target="_blank"
                  rel="noreferrer noopener"
                  title={`Open http://127.0.0.1:${p.running[0].port} in a new tab`}
                  aria-label={`Open ${p.title} app`}
                  onClick={(e) => e.stopPropagation()}
                >
                  ↗
                </a>
              )}
            </span>
          )}
        </div>
        {p.description && <div className="desc clamp">{p.description}</div>}
        <div className="status clamp">{p.status || <em className="muted">no status</em>}</div>
        {p.lastResult && (
          <div className="card-line">
            <span className="chip">last result</span>
            <span className="card-line-text">{p.lastResult}</span>
          </div>
        )}
        {p.next && (
          <div className="card-line">
            <span className="chip chip-quiet">next</span>
            <span className="card-line-text">{p.next}</span>
          </div>
        )}
        <div className="meta">
          <span>{p.openCount} open</span>
          <span className={stale ? "stale" : ""} title={stale ? `untouched for over ${STALE_DAYS} days` : undefined}>
            {ago(when)}
          </span>
        </div>
      </li>
    );
  };

  return (
    <div className="screen home-screen">
      <header className="bar">
        <nav className="tabs">
          {TABS.map(([k, label]) => (
            <button key={k} className={"tab" + (tab === k ? " active" : "")} onClick={() => changeTab(k)}>
              <h1>{label}</h1>
            </button>
          ))}
        </nav>
        <div className="bar-actions">
          <details className="help-menu">
            <summary className="link">Help{inboxCount ? <span className="badge">{inboxCount}</span> : null}</summary>
            <div className="help-menu-list">
              <button className="link" onClick={onSessions} title="Recent Claude Code conversations: unfiled inbox vs linked to a project">
                Sessions{inboxCount ? <span className="badge">{inboxCount}</span> : null}
              </button>
              <button className="link" onClick={onDoctor} title="LLM-free scan of transcripts: where errors and token spend concentrate">
                Doctor
              </button>
            </div>
          </details>
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
          onAll={setAllHidden}
          onClose={() => setShowFilter(false)}
        />
      )}

      <form className="capture" onSubmit={captureIdea}>
        <div className="capture-row">
          <input
            placeholder="💡 capture an idea…"
            value={idea}
            onChange={(e) => setIdea(e.target.value)}
            readOnly={ideaMsg.busy}
            aria-label="Capture an idea"
          />
          <Help
            text="Quick-drop a thought here without picking a project. It lands in the pinned Ideas list below, for sorting later."
            side="left"
          />
        </div>
        <div className={"capture-msg" + (ideaMsg.err ? " err" : ideaMsg.ok ? " ok" : "")} role="status" aria-live="polite">
          {ideaMsg.busy ? "Saving…" : ideaMsg.err ? `Couldn't save: ${ideaMsg.err}` : ideaMsg.ok || ""}
        </div>
      </form>

      {tab === "project" && (
        <div className="find">
          <input
            type="search"
            placeholder="Search projects…"
            aria-label="Search projects"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <select value={sort} onChange={(e) => changeSort(e.target.value)} aria-label="Sort projects">
            {Object.entries(SORTS).map(([k, [label]]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
          <button className={"link" + (hidden.length ? " active" : "")} onClick={() => setShowFilter(true)} title="Hide projects you don't want in this list (nothing is deleted)">
            Filter{hidden.length ? <span className="badge">{hidden.length}</span> : null}
          </button>
        </div>
      )}

      {burn && (
        <div className="burn-strip-row">
          <div className="burn-strip" title="Estimated Claude Code spend, same math as the statusline: current 5h block, today (UTC), last 7 days">
            <span>🔥 {usd(burn.block)} / 5h</span>
            <span>{usd(burn.today)} today</span>
            <span>{usd(burn.week)} / 7d</span>
          </div>
        </div>
      )}

      <RelayStrip />

      {ideasProj && (
        <button className="ideas-pill" onClick={() => onOpen(ideasProj.slug)} title="Your ideas inbox, always on top and never hidden by the filter">
          <span>💡 {ideasProj.title}</span>
          <span className="muted">{ideasProj.openCount} open</span>
        </button>
      )}

      {projects === null ? (
        <p className="muted pad">Loading…</p>
      ) : (
        <ul className="cards">
          {tab === "tool" && (
            <li className="card pc has-pc" style={slugStyle("env-manager")} onClick={onEnvs}>
              <div className="card-top">
                <span className="title">Env Manager</span>
              </div>
              <div className="status clamp">Every live .env var in the workspace with masked values; update one (e.g. a new API key) across all files at once, with a backup of each file.</div>
            </li>
          )}
          {tab === "tool" && (
            <li className="card pc has-pc" style={slugStyle("ports")} onClick={onPorts}>
              <div className="card-top">
                <span className="title">Ports</span>
              </div>
              <div className="status clamp">Every TCP port something on this Mac is listening on, with the owning process; stop one after a confirmation.</div>
            </li>
          )}
          {tab === "tool" && (
            <li className="card pc has-pc" style={slugStyle("changes")} onClick={onChanges}>
              <div className="card-top">
                <span className="title">Changes</span>
              </div>
              <div className="status clamp">Uncommitted edits in every git repo: side-by-side diffs, keep or discard per hunk, then commit and push. Plain git, no Claude.</div>
            </li>
          )}
          {visible.map(renderCard)}
          {entries.length > 0 && (
            <li
              className="tools-group-head"
              onClick={toggleTools}
              role="button"
              tabIndex={0}
              aria-expanded={toolsOpen}
              onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && toggleTools()}
            >
              <span className={`chevron${toolsOpen ? " open" : ""}`}>▸</span> tools <span className="muted">({entries.length})</span>
            </li>
          )}
          {toolsOpen && entries.map(renderCard)}
          {tab === "project" && !visible.length && !entries.length && (
            <li className="empty">{sorted.length ? "No match." : "Nothing here yet. Press + to add a project."}</li>
          )}
        </ul>
      )}

      {projects !== null && <LatestTodos projects={projects} reload={reload} hidden={hidden} />}
    </div>
  );
}

export function FilterSheet({ projects, hidden, onToggle, onAll, onClose }) {
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
          <>
          <div className="block-head">
            <button className="link" onClick={() => onAll(pickable.map((p) => p.slug), false)}>Select all</button>
            <button className="link" onClick={() => onAll(pickable.map((p) => p.slug), true)}>Deselect all</button>
            <span className="muted">{pickable.filter((p) => !hidden.includes(p.slug)).length}/{pickable.length} shown</span>
          </div>
          <ul className="filter-list">
            {pickable.map((p) => (
              <li key={p.slug} className="filter-row" onClick={() => onToggle(p.slug)}>
                <input type="checkbox" checked={!hidden.includes(p.slug)} readOnly />
                <span>{p.title}</span>
              </li>
            ))}
          </ul>
          </>
        ) : (
          <p className="muted">No projects to filter.</p>
        )}
        <p className="muted small">Pinned projects (💡) always show.</p>
      </div>
    </div>
  );
}
