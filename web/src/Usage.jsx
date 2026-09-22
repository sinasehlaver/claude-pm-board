import { useEffect, useState } from "react";
import { get, send } from "./api";
import { costFor, tokensFor, DEFAULT_GRID, getPricingConfig, savePricingConfig } from "./pricing.js";
import Help from "./Help.jsx";
import { UNIT_KEY, REFRESH_KEY, loadUnit, loadRefreshSec, RefreshSelect } from "./usageSettings.jsx";

const k = (n) => (n == null ? "—" : n >= 1000 ? Math.round(n / 1000).toLocaleString() + "k" : String(Math.round(n)));
const usd = (n) => (n == null ? "—" : "$" + n.toFixed(n < 1 ? 3 : 2));

// server/usage.mjs only ever sends a resetAt when it's meaningful (a live
// cache reset, or a projected one once actually over cap) — just format it.
function resetIn(iso) {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  if (!(ms > 0)) return null;
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h < 24) return `${h}h${m ? ` ${m}m` : ""}`;
  const d = Math.floor(h / 24);
  const hh = h % 24;
  return `${d}d${hh ? ` ${hh}h` : ""}`;
}

function Head({ onBack }) {
  return (
    <header className="bar">
      <button className="back" onClick={onBack}>
        ‹
      </button>
      <h1>Usage</h1>
      <span style={{ width: 32 }} />
    </header>
  );
}

function UnitToggle({ unit, onChange }) {
  return (
    <div className="seg usage-unit-seg">
      {["tokens", "cost"].map((u) => (
        <button key={u} className={unit === u ? "on" : ""} onClick={() => onChange(u)}>
          {u === "tokens" ? "tokens" : "$"}
        </button>
      ))}
    </div>
  );
}

// A radial (donut) gauge — the arc is clamped to a full ring at 100%, but the
// printed % is the real, uncapped number (can read >100% once actually over
// a learned/placeholder cap, which is informative in itself).
function Radial({ pct: rawPct, bad, muted }) {
  const display = Math.round(rawPct ?? 0);
  const clamped = Math.max(0, Math.min(100, rawPct ?? 0));
  const r = 40;
  const c = 2 * Math.PI * r;
  const dash = (clamped / 100) * c;
  return (
    <svg viewBox="0 0 100 100" className="radial" role="img" aria-label={muted ? "no data" : `${display}%`}>
      <circle cx="50" cy="50" r={r} className="radial-track" />
      {!muted && (
        <circle
          cx="50"
          cy="50"
          r={r}
          className={"radial-fill" + (bad ? " bad" : "")}
          strokeDasharray={`${dash} ${c - dash}`}
          strokeLinecap="round"
          transform="rotate(-90 50 50)"
        />
      )}
      <text x="50" y="50" textAnchor="middle" dominantBaseline="central" className={"radial-pct" + (muted ? " muted" : "")}>
        {muted ? "—" : `${display}%`}
      </text>
    </svg>
  );
}

const MODE_LABEL = { synced: "Synced", estimated: "Estimated", manual: "Manual" };

function ModeSeg({ mode, onChange }) {
  return (
    <div className="seg limit-mode-seg">
      {["synced", "estimated", "manual"].map((m) => (
        <button key={m} className={mode === m ? "on" : ""} onClick={() => onChange(m)}>
          {MODE_LABEL[m]}
        </button>
      ))}
    </div>
  );
}

// Manual cap is stored/sent to the server as raw tokens, but the input itself
// follows the page's tokens/$ unit like everything else — typing a dollar cap
// converts to tokens via the same blended rate used everywhere else on this
// page before it's saved.
function ManualCapInput({ value, unit, blendedRate, onSave }) {
  const toDisplay = (tokens) => {
    if (tokens == null) return "";
    if (unit === "cost") return blendedRate > 0 ? (tokens * blendedRate).toFixed(2) : "";
    return String(tokens);
  };
  const [draft, setDraft] = useState(toDisplay(value));
  useEffect(() => setDraft(toDisplay(value)), [value, unit]);
  return (
    <div className="limit-manual-row">
      <div className="limit-manual-input-wrap">
        {unit === "cost" && <span className="limit-manual-prefix">$</span>}
        <input
          type="number"
          min="0"
          step={unit === "cost" ? "0.01" : "1"}
          placeholder={unit === "cost" ? "cap" : "cap in tokens"}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            const n = Number(draft);
            if (!(n > 0)) return;
            const tokens = unit === "cost" ? (blendedRate > 0 ? Math.round(n / blendedRate) : null) : Math.round(n);
            if (tokens && tokens !== value) onSave(tokens);
          }}
        />
      </div>
      <span className="limit-manual-hint">{unit === "cost" ? "dollars" : "tokens"}</span>
    </div>
  );
}

function RadialGauge({ label, windowKey, entry, resetLabel, fmtAmt, unit, blendedRate, onSaveManual }) {
  const { mode, available, utilization, usedTokens, capTokens, resetProjected, capLearned } = entry;
  const hasCap = windowKey !== "30d"; // 5h/7d have hard Anthropic caps; 30d doesn't
  return (
    <div className="radial-card">
      <Radial pct={available ? utilization : 0} bad={available && (utilization ?? 0) >= 85} muted={!available} />
      <div className="radial-label">{label}</div>
      <div className="radial-nums">
        {available ? (
          hasCap ? `${fmtAmt(usedTokens)} of ${fmtAmt(capTokens)}` : fmtAmt(usedTokens)
        ) : mode === "manual" ? (
          "set a cap below"
        ) : (
          "no live data"
        )}
      </div>
      {resetLabel && (
        <div className="radial-reset">
          {resetProjected ? "~resets in " : "resets in "}
          {resetLabel}
        </div>
      )}
      {hasCap && mode === "estimated" && available && (
        <div className="radial-cap-note">{capLearned ? "learned cap" : "placeholder cap"}</div>
      )}
      {mode === "manual" && (
        <ManualCapInput
          value={capTokens}
          unit={unit}
          blendedRate={blendedRate}
          onSave={(tokens) => onSaveManual(windowKey, tokens)}
        />
      )}
    </div>
  );
}

// sum a set of per-model token rows into { tokens, cost }
function sumRows(rows) {
  return (rows || []).reduce(
    (acc, r) => ({ tokens: acc.tokens + tokensFor(r), cost: acc.cost + costFor(r) }),
    { tokens: 0, cost: 0 },
  );
}

// group per-day-per-model summary rows into one row per day (totals across models)
function byDay(rows) {
  const days = new Map();
  for (const r of rows) {
    if (!days.has(r.bucket)) days.set(r.bucket, { day: r.bucket, tokens: 0, cost: 0 });
    const d = days.get(r.bucket);
    d.tokens += tokensFor(r);
    d.cost += costFor(r);
  }
  return Array.from(days.values()).sort((a, b) => a.day.localeCompare(b.day));
}

function byModel(rows) {
  const models = new Map();
  for (const r of rows) {
    if (!models.has(r.model)) models.set(r.model, { model: r.model, tokens: 0, cost: 0 });
    const m = models.get(r.model);
    m.tokens += tokensFor(r);
    m.cost += costFor(r);
  }
  return Array.from(models.values()).sort((a, b) => b.tokens - a.tokens);
}

export default function Usage({ onBack }) {
  const [burn, setBurn] = useState(null);
  const [rows, setRows] = useState(null);
  const [unit, setUnit] = useState(loadUnit);
  const [refreshSec, setRefreshSec] = useState(loadRefreshSec);

  useEffect(() => {
    function load() {
      get("/usage/burn").then(setBurn);
      get("/usage/summary?bucket=day&days=14").then(setRows);
    }
    load();
    if (!refreshSec) return;
    const id = setInterval(load, refreshSec * 1000);
    return () => clearInterval(id);
  }, [refreshSec]);

  function changeUnit(u) {
    localStorage.setItem(UNIT_KEY, u);
    setUnit(u);
  }

  function changeRefresh(sec) {
    localStorage.setItem(REFRESH_KEY, String(sec));
    setRefreshSec(sec);
  }

  function reload() {
    get("/usage/burn").then(setBurn);
  }

  // One shared mode drives all three windows — Synced/Estimated/Manual isn't
  // a per-window choice in the UI, so flipping it writes all three at once.
  // (Each window still keeps its own manual cap value server-side.)
  function changeLimitMode(mode) {
    Promise.all(["5h", "7d", "30d"].map((key) => send("PUT", `/usage/limits/${key}`, { mode }))).then(reload);
  }

  function saveManualCap(windowKey, manualCapTokens) {
    send("PUT", `/usage/limits/${windowKey}`, { mode: "manual", manualCapTokens }).then(reload);
  }

  const days = rows ? byDay(rows) : [];
  const models = rows ? byModel(rows) : [];
  const fmt = (tokens, cost) => (unit === "cost" ? usd(cost) : k(tokens));
  const dayValue = (d) => (unit === "cost" ? d.cost : d.tokens);
  const maxDayValue = Math.max(1, ...days.map(dayValue));
  const totalCost14d = days.reduce((s, d) => s + d.cost, 0);
  const totalTokens14d = days.reduce((s, d) => s + d.tokens, 0);
  const blendedRate = totalTokens14d > 0 ? totalCost14d / totalTokens14d : 0;
  // limit/used are raw token counts (usage.mjs never does $ math itself) — convert
  // the same way everything else on this page does, via the 14-day blended rate.
  const fmtAmt = (tokens) => (tokens == null ? "—" : unit === "cost" ? usd(tokens * blendedRate) : k(tokens));

  const limits = burn?.limits;
  const win1h = sumRows(burn?.breakdown?.win1h);
  const win5h = sumRows(burn?.breakdown?.win5h);
  const win7d = sumRows(burn?.breakdown?.win7d);

  // Fast-responding companion to the win1h/win5h/win7d rolling sums — those
  // stay "stuck" for up to an hour after a burst ends; this is what actually
  // drops toward 0 once you go idle.
  const paceSum = sumRows(burn?.breakdown?.pace);
  const paceScale = 3600_000 / (burn?.paceWindowMs || 5 * 60_000);
  const paceTokensPerHour = paceSum.tokens * paceScale;
  const paceCostPerHour = paceSum.cost * paceScale;

  return (
    <div className="screen">
      <Head onBack={onBack} />

      <section className="block">
        <div className="block-head">
          <span className="block-head-title">
            <h2>Burn rate</h2>
            <Help text="Rolling token totals across every Claude Code session on this machine (main + subagents), the same windows the 'Run @seq' orchestrator paces against. Pure throughput — no rate-limit info here, see the Rate-limit ceiling section below for that." />
          </span>
          <span className="block-head-controls">
            <RefreshSelect value={refreshSec} onChange={changeRefresh} />
            <UnitToggle unit={unit} onChange={changeUnit} />
          </span>
        </div>
        {!burn ? (
          <p className="muted">Loading…</p>
        ) : (
          <div className="meta usage-stats">
            <span className="usage-pace">
              <b>{fmt(paceTokensPerHour, paceCostPerHour)}</b> /hr now
              <Help
                text={`Extrapolated from the last ${Math.round((burn.paceWindowMs || 300000) / 60000)} minutes of activity — drops toward 0 as soon as you go idle, unlike the sums to the right.`}
                side="left"
              />
            </span>
            <span>
              <b>{fmt(win1h.tokens, win1h.cost)}</b> / 1h
            </span>
            <span>
              <b>{fmt(win5h.tokens, win5h.cost)}</b> / 5h
            </span>
            <span>
              <b>{fmt(win7d.tokens, win7d.cost)}</b> / 7d
            </span>
          </div>
        )}
      </section>

      <section className="block">
        <div className="block-head">
          <span className="block-head-title">
            <h2>Rate-limit ceiling</h2>
            <Help text="Your account's % of Anthropic's rate limit for the 5h/7d/30d windows, with limit/used tokens and a reset time — the same shape claude.ai's own Usage page shows. Each window has its own mode: Synced reads the VS Code extension's own cache file (real numbers, but only live while a Claude Code GUI/statusline surface is active — the CLI itself never writes that file, so terminal-only sessions including pm's launch buttons leave it stale, and 30d has no synced source at all). Estimated computes from local token burn against a cap learned from your last real throttle (or a rough placeholder if you've never hit one). Manual uses a cap you type in yourself and never changes on its own — set once, it stays exactly as set until you edit it again." />
          </span>
        </div>
        {!burn ? (
          <p className="muted">Loading…</p>
        ) : !limits ? (
          <p className="muted">Loading…</p>
        ) : (
          <>
            <ModeSeg mode={limits.windows["5h"].mode} onChange={changeLimitMode} />
            <div className="radial-row">
              {["5h", "7d", "30d"].map((key) => (
                <RadialGauge
                  key={key}
                  label={key}
                  windowKey={key}
                  entry={limits.windows[key]}
                  resetLabel={resetIn(limits.windows[key].resetAt)}
                  fmtAmt={fmtAmt}
                  unit={unit}
                  blendedRate={blendedRate}
                  onSaveManual={saveManualCap}
                />
              ))}
            </div>
          </>
        )}
      </section>

      <section className="block">
        <div className="block-head">
          <span className="block-head-title">
            <h2>Last 14 days</h2>
            <Help text="Estimated cost from token counts using Anthropic's published per-model rates (see web/src/pricing.js) — an estimate, not a billing statement." />
          </span>
          <span className="pill">{usd(totalCost14d)} est.</span>
        </div>
        {!rows ? (
          <p className="muted">Loading…</p>
        ) : !days.length ? (
          <p className="muted">No usage in this window.</p>
        ) : (
          <div className="usage-cols">
            {days.map((d) => (
              <div key={d.day} className="usage-col">
                <span className="usage-col-v">{fmt(d.tokens, d.cost)}</span>
                <span className="usage-col-track">
                  <span className="usage-col-fill" style={{ height: (dayValue(d) / maxDayValue) * 100 + "%" }} />
                </span>
                <span className="usage-col-label">{d.day.slice(5)}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="block">
        <div className="block-head">
          <h2>By model (14d)</h2>
        </div>
        {!rows ? (
          <p className="muted">Loading…</p>
        ) : !models.length ? (
          <p className="muted">No usage in this window.</p>
        ) : (
          <table className="ctable">
            <tbody>
              {models.map((m) => (
                <tr key={m.model}>
                  <td className="clip">{m.model}</td>
                  <td className="num">{k(m.tokens)} tok</td>
                  <td className="num">{usd(m.cost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <PricingSection />
    </div>
  );
}

function PricingSection() {
  const [pricingConfig, setPricingConfig] = useState(getPricingConfig());
  const [showReset, setShowReset] = useState(false);

  const handlePriceChange = (model, field, value) => {
    const numValue = parseFloat(value);
    if (isNaN(numValue) || numValue < 0) return;
    const updated = { ...pricingConfig };
    if (!updated[model]) updated[model] = { ...DEFAULT_GRID[model] };
    else updated[model] = { ...updated[model] };
    updated[model][field] = numValue;
    setPricingConfig(updated);
    savePricingConfig(updated);
  };

  const resetToDefaults = () => {
    setPricingConfig({});
    savePricingConfig({});
    setShowReset(false);
  };

  const isCustomized = Object.keys(pricingConfig).length > 0;

  return (
    <section className="block">
      <div className="block-head">
        <span className="block-head-title">
          <h2>Pricing config</h2>
          <Help text="Edit per-model rates ($/M tokens). Changes apply immediately to all cost calculations and persist locally. Reset clears all customizations." />
        </span>
        {isCustomized && (
          <button
            className="pill"
            onClick={() => setShowReset(!showReset)}
            style={{ background: showReset ? "#f44336" : "#666" }}
          >
            {showReset ? "Cancel" : "Reset to defaults"}
          </button>
        )}
      </div>
      {showReset ? (
        <div style={{ padding: "1rem", textAlign: "center" }}>
          <p>Clear all price customizations?</p>
          <button onClick={resetToDefaults} style={{ marginRight: "0.5rem" }}>
            Yes, reset
          </button>
          <button onClick={() => setShowReset(false)}>Cancel</button>
        </div>
      ) : (
        <table className="ctable" style={{ fontSize: "0.9em" }}>
          <thead>
            <tr>
              <th style={{ textAlign: "left" }}>Model</th>
              <th style={{ textAlign: "right" }}>Input</th>
              <th style={{ textAlign: "right" }}>Output</th>
              <th style={{ textAlign: "right" }}>Cache 5m</th>
              <th style={{ textAlign: "right" }}>Cache 1h</th>
              <th style={{ textAlign: "right" }}>Cache read</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(DEFAULT_GRID).map(([model, defaults]) => {
              const current = pricingConfig[model] || defaults;
              return (
                <tr key={model}>
                  <td className="clip">{model}</td>
                  {["input", "output", "cache_write_5m", "cache_write_1h", "cache_read"].map((field) => (
                    <td key={field} style={{ textAlign: "right" }}>
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        value={current[field]}
                        onChange={(e) => handlePriceChange(model, field, e.target.value)}
                        style={{
                          width: "70px",
                          padding: "0.25rem",
                          textAlign: "right",
                          background:
                            pricingConfig[model]?.[field] !== undefined &&
                            pricingConfig[model][field] !== defaults[field]
                              ? "#fff3cd"
                              : "transparent",
                        }}
                      />
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
