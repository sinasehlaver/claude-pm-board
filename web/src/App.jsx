import { useCallback, useEffect, useState } from "react";
import { get, onStream } from "./api";
import Home from "./Home.jsx";
import Project from "./Project.jsx";
import Sessions from "./Sessions.jsx";
import Continuous from "./Continuous.jsx";

export default function App() {
  const [projects, setProjects] = useState(null);
  const [sessions, setSessions] = useState({ inbox: [], filed: [] });
  const [cont, setCont] = useState({ status: null, log: [] });
  const [view, setView] = useState("home"); // "home" | "sessions" | "continuous"
  const [sel, setSel] = useState(null);
  const [detail, setDetail] = useState(null);

  const loadList = useCallback(() => get("/projects").then(setProjects), []);
  const loadSessions = useCallback(() => get("/sessions").then(setSessions), []);
  const loadDetail = useCallback((s) => get("/projects/" + s).then(setDetail), []);
  const loadCont = useCallback(
    () =>
      Promise.all([get("/continuous"), get("/continuous/log?n=60")]).then(([status, log]) =>
        setCont({ status, log }),
      ),
    [],
  );

  useEffect(() => {
    loadList();
    loadSessions();
  }, [loadList, loadSessions]);

  useEffect(() => {
    if (sel) loadDetail(sel);
    else setDetail(null);
  }, [sel, loadDetail]);

  useEffect(() => {
    if (view === "continuous") loadCont();
  }, [view, loadCont]);

  useEffect(
    () =>
      onStream(() => {
        loadList();
        loadSessions();
        if (sel) loadDetail(sel);
        if (view === "continuous") loadCont();
      }),
    [sel, view, loadList, loadSessions, loadDetail, loadCont],
  );

  if (sel)
    return (
      <Project
        slug={sel}
        data={detail}
        projects={projects || []}
        onBack={() => setSel(null)}
        reload={() => loadDetail(sel)}
      />
    );
  if (view === "sessions")
    return (
      <Sessions
        data={sessions}
        projects={projects || []}
        onBack={() => setView("home")}
        onOpen={setSel}
        reload={loadSessions}
      />
    );
  if (view === "continuous")
    return (
      <Continuous
        status={cont.status}
        log={cont.log}
        onBack={() => setView("home")}
        reload={loadCont}
      />
    );
  return (
    <Home
      projects={projects}
      inboxCount={sessions.inbox.length}
      onOpen={setSel}
      onSessions={() => setView("sessions")}
      onContinuous={() => setView("continuous")}
      reload={loadList}
    />
  );
}
