import type { BarSeriesOption, LineSeriesOption } from "echarts/charts";
import type { AriaComponentOption, DatasetComponentOption, GridComponentOption, TooltipComponentOption } from "echarts/components";
import type { ComposeOption } from "echarts/core";

import {
  stableHash,
  type AnalyticsChartTheme,
  type AnalyticsRow,
  type CanonicalQueryResult,
  type ChartComponentFamily,
  type ChartVisualization,
  type CompiledFigure,
  type InteractiveDatumMeta,
} from "./analytics-model.ts";
import { formatAnalyticsValue } from "./formatting.ts";

export const MAX_BAR_MARKS = 24;
export const MAX_LINE_MARKS = 120;
export const MAX_CHART_ROWS = MAX_BAR_MARKS;
export type { AnalyticsChartTheme } from "./analytics-model.ts";
export type ChartRow = AnalyticsRow;

export type AnalyticsChartOption = ComposeOption<
  | AriaComponentOption
  | BarSeriesOption
  | DatasetComponentOption
  | GridComponentOption
  | LineSeriesOption
  | TooltipComponentOption
>;
export type AnalyticsCompiledFigure = CompiledFigure<AnalyticsChartOption>;

export function compileEChartsFigure(
  visualization: ChartVisualization,
  result: CanonicalQueryResult,
  theme: AnalyticsChartTheme,
  reducedMotion: boolean,
): AnalyticsCompiledFigure {
  validateBindings(visualization, result);
  const markLimit = visualization.kind === "bar" ? MAX_BAR_MARKS : MAX_LINE_MARKS;
  // SQL owns analytical ordering and top-N semantics. The adapter only applies
  // a disclosed renderer-density cap and never re-sorts a convenient prefix.
  const plottedRows = result.rows.slice(0, markLimit);
  const plottedDatumKeys = result.datumKeys.slice(0, markLimit);
  const datumIndex = new Map<string, InteractiveDatumMeta>();
  const dataIndex = new Map<number, InteractiveDatumMeta>();
  const semanticIndex = new Map<string, string[]>();
  for (let index = 0; index < plottedRows.length; index += 1) {
    const row = plottedRows[index] as AnalyticsRow;
    const datumKey = plottedDatumKeys[index] as string;
    const value = row[visualization.y] ?? null;
    const label = String(row[visualization.x] ?? "—");
    const semanticKey = `analytics:${visualization.x}:${stableHash(JSON.stringify(row[visualization.x] ?? null))}`;
    const meta: InteractiveDatumMeta = {
      datumKey,
      semanticKey,
      dataIndex: index,
      label,
      value,
      row,
      predicate: { field: visualization.x, operator: "eq", value: row[visualization.x] ?? null },
    };
    datumIndex.set(datumKey, meta);
    dataIndex.set(index, meta);
    const matches = semanticIndex.get(semanticKey) ?? [];
    matches.push(datumKey);
    semanticIndex.set(semanticKey, matches);
  }

  const ids = componentIds(visualization.id);
  const commonSeries = {
    id: ids.series,
    datasetId: ids.dataset,
    encode: {
      x: visualization.x,
      y: visualization.y,
      itemName: visualization.x,
      tooltip: [visualization.x, visualization.y],
    },
    tooltip: {
      valueFormatter: (value: unknown) => formatAnalyticsValue(scalar(value), visualization.format),
    },
  };
  const option: AnalyticsChartOption = {
    aria: {
      enabled: true,
      description: `${visualization.title}. ${plottedRows.length.toLocaleString()} plotted data points.`,
    },
    animation: !reducedMotion,
    animationDuration: reducedMotion ? 0 : 280,
    backgroundColor: "transparent",
    dataset: { id: ids.dataset, dimensions: [visualization.x, visualization.y], source: plottedRows },
    grid: {
      id: ids.grid,
      left: 10,
      right: 12,
      top: 10,
      bottom: 12,
      outerBoundsMode: "same",
      outerBoundsContain: "axisLabel",
    },
    tooltip: {
      id: ids.tooltip,
      trigger: visualization.kind === "line" ? "axis" : "item",
      renderMode: "richText",
      confine: true,
      backgroundColor: theme.surface,
      borderColor: theme.border,
      textStyle: { color: theme.foreground, fontSize: 11 },
    },
    xAxis: {
      id: ids.xAxis,
      type: "category",
      axisLine: { lineStyle: { color: theme.border } },
      axisTick: { lineStyle: { color: theme.border } },
      axisLabel: { color: theme.muted, fontSize: 11, hideOverlap: true, rotate: 32 },
    },
    yAxis: {
      id: ids.yAxis,
      type: "value",
      min: visualization.kind === "bar" ? 0 : undefined,
      axisLabel: {
        color: theme.muted,
        fontSize: 11,
        formatter: (value: number) => formatAnalyticsValue(value, visualization.format),
      },
      axisLine: { show: false },
      axisTick: { show: false },
      splitLine: { lineStyle: { color: theme.border, opacity: 0.55 } },
    },
    series: visualization.kind === "bar"
      ? [{ ...commonSeries, type: "bar", barMaxWidth: 42, itemStyle: { color: theme.series, borderRadius: [4, 4, 0, 0] } }]
      : [{ ...commonSeries, type: "line", showSymbol: plottedRows.length <= 45, symbolSize: 6, itemStyle: { color: theme.series }, lineStyle: { color: theme.series, width: 2 } }],
  };

  const componentTopology: Record<ChartComponentFamily, readonly string[]> = {
    aria: [ids.aria], dataset: [ids.dataset], grid: [ids.grid], series: [ids.series],
    tooltip: [ids.tooltip], xAxis: [ids.xAxis], yAxis: [ids.yAxis],
  };
  return {
    visualization,
    option,
    renderer: "svg",
    instanceKey: "analytics-echarts:svg:v1",
    structuralSignature: JSON.stringify([
      visualization.kind, visualization.x, visualization.y, visualization.format, componentTopology,
    ]),
    componentTopology,
    datumIndex,
    dataIndex,
    semanticIndex,
    plottedRows,
    plottedDatumKeys,
    plottedCount: plottedRows.length,
    total: result.extent,
    accessibleData: plottedRows,
    exportData: result.rows,
    format: visualization.format,
  };
}

function validateBindings(visualization: ChartVisualization, result: CanonicalQueryResult): void {
  const columns = new Set(result.columns.map((column) => column.name));
  if (!columns.has(visualization.x)) throw new Error(`${visualization.title} references missing dimension ${visualization.x}.`);
  if (!columns.has(visualization.y)) throw new Error(`${visualization.title} references missing measure ${visualization.y}.`);
  const invalid = result.rows.find((row) => {
    const value = row[visualization.y];
    return value != null && value !== "" && !Number.isFinite(typeof value === "number" ? value : Number(value));
  });
  if (invalid != null) throw new Error(`${visualization.title} requires numeric values in ${visualization.y}.`);
}

function componentIds(id: string) {
  return {
    aria: `aria-${id}`,
    dataset: `data-${id}`,
    grid: `grid-${id}`,
    series: `series-${id}`,
    tooltip: `tooltip-${id}`,
    xAxis: `x-${id}`,
    yAxis: `y-${id}`,
  } as const;
}

function scalar(value: unknown): string | number | boolean | null {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : null;
}

/** Compatibility helper retained for v1 callers while the host uses the rich compiler. */
export function buildEChartsOption(
  visualization: ChartVisualization,
  rows: AnalyticsRow[],
  theme: AnalyticsChartTheme,
  reducedMotion: boolean,
): AnalyticsChartOption {
  const result: CanonicalQueryResult = {
    id: visualization.queryId,
    generation: "compat",
    generationId: null,
    columns: [
      { name: visualization.x, logicalType: "VARCHAR", nullable: true },
      { name: visualization.y, logicalType: "DOUBLE", nullable: true },
    ],
    rows,
    datumKeys: rows.map((_, index) => `compat:${index}`),
    parameters: { rangeDays: 1, maxRows: rows.length },
    extent: { kind: "exact", rows: rows.length },
    elapsedMs: 0,
    truncated: false,
    cached: false,
  };
  return compileEChartsFigure(visualization, result, theme, reducedMotion).option;
}
