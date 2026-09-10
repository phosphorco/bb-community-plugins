// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import {
  createCapturedFigureExport,
  MAX_CAPTURED_SVG_BYTES,
} from "../../../../analytics-export.ts";
import {
  analyticsBundleSchema,
  type AnalyticsVisualization,
  type AnalyticsBundle,
} from "../../../../bundle-contract.ts";
import {
  canonicalResultWireBytes,
  deriveExecutionDatumKeys,
  EXECUTION_LIMITS,
  executionDefinitionSchema,
  executionLocatorSchema,
  executionResultSchema,
  type ExecutionLocator,
} from "../../../../execution-contract.ts";
import type { AnalyticsBundleResponse } from "../../../../rpc-contract.ts";
import { executionResultForRendering, type AnalyticsRow } from "../../../../analytics-model.ts";
import { compileEChartsFigure } from "../../../../echarts-options.ts";
import {
  assertLocatorAndScopeNegatives,
  createControlledExecutionClient,
  exerciseAbortErrorWithPendingSibling,
  exerciseCapturedDownloadAfterBundleEdit,
  exerciseCapturedExportFailureNoPartialDownload,
  exerciseCapturedReferenceAfterBundleEdit,
  exerciseExecutionBackedDashboard,
  exerciseSupersessionAndRetention,
  type ControlledExecutionResult,
  type ExecutionDashboardRevision,
} from "./execution-backed-ui.fixture.tsx";

const revision = "a".repeat(64);
const range = Object.freeze({
  startInclusiveMs: 1_700_000_000_000,
  endExclusiveMs: 1_700_086_400_000,
});
const parameters = Object.freeze([
  { name: "include_retries", logicalType: "boolean", value: true },
  { name: "range_days", logicalType: "integer", value: 7 },
] as const);

function coverage(capturedAtMs: number, projectionGeneration: number) {
  return {
    coverageRevision: projectionGeneration,
    retention: {
      startInclusiveMs: range.startInclusiveMs,
      earliestVerifiedRetainedInclusiveMs: range.startInclusiveMs,
      endExclusiveMs: capturedAtMs,
      policyDays: 90 as const,
    },
    observed: {
      earliestFactMs: range.startInclusiveMs,
      latestFactMs: range.endExclusiveMs,
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
      eventPageLimit: 500,
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

function fixtureBundle(label: string): AnalyticsBundle {
  const querySql = "SELECT capability_key, failures FROM tool_execution_fact_v1";
  const problemTitle = label === "authoritative" ? "Authoritative problem tools" : "Problem tools";
  return analyticsBundleSchema.parse({
    version: 1,
    id: "tool-reliability",
    title: `Execution UI fixture ${label}`,
    description: `Controlled execution fixture revision ${label}.`,
    loader: {
      id: "recent-capability-facts-v1",
      label: "Recent facts",
      maxAgeMs: 3_600_000,
      staleWhileRefresh: true,
    },
    queries: [
      { id: "problem-tools", title: problemTitle, sql: querySql, maxRows: 100 },
      { id: "tool-latency", title: "Tool latency", sql: "SELECT capability_key, duration_ms FROM tool_execution_fact_v1", maxRows: 100 },
    ],
    visualizations: [
      { id: "failures", queryId: "problem-tools", kind: "bar", title: label === "authoritative" ? "Authoritative failures" : label === "edited" ? "Edited failures" : "Failures", x: "capability_key", y: "failures", format: "integer" },
      { id: "latency", queryId: "tool-latency", kind: "bar", title: "Latency", x: "capability_key", y: "duration_ms", format: "duration" },
    ],
    layout: [
      { visualizationId: "failures", width: "half" },
      { visualizationId: "latency", width: "half" },
    ],
  });
}

function executionFor(
  bundle: AnalyticsBundle,
  query: AnalyticsBundle["queries"][number],
  snapshotTag: string,
  executionTag: string,
  capabilityKey: string,
): ControlledExecutionResult {
  const executionId = `analytics-exec_${executionTag}abcdefghijkl`;
  const capturedAtMs = range.endExclusiveMs + snapshotTag.charCodeAt(0);
  const sourceCoverage = coverage(capturedAtMs, snapshotTag.charCodeAt(0));
  const snapshot = {
    version: 2 as const,
    snapshotId: `analytics-snapshot_${snapshotTag}abcdefghijkl`,
    sourceScope: {
      scopeKey: `analytics-scope_${snapshotTag}abcdefghijkl`,
      projection: "tool_execution_fact_v1" as const,
      storage: "plugin-owned-sqlite" as const,
    },
    frozenRange: range,
    capturedAtMs,
    coverage: sourceCoverage,
  };
  const resolved = {
    version: 2 as const,
    executionId,
    snapshot,
    bundleId: "tool-reliability",
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
      parameters,
    },
  };
  const columns = query.id === "problem-tools"
    ? [
        { name: "capability_key", logicalType: "utf8" as const, nullable: false },
        { name: "failures", logicalType: "integer" as const, nullable: false },
      ]
    : [
        { name: "capability_key", logicalType: "utf8" as const, nullable: false },
        { name: "duration_ms", logicalType: "integer" as const, nullable: false },
      ];
  const rows = query.id === "problem-tools"
    ? [{ capability_key: capabilityKey, failures: 3 }]
    : [{ capability_key: capabilityKey, duration_ms: 48 }];
  const resultCore = {
    columns,
    rows,
    datumKeys: deriveExecutionDatumKeys(executionId, rows),
    resultExtent: { kind: "exact" as const, rows: rows.length },
    resultTruncated: false,
  };
  const result = {
    ...resultCore,
    encodedBytes: canonicalResultWireBytes(resultCore),
  };
  const execution = executionResultSchema.parse({
    version: 2,
    executionId,
    resolved,
    coverage: sourceCoverage,
    result,
    startedAtMs: capturedAtMs,
    completedAtMs: capturedAtMs + 12,
    elapsedMs: 12,
    cache: {
      status: "miss",
      physicalExecutionKey: `analytics-physical_${executionTag}abcdefghijkl`,
    },
  });
  const visualization = bundle.visualizations.find((candidate) => candidate.queryId === query.id);
  if (visualization == null) throw new Error(`fixture missing visualization for ${query.id}`);
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
      visualization: { ...visualization, layoutPosition: bundle.layout.findIndex((item) => item.visualizationId === visualization.id) },
      plotted: {
        plottedRows: execution.result.rows.length,
        total: execution.result.resultExtent,
        reduction: "none",
      },
    }],
  });
  return { execution, definition };
}

function revisionFixture(label: string, snapshotTag: string, capabilityPrefix: string): Readonly<{
  bundle: AnalyticsBundleResponse;
  locators: Readonly<Record<string, ExecutionLocator>>;
  results: ReadonlyMap<string, ControlledExecutionResult>;
  visibleDatumText: string;
}> {
  const bundle = fixtureBundle(label);
  const executions = bundle.queries.map((query) => executionFor(
    bundle,
    query,
    snapshotTag,
    `${snapshotTag}-${query.id}`,
    `${capabilityPrefix}-${query.id}`,
  ));
  const results = new Map(executions.map((value) => [value.execution.resolved.query.id, value]));
  const locators = Object.fromEntries(bundle.queries.map((query) => [query.id, executionLocatorSchema.parse({
    bundleId: bundle.id,
    queryId: query.id,
    range,
    parameters,
  })]));
  return {
    bundle: { bundle, builtin: true },
    locators,
    results,
    visibleDatumText: `${capabilityPrefix}-problem-tools`,
  };
}

const referenceResponse = {
  id: "analytics-ref_abcdefghijklmnop",
  token: "analytics-ref:v2:abcdefghijklmnop",
  label: "Problem tools fixture reference",
  expiresAtMs: 1_700_100_000_000,
};

const exportTheme = {
  foreground: "rgb(240, 240, 240)",
  muted: "rgb(150, 150, 150)",
  border: "rgb(80, 80, 80)",
  surface: "rgb(30, 30, 30)",
  series: "rgb(120, 90, 240)",
} as const;

function capturedExportInput(value: ControlledExecutionResult) {
  const rendering = executionResultForRendering(value.execution, value.definition);
  const visualization = value.definition.figures[0]?.visualization;
  if (visualization == null || !isRenderableChartVisualization(visualization)) {
    throw new Error("Export fixture requires a bar or line figure.");
  }
  return {
    execution: value.execution,
    definition: value.definition,
    result: rendering.result,
    figure: compileEChartsFigure(visualization, rendering.result, exportTheme, true),
  };
}

type CapturedChartVisualization = ControlledExecutionResult["definition"]["figures"][number]["visualization"];
type RenderableChartVisualization = CapturedChartVisualization & Extract<AnalyticsVisualization, { kind: "bar" | "line" }>;

function isRenderableChartVisualization(
  visualization: CapturedChartVisualization,
): visualization is RenderableChartVisualization {
  return (visualization.kind === "bar" || visualization.kind === "line") && visualization.format !== "text";
}

function typedCapturedExportInput(value: ControlledExecutionResult) {
  const rows = [
    { capability_key: "\t=SUM(A1)", failures: "-3.50", count: 1, ratio: 0.25, enabled: true, observed_at: 1_700_000_000_000, day: "2023-11-14" },
    { capability_key: "\r=CR", failures: "4.00", count: 2, ratio: -0.5, enabled: false, observed_at: 1_700_000_001_000, day: "2023-11-15" },
    { capability_key: "\n=LF, ☃", failures: "5.00", count: 3, ratio: 1.5, enabled: true, observed_at: 1_700_000_002_000, day: "2023-11-16" },
    { capability_key: "=EQUAL", failures: "5.50", count: 4, ratio: 2.75, enabled: false, observed_at: 1_700_000_003_000, day: "2023-11-17" },
    { capability_key: "+PLUS", failures: "6.00", count: 5, ratio: 3.25, enabled: true, observed_at: 1_700_000_004_000, day: "2023-11-18" },
    { capability_key: "-TEXT", failures: "7.00", count: 6, ratio: 4.5, enabled: false, observed_at: 1_700_000_005_000, day: "2023-11-19" },
    { capability_key: "@AT", failures: "8.00", count: 7, ratio: 5.75, enabled: true, observed_at: 1_700_000_006_000, day: "2023-11-20" },
    { capability_key: "", failures: null, count: 8, ratio: 6.25, enabled: false, observed_at: 1_700_000_007_000, day: "2023-11-21" },
    { capability_key: "quoted \"value\"", failures: "9.00", count: 9, ratio: 7.5, enabled: true, observed_at: 1_700_000_008_000, day: "2023-11-22" },
  ] as const;
  const columns = [
    { name: "capability_key", logicalType: "utf8" as const, nullable: true },
    { name: "failures", logicalType: "decimal" as const, nullable: true },
    { name: "count", logicalType: "integer" as const, nullable: false },
    { name: "ratio", logicalType: "float64" as const, nullable: false },
    { name: "enabled", logicalType: "boolean" as const, nullable: false },
    { name: "observed_at", logicalType: "timestamp_utc_ms" as const, nullable: false },
    { name: "day", logicalType: "date_utc" as const, nullable: false },
  ] as const;
  const resultCore = {
    columns,
    rows,
    datumKeys: deriveExecutionDatumKeys(value.execution.executionId, rows),
    resultExtent: { kind: "exact" as const, rows: rows.length },
    resultTruncated: false,
  };
  const execution = executionResultSchema.parse({
    ...value.execution,
    result: {
      ...value.execution.result,
      ...resultCore,
      encodedBytes: canonicalResultWireBytes(resultCore),
    },
  });
  const sourceFigure = value.definition.figures[0];
  if (sourceFigure == null) throw new Error("Typed export fixture is missing a figure.");
  const definition = executionDefinitionSchema.parse({
    ...value.definition,
    query: execution.resolved.query,
    figures: [{
      ...sourceFigure,
      visualization: { ...sourceFigure.visualization, format: "decimal" },
      plotted: {
        plottedRows: rows.length,
        total: resultCore.resultExtent,
        reduction: "none",
      },
    }],
  });
  return capturedExportInput({ execution, definition });
}

function reorderRowFields(row: AnalyticsRow): AnalyticsRow {
  const reordered: Record<string, AnalyticsRow[string]> = {};
  for (const key of Object.keys(row).reverse()) {
    reordered[key] = row[key];
  }
  return reordered;
}

function lineageCapCapturedExportInput(value: ControlledExecutionResult) {
  return capturedExportInput(lineageCapValue(value));
}

function lineageCapValue(value: ControlledExecutionResult): ControlledExecutionResult {
  const sourceFigure = value.definition.figures[0];
  if (sourceFigure == null) throw new Error("Lineage cap fixture is missing its source figure.");
  const columns = [
    { name: "capability_key", logicalType: "utf8" as const, nullable: true },
    { name: "failures", logicalType: "integer" as const, nullable: true },
    ...Array.from({ length: 62 }, (_, index) => ({
      name: `lineage_column_${String(index).padStart(2, "0")}_${"x".repeat(60)}`,
      logicalType: "utf8" as const,
      nullable: true,
    })),
  ];
  const rows = Array.from({ length: 120 }, () =>
    Object.fromEntries(columns.map((column) => [column.name, null])));
  const resultCore = {
    columns,
    rows,
    datumKeys: deriveExecutionDatumKeys(value.execution.executionId, rows),
    resultExtent: { kind: "exact" as const, rows: rows.length },
    resultTruncated: false,
  };
  const execution = executionResultSchema.parse({
    ...value.execution,
    result: {
      ...value.execution.result,
      ...resultCore,
      encodedBytes: canonicalResultWireBytes(resultCore),
    },
  });
  const definition = executionDefinitionSchema.parse({
    ...value.definition,
    query: execution.resolved.query,
    figures: [{
      ...sourceFigure,
      visualization: { ...sourceFigure.visualization, kind: "line" },
      plotted: {
        plottedRows: rows.length,
        total: resultCore.resultExtent,
        reduction: "none",
      },
    }],
  });
  return { execution, definition };
}

function markBoundValue(value: ControlledExecutionResult): ControlledExecutionResult {
  const sourceFigure = value.definition.figures[0];
  if (sourceFigure == null) throw new Error("Mark-bound fixture is missing its source figure.");
  const rows = Array.from({ length: 25 }, (_, index) => ({
    capability_key: `mark-${index}`,
    failures: index + 1,
  }));
  const resultCore = {
    columns: value.execution.result.columns,
    rows,
    datumKeys: deriveExecutionDatumKeys(value.execution.executionId, rows),
    resultExtent: { kind: "exact" as const, rows: rows.length },
    resultTruncated: false,
  };
  const execution = executionResultSchema.parse({
    ...value.execution,
    result: {
      ...value.execution.result,
      ...resultCore,
      encodedBytes: canonicalResultWireBytes(resultCore),
    },
  });
  const definition = executionDefinitionSchema.parse({
    ...value.definition,
    query: execution.resolved.query,
    figures: [{
      ...sourceFigure,
      plotted: {
        plottedRows: rows.length,
        total: resultCore.resultExtent,
        reduction: "none",
      },
    }],
  });
  return { execution, definition };
}

function lowerBoundValue(value: ControlledExecutionResult): ControlledExecutionResult {
  const sourceFigure = value.definition.figures[0];
  if (sourceFigure == null) throw new Error("Lower-bound fixture is missing its source figure.");
  const resultCore = {
    ...value.execution.result,
    resultExtent: { kind: "lower-bound" as const, rows: value.execution.result.rows.length + 2 },
    resultTruncated: true,
  };
  const execution = executionResultSchema.parse({
    ...value.execution,
    result: {
      ...resultCore,
      encodedBytes: canonicalResultWireBytes({
        columns: resultCore.columns,
        rows: resultCore.rows,
        datumKeys: resultCore.datumKeys,
        resultExtent: resultCore.resultExtent,
        resultTruncated: resultCore.resultTruncated,
      }),
    },
  });
  const definition = executionDefinitionSchema.parse({
    ...value.definition,
    query: execution.resolved.query,
    figures: [{
      ...sourceFigure,
      plotted: {
        plottedRows: execution.result.rows.length,
        total: execution.result.resultExtent,
        reduction: "none",
      },
    }],
  });
  return { execution, definition };
}

describe("execution-backed dashboard component seam", () => {
  it("freezes captured CSV and lineage data independently of every original graph", () => {
    const fixture = revisionFixture("A", "a", "read");
    const value = fixture.results.get("problem-tools");
    if (value == null) throw new Error("fixture missing export execution");
    const input = capturedExportInput(value);
    const artifact = createCapturedFigureExport(input);
    const csvBefore = artifact.csv("result");
    const lineageBefore = artifact.lineage("result");

    Object.defineProperty(input.execution.result.rows[0], "capability_key", { configurable: true, value: "mutated-row" });
    Object.defineProperty(input.execution.result.datumKeys, "0", { configurable: true, value: "analytics-datum_mutated" });
    Object.defineProperty(input.definition.query, "title", { configurable: true, value: "mutated-definition" });
    Object.defineProperty(input.figure.visualization, "title", { configurable: true, value: "mutated-figure" });
    Object.defineProperty(input.figure.plottedDatumKeys, "0", { configurable: true, value: "analytics-datum_mutated" });
    Object.defineProperty(input.figure.option, "animation", { configurable: true, value: true });

    expect(artifact.csv("result")).toEqual(csvBefore);
    expect(artifact.lineage("result")).toEqual(lineageBefore);
    expect(artifact).not.toHaveProperty("execution");
    expect(artifact).not.toHaveProperty("definition");
    expect(artifact).not.toHaveProperty("result");
    expect(artifact).not.toHaveProperty("figure");
  });

  it("rejects invalid SVG options and pre-aborted signals before renderer acquisition", () => {
    const fixture = revisionFixture("A", "a", "read");
    const value = fixture.results.get("problem-tools");
    if (value == null) throw new Error("fixture missing SVG option execution");
    const input = capturedExportInput(value);
    const artifact = createCapturedFigureExport(input);
    const options = {
      theme: exportTheme,
      width: 960,
      height: 540,
    } as const;
    expect(() => createCapturedFigureExport(input, { maxSvgBytes: MAX_CAPTURED_SVG_BYTES + 1 })).toThrow(/budget/i);
    expect(() => Reflect.apply(createCapturedFigureExport, undefined, [input, { maxSvgBytes: null }])).toThrow(/budget/i);
    expect(() => artifact.svg({ ...options, width: 0 })).toThrow(/dimension/i);
    expect(() => artifact.svg({ ...options, width: 2_001, height: 2_001 })).toThrow(/dimension|pixel/i);
    expect(() => artifact.svg({ ...options, theme: { ...exportTheme, series: "x".repeat(257) } })).toThrow(/theme/i);

    const controller = new AbortController();
    controller.abort();
    expect(() => artifact.svg({ ...options, signal: controller.signal })).toThrow(/cancel/i);
  });

  it("emits typed, formula-safe CSV and explicit null versus empty lineage markers", () => {
    const fixture = revisionFixture("A", "a", "read");
    const value = fixture.results.get("problem-tools");
    if (value == null) throw new Error("fixture missing typed export execution");
    const artifact = createCapturedFigureExport(typedCapturedExportInput(value));
    const csv = artifact.csv("result");
    const lineage = JSON.parse(artifact.lineage("result").text) as {
      datumKeys: string[];
      nullCells: Array<{ datumKey: string; column: string }>;
      emptyStringCells: Array<{ datumKey: string; column: string }>;
    };
    expect(csv.text).toContain("\"'\t=SUM(A1)\"");
    expect(csv.text).toContain("\"'\r=CR\"");
    expect(csv.text).toContain("\"'\n=LF, ☃\"");
    expect(csv.text).toContain("\"'=EQUAL\"");
    expect(csv.text).toContain("\"'+PLUS\"");
    expect(csv.text).toContain("\"'-TEXT\"");
    expect(csv.text).toContain("\"'@AT\"");
    expect(csv.text).toContain("\"-3.50\"");
    expect(csv.text).toContain("\"1\"");
    expect(csv.text).toContain("\"-0.5\"");
    expect(csv.text).toContain("\"true\"");
    expect(csv.text).toContain("\"1700000000000\"");
    expect(csv.text).toContain("\"2023-11-14\"");
    expect(csv.text).toContain("\"quoted \"\"value\"\"\"");
    expect(csv.text.startsWith("\"capability_key\",\"failures\",\"count\",\"ratio\",\"enabled\",\"observed_at\",\"day\"\r\n")).toBe(true);
    expect(csv.byteLength).toBe(new TextEncoder().encode(csv.text).byteLength);
    expect(artifact.lineage("result").byteLength).toBe(new TextEncoder().encode(artifact.lineage("result").text).byteLength);
    const emptyDatumKey = lineage.datumKeys[7];
    if (emptyDatumKey == null) throw new Error("typed export fixture missing empty datum key");
    expect(lineage.nullCells).toContainEqual({ datumKey: emptyDatumKey, column: "failures" });
    expect(lineage.emptyStringCells).toContainEqual({ datumKey: emptyDatumKey, column: "capability_key" });
  });

  it("rejects paired, render, figure, extent, key, reduction, and mark-bound drift", () => {
    const fixture = revisionFixture("A", "a", "read");
    const value = fixture.results.get("problem-tools");
    if (value == null) throw new Error("fixture missing negative export execution");
    const input = capturedExportInput(value);

    const reorderedObjects = {
      ...input,
      result: {
        ...input.result,
        rows: input.result.rows.map(reorderRowFields),
      },
    };
    expect(() => createCapturedFigureExport(reorderedObjects)).not.toThrow();

    const definitionDrift = structuredClone(input.definition);
    definitionDrift.query.title = "drifted query";
    expect(() => createCapturedFigureExport({ ...input, definition: definitionDrift })).toThrow();

    const resultDrift = {
      ...input.result,
      rows: [...input.result.rows, { capability_key: "extra", failures: 1 }],
    };
    expect(() => createCapturedFigureExport({ ...input, result: resultDrift })).toThrow();

    const columnOrderDrift = {
      ...input.result,
      columns: [...input.result.columns].reverse(),
    };
    expect(() => createCapturedFigureExport({ ...input, result: columnOrderDrift })).toThrow();

    const typedInput = typedCapturedExportInput(value);
    const rowOrderDrift = {
      ...typedInput.result,
      rows: [...typedInput.result.rows].reverse(),
    };
    expect(() => createCapturedFigureExport({ ...typedInput, result: rowOrderDrift })).toThrow();

    const keyOrderDrift = {
      ...typedInput.result,
      datumKeys: [...typedInput.result.datumKeys].reverse(),
    };
    expect(() => createCapturedFigureExport({ ...typedInput, result: keyOrderDrift })).toThrow();

    const keyDrift = {
      ...input.figure,
      plottedDatumKeys: ["analytics-datum_wrong", ...input.figure.plottedDatumKeys.slice(1)],
    };
    expect(() => createCapturedFigureExport({ ...input, figure: keyDrift })).toThrow();

    const extentDrift = structuredClone(input.definition);
    extentDrift.figures[0]!.plotted.total = { kind: "exact", rows: 99 };
    expect(() => createCapturedFigureExport({ ...input, definition: extentDrift })).toThrow();

    const reductionDrift = structuredClone(input.definition);
    reductionDrift.figures[0]!.plotted.reduction = "top-n";
    expect(() => createCapturedFigureExport({ ...input, definition: reductionDrift })).toThrow();

    expect(() => createCapturedFigureExport(capturedExportInput(markBoundValue(value)))).toThrow(/mark bound|renderer/i);
  });

  it("measures both output budgets and rejects a schema-valid lineage witness", () => {
    const fixture = revisionFixture("A", "a", "read");
    const value = fixture.results.get("problem-tools");
    if (value == null) throw new Error("fixture missing cap execution");
    const artifact = createCapturedFigureExport(capturedExportInput(value));
    const csvOutputs = [artifact.csv("plotted"), artifact.csv("result")];
    const lineageOutputs = [artifact.lineage("plotted"), artifact.lineage("result")];
    const csvBytes = Math.max(...csvOutputs.map((output) => output.byteLength));
    const lineageBytes = Math.max(...lineageOutputs.map((output) => output.byteLength));
    for (const csv of csvOutputs) {
      expect(csv.byteLength).toBe(new TextEncoder().encode(csv.text).byteLength);
      expect(csv.byteLength).toBeLessThanOrEqual(EXECUTION_LIMITS.maxCanonicalResultBytes);
    }
    for (const lineage of lineageOutputs) {
      expect(lineage.byteLength).toBe(new TextEncoder().encode(lineage.text).byteLength);
      expect(lineage.byteLength).toBeLessThanOrEqual(EXECUTION_LIMITS.maxReferenceBytes);
    }
    const quotaArtifact = createCapturedFigureExport(capturedExportInput(value), {
      maxCsvBytes: csvBytes,
      maxLineageBytes: lineageBytes,
    });
    for (const scope of ["plotted", "result"] as const) {
      expect(quotaArtifact.csv(scope).byteLength).toBeLessThanOrEqual(csvBytes);
      expect(quotaArtifact.lineage(scope).byteLength).toBeLessThanOrEqual(lineageBytes);
    }
    expect(() => createCapturedFigureExport(capturedExportInput(value), {
      maxCsvBytes: csvBytes - 1,
    })).toThrow(/CSV/i);
    expect(() => createCapturedFigureExport(capturedExportInput(value), {
      maxLineageBytes: lineageBytes - 1,
    })).toThrow(/lineage/i);
    expect(() => createCapturedFigureExport(capturedExportInput(value), {
      maxCsvBytes: EXECUTION_LIMITS.maxCanonicalResultBytes + 1,
    })).toThrow(/budget/i);
    expect(() => createCapturedFigureExport(capturedExportInput(value), {
      maxLineageBytes: Number.NaN,
    })).toThrow(/budget/i);
    expect(() => createCapturedFigureExport(capturedExportInput(value), {
      maxCsvBytes: -1,
    })).toThrow(/budget/i);
    expect(() => Reflect.apply(createCapturedFigureExport, undefined, [capturedExportInput(value), {
      maxLineageBytes: null,
    }])).toThrow(/budget/i);
    expect(() => Reflect.apply(createCapturedFigureExport, undefined, [capturedExportInput(value), {
      maxCsvBytes: null,
    }])).toThrow(/budget/i);
    expect(() => createCapturedFigureExport(lineageCapCapturedExportInput(value))).toThrow(/64.?KiB|lineage/i);
  });

  it("renders canonical results and propagates exact reference identity through composer and clipboard", async () => {
    const fixture = revisionFixture("A", "a", "read");
    const value = fixture.results.get("problem-tools");
    if (value == null) throw new Error("fixture missing problem-tools execution");
    const client = createControlledExecutionClient(referenceResponse);
    const result = await exerciseExecutionBackedDashboard({
      ...fixture,
      client,
      rangeDays: 7,
      expectedDatumKey: value.execution.result.datumKeys[0]!,
      expectedReferenceId: referenceResponse.id,
      expectedReferenceToken: referenceResponse.token,
    });
    expect(result.renderedText).toContain("read-problem-tools");
    expect(result.referenceRequests).toEqual([
      {
        executionId: value.execution.executionId,
        visualizationId: "failures",
        targetDatumKey: value.execution.result.datumKeys[0],
      },
      {
        executionId: value.execution.executionId,
        visualizationId: "failures",
        targetDatumKey: value.execution.result.datumKeys[0],
      },
    ]);
    expect(result.composerMentions).toHaveLength(1);
    expect(result.clipboardWrites).toEqual([referenceResponse.token]);
  });

  it("accepts valid declaration reordering and rejects scoped range/value drift", () => {
    const fixture = revisionFixture("A", "a", "read");
    const value = fixture.results.get("problem-tools");
    const locator = fixture.locators["problem-tools"];
    if (value == null || locator == null) throw new Error("fixture missing scope validation inputs");
    assertLocatorAndScopeNegatives(value.execution, value.definition, locator);
    expect(executionResultForRendering(value.execution, value.definition).result.generation).toBe(value.execution.executionId);
  });

  it("uses the paired captured definition when the supplied bundle query is stale", async () => {
    const authoritative = revisionFixture("authoritative", "a", "read");
    const authoritativeValue = authoritative.results.get("problem-tools");
    if (authoritativeValue == null) throw new Error("fixture missing authoritative problem-tools execution");
    const staleBundle = analyticsBundleSchema.parse({
      ...authoritative.bundle.bundle,
      queries: authoritative.bundle.bundle.queries.map((query) => query.id === "problem-tools"
        ? { ...query, title: "Stale problem tools", sql: "SELECT stale_value FROM stale_table", maxRows: 1 }
        : query),
      visualizations: authoritative.bundle.bundle.visualizations.map((visualization) => visualization.id === "failures"
        ? { ...visualization, title: "Stale failures" }
        : visualization),
    });
    const result = await exerciseExecutionBackedDashboard({
      ...authoritative,
      bundle: { bundle: staleBundle, builtin: true },
      client: createControlledExecutionClient(referenceResponse),
      rangeDays: 7,
      expectedDatumKey: authoritativeValue.execution.result.datumKeys[0]!,
      expectedReferenceId: referenceResponse.id,
      expectedReferenceToken: referenceResponse.token,
    });
    expect(result.renderedText).toContain("Authoritative failures");
    expect(result.renderedText).not.toContain("Stale failures");
    expect(result.referenceRequests).toHaveLength(2);
    expect(result.referenceRequests.every((request) => request.executionId === authoritativeValue.execution.executionId)).toBe(true);
  });

  it("retains A during B/C pending and keeps C after stale B settles", async () => {
    const a = revisionFixture("A", "a", "read");
    const b = revisionFixture("B", "b", "stale");
    const c = revisionFixture("C", "c", "new");
    const client = createControlledExecutionClient(referenceResponse);
    const result = await exerciseSupersessionAndRetention({
      a: { ...a, rangeDays: 7 },
      b: { ...b, rangeDays: 7 },
      c: { ...c, rangeDays: 7 },
      client,
    });
    expect(result.duringPendingText).toContain("read-problem-tools");
    expect(result.finalText).toContain("new-problem-tools");
  });

  it("keeps an already-open reference bound to the captured execution after bundle edit", async () => {
    const initial = revisionFixture("A", "a", "read");
    const edited = revisionFixture("edited", "e", "new");
    const initialValue = initial.results.get("problem-tools");
    if (initialValue == null) throw new Error("fixture missing initial problem-tools execution");
    const client = createControlledExecutionClient(referenceResponse);
    const result = await exerciseCapturedReferenceAfterBundleEdit({
      initial: {
        ...initial,
        client,
        rangeDays: 7,
        expectedDatumKey: initialValue.execution.result.datumKeys[0]!,
        expectedReferenceId: referenceResponse.id,
        expectedReferenceToken: referenceResponse.token,
      },
      edited: { ...edited, rangeDays: 7 },
    });
    expect(result.referenceRequest.executionId).toBe(initialValue.execution.executionId);
    expect(result.referenceRequest.visualizationId).toBe("failures");
  });

  it("downloads old captured plotted and returned payloads after a dashboard edit", async () => {
    const initial = revisionFixture("A", "a", "read");
    const edited = revisionFixture("edited", "e", "new");
    const initialValue = initial.results.get("problem-tools");
    if (initialValue == null) throw new Error("fixture missing download execution");
    const inputFor = (scope: "plotted" | "result") => ({
      initial: {
        ...initial,
        client: createControlledExecutionClient(referenceResponse),
        rangeDays: 7,
        expectedDatumKey: initialValue.execution.result.datumKeys[0]!,
        expectedReferenceId: referenceResponse.id,
        expectedReferenceToken: referenceResponse.token,
      },
      edited: { ...edited, rangeDays: 7 },
      scope,
    });
    for (const scope of ["plotted", "result"] as const) {
      const downloads = await exerciseCapturedDownloadAfterBundleEdit(inputFor(scope));
      expect(downloads).toHaveLength(2);
      const csv = downloads.find((download) => download.filename.endsWith(".csv"));
      const lineage = downloads.find((download) => download.filename.endsWith("-lineage.json"));
      if (csv == null || lineage == null) throw new Error("fixture missing captured download pair");
      expect(csv.type).toBe("text/csv;charset=utf-8");
      expect(csv.text).toContain("read-problem-tools");
      expect(csv.text).not.toContain("new-problem-tools");
      const manifest = JSON.parse(lineage.text) as {
        execution: { executionId: string };
        definition: { query: { title: string }; figures: Array<{ visualization: { id: string; title: string } }> };
        datumKeys: string[];
      };
      expect(manifest.execution.executionId).toBe(initialValue.execution.executionId);
      expect(manifest.definition.query.title).toBe(initialValue.definition.query.title);
      expect(manifest.definition.figures[0]?.visualization.title).toBe("Failures");
      expect(manifest.datumKeys).toEqual(initialValue.execution.result.datumKeys);
    }
  });

  it("exports a lower-bound returned result and shows its truncated extent", async () => {
    const initial = revisionFixture("A", "a", "read");
    const edited = revisionFixture("edited", "e", "new");
    const value = initial.results.get("problem-tools");
    if (value == null) throw new Error("fixture missing lower-bound execution");
    const lowerBoundResults = new Map(initial.results);
    lowerBoundResults.set("problem-tools", lowerBoundValue(value));
    const downloads = await exerciseCapturedDownloadAfterBundleEdit({
      initial: {
        ...initial,
        results: lowerBoundResults,
        client: createControlledExecutionClient(referenceResponse),
        rangeDays: 7,
        expectedDatumKey: value.execution.result.datumKeys[0]!,
        expectedReferenceId: referenceResponse.id,
        expectedReferenceToken: referenceResponse.token,
        expectedResultStatus: "Returned result: 1 rows returned · lower-bound extent (3+) · truncated",
      },
      edited: { ...edited, rangeDays: 7 },
      scope: "result",
    });
    const lineage = downloads.find((download) => download.filename.endsWith("-lineage.json"));
    if (lineage == null) throw new Error("fixture missing lower-bound lineage download");
    const manifest = JSON.parse(lineage.text) as {
      result: { extent: { kind: string; rows: number }; truncated: boolean };
    };
    expect(manifest.result.extent).toEqual({ kind: "lower-bound", rows: 3 });
    expect(manifest.result.truncated).toBe(true);
  });

  it("does not download partial payloads when captured artifact creation fails", async () => {
    const fixture = revisionFixture("A", "a", "read");
    const value = fixture.results.get("problem-tools");
    if (value == null) throw new Error("fixture missing failed-export execution");
    const failedResults = new Map(fixture.results);
    failedResults.set("problem-tools", lineageCapValue(value));
    const downloads = await exerciseCapturedExportFailureNoPartialDownload({
      ...fixture,
      results: failedResults,
      client: createControlledExecutionClient(referenceResponse),
      rangeDays: 7,
      expectedDatumKey: value.execution.result.datumKeys[0]!,
      expectedReferenceId: referenceResponse.id,
      expectedReferenceToken: referenceResponse.token,
    });
    expect(downloads).toHaveLength(0);
  });

  it("aborts the sibling when one query rejects AbortError and settles cleanup", async () => {
    const fixture = revisionFixture("A", "a", "read");
    const result = await exerciseAbortErrorWithPendingSibling({
      ...fixture,
      client: createControlledExecutionClient(referenceResponse),
      rangeDays: 7,
    });
    expect(result.siblingSignalAborted).toBe(true);
    expect(result.siblingAbortObserved).toBe(true);
    expect(result.siblingListenerAttachedAfterUnmount).toBe(false);
    expect(result.pendingAfterUnmount).toBe(0);
  });
});
