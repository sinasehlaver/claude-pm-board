import { send } from "./api";
import { alertDialog } from "./dialog.jsx";
import { loadColor, termBg } from "./projectColor.jsx";

// Start/Stop for a project's ./start.sh, plus ↗ to the running app. `p` = { slug, title, hasStart, running }.
export default function StartButton({ p, reload }) {
  if (!p.hasStart) return null;
  const running = p.running || [];
  const on = running.length > 0;
  const toggle = (e) => {
    e.stopPropagation();
    const req = on
      ? send("POST", `/projects/${p.slug}/stop`)
      : send("POST", `/projects/${p.slug}/start`, { bg: termBg(p.slug, loadColor(p.slug)) });
    // No file changes, so no SSE ping. The server caches listening ports for 4s, hence the second refetch.
    req.then(() => [1500, 6000].forEach((ms) => setTimeout(reload, ms))).catch((err) => alertDialog(err.message));
  };
  return (
    <span className="start-wrap">
      <button
        className={"start-btn" + (on ? " is-running" : "")}
        title={on ? "Running — click to stop it" : "Run ./start.sh in a terminal"}
        aria-label={`${on ? "Stop" : "Start"} ${p.title}`}
        onClick={toggle}
      >
        <span className="start-ico">{on ? "■" : "▶"}</span>
        <span className="start-txt">
          <b>{on ? "Stop" : "Start"}</b>
          <small>{on ? running.slice(0, 3).map((r) => ":" + r.port).join(" ") : "./start.sh"}</small>
        </span>
      </button>
      {on && (
        <a
          className="app-open-btn"
          href={`http://127.0.0.1:${running[0].port}`}
          target="_blank"
          rel="noreferrer noopener"
          title={`Open http://127.0.0.1:${running[0].port} in a new tab`}
          aria-label={`Open ${p.title} app`}
          onClick={(e) => e.stopPropagation()}
        >
          ↗
        </a>
      )}
    </span>
  );
}
