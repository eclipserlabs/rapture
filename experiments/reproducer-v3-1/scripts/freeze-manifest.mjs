// Freeze the V3.1 protocol manifest: hashes manifests/V3_1-MANIFEST.json into
// results/manifest.hash. Any later change to a preregistered threshold, gate,
// or decision rule is a protocol violation, not an amendment.
// Usage: node scripts/freeze-manifest.mjs
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const canonical = readFileSync(join(root, "manifests", "V3_1-MANIFEST.json"), "utf8");
const hash = createHash("sha256").update(canonical).digest("hex");
mkdirSync(join(root, "results"), { recursive: true });
writeFileSync(join(root, "results", "manifest.hash"), `${hash}\n`);
console.log(`V3.1 manifest frozen, hash ${hash}`);
