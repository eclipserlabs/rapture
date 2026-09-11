#!/usr/bin/env bash
# Bring up the V4 value-probe isolation topology.
# Structural property being created: the subject's only network has no gateway,
# therefore no route off-host, independent of what the subject runs.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"

SUBJECT_NET=v4-subject-net
EGRESS_NET=v4-egress-net
PROXY=v4-proxy
PROXY_IP=10.83.0.10
SQUID_IMAGE=${SQUID_IMAGE:-ubuntu/squid:5.2-22.04_beta}

docker network inspect "$SUBJECT_NET" >/dev/null 2>&1 || \
  docker network create --internal --subnet 10.83.0.0/24 "$SUBJECT_NET"
docker network inspect "$EGRESS_NET" >/dev/null 2>&1 || \
  docker network create "$EGRESS_NET"

# Idempotent: a healthy proxy is reused so its access log -- the network-attempt
# audit trail -- survives across runs instead of being reset by every preflight.
if [ "$(docker inspect -f '{{.State.Running}}' "$PROXY" 2>/dev/null)" = "true" ]; then
  echo "proxy already running; reusing (access log preserved)"
else
docker rm -f "$PROXY" >/dev/null 2>&1 || true
docker run -d --name "$PROXY" \
  --network "$SUBJECT_NET" --ip "$PROXY_IP" \
  -v "$HERE/squid.conf:/etc/squid/squid.conf:ro" \
  "$SQUID_IMAGE"

# Second leg. The proxy is the ONLY container with an interface on both sides.
docker network connect "$EGRESS_NET" "$PROXY"
fi

# Hardening found necessary by the audit: the VM's own sshd listens on the
# bridge IP and was reachable from the subject container (a pivot to a host with
# full internet). Container-to-container traffic on this bridge does not
# traverse INPUT, so dropping it does not affect subject -> proxy.
BR="br-$(docker network inspect "$SUBJECT_NET" --format '{{.Id}}' | cut -c1-12)"
colima ssh -- sudo iptables -C INPUT -i "$BR" -j DROP 2>/dev/null ||   colima ssh -- sudo iptables -I INPUT -i "$BR" -j DROP
echo "subject bridge $BR: host-directed traffic dropped"

echo "waiting for squid to accept connections..."
for i in $(seq 1 30); do
  if docker logs "$PROXY" 2>&1 | grep -q 'listening port: 3128'; then
    echo "squid up after ${i}s"; break
  fi
  sleep 1
done
docker ps --filter "name=$PROXY" --format '{{.Names}}\t{{.Status}}\t{{.Image}}'
