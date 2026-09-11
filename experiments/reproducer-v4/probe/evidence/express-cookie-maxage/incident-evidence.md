# Incident INC-29B5FCFDA116

**Service** `svc-express-api` · release `rel-817f98228fbe` · express on node v22.14.0

## Failure

`GET /session` returned **HTTP 500** in 46 ms.

Request target was supplied in origin-form request target.

```json
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Error</title>
</head>
<body>
<pre>TypeError: option maxAge is invalid<br> &nbsp; &nbsp;at Object.serialize (/work/repo/node_modules/cookie/index.js:125:13)<br> &nbsp; &nbsp;at res.cookie (/work/repo/lib/response.js:880:36)<br> &nbsp; &nbsp;at file:///work/app/server.mjs:9:7<br> &nbsp; &nbsp;at Layer.handle [as handle_request] (/work/repo/lib/router/layer.js:95:5)<br> &nbsp; &nbsp;at next (/work/repo/lib/router/route.js:137:13)<br> &nbsp; &nbsp;at Route.dispatch (/work/repo/lib/router/route.js:112:3)<br> &nbsp; &nbsp;at Layer.handle [as handle_request] (/work/repo/lib/router/layer.js:95:5)<br> &nbsp; &nbsp;at /work/repo/lib/router/index.js:280:22<br> &nbsp; &nbsp;at Function.process_params (/work/repo/lib/router/index.js:340:12)<br> &nbsp; &nbsp;at next (/work/repo/lib/router/index.js:274:10)</pre>
</body>
</html>

```

Normalized error code: `none`

## Application errors observed

- `TypeError`: option maxAge is invalid

```
TypeError: option maxAge is invalid
    at Object.serialize (/work/repo/node_modules/cookie/index.js:125:13)
    at res.cookie (/work/repo/lib/response.js:880:36)
    at file:///work/app/server.mjs:9:7
    at Layer.handle [as handle_request] (/work/repo/lib/router/layer.js:95:5)
    at next (/work/repo/lib/router/route.js:137:13)
    at Route.dispatch (/work/repo/lib/router/route.js:112:3)
    at Layer.handle [as handle_request] (/work/repo/lib/router/layer.js:95:5)
    at /work/repo/lib/router/index.js:280:22
    at Function.process_params (/work/repo/lib/router/index.js:340:12)
    at next (/work/repo/lib/router/index.js:274:10)
```

## Operation timeline

| # | kind | operation | status | ms |
|---|---|---|---|---|


Database result rows and outbound response bodies are not retained by the
observability pipeline.

## Logs

- `info` READY
- `error` TypeError: option maxAge is invalid
    at Object.serialize (/work/repo/node_modules/cookie/index.js:125:13)
    at res.cookie (/work/repo/lib/response.js:880:36)
    at file:///work/app/server.mjs:9:7
    at Layer.handle [as handle_request] (/work/repo/lib/router/layer.js:95:5)
    at next (/work/repo/lib/router/route.js:137:13)
    at Route.dispatch (/work/repo/lib/router/route.js:112:3)
    at Layer.handle [as handle_request] (/work/repo/lib/router/layer.js:95:5)
    at /work/repo/lib/router/index.js:280:22
    at Function.process_params (/work/repo/lib/router/index.js:340:12)
    at next (/work/repo/lib/router/index.js:274:10)

## Environment

- runtime: node v22.14.0
- framework: express
- platform: darwin
- release: rel-817f98228fbe
