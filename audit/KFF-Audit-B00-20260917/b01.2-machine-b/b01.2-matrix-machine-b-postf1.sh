#!/usr/bin/env bash
# POST-F1 §7 matrix on Machine B. Identical to b01.2-matrix-machine-b.sh except the log prefix, so the
# PRE-F1 logs are preserved byte-for-byte and the two runs can never be confused. Run only after the
# F1 settlement fix (guardian.ts) is in the working tree.
#
#   b01.2-matrix-machine-b-postf1.sh <force> <loads...>   (loads are absolute spinner counts)
set -u
FORCE="${1:?usage: b01.2-matrix-machine-b-postf1.sh <force> <loads...>}"; shift
LOADS=("$@")
OUT="$(cd "$(dirname "$0")" && pwd)"
REPO="C:/Users/17731/Documents/ChatGPT/KFF"
CORES="$(powershell -NoProfile -NonInteractive -Command "(Get-CimInstance Win32_ComputerSystem).NumberOfLogicalProcessors" | tr -d '\r' | tr -d ' ')"
SPIN='const end=Date.now()+5400000;while(Date.now()<end){Math.sqrt(Math.random());}'
FILTER="Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { \$_.CommandLine -like '*Math.sqrt(Math.random())*' }"
count() { powershell -NoProfile -NonInteractive -Command "($FILTER | Measure-Object).Count" | tr -d '\r'; }
kill_all() { powershell -NoProfile -NonInteractive -Command "$FILTER | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }" >/dev/null 2>&1; }
trap 'kill_all' EXIT INT TERM

echo "matrix start=$(date -Iseconds) machine=Machine-B phase=POST-F1 force=$FORCE cores=$CORES loads=${LOADS[*]}"
echo "preflight_spinners=$(count)"

for N in "${LOADS[@]}"; do
  LOG="$OUT/b01.2-machine-b-postf1-matrix-${N}.log"
  {
    echo "===== §7 MATRIX (Machine B, POST-F1): browser-message, force=$FORCE, load=$(awk "BEGIN{printf \"%.2f\", $N/$CORES}")x logical cores ====="
    echo "start=$(date -Iseconds)  spinners_armed=$N  logical_cpus=$CORES  force=$FORCE  machine=Machine-B  phase=POST-F1"
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
