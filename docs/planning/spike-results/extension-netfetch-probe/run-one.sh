#!/usr/bin/env bash
# Runs one probe cell and reports exit code, last stdout line, and whether a
# coredump for the electron binary appeared during the run window.
set -u
BASE="${BASE:?set BASE to a scratch copy of this folder}"
ELECTRON_BIN="${REPO:?set REPO to an Orivon checkout}"/node_modules/electron/dist/electron
RUN_HEADLESS="$REPO"/scripts/run-headless.mjs

RUN_ID="$1"; EXT_DIR="$2"; EXT_NAME="$3"; SESSION_MODE="$4"; EXTRA_LISTENER="${5:-0}"

RESULTS_FILE="$BASE/results/${RUN_ID}.json"
STDOUT_FILE="$BASE/results/${RUN_ID}.stdout.log"
SINCE=$(date '+%Y-%m-%d %H:%M:%S')

PROBE_PORT=19457 \
PROBE_EXT_DIR="$EXT_DIR" \
PROBE_EXT_NAME="$EXT_NAME" \
PROBE_SESSION_MODE="$SESSION_MODE" \
PROBE_RESULTS_FILE="$RESULTS_FILE" \
PROBE_RUN_ID="$RUN_ID" \
PROBE_EXTRA_LISTENER="$EXTRA_LISTENER" \
env -u ELECTRON_RUN_AS_NODE timeout 120 node "$RUN_HEADLESS" "$ELECTRON_BIN" "$BASE/probe-app" "--user-data-dir=$BASE/userdata/$RUN_ID" > "$STDOUT_FILE" 2>&1
CODE=$?

echo "=== $RUN_ID ==="
echo "exit_code=$CODE"
echo "last_stdout_line: $(tail -1 "$STDOUT_FILE")"
echo "--- coredumps since $SINCE ---"
coredumpctl list --since="$SINCE" "$ELECTRON_BIN" 2>&1 | tail -5
echo "--- results file (steps count) ---"
if [ -f "$RESULTS_FILE" ]; then
  node -e "const r=require('$RESULTS_FILE'); console.log('finishedAt=' + r.finishedAt); console.log('steps=' + r.steps.map(s=>s.step).join(','))"
else
  echo "NO RESULTS FILE WRITTEN"
fi
echo
