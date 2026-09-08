import assert from "node:assert/strict";
import test from "node:test";

import type { AnalyticsVisualization } from "../bundle-contract.ts";
import {
  buildEChartsOption,
  compileEChartsFigure,
  MAX_BAR_MARKS,
  MAX_LINE_MARKS,
  type AnalyticsChartTheme,
  type ChartRow,
} from "../echarts-options.ts";
import type { CanonicalQueryResult } from "../analytics-model.ts";

const theme: AnalyticsChartTheme = {
  foreground: "rgb(240, 240, 240)",
  muted: "rgb(150, 150, 150)",
  border: "rgb(80, 80, 80)",
  surface: "rgb(30, 30, 30)",
  series: "rgb(120, 90, 240)",
};

const bar = {
  id: "failures",
  queryId: "failures-query",
  kind: "bar",
  title: "Failures",
  x: "tool",
  y: "count",
  format: "integer",
} satisfies Extract<AnalyticsVisualization, { kind: "bar" }>;

const line = {
  ...bar,
  id: "daily-failures",
  kind: "line",
} satisfies Extract<AnalyticsVisualization, { kind: "line" }>;

test("bar compilation preserves SQL order and bounds a copied dataset", () => {
  const rows: ChartRow[] = Array.from({ length: 30 }, (_, index) => ({ tool: `tool-${index}`, count: index }));
  const original = structuredClone(rows);
  const option = buildEChartsOption(bar, rows, theme, false);
  const dataset = option.dataset as { source: ChartRow[]; id: string };

  assert.equal(dataset.id, "data-failures");
  assert.equal(dataset.source.length, MAX_BAR_MARKS);
  assert.equal(dataset.source[0]?.count, 0);
  assert.equal(dataset.source.at(-1)?.count, 23);
  assert.deepEqual(rows, original);
  assert.equal(Array.isArray(option.series) && option.series[0]?.id, "series-failures");
});

test("line compilation preserves query order and honors reduced motion", () => {
  const rows: ChartRow[] = [{ tool: "first", count: 2 }, { tool: "second", count: 1 }];
  const option = buildEChartsOption(line, rows, theme, true);
  const dataset = option.dataset as { source: ChartRow[] };

  assert.deepEqual(dataset.source.map((row) => row.tool), ["first", "second"]);
  assert.equal(option.animation, false);
  assert.equal(option.animationDuration, 0);
  assert.equal((option.aria as { enabled?: boolean }).enabled, true);
  assert.equal((option.tooltip as { renderMode?: string }).renderMode, "richText");
  assert.equal((option.grid as { outerBoundsMode?: string }).outerBoundsMode, "same");
});

test("rich compilation creates generation-scoped identity, lookup maps, and honest extents", () => {
  const rows: ChartRow[] = Array.from({ length: 30 }, (_, index) => ({ tool: `tool-${index}`, count: index }));
  const result = queryResult(rows, true);
  const compiled = compileEChartsFigure(bar, result, theme, false);
  assert.equal(compiled.plottedCount, MAX_BAR_MARKS);
  assert.deepEqual(compiled.total, { kind: "lower-bound", rows: 31 });
  assert.equal(compiled.dataIndex.get(0)?.datumKey, "generation:0");
  assert.equal(compiled.datumIndex.get("generation:0")?.label, "tool-0");
  assert.equal(compiled.semanticIndex.size, MAX_BAR_MARKS);
  assert.deepEqual(compiled.accessibleData, compiled.plottedRows);
  assert.deepEqual(compiled.exportData, result.rows);
  assert.equal(compiled.renderer, "svg");
});

test("line and bar use separate measured density lanes", () => {
  const rows: ChartRow[] = Array.from({ length: 140 }, (_, index) => ({ tool: `day-${index}`, count: index }));
  assert.equal(compileEChartsFigure(line, queryResult(rows), theme, false).plottedCount, MAX_LINE_MARKS);
  assert.equal(compileEChartsFigure(bar, queryResult(rows), theme, false).plottedCount, MAX_BAR_MARKS);
});

test("only trusted adapter formatters become callbacks", () => {
  const option = buildEChartsOption(bar, [{ tool: "read", count: 3 }], theme, false) as Record<string, unknown>;
  assert.equal(typeof (option.yAxis as { axisLabel?: { formatter?: unknown } }).axisLabel?.formatter, "function");
  assert.equal(containsFunction((option.dataset as { source: unknown }).source), false);
});

function queryResult(rows: ChartRow[], truncated = false): CanonicalQueryResult {
  return {
    id: "query",
    generation: "generation",
    generationId: 1,
    columns: [
      { name: "tool", logicalType: "VARCHAR", nullable: false },
      { name: "count", logicalType: "DOUBLE", nullable: false },
    ],
    rows,
    datumKeys: rows.map((_, index) => `generation:${index}`),
    parameters: { rangeDays: 14, maxRows: 500 },
    extent: truncated ? { kind: "lower-bound", rows: rows.length + 1 } : { kind: "exact", rows: rows.length },
    elapsedMs: 1,
    truncated,
    cached: false,
  };
}

function containsFunction(value: unknown): boolean {
  if (typeof value === "function") return true;
  if (Array.isArray(value)) return value.some(containsFunction);
  if (value != null && typeof value === "object") return Object.values(value).some(containsFunction);
  return false;
}
