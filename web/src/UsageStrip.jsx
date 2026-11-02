import { useEffect, useState } from "react";
import { get, send } from "./api";
import { alertDialog } from "./dialog.jsx";

// Home strip: the statusline builder's live segments (spend + limits), customizable here.
export default function UsageStrip() {
  const [d, setD] = useState(null);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    const load = () => get("/home-strip").then(setD).catch(() => {});
    load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, []);

  if (!d) return null;

  async function save(body) {
    try {
      setD(await send("PUT", "/home-strip", body));
    } catch (e) {
      alertDialog(`Couldn't save the usage strip: ${e.message || e}`);
    }
  }
  const cur = d.prefs.follow ? d.followed : d.prefs.segments;
  const name = (id) => d.available.find((a) => a.id === id)?.name || id;
  const toggle = (id) => save({ follow: false, segments: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] });
  const move = (i, dir) => {
    const n = [...cur];
    [n[i], n[i + dir]] = [n[i + dir], n[i]];
    save({ follow: false, segments: n });
  };
  const rest = d.available.filter((a) => !cur.includes(a.id));

  return (
    <>
      <div className="burn-strip-row">
        <div className="burn-strip" title="Claude Code usage, same segments, labels and order as your statusline (Setup → Status line). Segments with no live data here (model, folder, session…) are skipped.">
          {d.items.length === 0 && <span>🔥 No usage data</span>}
          {d.items.map((it, i) => (
            <span key={it.id}>
              {i === 0 && "🔥 "}
              {it.label ? it.label + " " : ""}
              {it.text}
              {i < d.items.length - 1 && <em className="bs-sep"> {d.sep.trim()}</em>}
            </span>
          ))}
          <button className="link bs-edit" onClick={() => setEditing((v) => !v)} title="Choose which segments this strip shows">
            {editing ? "Done" : "Edit"}
          </button>
        </div>
      </div>
      {editing && (
        <div className="burn-edit">
          <label>
            <input type="checkbox" checked={d.prefs.follow} onChange={(e) => save(e.target.checked ? { follow: true } : { follow: false, segments: cur })} />
            Follow my statusline settings
          </label>
          {!d.prefs.follow && (
            <>
              {cur.map((id, i) => (
                <div className="be-row" key={id}>
                  <span style={{ flex: 1 }}>{name(id)}</span>
                  <button className="link" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up">↑</button>
                  <button className="link" disabled={i === cur.length - 1} onClick={() => move(i, 1)} aria-label="Move down">↓</button>
                  <button className="link" onClick={() => toggle(id)}>Hide</button>
                </div>
              ))}
              {rest.map((a) => (
                <div className="be-row" key={a.id}>
                  <span style={{ flex: 1, opacity: 0.6 }}>{a.name}</span>
                  <button className="link" onClick={() => toggle(a.id)}>Show</button>
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </>
  );
}
