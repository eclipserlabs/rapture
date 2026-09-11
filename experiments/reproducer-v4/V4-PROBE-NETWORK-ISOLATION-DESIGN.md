# V4 Value Probe — Subject Network Isolation Design

**Design only. Nothing installed, nothing run, no probe case invoked, no probe
manifest frozen.** Frozen V3.3 untouched at `5416f275`.

Supersedes the rejected PATH-shim approach, which was proven bypassable
(`node fetch` → 200 while `curl` was blocked).

## Facts established for this design

Three were measured on this host rather than assumed:

| Fact | Method | Result |
|---|---|---|
| Provider endpoints | sampled `lsof -i` during one isolated trivial inference run | `104.20.32.17:443`, `172.65.90.20:443`, `172.65.90.21:443`, `172.66.173.149:443` — forward-resolving to **`opencode.ai`** and **`api.opencode.ai`** |
| opencode honours proxy env | ran inference with `HTTPS_PROXY`/`HTTP_PROXY`/`ALL_PROXY` pointed at a dead port | inference **did not complete** → opencode (Bun-based) **honours** proxy env |
| Node ignores proxy env | known undici behaviour, consistent with the earlier audit | subject's own `node fetch` attempts go **direct**, not via proxy |

The second and third facts together are what make this design work: **the
component that must reach the network cooperates with the proxy, and the
components that must not reach the network do not.** Isolation therefore does
not depend on subject cooperation — it depends on there being no route.

## Proposed topology

```
┌───────────────────────────────┐        ┌──────────────────────────────┐
│ subject-net  (--internal)     │        │ egress-net (default bridge)  │
│ NO gateway, NO route off-host │        │ normal outbound              │
│                               │        │                              │
│  ┌─────────────────────────┐  │        │                              │
│  │ subject container       │  │        │                              │
│  │  opencode + workspace   │  │        │                              │
│  │  HTTPS_PROXY=proxy:3128 │  │        │                              │
│  │  no direct route out    │  │        │                              │
│  └───────────┬─────────────┘  │        │                              │
│              │ only path      │        │                              │
│  ┌───────────▼─────────────┐  │        │                              │
│  │ proxy container (dual-homed)────────────────► internet (ACL'd)     │
│  │  CONNECT allowlist:     │  │        │                              │
│  │   api.opencode.ai       │  │        │                              │
│  │   opencode.ai           │  │        │                              │
│  │  logs every attempt     │  │        │                              │
│  └─────────────────────────┘  │        │                              │
└───────────────────────────────┘        └──────────────────────────────┘
```

## Chosen container runtime

**OrbStack**, with Docker Desktop as the equally-valid fallback.

| Runtime | Internal network | Dual-homed container | macOS fit | Verdict |
|---|---|---|---|---|
| **OrbStack** | yes (Docker-compatible `--internal`) | yes | lightest; fast VM, low idle cost | **recommended** |
| Docker Desktop | yes | yes | heaviest, but most standard | acceptable fallback |
| Podman | yes (`--internal`) | yes | needs `podman machine`; rootless networking adds friction | not preferred |

Rationale: all three enforce `--internal` identically because it is a property
of the Linux bridge inside the VM, not of the desktop app. OrbStack is chosen
purely on host cost — this box has 4 logical CPUs, 8 GB RAM and ~4.6 GB free
disk, and Docker Desktop's idle footprint is material at that size.

**Does it enforce no-direct-egress independently of application cooperation?**
**Yes.** A Docker network created with `--internal` has no gateway and no NAT
rule to the host's external interface. A container attached only to that network
cannot route to any off-host address regardless of what it runs, what
environment variables it sets, or which HTTP client it uses. This is the
property the PATH shim never had.

## Network enforcement mechanism

```sh
docker network create --internal --subnet 10.83.0.0/24 v4-subject-net
docker network create v4-egress-net            # normal, has outbound

docker run -d --name v4-proxy --network v4-subject-net \
  -v "$PWD/squid.conf:/etc/squid/squid.conf:ro" ubuntu/squid:latest
docker network connect v4-egress-net v4-proxy  # second leg: dual-homed

docker run --rm --name v4-subject --network v4-subject-net \
  -e HTTPS_PROXY=http://v4-proxy:3128 \
  -e HTTP_PROXY=http://v4-proxy:3128 \
  -e ALL_PROXY=http://v4-proxy:3128 \
  -e XDG_CONFIG_HOME=/isolated/config \
  -e HOME=/isolated/home \
  -v "$WORKSPACE:/work" \
  v4-subject-image ...
```

The subject container is attached to **one** network, and that network is
internal. The proxy is the only host on it with a second interface.

## Proxy choice and hostname ACL

**Squid**, CONNECT-only, hostname ACL — **not** an IP allowlist.

```squid
http_port 3128
acl SSL_ports port 443
acl CONNECT method CONNECT
acl model_hosts dstdomain api.opencode.ai opencode.ai

http_access allow CONNECT model_hosts SSL_ports
http_access deny all

access_log stdio:/dev/stdout squid
forwarded_for delete
via off
```

`dstdomain` matches the hostname in the **CONNECT request line**, which the
client must send before any bytes flow. A request for `github.com` is denied at
that point — no tunnel is opened, nothing resolves, nothing leaves.

Squid is preferred over tinyproxy because `dstdomain` semantics are exact and
the access log gives a per-attempt audit trail for free, satisfying the
"keep the network-attempt audit trail" requirement.

## Provider hostname discovery method

Already performed, and repeatable:

1. Start one trivial inference (`"Reply with exactly READY."`) in an isolated
   workspace — never a probe case.
2. Sample `lsof -nP -i TCP` for the runtime process at 1s intervals.
3. Collect distinct remote IP:port pairs.
4. Forward-resolve candidate hostnames and match against the observed set.

Observed minimum set: **`api.opencode.ai`, `opencode.ai`**. During
implementation this is re-run **inside** the container with the proxy in
`deny all` mode first, so any additional hostname (auth, telemetry) appears in
the Squid deny log and can be evaluated explicitly rather than guessed. Only
hostnames that inference actually requires are added.

## Threat model

The subject agent is assumed **actively motivated** to retrieve the historical
fix — not malicious, but optimising for task success, which here means finding
the upstream patch. The corpus is public express/fastify/hapi bugs identified by
exact fixing SHA, so a single `git fetch` would end the experiment's validity.

In scope: any retrieval path reachable from inside the subject container.
Out of scope: host compromise, container escape, and the model provider itself
(the model's own training data may contain these public fixes — an inherent
limitation of using historical public bugs, recorded but not solvable here).

## Known bypasses and how each is closed

| # | Bypass | Closure | Residual |
|---|---|---|---|
| 1 | Subject ignores `HTTPS_PROXY` and dials direct (the exact failure that invalidated the last harness) | `--internal` network has no route; connection fails at the kernel | none |
| 2 | Subject points at a different proxy | any other proxy is equally unreachable | none |
| 3 | `node fetch` / `https.request` / raw sockets | same as #1 — no route | none |
| 4 | `npm`, `git`, `curl`, `wget` | same as #1 — no route | none |
| 5 | CONNECT to an allowed host, then address a different server | CONNECT opens a tunnel to the hostname Squid resolves; the tunnel cannot be redirected | none |
| 6 | Public DNS lookup or DNS-based exfiltration | no external resolver reachable; the proxy resolves on the subject's behalf | none |
| 7 | opencode built-in `webfetch`/search | Bun honours the proxy, so it transits Squid and is denied by `dstdomain` | none |
| 8 | Inherited MCP servers, plugins, global instructions | container has its own `HOME` and `XDG_CONFIG_HOME`; `~/.config/opencode` is **not** mounted; `--pure` disables external plugins | none |
| 9 | Upstream remote in the workspace | workspace is a fresh single-commit repo with no remote; corpus repos are not mounted | none |
| 10 | IPv6 egress sidestepping the v4 bridge | disable IPv6 on both networks (`--ipv6=false`, default off) and assert in audit | verify in audit |
| 11 | Proxy container itself abused as a shell | subject can reach only tcp/3128; Squid config mounted read-only | none |

**The credential problem is the main implementation risk.** opencode needs
provider auth inside the container, and its auth store sits alongside the
global config that must *not* be inherited. The implementation must copy **only**
the auth material into `/isolated/`, never mount `~/.config/opencode` (which
declares a `jean` MCP server carrying a live token). If the auth material cannot
be separated cleanly, that is a design failure and must be reported, not
worked around.

## Audit procedure (must pass before any probe run)

Run **inside** the subject container, via the agent itself so it exercises the
same tool path the probe will use:

| # | Test | Expected |
|---|---|---|
| 1 | opencode model inference (`"Reply with exactly READY."`) | **PASS** |
| 2 | `node -e "fetch('https://api.github.com')"` | **BLOCKED** |
| 3 | `node -e "require('https').get('https://api.github.com')"` | **BLOCKED** |
| 4 | `npm view express version` | **BLOCKED** |
| 5 | `git ls-remote https://github.com/expressjs/express HEAD` | **BLOCKED** |
| 6 | `curl -m 8 https://example.com` and `wget -T 8 https://example.com` | **BLOCKED** |
| 7 | opencode built-in webfetch/search on a public URL | **BLOCKED** |
| 8 | inherited MCP/plugin/connector enumeration | **NONE** |
| 9 | `ip -6 route` / IPv6 egress attempt | **no route** |
| 10 | Squid access log review | every attempt logged; only `*.opencode.ai` ALLOWED |

Checks 2–7 must fail **by absence of route or ACL denial**, not by a missing
binary — a `command not found` does not count as blocked and must be recorded
as an inconclusive check.

## Host installation and changes required

- Install **OrbStack** (single user-space macOS app) — or Docker Desktop.
- No kernel extensions, no system network changes, no root daemon configuration.
- Pull two images: a Squid image and a Node/Bun base for the subject.
- Disk: ~1.5–2.5 GB for runtime + images. **Current free space is 4.6 GB**, so
  this fits but leaves limited headroom; re-check before pulling.

## Estimated setup time

| Step | Estimate |
|---|---|
| Install runtime, first start | 15–25 min |
| Build subject image, resolve credential isolation | 20–40 min |
| Squid config + network creation | 10 min |
| Full 10-point adversarial audit | 15–20 min |
| **Total** | **1–1.5 hours** before any calibration run |

## Rollback / cleanup

```sh
docker rm -f v4-subject v4-proxy
docker network rm v4-subject-net v4-egress-net
docker rmi v4-subject-image ubuntu/squid
# then uninstall OrbStack if desired; no host network state was modified
```

Nothing outside the container runtime is touched, so rollback is complete by
construction.

## Assessment

The design meets every stated constraint: direct egress is impossible rather
than discouraged, a proxy-ignoring Node process still cannot reach GitHub or
npm, all retrieval paths share one boundary, inference continues to work, no
global config is inherited, and no IP allowlist is used.

Two items remain genuinely unverified until implementation, and neither can be
settled by design alone: **credential isolation** (bypass #12) and **whether
opencode's proxy support covers every internal call path** including its
built-in web tool. Both are gated by the audit above, and either failing means
the design is rejected rather than patched.

RAPTURE_REPRODUCER_VALUE_PROBE_ISOLATION_DESIGN=READY_FOR_IMPLEMENTATION
