import { useCallback, useEffect, useState } from "react";
import { get, send, onStream } from "./api";
import Help from "./Help.jsx";

// Batch runs (Run all / Run @seq / Home "Run selected") default to the unattended
// relay — headless claude that auto-resumes after every rate-limit reset. This flag
// is shared by every run button and persisted, so the choice sticks.
export const UNATTENDED_KEY = "pm.unattended";
export const loadUnattended = () => localStorage.getItem(UNATTENDED_KEY) !== "0";
export const saveUnattended = (v) => localStorage.setItem(UNATTENDED_KEY, v ? "1" : "0");

export function launchNotice(r, what) {
  return r.relay
    ? `Unattended run started in ${r.term} for ${what}. It resumes itself after rate-limit resets — leave the Mac awake and plugged in.`
    : `Orchestrator launched in ${r.term} for ${what}.`;
}

export function UnattendedToggle({ value, onChange }) {
  return (
    <label className="relay-toggle">
      <input
        type="checkbox"
        checked={value}
        onChange={(e) => {
          saveUnattended(e.target.checked);
          onChange(e.target.checked);
        }}
      />
      <span>Unattended</span>
      <Help
        text="On: runs headless in a terminal and, whenever the account rate limit stops it, waits for the reset time and resumes the same session — so you can leave. It can edit files but cannot run git or un-allowlisted commands (those todos get marked Blocked). Off: a normal interactive session that stops at the limit and asks permission as usual."
        side="left"
      />
    </label>
  );
}

const STATUS_LABEL = {
  running: "running",
  waiting: "waiting",
  done: "done",
  stalled: "stalled",
  failed: "failed",
  stopped: "stopped",
  dead: "not running",
};
const LIVE = new Set(["running", "waiting"]);
const RECENT_MS = 12 * 3600e3;

const fmtAt = (ms) => new Date(ms).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false });
function fmtIn(ms) {
  const m = Math.max(0, Math.round(ms / 60_000));
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
}

// Home strip: live + recently finished unattended runs (read from .claude/pm/relay).
export function RelayStrip() {
  const [jobs, setJobs] = useState([]);
  const [now, setNow] = useState(Date.now());
  const load = useCallback(
    () =>
      get("/relay")
        .then((d) => Array.isArray(d) && setJobs(d))
        .catch(() => {}),
    [],
  );
  useEffect(() => {
    load();
    return onStream(load);
  }, [load]);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const shown = jobs.filter((j) => LIVE.has(j.status) || now - (j.updatedAt || 0) < RECENT_MS).slice(0, 3);
  const dismiss = (id) => {
    setJobs((js) => js.filter((j) => j.id !== id));
    send("DELETE", `/relay/${id}`).catch(load);
  };
  if (!shown.length) return null;
  return (
    <section className="relay-strip" aria-label="unattended runs">
      {shown.map((j) => (
        <div key={j.id} className="relay-row">
          <span className={`pill relay-${j.status}`}>{STATUS_LABEL[j.status] || j.status}</span>
          <span className="relay-label">{j.label}</span>
          <span className="relay-detail muted small">
            {j.status === "waiting" && j.resumeAt
              ? `${j.waitReason || "waiting"} · resumes ${fmtAt(j.resumeAt)} (in ${fmtIn(j.resumeAt - now)}) · ${j.open} left`
              : j.status === "running"
                ? `run ${j.attempt} · ${j.open} left`
                : `${j.open} left · ${j.events?.[j.events.length - 1]?.msg || ""}`}
          </span>
          {!LIVE.has(j.status) && (
            <button type="button" className="relay-dismiss" aria-label={`dismiss ${j.label}`} onClick={() => dismiss(j.id)}>
              ✕
            </button>
          )}
        </div>
      ))}
    </section>
  );
}
