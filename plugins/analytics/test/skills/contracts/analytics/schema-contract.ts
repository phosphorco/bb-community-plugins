import assert from "node:assert/strict";
import { skillObservationSchema } from "../../../../../../../fork/upstream/packages/domain/src/skill-observation.ts";
import {
  deterministicSkillFactId,
  reconcileMeasurementRows,
  summarizeActivation,
  summarizeMeasuredValues,
  type LifecycleObservationFact,
  type SkillMeasurementFact,
} from "../../../../skill-observation-contract.ts";
import { skillCoverageEpochFactSchema, skillLifecycleObservationFactSchema, skillMeasurementFactSchema } from "../../../../skill-fact-schema.ts";

const revision = "a".repeat(64);
const observationId = `skillobs_v1_${"b".repeat(64)}`;
const runtimeObservation = {
  schemaVersion: 1, observationId, dedupeKey: `skillobs_dedupe_v1_${"c".repeat(64)}`,
  evidenceKind: "named-token-measurement", status: "supported", captureTrigger: "provider-context-report",
  actor: { actorId: "actor-1", principalId: "principal-1", kind: "user" }, threadId: "thread-1", providerThreadId: "provider-thread-1", providerSessionId: "session-1",
  providerId: "claude-code", providerModel: "claude", providerTurnId: null, providerEventId: "event-1", catalogRevision: revision,
  skill: { skillId: "skill-1", name: "release-notes", skillMarkdownPath: "/repo/skills/release-notes/SKILL.md", sourceKind: "project", sourceId: "project-1", pluginId: null, catalogRevision: revision, skillMarkdownRevision: revision, treeRevision: revision },
  measurement: { method: "provider-reported-named-context-estimate", serializer: "ClaudeContextUsageCollector skills.skillFrontmatter", tokenizer: "provider-undisclosed", estimated: true, attribution: "per-skill", bytes: null, tokens: 22 },
  failure: null, rawProviderMetadata: { name: "release-notes" },
};
assert.equal(skillObservationSchema.safeParse(runtimeObservation).success, true, "real SkillObservation v1 remains the source boundary");

const revisionIdentity = runtimeObservation.skill!;
const activeBase = {
  observationId, sourceEventId: "source-1", coverageEpochId: "epoch-1", observedAtMs: 100, sessionId: "session-1", threadId: "thread-1", providerTurnId: null,
  projectId: "project-1", environmentId: "environment-1",
  principalId: "principal-1", providerId: "claude-code", providerModel: "claude", revision: revisionIdentity, status: "supported" as const,
  activationObservability: "observed" as const, captureTrigger: "active-staging", providerEventId: "event-1", failure: null,
};
const active: LifecycleObservationFact = { ...activeBase, evidenceKind: "active-staged", factId: deterministicSkillFactId("lifecycle", { ...activeBase, evidenceKind: "active-staged" }) };
assert.equal(skillLifecycleObservationFactSchema.safeParse(active).success, true);
const activated: LifecycleObservationFact = { ...activeBase, observationId: `skillobs_v1_${"d".repeat(64)}`, observedAtMs: 110, evidenceKind: "activated", captureTrigger: "provider-native-event", factId: deterministicSkillFactId("lifecycle", { ...activeBase, evidenceKind: "activated", observedAtMs: 110 }) };
assert.equal(skillLifecycleObservationFactSchema.safeParse(activated).success, true);

const contentBase = {
  observationId, sourceEventId: "source-1", coverageEpochId: "epoch-1", observedAtMs: 100, sessionId: "session-1", threadId: "thread-1", providerTurnId: null,
  projectId: "project-1", environmentId: "environment-1",
  principalId: "principal-1", providerId: "claude-code", providerModel: "claude", revision: revisionIdentity,
  family: "content-footprint" as const, method: "local-content-estimate" as const, serializer: "utf8-frontmatter", tokenizer: "none", contentComponent: "catalog-entry" as const,
  bytes: 88, tokens: 22, status: "supported" as const, estimated: true, rawObservationId: observationId,
};
const content: SkillMeasurementFact = { ...contentBase, factId: deterministicSkillFactId("measurement", contentBase) };
assert.equal(skillMeasurementFactSchema.safeParse(content).success, true);
assert.equal(skillCoverageEpochFactSchema.safeParse({ coverageEpochId: "epoch-1", startedAtMs: 1, endedAtMs: null, source: "skill-observation-v1", lifecycleCoverage: "observed", activationCoverage: "observed", reason: "instrumented" }).success, true);

const rejects = (label: string, schema: { safeParse(value: unknown): { success: boolean } }, value: unknown) => assert.equal(schema.safeParse(value).success, false, label);
rejects("unsupported is not zero", skillMeasurementFactSchema, { ...content, status: "unsupported", tokens: 0 });
rejects("context report is not body loading", skillMeasurementFactSchema, { ...content, family: "context-occupancy", method: "provider-reported-named-context-estimate", contentComponent: "body" });
rejects("activation needs observed coverage", skillLifecycleObservationFactSchema, { ...activated, activationObservability: "unsupported" });
rejects("coverage cannot travel back in time", skillCoverageEpochFactSchema, { coverageEpochId: "epoch-1", startedAtMs: 2, endedAtMs: 1, source: "skill-observation-v1", lifecycleCoverage: "observed", activationCoverage: "observed", reason: "bad" });
assert.throws(() => reconcileMeasurementRows([content, { ...content, factId: deterministicSkillFactId("measurement", { two: true }), tokenizer: "other" }], "tokens"), /must not be pooled/);

const activation = summarizeActivation([active, activated], { startMs: 1, endMs: 120 });
assert.deepEqual({ eligible: activation.eligibleUnits, activated: activation.activatedUnits, absent: activation.noActivationObservedUnits, rate: activation.activationRate }, { eligible: 1, activated: 1, absent: 0, rate: 1 });
const noActivation = summarizeActivation([active], { startMs: 1, endMs: 120 });
assert.deepEqual({ eligible: noActivation.eligibleUnits, absent: noActivation.noActivationObservedUnits, rate: noActivation.activationRate }, { eligible: 1, absent: 1, rate: 0 });
assert.deepEqual(summarizeMeasuredValues([1, 2, 3, 4, 100, null]), { count: 5, mean: 22, median: 3, p95: 100, minimum: 1, maximum: 100 });
assert.deepEqual(reconcileMeasurementRows([content], "tokens"), { total: 22, contributingFactIds: [content.factId], missingFactIds: [] });
assert.equal(deterministicSkillFactId("lifecycle", { b: 2, a: 1 }), deterministicSkillFactId("lifecycle", { a: 1, b: 2 }), "fact identity is key-order independent");
process.stdout.write(JSON.stringify({ status: "pass", checks: 12 }));
