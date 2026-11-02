// Pure helpers for the command palette: fuzzy scoring + filtering (no DOM).

// Score q against text: 0 = no match. Higher is better. Words are matched independently
// (substring beats in-order subsequence; word-start and early matches score more).
export function fuzzyScore(q, text) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const t = text.toLowerCase();
  if (!words.length) return 1;
  let total = 0;
  for (const w of words) {
    const i = t.indexOf(w);
    if (i >= 0) {
      total += 100 - Math.min(i, 50) + (i === 0 || /[\s/·-]/.test(t[i - 1]) ? 30 : 0);
      continue;
    }
    let p = 0;
    let gaps = 0;
    for (const ch of w) {
      const j = t.indexOf(ch, p);
      if (j < 0) return 0;
      gaps += j - p;
      p = j + 1;
    }
    total += Math.max(1, 40 - gaps);
  }
  return total;
}

// commands: [{ id, label, keywords? }] -> best matches first; stable for ties.
export function filterCommands(commands, q) {
  if (!q.trim()) return commands;
  return commands
    .map((c, i) => ({ c, i, s: fuzzyScore(q, c.label + " " + (c.keywords || "")) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.c);
}

// True when a plain-key shortcut must be ignored (user is typing).
export function isTyping(el) {
  if (!el) return false;
  const tag = (el.tagName || "").toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || !!el.isContentEditable;
}
