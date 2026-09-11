#!/usr/bin/env bash
set -u
N="$HOME/.nvm/versions/node/v22.14.0/bin/node"
cd "$(dirname "$0")/.."
"$N" scripts/quiescence.mjs --gate > /tmp/v33q1.log 2>&1 || exit 1
grep -q "QUIESCENCE GATE PASSED" /tmp/v33q1.log || exit 1
rm -rf results/steady-state
exec "$N" scripts/steady-state.mjs --reps 1 --requests 800 --seed 999
