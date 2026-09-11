#!/usr/bin/env bash
# Gate then run. Kept in a script file so no wrapper command line contains a
# forbidden-orphan pattern (which would make the guard flag its own launcher).
set -u
N="$HOME/.nvm/versions/node/v22.14.0/bin/node"
cd "$(dirname "$0")/.."
"$N" scripts/quiescence.mjs --gate > /tmp/v33gate.log 2>&1 || exit 1
grep -q "QUIESCENCE GATE PASSED" /tmp/v33gate.log || exit 1
"$N" scripts/quiescence.mjs --snapshot results/quiescence-phase4-start.json >> /tmp/v33gate.log 2>&1
rm -rf results/steady-state
exec "$N" scripts/steady-state.mjs --reps 10 --requests 20000
