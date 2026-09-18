#!/usr/bin/env bash
# One test, one load level, one budget - for reproducing a specific observation instead of sweeping.
#
# Backed by the retained-database probe runner, which keeps the isolated database after the run so the
# failing state can be read back afterwards. That matters here: the whole question in §8 is what the
# machine looked like at the moment the flush refused, and a dropped database cannot answer it.
#
#   b01.2-one.sh <spinners> <force|-> <name-substring> <logfile>
#   force '-' leaves KFF_TEST_LIVENESS_FORCE unset, i.e. the pinned test configuration.
set -u
N="${1:?usage: b01.2-one.sh <spinners> <force|-> <name-substring> <logfile>}"
FORCE="${2:?}"; NAME="${3:?}"; LOG="${4:?}"
SPIN='const end=Date.now()+5400000;while(Date.now()<end){Math.sqrt(Math.random());}'
FILTER="Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { \$_.CommandLine -like '*Math.sqrt(Math.random())*' }"
count() { powershell -NoProfile -NonInteractive -Command "($FILTER | Measure-Object).Count" | tr -d '\r'; }
kill_all() { powershell -NoProfile -NonInteractive -Command "$FILTER | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }" >/dev/null 2>&1; }
trap 'kill_all' EXIT INT TERM
if [ "$FORCE" = "-" ]; then BUDGET="pinned(5000)"; else BUDGET="production($FORCE)"; fi

{
  echo "===== ONE: load=$(awk "BEGIN{printf \"%.2f\", $N/8}")x  budget=$BUDGET  name~'$NAME' ====="
  echo "start=$(date -Iseconds)  spinners_armed=$N  logical_cpus=8"
  echo "preflight_spinners=$(count)"
} > "$LOG"
for _ in $(seq 1 "$N"); do node -e "$SPIN" & done
[ "$N" -gt 0 ] && sleep 5
echo "spinners_running=$(count)" >> "$LOG"
cd "C:/Users/17731/Desktop/KFF" || exit 1
if [ "$FORCE" = "-" ]; then
  PROBE_TEST_NAME="$NAME" npx tsx .kff/r2-probe/run-one.ts >> "$LOG" 2>&1
else
  KFF_TEST_LIVENESS_FORCE="$FORCE" PROBE_TEST_NAME="$NAME" npx tsx .kff/r2-probe/run-one.ts >> "$LOG" 2>&1
fi
echo "exit=$?" >> "$LOG"
kill_all
sleep 3
echo "post_run_spinners=$(count)" >> "$LOG"
echo "end=$(date -Iseconds)" >> "$LOG"
echo "--- $(grep -aoE 'Tests +[0-9]+ (failed|passed)[^)]*\)' "$LOG" | tail -1) | $(grep -aoE 'Duration +[0-9.]+s' "$LOG" | tail -1) | $(grep -aoE 'PROBE_DATABASE_NAME=[a-z0-9_]+' "$LOG" | tail -1)"
