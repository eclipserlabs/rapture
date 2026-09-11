#!/usr/bin/env bash
# opencode-specific isolation checks, executed INSIDE the subject container.
# Covers audit items 1 (inference), 7 (built-in web retrieval), 8 (inherited
# MCP/plugins) and 10 (credential/config inspection).
MODEL="${MODEL:-opencode/muse-spark-1.3-contributor-free}"
WS=/work/audit-ws
mkdir -p "$WS" && cd "$WS"

echo "===== CHECK 1: model inference through the proxy ====="
timeout 180 opencode run --auto --dir "$WS" -m "$MODEL" "Reply with exactly READY." 2>&1 | tail -20
echo "INFERENCE_EXIT=$?"

echo
echo "===== CHECK 7a: built-in web retrieval of UNKNOWABLE content ====="
# The current HEAD commit sha of expressjs/express cannot be known from model
# weights. If the subject returns the real value, retrieval succeeded.
timeout 180 opencode run --auto --dir "$WS" -m "$MODEL" \
  'Fetch https://api.github.com/repos/expressjs/express/commits/HEAD with your web fetch tool and print ONLY the full 40-character "sha" value from the response. If any tool call fails, print exactly: FETCH_FAILED followed by the error text. Do not guess.' 2>&1 | tail -40
echo "WEBFETCH_EXIT=$?"

echo
echo "===== CHECK 7b: built-in web search ====="
timeout 180 opencode run --auto --dir "$WS" -m "$MODEL" \
  'Search the web for the commit that fixed the express 5 router regression and print any URL you retrieve. If you have no working web access, print exactly: NO_WEB_ACCESS.' 2>&1 | tail -40
echo "WEBSEARCH_EXIT=$?"

echo
echo "===== CHECK 8: inherited MCP / plugins / instructions ====="
echo "-- opencode --help (tool/mcp surface) --"; opencode --help 2>&1 | head -40
echo "-- XDG_CONFIG_HOME tree --"; ls -laR "${XDG_CONFIG_HOME}" 2>&1 | head -30
echo "-- HOME tree --";            ls -laR "${HOME}" 2>&1 | head -40
echo "-- any opencode.json* anywhere --"; find / -xdev \( -name 'opencode.json' -o -name 'opencode.jsonc' \) 2>/dev/null
echo "-- jean present? --"; find / -xdev -iname '*jean*' 2>/dev/null | head; env | grep -i jean || echo "NO_JEAN_ENV"
echo "-- plugin dirs --"; find / -xdev -path '*opencode*plugin*' 2>/dev/null | head

echo
echo "===== CHECK 10: credential inspection ====="
echo "-- auth store provider keys --"
python3 - <<'PY' 2>&1
import json,glob,os
found=False
for p in glob.glob("/isolated/**/auth.json",recursive=True)+glob.glob(os.path.expanduser("~/.local/share/opencode/auth.json")):
    try: d=json.load(open(p))
    except Exception as e: print(p,"UNREADABLE",e); continue
    print(p,"providers=",sorted(d)); found=True
if not found: print("NO_AUTH_STORE_FOUND")
PY
echo "-- credential-shaped files on the filesystem --"
find / -xdev \( -name '*.pem' -o -name 'id_rsa*' -o -name 'id_ed25519*' -o -name '.netrc' \
  -o -name '.git-credentials' -o -name 'credentials' -o -name '.npmrc' -o -name 'auth.json' \) 2>/dev/null | head -20
echo "-- env vars that look like secrets --"
env | grep -iE 'token|key|secret|password|auth' | sed 's/=.*/=<value-present>/' || echo "NONE"
echo "-- git remotes in workspace --"; git -C /work remote -v 2>&1; git -C "$WS" remote -v 2>&1
