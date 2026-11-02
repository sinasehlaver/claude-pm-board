// Merge old Done items into fewer, shorter ones (the compact-done skill drives this via
// backlog-cli). Pure: returns a new backlog; the caller writes it through writeBacklog,
// which archives every dropped original — nothing is lost.
export const KEEP_DAYS = 7;
const MAX_TITLE = 120;
const MAX_NOTE = 200;

const daysAgo = (today, n) => {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};
// Undated Done items predate the date suffix, so they count as old.
const isOld = (t, cutoff) => t.state === "Done" && (!t.done || t.done < cutoff);
const clean = (s) => String(s ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();

export function candidates(b, { today = new Date().toISOString().slice(0, 10), keepDays = KEEP_DAYS } = {}) {
  const cutoff = daysAgo(today, keepDays);
  return b.tasks.filter((t) => isOld(t, cutoff)).map((t) => ({ title: t.title, done: t.done, note: t.note }));
}

export function compactDone(b, groups, { today = new Date().toISOString().slice(0, 10), keepDays = KEEP_DAYS } = {}) {
  if (!Array.isArray(groups) || !groups.length) throw new Error("plan must be a non-empty array of groups");
  const cutoff = daysAgo(today, keepDays);
  const old = new Map(b.tasks.filter((t) => isOld(t, cutoff)).map((t) => [t.title, t]));
  const used = new Set();
  const merged = groups.map((g, i) => {
    if (!g || typeof g !== "object") throw new Error(`group ${i}: not an object`);
    if (/[\r\n]/.test(g.title ?? "") || /[\r\n]/.test(g.note ?? "")) throw new Error(`group ${i}: title and note must be single lines`);
    const title = clean(g.title);
    const note = clean(g.note) || null;
    if (!title || title.length > MAX_TITLE) throw new Error(`group ${i}: title must be 1-${MAX_TITLE} chars`);
    if (note && note.length > MAX_NOTE) throw new Error(`group ${i}: note must be <= ${MAX_NOTE} chars`);
    if (!Array.isArray(g.from) || !g.from.length) throw new Error(`group ${i}: "from" must list exact Done titles`);
    const src = g.from.map((f) => {
      if (used.has(f)) throw new Error(`"${f}" is used twice`);
      const t = old.get(f);
      if (!t) throw new Error(`"${f}" is not a Done item older than ${keepDays} days`);
      used.add(f);
      return t;
    });
    if (src.length === 1 && title.length >= src[0].title.length && (note?.length ?? 0) >= (src[0].note?.length ?? 0))
      throw new Error(`group ${i}: a single-item group must get shorter`);
    const dates = src.map((t) => t.done).filter(Boolean).sort();
    return { title, note, src, done: dates.at(-1) || null };
  });
  const remaining = new Set(b.tasks.filter((t) => !used.has(t.title) || t.state !== "Done").map((t) => t.title));
  const seen = new Set();
  for (const m of merged) {
    if (remaining.has(m.title) || seen.has(m.title)) throw new Error(`title "${m.title}" collides with another task`);
    seen.add(m.title);
  }
  // Each merged item takes the slot of its first source in file order; other tasks keep theirs.
  const pos = (t) => b.tasks.indexOf(t);
  const slot = new Map(merged.map((m) => [m.src.reduce((a, t) => (pos(t) < pos(a) ? t : a)), m]));
  const tasks = [];
  for (const t of b.tasks) {
    const m = slot.get(t);
    if (m) tasks.push({ state: "Done", title: m.title, note: m.note, priority: null, done: m.done, seq: false });
    else if (!(t.state === "Done" && used.has(t.title))) tasks.push(t);
  }
  return { ...b, tasks: tasks.map((t, id) => ({ ...t, id })) };
}
