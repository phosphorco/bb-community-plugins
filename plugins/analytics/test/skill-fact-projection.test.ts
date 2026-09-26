import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { projectSkillObservation, reconcileProjectedSkillObservations, type RetainedSkillObservationEvent } from "../skill-fact-projection.ts";

const hash = (character: string) => character.repeat(64);
const epoch = [{ id: "coverage-observed", startedAtMs: 1_000, endedAtMs: null, lifecycle: "observed", activation: "observed" }] as const;
const revision = { skillId: "release-notes", name: "Release notes", skillMarkdownPath: "/skills/release/SKILL.md", sourceKind: "project", sourceId: "project-a", pluginId: null, catalogRevision: hash("a"), skillMarkdownRevision: hash("b"), treeRevision: hash("c") } as const;
const dimensions = { projectId: "project-a", environmentId: null, providerId: "claude-code" } as const;

function event(id = "source-1", overrides: Partial<RetainedSkillObservationEvent["observation"]> = {}): RetainedSkillObservationEvent {
  return {
    id, threadId: "thread-a", seq: 4, createdAt: 1_100, type: "skill/observed",
    observation: {
      schemaVersion: 1, observationId: `skillobs_v1_${hash("d")}`, dedupeKey: `skillobs_dedupe_v1_${hash("e")}`,
      evidenceKind: "active-staged", status: "supported", captureTrigger: "active-staging",
      actor: { principalId: "principal-a" }, threadId: "thread-a", providerSessionId: "session-a", providerId: "claude-code", providerModel: "opus", providerTurnId: null, providerEventId: "provider-event-a",
      skill: revision, measurement: null, failure: null, ...overrides,
    },
  };
}

test("projects durable public observations with exact identity and nullable turn", () => {
  const projected = projectSkillObservation(event(), epoch, dimensions);
  assert.equal(projected.lifecycle?.threadId, "thread-a");
  assert.equal(projected.lifecycle?.sessionId, "session-a");
  assert.equal(projected.lifecycle?.principalId, "principal-a");
  assert.equal(projected.lifecycle?.providerTurnId, null);
  assert.equal(projected.lifecycle?.coverageEpochId, "coverage-observed");
  assert.equal(projected.lifecycle?.activationObservability, "observed");
  assert.equal(projected.lifecycle?.revision.treeRevision, hash("c"));
  assert.equal(projected.sourceDigest, createHash("sha256").update(projected.sourceEventJson).digest("hex"));
});

test("retains a named measurement partition without claiming attributable consumption", () => {
  const projected = projectSkillObservation(event("source-measurement", {
    evidenceKind: "named-token-measurement", captureTrigger: "provider-context-report",
    measurement: { method: "provider-reported-named-context-estimate", serializer: "claude-frontmatter", tokenizer: "provider-reported", estimated: true, attribution: "per-skill", bytes: null, tokens: 31 },
  }), epoch, dimensions);
  assert.equal(projected.lifecycle, null);
  assert.equal(projected.measurement?.family, "context-occupancy");
  assert.equal(projected.measurement?.method, "provider-reported-named-context-estimate");
  assert.equal(projected.measurement?.tokens, 31);
  assert.equal(projected.measurement?.providerTurnId, null);
});

test("does not apportion aggregate usage and rejects conflicting retries", () => {
  const aggregate = projectSkillObservation(event("source-aggregate", {
    evidenceKind: "named-token-measurement", captureTrigger: "provider-aggregate-usage", skill: null,
    measurement: { method: "provider-aggregate-usage", serializer: "provider", tokenizer: "provider-undisclosed", estimated: false, attribution: "aggregate-unassigned", bytes: null, tokens: 99 },
  }), epoch, dimensions);
  assert.equal(aggregate.lifecycle, null);
  assert.equal(aggregate.measurement, null);
  const duplicate = reconcileProjectedSkillObservations([event(), event()], epoch, dimensions);
  assert.equal(duplicate.length, 1);
  assert.throws(() => reconcileProjectedSkillObservations([event(), event("source-1", { providerModel: "changed" })], epoch, dimensions), /Conflicting duplicate/u);
});
