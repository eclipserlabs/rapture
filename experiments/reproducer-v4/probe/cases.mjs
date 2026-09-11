// Calibration case table.
//
// Both cases are V3 headline bugs on the frozen V4 excluded_prior_bugs list and
// are therefore PERMANENTLY ineligible for the five-case value probe. Neither
// can ever enter the probe corpus, so nothing learned here can tune it.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const REPO = join(here, "..", "..", "..");
export const V3H = join(REPO, "experiments", "reproducer-v3", "headline");
export const CORPUS = join(REPO, ".rapture", "reproducer-v3", "corpus-hl");
export const ARTIFACTS = join(REPO, "experiments", "reproducer-v3-3", "results", "regression-8", "artifacts");
export const PG_ENTRY = join(REPO, "experiments", "reproducer-v2", "node_modules", "pg", "lib", "index.js");

export const CALIBRATION_CASES = [
  {
    id: "koa-1998",
    repository: "koajs/koa",
    stack: "koa",
    service: "koa-1998.mjs",
    port: 47902,
    buggy: "koa-4a191b1",
    fixed: "koa-1061776",
    code: "E_ASSERT_REGRESSION",
    route: "GET /admin",
    // Original incident trigger, exactly as V3 fired it.
    trigger: { kind: "fetch", path: "/admin" },
    // Hidden generalization variants: same root cause, DIFFERENT concrete
    // values. A patch that special-cases the exposed incident fails these.
    hidden_variants: [
      { name: "assert-403-different-message", path: "/hidden-a", expect_status: 403 },
      { name: "assert-402-different-message", path: "/hidden-b", expect_status: 402 },
    ],
    regression_command: ["node", "--test"],
  },
  {
    id: "koa-1999",
    repository: "koajs/koa",
    stack: "koa",
    service: "koa-1999.mjs",
    port: 47901,
    buggy: "koa-1061776",
    fixed: "koa-571938d",
    code: "E_URL_MISMATCH",
    route: "GET http://example.com/u",
    trigger: { kind: "raw-absolute", path: "http://example.com/u?q=1" },
    hidden_variants: [
      { name: "absolute-form-different-authority", path: "http://svc.internal:8080/u?q=9", expect_host: "svc.internal:8080" },
      { name: "absolute-form-https-scheme", path: "https://other.example/u?q=2", expect_host: "other.example" },
    ],
    regression_command: ["node", "--test"],
  },
];

export const byId = (id) => {
  const c = CALIBRATION_CASES.find((x) => x.id === id);
  if (!c) throw new Error(`unknown calibration case ${id}`);
  return c;
};
