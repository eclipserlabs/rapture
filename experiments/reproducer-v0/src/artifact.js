// Portable reproducer artifact for reproducer-v0.
import { canonicalBytes, deepClone, hashJson } from "./canonical.js";

export const ARTIFACT_SCHEMA_VERSION = 1;

/**
 * Build a self-contained ReproducerArtifact from a reduced keep-set.
 * Contains everything replay needs: input, required events (in original
 * sequence), required db rows, required config, expected fingerprint.
 * Never references absolute paths or the original capture file.
 */
export function buildArtifact({ scenarioId, codeVersion, sourceCaptureHash, candidate, expectedFingerprint }) {
  const artifact = {
    schema_version: ARTIFACT_SCHEMA_VERSION,
    scenario_id: scenarioId,
    code_version: codeVersion,
    source_capture_hash: sourceCaptureHash,
    input: deepClone(candidate.input),
    required_boundary_events: deepClone(candidate.events),
    required_db_rows: [...candidate.db.entries()].map(([k, v]) => {
      const sep = k.indexOf(":");
      return { table: k.slice(0, sep), key: k.slice(sep + 1), value: deepClone(v) };
    }),
    required_config: deepClone(candidate.config),
    expected_failure_fingerprint: deepClone(expectedFingerprint),
  };
  artifact.artifact_hash = hashJson(stripArtifactHash(artifact));
  return artifact;
}

function stripArtifactHash(artifact) {
  const { artifact_hash, ...rest } = artifact;
  return rest;
}

export function verifyArtifactHash(artifact) {
  return hashJson(stripArtifactHash(artifact)) === artifact.artifact_hash;
}

export function artifactBytes(artifact) {
  return canonicalBytes(stripArtifactHash(artifact));
}

/** Rebuild a replay candidate purely from the artifact (no capture file). */
export function candidateFromArtifact(artifact) {
  const db = new Map(artifact.required_db_rows.map((r) => [`${r.table}:${r.key}`, r.value]));
  return {
    input: deepClone(artifact.input),
    config: deepClone(artifact.required_config),
    db,
    events: deepClone(artifact.required_boundary_events),
  };
}
