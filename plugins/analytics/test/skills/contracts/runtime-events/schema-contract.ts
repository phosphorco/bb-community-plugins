import assert from "node:assert/strict";
import { threadEventSchema } from "../../../../../../../fork/upstream/packages/domain/src/provider-event.ts";
import { skillObservationSchema } from "../../../../../../../fork/upstream/packages/domain/src/skill-observation.ts";
import { skillObservationSchema as bridgeSkillObservationSchema } from "../../../../../../../fork/upstream/packages/provider-bridge-protocol/src/index.ts";
import { hostDaemonSkillObservationProvenanceSchema } from "../../../../../../../fork/upstream/packages/host-daemon-contract/src/commands.ts";

const revision = "a".repeat(64);
const identifier = "b".repeat(64);
const dedupe = "c".repeat(64);

const observation = {
  schemaVersion: 1,
  observationId: `skillobs_v1_${identifier}`,
  dedupeKey: `skillobs_dedupe_v1_${dedupe}`,
  evidenceKind: "named-token-measurement",
  status: "supported",
  captureTrigger: "provider-context-report",
  actor: { actorId: "actor-1", principalId: "principal-1", kind: "user" },
  threadId: "thread-1",
  providerThreadId: "provider-thread-1",
  providerSessionId: "provider-session-1",
  providerId: "claude-code",
  providerModel: "claude-sonnet-4-5-20250929",
  providerTurnId: null,
  providerEventId: "context-report-1",
  catalogRevision: revision,
  skill: {
    skillId: "skill-1",
    name: "release-notes",
    skillMarkdownPath: "/workspace/skills/release-notes/SKILL.md",
    sourceKind: "project",
    sourceId: "project-1",
    pluginId: null,
    catalogRevision: revision,
    skillMarkdownRevision: revision,
    treeRevision: revision,
  },
  measurement: {
    method: "provider-reported-named-context-estimate",
    serializer: "ClaudeContextUsageCollector skills.skillFrontmatter",
    tokenizer: "provider-undisclosed",
    estimated: true,
    attribution: "per-skill",
    bytes: null,
    tokens: 22,
  },
  failure: null,
  rawProviderMetadata: { category: "Skills", name: "release-notes" },
};

function rejects(label: string, value: unknown): void {
  assert.equal(skillObservationSchema.safeParse(value).success, false, label);
}

assert.deepEqual(bridgeSkillObservationSchema.parse(observation), observation);
assert.deepEqual(skillObservationSchema.parse(observation), observation);
assert.deepEqual(
  hostDaemonSkillObservationProvenanceSchema.parse(observation.actor),
  observation.actor,
);
assert.equal(
  threadEventSchema.safeParse({
    type: "skill/observed",
    threadId: observation.threadId,
    providerThreadId: observation.providerThreadId,
    observation,
    scope: { kind: "thread" },
  }).success,
  true,
  "session-scoped reports permit a nullable provider turn",
);

const missingNullableTurn = { ...observation } as Record<string, unknown>;
delete missingNullableTurn.providerTurnId;
rejects("providerTurnId must be present even when null", missingNullableTurn);

rejects("stale skill catalog revisions are rejected", {
  ...observation,
  skill: { ...observation.skill, catalogRevision: "d".repeat(64) },
});

rejects("unsupported measurements cannot be coerced to zero", {
  ...observation,
  status: "unsupported",
  measurement: { ...observation.measurement, tokens: 0 },
});

rejects("aggregate provider usage cannot be apportioned", {
  ...observation,
  measurement: {
    method: "provider-aggregate-usage",
    serializer: "thread/tokenUsage/updated",
    tokenizer: "provider-undisclosed",
    estimated: false,
    attribution: "aggregate-unassigned",
    bytes: null,
    tokens: 151,
  },
});

rejects("Codex per-skill attribution remains unsupported", {
  ...observation,
  providerId: "codex",
  evidenceKind: "registered-skill-md-read",
});

rejects("wrong enclosing event identifiers are rejected", {
  type: "skill/observed",
  threadId: "wrong-thread",
  providerThreadId: observation.providerThreadId,
  observation,
  scope: { kind: "thread" },
});

process.stdout.write(JSON.stringify({ status: "pass", checks: 9 }));
