import { useCallback, useEffect, useRef, useState } from "react";
import { get, onStream } from "./api";
import Home from "./Home.jsx";
import Project from "./Project.jsx";
import Sessions from "./Sessions.jsx";
import Doctor from "./Doctor.jsx";
import Ports from "./Ports.jsx";
import Changes from "./Changes.jsx";
import Envs from "./Envs.jsx";
import Help from "./Help.jsx";

const THEME_KEY = "pm.theme";

function currentTheme() {
  const stored = localStorage.getItem(THEME_KEY);
  if (stored === "light" || stored === "dark") return stored;
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function ThemeToggle() {
  const [theme, setTheme] = useState(currentTheme);
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);
  return (
    <button
      className="theme-toggle"
      title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
      onClick={() => {
        const next = theme === "dark" ? "light" : "dark";
        localStorage.setItem(THEME_KEY, next);
        setTheme(next);
      }}
    >
      {theme === "dark" ? "☾" : "☀"}
    </button>
  );
}

// Hover button. Desktop shell: window.pmShell (electron/preload.cjs) shrinks the window and pins it on top.
// Browser: Document Picture-in-Picture (Chromium) floats a second always-on-top window showing this app in an
// iframe (state is shared via localStorage); other browsers get a plain small popup. Hidden inside that iframe.
function HoverToggle({ selfSlug }) {
  const shell = window.pmShell;
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!shell) return;
    shell.getHover().then(setOn);
    return shell.onHover(setOn);
  }, [shell]);
  if (window.self !== window.top) return null;
  const pip = window.documentPictureInPicture;
  const openFloat = async () => {
    if (pip?.window) {
      pip.window.close();
      setOn(false);
      return;
    }
    const src = location.origin + (selfSlug ? "/project/" + encodeURIComponent(selfSlug) : "/");
    if (!pip) {
      window.open(src, "pm-hover", "popup,width=420,height=640");
      return;
    }
    const w = await pip.requestWindow({ width: 420, height: 640 });
    const f = w.document.createElement("iframe");
    f.src = src;
    f.style.cssText = "border:0;width:100vw;height:100vh;display:block";
    w.document.body.style.margin = "0";
    w.document.body.append(f);
    w.addEventListener("pagehide", () => setOn(false));
    setOn(true);
  };
  return (
    <button
      className={"theme-toggle" + (on ? " on" : "")}
      title={on ? "Leave hover mode" : "Hover mode: compact, always on top"}
      onClick={() => (shell ? shell.toggleHover().then(setOn) : openFloat().catch(() => {}))}
    >
      ⧉
    </button>
  );
}

// URL <-> {view, sel} — hand-rolled, no router lib. Paths:
//   "/"               -> home
//   "/sessions"        -> sessions
//   "/doctor"          -> doctor
//   "/envs"            -> env manager
//   "/ports"           -> listening ports
//   "/changes"         -> git changes across repos
//   "/project/<slug>"  -> project view for slug
function parsePath(pathname) {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] === "project" && parts[1]) return { view: "home", sel: decodeURIComponent(parts[1]) };
  if (parts[0] === "sessions") return { view: "sessions", sel: null };
  if (parts[0] === "doctor") return { view: "doctor", sel: null };
  if (parts[0] === "envs") return { view: "envs", sel: null };
  if (parts[0] === "ports") return { view: "ports", sel: null };
  if (parts[0] === "changes") return { view: "changes", sel: null };
  return { view: "home", sel: null };
}
function pathFor(view, sel) {
  if (sel) return "/project/" + encodeURIComponent(sel);
  if (view === "sessions") return "/sessions";
  if (view === "doctor") return "/doctor";
  if (view === "envs") return "/envs";
  if (view === "ports") return "/ports";
  if (view === "changes") return "/changes";
  return "/";
}

export default function App() {
  const [projects, setProjects] = useState(null);
  const [sessions, setSessions] = useState({ inbox: [], filed: [] });
  const initial = parsePath(window.location.pathname);
  const [view, setView] = useState(initial.view); // "home" | "sessions"
  const [sel, setSel] = useState(initial.sel);
  const [detail, setDetail] = useState(null);
  const fromPopstate = useRef(false);

  const [selfSlug, setSelfSlug] = useState(null); // PM_SELF_SLUG: the board's own project, shown in a side pane
  const [pmOpen, setPmOpen] = useState(false);
  const [pmDetail, setPmDetail] = useState(null);

  const pingTimer = useRef(0);
  const loadList = useCallback(() => get("/projects?kind=all").then(setProjects), []);
  const loadPm = useCallback(() => selfSlug && get("/projects/" + selfSlug).then(setPmDetail), [selfSlug]);

  useEffect(() => {
    get("/health").then((h) => setSelfSlug(h.self || null)).catch(() => {});
  }, []);

  useEffect(() => {
    if (pmOpen) loadPm();
  }, [pmOpen, loadPm]);
  const loadSessions = useCallback(() => get("/sessions").then(setSessions), []);
  const loadDetail = useCallback((s) => get("/projects/" + s).then(setDetail), []);

  useEffect(() => {
    loadList();
    loadSessions();
  }, [loadList, loadSessions]);

  useEffect(() => {
    if (sel) loadDetail(sel);
    else setDetail(null);
  }, [sel, loadDetail]);

  useEffect(
    () =>
      onStream(() => {
        // coalesce bursts (a write fires several fs.watch events + harvest ping) into one refetch
        clearTimeout(pingTimer.current);
        pingTimer.current = setTimeout(() => {
          loadList();
          loadSessions();
          if (sel) loadDetail(sel);
          if (pmOpen) loadPm();
        }, 300);
      }),
    [sel, pmOpen, loadList, loadSessions, loadDetail, loadPm],
  );

  // back/forward: restore {view, sel} from the URL the browser navigated to
  useEffect(() => {
    const onPop = () => {
      const p = parsePath(window.location.pathname);
      fromPopstate.current = true;
      setSel(p.sel);
      setView(p.view);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // keep the URL in sync with {view, sel} whenever they change in app code
  useEffect(() => {
    if (fromPopstate.current) {
      fromPopstate.current = false;
      return;
    }
    const path = pathFor(view, sel);
    if (window.location.pathname !== path) window.history.pushState(null, "", path);
  }, [view, sel]);

  const body = sel ? (
    <Project
      slug={sel}
      data={detail}
      projects={projects || []}
      onBack={() => setSel(null)}
      reload={() => loadDetail(sel)}
    />
  ) : view === "sessions" ? (
    <Sessions
      data={sessions}
      projects={projects || []}
      onBack={() => setView("home")}
      onOpen={setSel}
      reload={loadSessions}
    />
  ) : view === "doctor" ? (
    <Doctor onBack={() => setView("home")} />
  ) : view === "envs" ? (
    <Envs onBack={() => setView("home")} />
  ) : view === "ports" ? (
    <Ports onBack={() => setView("home")} />
  ) : view === "changes" ? (
    <Changes onBack={() => setView("home")} />
  ) : (
    <Home
      projects={projects}
      inboxCount={sessions.inbox.length}
      selfSlug={selfSlug}
      onOpen={setSel}
      onSessions={() => setView("sessions")}
      onDoctor={() => setView("doctor")}
      onEnvs={() => setView("envs")}
      onPorts={() => setView("ports")}
      onChanges={() => setView("changes")}
      reload={loadList}
    />
  );

  return (
    <>
      <div className="theme-toggle-fixed hover-fixed">
        <HoverToggle selfSlug={selfSlug} />
      </div>
      <div className="theme-toggle-fixed">
        <ThemeToggle />
        <Help
          text="Switches between light and dark colors. Your choice is remembered on this device."
          side="left"
        />
      </div>
      {body}
      {!sel && view === "home" && (
        <button className="pm-pane-toggle chg-fab" onClick={() => setView("changes")} title="Uncommitted changes in every repo: keep, discard, commit, push">
          Changes
        </button>
      )}
      {!sel && view === "changes" && (
        <button className="pm-pane-toggle chg-fab" onClick={() => setView("home")} title="Back to the board">
          ‹ Back
        </button>
      )}
      {selfSlug && (
        <button className={"pm-pane-toggle" + (pmOpen ? " on" : "")} aria-pressed={pmOpen} onClick={() => setPmOpen(!pmOpen)} title={`${selfSlug}: its todos and state, open next to whatever you are doing`}>
          {pmOpen ? "Back ›" : selfSlug}
        </button>
      )}
      {selfSlug && pmOpen && (
        <aside className="pm-pane">
          <Project slug={selfSlug} data={pmDetail} projects={projects || []} onBack={() => setPmOpen(false)} reload={loadPm} />
        </aside>
      )}
    </>
  );
}
