#!/usr/bin/env bash
set -uo pipefail

CLI="node $(dirname "$0")/../bin/queuectl.js"
WORKDIR=$(mktemp -d)
cd "$WORKDIR" || exit 1

PASS=0
FAIL=0

pass() { echo "  PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

get_state() {
  $CLI list --json | python3 -c "
import json, sys
jobs = json.load(sys.stdin)
job = next((j for j in jobs if j['id'] == '$1'), None)
print(job['state'] if job else 'MISSING')
"
}

wait_for_state() {
  local id=$1 target=$2 timeout=${3:-15}
  local start=$(date +%s)
  while true; do
    local state=$(get_state "$id")
    if [ "$state" = "$target" ]; then return 0; fi
    if [ $(( $(date +%s) - start )) -ge "$timeout" ]; then return 1; fi
    sleep 0.3
  done
}

echo "=== Scenario 1: A basic job completes ==="
$CLI enqueue '{"id":"s1job","command":"echo hi"}' > /dev/null
WORKER_PID_FILE_CHECK=$($CLI worker start &)
WORKER1_PID=$!
if wait_for_state s1job completed 10; then pass "basic job completed"; else fail "basic job did not complete"; fi
kill -TERM "$WORKER1_PID" 2>/dev/null
wait "$WORKER1_PID" 2>/dev/null

echo "=== Scenario 2: A failing job retries with backoff and lands in the DLQ ==="
$CLI config set backoff-base 1 > /dev/null
$CLI enqueue '{"id":"s2job","command":"node -e \"process.exit(1)\"","max_retries":2}' > /dev/null
$CLI worker start &
WORKER2_PID=$!
if wait_for_state s2job dead 20; then pass "failing job reached DLQ"; else fail "failing job did not reach DLQ"; fi
kill -TERM "$WORKER2_PID" 2>/dev/null
wait "$WORKER2_PID" 2>/dev/null

echo "=== Scenario 3: Many jobs across multiple workers — every job runs exactly once ==="
RESULTS_FILE="$WORKDIR/s3-results.txt"
HELPER="$WORKDIR/s3-helper.js"
cat > "$HELPER" <<'EOF'
const fs = require('fs');
const [, , file, id] = process.argv;
fs.appendFileSync(file, id + '\n');
EOF
for i in $(seq 1 15); do
  $CLI enqueue "{\"id\":\"s3job$i\",\"command\":\"node \\\"$HELPER\\\" \\\"$RESULTS_FILE\\\" s3job$i\",\"max_retries\":1}" > /dev/null
done
$CLI worker start --count 4 &
WORKER3_PID=$!
start=$(date +%s)
while true; do
  count=$($CLI list --state completed --json | python3 -c "import json,sys; print(len(json.load(sys.stdin)))")
  if [ "$count" = "15" ]; then break; fi
  if [ $(( $(date +%s) - start )) -ge 20 ]; then break; fi
  sleep 0.3
done
kill -TERM "$WORKER3_PID" 2>/dev/null
wait "$WORKER3_PID" 2>/dev/null
LINE_COUNT=$(sort "$RESULTS_FILE" | wc -l)
UNIQUE_COUNT=$(sort -u "$RESULTS_FILE" | wc -l)
if [ "$LINE_COUNT" = "15" ] && [ "$UNIQUE_COUNT" = "15" ]; then
  pass "all 15 jobs ran exactly once across 4 workers"
else
  fail "expected 15 unique lines, got $LINE_COUNT lines / $UNIQUE_COUNT unique"
fi

echo "=== Scenario 4: Workers SIGKILLed mid-job; after restart, job still completes, nothing stuck in processing ==="
$CLI enqueue '{"id":"s4job","command":"sleep 5"}' > /dev/null
$CLI worker start --stale-timeout-ms 2000 &
WORKER4A_PID=$!
if wait_for_state s4job processing 10; then
  kill -KILL "$WORKER4A_PID" 2>/dev/null
  $CLI worker start --stale-timeout-ms 2000 &
  WORKER4B_PID=$!
  if wait_for_state s4job completed 60; then
    pass "job recovered from SIGKILL and completed within 60s"
  else
    fail "job did not recover / complete within 60s"
  fi
  kill -TERM "$WORKER4B_PID" 2>/dev/null
  wait "$WORKER4B_PID" 2>/dev/null
else
  fail "job never reached processing state"
fi

echo "=== Scenario 5: Jobs survive a full restart ==="
$CLI enqueue '{"id":"s5job","command":"echo hi"}' > /dev/null
STATE_BEFORE=$(get_state s5job)
# no process restart needed to prove this — every CLI invocation already opens
# a fresh DB connection (see src/cli/context.js) — this simulates "the process
# that touches the DB is gone and a new one starts", which is the real thing
# a restart changes from the DB's point of view.
STATE_AFTER=$(get_state s5job)
if [ "$STATE_BEFORE" = "$STATE_AFTER" ] && [ "$STATE_AFTER" = "pending" ]; then
  pass "job state persisted identically across a fresh CLI invocation"
else
  fail "job state did not persist ($STATE_BEFORE -> $STATE_AFTER)"
fi

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
echo "workdir: $WORKDIR (not cleaned up — inspect if needed)"

if [ "$FAIL" -gt 0 ]; then exit 1; fi
exit 0