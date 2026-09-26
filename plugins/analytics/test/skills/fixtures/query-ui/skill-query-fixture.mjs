import assert from "node:assert/strict";

const revisionA = "a".repeat(64);
const revisionB = "b".repeat(64);
const revisionC = "c".repeat(64);

const skill = (skillId, name, revision, path) => ({
  skillId,
  name,
  revision,
  path,
  source: "project",
});

const coverage = (lifecycle, activation, measurement) => ({ lifecycle, activation, measurement });

/**
 * These facts deliberately model the raw, drill-through population rather
 * than a dashboard result. Every aggregate below is recomputed from these
 * records under its exact filters and retains its contributing fact IDs.
 */
export const rawFacts = Object.freeze([
  {
    factId: "life-resolved-a", kind: "lifecycle", observedAtMs: 100,
    evidence: "resolved", skill: skill("release-notes-project", "release-notes", revisionA, "/work/skills/release-notes/SKILL.md"),
    provider: "claude-code", model: "claude-sonnet", project: "alpha", environment: "preview", principal: "alice", session: "session-a", thread: "thread-a", turn: "turn-a",
    coverage: coverage("observed", "observed", "observed"),
  },
  {
    factId: "life-active-a", kind: "lifecycle", observedAtMs: 101,
    evidence: "active-staged", skill: skill("release-notes-project", "release-notes", revisionA, "/work/skills/release-notes/SKILL.md"),
    provider: "claude-code", model: "claude-sonnet", project: "alpha", environment: "preview", principal: "alice", session: "session-a", thread: "thread-a", turn: "turn-a",
    coverage: coverage("observed", "observed", "observed"),
  },
  {
    factId: "life-registered-skill-md-read-a", kind: "lifecycle", observedAtMs: 102,
    evidence: "registered-skill-md-read", skill: skill("release-notes-project", "release-notes", revisionA, "/work/skills/release-notes/SKILL.md"),
    provider: "claude-code", model: "claude-sonnet", project: "alpha", environment: "preview", principal: "alice", session: "session-a", thread: "thread-a", turn: "turn-read-a",
    coverage: coverage("observed", "observed", "observed"),
  },
  {
    factId: "life-subtree-read-a", kind: "lifecycle", observedAtMs: 103,
    evidence: "subtree-read", skill: skill("release-notes-project", "release-notes", revisionA, "/work/skills/release-notes/SKILL.md"),
    provider: "claude-code", model: "claude-sonnet", project: "alpha", environment: "preview", principal: "alice", session: "session-a", thread: "thread-a", turn: "turn-subtree-a",
    coverage: coverage("observed", "observed", "observed"),
  },
  {
    factId: "life-resolved-b", kind: "lifecycle", observedAtMs: 110,
    evidence: "resolved", skill: skill("release-notes-user", "release-notes", revisionB, "/home/alice/.agents/skills/release-notes/SKILL.md"),
    provider: "claude-code", model: "claude-haiku", project: "alpha", environment: "preview", principal: "alice", session: "session-b", thread: "thread-b", turn: null,
    coverage: coverage("observed", "observed", "observed"),
  },
  {
    factId: "life-active-b", kind: "lifecycle", observedAtMs: 111,
    evidence: "active-staged", skill: skill("release-notes-user", "release-notes", revisionB, "/home/alice/.agents/skills/release-notes/SKILL.md"),
    provider: "claude-code", model: "claude-haiku", project: "alpha", environment: "preview", principal: "alice", session: "session-b", thread: "thread-b", turn: null,
    coverage: coverage("observed", "observed", "observed"),
  },
  {
    factId: "life-preinstrumentation", kind: "lifecycle", observedAtMs: 50,
    evidence: "active-staged", skill: skill("release-notes-project", "release-notes", revisionA, "/work/skills/release-notes/SKILL.md"),
    provider: "claude-code", model: "claude-sonnet", project: "alpha", environment: "preview", principal: "alice", session: "session-old", thread: "thread-old", turn: null,
    coverage: coverage("unknown", "unknown", "unknown"),
  },
  {
    factId: "life-codex-unsupported", kind: "lifecycle", observedAtMs: 120,
    evidence: "active-staged", skill: skill("incident-response", "incident-response", revisionC, "/work/skills/incident-response/SKILL.md"),
    provider: "codex", model: "gpt-5", project: "alpha", environment: "preview", principal: "alice", session: "session-c", thread: "thread-c", turn: "turn-c",
    coverage: coverage("observed", "unsupported", "unsupported"),
  },
  {
    factId: "content-a", kind: "measurement", observedAtMs: 103,
    family: "content", method: "local-content-estimate", serializer: "utf8-frontmatter", tokenizer: "none", value: 100,
    evidence: "content-footprint", skill: skill("release-notes-project", "release-notes", revisionA, "/work/skills/release-notes/SKILL.md"),
    provider: "claude-code", model: "claude-sonnet", project: "alpha", environment: "preview", principal: "alice", session: "session-a", thread: "thread-a", turn: "turn-a",
    coverage: coverage("observed", "observed", "observed"),
  },
  {
    factId: "context-a", kind: "measurement", observedAtMs: 104,
    family: "context", method: "provider-reported-named-context-estimate", serializer: "ClaudeContextUsageCollector skills.skillFrontmatter", tokenizer: "provider-undisclosed", value: 22,
    evidence: "provider-context-report", skill: skill("release-notes-project", "release-notes", revisionA, "/work/skills/release-notes/SKILL.md"),
    provider: "claude-code", model: "claude-sonnet", project: "alpha", environment: "preview", principal: "alice", session: "session-a", thread: "thread-a", turn: null,
    coverage: coverage("observed", "observed", "observed"),
  },
  {
    factId: "context-b", kind: "measurement", observedAtMs: 112,
    family: "context", method: "provider-reported-named-context-estimate", serializer: "ClaudeContextUsageCollector skills.skillFrontmatter", tokenizer: "provider-undisclosed", value: 31,
    evidence: "provider-context-report", skill: skill("release-notes-user", "release-notes", revisionB, "/home/alice/.agents/skills/release-notes/SKILL.md"),
    provider: "claude-code", model: "claude-haiku", project: "alpha", environment: "preview", principal: "alice", session: "session-b", thread: "thread-b", turn: null,
    coverage: coverage("observed", "observed", "observed"),
  },
  {
    factId: "consumption-a", kind: "measurement", observedAtMs: 105,
    family: "consumption", method: "provider-attributed-token-usage", serializer: "claude-usage-v1", tokenizer: "claude-tokenizer-v1", value: 8,
    evidence: "provider-native-event", skill: skill("release-notes-project", "release-notes", revisionA, "/work/skills/release-notes/SKILL.md"),
    provider: "claude-code", model: "claude-sonnet", project: "alpha", environment: "preview", principal: "alice", session: "session-a", thread: "thread-a", turn: "turn-a",
    coverage: coverage("observed", "observed", "observed"),
  },
  {
    factId: "consumption-b-different-tokenizer", kind: "measurement", observedAtMs: 106,
    family: "consumption", method: "provider-attributed-token-usage", serializer: "claude-usage-v1", tokenizer: "custom-tokenizer-v2", value: 13,
    evidence: "provider-native-event", skill: skill("release-notes-project", "release-notes", revisionA, "/work/skills/release-notes/SKILL.md"),
    provider: "claude-code", model: "claude-sonnet", project: "alpha", environment: "preview", principal: "alice", session: "session-a", thread: "thread-a", turn: "turn-a",
    coverage: coverage("observed", "observed", "observed"),
  },
  {
    factId: "consumption-c-unsupported", kind: "measurement", observedAtMs: 121,
    family: "consumption", method: "unsupported", serializer: "none", tokenizer: "none", value: null,
    evidence: "unsupported-provider-telemetry", skill: skill("incident-response", "incident-response", revisionC, "/work/skills/incident-response/SKILL.md"),
    provider: "codex", model: "gpt-5", project: "alpha", environment: "preview", principal: "alice", session: "session-c", thread: "thread-c", turn: "turn-c",
    coverage: coverage("observed", "unsupported", "unsupported"),
  },
]);

const exact = (actual, expected) => expected === undefined || actual === expected;
const matches = (row, filters = {}) => (
  exact(row.provider, filters.provider)
  && exact(row.model, filters.model)
  && exact(row.project, filters.project)
  && exact(row.environment, filters.environment)
  && exact(row.principal, filters.principal)
  && exact(row.skill.name, filters.skillName)
  && exact(row.skill.revision, filters.revision)
  && exact(row.coverage.lifecycle, filters.lifecycleCoverage)
  && exact(row.coverage.activation, filters.activationCoverage)
  && exact(row.coverage.measurement, filters.measurementCoverage)
  && (filters.startMs === undefined || row.observedAtMs >= filters.startMs)
  && (filters.endMs === undefined || row.observedAtMs <= filters.endMs)
);

export function rawContributors(filters = {}, predicate = () => true) {
  return rawFacts.filter((row) => matches(row, filters) && predicate(row));
}

const measurementKey = (row) => [
  row.skill.skillId, row.skill.revision, row.provider, row.model, row.family,
  row.method, row.serializer, row.tokenizer, row.evidence,
].join("|");

export function measurementAggregates(filters = {}) {
  const groups = new Map();
  for (const row of rawContributors(filters, (entry) => entry.kind === "measurement" && entry.coverage.measurement === "observed" && Number.isFinite(entry.value))) {
    const key = measurementKey(row);
    const aggregate = groups.get(key) ?? {
      key, family: row.family, method: row.method, serializer: row.serializer, tokenizer: row.tokenizer,
      provider: row.provider, model: row.model, skill: row.skill, evidence: row.evidence, total: 0, count: 0, contributingFactIds: [], filters: { ...filters },
    };
    aggregate.total += row.value;
    aggregate.count += 1;
    aggregate.contributingFactIds.push(row.factId);
    groups.set(key, aggregate);
  }
  return [...groups.values()];
}

const readDeliveryUnit = (row) => [row.skill.skillId, row.skill.revision, row.provider, row.model, row.session, row.thread].join("|");

/** Compatibility fixture for the isolated UI: it exposes no-read provenance,
 * while native activation is explicitly unsupported rather than inferred. */
export function activationAggregate(filters = {}) {
  const lifecycle = rawContributors(filters, (row) => row.kind === "lifecycle");
  const eligibleUnits = new Map(lifecycle
    .filter((row) => row.provider === "claude-code" && row.evidence === "active-staged" && row.coverage.lifecycle === "observed")
    .map((row) => [readDeliveryUnit(row), row]));
  const readUnits = new Set(lifecycle
    .filter((row) => row.provider === "claude-code" && (row.evidence === "registered-skill-md-read" || row.evidence === "subtree-read"))
    .map(readDeliveryUnit));
  const noReadFactIds = [...eligibleUnits].filter(([unit]) => !readUnits.has(unit)).map(([, row]) => row.factId).sort();
  return {
    filters: { ...filters }, nativeActivation: { status: "unsupported", reason: "No provider-native per-skill activation fact is present." },
    noReadObserved: { observableActiveUnits: eligibleUnits.size, noReadObservedUnits: noReadFactIds.length, contributingFactIds: noReadFactIds },
    coverage: {
      observed: [...eligibleUnits.values()].length,
      unsupported: lifecycle.filter((row) => row.evidence === "active-staged" && row.coverage.activation === "unsupported").length,
      unknown: lifecycle.filter((row) => row.evidence === "active-staged" && row.coverage.activation === "unknown").length,
    },
  };
}

export function lifecycleCohortAggregates(filters = {}) {
  const groups = new Map();
  for (const row of rawContributors(filters, (entry) => entry.kind === "lifecycle")) {
    const key = [row.skill.skillId, row.skill.revision, row.provider, row.model, row.evidence, row.coverage.lifecycle, row.coverage.activation].join("|");
    const aggregate = groups.get(key) ?? {
      key, evidence: row.evidence, lifecycleCoverage: row.coverage.lifecycle, activationCoverage: row.coverage.activation,
      provider: row.provider, model: row.model, skill: row.skill, count: 0, contributingFactIds: [], filters: { ...filters },
    };
    aggregate.count += 1;
    aggregate.contributingFactIds.push(row.factId);
    groups.set(key, aggregate);
  }
  return [...groups.values()];
}

export function reconcileLifecycleCohortAggregate(aggregate) {
  const raw = rawContributors(aggregate.filters, (row) => row.kind === "lifecycle" && [row.skill.skillId, row.skill.revision, row.provider, row.model, row.evidence, row.coverage.lifecycle, row.coverage.activation].join("|") === aggregate.key);
  assert.deepEqual(raw.map((row) => row.factId).sort(), [...aggregate.contributingFactIds].sort(), "lifecycle aggregate must retain exactly its filtered raw contributors");
  assert.equal(raw.length, aggregate.count, "lifecycle count must be reconstructed from raw contributors");
}

export function reconcileMeasurementAggregate(aggregate) {
  const raw = rawContributors(aggregate.filters, (row) => row.kind === "measurement" && row.coverage.measurement === "observed" && measurementKey(row) === aggregate.key);
  assert.deepEqual(raw.map((row) => row.factId).sort(), [...aggregate.contributingFactIds].sort(), "measurement aggregate must retain exactly its filtered raw contributors");
  assert.equal(raw.reduce((sum, row) => sum + row.value, 0), aggregate.total, "measurement total must be reconstructed from raw contributors");
  assert.equal(raw.length, aggregate.count, "measurement sample count must be reconstructed from raw contributors");
}
