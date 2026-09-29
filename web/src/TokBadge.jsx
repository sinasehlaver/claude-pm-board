import { useEffect, useState } from "react";
import { get } from "./api";

// slug -> title -> {tokens, sessions, split, updatedAt}; refetched when `dep` changes.
export function useTaskTokens(dep) {
  const [map, setMap] = useState({});
  useEffect(() => {
    let live = true;
    get("/tasks/tokens")
      .then((d) => live && d && typeof d === "object" && !d.error && setMap(d))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [dep]);
  return map;
}

export const fmtTok = (n) =>
  n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n);

export default function TokBadge({ rec }) {
  if (!rec?.tokens) return null;
  const n = rec.sessions.length;
  const tip = `${rec.tokens.toLocaleString()} tokens across ${n} session${n === 1 ? "" : "s"}${
    rec.split ? " (evenly split across the todos of a batch: an estimate)" : ""
  }`;
  return (
    <span className="tokbadge" title={tip}>
      {rec.split ? "~" : ""}
      {fmtTok(rec.tokens)} tok
    </span>
  );
}
