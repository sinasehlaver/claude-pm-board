import { useState } from "react";
import { ago, send } from "./api";
import Help from "./Help.jsx";
import PathText, { OpenBtn } from "./PathText.jsx";
import TokBadge, { useTaskTokens } from "./TokBadge.jsx";
import { UnattendedToggle, loadUnattended } from "./relay.jsx";
import { ColorPane, slugStyle, loadColor, saveColor, termBg } from "./projectColor.jsx";

const STATES = ["Doing", "Todo", "Blocked", "Done"];
const KIND = { commit: "●", handoff: "⇄", plan: "▤" };
const EMPTY_RESUME = { lastResult: "", rerun: "", branch: "", artifacts: "" };

export default function Project({ slug, data, projects, onBack, reload }) {
  const [editing, setEditing] = useState(false);
  const [showStatus, setShowStatus] = useState(false);
  const [sectionOpen, setSectionOpen] = useState({ Blocked: false, Done: false });
  const [unattended, setUnattended] = useState(loadUnattended);
  const [color, setColor] = useState(() => loadColor(slug));
  const tokens = useTaskTokens(data);

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
    act(() => send("POST", `/projects/${slug}/tasks/${id}/launch`, { bg: termBg(slug, color) }));
  // Mirrors runnableTasks() in server/backlog.mjs: any non-Done @seq flag => only
  // those; else every Todo + Doing task (Blocked/Done skipped).
  const seqTasks = tasks.filter((t) => t.seq && t.state !== "Done");
  const runMode = seqTasks.length ? "seq" : "all";
  const runCount = seqTasks.length || tasks.filter((t) => t.state === "Todo" || t.state === "Doing").length;
  const runSeq = () =>
    act(async () => {
      await send("POST", `/projects/${slug}/tasks/run-seq`, { unattended, bg: termBg(slug, color) });
    });
  const securityAudit = () => act(() => send("POST", `/projects/${slug}/security-audit`, { bg: termBg(slug, color) }));
  const moveTask = (id) => {
    const to = prompt(`Move to which project?\n${moveTargets.join(", ")}`);
    if (to && moveTargets.includes(to))
      act(() => send("POST", `/tasks/move`, { fromSlug: slug, id, toSlug: to }));
  };
  const resume = (id) => act(() => send("POST", `/sessions/${id}/resume`, { bg: termBg(slug, color) }));
  const continueWork = () => act(() => send("POST", `/projects/${slug}/continue`, { bg: termBg(slug, color) }));

  return (
    <div className="screen pc has-pc" style={slugStyle(slug, color)}>
      <Bar title={data.title} onBack={onBack} />
      {data.description && <p className="proj-desc">{data.description}</p>}
      <ColorPane
        value={color}
        onChange={(n) => {
          saveColor(slug, n);
          setColor(n);
        }}
      />
      {data.path && (
        <p className="muted small">
          {data.kind}: <PathText text={data.path} slug={slug} />
        </p>
      )}

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

      <ResumePanel
        slug={slug}
        state={state}
        onContinue={continueWork}
        onEdit={() => {
          setShowStatus(true);
          setEditing(true);
        }}
      />

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

      {slug !== "ideas" && (
        <section className="block">
          <div className="block-head">
            <span className="block-head-title">
              <h2>Security</h2>
              <Help text="Launches a Claude Code session that audits this project against a catalogue of common breach classes (secrets, authz, injection, SSRF, path traversal, exposed ports, LLM-agent flaws, supply chain…), writes security tests into the project's own suite, and files findings as backlog todos plus a report in knowledge/security/." />
            </span>
            <button className="link" onClick={securityAudit} title="static audit + generated security tests">
              🛡 Security audit
            </button>
          </div>
        </section>
      )}

      <section className="block">
        <div className="block-head">
          <span className="block-head-title">
            <h2>Backlog</h2>
            <Help text="Your task list, grouped by state (Doing / Todo / Blocked / Done). Each task has a ▶ button to launch a Claude Code session on it, a @seq flag to include it in batch orchestration, and a priority pill." />
          </span>
          <span className="bar-item">
            <UnattendedToggle value={unattended} onChange={setUnattended} />
            <button
              className="link"
              onClick={runSeq}
              disabled={!runCount}
              title={runMode === "seq" ? "orchestrate the @seq-flagged todos" : "orchestrate all Todo/Doing tasks"}
            >
              {`▶▶ Run ${runMode === "seq" ? "@seq" : "all"} (${runCount})`}
            </button>
            <Help text="Launches one Claude Code session that works through your tasks. If any tasks are @seq-flagged it runs only those; with none flagged it runs every Todo and Doing task (Blocked and Done are skipped). The label shows which mode you're in." />
          </span>
        </div>
        <AddRow onAdd={addTask} />
        {STATES.map((st) => {
          const rows = tasks.filter((t) => t.state === st);
          if (!rows.length) return null;
          const collapsible = st === "Blocked" || st === "Done";
          const isOpen = !!sectionOpen[st];
          const open = !collapsible || isOpen;
          const toggle = () => setSectionOpen((m) => ({ ...m, [st]: !m[st] }));
          return (
            <div key={st} className="tg">
              {collapsible ? (
                <h3
                  className="tg-toggle"
                  role="button"
                  tabIndex={0}
                  aria-expanded={isOpen}
                  onClick={toggle}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      toggle();
                    }
                  }}
                >
                  <span className={`chevron${isOpen ? " open" : ""}`}>▸</span>
                  {isOpen ? st : `${st} (${rows.length})`}
                  <Help
                    text={
                      st === "Done"
                        ? "Finished tasks, tucked away by default so the active list stays short. Click here to show or hide them."
                        : "Tasks waiting on something, tucked away by default. Click here to show or hide them."
                    }
                  />
                </h3>
              ) : (
                <h3>{st}</h3>
              )}
              {open &&
                rows.map((t) => (
                  <Task
                    key={t.id}
                    t={t}
                    slug={slug}
                    rec={tokens[slug]?.[t.title]}
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
        {handoff && (
          <p className="muted small">
            newest handoff: {handoff} <OpenBtn path={handoff} />
          </p>
        )}
        <ul className="timeline">
          {(activity || []).map((a, i) => (
            <li key={i}>
              <span className="k">{KIND[a.kind] || "•"}</span>
              <span className="d">{String(a.date).slice(0, 10)}</span>
              <span className="s">{a.summary}</span>
              {a.kind === "handoff" && a.ref && <OpenBtn path={a.ref} slug={slug} />}
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

// "Where you left off": the state file's Resume block, so a project opens on what to
// do next. Edit goes through the same sheet as Status.
function ResumePanel({ slug, state, onContinue, onEdit }) {
  const [copied, setCopied] = useState(false);
  const r = state?.resume || EMPTY_RESUME;
  const filled = Object.values(r).some(Boolean);
  const artifacts = r.artifacts.split(",").map((a) => a.trim()).filter(Boolean);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(r.rerun);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      alert("Copy failed — select the command and copy it by hand.");
    }
  };
  return (
    <section className="block resume">
      <div className="block-head">
        <span className="block-head-title">
          <h2>Where you left off</h2>
          <Help text="The Resume block of this project's state file: the last test/benchmark result, the exact command to re-run it, the branch/variant, and where its artifacts live. Sessions launched from here keep it up to date; Continue opens a session that re-orients from it without re-running anything." />
        </span>
        <span className="bar-item">
          <button className="link" onClick={onEdit}>
            {filled ? "edit" : "add"}
          </button>
          <button className="build" onClick={onContinue} title="open a Claude Code session that re-orients from this project's state">
            Continue ▶
          </button>
        </span>
      </div>
      {state?.updated && <p className="muted small resume-updated">state updated {ago(state.updated)}</p>}
      {filled ? (
        <dl className="resume-dl">
          {r.lastResult && (
            <>
              <dt>Last result</dt>
              <dd>
                <PathText text={r.lastResult} slug={slug} />
              </dd>
            </>
          )}
          {r.rerun && (
            <>
              <dt>Re-run</dt>
              <dd className="rerun">
                <code>{r.rerun}</code>
                <button className="link" onClick={copy}>
                  {copied ? "copied" : "copy"}
                </button>
              </dd>
            </>
          )}
          {r.branch && (
            <>
              <dt>Branch / variant</dt>
              <dd>{r.branch}</dd>
            </>
          )}
          {artifacts.length > 0 && (
            <>
              <dt>Artifacts</dt>
              <dd className="artifacts">
                {artifacts.map((a) => (
                  <code key={a}>
                    <PathText text={a} slug={slug} />
                  </code>
                ))}
              </dd>
            </>
          )}
        </dl>
      ) : (
        <p className="muted">Nothing recorded yet. Add the last result and the re-run command, or let a launched session fill it in.</p>
      )}
    </section>
  );
}

function StatusForm({ state, onSave }) {
  const s = state || { now: "", next: [], lastFailure: "none", blockers: "none", resume: {} };
  const [resume, setResume] = useState({ ...EMPTY_RESUME, ...s.resume });
  const setR = (k) => (e) => setResume((r) => ({ ...r, [k]: e.target.value }));
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
      <fieldset className="form-group">
        <legend>Resume — where to pick this up</legend>
        <label>
          Last result (test / benchmark outcome, with numbers)
          <input value={resume.lastResult} onChange={setR("lastResult")} />
        </label>
        <label>
          Re-run (exact command)
          <input value={resume.rerun} onChange={setR("rerun")} />
        </label>
        <label>
          Branch / variant
          <input value={resume.branch} onChange={setR("branch")} />
        </label>
        <label>
          Artifacts (comma-separated paths)
          <input value={resume.artifacts} onChange={setR("artifacts")} />
        </label>
      </fieldset>
      <button
        className="save"
        onClick={() =>
          onSave({
            resume,
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

function Task({ t, slug, rec, onEdit, onDel, onBuild, onMove }) {
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
        <TokBadge rec={rec} />
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
      {t.note && (
        <div className="tnote">
          <PathText text={t.note} slug={slug} />
        </div>
      )}
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
