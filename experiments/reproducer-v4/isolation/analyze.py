"""Classify the raw in-container audit results and compare subject vs control.

Audit-integrity rules from the frozen authorization are enforced here, not by
eyeball:
  * a missing executable is INCONCLUSIVE_MISSING_BINARY, never "blocked"
  * a timeout with no identified cause is INCONCLUSIVE_TIMEOUT, never "blocked"
  * a check only counts as structurally blocked if the IDENTICAL command in the
    egress-attached control container reached its target
"""
import json, re, sys

EXPECT = {
    "node_global_fetch_api_github":   "BLOCKED",
    "node_https_request_api_github":  "BLOCKED",
    "npm_view_express_version":       "BLOCKED",
    "git_ls_remote_express":          "BLOCKED",
    "curl_example_com":               "BLOCKED",
    "wget_example_com":               "BLOCKED",
    "direct_ip_socket_no_dns":        "BLOCKED",
    "direct_ip_https_curl":           "BLOCKED",
    "ipv6_literal_connect":           "BLOCKED_NO_CONTROL_POSSIBLE",
    "proxy_tcp_reachable":            "REACHED",
    "proxy_denies_non_allowlisted":   "PROXY_DENIED",
    "dns_a_record_github":            "INFO",
    "dns_txt_exfil_channel":          "INFO",
    "default_route_absent":           "EMPTY_OUTPUT",
    "proxy_allows_allowlisted_host":  "REACHED",
    "ipv6_route_table":               "EMPTY_OUTPUT",
    "ipv4_route_table":               "INFO",
    "interfaces":                     "INFO",
}

# Explicit success markers only. Never a bare IP-looking string: route tables
# and error text both contain those.
REACHED = re.compile(r"\bREACHED\b|^[0-9a-f]{40}\s|CURL_HTTP=(?!000)[1-3]\d\d", re.M)
BLOCKED = re.compile(
    r"ENETUNREACH|EHOSTUNREACH|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|"
    r"network is unreachable|no route to host|connection refused|"
    r"could not resolve|name or service not known|temporary failure in name resolution|"
    r"connection timed out|failed to connect|socket timeout|unable to access|"
    r"unable to resolve|CURL_HTTP=000|wget: |giving up", re.I)
PROXY_DENY = re.compile(
    r"CONNECT tunnel failed, response (403|407)|CURL_HTTP=(403|407)|"
    r"npm error 40[37]|403 Forbidden|access denied|X-Squid-Error|Proxy tunneling failed", re.I)


def classify(rec):
    out, ec = rec["detail"], rec["exit"]
    if rec["class"] == "RAW_ABSENT":
        return "INCONCLUSIVE_MISSING_BINARY"
    if PROXY_DENY.search(out):
        # Denied at the proxy ACL. For the general-egress checks this is still a
        # block -- the client honoured the proxy and the ACL refused it -- but it
        # is recorded distinctly from a kernel-level absence of route.
        return "PROXY_DENIED"
    if REACHED.search(out) or (ec == 0 and EXPECT.get(rec["check"]) == "REACHED"):
        return "REACHED"
    exp = EXPECT.get(rec["check"])
    if exp == "EMPTY_OUTPUT":
        return "EMPTY" if not out.strip() else "NON_EMPTY"
    if ec == 0 and exp == "INFO":
        return "INFO_OK"
    if BLOCKED.search(out):
        return "BLOCKED"
    if ec in (124, 143):
        return "INCONCLUSIVE_TIMEOUT"
    if ec != 0:
        return "FAILED_UNCLASSIFIED"
    return "REACHED"


def load(path):
    recs = {}
    for line in open(path):
        line = line.strip()
        if not line.startswith("{"):
            continue
        r = json.loads(line)
        recs[r["check"]] = r
    return recs


subject, control = load(sys.argv[1]), load(sys.argv[2])
rows, verdict_fail = [], []
for name in EXPECT:
    s, c = subject.get(name), control.get(name)
    if s is None:
        rows.append({"check": name, "verdict": "MISSING_FROM_RUN"})
        verdict_fail.append(name)
        continue
    sc = classify(s)
    cc = classify(c) if c else "NO_CONTROL"
    exp = EXPECT[name]
    if exp == "INFO":
        verdict = "INFO"
    elif exp == "REACHED":
        verdict = "PASS" if sc == "REACHED" else "FAIL"
    elif exp == "PROXY_DENIED":
        verdict = "PASS" if sc == "PROXY_DENIED" else "FAIL"
    elif exp == "BLOCKED_NO_CONTROL_POSSIBLE":
        verdict = ("PASS_UNATTRIBUTABLE_IPV6_ABSENT_HOSTWIDE"
                   if sc == "BLOCKED" and cc == "BLOCKED" else
                   "PASS" if sc == "BLOCKED" else "FAIL")
    elif exp == "EMPTY_OUTPUT":
        verdict = "PASS" if sc == "EMPTY" else "FAIL"
    else:  # BLOCKED -- either no route, or refused by the proxy ACL
        if sc not in ("BLOCKED", "PROXY_DENIED"):
            verdict = "FAIL"
        elif cc not in ("REACHED",):
            # the block is real but not *attributable*: the control could not
            # reach the target either, so the target may simply be dead.
            verdict = "BLOCKED_BUT_UNATTRIBUTED"
        else:
            verdict = "PASS"
    if verdict in ("FAIL", "BLOCKED_BUT_UNATTRIBUTED", "MISSING_FROM_RUN",
                   "INCONCLUSIVE_MISSING_BINARY"):
        verdict_fail.append(name)
    rows.append({"check": name, "expected": exp, "subject": sc, "control": cc,
                 "verdict": verdict,
                 "subject_detail": s["detail"].strip()[:220],
                 "control_detail": (c["detail"].strip()[:160] if c else "")})

print(json.dumps({"rows": rows, "failing": verdict_fail,
                  "network_checks_all_pass": not verdict_fail}, indent=2))
