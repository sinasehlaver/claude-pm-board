import { useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

// Small "?" icon button that shows a short tooltip on hover or keyboard focus.
// The tip is portaled to <body> with fixed positioning, so no panel, stacking
// context or overflow:hidden ancestor can clip or cover it; it flips to the
// side with room and is clamped inside the viewport.
const GAP = 8;
const MARGIN = 8;

export default function Help({ text, side = "bottom" }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const id = useId();
  const btn = useRef(null);
  const tip = useRef(null);

  useLayoutEffect(() => {
    if (!open) { setPos(null); return; }
    const place = () => {
      if (!btn.current || !tip.current) return;
      const b = btn.current.getBoundingClientRect();
      const t = tip.current.getBoundingClientRect();
      const vw = window.innerWidth, vh = window.innerHeight;
      let s = side;
      const fits = {
        bottom: b.bottom + GAP + t.height <= vh - MARGIN,
        top: b.top - GAP - t.height >= MARGIN,
        right: b.right + GAP + t.width <= vw - MARGIN,
        left: b.left - GAP - t.width >= MARGIN,
      };
      if (!fits[s]) s = { bottom: "top", top: "bottom", left: "right", right: "left" }[s];
      if (!fits[s]) s = ["bottom", "top", "right", "left"].find((k) => fits[k]) || "bottom";
      let left, top;
      if (s === "bottom" || s === "top") {
        left = b.left + b.width / 2 - t.width / 2;
        top = s === "bottom" ? b.bottom + GAP : b.top - GAP - t.height;
      } else {
        top = b.top + b.height / 2 - t.height / 2;
        left = s === "right" ? b.right + GAP : b.left - GAP - t.width;
      }
      left = Math.max(MARGIN, Math.min(left, vw - MARGIN - t.width));
      top = Math.max(MARGIN, Math.min(top, vh - MARGIN - t.height));
      setPos({ left, top });
    };
    place();
    const close = () => setOpen(false);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open, side, text]);

  return (
    <span className="help">
      <button
        ref={btn}
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
      {open &&
        createPortal(
          <span
            ref={tip}
            role="tooltip"
            id={id}
            className="help-tip"
            style={pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0, visibility: "hidden" }}
          >
            {text}
          </span>,
          document.body,
        )}
    </span>
  );
}
