#!/usr/bin/env bash
# The twenty preregistered value-probe runs, in the frozen schedule order,
# concurrency 1. Reads the schedule emitted from V4-PROBE-MANIFEST.json.
set -uo pipefail
N22="$HOME/.nvm/versions/node/v22.14.0/bin/node"
cd "$(dirname "$0")"
RESULTS="$PWD/../results/probe-headline"
mkdir -p "$RESULTS"

while read -r idx case rep arm; do
  [ -z "${idx:-}" ] && continue
  LABEL="p${idx}-${case}-r${rep}-${arm}"
  if [ -f "$RESULTS/run-$LABEL.json" ]; then echo "##### SKIP $LABEL (already recorded) #####"; continue; fi
  echo "##### RUN ${idx}/20 $case rep$rep $arm  $(date +%H:%M:%S) #####"
  "$N22" run.mjs --case "$case" --arm "$arm" --label "$LABEL" \
    --evidence "$PWD/evidence/$case" --budget 1200 --results "$RESULTS" 2>&1 | tail -40
  RC=${PIPESTATUS[0]}
  if [ "$RC" = "2" ]; then echo "RESOURCE_BLOCKED at run $idx — stopping before the next run"; exit 2; fi
  echo
done < headline-schedule.txt
echo "ALL_HEADLINE_RUNS_COMPLETE"
