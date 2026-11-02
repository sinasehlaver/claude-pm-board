import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "./tour.css";

export const TOUR_KEY = "pm.tour.done";

// page: "home" | "ideas" | "project" | "tool" (the tour opens that page itself).
// expand: selector of a collapse toggle to open while the step shows (closed again when leaving).
// inFold: target sits inside Home's Projects fold, opened while the step shows.
// optional: skipped when its target never appears (feature off / nothing to show).
const STEPS = [
  { page: "home", sel: null, title: "Welcome to pm", text: "A board over your projects' Markdown files. Use ← → (or Back / Next) to move, and click the highlighted thing to try it: the tour stays open. Esc leaves." },
  { page: "home", sel: ".help-menu summary", title: "Help menu", text: "Sessions (file past Claude conversations to projects), Doctor (where tokens and errors go), Setup (which claude to launch, model, status line) and this Tour." },
  { page: "home", inFold: true, sel: "input[type=search]", title: "Find a project", text: "Search and sort your projects here. Filter hides ones you do not want in the list; nothing is deleted." },
  { page: "home", sel: ".burn-strip", title: "Spend", text: "Estimated Claude Code cost: current 5h block, today and the last 7 days." },
  { page: "home", sel: ".fill-panel", optional: true, title: "Fill unused quota", text: "Runs your auto todos when weekly quota would otherwise go unused. Fill now starts a run immediately." },
  { page: "home", sel: ".ideas-pill", optional: true, title: "Ideas inbox", text: "Your capture inbox, always on top. Click it to open it; Next opens it for you." },
  { page: "home", inFold: true, sel: ".cards .card", title: "Project cards", text: "Click a card to open a project. Next shows you what is inside one." },
  { page: "home", inFold: true, sel: ".start-wrap", optional: true, title: "Start / Stop", text: "▶ runs the project's start.sh in a terminal. While it listens it turns green with its port; ■ stops it. ↗ opens it in the browser." },
  { page: "home", inFold: true, sel: ".card-auto", optional: true, title: "Auto project", text: "Marks every open todo of a project as fair game for Fill." },
  { page: "home", inFold: true, sel: ".tools-group-head", expand: ".tools-group-head", optional: true, title: "Tools", text: "Entries that are tools rather than projects live in this group (opened here so you can see them)." },
  { page: "home", sel: ".lt", expand: ".lt-head-toggle", title: "Latest todos", text: "Add a todo to any project and see the newest open ones across projects. Tick some and run them: unattended via the relay (waits out rate limits) or interactive." },
  { page: "home", sel: ".hover-fixed button", optional: true, title: "Hover mode", text: "Pops pm into a small always-on-top window beside whatever you are working on." },
  { page: "home", sel: ".chg-fab", title: "Changes", text: "Uncommitted changes in every repo: keep, discard, commit or push, with no terminal." },
  { page: "home", sel: ".pal-open", title: "Command palette", text: "⌘K (Ctrl K) jumps to any project or page and runs actions; g then h/s/d/u… are quick chords." },
  { page: "home", sel: ".theme-toggle-fixed:not(.hover-fixed) .theme-toggle:not(.pal-open)", title: "Theme", text: "Light or dark." },

  { page: "ideas", sel: ".screen .bar", title: "Ideas inbox page", text: "One line per idea. ▶ on an idea researches it; if it is worth building it becomes a project. Ideas that just ask for research end as a report." },
  { page: "ideas", sel: ".block-head .bar-item", title: "Run ideas", text: "Tick ideas and run them together. Same toolbar as any project: Unattended toggle, model, Run selected." },
  { page: "ideas", sel: ".back", title: "Back", text: "This button goes back to the board. Click it, or press Next and the tour does it for you." },

  { page: "project", sel: ".screen .bar", title: "A project page", text: "The title bar has the colour picker and Back." },
  { page: "project", sel: "section.block", title: "Status", text: "Hand-written 'where is this project': click to read or edit. The Where you left off panel below it holds the resume notes for the next session." },
  { page: "project", sel: ".block-head .link[title^=\"static audit\"]", optional: true, title: "Security audit", text: "Starts a Claude session that audits this project against a breach catalogue. pm runs no scanner itself." },
  { page: "project", sel: ".block-head .bar-item", title: "Backlog toolbar", text: "Select all, ▶▶ Run selected / all, model and Unattended. Auto project lets Fill pick up every open todo." },
  { page: "project", sel: ".tg", title: "Todos", text: "Grouped Doing / Todo / Blocked / Done. Tick to select, ▶ launches Claude on one. Done has a Compact link to merge old entries." },

  { page: "tool", sel: ".screen .bar", title: "A tool page", text: "Tools are projects too (same backlog, status and launch buttons); they just sit in their own group on the board." },
  { page: "tool", sel: ".tg", title: "Tool todos", text: "Same todo groups as a project." },

  { page: "home", sel: null, title: "That is it", text: "Replay any time from Help → Tour or the palette." },
];

const PAD = 6;
const GAP = 10;

function find(sel) {
  if (!sel) return null;
  const el = document.querySelector(sel);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return r.width && r.height ? el : null;
}

function pageSlug(page, projects) {
  if (page === "home") return null;
  if (page === "ideas") return projects.find((p) => p.pinned)?.slug;
  if (page === "project") return projects.find((p) => !p.pinned && (p.kind || "project") === "project")?.slug;
  return projects.find((p) => !p.pinned && (p.kind || "project") !== "project")?.slug;
}

const same = (a, b) => a && b && a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height;

export default function Tour({ open, onClose, projects, sel, onNav }) {
  const [steps, setSteps] = useState(STEPS);
  const [i, setI] = useState(0);
  const [rect, setRect] = useState(null);
  const [ch, setCh] = useState(190);
  const cardRef = useRef(null);
  const dir = useRef(1);
  const restore = useRef(null);
  const expect = useRef(null);
  const live = useRef({});
  live.current = { sel, onNav, i, steps };

  const undoExpand = () => { restore.current?.(); restore.current = null; };

  useEffect(() => {
    if (!open) return;
    const list = projects || [];
    setSteps(STEPS.filter((s) => s.page === "home" || pageSlug(s.page, list)));
    setI(0);
    dir.current = 1;
  }, [open]);

  const step = steps[Math.min(i, steps.length - 1)];
  const last = i >= steps.length - 1;
  const close = () => {
    undoExpand();
    if (live.current.sel) live.current.onNav(null);
    onClose();
  };
  const go = (d) => {
    dir.current = d;
    if (d > 0 && last) return close();
    setI((n) => Math.max(0, n + d));
  };

  // Per step: open the right page, wait for the target, open its collapse, then follow it.
  useEffect(() => {
    if (!open || !step) return;
    undoExpand();
    setRect(null);
    const want = pageSlug(step.page, projects || []) ?? null;
    expect.current = want;
    if (want !== (live.current.sel ?? null)) live.current.onNav(want);
    let tries = 0, expanded = false, settled = false, skipped = false, seen = false;
    const tick = () => {
      // Home's Projects fold may be closed: open it for the steps inside, close it again on leaving.
      if (step.inFold) {
        const fold = document.querySelector(".projects-head");
        if (fold?.getAttribute("aria-expanded") === "false") {
          fold.click();
          const prev = restore.current;
          restore.current = () => {
            prev?.();
            const b = document.querySelector(".projects-head");
            if (b?.getAttribute("aria-expanded") === "true") b.click();
          };
          return;
        }
      }
      const el = find(step.sel);
      if (!el) {
        if (step.sel) setRect(null);
        if (step.sel && step.optional && !seen && ++tries > 14 && !skipped) {
          skipped = true;
          const n = live.current.i + dir.current;
          if (n < 0 || n >= live.current.steps.length) close();
          else setI(n);
        }
        return;
      }
      seen = true;
      if (step.expand && !expanded) {
        expanded = true;
        if (el.getAttribute("aria-expanded") === "false") {
          const sel2 = step.expand;
          const prev = restore.current;
          el.click();
          restore.current = () => {
            const b = document.querySelector(sel2);
            if (b && b.getAttribute("aria-expanded") === "true") b.click();
            prev?.();
          };
          return;
        }
      }
      if (!settled) { settled = true; el.scrollIntoView({ block: "center" }); }
      const r = el.getBoundingClientRect();
      setRect((o) => (same(o, r) ? o : r));
    };
    tick();
    const id = setInterval(tick, 150);
    return () => clearInterval(id);
  }, [open, step]);

  // The user clicked their way to another page: follow them to that page's steps.
  useEffect(() => {
    if (!open || (sel ?? null) === expect.current) return;
    expect.current = sel ?? null;
    const { steps: st, i: cur } = live.current;
    const slug = (pg) => pageSlug(pg, projects || []) ?? null;
    let idx = -1;
    if (sel == null) idx = st.findIndex((x, k) => k > cur && x.page === "home");
    else idx = st.findIndex((x) => x.page !== "home" && slug(x.page) === sel);
    if (idx >= 0) { dir.current = 1; setI(idx); }
  }, [sel]);

  useEffect(() => () => undoExpand(), []);

  useLayoutEffect(() => {
    const h = cardRef.current?.offsetHeight;
    if (h && h !== ch) setCh(h);
  });

  useEffect(() => {
    if (!open) return;
    const key = (e) => {
      if (e.key === "Escape") { e.stopPropagation(); close(); return; }
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      const t = e.target;
      if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return;
      e.preventDefault();
      e.stopPropagation();
      go(e.key === "ArrowRight" ? 1 : -1);
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  });

  if (!open || !step) return null;

  const vw = window.innerWidth, vh = window.innerHeight, W = Math.min(320, vw - 24);
  let style = { width: W, left: (vw - W) / 2, top: Math.max(12, vh / 2 - ch / 2) };
  if (rect) {
    const left = Math.max(12, Math.min(rect.left, vw - W - 12));
    if (rect.bottom + PAD + GAP + ch < vh) style = { width: W, left, top: rect.bottom + PAD + GAP };
    else if (rect.top - PAD - GAP - ch > 0) style = { width: W, left, top: rect.top - PAD - GAP - ch };
    else style = { width: W, left: Math.max(12, vw - W - 12), top: Math.max(12, vh - ch - 12) };
  }

  const n = Math.min(i, steps.length - 1);
  return createPortal(
    <div className="tour" role="dialog" aria-label="Tour">
      {rect ? (
        <div
          className="tour-hole"
          style={{ left: rect.left - PAD, top: rect.top - PAD, width: rect.width + PAD * 2, height: rect.height + PAD * 2 }}
        />
      ) : (
        <div className="tour-dim" />
      )}
      <div className="tour-card" ref={cardRef} style={style}>
        <div className="tour-step">{n + 1} / {steps.length}</div>
        <h3>{step.title}</h3>
        <p>{step.text}</p>
        <div className="tour-actions">
          <button className="dlg-btn" onClick={close}>Skip</button>
          <span style={{ flex: 1 }} />
          {i > 0 && <button className="dlg-btn" onClick={() => go(-1)}>Back</button>}
          <button className="dlg-btn primary" onClick={() => go(1)}>{last ? "Done" : "Next"}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
