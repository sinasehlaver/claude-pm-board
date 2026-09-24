#!/bin/bash
# Boot pm against a throwaway fixture workspace on a free port, smoke the API
# (projects + sessions + launch dryrun), then run the browser check if web/ is built.
# Usage: npm run verify
set -euo pipefail
cd "$(dirname "$0")/.."

port=$(../.claude/scripts/freeport.sh)
fix=$(mktemp -d -t pm-verify)
mkdir -p "$fix/.claude"/{state,rules,backlog,handoffs,pm,scripts}
# the fixture is a fake workspace; give it the real harvester (it honors PM_ROOT)
ln -sf "$(cd .. && pwd)/.claude/scripts/pm-activity.mjs" "$fix/.claude/scripts/pm-activity.mjs"

# fake session transcript at the path the harvester derives from PM_ROOT
sesc=$(printf '%s' "$fix" | tr '/' '-')
sdir="$HOME/.claude/projects/$sesc"
mkdir -p "$sdir"
sid="feedface-0000-1111-2222"
{
  echo '{"type":"queue-operation","timestamp":"2026-09-08T09:00:00Z"}'
  echo '{"type":"user","timestamp":"2026-09-08T09:00:01Z","cwd":"/whatever/Projects","message":{"role":"user","content":"help me fix the hub widget layout please"}}'
  echo '{"type":"ai-title","aiTitle":"Hub widget layout fix"}'
  echo "{\"type\":\"assistant\",\"timestamp\":\"2026-09-08T09:05:00Z\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"tool_use\",\"name\":\"Edit\",\"input\":{\"file_path\":\"$fix/hub/web/x.jsx\"}}]}}"
  echo '{"type":"user","timestamp":"2026-09-08T09:06:00Z","message":{"role":"user","content":[{"type":"tool_result","text":"ok"}]}}'
  echo '{"type":"assistant","timestamp":"2026-09-08T09:30:00Z","message":{"role":"assistant","content":[{"type":"text","text":"done"}]}}'
} > "$sdir/$sid.jsonl"

cat > "$fix/.claude/rules/hub.md" <<'EOF'
# hub — rules
EOF
cat > "$fix/.claude/state/hub.md" <<'EOF'
# hub — state
Updated: 2026-09-07

## Now
- [ ] Wire the P2 connectors feed

## Next
- P3 dev-ops
- P5 drills

## Last failure
none

## Blockers
none
EOF
cat > "$fix/.claude/backlog/hub.md" <<'EOF'
# hub — backlog
Updated: 2026-09-08

## Doing
- P2 connectors/feeds  p1

## Todo
- Widget designer sandbox  @seq  p3
- P2 connectors wiring  @seq

## Done
- P4 diet & self-care  (2026-09-07)
EOF
cat > "$fix/.claude/backlog/discord-clone.md" <<'EOF'
# discord-clone — backlog
Updated: 2026-09-08

## Todo
- Decide: fork an OSS client or build fresh  p2
EOF
cat > "$fix/.claude/backlog/ideas.md" <<'EOF'
# ideas — backlog
Updated: 2026-09-09

## Todo
- some captured idea
EOF
echo '[{"project":"hub","date":"2026-09-07T18:00:00Z","kind":"commit","summary":"diet widgets","ref":"a1b2c3d"}]' > "$fix/.claude/pm/activity.json"

export PM_ROOT="$fix" PORT="$port" PM_LAUNCH_DRYRUN=1
node server/index.mjs &
PID=$!
trap 'kill $PID 2>/dev/null; wait $PID 2>/dev/null; rm -rf "$fix" "$sdir"' EXIT

for _ in $(seq 1 50); do
  curl -sf "http://127.0.0.1:$port/api/health" >/dev/null && break
  sleep 0.2
done
# give the boot-time harvester a moment to write sessions.json
for _ in $(seq 1 25); do
  [ -f "$fix/.claude/pm/sessions.json" ] && break
  sleep 0.2
done

B="http://127.0.0.1:$port"
jn() { node -e "$1"; }

# a live-looking unattended relay job (pid = this script, alive for the whole run)
mkdir -p "$fix/.claude/pm/relay"
now_ms=$(( $(date +%s) * 1000 ))
cat > "$fix/.claude/pm/relay/verify.job.json" <<EOF
{"id":"verify","label":"hub (2)","status":"waiting","pid":$$,"startedAt":$now_ms,"updatedAt":$now_ms,"attempt":1,"open":2,"resumeAt":$(( now_ms + 7200000 )),"waitReason":"five_hour limit","events":[]}
EOF

echo "--- /api/projects"
curl -sf "$B/api/projects" | jn 'const d=JSON.parse(require("fs").readFileSync(0));console.log(d.map(p=>`${p.slug} open=${p.openCount} pinned=${p.pinned} adhoc=${p.adhoc}`).join("\n"));if(!d.find(p=>p.slug==="ideas"&&p.pinned))process.exit(1)'

echo "--- /api/sessions (inbox)"
curl -sf "$B/api/sessions" | jn 'const d=JSON.parse(require("fs").readFileSync(0));const s=d.inbox.find(x=>x.id==="feedface-0000-1111-2222");if(!s)process.exit(1);if(s.guess!=="hub"){console.error("bad guess",s.guess);process.exit(1)}console.log("session guess =",s.guess,"| touched =",s.touched.join(","))'

echo "--- file session under hub"
curl -sf -X PUT "$B/api/sessions/feedface-0000-1111-2222" -H content-type:application/json -d '{"project":"hub"}' >/dev/null
curl -sf "$B/api/sessions" | jn 'const d=JSON.parse(require("fs").readFileSync(0));if(d.inbox.length!==0||d.filed.length!==1)process.exit(1);console.log("filed:",d.filed[0].project)'
curl -sf "$B/api/projects/hub" | jn 'const d=JSON.parse(require("fs").readFileSync(0));if(!d.sessions||d.sessions.length!==1)process.exit(1);console.log("hub.sessions =",d.sessions.length)'

echo "--- build-with-claude (dryrun)"
curl -sf -X POST "$B/api/projects/hub/tasks/0/launch" | jn 'const d=JSON.parse(require("fs").readFileSync(0));if(!d.ok||!d.dryrun||!/claude "\$\(cat /.test(d.cmd))process.exit(1);console.log("launch cmd:",d.cmd.slice(0,60),"…")'

echo "--- run @seq orchestrator (dryrun; default = unattended relay, {unattended:false} = interactive)"
curl -sf -X POST "$B/api/projects/hub/tasks/run-seq" | jn 'const d=JSON.parse(require("fs").readFileSync(0));if(!d.ok||!d.dryrun||d.count!==2||!d.relay||!/caffeinate -is node .*relay-cli\.mjs/.test(d.cmd))process.exit(1);console.log("run-seq relay count =",d.count,"| job:",d.job)'
curl -sf -X POST "$B/api/projects/hub/tasks/run-seq" -H content-type:application/json -d '{"unattended":false}' | jn 'const d=JSON.parse(require("fs").readFileSync(0));if(!d.ok||!d.dryrun||d.count!==2||d.relay||!/claude "\$\(cat /.test(d.cmd))process.exit(1);console.log("run-seq interactive count =",d.count,"| cmd:",d.cmd.slice(0,50),"…")'
curl -sf "$B/api/relay" | jn 'const d=JSON.parse(require("fs").readFileSync(0));if(d.length!==1||d[0].status!=="waiting")process.exit(1);console.log("relay jobs listed =",d.length,"| status =",d[0].status)'

echo "--- run-all fallback (no @seq flags -> every Todo/Doing; nothing runnable -> 400)"
curl -sf -X POST "$B/api/projects/discord-clone/tasks/run-seq" | jn 'const d=JSON.parse(require("fs").readFileSync(0));if(!d.ok||!d.dryrun||d.mode!=="all"||d.count!==1)process.exit(1);console.log("run-all count =",d.count,"| mode =",d.mode)'
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/api/projects/nosuch/tasks/run-seq")
[ "$code" = "400" ] || { echo "expected 400 for empty project, got $code"; exit 1; }
echo "empty project -> 400"

echo "--- latest todos + cross-project run (dryrun; ideas excluded; stale -> 409)"
curl -sf "$B/api/todos/latest?limit=10" | jn 'const d=JSON.parse(require("fs").readFileSync(0));if(d.length!==4||d.some(t=>t.slug==="ideas"))process.exit(1);if(!["slug","id","title","note","seq","priority"].every(k=>k in d[0]))process.exit(1);console.log("latest:",d.map(t=>t.slug+":"+t.title).join(" | "))'
items=$(curl -sf "$B/api/todos/latest" | jn 'const d=JSON.parse(require("fs").readFileSync(0));console.log(JSON.stringify({items:d.slice(0,3).map(({slug,id,title})=>({slug,id,title})).concat([{slug:"ideas",id:0}])}))')
curl -sf -X POST "$B/api/tasks/run-cross" -H content-type:application/json -d "$items" | jn 'const d=JSON.parse(require("fs").readFileSync(0));if(!d.ok||!d.dryrun||d.count!==3||d.skipped!==1||!d.relay||!/relay-cli\.mjs/.test(d.cmd))process.exit(1);console.log("run-cross count =",d.count,"projects =",d.projects,"skipped =",d.skipped)'
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/api/tasks/run-cross" -H content-type:application/json -d '{"items":[{"slug":"hub","id":0,"title":"not the title"}]}')
[ "$code" = "409" ] || { echo "expected 409 for stale item, got $code"; exit 1; }
echo "stale item -> 409"

if [ -f web/dist/index.html ] && [ -f web/verify.mjs ]; then
  echo "--- browser check"
  PM_URL="$B/" node web/verify.mjs
fi

echo "verify OK"
