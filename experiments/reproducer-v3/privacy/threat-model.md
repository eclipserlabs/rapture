# V3 Privacy Threat Model (experiment policy — NOT a compliance certification)

## Sensitive classes
Credentials/secrets (hard rule): Authorization headers, Bearer tokens, API
keys, cookies, session IDs, DB passwords, connection strings, private keys,
JWTs, OAuth tokens, payment-like secrets, secret-like env/config values.
PII identifiers (documented handling): email addresses, phone numbers, postal
addresses, user IDs, names, nested PII in JSON, PII in query strings.

## Enforced boundary vs documented gaps (probed 2026-09-08, frozen code)
ENFORCED (gate tier — raw values must never serialize):
- Inbound/outbound header VALUES whose NAME matches
  authorization|cookie|set-cookie|x-api-key|api-key|*token*|*secret*
  (structural, total — any value shape).
- Query-param VALUES whose NAME matches
  token|access_token|api_key|secret|password|signature|auth, plus URL
  userinfo passwords (structural).
- Config/env VALUES whose NAME matches
  secret|password|token|private_key|api_key, or whose value matches a
  provider-key shape (structural).
- Body / pg-param / URL-scanned VALUES matching provider-key shapes:
  sk-|ghp_|github_pat_|xox[baprs]|AKIA followed by 8+ token chars
  (V3 SECRET_VALUE scrub over kernel redaction).
DOCUMENTED GAPS (exploratory tier — reported as findings, never gated;
secret-gated incidents are already outside the supported V3 boundary):
- Arbitrary password VALUES in JSON bodies / DB rows (no name signal).
- JWTs (eyJ…), PEM private keys, card numbers in free-text bodies.
- Base64/otherwise-encoded secrets (shape invisible to value patterns).
- PII emails/phones/names outside name-based locations (retained for
  branch fidelity where the app consumes them; see §PII).
A gap-tier leak is a boundary-mapping finding, not a silent pass: it is
reported, and any headline incident requiring a gap shape is
privacy-blocked, never counted as success.

## Policy
1. **Gate-tier credentials/secrets: raw values are NEVER serialized** into
   any capture or reduced artifact. Any raw gate-tier credential in a
   headline artifact fails the privacy gates outright.
2. **PII identifiers: redacted at trust-boundary locations** (inbound
   headers, cookies, query strings, config) where the value is identity
   metadata rather than branch data. **Retained in DB rows and JSON bodies**
   only where the application branches on the value and exact replay
   requires it; every retained location is documented in attack.json, and
   retained values never leave the local artifact store.
3. **Behaviorally-required secrets**: if exact raw sensitive content proves
   required for replay, the case is classified privacy-blocked (not counted
   as success) unless an equality-preserving deterministic surrogate
   preserves the failure. Raw values are never silently persisted.
4. No claim of GDPR/HIPAA/SOC2 compliance or production readiness is made.

## Attack surface under test (14 classes)
Secrets in: inbound headers, cookies, URL/query params, nested request
JSON, pg query params, nested DB rows, outbound request headers, outbound
request bodies, outbound response headers, outbound response JSON,
secret-like env/config, same secret across multiple boundaries,
substring/embedded secrets, multiple encodings (URL-encoding; base64 noted
as a known partial gap — see results).

## Fixed-point principle (implemented, verified by attack suite)
Replay derives live boundary values from redacted inbound data, so every
normalization must satisfy N(redacted(x)) == N(x): provider-shape scrubbing
is substring-based and idempotent; session-pair values map to deterministic
`[SESS:sha12]` surrogates (structure-preserving, unlike wholesale cookie
redaction, so cookie-derived DB/HTTP keys still match); replay keys are
computed from redacted values on both sides. Whole-value [REDACTED] mapping
was tried for pg params and REJECTED: it is not a fixed point and broke
offline matching. Verified: 0 gate leaks, 7/7 gate captures replay 5/5.

## Surrogate hypothesis (H3)
Equality-preserving deterministic surrogates (same raw → same surrogate
everywhere in the doc, email-shaped to survive validators) should preserve
replay because mocks key on transformed values consistently and the app
propagates inbound surrogates to its outbound calls. Tested at doc level
(scripts/privacy-surrogate.mjs) without touching frozen capture code.
