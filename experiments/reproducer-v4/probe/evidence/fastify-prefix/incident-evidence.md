# Incident INC-90C0F66C84D7

**Service** `svc-fastify-api` · release `rel-9fb69c8a3833` · fastify on node v22.14.0

## Failure

`GET /api/v1/orders` returned **HTTP 500** in 57 ms.

Request target was supplied in origin-form request target.

```json
{"error":"nested prefix joined incorrectly","code":"E_PREFIX_JOIN","url":"/api/v1/orders"}
```

Normalized error code: `E_PREFIX_JOIN` — nested prefix joined incorrectly

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
- release: rel-9fb69c8a3833
