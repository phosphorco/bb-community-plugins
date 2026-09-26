import assert from "node:assert/strict";
import test from "node:test";
import { analyticsSnapshotV1Schema, verifiedIsolationAttestationSchema } from "../../execution-contract.ts";

const artifact = {
  format: "analytics-snapshot-v1",
  snapshotId: "analytics-snapshot_execution_contract_fixture",
  dataset: "tool-execution-v1",
  sourceScope: "analytics-scope_execution_contract",
  generationId: 3,
  sourceGeneration: "source-3",
  factProjectionVersion: 1,
  cursor: "opaque-cursor",
  publishedAtMs: 100,
  rowCount: 1,
  byteCount: 100,
  integrityDigest: "b".repeat(64),
  coverage: { state: "complete", asOfMs: 100, retainedAfterMs: 1, earliestRetainedInclusiveMs: 1, resetWatermark: null, sourceComplete: true, incompleteReasons: [], requestedFastPathDays: 7, fastPathCoverage: "complete", lastFailure: null },
  facts: [{ source_event_id: "event", created_at_ms: 99 }],
};

test("analytics snapshot v1 is data-only and validates bounded content", () => {
  assert.deepEqual(analyticsSnapshotV1Schema.parse(artifact).snapshotId, artifact.snapshotId);
  assert.equal(analyticsSnapshotV1Schema.safeParse({ ...artifact, readonlyDatabasePath: "/host.sqlite" }).success, false);
  assert.equal(analyticsSnapshotV1Schema.safeParse({ ...artifact, rowCount: 2 }).success, false);
});

test("isolation attestation models observed enforced controls, not caller flags", () => {
  const attestation = {
    version: 1, kind: "linux-bubblewrap-cgroup-v2", issuedAtMs: 100, childPid: 42,
    snapshotAccess: "fixed-readonly-mount", hostDatabaseAccess: "denied", hostRpcAccess: "denied",
    networkAccess: "denied", parentExit: "kill-on-parent-exit",
    controllers: { cpu: "enforced", memory: "enforced", pids: "enforced", io: "enforced" },
  };
  assert.equal(verifiedIsolationAttestationSchema.safeParse(attestation).success, true);
  assert.equal(verifiedIsolationAttestationSchema.safeParse({ ...attestation, controls: true }).success, false);
});
