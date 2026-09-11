import { useState } from "react";
import { ago, send } from "./api";
import Help from "./Help.jsx";

const STATES = ["Doing", "Todo", "Blocked", "Done"];
const KIND = { commit: "●", handoff: "⇄", plan: "▤" };

export default function Project({ slug, data, projects, onBack, reload }) {
  const [editing, setEditing] = useState(false);
  const [showStatus, setShowStatus] = useState(false);
  const [doneOpen, setDoneOpen] = useState(false);

  if (!data)
    return (
      <div className="screen">
        <Bar title={slug} onBack={onBack} />
        <p className="muted pad">Loading…</p>
      </div>
    );

  const { state, backlog, activity, handoff, sessions } = data;
  const tasks = backlog ? backlog.tasks : [];
  const isIdeas = slug === "ideas";
  const moveTargets = (projects || []).map((p) => p.slug).filter((s) => s !== slug);

  const act = async (fn) => {
    try {
      await fn();
      reload();
    } catch (e) {
      alert(e.message);
    }
  };
  const patchState = (patch) =>
    act(async () => {
      await send("PUT", `/projects/${slug}/state`, patch);
      setEditing(false);
    });
  const addTask = (title) => act(() => send("POST", `/projects/${slug}/tasks`, { title }));
  const editTask = (id, patch) => act(() => send("PUT", `/projects/${slug}/tasks/${id}`, patch));
  const delTask = (id) => act(() => send("DELETE", `/projects/${slug}/tasks/${id}`));
  const buildTask = (id) =>
    act(() => send("POST", `/projects/${slug}/tasks/${id}/launch`));
  const runSeq = () =>
    act(async () => {
      const r = await send("POST", `/projects/${slug}/tasks/run-seq`);
      alert(`Orchestrator launched in ${r.term} for ${r.count} @seq todo(s).`);
    });
  const moveTask = (id) => {
    const to = prompt(`Move to which project?\n${moveTargets.join(", ")}`);
    if (to && moveTargets.includes(to))
      act(() => send("POST", `/tasks/move`, { fromSlug: slug, id, toSlug: to }));
  };
  const resume = (id) => act(() => send("POST", `/sessions/${id}/resume`));

  return (
    <div className="screen">
      <Bar title={data.title} onBack={onBack} />

      <section className="block">
        <div className="block-head">
          <span className="block-head-title">
            <h2>Status</h2>
            <Help text="A short hand-written summary of where this project stands — what's happening now, what's next, and any blockers. Not auto-generated." />
          </span>
          <button className="link" onClick={() => setShowStatus(true)}>
            {state ? "view / edit" : "add"}
          </button>
        </div>
        <p className="status-preview clamp" onClick={() => setShowStatus(true)}>
          {state?.now || <em className="muted">no status</em>}
        </p>
      </section>

      {showStatus && (
        <StatusSheet
          state={state}
          editing={editing}
          onEdit={setEditing}
          onSave={patchState}
          onClose={() => {
            setShowStatus(false);
            setEditing(false);
          }}
        />
      )}

      <section className="block">
        <div className="block-head">
          <span className="block-head-title">
            <h2>Backlog</h2>
            <Help text="Your task list, grouped by state (Doing / Todo / Blocked / Done). Each task has a ▶ button to launch a Claude Code session on it, a @seq flag to include it in batch orchestration, and a priority pill." />
          </span>
          {tasks.some((t) => t.seq && t.state !== "Done") && (
            <span className="bar-item">
              <button className="link" onClick={runSeq} title="orchestrate @seq todos">
                ▶▶ Run @seq
              </button>
              <Help text="Launches one Claude Code session that works through every @seq-flagged task in this project's backlog, one after another." />
            </span>
          )}
        </div>
        <AddRow onAdd={addTask} />
        {STATES.map((st) => {
          const rows = tasks.filter((t) => t.state === st);
          if (!rows.length) return null;
          const isDone = st === "Done";
          const open = !isDone || doneOpen;
          return (
            <div key={st} className="tg">
              {isDone ? (
                <h3
                  className="tg-toggle"
                  role="button"
                  tabIndex={0}
                  aria-expanded={doneOpen}
                  onClick={() => setDoneOpen((v) => !v)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setDoneOpen((v) => !v);
                    }
                  }}
                >
                  <span className={`chevron${doneOpen ? " open" : ""}`}>▸</span>
                  {doneOpen ? "Done" : `Done (${rows.length})`}
                  <Help text="Finished tasks, tucked away by default so the active list stays short. Click here to show or hide them." />
                </h3>
              ) : (
                <h3>{st}</h3>
              )}
              {open &&
                rows.map((t) => (
                  <Task
                    key={t.id}
                    t={t}
                    onEdit={editTask}
                    onDel={delTask}
                    onBuild={buildTask}
                    onMove={isIdeas ? moveTask : null}
                  />
                ))}
            </div>
          );
        })}
        {!tasks.length && <p className="muted">No tasks yet.</p>}
      </section>

      {sessions && sessions.length > 0 && (
        <section className="block">
          <div className="block-head">
            <span className="block-head-title">
              <h2>Sessions</h2>
              <Help text="Claude Code conversations already linked to this project. Reopen one to pick up where it left off." />
            </span>
          </div>
          {sessions.map((s) => (
            <div key={s.id} className="task">
              <div className="task-main">
                <span className="ttitle" style={{ cursor: "default" }}>
                  {s.title}
                </span>
                <button className="x" onClick={() => resume(s.id)}>
                  reopen
                </button>
              </div>
              <div className="chips">
                <span className="muted small">
                  {ago(s.start)} · {s.mins}m
                </span>
              </div>
            </div>
          ))}
        </section>
      )}

      <section className="block">
        <div className="block-head">
          <h2>Timeline</h2>
        </div>
        {handoff && <p className="muted small">newest handoff: {handoff}</p>}
        <ul className="timeline">
          {(activity || []).map((a, i) => (
            <li key={i}>
              <span className="k">{KIND[a.kind] || "•"}</span>
              <span className="d">{String(a.date).slice(0, 10)}</span>
              <span className="s">{a.summary}</span>
            </li>
          ))}
          {!activity?.length && <li className="muted">no activity harvested yet</li>}
        </ul>
      </section>
    </div>
  );
}

function Bar({ title, onBack }) {
  return (
    <header className="bar">
      <button className="back" onClick={onBack}>
        ‹
      </button>
      <h1>{title}</h1>
      <span style={{ width: 32 }} />
    </header>
  );
}

function StatusSheet({ state, editing, onEdit, onSave, onClose }) {
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <span className="block-head-title">
            <h2>Status</h2>
            <Help text="Now = what's actively being worked on. Next = the short queue after that. Last failure and Blockers flag anything stuck." />
          </span>
          <div className="bar-actions">
            <button className="link" onClick={() => onEdit((v) => !v)}>
              {editing ? "cancel" : "edit"}
            </button>
            <button className="link" onClick={onClose}>
              done
            </button>
          </div>
        </div>
        {editing ? (
          <StatusForm state={state} onSave={onSave} />
        ) : state ? (
          <dl className="status-dl">
            <dt>Now</dt>
            <dd>
              {(() => {
                const lines = (state.now || "").split("\n").map((l) => l.trim()).filter(Boolean);
                if (!lines.length) return "—";
                const [headline, ...details] = lines;
                return (
                  <>
                    <p className="now-headline">{headline}</p>
                    {details.length > 0 && (
                      <ul>
                        {details.map((l, i) => (
                          <li key={i}>{l}</li>
                        ))}
                      </ul>
                    )}
                  </>
                );
              })()}
            </dd>
            <dt>Next</dt>
            <dd>
              {state.next.length ? (
                <ul>
                  {state.next.map((n, i) => (
                    <li key={i}>{n}</li>
                  ))}
                </ul>
              ) : (
                "—"
              )}
            </dd>
            <dt>Last failure</dt>
            <dd>{state.lastFailure}</dd>
            <dt>Blockers</dt>
            <dd>{state.blockers}</dd>
          </dl>
        ) : (
          <p className="muted">No state file. Add one via edit.</p>
        )}
      </div>
    </div>
  );
}

function StatusForm({ state, onSave }) {
  const s = state || { now: "", next: [], lastFailure: "none", blockers: "none" };
  const [now, setNow] = useState(s.now);
  const [next, setNext] = useState(s.next.join("\n"));
  const [lf, setLf] = useState(s.lastFailure);
  const [bl, setBl] = useState(s.blockers);
  return (
    <div className="form">
      <label>
        Now (first line = headline, rest become sub-bullets)
        <textarea rows={4} value={now} onChange={(e) => setNow(e.target.value)} />
      </label>
      <label>
        Next (one per line)
        <textarea rows={3} value={next} onChange={(e) => setNext(e.target.value)} />
      </label>
      <label>
        Last failure
        <textarea rows={2} value={lf} onChange={(e) => setLf(e.target.value)} />
      </label>
      <label>
        Blockers
        <input value={bl} onChange={(e) => setBl(e.target.value)} />
      </label>
      <button
        className="save"
        onClick={() =>
          onSave({
            now,
            next: next.split("\n").map((x) => x.trim()).filter(Boolean),
            lastFailure: lf.trim() || "none",
            blockers: bl.trim() || "none",
          })
        }
      >
        Save
      </button>
    </div>
  );
}

function AddRow({ onAdd }) {
  const [v, setV] = useState("");
  return (
    <form
      className="addrow"
      onSubmit={(e) => {
        e.preventDefault();
        if (v.trim()) {
          onAdd(v.trim());
          setV("");
        }
      }}
    >
      <input placeholder="Add a task…" value={v} onChange={(e) => setV(e.target.value)} />
      <button>Add</button>
    </form>
  );
}

function Task({ t, onEdit, onDel, onBuild, onMove }) {
  return (
    <div className="task">
      <div className="task-main">
        <button
          className="ttitle"
          onClick={() => {
            const nv = prompt("Task", t.title);
            if (nv && nv !== t.title) onEdit(t.id, { title: nv });
          }}
        >
          {t.title}
        </button>
        <button className="build" title="build with Claude" onClick={() => onBuild(t.id)}>
          ▶
        </button>
        <button
          className={"seq" + (t.seq ? " on" : "")}
          title="flag for the Run @seq orchestrator"
          onClick={() => onEdit(t.id, { seq: !t.seq })}
        >
          @seq
        </button>
        <button
          className={"pri p" + (t.priority || 0)}
          onClick={() =>
            onEdit(t.id, { priority: t.priority === 3 ? null : (t.priority || 0) + 1 })
          }
        >
          {t.priority ? "p" + t.priority : "–"}
        </button>
        <button className="x" onClick={() => onDel(t.id)}>
          ×
        </button>
      </div>
      {t.note && <div className="tnote">{t.note}</div>}
      <div className="seg">
        {STATES.map((st) => (
          <button
            key={st}
            className={st === t.state ? "on" : ""}
            onClick={() => st !== t.state && onEdit(t.id, { state: st })}
          >
            {st}
          </button>
        ))}
        {onMove && (
          <button onClick={() => onMove(t.id)} title="move to project">
            ▸
          </button>
        )}
      </div>
    </div>
  );
}
