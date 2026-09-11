import { analyticsBundleSchema, type AnalyticsBundle } from "../../../../bundle-contract.ts";
import {
  canonicalResultWireBytes,
  deriveExecutionDatumKeys,
  executionDefinitionSchema,
  executionLocatorSchema,
  executionResultSchema,
  executeQueryResponseSchema,
  type ExecutionDefinition,
  type ExecutionResult,
  type ExecutionLocator,
} from "../../../../execution-contract.ts";
import type { AnalyticsBundleResponse, AnalyticsExecuteQueryResponse } from "../../../../rpc-contract.ts";

type AuthoredRow = Readonly<{ capability_key: string; failures: number }>;
type AuthoredChartVisualizationBase = Extract<AnalyticsBundle["visualizations"][number], { kind: "bar" | "line" }>;
type AuthoredChartVisualization = AuthoredChartVisualizationBase &
  Readonly<{ format: Exclude<AuthoredChartVisualizationBase["format"], "text"> }>;

const RANGE = Object.freeze({
  startInclusiveMs: 1_700_000_000_000,
  endExclusiveMs: 1_700_086_400_000,
});
const PARAMETERS = Object.freeze([
  { name: "include_retries", logicalType: "boolean", value: true },
  { name: "range_days", logicalType: "integer", value: 1 },
]);
const A_REVISION = "a".repeat(64);
const B_REVISION = "b".repeat(64);
const C_REVISION = "c".repeat(64);

const COLUMNS = Object.freeze([
  { name: "capability_key", logicalType: "utf8", nullable: false },
  { name: "failures", logicalType: "integer", nullable: false },
] as const);

export type StaleEventRevision = Readonly<{
  bundle: AnalyticsBundleResponse;
  locators: Readonly<Record<string, ExecutionLocator>>;
  responses: ReadonlyMap<string, AnalyticsExecuteQueryResponse>;
  rows: readonly AuthoredRow[];
  visibleDatumText: string;
  executionId: string;
  datumKeys: readonly string[];
  kind: "bar" | "line";
}>;

export type StaleEventBrowserCase = Readonly<{
  a: StaleEventRevision;
  b: StaleEventRevision;
  c: StaleEventRevision;
  expected: Readonly<{
    bundleId: string;
    queryId: string;
    range: typeof RANGE;
    parameters: typeof PARAMETERS;
    aLabels: readonly string[];
    bLabels: readonly string[];
    cLabels: readonly string[];
    aExecutionId: string;
    bExecutionId: string;
    cExecutionId: string;
    aDatumKeys: readonly string[];
    bDatumKeys: readonly string[];
    cDatumKeys: readonly string[];
  }>;
}>;

type AuthoredExecution = Readonly<{
  execution: ExecutionResult;
  definition: ExecutionDefinition;
}>;

function coverage(capturedAtMs: number, projectionGeneration: number, revision: string) {
  return {
    coverageRevision: projectionGeneration,
    retention: {
      startInclusiveMs: RANGE.startInclusiveMs,
      earliestVerifiedRetainedInclusiveMs: RANGE.startInclusiveMs,
      endExclusiveMs: capturedAtMs,
      policyDays: 90 as const,
    },
    observed: {
      earliestFactMs: RANGE.startInclusiveMs,
      latestFactMs: RANGE.endExclusiveMs,
      asOfMs: capturedAtMs,
      projectionGeneration,
      projectionRevision: revision,
    },
    population: {
      candidateThreads: 2,
      selectedThreads: 2,
      loadedThreads: 2,
      retainedFacts: 2,
      cappedThreads: 0,
      listPages: 1,
      eventPages: 1,
      eventBytes: 128,
      safeFailureCount: 0,
      lastSafeFailureAtMs: null,
      candidateThreadLimit: 200,
      threadPageLimit: 200,
      eventPageLimit: 100,
      maxEventsPerThread: 500,
      maxEventBytes: 1_000,
    },
    mode: "partial-retained-projection" as const,
    incompleteReasons: ["backfill-in-progress" as const],
    backfill: {
      state: "partial" as const,
      direction: "newest-to-oldest" as const,
      completeRange: null,
      resumable: true,
    },
    reconciliation: {
      observedAsOfMs: capturedAtMs,
      lastFullReconciliationAtMs: null,
      deletionConfirmation: "pending-retry" as const,
      sourceSemantics: "eventually-reconciled-observed-as-of" as const,
    },
    degraded: false,
  };
}

function fixtureBundle(kind: "bar" | "line"): AnalyticsBundle {
  return analyticsBundleSchema.parse({
    version: 1,
    id: "stale-event-proof",
    title: "Stale event proof",
    description: "Independent real-browser stale event identity fixture.",
    loader: {
      id: "recent-capability-facts-v1",
      label: "Stale event fixture source",
      maxAgeMs: 3_600_000,
      staleWhileRefresh: true,
    },
    queries: [{
      id: "failures",
      title: "Stale event failures",
      sql: "SELECT capability_key, failures FROM tool_execution_fact_v1",
      maxRows: 24,
    }],
    visualizations: [{
      id: "failures",
      queryId: "failures",
      kind,
      title: `Stale event ${kind}`,
      x: "capability_key",
      y: "failures",
      format: "integer",
    }],
    layout: [{ visualizationId: "failures", width: "full" }],
  });
}

function isAuthoredChartVisualization(
  value: AnalyticsBundle["visualizations"][number],
): value is AuthoredChartVisualization {
  return value.kind === "bar" || value.kind === "line";
}

function authoredExecution(
  bundle: AnalyticsBundle,
  revision: string,
  suffix: string,
  rows: readonly Record<string, unknown>[],
): AuthoredExecution {
  const executionId = `analytics-exec_stale_${suffix}`;
  const capturedAtMs = RANGE.endExclusiveMs + suffix.length;
  const sourceCoverage = coverage(capturedAtMs, suffix.length, revision);
  const query = bundle.queries[0];
  const visualization = bundle.visualizations[0];
  if (query == null || visualization == null) throw new Error("Stale event fixture is missing authored query or visualization.");
  if (!isAuthoredChartVisualization(visualization)) {
    throw new Error("Stale event fixture requires a non-text bar or line visualization.");
  }
  const resolvedQuery = {
    id: query.id,
    revision,
    title: query.title,
    sql: query.sql,
    maxRows: query.maxRows,
    astNodeCount: 9,
    astPolicyRevision: revision,
    sqlSha256: revision,
    parameterDeclarationDigest: revision,
    resultContractRevision: revision,
    cacheability: "stable" as const,
    parameters: PARAMETERS,
  };
  const resolved = {
    version: 2 as const,
    executionId,
    snapshot: {
      version: 2 as const,
      snapshotId: `analytics-snapshot_stale_${suffix}`,
      sourceScope: {
        scopeKey: `analytics-scope_stale_${suffix}`,
        projection: "tool_execution_fact_v1" as const,
        storage: "plugin-owned-sqlite" as const,
      },
      frozenRange: RANGE,
      capturedAtMs,
      coverage: sourceCoverage,
    },
    bundleId: bundle.id,
    bundleRevision: revision,
    query: resolvedQuery,
  };
  const resultCore = {
    columns: COLUMNS,
    rows,
    datumKeys: deriveExecutionDatumKeys(executionId, rows),
    resultExtent: { kind: "exact" as const, rows: rows.length },
    resultTruncated: false,
  };
  const execution = executionResultSchema.parse({
    version: 2,
    executionId,
    resolved,
    coverage: sourceCoverage,
    result: { ...resultCore, encodedBytes: canonicalResultWireBytes(resultCore) },
    startedAtMs: capturedAtMs,
    completedAtMs: capturedAtMs + 12,
    elapsedMs: 12,
    cache: { status: "miss", physicalExecutionKey: `analytics-physical_stale_${suffix}` },
  });
  const definition = executionDefinitionSchema.parse({
    bundle: {
      id: bundle.id,
      version: 1,
      revision,
      title: bundle.title,
      description: bundle.description,
      loader: bundle.loader,
    },
    query: execution.resolved.query,
    figures: [{
      visualization: {
        id: visualization.id,
        queryId: visualization.queryId,
        kind: visualization.kind,
        title: visualization.title,
        x: visualization.x,
        y: visualization.y,
        format: visualization.format,
        layoutPosition: 0,
      },
      plotted: {
        plottedRows: rows.length,
        total: execution.result.resultExtent,
        reduction: "none",
      },
    }],
  });
  return { execution, definition };
}

function revisionCase(
  kind: "bar" | "line",
  revision: string,
  suffix: string,
  rows: readonly Record<string, unknown>[],
): StaleEventRevision {
  const bundle = fixtureBundle(kind);
  const authored = authoredExecution(bundle, revision, suffix, rows);
  const locator = executionLocatorSchema.parse({
    bundleId: bundle.id,
    queryId: "failures",
    range: RANGE,
    parameters: PARAMETERS,
  });
  const response = executeQueryResponseSchema.parse({
    kind: "success",
    result: authored.execution,
    definition: authored.definition,
  });
  const labels = rows.map((row) => String(row.capability_key));
  const authoredRows: readonly AuthoredRow[] = rows.map((row) => {
    if (typeof row.capability_key !== "string" || typeof row.failures !== "number" || !Number.isFinite(row.failures)) {
      throw new Error("Stale event fixture row is not an authored capability/failure pair.");
    }
    return Object.freeze({ capability_key: row.capability_key, failures: row.failures });
  });
  return Object.freeze({
    bundle: Object.freeze({ bundle, builtin: true }),
    locators: Object.freeze({ failures: locator }),
    responses: new Map([["failures", response]]),
    rows: authoredRows,
    visibleDatumText: labels[0] ?? "",
    executionId: authored.execution.executionId,
    datumKeys: authored.execution.result.datumKeys,
    kind,
  });
}

const A_ROWS = Object.freeze([
  { capability_key: "A-first", failures: 3 },
  { capability_key: "A-second", failures: 2 },
]);
const B_ROWS = Object.freeze([
  { capability_key: "B-second", failures: 8 },
  { capability_key: "B-first", failures: 7 },
]);
const C_ROWS = Object.freeze([
  { capability_key: "C-first", failures: 13 },
  { capability_key: "C-second", failures: 11 },
]);

export function createStaleEventBrowserCase(): StaleEventBrowserCase {
  const a = revisionCase("bar", A_REVISION, "a", A_ROWS);
  const b = revisionCase("bar", B_REVISION, "b", B_ROWS);
  const c = revisionCase("line", C_REVISION, "c", C_ROWS);
  return Object.freeze({
    a,
    b,
    c,
    expected: Object.freeze({
      bundleId: "stale-event-proof",
      queryId: "failures",
      range: RANGE,
      parameters: PARAMETERS,
      aLabels: A_ROWS.map((row) => row.capability_key),
      bLabels: B_ROWS.map((row) => row.capability_key),
      cLabels: C_ROWS.map((row) => row.capability_key),
      aExecutionId: a.executionId,
      bExecutionId: b.executionId,
      cExecutionId: c.executionId,
      aDatumKeys: a.datumKeys,
      bDatumKeys: b.datumKeys,
      cDatumKeys: c.datumKeys,
    }),
  });
}

export const staleEventExpected = Object.freeze({
  columns: COLUMNS,
  aRows: A_ROWS,
  bRows: B_ROWS,
  cRows: C_ROWS,
});
