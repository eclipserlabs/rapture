#!/usr/bin/env bash
# Completion watcher. Deliberately avoids naming any script that appears in the
# quiescence forbidden-orphan list: a watcher whose own command line contains
# such a pattern is detected AS an orphan and blocks the very gate it waits on.
set -u
cd "$(dirname "$0")/.."
D=results/steady-state
i=0
while [ $i -lt 480 ]; do
  n=$(ls "$D" 2>/dev/null | grep -c '^ss-' || true)
  [ "$n" -ge 150 ] && { echo "RUN2_COMPLETE files=$n"; exit 0; }
  sleep 30
  i=$((i+1))
done
echo "RUN2_TIMEOUT files=$(ls "$D" 2>/dev/null | grep -c '^ss-' || true)"
