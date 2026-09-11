# Incident INC-FA433171A26D

**Service** `svc-hapi-api` · release `rel-8ec8c3501215` · hapi on node v22.14.0

## Failure

`POST /orders` returned **HTTP 500** in 54 ms.

Request target was supplied in origin-form request target.

```json
{"error":"default validation error unavailable","code":"E_NO_DEFAULT_ERROR"}
```

Normalized error code: `E_NO_DEFAULT_ERROR` — default validation error unavailable

## Application errors observed

- `Error`: "qty" must be greater than or equal to 1

```
ValidationError: "qty" must be greater than or equal to 1
    at exports.process (/work/repo/node_modules/@hapi/validate/lib/errors.js:165:29)
    at internals.entry (/work/repo/node_modules/@hapi/validate/lib/validator.js:49:26)
    at exports.entry (/work/repo/node_modules/@hapi/validate/lib/validator.js:23:30)
    at internals.Base.validate (/work/repo/node_modules/@hapi/validate/lib/base.js:307:26)
    at internals.Base.validateAsync (/work/repo/node_modules/@hapi/validate/lib/base.js:312:29)
    at internals.validate (/work/repo/lib/validation.js:246:23)
    at internals.input (/work/repo/lib/validation.js:129:69)
    at exports.payload (/work/repo/lib/validation.js:89:22)
    at Request._lifecycle (/work/repo/lib/request.js:370:68)
    at process.processTicksAndRejections (node:internal/process/task_queues:105:5)
```

- `exports`: Invalid request payload input

```
Error: Invalid request payload input
    at new exports.Boom (/work/repo/node_modules/@hapi/boom/lib/index.js:78:23)
    at exports.badRequest (/work/repo/node_modules/@hapi/boom/lib/index.js:143:12)
    at internals.input (/work/repo/lib/validation.js:148:74)
    at exports.payload (/work/repo/lib/validation.js:89:22)
    at Request._lifecycle (/work/repo/lib/request.js:370:68)
    at process.processTicksAndRejections (node:internal/process/task_queues:105:5)
    at async Request._execute (/work/repo/lib/request.js:280:9)
```

## Operation timeline

| # | kind | operation | status | ms |
|---|---|---|---|---|


Database result rows and outbound response bodies are not retained by the
observability pipeline.

## Logs

- `info` READY

## Environment

- runtime: node v22.14.0
- framework: hapi
- platform: darwin
- release: rel-8ec8c3501215
