#!/usr/bin/env bash
# Full rollback. No host network state was modified outside the Colima VM.
set -uo pipefail
BR="br-$(docker network inspect v4-subject-net --format '{{.Id}}' 2>/dev/null | cut -c1-12)"
[ "$BR" != "br-" ] && colima ssh -- sudo iptables -D INPUT -i "$BR" -j DROP 2>/dev/null
docker rm -f v4-subject v4-control v4-proxy 2>/dev/null
docker network rm v4-subject-net v4-egress-net 2>/dev/null
echo "topology removed; images and the colima VM are left in place"
