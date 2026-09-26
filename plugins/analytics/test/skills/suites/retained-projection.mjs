import assert from "node:assert/strict";
import { createPreSkillStore, projectionEvents, revisionOne, revisionTwo } from "../fixtures/projection/pre-skill-store.mjs";
import {
  assertPreservedArtifacts,
  openCoverageEpoch,
  projectEvent,
  reconcileStore,
  reopenStore,
  upgradePreSkillStore,
} from "../projection/retained-projection.mjs";

const controls = new Set(["duplicate-event", "interrupted-migration"]);

function projectedStore() {
  let store = upgradePreSkillStore(createPreSkillStore());
  store = openCoverageEpoch(store, { id: "coverage-observed-1100", startedAtMs: 1100, lifecycle: "observed", activation: "observed" });
  return store;
}

function duplicateEventNegative() {
  let store = projectedStore();
  store = projectEvent(store, projectionEvents.first).store;
  const corrupted = structuredClone(store);
  corrupted.skillSourceEvents.push(structuredClone(projectionEvents.first));
  assert.throws(() => reconcileStore(corrupted), /duplicate source event/u);
}

function interruptedMigrationNegative() {
  const prior = createPreSkillStore();
  const before = structuredClone(prior);
  assert.throws(() => upgradePreSkillStore(prior, { beforeCommit: () => { throw new Error("controlled-interruption"); } }), /controlled-interruption/u);
  assert.deepEqual(prior, before, "interrupted upgrade mutated the pre-skill store");
  const unsafe = structuredClone(before);
  unsafe.schemaVersion = 8;
  assert.throws(() => assert.deepEqual(unsafe, before), /Expected values to be strictly deep-equal/u);
}

function positiveProjection() {
  const prior = createPreSkillStore();
  const baseline = structuredClone(prior);
  let store = upgradePreSkillStore(prior);
  assert.deepEqual(prior, baseline, "upgrade must not mutate its pre-skill input");
  assertPreservedArtifacts(baseline, store);
  assert.deepEqual(store.migrationLog, [...baseline.migrationLog, "skill-projection-v1"]);
  assert.deepEqual(store.coverageEpochs, [
    { id: "coverage-pre-skill", startedAtMs: 0, endedAtMs: 1000, lifecycle: "pre-instrumentation", activation: "pre-instrumentation" },
    { id: "coverage-prospective-1000", startedAtMs: 1000, endedAtMs: null, lifecycle: "unknown", activation: "unknown" },
  ]);
  store = openCoverageEpoch(store, { id: "coverage-observed-1100", startedAtMs: 1100, lifecycle: "observed", activation: "observed" });
  assert.equal(store.coverageEpochs[1].endedAtMs, 1100, "prospective unknown coverage must not be rewritten as observed");
  store = projectEvent(store, projectionEvents.first).store;
  const duplicate = projectEvent(store, projectionEvents.first);
  assert.equal(duplicate.duplicateIgnored, true, "identical event retry must be idempotent");
  store = duplicate.store;
  store = projectEvent(store, projectionEvents.changedRevision).store;
  assert.equal(store.skillLifecycleFacts.length, 2, "changed revision must retain a second exact fact");
  assert.notEqual(store.skillLifecycleFacts[0].revisionKey, store.skillLifecycleFacts[1].revisionKey, "revision identity must include exact content revisions");
  assert.equal(store.skillLifecycleFacts.find((fact) => fact.sourceEventId === projectionEvents.changedRevision.eventId).providerTurnId, null, "nullable turn identity must survive projection");
  assert.deepEqual(store.skillLifecycleFacts.map((fact) => fact.revision.skillMarkdownRevision).sort(), [revisionOne.skillMarkdownRevision, revisionTwo.skillMarkdownRevision].sort());
  store = projectEvent(store, projectionEvents.deleteFirst).store;
  assert.deepEqual(store.skillLifecycleFacts.map((fact) => fact.sourceEventId), [projectionEvents.changedRevision.eventId], "deletion must reconcile stale source facts away");
  const reopened = reopenStore(store);
  assert.deepEqual(reopened, store, "restart must preserve exact append-only projection state");
  assert.deepEqual(upgradePreSkillStore(reopened), reopened, "reopened migrated stores must be idempotent");
}

export async function runSuite(options = {}) {
  const requested = options.negativeControls ?? [];
  for (const control of requested) assert.ok(controls.has(control), `unknown retained-projection negative control ${control}`);
  positiveProjection();
  duplicateEventNegative();
  interruptedMigrationNegative();
  return {
    suite: "retained-projection",
    status: "pass",
    checks: [
      { id: "pre-skill-upgrade-preserves-existing-artifacts", status: "pass", details: "A concrete pre-skill store upgrades append-only while tool_execution_fact_v1 rows and saved bundle/reference bytes remain exact." },
      { id: "prospective-coverage-epochs", status: "pass", details: "Pre-instrumentation and the unknown prospective interval remain distinct until a later observed epoch opens." },
      { id: "revision-duplicate-delete-reconciliation", status: "pass", details: "Exact changed revisions remain separate, retries are idempotent, and deletion removes only its targeted materialized fact." },
      { id: "restart-nullable-turn-and-idempotence", status: "pass", details: "A nullable provider turn, append-only source log, migration version, and reconciled facts survive reopen and repeat upgrade." },
      { id: "duplicate-event-negative-control", status: "pass", details: "A deliberately duplicated source event actually fails reconciliation." },
      { id: "interrupted-migration-negative-control", status: "pass", details: "An injected before-commit interruption preserves the original store; a simulated in-place mutation actually fails equality." },
    ],
    observations: [
      { id: "pre-skill-history", kind: "coverage", status: "unknown", details: "History before the first projection epoch is pre-instrumentation, not zero skill usage." },
      { id: "nullable-session-report", kind: "identity", status: "observed", details: "A session-scoped projection row retains a null provider turn rather than inventing one." },
    ],
    limits: ["This independent instrument specifies the required retained-store invariants; the later projection implementation must bind to these same migration and reconciliation semantics."],
  };
}
