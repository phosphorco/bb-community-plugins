import { analyticsBundleSchema, type AnalyticsBundle } from "../../../../bundle-contract.ts";
import {
  canonicalResultWireBytes,
  deriveExecutionDatumKeys,
  executionDefinitionSchema,
  executionLocatorSchema,
  executionResultSchema,
  executeQueryResponseSchema,
  utf8ByteLength,
  type ExecutionDefinition,
  type ExecutionResult,
} from "../../../../execution-contract.ts";
import {
  executionResultForRendering,
  type AnalyticsChartTheme,
  type ChartVisualization,
} from "../../../../analytics-model.ts";
import { compileEChartsFigure } from "../../../../echarts-options.ts";
import type { AnalyticsBundleResponse } from "../../../../rpc-contract.ts";
import type { CapturedFigureExportInput } from "../../../../analytics-export.ts";
import type {
  CapturedSvgBrowserInput,
  CapturedSvgBrowserRevision,
} from "./captured-svg.fixture.tsx";

const A_REVISION = "a".repeat(64);
const B_REVISION = "b".repeat(64);
const BOUNDARY_REVISION = "c".repeat(64);
const RANGE = Object.freeze({
  startInclusiveMs: 1_700_000_000_000,
  endExclusiveMs: 1_700_086_400_000,
});
const PARAMETERS = Object.freeze([
  { name: "include_retries", logicalType: "boolean", value: true },
  { name: "range_days", logicalType: "integer", value: 1 },
]);
const CAPTURE_THEME: AnalyticsChartTheme = Object.freeze({
  foreground: "rgb(28, 31, 38)",
  muted: "rgb(92, 100, 114)",
  border: "rgb(200, 205, 214)",
  surface: "rgb(255, 255, 255)",
  series: "rgb(35, 99, 235)",
});

type CapturedExecution = Readonly<{
  execution: ExecutionResult;
  definition: ExecutionDefinition;
}>;

export type CapturedSvgBrowserCase = Readonly<{
  input: CapturedSvgBrowserInput;
  capture: CapturedFigureExportInput;
  boundaryCalibration?: CapturedSvgBoundaryCalibration;
}>;

export type CapturedSvgBoundaryCalibration = Readonly<{
  hardLineageBytes: number;
  plottedDataLineageBytes: number;
  resultDataLineageBytes: number;
  imageLineageMinimumBytes: number;
  extraColumnCount: number;
  sqlCommentBytes: number;
}>;

function coverage(capturedAtMs: number, projectionGeneration: number, projectionRevision: string) {
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
      projectionRevision,
    },
    population: {
      candidateThreads: 4,
      selectedThreads: 4,
      loadedThreads: 4,
      retainedFacts: 4,
      cappedThreads: 0,
      listPages: 1,
      eventPages: 1,
      eventBytes: 256,
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

function fixtureBundle(
  label: string,
  sql: string,
  queryTitle: string,
  visualizationTitle: string,
): AnalyticsBundle {
  return analyticsBundleSchema.parse({
    version: 1,
    id: "captured-svg-proof",
    title: `Captured SVG ${label}`,
    description: `Independent captured SVG browser fixture ${label}.`,
    loader: {
      id: "recent-capability-facts-v1",
      label: "Captured SVG fixture source",
      maxAgeMs: 3_600_000,
      staleWhileRefresh: true,
    },
    queries: [{ id: "failures", title: queryTitle, sql, maxRows: 24 }],
    visualizations: [{
      id: "failures",
      queryId: "failures",
      kind: "bar",
      title: visualizationTitle,
      x: "capability_key",
      y: "failures",
      format: "integer",
    }],
    layout: [{ visualizationId: "failures", width: "full" }],
  });
}

function executionFor(
  bundle: AnalyticsBundle,
  revision: string,
  executionTag: string,
  label: string,
  rows: readonly Record<string, unknown>[],
  columns: readonly Readonly<{ name: string; logicalType: string; nullable: boolean }>[],
): CapturedExecution {
  const capturedAtMs = RANGE.endExclusiveMs + executionTag.length;
  const sourceCoverage = coverage(capturedAtMs, executionTag.length, revision);
  const executionId = `analytics-exec_${executionTag}`;
  const query = bundle.queries[0];
  if (query == null) throw new Error("Captured SVG browser data is missing its query.");
  const resolved = {
    version: 2 as const,
    executionId,
    snapshot: {
      version: 2 as const,
      snapshotId: `analytics-snapshot_${executionTag}`,
      sourceScope: {
        scopeKey: `analytics-scope_${executionTag}`,
        projection: "tool_execution_fact_v1" as const,
        storage: "plugin-owned-sqlite" as const,
      },
      frozenRange: RANGE,
      capturedAtMs,
      coverage: sourceCoverage,
    },
    bundleId: bundle.id,
    bundleRevision: revision,
    query: {
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
    },
  };
  const resultCore = {
    columns,
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
    cache: {
      status: "miss",
      physicalExecutionKey: `analytics-physical_${executionTag}`,
    },
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
        id: "failures",
        queryId: "failures",
        kind: "bar",
        title: bundle.visualizations[0]?.title ?? label,
        x: "capability_key",
        y: "failures",
        format: "integer",
        layoutPosition: 0,
      },
      plotted: {
        plottedRows: execution.result.rows.length,
        total: execution.result.resultExtent,
        reduction: "none",
      },
    }],
  });
  return { execution, definition };
}

function response(value: CapturedExecution) {
  return executeQueryResponseSchema.parse({
    kind: "success" as const,
    result: value.execution,
    definition: value.definition,
  });
}

function capture(value: CapturedExecution): CapturedFigureExportInput {
  const rendering = executionResultForRendering(value.execution, value.definition);
  const visualization = chartVisualizationForCapture(value.definition.figures[0]?.visualization);
  return {
    execution: value.execution,
    definition: value.definition,
    result: rendering.result,
    figure: compileEChartsFigure(visualization, rendering.result, CAPTURE_THEME, true),
  };
}

function chartVisualizationForCapture(
  value: ExecutionDefinition["figures"][number]["visualization"] | undefined,
): ChartVisualization & Pick<ExecutionDefinition["figures"][number]["visualization"], "layoutPosition"> {
  if (value == null || (value.kind !== "bar" && value.kind !== "line") || value.format === "text") {
    throw new Error("Captured SVG browser data requires a non-text bar or line visualization.");
  }
  return {
    id: value.id,
    queryId: value.queryId,
    kind: value.kind,
    title: value.title,
    x: value.x,
    y: value.y,
    format: value.format,
    layoutPosition: value.layoutPosition,
  };
}

function revisionCase(
  label: string,
  revision: string,
  executionTag: string,
  sql: string,
  queryTitle: string,
  visualizationTitle: string,
  rows: readonly Record<string, unknown>[],
  columns: readonly Readonly<{ name: string; logicalType: string; nullable: boolean }>[],
): Readonly<{ revision: CapturedSvgBrowserRevision; capture: CapturedFigureExportInput }> {
  const bundle = fixtureBundle(label, sql, queryTitle, visualizationTitle);
  const execution = executionFor(bundle, revision, executionTag, label, rows, columns);
  const bundleResponse: AnalyticsBundleResponse = { bundle, builtin: true };
  const locator = executionLocatorSchema.parse({
    bundleId: bundle.id,
    queryId: "failures",
    range: RANGE,
    parameters: PARAMETERS,
  });
  const parsedResponse = response(execution);
  return {
    revision: {
      bundle: bundleResponse,
      locators: { failures: locator },
      responses: new Map([["failures", parsedResponse]]),
      visibleDatumText: authoredVisibleDatumText(rows),
    },
    capture: capture(execution),
  };
}

function authoredVisibleDatumText(rows: readonly Record<string, unknown>[]): string {
  const first = rows[0]?.capability_key;
  if (typeof first !== "string" || first.length === 0) {
    throw new Error("Captured SVG browser data requires a non-empty authored capability key.");
  }
  return first;
}

const baseColumns = Object.freeze([
  { name: "capability_key", logicalType: "utf8", nullable: false },
  { name: "failures", logicalType: "integer", nullable: false },
] as const);

const baseRows = Object.freeze([
  { capability_key: "old-failures", failures: 5 },
  { capability_key: "old-retries", failures: 3 },
  { capability_key: "old-timeouts", failures: 2 },
  { capability_key: "old-cancellations", failures: 1 },
]);

const editedRows = Object.freeze([
  { capability_key: "new-failures", failures: 8 },
  { capability_key: "new-retries", failures: 4 },
  { capability_key: "new-timeouts", failures: 2 },
  { capability_key: "new-cancellations", failures: 1 },
]);

const normalA = revisionCase(
  "A",
  A_REVISION,
  "captured_a",
  "SELECT capability_key, failures FROM tool_execution_fact_v1",
  "Old captured failures",
  "Old failures",
  baseRows,
  baseColumns,
);
const normalB = revisionCase(
  "B",
  B_REVISION,
  "captured_b",
  "SELECT capability_key, failures FROM tool_execution_fact_v1",
  "Edited current failures",
  "Edited failures",
  editedRows,
  baseColumns,
);

const CAPTURED_LINEAGE_HARD_BYTES = 64 * 1024;
const MAX_BOUNDARY_SQL_COMMENT_BYTES = 15_900;

function independentJsonBytes(value: unknown): number {
  const text = JSON.stringify(value);
  if (text == null) throw new Error("Captured SVG boundary arithmetic could not encode its expected manifest.");
  return utf8ByteLength(text);
}

function independentLineageManifest(
  input: CapturedFigureExportInput,
  scope: "plotted" | "result",
): Readonly<Record<string, unknown>> {
  const figure = input.definition.figures.find(
    (candidate) => candidate.visualization.id === input.figure.visualization.id,
  );
  if (figure == null) throw new Error("Captured SVG boundary arithmetic is missing its figure definition.");
  const count = scope === "plotted" ? figure.plotted.plottedRows : input.execution.result.rows.length;
  const rows = input.execution.result.rows.slice(0, count);
  const datumKeys = input.execution.result.datumKeys.slice(0, count);
  const nullCells: Array<Readonly<{ datumKey: string; column: string }>> = [];
  const emptyStringCells: Array<Readonly<{ datumKey: string; column: string }>> = [];
  rows.forEach((row, rowIndex) => {
    const datumKey = datumKeys[rowIndex];
    if (datumKey == null) throw new Error("Captured SVG boundary arithmetic is missing a datum key.");
    input.execution.result.columns.forEach((column) => {
      const value = row[column.name];
      if (value === null) nullCells.push({ datumKey, column: column.name });
      else if (column.logicalType === "utf8" && value === "") emptyStringCells.push({ datumKey, column: column.name });
    });
  });
  return {
    version: 1,
    kind: "analytics-captured-data",
    scope,
    nullEncoding: "empty-csv-cell-with-lineage-nullCells",
    execution: {
      executionId: input.execution.executionId,
      bundleId: input.execution.resolved.bundleId,
      bundleRevision: input.execution.resolved.bundleRevision,
      snapshot: input.execution.resolved.snapshot,
      coverage: input.execution.coverage,
    },
    definition: input.definition,
    result: {
      id: input.execution.resolved.query.id,
      generation: input.execution.executionId,
      columns: input.execution.result.columns,
      extent: input.execution.result.resultExtent,
      truncated: input.execution.result.resultTruncated,
    },
    figure: {
      visualization: figure.visualization,
      plotted: figure.plotted,
    },
    datumKeys,
    nullCells,
    emptyStringCells,
  };
}

function independentImageLineageMinimumBytes(input: CapturedFigureExportInput): number {
  return independentJsonBytes({
    ...independentLineageManifest(input, "plotted"),
    image: {
      width: 960,
      height: 540,
      devicePixelRatio: 1,
      theme: CAPTURE_THEME,
      renderer: "svg",
      animation: "off",
      viewportPolicy: "full-canonical-plot",
      svgByteLength: 0,
    },
  });
}

function boundaryColumns(extraColumnCount: number) {
  const extra = Array.from({ length: extraColumnCount }, (_, index) => ({
    name: `boundary_${String(index).padStart(2, "0")}_${"x".repeat(58)}`,
    logicalType: "utf8",
    nullable: true,
  }));
  return Object.freeze([...baseColumns, ...extra]);
}

function boundaryRows(
  columns: readonly Readonly<{ name: string; logicalType: string; nullable: boolean }>[],
) {
  const extraColumns = columns.slice(baseColumns.length);
  return Object.freeze(
    Array.from({ length: 24 }, (_, index) => ({
      capability_key: `boundary-${String(index).padStart(2, "0")}`,
      failures: index + 1,
      ...Object.fromEntries(extraColumns.map((column) => [column.name, null])),
    })),
  );
}

function boundaryCandidate(extraColumnCount: number, sqlCommentBytes: number) {
  const columns = boundaryColumns(extraColumnCount);
  const rows = boundaryRows(columns);
  const sql = `SELECT capability_key, failures FROM tool_execution_fact_v1 /*${"x".repeat(sqlCommentBytes)}*/`;
  const built = revisionCase(
    "boundary",
    BOUNDARY_REVISION,
    "captured_boundary",
    sql,
    "Boundary captured failures",
    "Boundary failures",
    rows,
    columns,
  );
  const plottedDataLineageBytes = independentJsonBytes(independentLineageManifest(built.capture, "plotted"));
  const resultDataLineageBytes = independentJsonBytes(independentLineageManifest(built.capture, "result"));
  const imageLineageMinimumBytes = independentImageLineageMinimumBytes(built.capture);
  return {
    ...built,
    calibration: Object.freeze({
      hardLineageBytes: CAPTURED_LINEAGE_HARD_BYTES,
      plottedDataLineageBytes,
      resultDataLineageBytes,
      imageLineageMinimumBytes,
      extraColumnCount,
      sqlCommentBytes,
    }),
  };
}

function calibrateBoundary() {
  for (let extraColumnCount = 9; extraColumnCount <= 32; extraColumnCount += 1) {
    let low = 0;
    let high = MAX_BOUNDARY_SQL_COMMENT_BYTES;
    let best: ReturnType<typeof boundaryCandidate> | null = null;
    while (low <= high) {
      const sqlCommentBytes = Math.floor((low + high) / 2);
      const candidate = boundaryCandidate(extraColumnCount, sqlCommentBytes);
      const fitsData = candidate.calibration.plottedDataLineageBytes < CAPTURED_LINEAGE_HARD_BYTES &&
        candidate.calibration.resultDataLineageBytes < CAPTURED_LINEAGE_HARD_BYTES;
      const imageCrosses = candidate.calibration.imageLineageMinimumBytes > CAPTURED_LINEAGE_HARD_BYTES;
      if (fitsData && imageCrosses) {
        best = candidate;
        low = sqlCommentBytes + 1;
      } else if (!fitsData) {
        high = sqlCommentBytes - 1;
      } else {
        low = sqlCommentBytes + 1;
      }
    }
    if (best != null) return best;
  }
  throw new Error("Captured SVG boundary arithmetic could not produce a schema-valid default-lineage witness.");
}

const boundary = calibrateBoundary();

const referenceResponse = Object.freeze({
  id: "analytics-ref_captured_svg",
  token: "analytics-ref:v2:captured_svg",
  label: "Captured SVG fixture reference",
  expiresAtMs: 1_700_100_000_000,
});

function normalCase(): CapturedSvgBrowserCase {
  const initial = revisionCase(
    "A",
    A_REVISION,
    "captured_a",
    "SELECT capability_key, failures FROM tool_execution_fact_v1",
    "Old captured failures",
    "Old failures",
    baseRows,
    baseColumns,
  );
  const edited = revisionCase(
    "B",
    B_REVISION,
    "captured_b",
    "SELECT capability_key, failures FROM tool_execution_fact_v1",
    "Edited current failures",
    "Edited failures",
    editedRows,
    baseColumns,
  );
  return {
    input: { initial: initial.revision, edited: edited.revision, referenceResponse },
    capture: initial.capture,
  };
}

function boundaryCase(): CapturedSvgBrowserCase {
  return {
    input: { initial: boundary.revision, edited: boundary.revision, referenceResponse },
    capture: boundary.capture,
    boundaryCalibration: boundary.calibration,
  };
}

export function createCapturedSvgBrowserCase(name: "normal" | "boundary"): CapturedSvgBrowserCase {
  return name === "normal" ? normalCase() : boundaryCase();
}

export const capturedSvgBrowserCases = Object.freeze({
  normal: Object.freeze({
    input: {
      initial: normalA.revision,
      edited: normalB.revision,
      referenceResponse,
    } satisfies CapturedSvgBrowserInput,
    capture: normalA.capture,
  }),
  boundary: Object.freeze({
    input: {
      initial: boundary.revision,
      edited: boundary.revision,
      referenceResponse,
    } satisfies CapturedSvgBrowserInput,
    capture: boundary.capture,
    boundaryCalibration: boundary.calibration,
  }),
});

export const capturedSvgExpected = Object.freeze({
  bundleId: "captured-svg-proof",
  queryId: "failures",
  range: RANGE,
  parameters: PARAMETERS,
  oldLabels: baseRows.map((row) => row.capability_key),
  newLabels: editedRows.map((row) => row.capability_key),
  oldExecutionId: normalA.capture.execution.executionId,
  oldDatumKeys: normalA.capture.execution.result.datumKeys,
  newExecutionId: normalB.capture.execution.executionId,
  newDatumKeys: normalB.capture.execution.result.datumKeys,
  boundaryExecutionId: boundary.capture.execution.executionId,
  boundaryCalibration: boundary.calibration,
  maxReferenceBytes: 64 * 1024,
  fixedConsumerSvgBytes: 1_000_000,
});

export function capturedSvgOptions(signal?: AbortSignal) {
  return {
    width: 960,
    height: 540,
    theme: CAPTURE_THEME,
    ...(signal === undefined ? {} : { signal }),
  };
}
