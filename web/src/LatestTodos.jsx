import { useCallback, useEffect, useState } from "react";
import { get, onStream, send } from "./api";
import Help from "./Help.jsx";
import { UnattendedToggle, launchNotice, loadUnattended } from "./relay.jsx";

const PROJECT_KEY = "pm.addTodoProject";
const LATEST_OPEN_KEY = "pm.latestTodosOpen";
const LIMIT = 30;
// Ids are positional and shift after every write, so selection is keyed by
// slug + title (stable across refetches); the current id is looked up at run time.
const keyOf = (t) => `${t.slug}\u0000${t.title}`;

// Home panel: add a todo to any project + the most recently added open todos
// across all projects (newest first), selectable for one cross-project run.
export default function LatestTodos({ projects, reload, hidden = [] }) {
  const [todos, setTodos] = useState(null);
  const [picked, setPicked] = useState(() => new Set());
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState(() => localStorage.getItem(PROJECT_KEY) || "");
  const [busy, setBusy] = useState(false);
  const [unattended, setUnattended] = useState(loadUnattended);
  const [notice, setNotice] = useState("");
  const [open, setOpen] = useState(() => {
    const stored = localStorage.getItem(LATEST_OPEN_KEY);
    return stored ? JSON.parse(stored) : false;
  });

  // ideas have their own capture box + promotion flow, so they aren't offered here
  const targets = (projects || []).filter((p) => !p.pinned && p.slug !== "ideas" && !hidden.includes(p.slug));
  const target = targets.some((p) => p.slug === slug) ? slug : targets[0]?.slug || "";

  const load = useCallback(
    () =>
      get(`/todos/latest?limit=${LIMIT}`)
        .then((d) => {
          if (!Array.isArray(d)) return;
          setTodos(d);
          const live = new Set(d.map(keyOf));
          setPicked((prev) => {
            const next = new Set([...prev].filter((k) => live.has(k)));
            return next.size === prev.size ? prev : next;
          });
        })
        .catch(() => {}),
    [],
  );

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(""), 9000);
    return () => clearTimeout(t);
  }, [notice]);

  // re-fetch on mount and on every SSE ping (ids shift after any write)
  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => onStream(load), [load]);

  // auto-select dropdown to the most-recent todo's project and persist to localStorage
  useEffect(() => {
    if (todos && todos.length > 0) {
      const firstSlug = todos[0].slug;
      setSlug(firstSlug);
      localStorage.setItem(PROJECT_KEY, firstSlug);
    }
  }, [todos]);

  function toggle(t) {
    setPicked((prev) => {
      const next = new Set(prev);
      const k = keyOf(t);
      next.has(k) ? next.delete(k) : next.add(k);
      return next;
    });
  }

  async function add(e) {
    e.preventDefault();
    if (!title.trim() || !target || busy) return;
    setBusy(true);
    try {
      await send("POST", `/projects/${target}/tasks`, { title: title.trim() });
      setTitle("");
      localStorage.setItem(PROJECT_KEY, target);
      await load();
      reload();
    } catch (err) {
      alert(err.message);
    } finally {
      setBusy(false);
    }
  }

  const list = (todos || []).filter((t) => !hidden.includes(t.slug));
  const chosen = list.filter((t) => picked.has(keyOf(t)));
  const runList = chosen.length ? chosen : list;
  const allMode = !chosen.length;

  async function run() {
    if (!runList.length || busy) return;
    setBusy(true);
    try {
      const r = await send("POST", "/tasks/run-cross", {
        unattended,
        items: runList.map(({ slug, id, title }) => ({ slug, id, title })),
      });
      setNotice(launchNotice(r, `${r.count} todo(s) across ${r.projects} project(s)`));
      setPicked(new Set());
    } catch (err) {
      alert(err.message);
      load(); // a 409 means ids shifted — pull the fresh list
    } finally {
      setBusy(false);
    }
  }

  const handleToggle = () => {
    const nextOpen = !open;
    setOpen(nextOpen);
    localStorage.setItem(LATEST_OPEN_KEY, JSON.stringify(nextOpen));
  };

  return (
    <section className="block lt">
      <div
        className={"block-head lt-head" + (open ? " open" : "")}
        onClick={(e) => {
          if (!e.target.closest("button:not(.lt-head-toggle), input, select")) handleToggle();
        }}
      >
        <span className="block-head-title">
          <h3
            className="tg-toggle lt-head-toggle"
            role="button"
            tabIndex={0}
            aria-expanded={open}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                handleToggle();
              }
            }}
          >
            <span className={`chevron${open ? " open" : ""}`}>▸</span>
            {open ? "Latest todos" : `Latest todos (${list.length})`}
            <Help text="Add a todo to any project, and see the most recently added open todos across all projects, newest first. Order is a best guess (backlog files have no created date): most recently edited backlog first, and within a project the last-added first. Ideas are not listed or run here — they have their own flow. Projects hidden by the Home filter are left out too." />
          </h3>
        </span>
        {chosen.length > 0 && open && (
          <button className="link" onClick={() => setPicked(new Set())}>
            clear
          </button>
        )}
      </div>

      {open && (
        <>
          <form className="lt-add" onSubmit={add}>
            <input
              className="lt-input"
              placeholder="add a todo…"
              aria-label="new todo title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
            <select
              className="lt-select"
              aria-label="project for the new todo"
              value={target}
              onChange={(e) => {
                setSlug(e.target.value);
                localStorage.setItem(PROJECT_KEY, e.target.value);
              }}
            >
              {targets.map((p) => (
                <option key={p.slug} value={p.slug}>
                  {p.slug}
                </option>
              ))}
            </select>
            <button className="lt-btn" type="submit" disabled={!title.trim() || !target || busy}>
              Add
            </button>
          </form>

          {todos === null ? (
            <p className="muted small">Loading…</p>
          ) : list.length ? (
            <ul className="lt-list">
              {list.map((t) => {
                const on = picked.has(keyOf(t));
                return (
                  <li key={`${t.slug}#${t.id}`}>
                    <label className={"lt-row" + (on ? " on" : "")}>
                      <input type="checkbox" checked={on} onChange={() => toggle(t)} />
                      <span className="lt-body">
                        <span className="lt-title">{t.title}</span>
                        <span className="lt-meta">
                          <span className="lt-slug">{t.slug}</span>
                          {t.state === "Doing" && <span className="lt-state">doing</span>}
                          {t.priority ? <span className={`lt-pri p${t.priority}`}>p{t.priority}</span> : null}
                        </span>
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="muted small">No open todos yet.</p>
          )}

          <div className="lt-run">
            <UnattendedToggle value={unattended} onChange={setUnattended} />
            <span className="bar-item">
              <button className="lt-btn lt-run-btn" onClick={run} disabled={!runList.length || busy}>
                {allMode ? `▶▶ Run all listed (${runList.length})` : `▶▶ Run selected (${chosen.length})`}
              </button>
              <Help
                text="Launches ONE Claude Code session at the workspace root that works the picked todos across their projects (different projects in parallel, same-project one after another). Nothing selected = every listed todo. Ideas are excluded. With Unattended on, it auto-resumes after every rate-limit reset."
                side="left"
              />
            </span>
          </div>
          {notice && (
            <p className="lt-notice" role="status">
              {notice}
            </p>
          )}
        </>
      )}
    </section>
  );
}
