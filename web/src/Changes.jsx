import { useEffect, useState, useCallback } from "react";
import { get, send } from "./api";
import { confirmDialog } from "./dialog.jsx";
import { FilterSheet, HIDDEN_KEY, loadHidden } from "./Home.jsx";

const q = (o) => new URLSearchParams(o).toString();

// Pair a hunk's -/+ runs into left (old) / right (new) rows for the side-by-side view.
export function sideRows(lines) {
  const rows = [];
  let del = [];
  let add = [];
  const flush = () => {
    for (let i = 0; i < Math.max(del.length, add.length); i++) rows.push({ l: del[i] ?? null, r: add[i] ?? null });
    del = [];
    add = [];
  };
  for (const ln of lines) {
    if (ln.t === "-") del.push(ln.s);
    else if (ln.t === "+") add.push(ln.s);
    else if (ln.t === " ") (flush(), rows.push({ l: ln.s, r: ln.s, ctx: true }));
  }
  flush();
  return rows;
}

function Hunk({ h, i, side, untracked, act }) {
  const rows = sideRows(h.lines);
  return (
    <div className="chg-hunk">
      <div className="chg-hunk-head">
        <code>{h.header}</code>
        {!untracked && (
          <span className="chg-acts">
            {side === "staged" ? (
              <button className="link" onClick={() => act("unkeep", { index: i, header: h.header })}>
                Unkeep
              </button>
            ) : (
              <>
                <button className="link" onClick={() => act("keep", { index: i, header: h.header })}>
                  Keep
                </button>
                <button className="link danger" onClick={() => act("discard", { index: i, header: h.header })}>
                  Discard
                </button>
              </>
            )}
          </span>
        )}
      </div>
      <div className="chg-split">
        {rows.map((r, n) => (
          <div className="chg-row" key={n}>
            <pre className={"chg-cell" + (r.l === null ? " empty" : r.ctx ? "" : " chg-del")}>{r.l ?? ""}</pre>
            <pre className={"chg-cell" + (r.r === null ? " empty" : r.ctx ? "" : " chg-add")}>{r.r ?? ""}</pre>
          </div>
        ))}
      </div>
    </div>
  );
}

const LS = "pm.changes.";
const readLS = (k, d) => {
  try {
    return JSON.parse(localStorage.getItem(LS + k)) ?? d;
  } catch {
    return d;
  }
};
const useStored = (k, d) => {
  const [v, setV] = useState(() => readLS(k, d));
  useEffect(() => localStorage.setItem(LS + k, JSON.stringify(v)), [k, v]);
  return [v, setV];
};

function FileList({ title, files, side, sel, onSel, act }) {
  if (!files.length) return null;
  return (
    <div className="chg-group">
      <div className="chg-group-head">
        <span>
          {title} <span className="muted">{files.length}</span>
        </span>
      </div>
      {files.map((f) => (
        <div key={side + f.path} className={"chg-file" + (sel && sel.path === f.path && sel.side === side ? " on" : "")} onClick={() => onSel({ path: f.path, side })}>
          <span className={"chg-st st-" + f.status}>{f.status}</span>
          <span className="chg-path" title={f.path}>
            <bdi>{f.path}</bdi>
          </span>
          <span className="chg-acts" onClick={(e) => e.stopPropagation()}>
            {side === "staged" ? (
              <button className="link" onClick={() => act(f, side, "unkeep")}>
                Unkeep
              </button>
            ) : (
              <>
                <button className="link" onClick={() => act(f, side, "keep")}>
                  Keep
                </button>
                <button className="link danger" onClick={() => act(f, side, "discard")}>
                  Discard
                </button>
              </>
            )}
          </span>
        </div>
      ))}
    </div>
  );
}

export default function Changes({ onBack }) {
  const [repos, setRepos] = useState(null);
  const [open, setOpen] = useStored("open", []); // expanded repo sections
  const [paneOpen, setPaneOpen] = useStored("pane", true);
  const [onlyDirty, setOnlyDirty] = useStored("dirty", true);
  const [sts, setSts] = useState({}); // slug -> status
  const [msgs, setMsgs] = useState({}); // slug -> commit message draft
  const [sel, setSel] = useState(null); // {slug, path, side}
  const [diff, setDiff] = useState(null);
  const [note, setNote] = useState("");
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [hidden, setHidden] = useState(loadHidden); // same hidden list as the Home filter
  const [showFilter, setShowFilter] = useState(false);
  const [plainOpen, setPlainOpen] = useStored("plain", false);

  const loadRepos = useCallback(
    () => get("/changes").then((d) => (d.repos ? setRepos(d.repos) : setNote(d.error || "could not list repos"))).catch((e) => setNote(e.message)),
    [],
  );
  const loadRepo = useCallback(
    (s) =>
      get("/changes/" + encodeURIComponent(s))
        .then((d) => (d.error ? setNote(d.error) : setSts((m) => ({ ...m, [s]: d }))))
        .catch((e) => setNote(e.message)),
    [],
  );
  const loadDiff = useCallback(
    (f) =>
      get(`/changes/${encodeURIComponent(f.slug)}/diff?${q({ path: f.path, side: f.side })}`)
        .then((d) => (d.error ? (setNote(d.error), setDiff(null)) : setDiff(d)))
        .catch((e) => setNote(e.message)),
    [],
  );
  useEffect(() => {
    loadRepos();
  }, [loadRepos]);
  useEffect(() => {
    open.forEach((s) => !sts[s] && loadRepo(s));
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    setDiff(null);
    if (sel) loadDiff(sel);
  }, [sel, loadDiff]);

  const setHiddenSave = (fn) =>
    setHidden((prev) => {
      const next = fn(prev);
      localStorage.setItem(HIDDEN_KEY, JSON.stringify(next));
      return next;
    });
  const gitInit = async (slug) => {
    if (!(await confirmDialog({ title: "Create a git repository?", body: `Run git init in ${slug}/. This adds a .git folder and a starter .gitignore (only if none exists); nothing is committed.`, confirmLabel: "git init" }))) return;
    run(slug, () => post(slug, "init"), () => `${slug}: git repository created`);
  };
  const fetchOne = (slug) => run(slug, () => post(slug, "fetch"), (r) => `${slug}: fetched, ${r.behind ? `${r.behind} to pull` : "up to date"}`);
  const fetchAll = async () => {
    const targets = (repos || []).filter((r) => r.git !== false && !r.error);
    setBusy(true);
    setNote(`Fetching ${targets.length} repos…`);
    const res = await Promise.allSettled(targets.map((r) => post(r.slug, "fetch")));
    const failed = targets.filter((_, i) => res[i].status === "rejected").map((r) => r.slug);
    await refresh().catch(() => {});
    setNote(`Fetched ${targets.length - failed.length}/${targets.length} repos${failed.length ? `; failed (no remote or offline): ${failed.join(", ")}` : ""}`);
    setBusy(false);
  };
  const toggle = (s) => setOpen((o) => (o.includes(s) ? o.filter((x) => x !== s) : [...o, s]));
  const pick = (slug, f) => setSel({ slug, ...f });

  const refresh = async (slug) => {
    await loadRepos();
    await Promise.all(open.map(loadRepo));
    if (slug && !open.includes(slug)) await loadRepo(slug);
  };
  // after a change: reload repo list, open repos, and the open diff (dropping the selection if its change is gone)
  const run = async (slug, fn, okMsg) => {
    setBusy(true);
    setNote("");
    setErr(null);
    try {
      const r = await fn();
      setNote(okMsg ? okMsg(r) : r?.backup ? `discarded — saved as ${r.backup}` : "");
    } catch (e) {
      setErr({ slug, text: e.message });
    }
    await refresh(slug).catch(() => {});
    if (sel) {
      const st = await get("/changes/" + encodeURIComponent(sel.slug)).catch(() => null);
      const still = st && (sel.side === "staged" ? st.staged : st.changes || []).some((f) => f.path === sel.path);
      if (still) loadDiff(sel);
      else setSel(null);
    }
    setBusy(false);
  };
  const post = (slug, path, body) => send("POST", `/changes/${encodeURIComponent(slug)}/${path}`, body);
  const fileAct = (slug) => async (f, side, action) => {
    if (action === "discard" && !(await confirmDialog({ title: "Discard changes?", body: `All unkept changes in ${f.path} will be reverted.\n\nA patch backup is saved under .claude/pm/discarded/.`, confirmLabel: "Discard", danger: true }))) return;
    run(slug, () => post(slug, "apply", { path: f.path, side, action }));
  };
  const hunkAct = async (action, hunk) => {
    if (action === "discard" && !(await confirmDialog({ title: "Discard this hunk?", body: "It will be reverted in the file.\n\nA patch backup is saved under .claude/pm/discarded/.", confirmLabel: "Discard", danger: true }))) return;
    run(sel.slug, () => post(sel.slug, "apply", { path: sel.path, side: sel.side, action, hunk }));
  };
  const commit = async (slug) => {
    const message = (msgs[slug] || "").trim();
    if (!message) {
      const st = sts[slug];
      const pushed = st.upstream && !st.ahead;
      if (!(await confirmDialog({ title: "Amend the last commit?", body: `The kept files are added to the last commit of ${slug}; its message stays.${pushed ? "\n\nThat commit is already pushed: pushing again will be rejected (pm never force-pushes)." : ""}`, confirmLabel: "Amend", danger: !!pushed }))) return;
    }
    run(
      slug,
      async () => {
        const r = await post(slug, "commit", { message, amend: !message });
        setMsgs((m) => ({ ...m, [slug]: "" }));
        return r;
      },
      (r) => `${slug}: ${r.amended ? "amended" : "committed"} ${r.hash}`,
    );
  };
  const push = async (slug) => {
    const st = sts[slug];
    if (!(await confirmDialog({ title: "Push?", body: `Push ${st.branch} to ${st.upstream || "a new upstream on the only remote"}?${st.ahead ? `\n\n${st.ahead} commit(s) ahead.` : ""}`, confirmLabel: "Push" }))) return;
    run(slug, () => post(slug, "push"), () => `${slug}: pushed`);
  };

  const needle = query.trim().toLowerCase();
  const visibleRepo = (r) => !hidden.includes(r.slug) && (!needle || r.slug.toLowerCase().includes(needle));
  const shown = (repos || []).filter((r) => r.git !== false && visibleRepo(r) && (!onlyDirty || r.staged + r.changes + (r.ahead || 0) > 0 || r.error || open.includes(r.slug)));
  const plain = (repos || []).filter((r) => r.git === false && visibleRepo(r));
  const count = (r) => {
    const st = sts[r.slug];
    return st ? [st.staged.length, st.changes.length] : [r.staged, r.changes];
  };

  const repoSection = (r) => {
    const st = sts[r.slug];
    const isOpen = open.includes(r.slug);
    const [kept, changed] = count(r);
    const ahead = st ? st.ahead : r.ahead;
    return (
      <div className="chg-repo" key={r.slug}>
        <div className="chg-repo-row">
          <button className="chg-repo-head" aria-expanded={isOpen} onClick={() => toggle(r.slug)}>
            <span className={"chg-chev" + (isOpen ? " open" : "")}>›</span>
            <b className="chg-repo-name">{r.slug}</b>
          {ahead ? <span className="muted">↑{ahead}</span> : null}
          {(st ? st.behind : r.behind) ? <span className="muted">↓{st ? st.behind : r.behind}</span> : null}
          {kept ? <span className="chg-pill keep">{kept}</span> : null}
          {changed ? <span className="chg-pill">{changed}</span> : null}
          </button>
          <span className="chg-acts chg-repo-acts">
            <button className="link" disabled={busy} aria-label="Refresh" title="Refresh: re-check this repo's local changes (no network)" onClick={() => run(r.slug, async () => {}, () => `${r.slug}: refreshed`)}>
              ↻
            </button>
            <button className="link" disabled={busy} aria-label="Fetch" title="git fetch: update what pm knows about the remote (changes no files)" onClick={() => fetchOne(r.slug)}>
              F
            </button>
            <button className="link" disabled={busy || !(st ? st.upstream : r.upstream)} aria-label="Pull" title="git pull --ff-only: aborts without changes if it can't fast-forward" onClick={() => run(r.slug, () => post(r.slug, "pull"), () => `${r.slug}: pulled`)}>
              P
            </button>
          </span>
        </div>
        {isOpen && (
          <div className="chg-repo-body">
            {r.error && <p className="muted pad">{r.error}</p>}
            {!st && !r.error && <p className="muted pad">Loading…</p>}
            {st && (
              <>
                <div className="chg-meta muted">
                  {st.branch}
                  {st.upstream ? ` → ${st.upstream}` : " (no upstream)"} {st.behind ? `↓${st.behind}` : ""}
                </div>
                <div className="chg-commit">
                  <textarea className="env-input" rows={2} placeholder="Commit message" value={msgs[r.slug] || ""} onChange={(e) => setMsgs((m) => ({ ...m, [r.slug]: e.target.value }))} />
                  <div className="chg-btns">
                    <button className="link" disabled={busy || !st.staged.length} title="Empty message = amend the last commit, keeping its message" onClick={() => commit(r.slug)}>
                      {(msgs[r.slug] || "").trim() ? "Commit" : "Amend (no edit)"}{st.staged.length ? ` (${st.staged.length})` : ""}
                    </button>
                    <button className="link" disabled={busy || (st.upstream && !st.ahead)} onClick={() => push(r.slug)}>
                      Push{st.ahead ? ` ↑${st.ahead}` : ""}
                    </button>
                    <button className="link" disabled={busy || !st.changes.length} onClick={() => run(r.slug, () => post(r.slug, "stage-all", { on: true }))}>
                      Keep all
                    </button>
                    <button className="link" disabled={busy || !st.changes.some((f) => !f.untracked)} title="Keep every change except untracked (new) files" onClick={() => run(r.slug, () => post(r.slug, "stage-all", { on: true, tracked: true }))}>
                      Keep tracked
                    </button>
                    <button className="link" disabled={busy || !st.staged.length} onClick={() => run(r.slug, () => post(r.slug, "stage-all", { on: false }))}>
                      Unkeep all
                    </button>
                  </div>
                </div>
                <FileList title="Kept (staged)" files={st.staged} side="staged" sel={sel && sel.slug === r.slug ? sel : null} onSel={(f) => pick(r.slug, f)} act={fileAct(r.slug)} />
                <FileList title="Changes" files={st.changes} side="changes" sel={sel && sel.slug === r.slug ? sel : null} onSel={(f) => pick(r.slug, f)} act={fileAct(r.slug)} />
                {!st.staged.length && !st.changes.length && <p className="muted pad">Working tree clean.</p>}
                {st.truncated && <p className="muted pad">Showing the first 500 files.</p>}
              </>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="screen chg-screen">
      <header className="bar">
<h1>Changes</h1>
        <label className="muted chg-toggle">
          <input type="checkbox" checked={onlyDirty} onChange={(e) => setOnlyDirty(e.target.checked)} /> only repos with edits
        </label>
        <button className="link" disabled={busy} onClick={fetchAll} title="git fetch in every repo (changes no files)">
          Fetch all
        </button>
        <button className="link" onClick={() => refresh()}>
          Refresh
        </button>
      </header>
      {note && <p className="muted pad">{note}</p>}
      {err && (
        <div className="chg-err" role="alert">
          <div className="chg-err-head">
            <strong>{err.slug}: failed</strong>
            <button className="link" onClick={() => navigator.clipboard?.writeText(err.text).then(() => toast?.("Copied"), () => {})}>
              Copy
            </button>
            <button className="link" onClick={() => setErr(null)}>
              Dismiss
            </button>
          </div>
          <pre className="chg-err-text">{err.text}</pre>
        </div>
      )}
      <div className={"chg-layout" + (paneOpen ? "" : " collapsed")}>
        <aside className="chg-side">
          <button className="chg-rail" onClick={() => setPaneOpen(!paneOpen)} aria-expanded={paneOpen} title={paneOpen ? "Collapse panel" : "Expand panel"}>
            <span className={"chg-chev" + (paneOpen ? " open" : "")} style={{ transform: paneOpen ? "rotate(180deg)" : "none" }}>
              ›
            </span>
            {paneOpen ? <span>Repositories</span> : null}
          </button>
          <div className="chg-side-body">
            <div className="find chg-find">
              <input type="search" placeholder="Search repos…" aria-label="Search repos" value={query} onChange={(e) => setQuery(e.target.value)} />
              <button className={"link" + (hidden.length ? " active" : "")} onClick={() => setShowFilter(true)} title="Hide projects you don't want in this list (nothing is deleted)">
                Filter{hidden.length ? <span className="badge">{hidden.length}</span> : null}
              </button>
            </div>
            {!repos && !note && <p className="muted pad">Scanning repos…</p>}
            {repos && !shown.length && <p className="muted pad">No uncommitted or unpushed edits in any repo.</p>}
            {shown.map(repoSection)}
            {plain.length > 0 && (
              <div className="chg-repo">
                <button className="chg-repo-head" aria-expanded={plainOpen} onClick={() => setPlainOpen(!plainOpen)}>
                  <span className={"chg-chev" + (plainOpen ? " open" : "")}>›</span>
                  <b className="chg-repo-name">Not git repos</b>
                  <span className="muted">{plain.length}</span>
                </button>
                {plainOpen &&
                  plain.map((r) => (
                    <div className="chg-file" key={r.slug}>
                      <span className="chg-path">
                        <bdi>{r.slug}</bdi>
                      </span>
                      <button className="link" disabled={busy} onClick={() => gitInit(r.slug)}>
                        git init
                      </button>
                    </div>
                  ))}
              </div>
            )}
          </div>
        </aside>
        <main className="chg-main">
          {!sel && <p className="muted pad">Pick a file to see its diff.</p>}
          {sel && !diff && <p className="muted pad">Loading…</p>}
          {diff && (
            <>
              <div className="chg-file-head">
                <b>{sel.slug}</b> <span className="muted">/</span> <code>{diff.orig ? `${diff.orig} → ` : ""}{diff.path}</code>
                <span className="muted"> {diff.side === "staged" ? "kept" : "changes"}</span>
              </div>
              {diff.binary && <p className="muted pad">Binary file — keep or discard it whole from the list.</p>}
              {diff.note && <p className="muted pad">{diff.note}</p>}
              {!diff.binary && !diff.note && !diff.hunks.length && <p className="muted pad">No textual changes (mode or rename only).</p>}
              {diff.hunks.map((h, i) => (
                <Hunk key={h.header + i} h={h} i={i} side={diff.side} untracked={diff.untracked} act={hunkAct} />
              ))}
            </>
          )}
        </main>
      </div>
      {showFilter && (
        <FilterSheet
          projects={(repos || []).map((r) => ({ slug: r.slug, title: r.slug }))}
          hidden={hidden}
          onToggle={(s) => setHiddenSave((p) => (p.includes(s) ? p.filter((x) => x !== s) : [...p, s]))}
          onAll={(slugs, hide) => setHiddenSave((p) => (hide ? [...new Set([...p, ...slugs])] : p.filter((s) => !slugs.includes(s))))}
          onClose={() => setShowFilter(false)}
        />
      )}
    </div>
  );
}
