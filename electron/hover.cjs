// Pure helpers for the desktop shell's hover mode (no Electron imports, unit-tested).
const HOVER_SIZE = { width: 420, height: 640 };
const HOVER_MIN = { width: 320, height: 360 };

function sanitizePrefs(raw) {
  const p = raw && typeof raw === "object" ? raw : {};
  const num = (v) => Number.isFinite(v) && Math.abs(v) < 100000;
  const b = p.hoverBounds;
  const hoverBounds =
    b && typeof b === "object" && num(b.x) && num(b.y) && num(b.width) && num(b.height) && b.width >= HOVER_MIN.width && b.height >= HOVER_MIN.height
      ? { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) }
      : null;
  return { hover: p.hover === true, hoverBounds };
}

// Default hover spot: top-right of the work area; a saved spot wins if it is still on a display.
function hoverBounds(saved, workAreas) {
  const areas = workAreas && workAreas.length ? workAreas : [{ x: 0, y: 0, width: 1440, height: 900 }];
  if (saved) {
    const onScreen = areas.some(
      (a) => saved.x + saved.width > a.x + 40 && saved.x < a.x + a.width - 40 && saved.y >= a.y - 10 && saved.y < a.y + a.height - 40,
    );
    if (onScreen) return saved;
  }
  const a = areas[0];
  return { x: a.x + a.width - HOVER_SIZE.width - 16, y: a.y + 16, ...HOVER_SIZE };
}

module.exports = { HOVER_SIZE, HOVER_MIN, sanitizePrefs, hoverBounds };
