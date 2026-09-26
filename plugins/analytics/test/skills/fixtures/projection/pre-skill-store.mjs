const hash = (character) => character.repeat(64);

export const revisionOne = Object.freeze({
  skillId: "skill-release-notes",
  name: "Release notes",
  skillMarkdownPath: "/workspace/skills/release-notes/SKILL.md",
  sourceKind: "project",
  sourceId: "workspace-project",
  pluginId: null,
  catalogRevision: hash("a"),
  skillMarkdownRevision: hash("b"),
  treeRevision: hash("c"),
});

export const revisionTwo = Object.freeze({
  ...revisionOne,
  catalogRevision: hash("d"),
  skillMarkdownRevision: hash("e"),
  treeRevision: hash("f"),
});

export const projectionEvents = Object.freeze({
  first: Object.freeze({
    eventId: "skill-event-resolved-r1",
    action: "upsert",
    coverageEpochId: "coverage-observed-1100",
    observedAtMs: 1100,
    revision: revisionOne,
    sessionId: "session-a",
    threadId: "thread-a",
    providerTurnId: "turn-a",
    evidenceKind: "resolved",
  }),
  changedRevision: Object.freeze({
    eventId: "skill-event-staged-r2",
    action: "upsert",
    coverageEpochId: "coverage-observed-1100",
    observedAtMs: 1200,
    revision: revisionTwo,
    sessionId: "session-a",
    threadId: "thread-a",
    providerTurnId: null,
    evidenceKind: "active-staged",
  }),
  deleteFirst: Object.freeze({
    eventId: "skill-event-delete-r1",
    action: "delete",
    coverageEpochId: "coverage-observed-1100",
    observedAtMs: 1300,
    targetEventId: "skill-event-resolved-r1",
  }),
});

/** A frozen concrete pre-skill store; byte-bearing artifacts must survive unchanged. */
export function createPreSkillStore() {
  return {
    schemaVersion: 7,
    migrationLog: ["analytics-v5", "retained-facts-v1"],
    toolExecutionFacts: [{ factId: "toolfact-1", capabilityKey: "bb:read_file", durationMs: 18 }],
    savedArtifacts: {
      bundleSourceJson: '{"id":"existing-tools","query":"SELECT * FROM tool_execution_fact_v1"}',
      referenceCapsuleJson: '{"version":1,"reference":"analytics-ref:v1:preserved"}',
    },
  };
}
