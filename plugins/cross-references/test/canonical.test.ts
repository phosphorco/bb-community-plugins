import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalizeIdentity,
  canonicalizeResource,
  CrossReferenceValidationError,
  machineMonitorIdentity,
  machineMonitorResource,
  projectIdentity,
  projectResource,
  projectionPayloadDigest,
  projectionPayloadJson,
  sha256Hex,
  threadIdentity,
  threadResource,
  type Resource,
} from "../canonical.ts";
import { normalizeProjectionCommand } from "../model.ts";

const source: Resource = {
  provider: "bb",
  keys: { thread: "thr_23456789ab", project: "proj_23456789ab" },
  presentation: {
    label: "  Fix thread  ",
    detail: "Project context",
    url: "/threads/thr_23456789ab",
  },
};

const target: Resource = {
  provider: "bb",
  keys: { thread: "thr_23456789ab", project: "proj_23456789ab" },
  presentation: { label: "Thread" },
};

const mutationId = "00000000-0000-4000-8000-000000000001";

function command(overrides: Partial<{
  source: Resource;
  targets: Resource[];
  revision: number;
  expectedRevision: number;
  tombstone: boolean;
}> = {}) {
  const input = {
    protocolVersion: 1 as const,
    producerPluginId: "machine-monitor",
    mutationId,
    source: overrides.source ?? source,
    revision: overrides.revision ?? 1,
    expectedRevision: overrides.expectedRevision ?? 0,
    tombstone: overrides.tombstone ?? false,
    targets: overrides.targets ?? [target],
  };
  const canonicalSource = canonicalizeResource(input.source);
  const canonicalTargets = input.targets.map(canonicalizeResource);
  return {
    ...input,
    payloadDigest: projectionPayloadDigest(
      input.producerPluginId,
      canonicalSource,
      input.tombstone,
      canonicalTargets,
    ),
  };
}

test("canonicalizes sorted identities, NFC values, and fixed presentation JSON", () => {
  const resource = canonicalizeResource({
    provider: "test",
    keys: { z: "e\u0301", a: "  kept at edges  " },
    presentation: { label: "Label", url: "https://example.test/a" },
  });

  assert.deepEqual(resource.keys, { a: "  kept at edges  ", z: "é" });
  assert.equal(resource.canonicalKeysJson, '{"a":"  kept at edges  ","z":"é"}');
  assert.equal(
    resource.canonicalIdentityJson,
    '{"provider":"test","keys":{"a":"  kept at edges  ","z":"é"}}',
  );
  assert.equal(resource.identityDigest, sha256Hex(resource.canonicalIdentityJson));
  assert.equal(resource.presentationJson, '{"label":"Label","url":"https://example.test/a"}');
  assert.equal(canonicalizeIdentity({ provider: "test", keys: { z: "e\u0301", a: "  kept at edges  " } }).identityDigest, resource.identityDigest);
});

test("keeps exact identity independent from presentation", () => {
  const first = canonicalizeResource({ ...target, presentation: { label: "Before" } });
  const second = canonicalizeResource({ ...target, presentation: { label: "After", detail: "new" } });
  assert.equal(first.identityDigest, second.identityDigest);
  assert.equal(first.canonicalIdentityJson, second.canonicalIdentityJson);
  assert.notEqual(first.presentationJson, second.presentationJson);
});

test("publishes exact BB project, thread, and Machine Monitor conventions", () => {
  const project = canonicalizeResource(projectResource("proj_12345678", { label: "Project" }));
  const thread = canonicalizeResource(threadResource("proj_12345678", "thr_12345678", { label: "Thread" }));
  const monitor = canonicalizeResource(machineMonitorResource());
  assert.notEqual(project.identityDigest, thread.identityDigest);
  assert.notEqual(project.identityDigest, monitor.identityDigest);
  assert.notEqual(thread.identityDigest, monitor.identityDigest);
  assert.deepEqual(projectIdentity("proj_12345678"), { provider: "bb", keys: { project: "proj_12345678" } });
  assert.deepEqual(threadIdentity("proj_12345678", "thr_12345678"), {
    provider: "bb",
    keys: { project: "proj_12345678", thread: "thr_12345678" },
  });
  assert.deepEqual(machineMonitorIdentity(), { provider: "bb", keys: { page: "machine-monitor", plugin: "machine-monitor" } });
  assert.equal(monitor.presentation.url, "/plugins/machine-monitor/machine-monitor");
});

test("rejects malformed, unsafe, and unbounded canonical data", () => {
  const invalid = (resource: Resource) => assert.throws(
    () => canonicalizeResource(resource),
    (error: unknown) => error instanceof CrossReferenceValidationError,
  );

  invalid({ ...target, provider: "BB" });
  invalid({ ...target, keys: { ...target.keys, bad: "\u0000" } });
  invalid({ ...target, keys: { only: "   " } });
  invalid({ ...target, presentation: { label: "" } });
  invalid({ ...target, presentation: { label: "Target", url: "javascript:alert(1)" } });
  invalid({ ...target, presentation: { label: "x".repeat(257) } });
  invalid({ ...target, keys: { thread: "x".repeat(513) } });
  invalid({ ...target, keys: { project: "proj with space" } });
  invalid({ ...target, keys: { page: "other", plugin: "machine-monitor" } });
});

test("normalizes a complete projection before persistence and binds its digest", () => {
  const normalized = normalizeProjectionCommand(command());
  assert.equal(normalized.payloadJson, projectionPayloadJson(
    "machine-monitor",
    normalized.source,
    false,
    normalized.targets,
  ));
  assert.equal(normalized.payloadDigest, normalized.computedPayloadDigest);
  assert.throws(
    () => normalizeProjectionCommand({ ...command(), payloadDigest: "0".repeat(64) }),
    CrossReferenceValidationError,
  );
  assert.throws(
    () => normalizeProjectionCommand({ ...command({ tombstone: true }), targets: [target] }),
    CrossReferenceValidationError,
  );
  assert.throws(
    () => normalizeProjectionCommand({ ...command(), targets: [target, target] }),
    CrossReferenceValidationError,
  );
});
