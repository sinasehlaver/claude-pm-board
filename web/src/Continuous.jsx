import { useState } from "react";
import { send } from "./api";

const k = (n) => (n == null ? "—" : Math.round(n / 1000).toLocaleString() + "k");
const pct = (u, c) => (c > 0 ? Math.min(100, Math.round((u / c) * 100)) : 0);

export default function Continuous({ status, log, onBack, reload }) {
  if (!status) {
    return (
      <div className="screen">
        <Head onBack={onBack} />
        <p className="muted pad">Loading…</p>
      </div>
    );
  }
  const { runner, state = {}, config, decision, usage, caps } = status;

  const call = async (method, path, body) => {
    try {
      await send(method, path, body);
      reload();
    } catch (e) {
      alert(e.message);
    }
  };

  if (!config) {
    return (
      <div className="screen">
        <Head onBack={onBack} />
        <p className="muted pad">
          No <code>continuous/config.json</code>. Copy <code>config.example.json</code> to{" "}
          <code>config.json</code> in the continuous/ project first.
        </p>
      </div>
    );
  }

  return (
    <div className="screen">
      <Head onBack={onBack} />

      <section className="block">
        <div className="block-head">
          <h2>Runner</h2>
          <span className={"pill" + (runner.alive ? " on" : "")}>
            {runner.alive ? `running · pid ${runner.pid}` : "stopped"}
          </span>
        </div>
        {decision?.error ? (
          <p className="muted">decision error: {decision.error}</p>
        ) : decision ? (
          <p className="cdecide">
            <b>{decision.do === "run" ? "▶ would run" : "⏸ sleeping"}</b> — {decision.reason}
          </p>
        ) : null}
        <div className="seg">
          <button onClick={() => call("POST", "/continuous/runner", { action: "tick" })}>
            Tick now
          </button>
          <button onClick={() => call("POST", "/continuous/runner", { action: "start" })}>
            Start loop
          </button>
          <button onClick={() => call("POST", "/continuous/runner", { action: "stop" })}>
            Stop
          </button>
        </div>
        {state.last_failure && (
          <p className="cfail">
            last failure: {state.last_failure.slug} / {state.last_failure.action}
            {state.last_failure.timedOut ? " (timeout)" : ""}{" "}
            <button
              className="link"
              onClick={() => call("POST", "/continuous/clear-failure")}
            >
              clear
            </button>
          </p>
        )}
      </section>

      <section className="block">
        <div className="block-head">
          <h2>Budget</h2>
          {decision && (
            <span className={"pill" + (decision.ratio > 1 ? " bad" : "")}>
              rate {decision.ratio}× pace
            </span>
          )}
        </div>
        <Meter label="5h" used={usage?.used_5h} cap={caps?.cap_5h} />
        <Meter label="7d" used={usage?.used_7d} cap={caps?.cap_7d} />
        <div className="meta">
          <span>pace {k(decision?.pace)}/h</span>
          <span>1h {k(usage?.spent_1h)}</span>
          {caps?.learned?.cap_5h && <span>learned 5h cap {k(caps.learned.cap_5h)}</span>}
        </div>
      </section>

      <section className="block">
        <div className="block-head">
          <h2>Now</h2>
        </div>
        {state.cur ? (
          <p>
            {state.cur.slug} · action #{state.cur.actionIdx} · calib{" "}
            {Math.round(state.calib_fixed || 0) / 1000}k + {(state.calib_mult || 1).toFixed(2)}×est
          </p>
        ) : (
          <p className="muted">idle</p>
        )}
      </section>

      <section className="block">
        <div className="block-head">
          <h2>Activity</h2>
        </div>
        {!log?.length && <p className="muted">no actions logged yet</p>}
        {log?.length > 0 && (
          <table className="ctable">
            <tbody>
              {log.map((r, i) => (
                <tr key={i} className={r.err ? "bad" : ""}>
                  <td>{String(r.ts).slice(5, 16).replace("T", " ")}</td>
                  <td>{r.slug}</td>
                  <td className="clip">{r.action}</td>
                  <td>{r.gear?.split("/")[0].replace("claude-", "")}</td>
                  <td className="num">{k(r.actual)}</td>
                  <td className="num">{r.over}×</td>
                  <td className="num">{r.cost != null ? "$" + r.cost.toFixed(2) : ""}</td>
                  <td>{r.err ? "✗" : "✓"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="block">
        <div className="block-head">
          <h2>Config</h2>
        </div>
        <ConfigForm config={config} caps={caps} onSave={(p) => call("PUT", "/continuous/config", p)} />
      </section>
    </div>
  );
}

function Head({ onBack }) {
  return (
    <header className="bar">
      <button className="back" onClick={onBack}>
        ‹
      </button>
      <h1>Continuous</h1>
      <span style={{ width: 32 }} />
    </header>
  );
}

function Meter({ label, used, cap }) {
  const p = pct(used, cap);
  return (
    <div className="cmeter">
      <span className="cmeter-l">{label}</span>
      <span className="cmeter-track">
        <span className={"cmeter-fill" + (p >= 85 ? " bad" : "")} style={{ width: p + "%" }} />
      </span>
      <span className="cmeter-v">
        {k(used)}/{k(cap)} · {p}%
      </span>
    </div>
  );
}

function ConfigForm({ config, caps, onSave }) {
  const [f, setF] = useState({
    cap_5h: config.cap_5h,
    cap_7d: config.cap_7d,
    safety: config.safety,
    active_hours_per_day: config.active_hours_per_day,
    min_action_tokens: config.min_action_tokens,
  });
  const [pool, setPool] = useState(JSON.stringify(config.pool ?? [], null, 1));
  const num = (key) => (e) => setF({ ...f, [key]: Number(e.target.value) });
  const learned5h = caps?.learned?.cap_5h;
  const warn = learned5h && f.cap_5h < learned5h;

  return (
    <div className="form">
      <label>
        human_at_keyboard
        <div className="seg">
          {[false, true].map((v) => (
            <button
              key={String(v)}
              className={config.human_at_keyboard === v ? "on" : ""}
              onClick={() => onSave({ human_at_keyboard: v })}
            >
              {v ? "on — any task + notify" : "off — @auto only"}
            </button>
          ))}
        </div>
      </label>
      {["cap_5h", "cap_7d", "safety", "active_hours_per_day", "min_action_tokens"].map((key) => (
        <label key={key}>
          {key}
          {key === "cap_5h" && learned5h ? ` (learned ${k(learned5h)})` : ""}
          <input type="number" step="any" value={f[key]} onChange={num(key)} />
        </label>
      ))}
      {warn && <p className="cfail">cap_5h below the learned ceiling — runner will over-throttle.</p>}
      <label>
        pool (JSON)
        <textarea rows={6} value={pool} onChange={(e) => setPool(e.target.value)} />
      </label>
      <button
        className="save"
        onClick={() => {
          let p;
          try {
            p = JSON.parse(pool);
          } catch {
            return alert("pool is not valid JSON");
          }
          onSave({ ...f, pool: p });
        }}
      >
        Save
      </button>
    </div>
  );
}
