export function createExtractionFixture() {
  const threads = Array.from({ length: 201 }, (_, offset) => `thread-${offset + 1}`);
  return {
    id: "retained-union-reconcile-v2",
    threads,
    events: Object.fromEntries(threads.map((id) => [id, [{ sequence: 1, value: `${id}-v1` }]])),
    pageSize: 200,
    eventPageSize: 100,
    clock: 1_700_086_400_000,
    coverage: {
      mode: "partial-retained-projection",
      incompleteReasons: ["backfill-in-progress"],
      earliestVerifiedRetainedInclusiveMs: 1_700_000_000_000,
      endExclusiveMs: 1_700_086_400_000,
    },
  };
}

export const referenceFixture = Object.freeze({
  id: "authoritative-reference-v1",
  executionId: "analytics-exec_abcdefghijklmnop",
  visualizationId: "failures",
  targetDatumKey: "analytics-datum_abcdefghijklmnop_0",
  createdAtMs: 1_700_086_400_000,
  expiresAtMs: 1_700_172_800_000,
  rejected: ["forged-execution", "scope-mismatch", "unknown-datum", "expired-record"],
  bundle: { id: "tool-reliability", revision: "a".repeat(64) },
  query: { id: "problem-tools", revision: "b".repeat(64), sql: "SELECT capability_key, failures FROM tool_execution_fact_v1", parameters: [{ name: "days", logicalType: "integer", value: 7 }] },
  range: { startInclusiveMs: 1_700_000_000_000, endExclusiveMs: 1_700_086_400_000 },
  selectedRow: { capability_key: "read_file", failures: 3 },
  siblingVisualizations: ["failures", "failure-table"],
});

/** Exact accepted contract shape, copied/adapted from execution-contract fixture. */
export function createStoredExecutionRecordFixture() {
  const r = "a".repeat(64), range = { startInclusiveMs: 1700000000000, endExclusiveMs: 1700086400000 };
  const scope = { scopeKey: "analytics-scope_abcdefghijklmnop", projection: "tool_execution_fact_v1", storage: "plugin-owned-sqlite" };
  const coverage = { coverageRevision: 1, retention: { startInclusiveMs: 1692224000000, earliestVerifiedRetainedInclusiveMs: range.startInclusiveMs, endExclusiveMs: range.endExclusiveMs, policyDays: 90 }, observed: { earliestFactMs: range.startInclusiveMs, latestFactMs: range.startInclusiveMs, asOfMs: range.endExclusiveMs, projectionGeneration: 7, projectionRevision: r }, population: { candidateThreads: 200, selectedThreads: 80, loadedThreads: 80, retainedFacts: 1, cappedThreads: 0, listPages: 2, eventPages: 80, eventBytes: 100, safeFailureCount: 0, lastSafeFailureAtMs: null, candidateThreadLimit: 200, threadPageLimit: 200, eventPageLimit: 100, maxEventsPerThread: 500, maxEventBytes: 1000 }, mode: "partial-retained-projection", incompleteReasons: ["backfill-in-progress"], backfill: { state: "partial", direction: "newest-to-oldest", completeRange: null, resumable: true }, reconciliation: { observedAsOfMs: range.endExclusiveMs, lastFullReconciliationAtMs: null, deletionConfirmation: "pending-retry", sourceSemantics: "eventually-reconciled-observed-as-of" }, degraded: false };
  const snapshot = { version: 2, snapshotId: "analytics-snapshot_abcdefghijklmnop", sourceScope: scope, frozenRange: range, capturedAtMs: range.endExclusiveMs, coverage };
  const parameters = [{ name: "range_days", logicalType: "integer", value: 1 }];
  // Synthetic historical fixture digests for exact SQL and canonical sorted
  // name/type declarations; they are not parser or admission evidence.
  const query = { id: "problem-tools", revision: r, title: "Problem tools", sql: "SELECT capability_key, failures FROM tool_execution_fact_v1", maxRows: 500, astNodeCount: 9, astPolicyRevision: r, sqlSha256: "1d648def66363ac50ab673eba7b12531c3f741fd5be3059ea8a8fcf713ad7b33", parameterDeclarationDigest: "ee21d05ca4b025cd5ec59203ed861f790a5517310aa4c096c25ec3a7f0f51ac0", resultContractRevision: r, cacheability: "stable", parameters };
  const resolved = { version: 2, executionId: "analytics-exec_abcdefghijklmnop", snapshot, bundleId: "tool-reliability", bundleRevision: r, query };
  const result = { columns: [{ name: "capability_key", logicalType: "utf8", nullable: false }, { name: "failures", logicalType: "integer", nullable: false }, { name: "failure_rate", logicalType: "float64", nullable: false }], rows: [{ capability_key: "read_file", failures: 3, failure_rate: 12.5 }], datumKeys: ["analytics-datum_abcdefghijklmnop_0"], resultExtent: { kind: "exact", rows: 1 }, resultTruncated: false, encodedBytes: 392 };
  const execution = { version: 2, executionId: resolved.executionId, resolved, coverage, result, startedAtMs: range.endExclusiveMs, completedAtMs: range.endExclusiveMs + 12, elapsedMs: 12, cache: { status: "miss", physicalExecutionKey: "analytics-physical_abcdefghijklmnop" } };
  const definition = { bundle: { id: "tool-reliability", version: 1, revision: r, title: "Tool reliability", description: "Observe tool reliability.", loader: { id: "recent-capability-facts-v1", label: "Recent facts", maxAgeMs: 3600000, staleWhileRefresh: true } }, query, figures: [{ visualization: { id: "failures", queryId: "problem-tools", kind: "bar", title: "Failures", x: "capability_key", y: "failures", format: "integer", layoutPosition: 0 }, plotted: { plottedRows: 1, total: { kind: "exact", rows: 1 }, reduction: "none" } }] };
  return { version: 2, result: execution, snapshot, definition, createdAtMs: execution.completedAtMs, expiresAtMs: execution.completedAtMs + 86400000 };
}

export const migrationFixture = Object.freeze({
  id: "migration-package-boundary-v1",
  priorStore: {
    migrationSql: [
      "CREATE TABLE analytics_bundles (id TEXT PRIMARY KEY NOT NULL, version INTEGER NOT NULL, title TEXT NOT NULL, source_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL) STRICT",
      "CREATE TABLE analytics_index_state (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), status TEXT NOT NULL, started_at INTEGER, completed_at INTEGER, loaded_threads INTEGER NOT NULL DEFAULT 0, fact_count INTEGER NOT NULL DEFAULT 0, truncated_threads INTEGER NOT NULL DEFAULT 0, duration_ms INTEGER, error TEXT) STRICT",
      "INSERT INTO analytics_index_state (singleton, status) VALUES (1, 'empty')",
    ],
    rows: { analytics_index_state: [{ singleton: 1, status: "ready", loaded_threads: 1, fact_count: 1, truncated_threads: 0 }], tool_execution_facts_v1: [{ source_event_id: "event-1", thread_id: "thread-1", turn_id: null, sequence: 1, project_id: "project-1", provider_id: "provider-1", created_at_ms: 1_700_000_000_000, capability_kind: "tool", capability_key: "read_file", status: "success", duration_ms: 3, failed: 0, error_class: null, error_signature: null }] },
  },
  legacyBundle: { version: 1, id: "tool-reliability", title: "Legacy bundle", description: "Legacy authored bundle.", loader: { id: "recent-capability-facts-v1", label: "Recent facts", maxAgeMs: 3600000, staleWhileRefresh: true }, queries: [{ id: "problem-tools", title: "Problem tools", sql: "SELECT capability_key, failures FROM tool_execution_fact_v1", maxRows: 100 }], visualizations: [{ id: "failure-table", queryId: "problem-tools", kind: "table", title: "Failures", columns: [{ field: "capability_key", label: "Capability", format: "text" }, { field: "failures", label: "Failures", format: "integer" }] }], layout: [{ visualizationId: "failure-table", width: "full" }] },
  legacyReference: { version: 1, id: "legacy/id:✓", token: "analytics-ref:v1:history", createdAt: 1.5, bundleId: "Tool Reliability / old", bundleTitle: "Tool reliability 🧪", queryId: "problem tools", queryTitle: "Problem tools", querySql: "SELECT failures FROM tool_execution_fact_v1", visualizationId: "failure chart", visualizationTitle: "Failures", visualizationKind: "bar", resultGeneration: "legacy-result", snapshotGenerationId: 1, snapshotUpdatedAt: 2, rangeDays: 14, coverage: { kind: "exact", rows: 1 }, selection: { datumKey: "legacy datum", label: "read_file 🧪", row: { failures: 3.25 }, predicate: { field: "capability key", operator: "eq", value: "read_file" } } },
  cases: [
    "legacy-v1-capsule-preserved-unverified",
    "legacy-authored-bundle-preserved",
    "prior-fact-store-recovery",
    "worker-reload-recovery",
    "rollback-artifacts-retained",
    "clean-package-manifest",
    "identity-unavailable-denied",
  ],
});
