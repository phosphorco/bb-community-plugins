import {
  EXECUTION_LIMITS,
  executeQueryResponseSchema,
  utf8ByteLength,
  type ExecutionDefinition,
  type ExecutionResult,
} from "./execution-contract.ts";
import type {
  AnalyticsRow,
  AnalyticsChartTheme,
  ChartVisualization,
  CanonicalQueryResult,
  QueryResultExtent,
} from "./analytics-model.ts";
import { compileEChartsFigure, MAX_BAR_MARKS, MAX_LINE_MARKS } from "./echarts-options.ts";
import type { AnalyticsCompiledFigure } from "./echarts-options.ts";
import { echarts } from "./echarts-registry.ts";

export type CapturedFigureExportScope = "plotted" | "result";

export const CAPTURED_SVG_DEFAULT_WIDTH = 960;
export const CAPTURED_SVG_DEFAULT_HEIGHT = 540;
export const MAX_CAPTURED_SVG_WIDTH = 4_096;
export const MAX_CAPTURED_SVG_HEIGHT = 4_096;
export const MAX_CAPTURED_SVG_PIXELS = 4_000_000;
export const MAX_CAPTURED_SVG_THEME_BYTES = 256;
export const MAX_CAPTURED_SVG_BYTES = 1_048_576;

/** Stricter consumer quotas; neither value can raise the contract hard maximum. */
export type CapturedFigureExportBudget = Readonly<{
  maxCsvBytes?: number;
  maxLineageBytes?: number;
  maxSvgBytes?: number;
}>;

export type CapturedFigureExportInput = Readonly<{
  execution: ExecutionResult;
  definition: ExecutionDefinition;
  result: CanonicalQueryResult;
  figure: AnalyticsCompiledFigure;
}>;

export type CapturedFigureExportErrorCode =
  | "invalid-capture"
  | "unsupported-capture"
  | "invalid-budget"
  | "invalid-svg-options"
  | "aborted"
  | "csv-too-large"
  | "lineage-too-large"
  | "svg-too-large";

export class CapturedFigureExportError extends Error {
  readonly code: CapturedFigureExportErrorCode;

  constructor(code: CapturedFigureExportErrorCode, message: string) {
    super(message);
    this.name = "CapturedFigureExportError";
    this.code = code;
  }
}

export type CapturedCsvExport = Readonly<{
  text: string;
  byteLength: number;
}>;

export type CapturedLineageExport = Readonly<{
  text: string;
  byteLength: number;
}>;

export type CapturedFigureSvgOptions = Readonly<{
  width: number;
  height: number;
  theme: AnalyticsChartTheme;
  signal?: AbortSignal;
}>;

export type CapturedSvgExport = Readonly<{
  text: string;
  byteLength: number;
  lineage: CapturedLineageExport;
}>;

export type CapturedFigureExport = Readonly<{
  csv(scope: CapturedFigureExportScope): CapturedCsvExport;
  lineage(scope: CapturedFigureExportScope): CapturedLineageExport;
  svg(options: CapturedFigureSvgOptions): CapturedSvgExport;
}>;

type CapturedSnapshot = Readonly<{
  execution: Readonly<{
    executionId: ExecutionResult["executionId"];
    bundleId: ExecutionResult["resolved"]["bundleId"];
    bundleRevision: ExecutionResult["resolved"]["bundleRevision"];
    snapshot: ExecutionResult["resolved"]["snapshot"];
    coverage: ExecutionResult["coverage"];
  }>;
  definition: ExecutionDefinition;
  result: Readonly<{
    id: string;
    generation: string;
    columns: CanonicalQueryResult["columns"];
    rows: readonly AnalyticsRow[];
    datumKeys: readonly string[];
    parameters: CanonicalQueryResult["parameters"];
    extent: QueryResultExtent;
    elapsedMs: number;
    truncated: boolean;
    cached: boolean;
  }>;
  figure: Readonly<{
    visualization: ExecutionDefinition["figures"][number]["visualization"];
    plotted: ExecutionDefinition["figures"][number]["plotted"];
  }>;
}>;

export function rowsToCsv(rows: readonly AnalyticsRow[], fields?: readonly string[]): string {
  const columns = fields == null
    ? [...new Set(rows.flatMap((row) => Object.keys(row)))].sort()
    : [...fields];
  return [
    columns.map(csvCell).join(","),
    ...rows.map((row) => columns.map((column) => csvCell(row[column] ?? null)).join(",")),
  ].join("\r\n");
}

/**
 * Freeze the bounded data and provenance needed by a menu export. ECharts
 * options, maps, and the caller-owned execution graphs never enter the
 * returned artifact.
 */
export function createCapturedFigureExport(
  input: CapturedFigureExportInput,
  budget?: CapturedFigureExportBudget,
): CapturedFigureExport {
  const limits = resolveBudget(budget);
  let validated: Extract<ReturnType<typeof executeQueryResponseSchema.parse>, { kind: "success" }>;
  try {
    const parsed = executeQueryResponseSchema.parse({
      kind: "success",
      result: input.execution,
      definition: input.definition,
    });
    if (parsed.kind !== "success") {
      throw new CapturedFigureExportError(
        "invalid-capture",
        "The captured execution did not produce a success response.",
      );
    }
    validated = parsed;
  } catch {
    throw new CapturedFigureExportError(
      "invalid-capture",
      "The captured execution and definition failed paired response validation.",
    );
  }

  const execution = validated.result;
  const definition = validated.definition;
  const expectedResult = renderingResult(execution);
  assertSame("render result", input.result, expectedResult);

  const figureDefinition = definition.figures.find(
    (figure) => figure.visualization.id === input.figure.visualization.id,
  );
  if (figureDefinition == null) {
    throw new CapturedFigureExportError(
      "invalid-capture",
      "The captured execution definition does not contain the compiled figure.",
    );
  }
  if (!sameCanonical(input.figure.visualization, figureDefinition.visualization)) {
    throw new CapturedFigureExportError(
      "invalid-capture",
      "The compiled figure visualization does not match the captured definition.",
    );
  }
  if (input.figure.renderer !== "svg") {
    throw new CapturedFigureExportError(
      "unsupported-capture",
      "Captured data export supports only the current SVG figure renderer.",
    );
  }
  if (figureDefinition.plotted.reduction !== "none") {
    throw new CapturedFigureExportError(
      "unsupported-capture",
      `Captured figure reduction ${figureDefinition.plotted.reduction} is not supported by this export primitive.`,
    );
  }
  const maxRows = input.figure.visualization.kind === "bar" ? MAX_BAR_MARKS : MAX_LINE_MARKS;
  if (expectedResult.rows.length > maxRows) {
    throw new CapturedFigureExportError(
      "unsupported-capture",
      "Captured none-reduction data exceeds the current renderer mark bound.",
    );
  }
  if (
    !sameCanonical(figureDefinition.plotted.total, execution.result.resultExtent) ||
    !sameCanonical(input.figure.total, execution.result.resultExtent) ||
    figureDefinition.plotted.plottedRows !== expectedResult.rows.length ||
    input.figure.plottedCount !== expectedResult.rows.length ||
    input.figure.plottedRows.length !== expectedResult.rows.length ||
    input.figure.plottedDatumKeys.length !== expectedResult.datumKeys.length ||
    !sameCanonical(input.figure.plottedRows, expectedResult.rows) ||
    !sameCanonical(input.figure.plottedDatumKeys, expectedResult.datumKeys)
  ) {
    throw new CapturedFigureExportError(
      "invalid-capture",
      "The compiled figure does not preserve the captured canonical rows, keys, or extent.",
    );
  }

  const snapshot = freezeDeep(structuredClone({
    execution: {
      executionId: execution.executionId,
      bundleId: execution.resolved.bundleId,
      bundleRevision: execution.resolved.bundleRevision,
      snapshot: execution.resolved.snapshot,
      coverage: execution.coverage,
    },
    definition,
    result: {
      id: expectedResult.id,
      generation: expectedResult.generation,
      columns: execution.result.columns,
      rows: execution.result.rows,
      datumKeys: execution.result.datumKeys,
      parameters: expectedResult.parameters,
      extent: execution.result.resultExtent,
      elapsedMs: expectedResult.elapsedMs,
      truncated: execution.result.resultTruncated,
      cached: expectedResult.cached,
    },
    figure: {
      visualization: figureDefinition.visualization,
      plotted: figureDefinition.plotted,
    },
  } satisfies CapturedSnapshot));

  const outputs = Object.freeze({
    plotted: Object.freeze({
      csv: buildCapturedCsv(snapshot, "plotted", limits.maxCsvBytes),
      lineage: buildCapturedLineage(snapshot, "plotted", limits.maxLineageBytes),
    }),
    result: Object.freeze({
      csv: buildCapturedCsv(snapshot, "result", limits.maxCsvBytes),
      lineage: buildCapturedLineage(snapshot, "result", limits.maxLineageBytes),
    }),
  });
  return Object.freeze({
    csv: (scope: CapturedFigureExportScope) => outputs[scope].csv,
    lineage: (scope: CapturedFigureExportScope) => outputs[scope].lineage,
    svg: (options: CapturedFigureSvgOptions) => buildCapturedSvg(
      snapshot,
      options,
      limits.maxSvgBytes,
      limits.maxLineageBytes,
    ),
  });
}

export function downloadText(filename: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  queueMicrotask(() => URL.revokeObjectURL(url));
}

export function downloadDataUrl(filename: string, dataUrl: string): void {
  const anchor = document.createElement("a");
  anchor.href = dataUrl;
  anchor.download = filename;
  anchor.click();
}

function renderingResult(execution: ExecutionResult): CanonicalQueryResult {
  const rangeMs = execution.resolved.snapshot.frozenRange.endExclusiveMs - execution.resolved.snapshot.frozenRange.startInclusiveMs;
  return {
    id: execution.resolved.query.id,
    generation: execution.executionId,
    generationId: null,
    columns: execution.result.columns,
    rows: execution.result.rows,
    datumKeys: execution.result.datumKeys,
    parameters: {
      rangeDays: Math.max(1, Math.ceil(rangeMs / (24 * 60 * 60 * 1_000))),
      maxRows: execution.resolved.query.maxRows,
    },
    extent: execution.result.resultExtent,
    elapsedMs: execution.elapsedMs,
    truncated: execution.result.resultTruncated,
    cached: execution.cache.status === "physical-reuse",
  } satisfies CanonicalQueryResult;
}

function renderingResultFromSnapshot(snapshot: CapturedSnapshot): CanonicalQueryResult {
  return {
    id: snapshot.result.id,
    generation: snapshot.result.generation,
    generationId: null,
    columns: snapshot.result.columns,
    rows: snapshot.result.rows,
    datumKeys: snapshot.result.datumKeys,
    parameters: snapshot.result.parameters,
    extent: snapshot.result.extent,
    elapsedMs: snapshot.result.elapsedMs,
    truncated: snapshot.result.truncated,
    cached: snapshot.result.cached,
  };
}

function buildCapturedCsv(
  snapshot: CapturedSnapshot,
  scope: CapturedFigureExportScope,
  maxCsvBytes: number,
): CapturedCsvExport {
  const selected = selectedRows(snapshot, scope);
  const writer = new BoundedTextWriter(maxCsvBytes, "csv-too-large");
  const columns = snapshot.result.columns;
  appendCapturedCsvRow(writer, columns, null);
  for (let rowIndex = 0; rowIndex < selected.rows.length; rowIndex += 1) {
    writer.append("\r\n");
    const row = selected.rows[rowIndex];
    if (row == null) throw new CapturedFigureExportError("invalid-capture", "Captured CSV row is missing.");
    appendCapturedCsvRow(writer, columns, row);
  }
  return writer.finish();
}

function appendCapturedCsvRow(
  writer: BoundedTextWriter,
  columns: CapturedSnapshot["result"]["columns"],
  row: AnalyticsRow | null,
): void {
  for (let columnIndex = 0; columnIndex < columns.length; columnIndex += 1) {
    if (columnIndex > 0) writer.append(",");
    const column = columns[columnIndex];
    if (column == null) throw new CapturedFigureExportError("invalid-capture", "Captured CSV column is missing.");
    writer.append(row == null
      ? capturedCsvCell(formulaSafeText(column.name))
      : typedCsvCell(row[column.name], column.logicalType));
  }
}

function buildCapturedLineage(
  snapshot: CapturedSnapshot,
  scope: CapturedFigureExportScope,
  maxLineageBytes: number,
): CapturedLineageExport {
  const writer = new BoundedTextWriter(maxLineageBytes, "lineage-too-large");
  appendJsonValue(writer, capturedLineageManifest(snapshot, scope));
  return writer.finish();
}

function buildCapturedImageLineage(
  snapshot: CapturedSnapshot,
  options: ResolvedCapturedFigureSvgOptions,
  svgByteLength: number,
  maxLineageBytes: number,
): CapturedLineageExport {
  const writer = new BoundedTextWriter(maxLineageBytes, "lineage-too-large");
  appendJsonValue(writer, {
    ...capturedLineageManifest(snapshot, "plotted"),
    image: {
      width: options.width,
      height: options.height,
      devicePixelRatio: 1,
      theme: options.theme,
      renderer: "svg",
      animation: "off",
      viewportPolicy: "full-canonical-plot",
      svgByteLength,
    },
  });
  return writer.finish();
}

function capturedLineageManifest(
  snapshot: CapturedSnapshot,
  scope: CapturedFigureExportScope,
): Readonly<Record<string, unknown>> {
  const selected = selectedRows(snapshot, scope);
  const nullCells: Array<Readonly<{ datumKey: string; column: string }>> = [];
  const emptyStringCells: Array<Readonly<{ datumKey: string; column: string }>> = [];
  for (let rowIndex = 0; rowIndex < selected.rows.length; rowIndex += 1) {
    const row = selected.rows[rowIndex];
    const datumKey = selected.datumKeys[rowIndex];
    if (row == null || datumKey == null) {
      throw new CapturedFigureExportError("invalid-capture", "Captured lineage row identity is incomplete.");
    }
    for (const column of snapshot.result.columns) {
      const value = row[column.name];
      if (value === null) nullCells.push({ datumKey, column: column.name });
      else if (column.logicalType === "utf8" && value === "") emptyStringCells.push({ datumKey, column: column.name });
    }
  }
  return {
    version: 1,
    kind: "analytics-captured-data",
    scope,
    nullEncoding: "empty-csv-cell-with-lineage-nullCells",
    execution: snapshot.execution,
    definition: snapshot.definition,
    result: {
      id: snapshot.result.id,
      generation: snapshot.result.generation,
      columns: snapshot.result.columns,
      extent: snapshot.result.extent,
      truncated: snapshot.result.truncated,
    },
    figure: snapshot.figure,
    datumKeys: selected.datumKeys,
    nullCells,
    emptyStringCells,
  };
}

type ResolvedCapturedFigureSvgOptions = Readonly<{
  width: number;
  height: number;
  theme: AnalyticsChartTheme;
  signal?: AbortSignal;
}>;

function buildCapturedSvg(
  snapshot: CapturedSnapshot,
  options: CapturedFigureSvgOptions,
  maxSvgBytes: number,
  maxLineageBytes: number,
): CapturedSvgExport {
  const resolvedOptions = resolveSvgOptions(options);
  throwIfAborted(resolvedOptions.signal);
  const visualization = normalizeSvgVisualization(snapshot.figure.visualization);
  const result = renderingResultFromSnapshot(snapshot);
  let compiled: AnalyticsCompiledFigure;
  try {
    compiled = compileEChartsFigure(visualization, result, resolvedOptions.theme, true);
  } catch (cause) {
    throw new CapturedFigureExportError(
      "unsupported-capture",
      cause instanceof Error ? cause.message : "The captured figure cannot be compiled for SVG export.",
    );
  }
  if (
    compiled.plottedCount !== snapshot.figure.plotted.plottedRows ||
    !sameCanonical(compiled.total, snapshot.figure.plotted.total) ||
    !sameCanonical(compiled.plottedRows, snapshot.result.rows.slice(0, compiled.plottedCount)) ||
    !sameCanonical(compiled.plottedDatumKeys, snapshot.result.datumKeys.slice(0, compiled.plottedCount))
  ) {
    throw new CapturedFigureExportError(
      "invalid-capture",
      "The private SVG compilation changed the captured plotted rows, keys, or extent.",
    );
  }
  throwIfAborted(resolvedOptions.signal);

  const chart = echarts.init(null, null, {
    renderer: "svg",
    ssr: true,
    width: resolvedOptions.width,
    height: resolvedOptions.height,
    devicePixelRatio: 1,
  });
  try {
    chart.setOption(compiled.option, { notMerge: true, lazyUpdate: false, silent: true });
    throwIfAborted(resolvedOptions.signal);
    const text = chart.renderToSVGString({ useViewBox: false });
    const byteLength = utf8ByteLength(text);
    if (byteLength > maxSvgBytes) {
      throw new CapturedFigureExportError(
        "svg-too-large",
        `Captured SVG exceeds its ${maxSvgBytes}-byte return limit after synchronous rendering.`,
      );
    }
    throwIfAborted(resolvedOptions.signal);
    const lineage = buildCapturedImageLineage(snapshot, resolvedOptions, byteLength, maxLineageBytes);
    throwIfAborted(resolvedOptions.signal);
    return Object.freeze({ text, byteLength, lineage });
  } finally {
    chart.dispose();
  }
}

function resolveSvgOptions(options: CapturedFigureSvgOptions): ResolvedCapturedFigureSvgOptions {
  if (options == null || typeof options !== "object") {
    throw new CapturedFigureExportError("invalid-svg-options", "Captured SVG options must be an object.");
  }
  const width = options.width;
  const height = options.height;
  if (
    !Number.isSafeInteger(width) ||
    width < 1 ||
    width > MAX_CAPTURED_SVG_WIDTH ||
    !Number.isSafeInteger(height) ||
    height < 1 ||
    height > MAX_CAPTURED_SVG_HEIGHT ||
    width * height > MAX_CAPTURED_SVG_PIXELS
  ) {
    throw new CapturedFigureExportError(
      "invalid-svg-options",
      `Captured SVG dimensions must be safe integers within ${MAX_CAPTURED_SVG_WIDTH}×${MAX_CAPTURED_SVG_HEIGHT} and ${MAX_CAPTURED_SVG_PIXELS} pixels.`,
    );
  }
  if (options.theme == null || typeof options.theme !== "object") {
    throw new CapturedFigureExportError("invalid-svg-options", "Captured SVG theme must be an object.");
  }
  const theme = {
    foreground: copyThemeValue(options.theme.foreground),
    muted: copyThemeValue(options.theme.muted),
    border: copyThemeValue(options.theme.border),
    surface: copyThemeValue(options.theme.surface),
    series: copyThemeValue(options.theme.series),
  } satisfies AnalyticsChartTheme;
  const signal = options.signal;
  if (
    signal !== undefined &&
    (signal == null || typeof signal !== "object" || typeof signal.aborted !== "boolean")
  ) {
    throw new CapturedFigureExportError("invalid-svg-options", "Captured SVG signal must be an AbortSignal or undefined.");
  }
  return Object.freeze({
    width,
    height,
    theme: Object.freeze(theme),
    signal,
  });
}

function normalizeSvgVisualization(
  value: CapturedSnapshot["figure"]["visualization"],
): ChartVisualization {
  if (value.kind !== "bar" && value.kind !== "line") {
    throw new CapturedFigureExportError(
      "unsupported-capture",
      "Captured SVG export supports only bar and line visualizations.",
    );
  }
  if (value.format === "text") {
    throw new CapturedFigureExportError(
      "unsupported-capture",
      "Captured SVG export requires a non-text chart format.",
    );
  }
  return {
    id: value.id,
    queryId: value.queryId,
    kind: value.kind,
    title: value.title,
    x: value.x,
    y: value.y,
    format: value.format,
  };
}

function copyThemeValue(value: unknown): string {
  if (typeof value !== "string" || utf8ByteLength(value) > MAX_CAPTURED_SVG_THEME_BYTES) {
    throw new CapturedFigureExportError(
      "invalid-svg-options",
      `Each captured SVG theme value must be a string no larger than ${MAX_CAPTURED_SVG_THEME_BYTES} UTF-8 bytes.`,
    );
  }
  return value;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new CapturedFigureExportError("aborted", "Captured SVG export was cancelled before completion.");
  }
}

function selectedRows(
  snapshot: CapturedSnapshot,
  scope: CapturedFigureExportScope,
): Readonly<{ rows: readonly AnalyticsRow[]; datumKeys: readonly string[] }> {
  const count = scope === "plotted" ? snapshot.figure.plotted.plottedRows : snapshot.result.rows.length;
  return {
    rows: snapshot.result.rows.slice(0, count),
    datumKeys: snapshot.result.datumKeys.slice(0, count),
  };
}

function resolveBudget(
  budget: CapturedFigureExportBudget | undefined,
): Readonly<{ maxCsvBytes: number; maxLineageBytes: number; maxSvgBytes: number }> {
  if (budget === null || (budget != null && typeof budget !== "object")) {
    throw new CapturedFigureExportError(
      "invalid-budget",
      "Captured export budgets must be an object or undefined.",
    );
  }
  const maxCsvBytes = budget === undefined || budget.maxCsvBytes === undefined
    ? EXECUTION_LIMITS.maxCanonicalResultBytes
    : budget.maxCsvBytes;
  const maxLineageBytes = budget === undefined || budget.maxLineageBytes === undefined
    ? EXECUTION_LIMITS.maxReferenceBytes
    : budget.maxLineageBytes;
  const maxSvgBytes = budget === undefined || budget.maxSvgBytes === undefined
    ? MAX_CAPTURED_SVG_BYTES
    : budget.maxSvgBytes;
  if (
    !Number.isSafeInteger(maxCsvBytes) ||
    maxCsvBytes <= 0 ||
    maxCsvBytes > EXECUTION_LIMITS.maxCanonicalResultBytes ||
    !Number.isSafeInteger(maxLineageBytes) ||
    maxLineageBytes <= 0 ||
    maxLineageBytes > EXECUTION_LIMITS.maxReferenceBytes ||
    !Number.isSafeInteger(maxSvgBytes) ||
    maxSvgBytes <= 0 ||
    maxSvgBytes > MAX_CAPTURED_SVG_BYTES
  ) {
    throw new CapturedFigureExportError(
      "invalid-budget",
      "Captured export budgets must be positive safe integers no greater than the production maxima.",
    );
  }
  return { maxCsvBytes, maxLineageBytes, maxSvgBytes };
}

function typedCsvCell(value: unknown, logicalType: string): string {
  if (value === null) return capturedCsvCell("");
  const text = logicalType === "utf8"
    ? formulaSafeText(String(value))
    : String(value);
  return capturedCsvCell(text);
}

function formulaSafeText(value: string): string {
  return /^[\t\r\n ]*[=+\-@]/.test(value) ? `'${value}` : value;
}

function capturedCsvCell(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function assertSame(label: string, actual: unknown, expected: unknown): void {
  if (!sameCanonical(actual, expected)) {
    throw new CapturedFigureExportError("invalid-capture", `Captured ${label} does not match the paired execution result.`);
  }
}

function sameCanonical(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) &&
      left.length === right.length && left.every((value, index) => sameCanonical(value, right[index]));
  }
  if (left != null && right != null && typeof left === "object" && typeof right === "object") {
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const leftKeys = Object.keys(leftRecord).sort();
    const rightKeys = Object.keys(rightRecord).sort();
    return leftKeys.length === rightKeys.length &&
      leftKeys.every((key, index) => key === rightKeys[index] && sameCanonical(leftRecord[key], rightRecord[key]));
  }
  return false;
}

function freezeDeep<T>(value: T): T {
  if (value == null || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
  return value;
}

class BoundedTextWriter {
  private readonly chunks: string[] = [];
  private bytes = 0;
  private readonly limit: number;
  private readonly errorCode: "csv-too-large" | "lineage-too-large";

  constructor(
    limit: number,
    errorCode: "csv-too-large" | "lineage-too-large",
  ) {
    this.limit = limit;
    this.errorCode = errorCode;
  }

  append(value: string): void {
    const bytes = utf8ByteLength(value);
    if (this.bytes + bytes > this.limit) {
      throw new CapturedFigureExportError(
        this.errorCode,
        `Captured ${this.errorCode === "csv-too-large" ? "CSV" : "lineage"} exceeds its ${this.limit}-byte limit.`,
      );
    }
    this.chunks.push(value);
    this.bytes += bytes;
  }

  finish(): Readonly<{ text: string; byteLength: number }> {
    return Object.freeze({ text: this.chunks.join(""), byteLength: this.bytes });
  }
}

function appendJsonValue(writer: BoundedTextWriter, value: unknown): void {
  if (value === null) {
    writer.append("null");
    return;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    const encoded = JSON.stringify(value);
    if (encoded == null) throw new CapturedFigureExportError("invalid-capture", "Captured lineage contains an unsupported scalar.");
    writer.append(encoded);
    return;
  }
  if (Array.isArray(value)) {
    writer.append("[");
    value.forEach((item, index) => {
      if (index > 0) writer.append(",");
      appendJsonValue(writer, item);
    });
    writer.append("]");
    return;
  }
  if (typeof value === "object") {
    writer.append("{");
    Object.entries(value).forEach(([key, entry], index) => {
      if (index > 0) writer.append(",");
      writer.append(JSON.stringify(key));
      writer.append(":");
      appendJsonValue(writer, entry);
    });
    writer.append("}");
    return;
  }
  throw new CapturedFigureExportError("invalid-capture", "Captured lineage contains an unsupported value.");
}

function csvCell(value: unknown): string {
  let text = value == null ? "" : String(value);
  // Neutralize spreadsheet formula execution while keeping the visible value.
  if (/^[\t\r ]*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
