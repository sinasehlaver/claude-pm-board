const base = "/api";

export const get = (p) => fetch(base + p).then((r) => r.json());

export async function send(method, p, body) {
  const r = await fetch(base + p, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}

export function onStream(cb) {
  const es = new EventSource(base + "/stream");
  es.onmessage = cb;
  return () => es.close();
}

export function ago(iso) {
  if (!iso) return "—";
  const d = (Date.now() - Date.parse(iso)) / 1000;
  if (d < 90) return "just now";
  if (d < 5400) return Math.round(d / 60) + "m ago";
  if (d < 129600) return Math.round(d / 3600) + "h ago";
  return Math.round(d / 86400) + "d ago";
}
