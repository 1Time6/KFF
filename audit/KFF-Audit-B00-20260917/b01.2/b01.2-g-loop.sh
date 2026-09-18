#!/usr/bin/env bash
# §8-G: repeat the single case under a fixed load until the flush refuses, because the refusal is
# intermittent and one attempt proves nothing either way.
#
# The load is armed once and held across every attempt rather than re-armed per attempt, so the machine
# state is the same for each one and the only thing that varies is the run itself. Each attempt gets its
# own log and its own isolated database, and the database is retained on failure - the state at the
# moment of refusal is the evidence, and a dropped database cannot supply it.
#
# Duration is printed per attempt on purpose: earlier observations put the failure next to the slower
# runs of the same case, so the durations are part of the record rather than noise around it.
#
#   b01.2-g-loop.sh <spinners> <attempts> <name-substring> <log-prefix>
set -u
N="${1:?usage: b01.2-g-loop.sh <spinners> <attempts> <name> <prefix>}"
ATTEMPTS="${2:?}"; NAME="${3:?}"; PREFIX="${4:?}"
SPIN='const end=Date.now()+5400000;while(Date.now()<end){Math.sqrt(Math.random());}'
FILTER="Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { \$_.CommandLine -like '*Math.sqrt(Math.random())*' }"
count() { powershell -NoProfile -NonInteractive -Command "($FILTER | Measure-Object).Count" | tr -d '\r'; }
kill_all() { powershell -NoProfile -NonInteractive -Command "$FILTER | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }" >/dev/null 2>&1; }
trap 'kill_all' EXIT INT TERM

echo "loop start=$(date -Iseconds) load=$(awk "BEGIN{printf \"%.2f\", $N/8}")x attempts=$ATTEMPTS"
echo "preflight_spinners=$(count)"
for _ in $(seq 1 "$N"); do node -e "$SPIN" & done
sleep 5
echo "spinners_running=$(count)"
cd "C:/Users/17731/Desktop/KFF" || exit 1
CAPTURED=0
for i in $(seq 1 "$ATTEMPTS"); do
  LOG="${PREFIX}-try${i}.log"
  { echo "===== §8-G ATTEMPT $i  load=$(awk "BEGIN{printf \"%.2f\", $N/8}")x  name~'$NAME' ====="; echo "start=$(date -Iseconds)"; } > "$LOG"
  PROBE_TEST_NAME="$NAME" npx tsx .kff/r2-probe/run-one.ts >> "$LOG" 2>&1
  echo "exit=$?" >> "$LOG"
  DUR=$(sed 's/\x1b\[[0-9;]*m//g' "$LOG" | grep -aoE 'Duration +[0-9.]+s' | tail -1)
  RES=$(sed 's/\x1b\[[0-9;]*m//g' "$LOG" | grep -aoE 'Tests +[0-9]+ (failed|passed)[^)]*\)' | tail -1)
  # The marker has to be the diagnostic's own text, not the "§8-G" the header of this very log carries -
  # matching the header made the first version of this script stop on a passing run and call it captured.
  if grep -q 'flush refused' "$LOG"; then
    CAPTURED=1
    echo "attempt $i: *** FLUSH REFUSED — CAPTURED ***  $DUR"
    break
  fi
  echo "attempt $i: $RES | $DUR"
done
kill_all
sleep 3
echo "captured=$CAPTURED  post_run_spinners=$(count)"
echo "loop end=$(date -Iseconds)"
