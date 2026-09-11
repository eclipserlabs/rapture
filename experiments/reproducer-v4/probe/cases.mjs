// Case tables for the V4 value probe.
//
//  * CALIBRATION_CASES  -- V3 headline bugs on the frozen excluded_prior_bugs
//    list. Permanently ineligible for the probe; harness validation only.
//  * PROBE_CASES        -- the five preregistered value-probe cases, exactly as
//    frozen in V4-PROBE-MANIFEST.json. Not editable after headline run 1.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const REPO = join(here, "..", "..", "..");
export const V3H = join(REPO, "experiments", "reproducer-v3", "headline");
export const CORPUS = join(REPO, ".rapture", "reproducer-v3", "corpus-hl");
export const ARTIFACTS = join(REPO, "experiments", "reproducer-v3-3", "results", "regression-8", "artifacts");
export const PG_ENTRY = join(REPO, "experiments", "reproducer-v2", "node_modules", "pg", "lib", "index.js");
const V4WORK = join(REPO, ".rapture", "reproducer-v4", "work");
const V4SVC = join(REPO, "experiments", "reproducer-v4", "services");
const PROBE_ARTIFACTS = join(here, "artifacts");
const HIDDEN = join(here, "hidden");

// ---------------------------------------------------------------------------
// Calibration (V3 stack: real pg + outbound HTTP boundaries)
// ---------------------------------------------------------------------------
export const CALIBRATION_CASES = [
  {
    kind: "calibration", id: "koa-1998", repository: "koajs/koa", stack: "koa",
    serviceEntry: join(V3H, "services", "koa-1998.mjs"),
    sharedEntry: join(V3H, "services", "shared.mjs"),
    buggyRoot: join(CORPUS, "koa-4a191b1"), fixedRoot: join(CORPUS, "koa-1061776"),
    fixSha: "1061776", issue: "#1998",
    artifact: join(ARTIFACTS, "koa-1998.json"),
    needsPgAndExternal: true,
    route: "GET /admin", code: "E_ASSERT_REGRESSION",
    trigger: { method: "GET", path: "/admin" },
    originalFailure: { kind: "code", code: "E_ASSERT_REGRESSION" },
    hiddenEntry: join(HIDDEN, "koa-1998-hidden.mjs"),
    hidden: [
      { name: "assert-403-different-message", method: "GET", path: "/hidden-a", expect_status: 403 },
      { name: "assert-402-different-message", method: "GET", path: "/hidden-b", expect_status: 402 },
    ],
    regressionStack: null, regressionCommand: ["node", "--test"],
  },
  {
    kind: "calibration", id: "koa-1999", repository: "koajs/koa", stack: "koa",
    serviceEntry: join(V3H, "services", "koa-1999.mjs"),
    sharedEntry: join(V3H, "services", "shared.mjs"),
    buggyRoot: join(CORPUS, "koa-1061776"), fixedRoot: join(CORPUS, "koa-571938d"),
    fixSha: "571938d", issue: "#1999",
    artifact: join(ARTIFACTS, "koa-1999.json"),
    needsPgAndExternal: true,
    route: "GET http://example.com/u", code: "E_URL_MISMATCH",
    trigger: { method: "GET", absolute: "http://example.com/u?q=1" },
    originalFailure: { kind: "code", code: "E_URL_MISMATCH" },
    hiddenEntry: join(HIDDEN, "koa-1999-hidden.mjs"),
    hidden: [
      { name: "absolute-form-different-authority", absolute: "http://svc.internal:8080/u?q=9",
        headers: { "x-expect-host": "svc.internal:8080" }, expect_status: 200 },
      { name: "absolute-form-https-scheme", absolute: "https://other.example/u?q=2",
        headers: { "x-expect-host": "other.example" }, expect_status: 200 },
    ],
    regressionStack: null, regressionCommand: ["node", "--test"],
  },
];

// ---------------------------------------------------------------------------
// The five frozen probe cases
// ---------------------------------------------------------------------------
const probe = (id, o) => ({
  kind: "probe", id,
  buggyRoot: join(V4WORK, `${id}-buggy`), fixedRoot: join(V4WORK, `${id}-fixed`),
  serviceEntry: join(V4SVC, o.service), sharedEntry: null, needsPgAndExternal: false,
  artifact: join(PROBE_ARTIFACTS, `${id}.json`),
  hiddenEntry: join(HIDDEN, `${id}-hidden.mjs`),
  ...o,
});

export const PROBE_CASES = [
  probe("express-cookie-maxage", {
    fixSha: "58553394", issue: null,
    repository: "expressjs/express", stack: "express", service: "express-cookie-maxage.mjs",
    routeKey: "GET /session", route: "GET /session", code: "E_COOKIE_INVALID_DATE",
    trigger: { method: "GET", path: "/session" },
    // The buggy revision throws inside res.cookie before the service invariant
    // is reached, so the observable original failure is the 500 itself.
    originalFailure: { kind: "status", status: 500 },
    hidden: [
      { name: "cookie-token-undefined-maxage-different-path", method: "GET", path: "/hv-a", expect_status: 200 },
      { name: "cookie-pref-null-maxage-samesite", method: "GET", path: "/hv-b", expect_status: 200 },
    ],
    regressionStack: "express",
  }),
  probe("express-jsonp", {
    fixSha: "9dd0e7af", issue: null,
    repository: "expressjs/express", stack: "express", service: "express-jsonp.mjs",
    routeKey: "GET /lookup", route: "GET /lookup", code: "E_JSONP_UNDEFINED",
    trigger: { method: "GET", path: "/lookup?id=missing&cb=render" },
    originalFailure: { kind: "code", code: "E_JSONP_UNDEFINED" },
    hidden: [
      { name: "jsonp-undefined-different-callback-name", method: "GET", path: "/hv-a?render2=showA", expect_status: 200 },
      { name: "jsonp-undefined-default-callback-name", method: "GET", path: "/hv-b?callback=showB", expect_status: 200 },
    ],
    regressionStack: "express",
  }),
  probe("fastify-prefix", {
    fixSha: "2f597a92", issue: "#6803",
    repository: "fastify/fastify", stack: "fastify", service: "fastify-prefix.mjs",
    routeKey: "GET /api/v1/orders", route: "GET /api/v1/orders", code: "E_PREFIX_JOIN",
    trigger: { method: "GET", path: "/api/v1/orders" },
    originalFailure: { kind: "code", code: "E_PREFIX_JOIN" },
    hidden: [
      { name: "nested-prefix-svc-v2", method: "GET", path: "/svc/v2/items", expect_status: 200 },
      { name: "nested-prefix-z-w-no-leading-slash", method: "GET", path: "/z/w/thing", expect_status: 200 },
    ],
    regressionStack: "fastify",
  }),
  probe("fastify-port", {
    fixSha: "6ac2e953", issue: "#6680",
    repository: "fastify/fastify", stack: "fastify", service: "fastify-port.mjs",
    routeKey: "GET /callback-url", route: "GET /callback-url", code: "E_PORT_DERIVATION",
    trigger: { method: "GET", path: "/callback-url", headers: { "x-forwarded-host": "api.example.com:8443" } },
    originalFailure: { kind: "code", code: "E_PORT_DERIVATION" },
    hidden: [
      { name: "forwarded-host-edge-9443", method: "GET", path: "/hv-a",
        headers: { "x-forwarded-host": "edge.example.org:9443" }, expect_status: 200 },
      { name: "forwarded-host-internal-7000", method: "GET", path: "/hv-b",
        headers: { "x-forwarded-host": "svc.internal:7000" }, expect_status: 200 },
    ],
    regressionStack: "fastify",
  }),
  probe("hapi-failaction", {
    fixSha: "619380ab", issue: "#4350",
    repository: "hapijs/hapi", stack: "hapi", service: "hapi-failaction.mjs",
    routeKey: "POST /orders", route: "POST /orders", code: "E_NO_DEFAULT_ERROR",
    trigger: { method: "POST", path: "/orders", headers: { "content-type": "application/json" },
               body: JSON.stringify({ qty: 0 }) },
    originalFailure: { kind: "code", code: "E_NO_DEFAULT_ERROR" },
    hidden: [
      { name: "put-payload-string-min-length", method: "PUT", path: "/hv-a",
        headers: { "content-type": "application/json" }, body: JSON.stringify({ label: "short" }),
        expect_status: 200 },
      { name: "get-query-integer-min", method: "GET", path: "/hv-b?page=0", expect_status: 200 },
    ],
    regressionStack: "hapi",
  }),
];

export const ALL_CASES = [...CALIBRATION_CASES, ...PROBE_CASES];
export const byId = (id) => {
  const c = ALL_CASES.find((x) => x.id === id);
  if (!c) throw new Error(`unknown case ${id}`);
  return c;
};
