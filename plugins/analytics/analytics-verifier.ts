import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type AnalyticsBundle } from "./bundle-contract.ts";
import {
  EXECUTION_LIMITS,
  resolvedExecutionSchema,
} from "./execution-contract.ts";
import { createQueryRuntime } from "./query-runtime/index.mjs";
import { parseAnalyticsQuery } from "./sql-policy.ts";

const REVISION = "0".repeat(64);
const NOW = 1_728_000_000_000;

export interface AnalyticsBundleVerification {
  bundleId: string;
  queryCount: number;
  visualizationCount: number;
}

/** Same isolated parser/bootstrap/binding path as ordinary execution. */
export async function verifyAnalyticsBundle(
  bundle: AnalyticsBundle,
): Promise<AnalyticsBundleVerification> {
  const fixture = await createVerifierFixture();
  let runtime: Awaited<ReturnType<typeof createQueryRuntime>> | undefined;
  let failed = false;
  try {
    runtime = await createQueryRuntime({ trustedSource: fixture.handoff });
    const queryColumns = new Map<string, Set<string>>();
    for (const query of bundle.queries) {
      const policy = parseAnalyticsQuery(query.sql);
      const parameters = policy.parameters.map((name) => ({
        name,
        logicalType: "integer" as const,
        value: 14,
      }));
      const admitted = await runtime.admitQuery({
        sql: query.sql,
        parameters,
        cacheability: "stable",
      });
      if (admitted.kind !== "admitted") {
        throw new Error(
          `Query ${query.id} failed isolated admission: ${admitted.error.message}`,
        );
      }
      const resolved = resolvedExecutionSchema.parse({
        version: 2,
        executionId: `analytics-exec_verifier_${bundle.id}_${query.id}`,
        snapshot: fixture.snapshot,
        bundleId: bundle.id,
        bundleRevision: REVISION,
        query: {
          id: query.id,
          revision: REVISION,
          title: query.title,
          sql: query.sql,
          maxRows: query.maxRows,
          ...admitted.admission,
          resultContractRevision: REVISION,
          parameters,
        },
      });
      const outcome = await runtime.worker.execute({
        resolved,
        source: fixture.handoff,
      }, new AbortController().signal);
      if (outcome.kind === "error") {
        throw new Error(
          `Query ${query.id} failed DuckDB verification: ${outcome.error.message}`,
        );
      }
      queryColumns.set(
        query.id,
        new Set(outcome.result.result.columns.map((column) => column.name)),
      );
    }
    for (const visualization of bundle.visualizations) {
      const columns = queryColumns.get(visualization.queryId);
      if (columns == null) {
        throw new Error(
          `Visualization ${visualization.id} references an unverified query.`,
        );
      }
      const fields = visualization.kind === "metric"
        ? [visualization.value]
        : visualization.kind === "table"
        ? visualization.columns.map((column) => column.field)
        : [visualization.x, visualization.y];
      for (const field of fields) {
        if (!columns.has(field)) {
          throw new Error(
            `Visualization ${visualization.id} references missing query column ${field}.`,
          );
        }
      }
    }
    return {
      bundleId: bundle.id,
      queryCount: bundle.queries.length,
      visualizationCount: bundle.visualizations.length,
    };
  } catch (cause) {
    failed = true;
    throw cause;
  } finally {
    let cleanupFailure: unknown;
    try {
      await runtime?.close();
    } catch (cause) {
      cleanupFailure = cause;
    }
    try {
      await fixture.cleanup();
    } catch (cause) {
      cleanupFailure ??= cause;
    }
    if (!failed && cleanupFailure !== undefined) throw cleanupFailure;
  }
}

async function createVerifierFixture() {
  const directory = await mkdtemp(join(tmpdir(), "analytics-verifier-"));
  const path = join(directory, "verification.sqlite");
  try {
    const sqlite = await import("node:sqlite");
    const db = new sqlite.DatabaseSync(path);
    try {
      db.exec(
        `CREATE TABLE analytics_index_state (singleton INTEGER PRIMARY KEY, generation_id INTEGER NOT NULL, fact_projection_version INTEGER NOT NULL, loaded_threads INTEGER NOT NULL, fact_count INTEGER NOT NULL, truncated_threads INTEGER NOT NULL, degraded INTEGER NOT NULL, snapshot_updated_at INTEGER); INSERT INTO analytics_index_state VALUES (1, 1, 1, 1, 1, 0, 0, ${NOW}); CREATE TABLE tool_execution_facts_v1 (source_event_id TEXT PRIMARY KEY, thread_id TEXT, turn_id TEXT, sequence INTEGER, project_id TEXT, provider_id TEXT, created_at_ms INTEGER, turn_started_at_ms INTEGER, turn_completed_at_ms INTEGER, capability_kind TEXT, capability_key TEXT, status TEXT, duration_ms INTEGER, failed INTEGER, error_class TEXT, error_signature TEXT, command_binary TEXT, command_argument_1 TEXT, command_argument_2 TEXT, command_uses_help INTEGER, command_shape TEXT, command_shell_wrapped INTEGER, command_attribution_eligible INTEGER);`,
      );
      db.prepare(
        `INSERT INTO tool_execution_facts_v1 VALUES ('verification', 'verification', 'verification', 1, 'verification', 'verification', ?, ?, ?, 'command', 'native:command_execution', 'completed', 0, 0, NULL, NULL, NULL, NULL, NULL, 0, NULL, 0, 0)`,
      ).run(NOW - 1_000, NOW - 2_000, NOW - 500);
    } finally {
      db.close();
    }
    const sourceScope = {
      scopeKey: "analytics-scope_verifier_fixture",
      projection: "tool_execution_fact_v1" as const,
      storage: "plugin-owned-sqlite" as const,
    };
    const range = { startInclusiveMs: NOW - 86_400_000, endExclusiveMs: NOW };
    const coverage = {
      coverageRevision: 1,
      retention: {
        startInclusiveMs: range.startInclusiveMs,
        earliestVerifiedRetainedInclusiveMs: range.startInclusiveMs,
        endExclusiveMs: NOW,
        policyDays: EXECUTION_LIMITS.retainedProjectionDays,
      },
      observed: {
        earliestFactMs: NOW - 1_000,
        latestFactMs: NOW - 1_000,
        asOfMs: NOW,
        projectionGeneration: 1,
        projectionRevision: REVISION,
      },
      population: {
        candidateThreads: 1,
        selectedThreads: 1,
        loadedThreads: 1,
        retainedFacts: 1,
        cappedThreads: 0,
        listPages: 1,
        eventPages: 1,
        eventBytes: 1,
        safeFailureCount: 0,
        lastSafeFailureAtMs: null,
        candidateThreadLimit: 1,
        threadPageLimit: 1,
        eventPageLimit: 1,
        maxEventsPerThread: 1,
        maxEventBytes: 1,
      },
      mode: "complete-retained-projection" as const,
      incompleteReasons: [],
      backfill: {
        state: "complete" as const,
        direction: "newest-to-oldest" as const,
        completeRange: range,
        resumable: true,
      },
      reconciliation: {
        observedAsOfMs: NOW,
        lastFullReconciliationAtMs: NOW,
        deletionConfirmation: "confirmed" as const,
        sourceSemantics: "eventually-reconciled-observed-as-of" as const,
      },
      degraded: false,
    };
    const snapshot = {
      version: 2 as const,
      snapshotId: "analytics-snapshot_verifier_fixture",
      sourceScope,
      frozenRange: range,
      capturedAtMs: NOW,
      coverage,
    };
    const handoff = {
      kind: "node-sqlite-readonly" as const,
      sourceScope,
      snapshotId: snapshot.snapshotId,
      sourceGeneration: 1,
      factProjectionVersion: 1,
      readonlyDatabasePath: path,
      maxChunkBytes: EXECUTION_LIMITS.maxTransferChunkBytes,
      maxRowsPerChunk: EXECUTION_LIMITS.maxTransferRowsPerChunk,
    };
    return {
      snapshot,
      handoff,
      cleanup: () => rm(directory, { recursive: true, force: true }),
    };
  } catch (cause) {
    await rm(directory, { recursive: true, force: true });
    throw cause;
  }
}
