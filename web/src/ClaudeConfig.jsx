import { useEffect, useState } from "react";
import { get } from "./api";

// Read-only review of the Claude Code setup (hooks, permissions, plugins, MCP, skills, agents,
// instruction files). Secrets are masked server-side. Server: server/claude-config.mjs.
function Section({ title, count, children }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button className="doc-card-head cc-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className={`cc-chev${open ? " open" : ""}`} aria-hidden>▸</span>
        <span className="doc-title">{title}</span>
        <span className="doc-target">{count}</span>
      </button>
      {open && <div className="cc-body">{children}</div>}
    </div>
  );
}

function Files({ items }) {
  const [view, setView] = useState(null);
  const [err, setErr] = useState("");
  const show = async (id) => {
    if (view?.id === id) return setView(null);
    setErr("");
    try {
      setView(await get("/claude-config?id=" + encodeURIComponent(id)));
    } catch (e) {
      setErr(e.message);
    }
  };
  if (!items.length) return <p className="doc-suggest muted">None found.</p>;
  return (
    <ul className="sl-list">
      {items.map((i) => (
        <li key={i.id}>
          <button className="link" onClick={() => show(i.id)} aria-expanded={view?.id === i.id}>{i.name}</button>{" "}
          <span className="doc-target">{i.scope}</span>{" "}
          <span className="muted small">{i.description || i.heading} {i.paths && `· paths: ${i.paths}`} · {i.size} B</span>
          {view?.id === i.id && <pre className="cc-pre">{view.text}{view.truncated ? "\n… (truncated)" : ""}</pre>}
        </li>
      ))}
      {err && <li className="muted">{err}</li>}
    </ul>
  );
}

export default function ClaudeConfig() {
  const [c, setC] = useState(null);
  const [msg, setMsg] = useState("");
  useEffect(() => {
    get("/claude-config").then(setC).catch((e) => setMsg(e.message));
  }, []);
  if (!c) return <li className="doc-card"><p className="doc-suggest muted">{msg || "Loading Claude config…"}</p></li>;
  const hooks = c.settings.flatMap((s) => s.hooks.map((h) => ({ ...h, file: s.file })));
  const plugins = c.settings.flatMap((s) => s.plugins);
  const mcp = c.settings.flatMap((s) => s.mcp);
  const envNames = c.settings.flatMap((s) => s.env.map((n) => `${n} (${s.file})`));
  return (
    <li className="doc-card">
      <div className="doc-card-head" style={{ cursor: "default" }}>
        <span className="doc-title">Claude config</span>
      </div>
      <p className="doc-suggest muted">
        Read-only view of what Claude Code loads from <code>{c.dir}</code> and <code>{c.root}/.claude</code>. Secrets are masked.
      </p>
      <Section title="Hooks" count={hooks.length}>
        {hooks.length ? (
          <ul className="sl-list">
            {hooks.map((h, i) => (
              <li key={i}><b>{h.event}</b> <span className="doc-target">{h.matcher}</span> <code>{h.command}</code> <span className="muted small">{h.file}</span></li>
            ))}
          </ul>
        ) : <p className="doc-suggest muted">No hooks.</p>}
      </Section>
      <Section title="Permissions and settings" count={c.settings.length}>
        <ul className="sl-list">
          {c.settings.map((s) => (
            <li key={s.file}>
              <b>{s.file}</b>: {s.permissions.allow} allow, {s.permissions.deny} deny, {s.permissions.ask} ask
              {s.permissions.defaultMode && `, mode ${s.permissions.defaultMode}`}{s.model && `, model ${s.model}`}
            </li>
          ))}
          {envNames.length > 0 && <li>Env (values hidden): {envNames.join(", ")}</li>}
        </ul>
      </Section>
      <Section title="Plugins" count={plugins.length}>
        <ul className="sl-list">{plugins.map((p) => <li key={p.name} className={p.enabled ? "" : "muted"}>{p.name} {p.enabled ? "" : "(off)"}</li>)}</ul>
        {!plugins.length && <p className="doc-suggest muted">None enabled.</p>}
      </Section>
      <Section title="MCP servers" count={mcp.length}>
        <ul className="sl-list">
          {mcp.map((m) => <li key={m.name}><b>{m.name}</b> <span className="doc-target">{m.type}</span> <code>{m.command}</code>{m.env.length > 0 && <span className="muted small"> env: {m.env.join(", ")}</span>}</li>)}
        </ul>
        {!mcp.length && <p className="doc-suggest muted">None in settings.</p>}
      </Section>
      <Section title="Skills" count={c.skills.length}><Files items={c.skills} /></Section>
      <Section title="Agents" count={c.agents.length}><Files items={c.agents} /></Section>
      <Section title="Commands" count={c.commands.length}><Files items={c.commands} /></Section>
      <Section title="CLAUDE.md files" count={c.memory.length}><Files items={c.memory} /></Section>
      <Section title="Rules" count={c.rules.length}><Files items={c.rules} /></Section>
      {c.truncated && <p className="doc-suggest muted">List capped at 200 files.</p>}
    </li>
  );
}
