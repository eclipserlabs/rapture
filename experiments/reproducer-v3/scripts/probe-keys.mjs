import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildReplayQueues, consumeReplayEvent } from "../src/capture/events.mjs";
import { eventKey } from "../src/capture/events.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const doc = JSON.parse(readFileSync(join(root, "results", "privacy", "surrogate-db.json"), "utf8"));
for (const e of doc.events) console.log("stored:", e.seq, e.kind, e.key.slice(0, 100));
const q = buildReplayQueues(doc);
// Live values the replaying app derives from the transformed inbound request:
const surrogates = [...new Set((JSON.stringify(doc).match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? []))];
console.log("emails in transformed doc:", surrogates);
const liveId = surrogates[0];
const tries = [
  ["pg", eventKey("pg", { text: "SELECT id, profile FROM v3priv_users WHERE id = $1", values: [liveId] }, 0)],
  ["http", eventKey("http", { method: "GET", url: "http://localhost:47129/secret-profile", body: null }, 0)],
];
for (const [kind, key] of tries) {
  console.log("live key:", key.slice(0, 100));
  try {
    consumeReplayEvent(q, kind, key);
    console.log("  consumed OK");
  } catch (e) {
    console.log("  CONSUME FAIL:", e.message.slice(0, 200));
  }
}
