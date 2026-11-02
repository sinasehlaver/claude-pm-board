const base = "/api";

// A request that never answers used to hang the UI forever; fail loudly instead.
const TIMEOUT_MS = 20_000;

async function req(p, init) {
  try {
    return await fetch(base + p, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    if (e.name === "TimeoutError") throw new Error(`pm server didn't answer in ${TIMEOUT_MS / 1000}s (${p})`);
    throw new Error(`can't reach the pm server (${e.message})`);
  }
}

export const get = (p) => req(p).then((r) => r.json());

export async function send(method, p, body) {
  const r = await req(p, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}

// One EventSource for ALL open pm tabs. Browsers allow 6 HTTP/1.1 connections per
// origin and an SSE stream holds one open for good, so a stream per component per tab
// starved every other request (adds hung, reload said "Failed to fetch"). A Web Lock
// elects one leader tab that holds the stream and relays pings over a BroadcastChannel.
const subs = new Set();
let started = false;
const fire = (ev) => subs.forEach((cb) => cb(ev));

function startStream() {
  started = true;
  const open = () => {
    const es = new EventSource(base + "/stream");
    es.onmessage = (ev) => {
      fire(ev);
      chan?.postMessage(ev.data);
    };
    return es;
  };
  const chan = typeof BroadcastChannel === "function" ? new BroadcastChannel("pm-stream") : null;
  if (!chan || !navigator.locks) return void open();
  chan.onmessage = (m) => fire({ data: m.data });
  // never resolves while the tab lives, so the lock passes on only when the leader closes
  navigator.locks.request("pm-stream-leader", () => new Promise(() => open()));
}

export function onStream(cb) {
  subs.add(cb);
  if (!started) startStream();
  return () => subs.delete(cb);
}

export function ago(iso) {
  if (!iso) return "—";
  const d = (Date.now() - Date.parse(iso)) / 1000;
  if (d < 90) return "just now";
  if (d < 5400) return Math.round(d / 60) + "m ago";
  if (d < 129600) return Math.round(d / 3600) + "h ago";
  return Math.round(d / 86400) + "d ago";
}
