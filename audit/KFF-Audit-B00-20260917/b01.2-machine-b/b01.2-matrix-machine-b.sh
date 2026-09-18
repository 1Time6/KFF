#!/usr/bin/env bash
# §7-A/D capacity matrix on Machine B (desktop: i5-14600KF, 14C/20T, 32GB DDR5-6000, RTX 4060 Ti 8GB,
# Windows 11 build 26200). This is the Machine B counterpart of Machine A's b01.2-matrix.sh; logs go to
# this script's own directory and every header is stamped Machine B so the two machines' data cannot be
# mixed. Logical cores are read live from the system instead of being assumed.
#
# Same semantics as the Machine A matrix: only the load varies between rows; the budget is the
# production default force=10000 injected through KFF_TEST_LIVENESS_FORCE; spinners are busy-loops and
# teardown is by command-line filter with a printed before/after count.
#
#   b01.2-matrix-machine-b.sh <force> <loads...>   (loads are absolute spinner counts)
set -u
FORCE="${1:?usage: b01.2-matrix-machine-b.sh <force> <loads...>}"; shift
LOADS=("$@")
OUT="$(cd "$(dirname "$0")" && pwd)"
REPO="C:/Users/17731/Documents/ChatGPT/KFF"
CORES="$(powershell -NoProfile -NonInteractive -Command "(Get-CimInstance Win32_ComputerSystem).NumberOfLogicalProcessors" | tr -d '\r' | tr -d ' ')"
SPIN='const end=Date.now()+5400000;while(Date.now()<end){Math.sqrt(Math.random());}'
FILTER="Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { \$_.CommandLine -like '*Math.sqrt(Math.random())*' }"
count() { powershell -NoProfile -NonInteractive -Command "($FILTER | Measure-Object).Count" | tr -d '\r'; }
kill_all() { powershell -NoProfile -NonInteractive -Command "$FILTER | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }" >/dev/null 2>&1; }
trap 'kill_all' EXIT INT TERM

echo "matrix start=$(date -Iseconds) machine=Machine-B force=$FORCE cores=$CORES loads=${LOADS[*]}"
echo "preflight_spinners=$(count)"

for N in "${LOADS[@]}"; do
  LOG="$OUT/b01.2-machine-b-matrix-${N}.log"
  {
    echo "===== §7 MATRIX (Machine B): browser-message, force=$FORCE, load=$(awk "BEGIN{printf \"%.2f\", $N/$CORES}")x logical cores ====="
    echo "start=$(date -Iseconds)  spinners_armed=$N  logical_cpus=$CORES  force=$FORCE  machine=Machine-B"
    echo "preflight_spinners=$(count)"
  } > "$LOG"
  for _ in $(seq 1 "$N" 2>/dev/null); do node -e "$SPIN" & done
  [ "$N" -gt 0 ] && sleep 5
  echo "spinners_running=$(count)" >> "$LOG"
  cd "$REPO" || exit 1
  KFF_TEST_LIVENESS_FORCE="$FORCE" npx tsx scripts/integration.ts tests/integration/browser-message.test.ts >> "$LOG" 2>&1
  echo "exit=$?" >> "$LOG"
  kill_all
  sleep 3
  echo "post_run_spinners=$(count)" >> "$LOG"
  echo "end=$(date -Iseconds)" >> "$LOG"
  echo "--- load=$N ($(awk "BEGIN{printf \"%.2f\", $N/$CORES}")x) -> $(grep -aoE 'Tests +[0-9]+ (failed|passed)[^)]*\)' "$LOG" | tail -1) | $(grep -aoE 'Duration +[0-9.]+s' "$LOG" | tail -1)"
done
echo "matrix end=$(date -Iseconds)"
