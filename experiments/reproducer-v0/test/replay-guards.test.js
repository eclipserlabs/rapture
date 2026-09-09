// Live-effect refusal tests.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReplayContext } from "../src/replay.js";
import { LiveEffectError } from "../src/fingerprint.js";

function makeCtx() {
  return new ReplayContext({
    mode: "replay",
    script: new Map(),
    retainedEvents: new Map(),
    config: {},
    db: new Map(),
    tempDir: mkdtempSync(join(tmpdir(), "repro-guard-")),
    counters: { liveEffectAttempts: 0 },
  });
}

describe("replay guards", () => {
  it("refuses live network", () => {
    const ctx = makeCtx();
    assert.throws(() => ctx.liveFetch("https://api.example.com/charge", {}), LiveEffectError);
    assert.equal(ctx.counters.liveEffectAttempts, 1);
  });

  it("refuses filesystem writes outside the experiment temp directory", () => {
    const ctx = makeCtx();
    assert.throws(() => ctx.guardedWrite("/etc/production.conf"), LiveEffectError);
    assert.throws(() => ctx.guardedWrite("/tmp/somewhere-else.txt"), LiveEffectError);
    assert.equal(ctx.counters.liveEffectAttempts, 2);
    // Writes inside the temp dir resolve without throwing.
    const inside = ctx.guardedWrite(join(ctx.tempDir, "out.json"));
    assert.ok(inside.startsWith(ctx.tempDir));
    assert.equal(ctx.counters.liveEffectAttempts, 2);
  });
});
