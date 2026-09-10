import { check, isInstrumentSelfTest, loadOptionalTestBinding, missingOperation, suiteResult } from "./data/common.mjs";
import { createExtractionFixture } from "./data/fixtures.mjs";
import { controlledExtractionOperations } from "./data/instrument-self-test-adapter.mjs";

function same(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
function ids(snapshot) { return snapshot.rows.map((row) => `${row.threadId}/${row.sequence}:${row.value}`).sort(); }
function invariant(id, predicate, details) { return check(id, predicate ? "pass" : "fail", details); }
async function pullUntil(projector, predicate, label, maxCalls = 4) {
  let last;
  for (let count = 0; count < maxCalls; count += 1) {
    await projector.pull({ maxThreads: 200, maxEventsPerThread: 500 });
    last = structuredClone(await projector.readPublishedSnapshot());
    if (predicate(last)) return last;
  }
  return last;
}
async function controlledFailure(action, expectedCode, testMessage) {
  try {
    const result = await action();
    if (result?.kind === "degraded" || result?.kind === "failed" || result?.code === expectedCode) return result;
    throw new Error(`Controlled ${expectedCode} did not return a typed degraded/failure outcome.`);
  } catch (error) {
    if (error?.code === expectedCode || String(error?.message).includes(testMessage)) return { kind: "thrown", code: expectedCode };
    throw error;
  }
}

/** Operation-level scenario: the test drives source mutations and inspects actual snapshots. */
export async function runExtractionScenario(operations) {
  const fixture = createExtractionFixture();
  fixture.events["thread-1"] = Array.from({ length: 501 }, (_, offset) => ({ sequence: offset + 1, value: `thread-1-v${offset + 1}` }));
  const source = operations.createPublicSource(fixture);
  const store = operations.createPersistentStore();
  let now = fixture.clock;
  const testPolicy = { pullFreshnessMs: 60_000 };
  const make = (persistenceFault = null) => operations.createProjector({ source, store, clock: () => now, policy: testPolicy, persistenceFault });
  let projector;
  try {
  projector = await make();
  const seed = await pullUntil(projector, (snapshot) => ids(snapshot).includes("thread-201/1:thread-201-v1") && ids(snapshot).includes("thread-1/501:thread-1-v501"), "seed");
  now += testPolicy.pullFreshnessMs + 1; source.append("thread-1", { sequence: 502, value: "appended" }); const appended = await pullUntil(projector, (snapshot) => ids(snapshot).includes("thread-1/502:appended"), "append");
  now += testPolicy.pullFreshnessMs + 1; source.rewrite("thread-201", 1, { value: "rewritten" }); const rewritten = await pullUntil(projector, (snapshot) => ids(snapshot).includes("thread-201/1:rewritten"), "rewrite");
  now += testPolicy.pullFreshnessMs + 1; source.omitFromList("thread-201"); await projector.pull({ maxThreads: 200, maxEventsPerThread: 500 }); const omitted = structuredClone(await projector.readPublishedSnapshot());
  now += testPolicy.pullFreshnessMs + 1; source.failNextRead(new Error("synthetic transient source failure")); const sourceFailure = await controlledFailure(() => projector.pull({ maxThreads: 200, maxEventsPerThread: 500 }), "source-read-failure", "synthetic transient"); const genericFailure = structuredClone(await projector.readPublishedSnapshot());
  now += testPolicy.pullFreshnessMs + 1; source.restoreToList("thread-201"); source.confirmNotFound("thread-201"); await projector.pull({ maxThreads: 200, maxEventsPerThread: 500 }); const deleted = structuredClone(await projector.readPublishedSnapshot());
  now += testPolicy.pullFreshnessMs + 1; source.append("thread-1", { sequence: 503, value: "interrupted" }); await projector.dispose(); projector = await make("before-publication"); await controlledFailure(() => projector.pull({ maxThreads: 200, maxEventsPerThread: 500 }), "persistence-failure", "injected before publication"); const beforePublication = structuredClone(await projector.readPublishedSnapshot()); await projector.dispose(); projector = await make("after-rows-before-checkpoint"); await controlledFailure(() => projector.pull({ maxThreads: 200, maxEventsPerThread: 500 }), "persistence-failure", "injected after rows"); const afterRowsBeforeCheckpoint = structuredClone(await projector.readPublishedSnapshot()); await projector.dispose(); projector = await make(); const replay = await pullUntil(projector, (snapshot) => ids(snapshot).includes("thread-1/503:interrupted"), "replay");
  const seedIds = ids(seed), appendedIds = ids(appended), rewrittenIds = ids(rewritten), deletedIds = ids(deleted), replayIds = ids(replay);
  return [
    invariant("retained-union-beyond-200-threads-and-500-events", seedIds.includes("thread-201/1:thread-201-v1") && seedIds.includes("thread-1/501:thread-1-v501"), "Actual published rows retain the 201st thread and 501st event."),
    invariant("incremental-append-and-full-rewrite", appendedIds.includes("thread-1/502:appended") && rewrittenIds.includes("thread-201/1:rewritten") && !rewrittenIds.includes("thread-201/1:thread-201-v1"), "Actual rows include append/replace without obsolete projection."),
    invariant("list-omission-and-generic-failure-are-not-delete", same(ids(omitted), rewrittenIds) && same(ids(genericFailure), rewrittenIds), "List omission or generic failure changed actual retained rows."),
    invariant("failed-read-is-explicitly-degraded-or-typed", sourceFailure?.kind === "thrown" || sourceFailure?.kind === "degraded" || sourceFailure?.kind === "failed" || sourceFailure?.code === "source-read-failure" || genericFailure.coverage?.degraded === true, "Generic source failure was neither surfaced as a typed outcome nor reflected in degraded coverage."),
    invariant("exact-404-reconciles-delete", !deletedIds.some((id) => id.startsWith("thread-201/")), "Confirmed not-found did not remove actual retained thread."),
    invariant("publication-checkpoint-atomic-across-interruption-and-replay", same(ids(beforePublication), deletedIds) && same(beforePublication.checkpoint, deleted.checkpoint) && same(afterRowsBeforeCheckpoint, deleted) && replayIds.includes("thread-1/503:interrupted") && replay.checkpoint.generation > deleted.checkpoint.generation, "Actual rows/checkpoint diverged across interruption or replay."),
    invariant("injected-failures-were-reached", source.getInjectedFailureCount() === 1 && store.getInjectedWriteFailureCount() === 2, "Controlled source/persistence failure points were not actually reached."),
    invariant("honest-coverage", replay.coverage.mode === fixture.coverage.mode && same(replay.coverage.incompleteReasons, fixture.coverage.incompleteReasons) && replay.coverage.earliestVerifiedRetainedInclusiveMs === fixture.coverage.earliestVerifiedRetainedInclusiveMs, "Actual coverage misstates controlled partial backfill."),
  ];
  } finally { if (projector != null) await projector.dispose(); }
}

async function selfTest() {
  const controls = { "drop-201st-thread": "retained-union-beyond-200-threads-and-500-events", "drop-501st-event": "retained-union-beyond-200-threads-and-500-events", "ignore-append": "incremental-append-and-full-rewrite", "ignore-rewrite": "incremental-append-and-full-rewrite", "delete-on-omission": "list-omission-and-generic-failure-are-not-delete", "delete-on-generic-failure": "list-omission-and-generic-failure-are-not-delete", "ignore-404": "exact-404-reconciles-delete", "partial-publication": "publication-checkpoint-atomic-across-interruption-and-replay", "dishonest-coverage": "honest-coverage" };
  const positive = await runExtractionScenario(controlledExtractionOperations());
  const negative = await Promise.all(Object.entries(controls).map(async ([fault, oracle]) => {
    const checks = await runExtractionScenario(controlledExtractionOperations({ fault }));
    return check(`instrument-self-test-${fault}`, checks.find((item) => item.id === oracle)?.status === "fail" ? "pass" : "fail", `Deliberately wrong operation result must fail ${oracle}.`);
  }));
  return suiteResult("extraction", [check("instrument-self-test-positive", positive.every((item) => item.status === "pass") ? "pass" : "fail", "Operation-level controlled positive scenario."), ...negative], ["instrument-self-test only; controlled operation doubles are not production evidence"]);
}

async function loadOperations() { return loadOptionalTestBinding("extraction"); }

export async function runSuite(options = {}) {
  if (isInstrumentSelfTest(options)) return selfTest();
  const binding = await loadOperations();
  if (binding.kind === "defect") return suiteResult("extraction", [check("production-extraction-binding-defect", "fail", binding.details)]);
  if (binding.kind === "absent") return suiteResult("extraction", [check("missing-production-extraction-operations", "blocked", `${binding.details} ${missingOperation("extraction", "createPublicSource/createPersistentStore/createProjector({ source, store, clock, persistenceFault }) -> pull/readPublishedSnapshot/dispose").details}`)], ["Normal mode will execute runExtractionScenario unchanged when its test-owned real-operation binding is available."]);
  return suiteResult("extraction", await runExtractionScenario(binding.operations));
}
