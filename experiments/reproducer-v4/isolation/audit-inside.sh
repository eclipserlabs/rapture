#!/usr/bin/env bash
# Adversarial isolation audit, executed INSIDE a container.
# Run identically in the subject (expected: blocked) and in an egress-attached
# control container (expected: reaches target). The only difference between the
# two runs is network attachment, so a block cannot be attributed to a missing
# binary, a wrong command, or a dead endpoint.
#
# Emits one JSON object per line: {"check","cmd","exit","class","detail"}

TMO=15
DIRECT_IP="${DIRECT_IP:-140.82.121.6}"     # github.com A record, supplied by caller
DIRECT_HOST="${DIRECT_HOST:-github.com}"
PROXY_HOST="${PROXY_HOST:-10.83.0.10}"

jstr() { python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()[:600]))'; }

emit() { # name cmd exit class detail-file
  printf '{"check":%s,"cmd":%s,"exit":%s,"class":"%s","detail":%s}\n' \
    "$(printf '%s' "$1" | jstr)" "$(printf '%s' "$2" | jstr)" "$3" "$4" "$(jstr < "$5")"
}

run() { # name binary command...
  local name="$1" bin="$2"; shift 2
  local out; out=$(mktemp)
  local present=ABSENT
  command -v "$bin" >/dev/null 2>&1 && present=PRESENT
  timeout "$TMO" "$@" >"$out" 2>&1; local ec=$?
  emit "$name" "$*" "$ec" "RAW_$present" "$out"
  rm -f "$out"
}

# --- 2. node global fetch -----------------------------------------------------
run "node_global_fetch_api_github" node node -e '
fetch("https://api.github.com",{headers:{"user-agent":"v4audit"}})
  .then(r=>{console.log("REACHED status="+r.status);process.exit(0)})
  .catch(e=>{console.log("ERR "+(e.cause&&e.cause.code||e.code||"")+" "+e.message);process.exit(1)});'

# --- 3. node https.request ----------------------------------------------------
run "node_https_request_api_github" node node -e '
const h=require("https");
const rq=h.request({host:"api.github.com",port:443,path:"/",method:"GET",headers:{"user-agent":"v4audit"}},
  r=>{console.log("REACHED status="+r.statusCode);process.exit(0)});
rq.on("error",e=>{console.log("ERR "+(e.code||"")+" "+e.message);process.exit(1)});
rq.end();'

# --- 4. npm -------------------------------------------------------------------
run "npm_view_express_version" npm npm view express version

# --- 5. git -------------------------------------------------------------------
run "git_ls_remote_express" git git ls-remote https://github.com/expressjs/express HEAD

# --- 6. curl / wget -----------------------------------------------------------
run "curl_example_com"  curl curl -sS -m 8 -o /dev/null -w 'CURL_HTTP=%{http_code}\n' https://example.com
run "wget_example_com"  wget wget -T 8 -t 1 -O- https://example.com

# --- 9/10. IPv6 and DNS-free direct socket ------------------------------------
run "ipv6_route_table"  ip   ip -6 route show
run "ipv4_route_table"  ip   ip route show
run "interfaces"        ip   ip -brief addr show
run "direct_ip_socket_no_dns" node node -e '
const net=require("net");
const s=net.connect(443,process.env.DIRECT_IP,()=>{console.log("REACHED tcp connect to "+process.env.DIRECT_IP);process.exit(0)});
s.setTimeout(9000,()=>{console.log("ERR socket timeout");process.exit(1)});
s.on("error",e=>{console.log("ERR "+(e.code||"")+" "+e.message);process.exit(1)});'
run "direct_ip_https_curl" curl curl -sS -m 8 -k -o /dev/null -w 'CURL_HTTP=%{http_code}\n' "https://${DIRECT_IP}/"
run "ipv6_literal_connect" node node -e '
const net=require("net");
const s=net.connect(443,"2606:4700:4700::1111",()=>{console.log("REACHED ipv6");process.exit(0)});
s.setTimeout(9000,()=>{console.log("ERR ipv6 timeout");process.exit(1)});
s.on("error",e=>{console.log("ERR "+(e.code||"")+" "+e.message);process.exit(1)});'

run "default_route_absent" ip ip route show default
run "proxy_allows_allowlisted_host" curl curl -sS -m 20 -o /dev/null \
  -w 'CURL_HTTP=%{http_code}\n' -x http://$PROXY_HOST:3128 https://api.opencode.ai/

# --- 11. DNS behaviour --------------------------------------------------------
run "dns_a_record_github"   getent getent hosts "$DIRECT_HOST"
run "dns_txt_exfil_channel" dig    dig +time=5 +tries=1 +short TXT google.com

# --- proxy reachability from subject -----------------------------------------
run "proxy_tcp_reachable" nc nc -z -w 5 "$PROXY_HOST" 3128
run "proxy_denies_non_allowlisted" curl curl -sS -m 10 -o /dev/null -w 'CURL_HTTP=%{http_code}\n' \
  -x http://$PROXY_HOST:3128 https://api.github.com/
