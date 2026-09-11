# Incident INC-0C8322371253

**Service** `svc-fastify-api` · release `rel-1242405b8eea` · fastify on node v22.14.0

## Failure

`GET /callback-url` returned **HTTP 500** in 55 ms.

Request target was supplied in origin-form request target.

```json
{"error":"derived port disagrees with host","code":"E_PORT_DERIVATION","host":"api.example.com:8443","port":"49700"}
```

Normalized error code: `E_PORT_DERIVATION` — derived port disagrees with host

## Application errors observed

_the application handled this error internally; no unhandled stack was exposed to the error tracker_

## Operation timeline

| # | kind | operation | status | ms |
|---|---|---|---|---|


Database result rows and outbound response bodies are not retained by the
observability pipeline.

## Logs

- `info` READY

## Environment

- runtime: node v22.14.0
- framework: fastify
- platform: darwin
- release: rel-1242405b8eea
