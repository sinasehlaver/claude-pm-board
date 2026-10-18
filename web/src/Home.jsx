import { useEffect, useState } from "react";
import { ago, get, send } from "./api";
import Help from "./Help.jsx";
import LatestTodos from "./LatestTodos.jsx";
import { RelayStrip } from "./relay.jsx";
import { costFor, tokensFor } from "./pricing.js";
import { loadUnit, REFRESH_KEY, loadRefreshSec, RefreshSelect } from "./usageSettings.jsx";
import { loadColor, slugStyle } from "./projectColor.jsx";

const k = (n) => (n == null ? "—" : n >= 1000 ? Math.round(n / 1000).toLocaleString() + "k" : String(Math.round(n)));
const usd = (n) => (n == null ? "—" : "$" + n.toFixed(n < 1 ? 3 : 2));

// sum a set of per-model token rows into a single $ or token figure, matching
// the unit set on the Usage page (see usageSettings.jsx).
function burnFigure(rows, unit) {
  const sum = (rows || []).reduce((s, r) => s + (unit === "cost" ? costFor(r) : tokensFor(r)), 0);
  return unit === "cost" ? usd(sum) : k(sum);
}

const HIDDEN_KEY = "pm.hiddenSlugs";
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

function loadHidden() {
  try {
    const raw = localStorage.getItem(HIDDEN_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export default function Home({ projects, inboxCount, selfSlug, onOpen, onSessions, onUsage, onDoctor, onEnvs, reload }) {
  const [idea, setIdea] = useState("");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState(() => loadPref(SORT_KEY, (v) => v in SORTS, "focus"));
  const [tab, setTab] = useState(() => loadPref(TAB_KEY, (v) => TABS.some(([k]) => k === v), "project"));
  const [toolsOpen, setToolsOpen] = useState(() => loadPref(TOOLS_OPEN_KEY, (v) => v === "1", "0") === "1");
  const [hidden, setHidden] = useState(loadHidden);
  const [showFilter, setShowFilter] = useState(false);
  const [burn, setBurn] = useState(null);
  const [unit] = useState(loadUnit);
  const [refreshSec, setRefreshSec] = useState(loadRefreshSec);

  useEffect(() => {
    function load() {
      get("/usage/burn").then(setBurn).catch(() => {});
    }
    load();
    if (!refreshSec) return;
    const id = setInterval(load, refreshSec * 1000);
    return () => clearInterval(id);
  }, [refreshSec]);

  function changeRefresh(sec) {
    localStorage.setItem(REFRESH_KEY, String(sec));
    setRefreshSec(sec);
  }

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

  // Projects tab = projects, plus a collapsible group for benchmark/tool entries (entries.json).
  // Tools tab = in-app tools (Env Manager). The self project (PM_SELF_SLUG) lives in the side pane.
  const sorted = (projects || [])
    .filter((p) => p.slug !== selfSlug)
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || SORTS[sort][1](a, b));
  const q = query.trim().toLowerCase();
  // pinned projects (e.g. ideas) always show, regardless of filter and search
  const match = (p) =>
    p.pinned ||
    (!hidden.includes(p.slug) &&
      (!q || [p.slug, p.title, p.status, p.next, p.lastResult].some((t) => (t || "").toLowerCase().includes(q))));
  const visible = tab === "project" ? sorted.filter((p) => (p.kind || "project") === "project" && match(p)) : [];
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
          {p.blocked && <span className="dot" title="blocked" />}
        </div>
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
    <div className="screen">
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
              <button className="link" onClick={onUsage} title="Token/cost burn rate across all sessions, and rate-limit ceiling">
                Usage
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
          />
          <Help
            text="Quick-drop a thought here without picking a project. It lands in the pinned Ideas list below, for sorting later."
            side="left"
          />
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
          <button className="burn-strip" onClick={onUsage} title="open Usage">
            <span>🔥 {burnFigure(burn.breakdown?.win1h, unit)}{unit === "cost" ? "" : " tok"}/1h</span>
            <span>{burnFigure(burn.breakdown?.win5h, unit)} / 5h</span>
            <span>{burnFigure(burn.breakdown?.win7d, unit)} / 7d</span>
            {burn.limits?.windows?.["5h"]?.limitStatus && burn.limits.windows["5h"].limitStatus !== "allowed" && (
              <span className="pill bad">{burn.limits.windows["5h"].limitStatus}</span>
            )}
          </button>
          <span className="bar-item">
            <RefreshSelect value={refreshSec} onChange={changeRefresh} />
            <Help text="How often the burn-rate strip above refreshes itself. Shared with the same setting on the Usage page." />
          </span>
        </div>
      )}

      <RelayStrip />

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
              <span className={`chevron${toolsOpen ? " open" : ""}`}>▸</span> benchmarks &amp; tools <span className="muted">({entries.length})</span>
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

function FilterSheet({ projects, hidden, onToggle, onAll, onClose }) {
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
