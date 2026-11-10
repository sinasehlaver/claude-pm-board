import { useEffect, useState } from "react";
import { get, send } from "./api";

export const MODELS = ["default", "opus", "sonnet", "haiku"];

// Colour by token price (USD per 1M tokens, input/output; mirrors PRICING in server/statusline-usage.mjs).
const TIERS = {
  default: { tier: "default", price: "", tip: "Claude Code's own default model (price depends on it)" },
  haiku: { tier: "cheap", price: "$", tip: "Cheapest: $0.50 in / $2.50 out per 1M tokens" },
  sonnet: { tier: "mid", price: "$$", tip: "Mid price: $2 in / $10 out per 1M tokens" },
  opus: { tier: "high", price: "$$$", tip: "Priciest here: $4 in / $20 out per 1M tokens" },
};

// Compact model selector: the pick lives in .claude/pm/prefs.json and applies to every launch.
export default function ModelPick() {
  const [model, setModel] = useState("default");
  useEffect(() => {
    get("/setup").then((d) => setModel(d.prefs?.model || "default")).catch(() => {});
  }, []);
  const change = async (e) => {
    const v = e.target.value;
    const prev = model;
    setModel(v);
    try {
      const d = await send("PUT", "/setup", { model: v });
      setModel(d.prefs?.model || "default");
    } catch {
      setModel(prev);
    }
  };
  const cur = TIERS[model];
  return (
    <span className="srow model-pick">
      <span className="mp-seg" role="radiogroup" aria-label="Model for launched sessions" data-tier={cur.tier}>
        {MODELS.map((m) => (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={model === m}
            className={`mp-opt mp-${TIERS[m].tier}${model === m ? " on" : ""}`}
            title={TIERS[m].tip}
            onClick={() => change({ target: { value: m } })}
          >
            <i className="mp-dot" />
            {m}
            {TIERS[m].price && <small>{TIERS[m].price}</small>}
          </button>
        ))}
      </span>
    </span>
  );
}
