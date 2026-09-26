import assert from "node:assert/strict";

const skillMigration = "skill-projection-v1";
const preSkillEpoch = "coverage-pre-skill";
const unknownEpoch = "coverage-prospective-1000";
const evidenceKinds = new Set(["resolved", "active-staged", "bridge-acknowledged", "provider-observed", "activated", "registered-skill-md-read", "subtree-read"]);

const clone = (value) => structuredClone(value);

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

function revisionKey(revision) {
  return canonical({
    skillId: revision.skillId,
    sourceKind: revision.sourceKind,
    sourceId: revision.sourceId,
    pluginId: revision.pluginId,
    skillMarkdownPath: revision.skillMarkdownPath,
    catalogRevision: revision.catalogRevision,
    skillMarkdownRevision: revision.skillMarkdownRevision,
    treeRevision: revision.treeRevision,
  });
}

function validateRevision(revision) {
  assert.ok(revision && typeof revision === "object", "skill revision is required");
  for (const key of ["skillId", "name", "skillMarkdownPath", "sourceKind", "sourceId", "catalogRevision", "skillMarkdownRevision", "treeRevision"]) {
    assert.equal(typeof revision[key], "string", `revision.${key} must be a string`);
    assert.notEqual(revision[key].length, 0, `revision.${key} must not be empty`);
  }
  for (const key of ["catalogRevision", "skillMarkdownRevision", "treeRevision"])
    assert.match(revision[key], /^[a-f0-9]{64}$/u, `revision.${key} must be an exact SHA-256 revision`);
  assert.ok(revision.pluginId === null || typeof revision.pluginId === "string", "revision.pluginId must be nullable string");
}

function requireSkillStore(state) {
  assert.equal(state.schemaVersion, 8, "skill projection requires schema version 8");
  assert.equal(state.skillProjectionVersion, 1, "skill projection version must be 1");
  assert.ok(Array.isArray(state.skillSourceEvents), "skill source event log is required");
  assert.ok(Array.isArray(state.skillLifecycleFacts), "skill lifecycle facts are required");
  assert.ok(Array.isArray(state.coverageEpochs), "coverage epochs are required");
}

function epochFor(state, id, observedAtMs) {
  const epoch = state.coverageEpochs.find((candidate) => candidate.id === id);
  assert.ok(epoch, `unknown coverage epoch ${id}`);
  assert.ok(observedAtMs >= epoch.startedAtMs, "event predates its coverage epoch");
  assert.ok(epoch.endedAtMs === null || observedAtMs < epoch.endedAtMs, "event is outside closed coverage epoch");
  return epoch;
}

function lifecycleFact(event) {
  return {
    factId: `skillfact_v1_${event.eventId}`,
    sourceEventId: event.eventId,
    coverageEpochId: event.coverageEpochId,
    observedAtMs: event.observedAtMs,
    revision: clone(event.revision),
    revisionKey: revisionKey(event.revision),
    sessionId: event.sessionId,
    threadId: event.threadId,
    providerTurnId: event.providerTurnId,
    evidenceKind: event.evidenceKind,
  };
}

function validateUpsert(state, event) {
  assert.equal(event.action, "upsert");
  assert.equal(typeof event.eventId, "string");
  assert.ok(event.eventId.length > 0, "event id is required");
  assert.ok(Number.isSafeInteger(event.observedAtMs) && event.observedAtMs >= 0, "event timestamp is invalid");
  assert.equal(typeof event.sessionId, "string", "session identity is required");
  assert.equal(typeof event.threadId, "string", "thread identity is required");
  assert.ok(event.providerTurnId === null || typeof event.providerTurnId === "string", "provider turn must be nullable string");
  assert.ok(evidenceKinds.has(event.evidenceKind), "lifecycle evidence kind is invalid");
  validateRevision(event.revision);
  epochFor(state, event.coverageEpochId, event.observedAtMs);
}

function expectedFacts(state) {
  const deleted = new Set(state.skillSourceEvents.filter((event) => event.action === "delete").map((event) => event.targetEventId));
  return state.skillSourceEvents
    .filter((event) => event.action === "upsert" && !deleted.has(event.eventId))
    .map(lifecycleFact)
    .sort((left, right) => left.sourceEventId.localeCompare(right.sourceEventId));
}

/** Upgrade builds a draft and commits only by returning it; input remains a pre-skill store on interruption. */
export function upgradePreSkillStore(store, { coverageStartedAtMs = 1000, beforeCommit } = {}) {
  if (store.schemaVersion === 8) {
    requireSkillStore(store);
    reconcileStore(store);
    return clone(store);
  }
  assert.equal(store.schemaVersion, 7, "only the frozen pre-skill schema can be upgraded");
  assert.ok(Array.isArray(store.migrationLog) && !store.migrationLog.includes(skillMigration), "migration must append exactly once");
  assert.ok(Number.isSafeInteger(coverageStartedAtMs) && coverageStartedAtMs >= 0, "coverage start is invalid");
  const draft = clone(store);
  draft.schemaVersion = 8;
  draft.skillProjectionVersion = 1;
  draft.migrationLog.push(skillMigration);
  draft.skillSourceEvents = [];
  draft.skillLifecycleFacts = [];
  draft.coverageEpochs = [
    { id: preSkillEpoch, startedAtMs: 0, endedAtMs: coverageStartedAtMs, lifecycle: "pre-instrumentation", activation: "pre-instrumentation" },
    { id: unknownEpoch, startedAtMs: coverageStartedAtMs, endedAtMs: null, lifecycle: "unknown", activation: "unknown" },
  ];
  beforeCommit?.(draft);
  reconcileStore(draft);
  return draft;
}

/** Opens a new observed epoch prospectively; it cannot relabel the prior unknown interval. */
export function openCoverageEpoch(store, epoch) {
  const draft = clone(store);
  requireSkillStore(draft);
  assert.equal(typeof epoch?.id, "string", "coverage epoch id is required");
  assert.ok(Number.isSafeInteger(epoch.startedAtMs), "coverage epoch start is invalid");
  assert.ok(["observed", "unsupported", "unknown"].includes(epoch.lifecycle), "lifecycle coverage is invalid");
  assert.ok(["observed", "unsupported", "unknown"].includes(epoch.activation), "activation coverage is invalid");
  assert.equal(draft.coverageEpochs.at(-1)?.endedAtMs, null, "only the current coverage epoch can be closed");
  assert.ok(epoch.startedAtMs >= draft.coverageEpochs.at(-1).startedAtMs, "coverage epochs cannot move backwards");
  assert.equal(draft.coverageEpochs.some((candidate) => candidate.id === epoch.id), false, "coverage epoch ids are immutable");
  draft.coverageEpochs.at(-1).endedAtMs = epoch.startedAtMs;
  draft.coverageEpochs.push({ ...clone(epoch), endedAtMs: null });
  reconcileStore(draft);
  return draft;
}

/** Append a source event exactly once and derive facts from its unretracted source events. */
export function projectEvent(store, event) {
  const draft = clone(store);
  requireSkillStore(draft);
  assert.equal(typeof event?.eventId, "string", "event id is required");
  const existing = draft.skillSourceEvents.find((candidate) => candidate.eventId === event.eventId);
  if (existing) {
    assert.equal(canonical(existing), canonical(event), `conflicting duplicate source event ${event.eventId}`);
    return { store: draft, duplicateIgnored: true };
  }
  if (event.action === "upsert") validateUpsert(draft, event);
  else if (event.action === "delete") {
    assert.equal(typeof event.targetEventId, "string", "deletion target is required");
    assert.ok(draft.skillSourceEvents.some((candidate) => candidate.eventId === event.targetEventId && candidate.action === "upsert"), "deletion must target an existing skill event");
    epochFor(draft, event.coverageEpochId, event.observedAtMs);
  } else throw new Error("projection event action is invalid");
  draft.skillSourceEvents.push(clone(event));
  draft.skillLifecycleFacts = expectedFacts(draft);
  reconcileStore(draft);
  return { store: draft, duplicateIgnored: false };
}

/** Reconciliation detects direct event-log corruption and stale materialized rows. */
export function reconcileStore(store) {
  requireSkillStore(store);
  assert.equal(store.migrationLog.at(-1), skillMigration, "skill migration must be append-only and last");
  const eventIds = new Set();
  for (const event of store.skillSourceEvents) {
    assert.equal(typeof event.eventId, "string", "source events require an id");
    assert.equal(eventIds.has(event.eventId), false, `duplicate source event ${event.eventId}`);
    eventIds.add(event.eventId);
  }
  let previous = -1;
  for (const epoch of store.coverageEpochs) {
    assert.ok(epoch.startedAtMs >= previous, "coverage epochs must be ordered");
    assert.ok(epoch.endedAtMs === null || epoch.endedAtMs >= epoch.startedAtMs, "coverage epoch cannot end before it starts");
    previous = epoch.startedAtMs;
  }
  assert.deepEqual(store.skillLifecycleFacts, expectedFacts(store), "materialized skill facts must exactly reconcile to append-only source events");
  return true;
}

export function reopenStore(store) {
  const reopened = clone(store);
  reconcileStore(reopened);
  return reopened;
}

export function assertPreservedArtifacts(prior, upgraded) {
  assert.deepEqual(upgraded.toolExecutionFacts, prior.toolExecutionFacts, "tool_execution_fact_v1 rows changed during skill migration");
  assert.equal(upgraded.savedArtifacts.bundleSourceJson, prior.savedArtifacts.bundleSourceJson, "saved bundle bytes changed during skill migration");
  assert.equal(upgraded.savedArtifacts.referenceCapsuleJson, prior.savedArtifacts.referenceCapsuleJson, "saved reference bytes changed during skill migration");
}
