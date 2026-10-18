#!/usr/bin/env python3
"""Print "<5h-block> <today> <7d>" Claude Code spend in USD, for statusline.sh.

Reads ~/.claude/projects/*/*.jsonl, dedups by message id. Days are UTC (matches the claude.ai
usage page); 7d = today + the 6 previous UTC days; 5h = ccusage-style block (starts at the hour of
its first message, lasts 5h). Costs are an estimate from PRICING (USD per million tokens): edit it
when rates change or you use another model.

Usage: python3 usage.py
"""
import datetime as dt, glob, json, os, time

PRICING = {
    "claude-fable-5-1": dict(input=10.0, output=50.0, cache_write_5m=12.5, cache_write_1h=20.0, cache_read=0.25),
    "claude-opus-5-5": dict(input=4.0, output=20.0, cache_write_5m=5.0, cache_write_1h=8.0, cache_read=0.2),
    "claude-sonnet-5-5": dict(input=2.0, output=10.0, cache_write_5m=2.5, cache_write_1h=4.0, cache_read=0.1),
    "claude-haiku-5-5": dict(input=0.5, output=2.5, cache_write_5m=0.625, cache_write_1h=1.0, cache_read=0.05),
    "other": dict(input=3.0, output=15.0, cache_write_5m=3.75, cache_write_1h=6.0, cache_read=0.3),
}

now = dt.datetime.now(dt.timezone.utc)
week_start = now.date() - dt.timedelta(days=6)
seen, msgs = set(), []  # msgs: (datetime, cost)
for p in glob.glob(os.path.expanduser("~/.claude/projects/*/*.jsonl")):
    if os.path.getmtime(p) < time.time() - 8 * 86400:
        continue
    for line in open(p):
        try:
            o = json.loads(line)
            m = o["message"]; u = m["usage"]; ts = dt.datetime.fromisoformat(o["timestamp"].replace("Z", "+00:00"))
        except (ValueError, KeyError, TypeError):
            continue
        if ts.date() < week_start or (m.get("id") and m["id"] in seen):
            continue
        seen.add(m.get("id"))
        r = PRICING.get(m.get("model"), PRICING["other"]); cc = u.get("cache_creation") or {}
        cost = ((u.get("input_tokens") or 0) * r["input"] + (u.get("output_tokens") or 0) * r["output"]
                + (u.get("cache_read_input_tokens") or 0) * r["cache_read"]
                + (cc.get("ephemeral_1h_input_tokens") or 0) * r["cache_write_1h"]
                + (cc.get("ephemeral_5m_input_tokens") or 0) * r["cache_write_5m"]) / 1e6
        msgs.append((ts, cost))
msgs.sort()

block_start = None; block = 0.0; last = now  # last is only read once block_start is set
for ts, c in msgs:
    if block_start is None or ts >= block_start + dt.timedelta(hours=5) or ts - last >= dt.timedelta(hours=5):
        block_start, block = ts.replace(minute=0, second=0, microsecond=0), 0.0
    block += c; last = ts
active = block_start is not None and now < block_start + dt.timedelta(hours=5) and now - last < dt.timedelta(hours=5)
today = sum(c for ts, c in msgs if ts.date() == now.date())
print(f"{block if active else 0:.4f} {today:.4f} {sum(c for _, c in msgs):.4f}")
