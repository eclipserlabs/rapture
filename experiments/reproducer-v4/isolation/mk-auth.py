"""Build a MINIMAL opencode auth store for the subject container.

HARD GATE (frozen authorization, credential_isolation):
  - only the credential for the frozen provider may cross into the subject
  - the host's global opencode config (which declares the `jean` MCP server and
    its live token) must never be mounted or copied
  - unrelated provider credentials must not be present

This copies exactly one top-level key out of the host auth store. It never
prints credential material; it prints only key names and byte counts.
"""
import json, os, sys, stat, hashlib

SRC = os.path.expanduser("~/.local/share/opencode/auth.json")
DST = sys.argv[1]
KEEP = sys.argv[2] if len(sys.argv) > 2 else "opencode"

with open(SRC) as fh:
    host = json.load(fh)

if KEEP not in host:
    sys.exit(f"FAIL: frozen provider {KEEP!r} absent from host auth store")

minimal = {KEEP: host[KEEP]}

os.makedirs(os.path.dirname(DST), exist_ok=True)
with open(DST, "w") as fh:
    json.dump(minimal, fh)
os.chmod(DST, stat.S_IRUSR | stat.S_IWUSR)

print("host auth providers present :", sorted(host))
print("copied into subject store   :", sorted(minimal))
print("excluded                    :", sorted(set(host) - set(minimal)))
print("subject auth.json bytes     :", os.path.getsize(DST))
print("subject auth.json sha256    :", hashlib.sha256(open(DST,'rb').read()).hexdigest())
