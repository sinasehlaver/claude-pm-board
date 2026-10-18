// Terminal UI core for pm — pure model + render, no tty. `server/tui.mjs` wires it to
// stdin/stdout; tests inject fake `deps`. Runs on the Mac and is reached over SSH
// (Termius -> Tailscale), so there is no network surface of its own.
import { STATES } from "./backlog.mjs";

const ESC = "\x1b";
export const TITLE_MAX = 200;
const STATE_ICON = { Doing: "▶", Todo: "○", Blocked: "✖", Done: "✔" };
const STATE_COLOR = { Doing: 33, Todo: 37, Blocked: 31, Done: 32 };
const JOB_COLOR = { running: 33, waiting: 36, done: 32, stalled: 31, dead: 31 };

const paint = (code, s) => `${ESC}[${code}m${s}${ESC}[0m`;
const dim = (s) => paint(2, s);
const bold = (s) => paint(1, s);
export const wrap = (s, n) => {
  const out = [];
  let cur = "";
  for (let word of s.split(" ")) {
    while (word.length > n) {
      if (cur) out.push(cur);
      out.push(word.slice(0, n));
      word = word.slice(n);
      cur = "";
    }
    if (cur && cur.length + 1 + word.length > n) {
      out.push(cur);
      cur = word;
    } else cur = cur ? `${cur} ${word}` : word;
  }
  out.push(cur);
  return out;
};
const clip = (s, n) => (s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : s);
// Strip control chars (incl. ESC) so file/transcript-derived text can't drive the terminal.
export const clean = (s) => String(s ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");

// Split a raw stdin chunk into key tokens (escape sequences stay whole; a paste is many chars).
export function parseKeys(chunk) {
  return String(chunk).match(/\x1b\[[0-9;]*[A-Za-z~]|\x1b|[\s\S]/gu) || [];
}

export function sanitizeTitle(s) {
  return clean(s).replace(/\s+/g, " ").trim().slice(0, TITLE_MAX);
}

// Todos currently owned by a live relay job: Set of "slug\0title".
export function runningSet(jobs) {
  const out = new Map();
  for (const j of jobs || [])
    if (j.status === "running" || j.status === "waiting")
      for (const t of j.tasks || []) out.set(`${t.slug}\0${t.title}`, j.status);
  return out;
}

export function fmtAge(ms) {
  const m = Math.max(0, Math.floor(ms / 60000));
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

export function groupTasks(tasks, showDone) {
  return STATES.filter((s) => showDone || s !== "Done").flatMap((s) => tasks.filter((t) => t.state === s));
}

// One-line Claude spend (the 5h/today/7d USD numbers the statusline shows); null when none.
export function usageLine(u) {
  if (!u || u.block == null) return null;
  const usd = (v) => `$${(v ?? 0).toFixed(2)}`;
  return `claude 5h ${paint(32, usd(u.block))} · today ${usd(u.today)} · 7d ${usd(u.week)}`;
}

export function createApp(deps) {
  const m = {
    screen: "projects", // projects | project | jobs
    projects: [],
    cursor: 0,
    slug: null,
    tasks: [],
    tcursor: 0,
    showDone: false,
    jobs: [],
    jcursor: 0,
    marked: new Set(),
    pending: null, // confirm: {kind:"run",tasks} | {kind:"stop",id}
    mode: "nav", // nav | add | move | confirm
    input: "",
    msg: "",
    quit: false,
  };

  const visibleTasks = () => groupTasks(m.tasks, m.showDone);
  const clamp = (i, n) => Math.max(0, Math.min(i, n - 1));

  async function refresh() {
    try {
      m.jobs = await deps.listJobs();
      m.jcursor = clamp(m.jcursor, m.jobs.length);
      if (m.screen === "projects") {
        m.projects = await deps.listProjects();
        m.cursor = clamp(m.cursor, m.projects.length);
      } else if (m.screen === "project") {
        const b = await deps.readBacklog(m.slug);
        m.tasks = b ? b.tasks : [];
        m.tcursor = clamp(m.tcursor, visibleTasks().length);
      }
    } catch (e) {
      m.msg = `error: ${clean(e.message)}`;
    }
  }

  async function open(screen, slug = null) {
    m.screen = screen;
    m.slug = slug;
    m.tcursor = 0;
    m.mode = "nav";
    m.msg = "";
    await refresh();
  }

  async function key(k) {
    if (m.mode === "add") return addKey(k);
    if (m.mode === "move") return moveKey(k);
    if (m.mode === "confirm") return confirmKey(k);
    const up = k === `${ESC}[A` || k === "k";
    const down = k === `${ESC}[B` || k === "j";
    if (k === "q" || k === "\x03") m.quit = true;
    else if (k === "R") await refresh();
    else if (m.screen === "projects") {
      if (up) m.cursor = clamp(m.cursor - 1, m.projects.length);
      else if (down) m.cursor = clamp(m.cursor + 1, m.projects.length);
      else if ((k === "\r" || k === "l" || k === `${ESC}[C`) && m.projects[m.cursor]) await open("project", m.projects[m.cursor].slug);
      else if (k === "r") await open("jobs");
    } else if (m.screen === "project") {
      const list = visibleTasks();
      if (up) m.tcursor = clamp(m.tcursor - 1, list.length);
      else if (down) m.tcursor = clamp(m.tcursor + 1, list.length);
      else if (k === ESC || k === "b" || k === "h" || k === `${ESC}[D`) await open("projects");
      else if (k === "a") (m.mode = "add"), (m.input = ""), (m.msg = "");
      else if (k === "m" && list[m.tcursor]) (m.mode = "move"), (m.msg = "");
      else if (k === "d") (m.showDone = !m.showDone), (m.tcursor = 0);
      else if (k === " " && list[m.tcursor]) {
        const t = list[m.tcursor].title;
        m.marked.has(t) ? m.marked.delete(t) : m.marked.add(t);
      } else if (k === "x") askRun(list);
      else if (k === "r") await open("jobs");
    } else if (up) m.jcursor = clamp(m.jcursor - 1, m.jobs.length);
    else if (down) m.jcursor = clamp(m.jcursor + 1, m.jobs.length);
    else if (k === "s" && m.jobs[m.jcursor]) {
      const j = m.jobs[m.jcursor];
      if (j.status === "running" || j.status === "waiting") (m.mode = "confirm"), (m.pending = { kind: "stop", id: j.id, label: j.label });
      else m.msg = "job is not running";
    } else if (k === ESC || k === "b" || k === "h" || k === `${ESC}[D`) await open("projects");
  }

  function askRun(list) {
    m.msg = "";
    if (m.slug === "ideas") return void (m.msg = "ideas are researched from the web board, not run here");
    const running = runningSet(m.jobs);
    const picked = m.marked.size ? list.filter((t) => m.marked.has(t.title)) : [list[m.tcursor]].filter(Boolean);
    const tasks = picked.filter((t) => (t.state === "Todo" || t.state === "Doing") && !running.has(`${m.slug}\0${t.title}`));
    if (!tasks.length) return void (m.msg = "nothing runnable selected (already running, blocked or done)");
    m.mode = "confirm";
    m.pending = { kind: "run", tasks: tasks.map((t) => ({ slug: m.slug, title: t.title })) };
  }

  async function confirmKey(k) {
    const p = m.pending;
    m.mode = "nav";
    m.pending = null;
    if (k !== "y" || !p) return void (m.msg = "cancelled");
    try {
      if (p.kind === "run") {
        m.msg = clean(await deps.runTodos(m.slug, p.tasks.map((t) => t.title)));
        m.marked.clear();
      } else m.msg = clean(await deps.stopJob(p.id));
    } catch (e) {
      m.msg = `error: ${clean(e.message)}`;
    }
    await refresh();
  }

  async function addKey(k) {
    if (k === ESC) (m.mode = "nav"), (m.input = "");
    else if (k === "\r") {
      const title = sanitizeTitle(m.input);
      m.mode = "nav";
      m.input = "";
      if (!title) return;
      try {
        m.msg = clean(await deps.addTask(m.slug, title));
      } catch (e) {
        m.msg = `error: ${clean(e.message)}`;
      }
      await refresh();
    } else if (k === "\x7f" || k === "\b") m.input = m.input.slice(0, -1);
    else if (k === "\n") m.input = (m.input + " ").slice(0, TITLE_MAX * 2);
    else if (k.length === 1 && k >= " ") m.input = (m.input + k).slice(0, TITLE_MAX * 2);
    else if (k.length > 1 && !k.startsWith(ESC)) m.input = (m.input + k).slice(0, TITLE_MAX * 2);
  }

  async function moveKey(k) {
    const t = visibleTasks()[m.tcursor];
    m.mode = "nav";
    const to = STATES[Number(k) - 1];
    if (!t || !to) return;
    try {
      m.msg = clean(await deps.moveTask(m.slug, to, t.title));
    } catch (e) {
      m.msg = `error: ${clean(e.message)}`;
    }
    await refresh();
  }

  function view(cols = 80, rows = 24) {
    const w = Math.max(20, cols - 1);
    const out = [];
    const body = Math.max(3, rows - 4);
    const window = (items, cur) => {
      const start = Math.max(0, Math.min(cur - Math.floor(body / 2), items.length - body));
      return items.slice(start, start + body).map((it, i) => ({ it, idx: start + i }));
    };
    if (m.screen === "projects") {
      out.push(bold("pm · projects"));
      for (const { it: p, idx } of window(m.projects, m.cursor)) {
        const nr = [...runningSet(m.jobs).keys()].filter((k) => k.startsWith(`${p.slug}\0`)).length;
        const tag = (p.blocked ? paint(31, " ✖") : "") + (nr ? paint(33, ` ⟳${nr}`) : "");
        const line = `${String(p.openCount).padStart(3)}  ${p.slug}${tag}  ${dim(clip(clean(p.status), Math.max(0, w - p.slug.length - 12)))}`;
        out.push(idx === m.cursor ? `${ESC}[7m${line}${ESC}[0m` : line);
      }
      if (!m.projects.length) out.push(dim("no projects"));
    } else if (m.screen === "project") {
      const list = visibleTasks();
      const running = runningSet(m.jobs);
      const nRun = [...running.keys()].filter((k) => k.startsWith(`${m.slug}\0`)).length;
      out.push(bold(`pm · ${m.slug}`) + dim(m.showDone ? "  (incl. done)" : "") + (nRun ? paint(33, `  ⟳ ${nRun} running`) : ""));
      const tok = deps.tokens?.()?.[m.slug] || {};
      const blocks = list.map((t, idx) => {
        const rec = tok[t.title];
        const extra = (t.priority ? ` p${t.priority}` : "") + (rec?.tokens ? ` ${rec.split ? "~" : ""}${Math.round(rec.tokens / 1000)}k tok` : "");
        const rs = t.state === "Done" ? null : running.get(`${m.slug}\0${t.title}`);
        const mark = m.marked.has(t.title) ? paint(36, "◆") : " ";
        const badge = rs ? paint(rs === "waiting" ? 36 : 33, rs === "waiting" ? " ⏸ waiting" : " ⟳ running") : "";
        const parts = wrap(clean(t.title), Math.max(10, w - 3 - extra.length - (rs ? 10 : 0)));
        const lines = parts.map((part, i) => {
          const tail = i === parts.length - 1 ? dim(extra) + badge : "";
          return i === 0 ? `${mark}${paint(STATE_COLOR[t.state], STATE_ICON[t.state])} ${part}${tail}` : `   ${part}${tail}`;
        });
        if (idx !== m.tcursor) return lines;
        const shown = lines.map((l) => `${ESC}[7m${l}${ESC}[0m`);
        if (t.note) shown.push(...wrap(clean(t.note), Math.max(10, w - 4)).map((l) => dim(`    ${l}`)));
        return shown;
      });
      let lo = Math.min(m.tcursor, blocks.length - 1);
      let hi = lo;
      let used = blocks[lo]?.length || 0;
      while (lo > 0 || hi < blocks.length - 1) {
        const up = lo > 0 && used + blocks[lo - 1].length <= body;
        const down = hi < blocks.length - 1 && used + blocks[hi + 1].length <= body;
        if (!up && !down) break;
        if (up && (!down || m.tcursor - lo <= hi - m.tcursor)) used += blocks[--lo].length;
        else used += blocks[++hi].length;
      }
      for (let i = lo; i <= hi && blocks[i]; i++) out.push(...blocks[i]);
      if (!list.length) out.push(dim("nothing here — press a to add a todo"));
    } else {
      out.push(bold("pm · relay jobs"));
      if (!m.jobs.length) out.push(dim("no relay jobs"));
      const per = 4;
      const first = Math.max(0, Math.min(m.jcursor - 1, m.jobs.length - Math.floor(body / per)));
      for (const [i, j] of m.jobs.slice(first, first + Math.max(1, Math.floor(body / per))).entries()) {
        const sel = first + i === m.jcursor;
        const live = j.status === "running" || j.status === "waiting";
        const age = j.startedAt ? ` ${fmtAge((live ? Date.now() : j.updatedAt || Date.now()) - j.startedAt)}` : "";
        const left = Number.isFinite(j.open) ? ` · ${j.open}/${(j.tasks || []).length} open` : "";
        const head = `${paint(JOB_COLOR[j.status] || 37, clean(j.status))} ${clip(clean(j.label || j.id), w - 30)}${dim(age + left)}`;
        out.push(sel ? `${ESC}[7m${head}${ESC}[0m` : head);
        if (j.status === "waiting" && j.waitReason) out.push(dim(`   ${clip(clean(j.waitReason), w - 4)}`));
        for (const a of (j.activity || []).slice(live ? -2 : -1)) out.push(dim(`   ${clip(clean(a.text), w - 4)}`));
        if (!live) {
          const ev = (j.events || []).slice(-1)[0];
          if (ev) out.push(dim(`   ${clip(clean(ev.msg), w - 4)}`));
        }
      }
    }
    let usage = null;
    try {
      usage = usageLine(deps.usage?.());
    } catch {}
    while (out.length < rows - (usage ? 3 : 2)) out.push("");
    if (usage) out.push(clip(usage, w + 20));
    const foot =
      m.mode === "add"
        ? `add › ${m.input}█`
        : m.mode === "move"
          ? "move to: 1 Doing  2 Todo  3 Blocked  4 Done  (esc cancel)"
          : m.mode === "confirm"
            ? m.pending.kind === "run"
              ? `run ${m.pending.tasks.length} todo(s) with Claude (unattended, spends tokens)? y/n`
              : `stop job "${clean(m.pending.label || m.pending.id)}"? y/n`
          : m.screen === "projects"
            ? "↑↓ select · →/enter open · r jobs · R reload · q quit"
            : m.screen === "project"
              ? "a add · m move · space mark · x run · d done · r jobs · ←/b back"
              : "↑↓ select · s stop · ←/b back · q quit";
    out.push(m.msg ? dim(clip(m.msg, w)) : "");
    out.push(clip(foot, w + 20));
    return out.slice(-rows);
  }

  return { m, key, refresh, view, open };
}
