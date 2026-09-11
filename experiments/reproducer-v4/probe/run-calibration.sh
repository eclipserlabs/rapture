#!/usr/bin/env bash
# Four calibration runs, sequential (run_concurrency = 1).
set -uo pipefail
N22="$HOME/.nvm/versions/node/v22.14.0/bin/node"
cd "$(dirname "$0")"
run() {
  echo "##### RUN $1 $2  $(date +%H:%M:%S) #####"
  "$N22" run.mjs --case "$1" --arm "$2" --label "cal-$1-$2" \
    --evidence "/tmp/v4ev/$1" --budget 1200 2>&1 | tail -45
  echo
}
run koa-1998 CONTROL
run koa-1998 TREATMENT
run koa-1999 CONTROL
run koa-1999 TREATMENT
echo "ALL_CALIBRATION_RUNS_COMPLETE"
