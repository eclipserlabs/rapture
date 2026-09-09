// Freeze V3 protocol manifest: writes manifests/V3-MANIFEST.json hash to
// results/manifest.hash. Any later headline-threshold change is a protocol
// violation, not an amendment.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const canonical = readFileSync(join(root, "manifests", "V3-MANIFEST.json"), "utf8");
const hash = createHash("sha256").update(canonical).digest("hex");
mkdirSync(join(root, "results"), { recursive: true });
writeFileSync(join(root, "results", "manifest.hash"), `${hash}\n`);
console.log(`V3 manifest frozen, hash ${hash}`);
