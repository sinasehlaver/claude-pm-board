import { useEffect, useState } from "react";
import { get, send } from "./api";

export const MODELS = ["default", "opus", "sonnet", "haiku"];

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
  return (
    <span className="srow model-pick">
      <select value={model} onChange={change} title="model for launched sessions" aria-label="Model">
        {MODELS.map((m) => (
          <option key={m} value={m}>
            {m === "default" ? "Model: default" : `Model: ${m}`}
          </option>
        ))}
      </select>
    </span>
  );
}
