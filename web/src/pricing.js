// Cost math ported from claude_usage_dashboard/web/src/pricing.js — pm reuses
// the calculation, not the app (that app doesn't need to be installed/running).
// Anthropic cache writes bill at a multiplier over the base input rate:
// 1.25x for the 5-minute default cache, 2x for the 1-hour extended cache.
export const DEFAULT_GRID = {
  "claude-fable-5": { input: 10.0, output: 50.0, cache_write_5m: 12.5, cache_write_1h: 20.0, cache_read: 1.0 },
  "claude-opus-5": { input: 5.0, output: 25.0, cache_write_5m: 6.25, cache_write_1h: 10.0, cache_read: 0.5 },
  "claude-opus-4-8": { input: 5.0, output: 25.0, cache_write_5m: 6.25, cache_write_1h: 10.0, cache_read: 0.5 },
  // Sonnet 5 intro rate (through 2026-08-31); reverts to $3/$15 after.
  "claude-sonnet-5": { input: 2.0, output: 10.0, cache_write_5m: 2.5, cache_write_1h: 4.0, cache_read: 0.2 },
  "claude-sonnet-4-6": { input: 3.0, output: 15.0, cache_write_5m: 3.75, cache_write_1h: 6.0, cache_read: 0.3 },
  "claude-haiku-4-5": { input: 1.0, output: 5.0, cache_write_5m: 1.25, cache_write_1h: 2.0, cache_read: 0.1 },
  "claude-haiku-4-5-20251001": { input: 1.0, output: 5.0, cache_write_5m: 1.25, cache_write_1h: 2.0, cache_read: 0.1 },
  other: { input: 3.0, output: 15.0, cache_write_5m: 3.75, cache_write_1h: 6.0, cache_read: 0.3 },
};

export function rateFor(model) {
  return DEFAULT_GRID[model] || DEFAULT_GRID.other;
}

// `row` = { input, output, cache_read, cache_creation_1h, cache_creation_5m } (per-million counts)
export function costFor(row) {
  const rate = rateFor(row.model);
  return (
    (row.input || 0) * rate.input +
    (row.output || 0) * rate.output +
    (row.cache_creation_1h || 0) * rate.cache_write_1h +
    (row.cache_creation_5m || 0) * rate.cache_write_5m +
    (row.cache_read || 0) * rate.cache_read
  ) / 1_000_000;
}

export function tokensFor(row) {
  return (
    (row.input || 0) +
    (row.output || 0) +
    (row.cache_read || 0) +
    (row.cache_creation_1h || 0) +
    (row.cache_creation_5m || 0)
  );
}
