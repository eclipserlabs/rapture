# Incident INC-4243383C84C1

**Service** `svc-express-api` · release `rel-b88e720b742d` · express on node v22.14.0

## Failure

`GET /lookup` returned **HTTP 500** in 44 ms.

Request target was supplied in origin-form request target.

```json
{"error":"jsonp serialization failed","code":"E_JSONP_UNDEFINED","detail":"Cannot read properties of undefined (reading 'replace')"}
```

Normalized error code: `E_JSONP_UNDEFINED` — jsonp serialization failed

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
- framework: express
- platform: darwin
- release: rel-b88e720b742d
