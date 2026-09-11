#!/usr/bin/env bash
# Phase 7 large-application case: parse-community/parse-server.
#
# Builds two isolated git worktrees at the buggy and fixed revisions of the
# historical bug "Postgres query on non-existent column throws internal server
# error" (#10308, merged as c5c4325), and creates the Postgres databases the
# application will use.
#
# NOTHING in the application is edited. Each worktree is built with the
# project's OWN build script (babel src/ -> lib/), and node_modules is shared
# from the already-installed screening clone, exactly as a developer running
# the project locally would have it.
set -euo pipefail

CLONE=/Users/wira/Documents/rapture/rapture/.rapture/reproducer-v3/corpus-screening/parse-server
BASE=/Users/wira/Documents/rapture/rapture/.rapture/reproducer-v3-1/parse-server
BUGGY_SHA=3f888b1
FIXED_SHA=c5c4325

mkdir -p "$BASE"

for pair in "buggy:$BUGGY_SHA" "fixed:$FIXED_SHA"; do
  name="${pair%%:*}"
  sha="${pair##*:}"
  dir="$BASE/$name"
  if [ ! -d "$dir" ]; then
    echo "== creating worktree $name at $sha"
    git -C "$CLONE" worktree add --detach "$dir" "$sha"
  fi
  if [ ! -e "$dir/node_modules" ]; then
    echo "== linking node_modules (shared from the installed screening clone)"
    ln -s "$CLONE/node_modules" "$dir/node_modules"
  fi
  if [ ! -d "$dir/lib" ] || [ -z "$(ls -A "$dir/lib" 2>/dev/null)" ]; then
    echo "== building $name with the project's own build script"
    (cd "$dir" && ./node_modules/.bin/babel src/ -d lib/ --copy-files --extensions '.ts,.js' >/dev/null)
  fi
  echo "$name: $(git -C "$dir" rev-parse HEAD)"
done

for db in parse_v31_buggy parse_v31_fixed; do
  if ! psql -lqt | cut -d\| -f1 | grep -qw "$db"; then
    echo "== creating database $db"
    createdb "$db"
  fi
  psql -q -d "$db" -c 'CREATE EXTENSION IF NOT EXISTS "pgcrypto";' >/dev/null 2>&1 || true
  psql -q -d "$db" -c 'CREATE EXTENSION IF NOT EXISTS "postgis";' >/dev/null 2>&1 || true
done

echo "parse-server large-app corpus ready under $BASE"
