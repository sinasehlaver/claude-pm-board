// Which interface the API binds to. Default is loopback; anything else needs
// PM_TOKEN, except a Tailscale address (100.64.0.0/10) where the tailnet's WireGuard
// identity is the authentication. Never silently falls back to 0.0.0.0.
import { timingSafeEqual } from "node:crypto";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

export function isTailscaleIp(host) {
  const m = /^100\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host || "");
  return Boolean(m) && Number(m[1]) >= 64 && Number(m[1]) <= 127;
}

export function resolveHost(env = process.env) {
  const host = (env.PM_HOST || "127.0.0.1").trim();
  if (LOOPBACK_HOSTS.has(host) || isTailscaleIp(host)) return host;
  if (!env.PM_TOKEN)
    throw new Error(
      `PM_HOST=${host} exposes pm beyond this machine; set PM_TOKEN, or bind loopback / a Tailscale 100.x address`,
    );
  return host;
}

export function tokenMatches(given, expected) {
  if (!expected || typeof given !== "string") return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
