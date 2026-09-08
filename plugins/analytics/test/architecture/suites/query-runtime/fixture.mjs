import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const now = 1_728_000_000_000;
const revision = "b".repeat(64);
const sourceScope = Object.freeze({ scopeKey: "analytics-scope_acceptance_runtime", projection: "tool_execution_fact_v1", storage: "plugin-owned-sqlite" });

/** Test-owned fixture using the existing AnalyticsStore migrations and commit API. */
export async function createOwnStoreFixture() {
  const directory = await mkdtemp(join(tmpdir(), "analytics-query-runtime-"));
  let database;
  let transferred = false;
  try {
    const [{ AnalyticsStore, analyticsMigrations }, { FACT_PROJECTION_VERSION }, databaseModule] = await Promise.all([import("../../../../store.ts"), import("../../../../fact-projection.ts"), import("better-sqlite3")]);
    const Database = databaseModule.default;
    if (typeof Database !== "function" || typeof AnalyticsStore !== "function" || !Array.isArray(analyticsMigrations) || !Number.isSafeInteger(FACT_PROJECTION_VERSION) || FACT_PROJECTION_VERSION < 1)
      return { kind: "missing-boundary", details: "Existing AnalyticsStore migration surface is unavailable for the test-owned fixture." };
    const path = join(directory, "analytics.sqlite");
    database = new Database(path);
    for (const migration of analyticsMigrations) database.exec(migration);
    const store = new AnalyticsStore(database);
    // Keep one fact in the narrow recent range and one only in the older range.
    // Range assertions must therefore prove physical filtering, rather than
    // merely observe distinct cache keys for scalar statements.
    const includedFact = fact({ sourceEventId: "acceptance-event-in-range", sequence: 1, capabilityKey: "bb:read_file", createdAtMs: now - 1_000, durationMs: 1_500 });
    const excludedFact = fact({ sourceEventId: "acceptance-event-out-of-range", sequence: 2, capabilityKey: "bb:write_file", createdAtMs: now - 12_000, durationMs: 900 });
    store.commitSnapshot({ completedAt: now, durationMs: 1, selectedThreadIds: [includedFact.threadId], threads: [{ threadId: includedFact.threadId, projectId: includedFact.projectId, providerId: includedFact.providerId, updatedAt: now, outcome: "loaded", facts: [includedFact, excludedFact], maxObservedSeq: excludedFact.sequence, truncated: false }], loadedThreads: 1, factCount: 2, truncatedThreads: 0, degraded: false, lastError: null, factsChanged: true, lastFullReconciliationAt: now, factProjectionVersion: FACT_PROJECTION_VERSION });
    const makeSnapshot = (range = { startInclusiveMs: now - 86_400_000, endExclusiveMs: now }) => snapshotFor(store.getIndexState(), range, path);
    const initial = makeSnapshot();
    transferred = true;
    return { kind: "ready", fixture: { ...initial, makeSnapshot, cleanup: async () => { try { database?.close(); } finally { await rm(directory, { recursive: true, force: true }); } } } };
  } catch (cause) {
    return { kind: "failure", details: "Test-owned AnalyticsStore fixture setup failed: " + errorText(cause) };
  } finally {
    if (!transferred) {
      try { database?.close(); } finally { await rm(directory, { recursive: true, force: true }); }
    }
  }
}

function snapshotFor(state, range, path) {
  const snapshotId = "analytics-snapshot_acceptance_runtime_" + state.generationId;
  const coverage = {
    coverageRevision: state.generationId,
    retention: { startInclusiveMs: now - 86_400_000, earliestVerifiedRetainedInclusiveMs: now - 86_400_000, endExclusiveMs: now, policyDays: 90 },
    observed: { earliestFactMs: now - 12_000, latestFactMs: now - 1_000, asOfMs: now, projectionGeneration: state.generationId, projectionRevision: revision },
    population: { candidateThreads: 1, selectedThreads: 1, loadedThreads: state.loadedThreads, retainedFacts: state.factCount, cappedThreads: state.truncatedThreads, listPages: 1, eventPages: 1, eventBytes: 1, safeFailureCount: 0, lastSafeFailureAtMs: null, candidateThreadLimit: 1, threadPageLimit: 1, eventPageLimit: 1, maxEventsPerThread: 1, maxEventBytes: 1 },
    mode: "complete-retained-projection",
    incompleteReasons: [],
    backfill: { state: "complete", direction: "newest-to-oldest", completeRange: { startInclusiveMs: now - 86_400_000, endExclusiveMs: now }, resumable: true },
    reconciliation: { observedAsOfMs: now, lastFullReconciliationAtMs: state.lastFullReconciliationAt, deletionConfirmation: "confirmed", sourceSemantics: "eventually-reconciled-observed-as-of" },
    degraded: state.degraded,
  };
  return { snapshot: { version: 2, snapshotId, sourceScope, frozenRange: range, capturedAtMs: now, coverage }, handoff: { kind: "node-sqlite-readonly", sourceScope, snapshotId, sourceGeneration: state.generationId, factProjectionVersion: state.factProjectionVersion, readonlyDatabasePath: path, maxChunkBytes: 256 * 1024, maxRowsPerChunk: 1_000 } };
}

function errorText(cause) { return cause instanceof Error ? cause.message : String(cause); }

function fact(overrides) {
  return {
    threadId: "acceptance-thread-1",
    turnId: "acceptance-turn-1",
    projectId: "acceptance-project",
    providerId: "acceptance-provider",
    turnStartedAtMs: now - 13_000,
    turnCompletedAtMs: now - 500,
    capabilityKind: "tool",
    status: "completed",
    failed: false,
    errorClass: null,
    errorSignature: null,
    commandBinary: null,
    commandArgument1: null,
    commandArgument2: null,
    commandUsesHelp: false,
    commandShape: null,
    commandShellWrapped: false,
    commandAttributionEligible: false,
    ...overrides,
  };
}
