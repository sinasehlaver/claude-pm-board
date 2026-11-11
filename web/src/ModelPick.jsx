import { useEffect, useState } from "react";
import { get, send } from "./api";

export const MODELS = ["default", "fable", "opus", "sonnet", "haiku"];

// Colour by token price (USD per 1M tokens, input/output; mirrors PRICING in server/statusline-usage.mjs).
const TIERS = {
  default: { tier: "default", price: "", tip: "Claude Code's own default model (price depends on it)" },
  haiku: { tier: "cheap", price: "$", tip: "Cheapest: $0.50 in / $2.50 out per 1M tokens" },
  sonnet: { tier: "mid", price: "$$", tip: "Mid price: $2 in / $10 out per 1M tokens" },
  opus: { tier: "high", price: "$$$", tip: "Pricey: $4 in / $20 out per 1M tokens" },
  fable: { tier: "top", price: "$$$$", tip: "Priciest: $10 in / $50 out per 1M tokens" },
};

// Compact model selector + relay spend cap: both live in .claude/pm/prefs.json and apply to every launch.
// `full` (Setup only) adds the resolved-default line, the subagent note and the spend cap.
export default function ModelPick({ full = false }) {
  const [model, setModel] = useState("sonnet");
  const [resolved, setResolved] = useState(null);
  const [cap, setCap] = useState("");
  const apply = (d) => {
    setModel(d.prefs?.model || "sonnet");
    setCap(d.prefs?.maxBudgetUsd == null ? "" : String(d.prefs.maxBudgetUsd));
    if (d.resolvedDefault) setResolved(d.resolvedDefault);
  };
  const reload = () => get("/setup").then(apply).catch(() => {});
  useEffect(() => {
    reload();
  }, []);
  const change = async (v) => {
    const prev = model;
    setModel(v);
    try {
      apply(await send("PUT", "/setup", { model: v }));
    } catch {
      setModel(prev);
    }
  };
  const saveCap = async () => {
    const n = cap.trim() === "" ? null : Number(cap);
    if (n !== null && !(n > 0 && n <= 10000)) return reload();
    try {
      apply(await send("PUT", "/setup", { maxBudgetUsd: n }));
    } catch {
      reload();
    }
  };
  const cur = TIERS[model] || TIERS.sonnet;
  const defaultTip = resolved?.model
    ? `"default" runs ${resolved.model} (from ${resolved.from})`
    : `"default" runs your account's default model, which can be the priciest one`;
  return (
    <>
      <span className="srow model-pick">
        <span className="mp-seg" role="radiogroup" aria-label="Model for launched sessions" data-tier={cur.tier}>
          {MODELS.map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={model === m}
              className={`mp-opt mp-${TIERS[m].tier}${model === m ? " on" : ""}`}
              title={m === "default" ? defaultTip : TIERS[m].tip}
              onClick={() => change(m)}
            >
              <i className="mp-dot" />
              {m}
              {TIERS[m].price && <small>{TIERS[m].price}</small>}
            </button>
          ))}
        </span>
      </span>
      {full && model === "default" && <p className="doc-suggest muted small">{defaultTip}</p>}
      {full && <p className="doc-suggest muted small">Subagents always run on sonnet, whatever the main session uses.</p>}
      {full && <div className="fill-opts small muted">
        <label>
          unattended spend cap $
          <input
            type="number"
            min="1"
            max="10000"
            placeholder="none"
            value={cap}
            onChange={(e) => setCap(e.target.value)}
            onBlur={saveCap}
            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
          />
          per run, empty = no cap
        </label>
      </div>}
    </>
  );
}
