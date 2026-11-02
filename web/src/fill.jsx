import { useCallback, useEffect, useState } from "react";
import { get, send, onStream } from "./api";
import Help from "./Help.jsx";
import { alertDialog } from "./dialog.jsx";

// Fill (server/fill.mjs): while you're away, relay jobs work the todos you marked "auto"
// until today's share of the weekly quota is used.
export function useFill() {
  const [fill, setFill] = useState(null);
  const load = useCallback(() => get("/fill").then(setFill).catch(() => {}), []);
  useEffect(() => {
    load();
    const t = setInterval(load, 60_000);
    const off = onStream(load);
    return () => {
      clearInterval(t);
      off();
    };
  }, [load]);
  return [fill, load, setFill];
}

export function AutoToggle({ on, onToggle, title, viaProject }) {
  return (
    <button
      type="button"
      className={"auto-btn" + (on ? " on" : "")}
      aria-pressed={on}
      disabled={viaProject}
      aria-label={`${on ? "unmark" : "mark"} "${title}" for unattended fill runs`}
      title={
        viaProject
          ? "Auto via the project: turn off \"Auto project\" above to pick todos one by one"
          : on
            ? "Auto: fill runs may work this todo while you're away (click to unmark)"
            : "Mark auto: let fill runs work this todo while you're away"
      }
      onClick={onToggle}
    >
      auto
    </button>
  );
}

export async function toggleAuto(slug, title, on, reload) {
  try {
    await send("PUT", "/fill/auto", { slug, title, on });
  } catch (e) {
    alertDialog(`Couldn't change auto: ${e.message || e}`);
  }
  reload();
}

// Whole project auto: fill runs take every open todo, and todos added later join the next run.
export function AutoProjectToggle({ slug, on: saved, reload }) {
  const [on, setOn] = useState(saved);
  useEffect(() => setOn(saved), [saved]);
  const flip = async (next) => {
    setOn(next);
    try {
      await send("PUT", "/fill/auto-project", { slug, on: next });
    } catch (e) {
      alertDialog(`Couldn't change auto project: ${e.message || e}`);
    }
    reload();
  };
  return (
    <label className="relay-toggle auto-project" title="Let fill runs work every open todo here while you're away, including todos added later">
      <input type="checkbox" checked={on} onChange={(e) => flip(e.target.checked)} />
      <span>Auto project</span>
    </label>
  );
}

// Everything fill may pick up, per project: the one place to see and unselect it all,
// whichever project page or Latest todos row it was marked on.
function AutoList({ fill, load, onOpen }) {
  const list = fill.autoList || [];
  const projects = fill.autoProjects || [];
  const slugs = [...new Set([...projects, ...list.map((t) => t.slug)])];
  return (
    <div className="fill-list">
      {slugs.map((slug) => (
        <div className="fill-group" key={slug}>
          <div className="fill-group-head">
            <button type="button" className="link" onClick={() => onOpen(slug)} title="Open this project">{slug}</button>
            {projects.includes(slug) && <AutoProjectToggle slug={slug} on reload={load} />}
          </div>
          {list.filter((t) => t.slug === slug).map((t) => (
            <div className="fill-row" key={t.title}>
              <span className="fill-row-title">
                {t.title}
                {t.skipped && <span className="muted small"> (skipped: fill tried it twice this week)</span>}
              </span>
              <AutoToggle on viaProject={t.viaProject} title={t.title} onToggle={() => toggleAuto(slug, t.title, false, load)} />
            </div>
          ))}
          {projects.includes(slug) && !list.some((t) => t.slug === slug) && <div className="muted small">No open todos right now; new ones join automatically.</div>}
        </div>
      ))}
    </div>
  );
}

const LIST_OPEN_KEY = "pm.fillListOpen";

const pct = (n) => (typeof n === "number" ? `${Math.round(n)}%` : "–");
const hhmm = (ms) => (ms ? new Date(ms).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }) : "");

// Home owns the useFill() state and shares it with Latest todos' auto pills.
export function FillPanel({ fill, load, setFill, onOpen }) {
  const [busy, setBusy] = useState(false);
  const [listOpen, setListOpen] = useState(() => localStorage.getItem(LIST_OPEN_KEY) === "1");
  if (!fill) return null;
  const { settings, limits, target, queued, decision } = fill;
  const hasList = !!(fill.autoList?.length || fill.autoProjects?.length);
  const flipList = () => {
    localStorage.setItem(LIST_OPEN_KEY, listOpen ? "0" : "1");
    setListOpen(!listOpen);
  };
  const save = async (patch) => {
    setFill((f) => ({ ...f, settings: { ...f.settings, ...patch } }));
    try {
      await send("PUT", "/fill/settings", patch);
    } catch (e) {
      alertDialog(`Couldn't save fill settings: ${e.message || e}`);
    }
    load();
  };
  const runNow = async () => {
    setBusy(true);
    try {
      const r = await send("POST", "/fill/run");
      alertDialog(
        r.pending
          ? `No quota right now (${r.why}). Fill will start by itself once quota frees up.`
          : `Fill run started (job ${r.job}). It runs in the background; watch it in the strip below.`,
      );
    } catch (e) {
      alertDialog(`Nothing to fill right now: ${e.message || e}`);
    }
    setBusy(false);
    load();
  };
  const week = limits?.week;
  const fillW = week && target ? Math.min(100, (week.pct / Math.max(target, 1)) * 100) : 0;
  return (
    <section className="fill-panel" aria-label="fill unused quota">
      <div className="fill-head">
        <label className="relay-toggle">
          <input type="checkbox" checked={settings.enabled} onChange={(e) => save({ enabled: e.target.checked })} />
          <span>Fill unused quota</span>
        </label>
        <Help
          text={`While you're away (no keyboard/mouse for ${settings.idleMin} min, pm running, Mac awake), pm starts unattended relay runs over the todos you marked "auto", up to ${settings.batch} at a time. Today's target is a daily share of your weekly limit (unused days roll forward), minus a ${settings.reservePct}% reserve for you. A run stops itself at the target.`}
          side="left"
        />
        <button
          type="button"
          className={"fill-queued small" + (listOpen && hasList ? " open" : "")}
          aria-expanded={listOpen && hasList}
          disabled={!hasList}
          onClick={flipList}
          title={hasList ? "See which todos fill may work, and unselect them" : "Nothing marked auto yet"}
        >
          {queued} auto todo{queued === 1 ? "" : "s"}
        </button>
        <button type="button" className="fill-run" disabled={busy || !queued} onClick={runNow} title="Start a fill run now, even if you're at the keyboard">
          {busy ? "Starting…" : "Fill now"}
        </button>
      </div>
      {listOpen && hasList && <AutoList fill={fill} load={load} onOpen={onOpen} />}
      <div className="fill-meter" title={week ? `weekly ${pct(week.pct)} used, target by tonight ${pct(target)}` : "no limit data yet"}>
        <div className="fill-bar" style={{ width: `${fillW}%` }} />
      </div>
      <div className="muted small fill-line">
        {week ? (
          <>
            week {pct(week.pct)} → today's target {pct(target)}
            {limits.fiveHour ? ` · 5h ${pct(limits.fiveHour.pct)}` : ""}
            {week.resetsAtMs ? ` · resets ${hhmm(week.resetsAtMs)}` : ""}
          </>
        ) : (
          "No limit numbers yet: the first run learns them (or let the statusline save them, see docs/guide.md)."
        )}
        <span className="fill-why"> · {decision.go ? "ready" : decision.why}</span>
        {settings.pending && (
          <span className="fill-why">
            {" · waiting for quota, starts by itself "}
            <button type="button" className="link" onClick={() => save({ pending: false })}>Cancel</button>
          </span>
        )}
      </div>
      {settings.enabled && (
        <div className="fill-opts small muted">
          <label>
            idle
            <input type="number" min="0" max="720" value={settings.idleMin} onChange={(e) => save({ idleMin: Math.max(0, Math.min(720, parseInt(e.target.value, 10) || 0)) })} />
            min
          </label>
          <label>
            reserve
            <input type="number" min="0" max="50" value={settings.reservePct} onChange={(e) => save({ reservePct: Math.max(0, Math.min(50, parseInt(e.target.value, 10) || 0)) })} />
            %
          </label>
          <label>
            batch
            <input type="number" min="1" max="20" value={settings.batch} onChange={(e) => save({ batch: Math.max(1, Math.min(20, parseInt(e.target.value, 10) || 1)) })} />
          </label>
        </div>
      )}
    </section>
  );
}
