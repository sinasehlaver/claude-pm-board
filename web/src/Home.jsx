import { useRef, useState } from "react";
import { ago, send } from "./api";
import Help from "./Help.jsx";
import LatestTodos from "./LatestTodos.jsx";
import { RelayStrip } from "./relay.jsx";
import { FillPanel, useFill } from "./fill.jsx";
import { ColorPane, loadColor, saveColor, slugStyle } from "./projectColor.jsx";
import StartButton from "./StartButton.jsx";
import { alertDialog, promptDialog } from "./dialog.jsx";
import UsageStrip from "./UsageStrip.jsx";
import AppearancePanel from "./Appearance.jsx";


export const HIDDEN_KEY = "pm.hiddenSlugs";
const SORT_KEY = "pm.sort";
const TAB_KEY = "pm.tab";
const TOOLS_OPEN_KEY = "pm.toolsGroupOpen";
const PROJECTS_OPEN_KEY = "pm.projectsOpen";
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

export default function Home({ projects, inboxCount, selfSlug, onOpen, onSessions, onDoctor, onSetup, onTour, setupBad, onEnvs, onPorts, onChanges, reload }) {
  const [showAppearance, setShowAppearance] = useState(false);
  const [idea, setIdea] = useState("");
  const [ideaMsg, setIdeaMsg] = useState({});
  const ideaTimer = useRef(null);
  const [query, setQuery] = useState("");
  const [, setColorTick] = useState(0);
  const [sort, setSort] = useState(() => loadPref(SORT_KEY, (v) => v in SORTS, "recent"));
  const [tab, setTab] = useState(() => loadPref(TAB_KEY, (v) => TABS.some(([k]) => k === v), "project"));
  const [toolsOpen, setToolsOpen] = useState(() => loadPref(TOOLS_OPEN_KEY, (v) => v === "1", "0") === "1");
  const [projectsOpen, setProjectsOpen] = useState(() => loadPref(PROJECTS_OPEN_KEY, (v) => v === "0", "1") === "1");
  const [hidden, setHidden] = useState(loadHidden);
  const [showFilter, setShowFilter] = useState(false);
  const [fill, reloadFill, setFill] = useFill();
  const autoProjects = new Set(fill?.autoProjects || []);
  const autoCount = fill?.queuedBySlug || {};

  async function toggleAutoProject(slug, on) {
    setFill((f) => f && { ...f, autoProjects: on ? [...(f.autoProjects || []), slug] : (f.autoProjects || []).filter((s) => s !== slug) });
    try {
      await send("PUT", "/fill/auto-project", { slug, on });
    } catch (e) {
      alertDialog(`Couldn't change auto project: ${e.message || e}`);
    }
    reloadFill();
  }

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
    const descriptor = await promptDialog({ title: "What is it?", label: "A few words, max 40 characters", placeholder: "band merch demand tracker", confirmLabel: "Create" });
    if (!descriptor) return;
    try {
      await send("POST", "/projects", { slug, descriptor });
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
  const toggleProjects = () => (setProjectsOpen(!projectsOpen), savePref(PROJECTS_OPEN_KEY, projectsOpen ? "0" : "1"));

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
      (!q || [p.slug, p.title, p.status, p.next].some((t) => (t || "").toLowerCase().includes(q))));
  const visible = tab === "project" ? sorted.filter((p) => !p.pinned && (p.kind || "project") === "project" && match(p)) : [];
  const entries = tab === "project" ? sorted.filter((p) => (p.kind || "project") !== "project" && match(p)) : [];

  const renderCard = (p) => {
    const when = touched(p);
    const stale = !p.pinned && ageDays(when) > STALE_DAYS;
    return (
      <li
        key={p.slug}
        data-slug={p.slug}
        className={"card pc has-pc" + (p.blocked ? " is-blocked" : "")}
        style={slugStyle(p.slug, loadColor(p.slug))}
        onClick={() => onOpen(p.slug)}
      >
        <div className="card-top">
          <span className="title">
            {!p.pinned && (
              <span className="card-color" onClick={(e) => e.stopPropagation()}>
                <ColorPane
                  slug={p.slug}
                  value={loadColor(p.slug)}
                  align="left"
                  onChange={(n) => {
                    saveColor(p.slug, n);
                    setColorTick((t) => t + 1);
                  }}
                />
              </span>
            )}
            <span className="title-text" title={p.title}>
              {p.pinned ? "💡 " : ""}
              {p.title}
            </span>
            {p.adhoc && <span className="tag">ad-hoc</span>}
            {p.pinned && (
              <Help text="Your always-on-top ideas inbox — a catch-all backlog for anything not tied to a specific project yet. Never hidden by the filter." />
            )}
          </span>
          <StartButton p={p} reload={reload} />
        </div>
        {p.description && <div className="desc clamp">{p.description}</div>}
        <div className="status clamp">{p.status || <em className="muted">no status</em>}</div>
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
        {fill && (() => {
          const on = autoProjects.has(p.slug);
          const n = autoCount[p.slug] || 0;
          return (
            <button
              type="button"
              className={"auto-btn card-auto" + (on ? " on" : n ? " part" : "")}
              aria-pressed={on}
              aria-label={`${on ? "Turn off" : "Turn on"} auto for the whole ${p.title} project`}
              title={
                on
                  ? "Auto project: fill runs may work every open todo here while you're away (click to turn off)"
                  : (n ? `${n} todo${n === 1 ? "" : "s"} marked auto. ` : "") + "Click to make the whole project auto: fill runs may work every open todo here, including ones added later"
              }
              onClick={(e) => {
                e.stopPropagation();
                toggleAutoProject(p.slug, !on);
              }}
            >
              auto{!on && n ? ` ${n}` : ""}
            </button>
          );
        })()}
        </div>
      </li>
    );
  };

  return (
    <div className="screen home-screen">
      <div className="theme-toggle-fixed hover-fixed add-fixed">
        <button className="theme-toggle" onClick={addAdhoc} title="Add an ad-hoc project" aria-label="Add project">
          +
        </button>
      </div>
      {showAppearance && <AppearancePanel onClose={() => setShowAppearance(false)} />}
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
            <summary className="link">Help{inboxCount ? <span className="dot" title={`${inboxCount} unfiled session${inboxCount === 1 ? "" : "s"}`} aria-label="Needs attention" /> : null}</summary>
            <div className="help-menu-list">
              <button className="link" onClick={onSessions} title="Recent Claude Code conversations: unfiled inbox vs linked to a project">
                Sessions{inboxCount ? <span className="badge">{inboxCount}</span> : null}
              </button>
              <button className="link" onClick={onDoctor} title="LLM-free scan of transcripts: where errors and token spend concentrate">
                Doctor
              </button>
              <button className="link" onClick={onSetup} title="Which claude pm launches, plus Rosetta / platform-package checks">
                Setup{setupBad ? <span className="badge">{setupBad}</span> : null}
              </button>
              <button className="link" onClick={onTour} title="A short walkthrough of the board">
                Tour
              </button>
            </div>
          </details>
          <button className="add gear" onClick={() => setShowAppearance(true)} title="Appearance: colours, font, density" aria-label="Appearance settings">
            ⚙
          </button>
        </div>
      </header>

      {setupBad > 0 && (
        <p className="pad">
          <button className="link" onClick={onSetup} style={{ color: "var(--bad)" }}>
            ⚠ {setupBad} launch check{setupBad > 1 ? "s" : ""} failing: sessions may not start. Open Setup
          </button>
        </p>
      )}

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

      {ideasProj && (
        <button className="ideas-pill" onClick={() => onOpen(ideasProj.slug)} title="Your ideas inbox, always on top and never hidden by the filter">
          <span>💡 {ideasProj.title}</span>
          <span className="muted">{ideasProj.openCount} open</span>
        </button>
      )}

      <UsageStrip />

      <FillPanel fill={fill} load={reloadFill} setFill={setFill} onOpen={onOpen} />
      <RelayStrip />

      <div className={tab === "project" ? "projects-fold" : undefined}>
      {tab === "project" && (
        <button type="button" className="projects-head" aria-expanded={projectsOpen} onClick={toggleProjects}>
          <span className={`chevron${projectsOpen ? " open" : ""}`}>▸</span>
          Projects
          {projects !== null && <span className="projects-count">({visible.length + entries.length})</span>}
        </button>
      )}
      {(tab !== "project" || projectsOpen) && (
      <>
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
      </>
      )}
      </div>

      {projects !== null && <LatestTodos projects={projects} reload={reload} hidden={hidden} fill={fill} reloadFill={reloadFill} />}
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
