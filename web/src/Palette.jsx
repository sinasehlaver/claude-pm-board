import { useEffect, useMemo, useRef, useState } from "react";
import { filterCommands } from "./palette-core.mjs";

// ⌘K command palette. commands: [{ id, label, keys?, keywords?, run }].
export default function Palette({ open, onClose, commands }) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const input = useRef(null);
  const listRef = useRef(null);
  useEffect(() => {
    if (open) {
      setQ("");
      setSel(0);
      setTimeout(() => input.current?.focus(), 0);
    }
  }, [open]);
  const list = useMemo(() => filterCommands(commands, q), [commands, q]);
  useEffect(() => {
    listRef.current?.querySelector(".pal-row.on")?.scrollIntoView({ block: "nearest" });
  }, [sel, list]);
  if (!open) return null;
  const run = (c) => {
    onClose();
    c.run();
  };
  return (
    <div className="sheet-backdrop pal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet pal" role="dialog" aria-modal="true" aria-label="Command palette">
        <input
          ref={input}
          className="env-input pal-input"
          placeholder="Type a command…"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setSel(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
            else if (e.key === "ArrowDown") {
              e.preventDefault();
              setSel((s) => Math.min(s + 1, list.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setSel((s) => Math.max(s - 1, 0));
            } else if (e.key === "Enter" && list[sel]) run(list[sel]);
          }}
        />
        <ul className="pal-list" role="listbox" ref={listRef}>
          {list.map((c, i) => (
            <li
              key={c.id}
              role="option"
              aria-selected={i === sel}
              className={"pal-row" + (i === sel ? " on" : "")}
              onMouseMove={() => setSel(i)}
              onClick={() => run(c)}
            >
              <span className="pal-label">{c.label}</span>
              {c.keys && <kbd className="pal-kbd">{c.keys}</kbd>}
            </li>
          ))}
          {!list.length && <li className="pal-empty muted">No matching command</li>}
        </ul>
      </div>
    </div>
  );
}
