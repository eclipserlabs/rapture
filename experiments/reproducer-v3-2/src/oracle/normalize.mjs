// Normalization for FailureFingerprintV2. Removes volatile values while
// never touching application error identity (names, codes, routes, status).
const ISO_TS = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?/gu;
const EPOCH_MS = /\b(1[0-9]{12}|[2-9][0-9]{12})\b/gu;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/giu;
const LONG_HEX = /\b[0-9a-f]{16,}\b/giu;
const REQ_ID = /\b(req|request)[-_]?[Ii]d\b/gu;
const TMP_PATH = /(?:\/private)?\/(?:tmp|var\/folders)\/[^\s"'`,;)]*/gu;
const STACK_OFFSET = /:\d+:\d+(?=[)\s]|$)/gu;

export function normalizeVolatile(value) {
  if (typeof value !== "string") return value;
  return value
    .replace(ISO_TS, "<TS>")
    .replace(UUID, "<ID>")
    .replace(EPOCH_MS, "<TS>")
    .replace(TMP_PATH, "<TMP>")
    .replace(REQ_ID, "req-id")
    .replace(LONG_HEX, "<ID>");
}

export function normalizeStackLineOffsets(stack) {
  if (typeof stack !== "string") return stack;
  return normalizeVolatile(stack).replace(STACK_OFFSET, "");
}

/** First stack frame outside node internals / capture runtime. */
export function stableAppFrame(stack) {
  if (typeof stack !== "string") return null;
  for (const line of stack.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("at ")) continue;
    if (/node:(internal|async_hooks)/.test(t)) continue;
    if (/reproducer-v2\/src\/capture\//.test(t)) continue;
    if (/node_modules\/(pg|undici)\//.test(t)) continue;
    return normalizeStackLineOffsets(t.replace(/^at\s+/, ""));
  }
  return null;
}
