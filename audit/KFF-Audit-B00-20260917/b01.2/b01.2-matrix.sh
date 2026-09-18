#!/usr/bin/env bash
# §7-A/D capacity matrix on the audit machine (Lenovo Air14 2020: i5-10xxxU mobile, 16 GB, MX350,
# 8 logical threads).
#
# What varies between rows: load, and nothing else. Same file, same command, same machine, same
# database-per-run isolation. The budget is the production default (`force: 10000`), injected through
# KFF_TEST_LIVENESS_FORCE - the test reads that variable with a 5000 default, so an unset variable is
# the pinned test configuration and 10000 is production. Injecting it here rather than editing the
# pinned value keeps the committed test exactly as it was reviewed.
#
# Load is `spinner processes / logical cores`; the spinners are busy-loops, so they hold a core rather
# than sleeping on it. Teardown is by command-line filter rather than by pid: killing a spinner's parent
# leaves its grandchildren running, which contaminated an earlier run in this audit, so every process
# whose command line carries the spin expression is stopped by name and the count is printed before and
# after so a leftover cannot pass unnoticed.
#
#   b01.2-matrix.sh <force> <loads...>
set -u
FORCE="${1:?usage: b01.2-matrix.sh <force> <loads...>}"; shift
LOADS=("$@")
OUT="$(cd "$(dirname "$0")" && pwd)"
SPIN='const end=Date.now()+5400000;while(Date.now()<end){Math.sqrt(Math.random());}'
FILTER="Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { \$_.CommandLine -like '*Math.sqrt(Math.random())*' }"
count() { powershell -NoProfile -NonInteractive -Command "($FILTER | Measure-Object).Count" | tr -d '\r'; }
kill_all() { powershell -NoProfile -NonInteractive -Command "$FILTER | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }" >/dev/null 2>&1; }
trap 'kill_all' EXIT INT TERM

echo "matrix start=$(date -Iseconds) force=$FORCE loads=${LOADS[*]}"
echo "preflight_spinners=$(count)"

for N in "${LOADS[@]}"; do
  LOG="$OUT/b01.2-matrix-${N}.log"
  {
    echo "===== §7 MATRIX: browser-message, force=$FORCE, load=$(awk "BEGIN{printf \"%.2f\", $N/8}")x logical cores ====="
    echo "start=$(date -Iseconds)  spinners_armed=$N  logical_cpus=8  force=$FORCE"
    echo "preflight_spinners=$(count)"
  } > "$LOG"
  for _ in $(seq 1 "$N" 2>/dev/null); do node -e "$SPIN" & done
  [ "$N" -gt 0 ] && sleep 5
  echo "spinners_running=$(count)" >> "$LOG"
  cd "C:/Users/17731/Desktop/KFF" || exit 1
  KFF_TEST_LIVENESS_FORCE="$FORCE" npx tsx scripts/integration.ts tests/integration/browser-message.test.ts >> "$LOG" 2>&1
  echo "exit=$?" >> "$LOG"
  kill_all
  sleep 3
  echo "post_run_spinners=$(count)" >> "$LOG"
  echo "end=$(date -Iseconds)" >> "$LOG"
  echo "--- load=$N -> $(grep -aoE 'Tests +[0-9]+ (failed|passed)[^)]*\)' "$LOG" | tail -1) | $(grep -aoE 'Duration +[0-9.]+s' "$LOG" | tail -1)"
done
echo "matrix end=$(date -Iseconds)"
