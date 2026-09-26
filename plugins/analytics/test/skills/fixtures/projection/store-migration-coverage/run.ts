import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";

import {
  AnalyticsStore,
  analyticsMigrations,
  SKILL_FACT_PROJECTION_MIGRATION_START,
} from "../../../../../store.ts";
import {
  projectSkillObservation,
  SKILL_FACT_PROJECTION_VERSION,
  type RetainedSkillObservationEvent,
  type SkillCoverageEpoch,
} from "../../../../../skill-fact-projection.ts";

const bundleBytes = '{"id":"saved-tools","query":"SELECT * FROM tool_execution_fact_v1","bytes":"keep-exact"}';
const referenceBytes = '{"id":"analytics-ref:v1:preserved","selection":{"row":7},"bytes":"keep-exact"}';

const expectedCoverage: readonly SkillCoverageEpoch[] = Object.freeze([
  { id: "coverage-pre-instrumentation", startedAtMs: 0, endedAtMs: 1_000, lifecycle: "pre-instrumentation", activation: "pre-instrumentation" },
  { id: "coverage-prospective-1000", startedAtMs: 1_000, endedAtMs: 1_100, lifecycle: "unknown", activation: "unknown" },
  { id: "coverage-observed-1100", startedAtMs: 1_100, endedAtMs: null, lifecycle: "observed", activation: "observed" },
]);

const expectedInitialCoverage: readonly SkillCoverageEpoch[] = Object.freeze([
  { id: "coverage-pre-instrumentation", startedAtMs: 0, endedAtMs: 1_000, lifecycle: "pre-instrumentation", activation: "pre-instrumentation" },
  { id: "coverage-prospective-1000", startedAtMs: 1_000, endedAtMs: null, lifecycle: "unknown", activation: "unknown" },
]);
const authoritativeDimensions = Object.freeze({ projectId: "project-before-skills", environmentId: null, providerId: "claude-code" });

function hash(character: string): string {
  return character.repeat(64);
}

function sourceEvent(includeMeasurement = false): RetainedSkillObservationEvent {
  return {
    id: "skill-event-observed-1",
    threadId: "thread-before-skills",
    seq: 9,
    createdAt: 1_200,
    type: "skill/observed",
    observation: {
      schemaVersion: 1,
      observationId: `skillobs_v1_${hash("a")}`,
      dedupeKey: `skillobs_dedupe_v1_${hash("b")}`,
      evidenceKind: "active-staged",
      status: "supported",
      captureTrigger: "active-staging",
      actor: { principalId: "principal-internal" },
      threadId: "thread-before-skills",
      providerSessionId: "session-before-skills",
      providerId: "claude-code",
      providerModel: "claude-test",
      providerTurnId: null,
      providerEventId: "provider-event-1",
      skill: {
        skillId: "skill-release-notes",
        name: "Release notes",
        skillMarkdownPath: "/workspace/skills/release-notes/SKILL.md",
        sourceKind: "project",
        sourceId: "project-before-skills",
        pluginId: null,
        catalogRevision: hash("c"),
        skillMarkdownRevision: hash("d"),
        treeRevision: hash("e"),
      },
      measurement: includeMeasurement
        ? { method: "local-content-estimate", serializer: "skill-catalog-v1", tokenizer: "fixture-tokenizer", estimated: true, attribution: "per-skill", bytes: 99, tokens: 21 }
        : null,
      failure: null,
    },
  };
}

function expectedLifecycle(event: RetainedSkillObservationEvent) {
  const observation = event.observation;
  return {
    sourceEventId: event.id,
    coverageEpochId: "coverage-observed-1100",
    observedAtMs: 1_200,
    sessionId: "session-before-skills",
    threadId: "thread-before-skills",
    providerTurnId: null,
    principalId: "principal-internal",
    projectId: "project-before-skills",
    environmentId: null,
    providerId: "claude-code",
    providerModel: "claude-test",
    revision: observation.skill,
    evidenceKind: "active-staged",
    status: "supported",
    activationObservability: "observed",
    captureTrigger: "active-staging",
    providerEventId: "provider-event-1",
    failure: null,
  };
}

function expectedMeasurement(event: RetainedSkillObservationEvent) {
  return {
    sourceEventId: event.id,
    coverageEpochId: "coverage-observed-1100",
    observedAtMs: 1_200,
    sessionId: "session-before-skills",
    threadId: "thread-before-skills",
    providerTurnId: null,
    principalId: "principal-internal",
    projectId: "project-before-skills",
    environmentId: null,
    providerId: "claude-code",
    providerModel: "claude-test",
    revision: event.observation.skill,
    family: "content-footprint",
    method: "local-content-estimate",
    serializer: "skill-catalog-v1",
    tokenizer: "fixture-tokenizer",
    contentComponent: "catalog-entry",
    bytes: 99,
    tokens: 21,
    status: "supported",
    estimated: true,
    rawObservationId: event.observation.observationId,
  };
}

function temporaryDatabase(): { directory: string; path: string } {
  const directory = mkdtempSync(join(tmpdir(), "analytics-store-migration-"));
  return { directory, path: join(directory, "analytics.sqlite") };
}

function applyMigrations(db: Database.Database, from: number, to = analyticsMigrations.length): void {
  for (const migration of analyticsMigrations.slice(from, to)) db.exec(migration);
}

function upgradeAtomically(db: Database.Database, failAfter: number | null = null): void {
  db.transaction(() => {
    for (let index = SKILL_FACT_PROJECTION_MIGRATION_START; index < analyticsMigrations.length; index += 1) {
      if (index === failAfter) throw new Error("controlled interrupted skill migration");
      db.exec(analyticsMigrations[index]!);
    }
  })();
}

function createPreSkillDatabase(path: string): Database.Database {
  const db = new Database(path);
  applyMigrations(db, 0, SKILL_FACT_PROJECTION_MIGRATION_START);
  db.prepare(`INSERT INTO tool_execution_facts_v1 (
    source_event_id,thread_id,turn_id,sequence,project_id,provider_id,created_at_ms,
    capability_kind,capability_key,status,duration_ms,failed,error_class,error_signature,
    command_binary,command_argument_1,command_argument_2,command_uses_help,command_shape,
    command_shell_wrapped,command_attribution_eligible,turn_started_at_ms,turn_completed_at_ms
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    "tool-before-skills", "thread-before-skills", null, 8, "project-before-skills", "claude-code", 900,
    "tool", "bb:read_file", "completed", 18, 0, null, null,
    "read", "/workspace/skills/release-notes/SKILL.md", null, 0, "read <path>", 0, 1, 890, 900,
  );
  db.prepare("INSERT INTO analytics_bundles (id,version,title,source_json,created_at,updated_at) VALUES (?,?,?,?,?,?)")
    .run("saved-tools", 1, "Saved tools", bundleBytes, 1, 1);
  db.prepare("INSERT INTO analytics_references (id,capsule_json,created_at) VALUES (?,?,?)")
    .run("analytics-ref:v1:preserved", referenceBytes, 2);
  return db;
}

function legacySnapshot(db: Database.Database) {
  return {
    toolRows: db.prepare("SELECT * FROM tool_execution_facts_v1 ORDER BY source_event_id").all(),
    bundle: db.prepare("SELECT source_json FROM analytics_bundles WHERE id='saved-tools'").get(),
    reference: db.prepare("SELECT capsule_json FROM analytics_references WHERE id='analytics-ref:v1:preserved'").get(),
  };
}

function assertLegacySnapshot(db: Database.Database, expected: ReturnType<typeof legacySnapshot>): void {
  assert.deepEqual(db.prepare("SELECT * FROM tool_execution_facts_v1 ORDER BY source_event_id").all(), expected.toolRows, "tool_execution_fact_v1 rows changed during skill migration");
  assert.equal((db.prepare("SELECT source_json FROM analytics_bundles WHERE id='saved-tools'").get() as { source_json: string }).source_json, bundleBytes, "saved bundle bytes changed during skill migration");
  assert.equal((db.prepare("SELECT capsule_json FROM analytics_references WHERE id='analytics-ref:v1:preserved'").get() as { capsule_json: string }).capsule_json, referenceBytes, "saved reference bytes changed during skill migration");
}

function sourceDigest(event: RetainedSkillObservationEvent): string {
  return createHash("sha256").update(JSON.stringify(event)).digest("hex");
}

function assertLifecycle(store: AnalyticsStore, event: RetainedSkillObservationEvent): void {
  const [actual] = store.listActiveSkillLifecycleFacts();
  assert.ok(actual, "production store did not publish the expected lifecycle fact");
  assert.deepEqual({
    sourceEventId: actual.sourceEventId, coverageEpochId: actual.coverageEpochId, observedAtMs: actual.observedAtMs,
    sessionId: actual.sessionId, threadId: actual.threadId, providerTurnId: actual.providerTurnId,
    principalId: actual.principalId, projectId: actual.projectId, environmentId: actual.environmentId, providerId: actual.providerId, providerModel: actual.providerModel,
    revision: actual.revision, evidenceKind: actual.evidenceKind, status: actual.status,
    activationObservability: actual.activationObservability, captureTrigger: actual.captureTrigger,
    providerEventId: actual.providerEventId, failure: actual.failure,
  }, expectedLifecycle(event), "production lifecycle projection differs from independently derived expectation");
}

function positiveMigrationAndProjection(): void {
  const temporary = temporaryDatabase();
  try {
    const db = createPreSkillDatabase(temporary.path);
    const preserved = legacySnapshot(db);
    upgradeAtomically(db);
    assertLegacySnapshot(db, preserved);
    const store = new AnalyticsStore(db);
    assert.deepEqual(store.readSkillProjectionState(), { projectionVersion: 0, generationId: 0, publishedAtMs: null, sourceDigest: null });
    assert.deepEqual(store.initializeSkillProjectionCoverage(1_000), expectedInitialCoverage, "migration must begin with prospective unknown coverage");
    assert.deepEqual(store.openSkillCoverageEpoch(expectedCoverage[2]!), expectedCoverage, "opening observed coverage must close only the prospective unknown interval");
    const event = sourceEvent();
    const projected = projectSkillObservation(event, expectedCoverage, authoritativeDimensions);
    store.commitSkillProjection({
      observations: [projected], coverageEpochs: expectedCoverage, completedAtMs: 1_300,
      sourceDigest: sourceDigest(event), projectionVersion: SKILL_FACT_PROJECTION_VERSION,
    });
    assertLifecycle(store, event);
    assert.equal(store.listActiveSkillMeasurementFacts().length, 0);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM analytics_skill_source_events_v1").get() as { count: number }).count, 1);
    const firstFacts = store.listActiveSkillLifecycleFacts();
    store.commitSkillProjection({
      observations: [projected], coverageEpochs: expectedCoverage, completedAtMs: 1_400,
      sourceDigest: sourceDigest(event), projectionVersion: SKILL_FACT_PROJECTION_VERSION,
    });
    assert.deepEqual(store.listActiveSkillLifecycleFacts(), firstFacts, "replayed event changed active facts");
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM analytics_skill_source_events_v1").get() as { count: number }).count, 1, "replayed event was stored twice");
    const beforeConflict = {
      lifecycle: store.listActiveSkillLifecycleFacts(), state: store.readSkillProjectionState(),
      sources: db.prepare("SELECT source_event_id,source_digest,active_generation FROM analytics_skill_source_events_v1 ORDER BY source_event_id").all(),
    };
    const conflicting = { ...event, createdAt: 1_201 };
    assert.throws(() => store.commitSkillProjection({
      observations: [projectSkillObservation(conflicting, expectedCoverage, authoritativeDimensions)], coverageEpochs: expectedCoverage,
      completedAtMs: 1_500, sourceDigest: sourceDigest(conflicting), projectionVersion: SKILL_FACT_PROJECTION_VERSION,
    }), /Conflicting duplicate skill source event/u);
    assert.deepEqual(store.listActiveSkillLifecycleFacts(), beforeConflict.lifecycle, "conflicting duplicate partially unpublished the prior lifecycle fact");
    assert.deepEqual(store.readSkillProjectionState(), beforeConflict.state, "conflicting duplicate advanced publication state");
    assert.deepEqual(db.prepare("SELECT source_event_id,source_digest,active_generation FROM analytics_skill_source_events_v1 ORDER BY source_event_id").all(), beforeConflict.sources, "conflicting duplicate changed source rows");
    db.close();
    const reopened = new Database(temporary.path);
    const reopenedStore = new AnalyticsStore(reopened);
    assert.deepEqual(reopenedStore.listSkillCoverageEpochs(), expectedCoverage, "reopen changed coverage epochs");
    assertLifecycle(reopenedStore, event);
    assertLegacySnapshot(reopened, preserved);
    reopened.close();
  } finally {
    rmSync(temporary.directory, { recursive: true, force: true });
  }
}

function interruptedMigrationFailsClosed(): void {
  const temporary = temporaryDatabase();
  try {
    const db = createPreSkillDatabase(temporary.path);
    const preserved = legacySnapshot(db);
    assert.throws(() => upgradeAtomically(db, SKILL_FACT_PROJECTION_MIGRATION_START + 1), /controlled interrupted skill migration/u);
    assertLegacySnapshot(db, preserved);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name LIKE 'analytics_skill_%'").get() as { count: number }).count, 0, "interrupted transactional migration published skill tables");
    db.close();
  } finally {
    rmSync(temporary.directory, { recursive: true, force: true });
  }
}

function partialPublicationFailsClosed(): void {
  const temporary = temporaryDatabase();
  try {
    const db = createPreSkillDatabase(temporary.path);
    db.exec(analyticsMigrations[SKILL_FACT_PROJECTION_MIGRATION_START]!);
    const partialStore = new AnalyticsStore(db);
    assert.throws(() => partialStore.initializeSkillProjectionCoverage(1_000), /no such table: analytics_skill_coverage_epochs_v1/u, "a partially published schema must not claim coverage");
    db.close();
    rmSync(temporary.path, { force: true });

    const complete = createPreSkillDatabase(temporary.path);
    upgradeAtomically(complete);
    const store = new AnalyticsStore(complete);
    store.initializeSkillProjectionCoverage(1_000);
    store.openSkillCoverageEpoch(expectedCoverage[2]!);
    const event = sourceEvent(true);
    const projected = projectSkillObservation(event, expectedCoverage, authoritativeDimensions);
    store.commitSkillProjection({ observations: [projected], coverageEpochs: expectedCoverage, completedAtMs: 1_300, sourceDigest: sourceDigest(event), projectionVersion: SKILL_FACT_PROJECTION_VERSION });
    const before = {
      lifecycle: store.listActiveSkillLifecycleFacts(),
      state: store.readSkillProjectionState(),
      source: complete.prepare("SELECT source_event_id,active_generation FROM analytics_skill_source_events_v1").all(),
    };
    complete.exec("DROP TABLE analytics_skill_measurement_facts_v1");
    assert.throws(() => store.commitSkillProjection({ observations: [projected], coverageEpochs: expectedCoverage, completedAtMs: 1_400, sourceDigest: sourceDigest(event), projectionVersion: SKILL_FACT_PROJECTION_VERSION }), /no such table: analytics_skill_measurement_facts_v1/u);
    assert.deepEqual(store.listActiveSkillLifecycleFacts(), before.lifecycle, "partial publication failure altered active lifecycle facts");
    assert.deepEqual(store.readSkillProjectionState(), before.state, "partial publication failure advanced projection state");
    assert.deepEqual(complete.prepare("SELECT source_event_id,active_generation FROM analytics_skill_source_events_v1").all(), before.source, "partial publication failure changed source activation");
    complete.close();
  } finally {
    rmSync(temporary.directory, { recursive: true, force: true });
  }
}

function main(): void {
  positiveMigrationAndProjection();
  interruptedMigrationFailsClosed();
  partialPublicationFailsClosed();
  process.stdout.write(`${JSON.stringify({ status: "pass", checks: ["pre-skill-sqlite-migration", "prospective-and-observed-coverage", "reopen-and-idempotence", "duplicate-and-interrupted-fail-closed", "partial-publication-fail-closed"] })}\n`);
}

main();
