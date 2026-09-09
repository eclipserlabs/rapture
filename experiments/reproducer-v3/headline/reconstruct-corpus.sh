#!/usr/bin/env bash
# Reconstruct the V3 headline corpus from public repositories.
# Clones (or reuses) the four framework repos + koa screening clone, then
# creates the exact buggy/fixed worktrees pinned in headline/bug-corpus.json.
# The qs/semver dependency trees are reused unmodified from V1
# (experiments/reproducer-v1/real-bugs, exact SHAs in bug-corpus.json).
# Usage: ./reconstruct-corpus.sh [cache-dir]
set -euo pipefail
CACHE="${1:-.rapture/reproducer-v3}"
SRC="$CACHE/corpus-src"
HL="$CACHE/corpus-hl"
mkdir -p "$SRC" "$HL"
clone() {
  local url="$1" name="$2"
  if [ ! -d "$SRC/$name/.git" ]; then git clone "$url" "$SRC/$name"; fi
  git -C "$SRC/$name" fetch --tags origin
}
clone "https://github.com/koajs/koa.git" koa
clone "https://github.com/expressjs/express.git" express
clone "https://github.com/fastify/fastify.git" fastify
clone "https://github.com/hapijs/hapi.git" hapi
wt() {
  local src="$1" rev="$2" dest="$3"
  if [ ! -d "$HL/$dest" ]; then git -C "$SRC/$src" worktree add --detach "$HL/$dest" "$rev"; fi
  (cd "$HL/$dest" && npm install --no-audit --no-fund)
}
wt koa 4a191b1fb7bc999ebbe4bc822e4f315bb752006e koa-4a191b1
wt koa 10617764ac2b9160edf84b8eb2bdc8646c233b75 koa-1061776
wt koa 571938d1b42d5bbfbc4f203202e1095a63003f7e koa-571938d
wt express 4.19.2 express-4.19.2
wt express 4.21.1 express-4.21.1
wt fastify v5.3.0 fastify-5.3.0
wt fastify v5.3.2 fastify-5.3.2
wt hapi 509538273c8168609c283acba95d2ecd03b37bd2 hapi-5095382
wt hapi 2e418c454b2b0f1bdb58692d8a713de1d910f52a hapi-ee8475b
wt hapi 62032e6d3189deb638cac8cd18e18607230f2a06 hapi-62032e6
wt hapi 97c435fefea45b4a5ccfdb3873dd52da054f4d66 hapi-97c435f
echo "corpus reconstructed under $HL"
