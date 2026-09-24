import { useCallback, useEffect, useRef, useState } from "react";
import { get, onStream } from "./api";
import Home from "./Home.jsx";
import Project from "./Project.jsx";
import Sessions from "./Sessions.jsx";
import Usage from "./Usage.jsx";
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

// URL <-> {view, sel} — hand-rolled, no router lib. Paths:
//   "/"               -> home
//   "/sessions"        -> sessions
//   "/usage"           -> usage
//   "/project/<slug>"  -> project view for slug
function parsePath(pathname) {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] === "project" && parts[1]) return { view: "home", sel: decodeURIComponent(parts[1]) };
  if (parts[0] === "sessions") return { view: "sessions", sel: null };
  if (parts[0] === "usage") return { view: "usage", sel: null };
  return { view: "home", sel: null };
}
function pathFor(view, sel) {
  if (sel) return "/project/" + encodeURIComponent(sel);
  if (view === "sessions") return "/sessions";
  if (view === "usage") return "/usage";
  return "/";
}

export default function App() {
  const [projects, setProjects] = useState(null);
  const [sessions, setSessions] = useState({ inbox: [], filed: [] });
  const initial = parsePath(window.location.pathname);
  const [view, setView] = useState(initial.view); // "home" | "sessions" | "usage"
  const [sel, setSel] = useState(initial.sel);
  const [detail, setDetail] = useState(null);
  const fromPopstate = useRef(false);

  const loadList = useCallback(() => get("/projects").then(setProjects), []);
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
        loadList();
        loadSessions();
        if (sel) loadDetail(sel);
      }),
    [sel, loadList, loadSessions, loadDetail],
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
  ) : view === "usage" ? (
    <Usage onBack={() => setView("home")} />
  ) : (
    <Home
      projects={projects}
      inboxCount={sessions.inbox.length}
      onOpen={setSel}
      onSessions={() => setView("sessions")}
      onUsage={() => setView("usage")}
      reload={loadList}
    />
  );

  return (
    <>
      <div className="theme-toggle-fixed">
        <ThemeToggle />
        <Help
          text="Switches between light and dark colors. Your choice is remembered on this device."
          side="left"
        />
      </div>
      {body}
    </>
  );
}
