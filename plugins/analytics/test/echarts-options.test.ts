import assert from "node:assert/strict";
import test from "node:test";

import type { AnalyticsVisualization } from "../bundle-contract.ts";
import {
  buildEChartsOption,
  MAX_CHART_ROWS,
  type AnalyticsChartTheme,
  type ChartRow,
} from "../echarts-options.ts";

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

test("bar compilation bounds and orders a copied dataset", () => {
  const rows: ChartRow[] = Array.from({ length: 30 }, (_, index) => ({ tool: `tool-${index}`, count: index }));
  const original = structuredClone(rows);
  const option = buildEChartsOption(bar, rows, theme, false);
  const dataset = option.dataset as { source: ChartRow[]; id: string };

  assert.equal(dataset.id, "data-failures");
  assert.equal(dataset.source.length, MAX_CHART_ROWS);
  assert.equal(dataset.source[0]?.count, 23);
  assert.equal(dataset.source.at(-1)?.count, 0);
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

test("compiled chart options contain data only, never callbacks", () => {
  const option = buildEChartsOption(bar, [{ tool: "read", count: 3 }], theme, false);
  assert.equal(containsFunction(option), false);
});

function containsFunction(value: unknown): boolean {
  if (typeof value === "function") return true;
  if (Array.isArray(value)) return value.some(containsFunction);
  if (value != null && typeof value === "object") return Object.values(value).some(containsFunction);
  return false;
}
