# V4 Value Probe — Subject Isolation Implementation and Adversarial Audit

**Scope executed:** infrastructure implementation and adversarial isolation audit
only. `V4-PROBE-MANIFEST.json` is **not** frozen, no calibration was run, none of
the five repair cases was invoked, V3.3 is unmodified at `5416f275`, the corpus is
unmodified, and the subject model is unchanged.

Implements the design frozen at `e462d1b3`. Supersedes the PATH-shim harness
audited at `cbca2642`.

---

## Deviation from the approved design: the container runtime

**This host is macOS 13.7.8 on Intel.** The OrbStack cask requires macOS ≥ 14 —
and so does `docker-desktop`. **Neither runtime named in the approved design is
installable here.** I did not establish this at design time; it is a defect in
the design document, not a change of preference.

Under `host_change_authorized.constraint` ("do not install additional
infrastructure products unless OrbStack cannot implement the frozen design"),
I substituted:

| | Approved | Used |
|---|---|---|
| Runtime | OrbStack (fallback Docker Desktop) | **Colima 0.10.3** — Lima VM, Ubuntu 24.04, `dockerd` 29.5.2, `docker` CLI 29.8.0 |

The design's enforcement argument was that `--internal` is a property of the
Linux bridge *inside the VM*, not of the desktop app. Colima runs the same
`dockerd` in a Linux VM, so the argument transfers unchanged. It was nonetheless
**verified empirically, not assumed** — see `default_route_absent` and
`direct_ip_socket_no_dns` below. Nothing in the audit depends on the runtime's
identity; every check is an observation made from inside the subject container.

---

## Topology as built

```
subject container                      proxy (dual-homed)            internet
eth0 10.83.0.2/24  ──── v4-subject-net ──── 10.83.0.10  ┐
NO default route        (--internal)        172.18.0.2  ├── v4-egress-net ──►
lo + eth0 only                                          ┘   gw 172.18.0.1
```

`docker inspect` reports the proxy's subject-side gateway as **`invalid IP`** and
its egress-side gateway as `172.18.0.1`. Inside the subject, `ip route show
default` prints **nothing**; the identical control container prints
`default via 172.18.0.1`.

Squid, CONNECT-only, `dstdomain api.opencode.ai opencode.ai`, `http_access deny
all`. **No IP allowlist, no Cloudflare range, no CDN range, no `*.opencode.ai`.**

---

## How a "blocked" result was made trustworthy

Every check ran twice from the **same image** via the **same script**, differing
only in network attachment: once in the subject (`v4-subject-net`) and once in a
control container on `v4-egress-net`. A check counts as structurally blocked only
if the control **reached** its target. `curl`, `wget`, `git`, `npm`, `node`,
`python3`, `dig` and `nc` are all installed in the image deliberately, so no
result can be an artifact of a missing binary.

An early classifier bug is worth recording: `curl -w 'REACHED http=%{http_code}'`
made my own analyzer read a denied request (`http=000`) as a success. The raw
per-check output is retained in `isolation/logs/audit-subject.jsonl` precisely so
that classification can be re-derived rather than trusted.

---

## Results — the ten mandatory checks

| # | Check | Expected | Result | Subject observed |
|---|---|---|---|---|
| 1 | opencode model inference via proxy | PASS | **PASS** | `READY` returned 4/4 runs |
| 2 | `node` global `fetch` → api.github.com | BLOCKED | **PASS** | `EAI_AGAIN fetch failed` |
| 3 | `node` `https.request` → api.github.com | BLOCKED | **PASS** | `getaddrinfo EAI_AGAIN` |
| 4 | `npm view express version` | BLOCKED | **PASS** | `403 Forbidden` at the ACL |
| 5 | `git ls-remote …/express HEAD` | BLOCKED | **PASS** | `CONNECT tunnel failed, response 403` |
| 6 | `curl` / `wget` public endpoint | BLOCKED | **PASS** | `CONNECT tunnel failed, 403` / `Proxy tunneling failed: Forbidden` |
| 7 | opencode built-in webfetch / search | BLOCKED WITH PROOF | **PASS** | see below |
| 8 | inherited MCP / plugins / connectors | NONE | **PASS** | `No MCP servers configured` |
| 9 | direct socket egress ignoring `HTTPS_PROXY` | BLOCKED | **PASS** | `ENETUNREACH 20.205.243.166:443` |
| 10 | credential / config inspection | only minimal provider auth | **PASS** | see below |

Control container, identical commands: every one of checks 2–6 and 9 **reached**
its target.

Check 9 is the load-bearing one. It is a raw TCP connect to a **literal IP** — no
DNS, no proxy, no HTTP client. `ENETUNREACH` is a kernel routing result, which is
exactly the property the PATH shim never had.

### Check 7 — the provider-web-bypass test

The subject was asked for the **live HEAD commit sha of `expressjs/express`**,
which cannot be present in model weights.

- `WebFetch https://api.github.com/repos/expressjs/express/commits/HEAD` → **403**; the agent printed `FETCH_FAILED`.
- opencode's built-in **Exa** search → `CONNECT mcp.exa.ai:443` **TCP_DENIED/403**; the agent printed `NO_WEB_ACCESS`.
- Ground truth `53d4a0d606c0388f764f192b306ce0e90200e7e8` appeared **0 times** in the subject's output. No 40-hex string of any kind was produced.

opencode's web tools address the **target host directly** and are refused by the
`dstdomain` ACL — they are not tunnelled through the allowed `opencode.ai`
connection. **No provider-mediated web bypass was observed.**

`mcp.exa.ai` must never be added to the allowlist: it is a general web-retrieval
channel.

### Check 10 — the credential hard gate

The host auth store holds **three** providers. Only one crossed into the subject.

| | |
|---|---|
| Host providers | `openai`, `opencode`, `opencode-go` |
| Subject providers | **`opencode` only** |
| Excluded | `openai`, `opencode-go` |

The host's global `~/.config/opencode` — which declares the `jean` MCP server and
its live token — was **never mounted or copied**. Inside the subject, opencode
generated its own config containing only `{"$schema": …}`. No jean binary, no jean
socket, no `JEAN_*` variable. No SSH keys, no `.git-credentials`, no `.netrc`, no
secret-shaped environment variables. The only credential-shaped files are the OS
CA bundle.

Mounts are exactly two: the minimal auth store and a disposable workspace. **The
Rapture repository is not mounted.**

---

## A bypass the design missed, found by the audit and closed

The Colima VM's **own sshd listens on the subject bridge gateway** `10.83.0.1`,
and `tcp/22` was **OPEN** from inside the subject container. A shell on the VM is
a host with full internet — a pivot the design did not anticipate.

Closed with `iptables -I INPUT -i br-<subject-net> -j DROP` inside the VM.
Container-to-container traffic on that bridge does not traverse `INPUT`, so
subject → proxy is unaffected.

Verified after: `10.83.0.1` tcp/22, 53, 2375, 3128 all closed/filtered from the
subject; `proxy:3128` still open; inference 3/3; **full network audit re-run with
zero failures**. `net-up.sh` re-applies the rule idempotently — it must be
re-asserted after any `colima restart`.

---

## Hostname allowlist — what actually happened

49 proxy transactions logged.

| Allowed | | Denied | |
|---|---|---|---|
| `opencode.ai` | 8 | `registry.npmjs.org` | 10 |
| `api.opencode.ai` | 2 | **`models.opencode.ai`** | **7** |
| | | `example.com` | 6 |
| | | `github.com` | 4 |
| | | `api.github.com` | 4 |
| | | `20.205.243.166` (literal) | 3 |
| | | `mcp.exa.ai` | 1 |

**`models.opencode.ai` was attempted 7 times and denied every time — and
inference still succeeded 4/4.** The frozen rule permits adding a hostname only
if inference *fails* without it. It did not fail, so **it was not added.**

---

## Residual limitations

- **The model provider is not isolated.** These are public express/fastify/hapi bugs; the model's weights may contain the historical fixes. Inherent to the corpus choice — recorded, not solved.
- **IPv6 blocking is not attributable to the design.** The control container is also IPv6-less, so this VM provides no IPv6 anywhere. IPv6 offers no bypass, but that is not evidence *for* the internal network.
- **The allowlist was validated against four runs of a trivial prompt.** A long repair run may exercise further hostnames. Any such attempt lands in the squid deny log and must be evaluated under the frozen rule, never pre-approved.
- **Disk.** Host free space fell from 6.9 GB to ~2 GB during setup. Re-check headroom before probe runs.

---

## Files

```
experiments/reproducer-v4/
  V4-PROBE-ISOLATION-AUDIT.md          this report
  results/probe-isolation-audit.json   structured result + sha256
  isolation/
    Dockerfile.subject  squid.conf  net-up.sh  net-down.sh
    audit-inside.sh     analyze.py  mk-auth.py  opencode-checks.sh
    logs/   raw per-check output, squid access log, build logs
```

`net-down.sh` removes containers, networks and the iptables rule. No host network
state outside the Colima VM was modified.

---

RAPTURE_REPRODUCER_VALUE_PROBE_ISOLATION=VALID
