// Usage settings shared between Home's burn strip and the Usage page. Both
// read/write the same localStorage keys — Home and Usage are never mounted
// at the same time (App.jsx swaps one for the other), so a setting changed
// on one page is picked up by the other the next time it mounts.
export const UNIT_KEY = "pm.usage.unit";
export const REFRESH_KEY = "pm.usage.refreshSec";

export const REFRESH_OPTIONS = [
  { value: 0, label: "off" },
  { value: 15, label: "15s" },
  { value: 30, label: "30s" },
  { value: 60, label: "1m" },
  { value: 300, label: "5m" },
];
const DEFAULT_REFRESH_SEC = 30;

export function loadUnit() {
  return localStorage.getItem(UNIT_KEY) || "tokens";
}

export function loadRefreshSec() {
  const raw = Number(localStorage.getItem(REFRESH_KEY));
  return REFRESH_OPTIONS.some((o) => o.value === raw) ? raw : DEFAULT_REFRESH_SEC;
}

export function RefreshSelect({ value, onChange }) {
  return (
    <select
      className="usage-refresh"
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      title="auto-refresh interval"
    >
      {REFRESH_OPTIONS.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
