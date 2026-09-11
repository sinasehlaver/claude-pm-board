import { useId, useState } from "react";

// Small "?" icon button that shows a short tooltip on hover or keyboard focus.
// Plain React + CSS, no dependency — keyboard users get the same info as mouse
// users (focus/blur mirror hover/leave), and Escape dismisses it.
export default function Help({ text, side = "bottom" }) {
  const [open, setOpen] = useState(false);
  const id = useId();

  return (
    <span className="help">
      <button
        type="button"
        className="help-btn"
        aria-describedby={open ? id : undefined}
        aria-label="Help"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (e.key === "Escape") setOpen(false);
        }}
        onClick={(e) => {
          // tap-to-toggle for touch devices, which have no hover/focus-in
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        ?
      </button>
      {open && (
        <span role="tooltip" id={id} className={`help-tip help-tip-${side}`}>
          {text}
        </span>
      )}
    </span>
  );
}
