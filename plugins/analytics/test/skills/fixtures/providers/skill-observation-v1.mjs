const hex = (value) => value.toString(16).padStart(64, "0");

export const revisions = Object.freeze({
  catalogInitial: "a".repeat(64),
  markdownInitial: "b".repeat(64),
  treeInitial: "c".repeat(64),
  catalogCurrent: "d".repeat(64),
  markdownCurrent: "e".repeat(64),
  treeCurrent: "f".repeat(64),
  collisionMarkdown: "1".repeat(64),
  collisionTree: "2".repeat(64),
});

export function skill({
  id = "release-notes-project",
  name = "release-notes",
  path = "/project/skills/release-notes/SKILL.md",
  sourceKind = "project",
  sourceId = "project-alpha",
  pluginId = null,
  catalogRevision = revisions.catalogCurrent,
  skillMarkdownRevision = revisions.markdownCurrent,
  treeRevision = revisions.treeCurrent,
} = {}) {
  return {
    skillId: id,
    name,
    skillMarkdownPath: path,
    sourceKind,
    sourceId,
    pluginId,
    catalogRevision,
    skillMarkdownRevision,
    treeRevision,
  };
}

export function observation({
  serial,
  evidenceKind,
  status = "supported",
  captureTrigger,
  providerId = "claude-code",
  providerModel = "claude-sonnet-4-5-20250929",
  providerTurnId = "turn-1",
  providerEventId = `event-${serial}`,
  catalogRevision = revisions.catalogCurrent,
  observedSkill = skill(),
  measurement = null,
  failure = null,
  rawProviderMetadata = {},
} = {}) {
  if (!Number.isInteger(serial) || serial < 1) throw new Error("fixture serial must be a positive integer");
  return {
    schemaVersion: 1,
    observationId: `skillobs_v1_${hex(serial)}`,
    dedupeKey: `skillobs_dedupe_v1_${hex(serial + 10_000)}`,
    evidenceKind,
    status,
    captureTrigger,
    actor: { actorId: "actor-1", principalId: "principal-1", kind: "user" },
    threadId: "thread-1",
    providerThreadId: "provider-thread-1",
    providerSessionId: "provider-session-1",
    providerId,
    providerModel,
    providerTurnId,
    providerEventId,
    catalogRevision,
    skill: observedSkill,
    measurement,
    failure,
    rawProviderMetadata,
  };
}

const currentSkill = skill();
const initialSkill = skill({
  catalogRevision: revisions.catalogInitial,
  skillMarkdownRevision: revisions.markdownInitial,
  treeRevision: revisions.treeInitial,
});

export const catalogDelivery = Object.freeze({
  initialResolved: observation({
    serial: 1,
    evidenceKind: "resolved",
    captureTrigger: "catalog-resolution",
    catalogRevision: revisions.catalogInitial,
    observedSkill: initialSkill,
  }),
  currentResolved: observation({
    serial: 2,
    evidenceKind: "resolved",
    captureTrigger: "catalog-resolution",
    observedSkill: currentSkill,
  }),
  busyDeferral: observation({
    serial: 3,
    evidenceKind: "active-staged",
    status: "failure",
    captureTrigger: "busy-runtime-deferral",
    observedSkill: currentSkill,
    failure: "shared runtime is mid-turn; catalog staging is deferred",
    rawProviderMetadata: { reason: "busy-runtime", retry: "after-turn" },
  }),
  failedConfiguration: observation({
    serial: 4,
    evidenceKind: "bridge-acknowledged",
    status: "failure",
    captureTrigger: "bridge-configure-acknowledgement",
    observedSkill: currentSkill,
    failure: "skills/configure rejected by provider bridge",
    rawProviderMetadata: { method: "skills/configure", acknowledged: false },
  }),
  sameNameDifferentPath: observation({
    serial: 5,
    evidenceKind: "resolved",
    captureTrigger: "catalog-resolution",
    observedSkill: skill({
      id: "release-notes-plugin",
      path: "/project/plugins/release-notes/SKILL.md",
      sourceKind: "plugin",
      sourceId: "plugin-release-tools",
      pluginId: "release-tools",
      skillMarkdownRevision: revisions.collisionMarkdown,
      treeRevision: revisions.collisionTree,
    }),
  }),
  wrongRevision: observation({
    serial: 6,
    evidenceKind: "resolved",
    captureTrigger: "catalog-resolution",
    observedSkill: skill({ catalogRevision: revisions.catalogInitial }),
  }),
});

export const codexProvider = Object.freeze({
  bridgeAcknowledged: observation({
    serial: 11,
    evidenceKind: "bridge-acknowledged",
    captureTrigger: "bridge-configure-acknowledgement",
    providerId: "codex",
    providerModel: null,
  }),
  unsupportedNativeAttribution: observation({
    serial: 12,
    evidenceKind: "provider-observed",
    status: "unsupported",
    captureTrigger: "provider-native-event",
    providerId: "codex",
    providerModel: null,
    measurement: null,
    rawProviderMetadata: { notification: "skills/changed", classification: "noise" },
  }),
  aggregateUsage: observation({
    serial: 13,
    evidenceKind: "provider-observed",
    captureTrigger: "provider-aggregate-usage",
    providerId: "codex",
    providerModel: null,
    observedSkill: null,
    measurement: {
      method: "provider-aggregate-usage",
      serializer: "thread/tokenUsage/updated",
      tokenizer: "provider-undisclosed",
      estimated: false,
      attribution: "aggregate-unassigned",
      bytes: null,
      tokens: 151,
    },
    rawProviderMetadata: { threadId: "thread-1", turnId: "turn-1" },
  }),
  apportionedAggregate: observation({
    serial: 14,
    evidenceKind: "provider-observed",
    captureTrigger: "provider-aggregate-usage",
    providerId: "codex",
    providerModel: null,
    observedSkill: currentSkill,
    measurement: {
      method: "provider-aggregate-usage",
      serializer: "thread/tokenUsage/updated",
      tokenizer: "provider-undisclosed",
      estimated: false,
      attribution: "aggregate-unassigned",
      bytes: null,
      tokens: 151,
    },
  }),
});

const namedFrontmatterMeasurement = Object.freeze({
  method: "provider-reported-named-context-estimate",
  serializer: "ClaudeContextUsageCollector skills.skillFrontmatter",
  tokenizer: "provider-undisclosed",
  estimated: true,
  attribution: "per-skill",
  bytes: null,
  tokens: 22,
});

const currentFrontmatterSnapshot = observation({
  serial: 23,
  evidenceKind: "named-token-measurement",
  captureTrigger: "provider-context-report",
  providerTurnId: null,
  providerEventId: "context-report-current",
  measurement: namedFrontmatterMeasurement,
  rawProviderMetadata: { name: "release-notes", source: "project", category: "Skills" },
});

export const claudeProvider = Object.freeze({
  registeredSkillMarkdownRead: observation({
    serial: 21,
    evidenceKind: "registered-skill-md-read",
    captureTrigger: "provider-read",
    providerEventId: "read-skill-md",
    rawProviderMetadata: { path: "/project/skills/release-notes/SKILL.md", tool: "Read" },
  }),
  containedSubtreeRead: observation({
    serial: 22,
    evidenceKind: "subtree-read",
    captureTrigger: "provider-read",
    providerEventId: "read-reference",
    rawProviderMetadata: { path: "/project/skills/release-notes/references/current.md", tool: "Read" },
  }),
  outsideTreeRead: observation({
    serial: 24,
    evidenceKind: "subtree-read",
    captureTrigger: "provider-read",
    providerEventId: "read-outside-tree",
    rawProviderMetadata: { path: "/project/skills/another-skill/SKILL.md", tool: "Read" },
  }),
  currentFrontmatterSnapshot,
  duplicateCurrentFrontmatterSnapshot: {
    ...currentFrontmatterSnapshot,
    observationId: `skillobs_v1_${hex(25)}`,
    providerEventId: "context-report-current-replayed",
  },
  lateFrontmatterSnapshot: observation({
    serial: 26,
    evidenceKind: "named-token-measurement",
    captureTrigger: "provider-context-report",
    providerTurnId: null,
    providerEventId: "context-report-old-revision",
    catalogRevision: revisions.catalogInitial,
    observedSkill: initialSkill,
    measurement: namedFrontmatterMeasurement,
    rawProviderMetadata: { name: "release-notes", source: "project", category: "Skills", capturedAfterRevision: "old" },
  }),
});

export const expectedCurrentSkill = currentSkill;
