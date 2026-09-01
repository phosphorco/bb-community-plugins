import type { BarSeriesOption, LineSeriesOption } from "echarts/charts";
import type {
  AriaComponentOption,
  DatasetComponentOption,
  GridComponentOption,
  TooltipComponentOption,
} from "echarts/components";
import type { ComposeOption } from "echarts/core";

import type { AnalyticsVisualization } from "./bundle-contract.ts";

export const MAX_CHART_ROWS = 24;

export type ChartVisualization = Extract<AnalyticsVisualization, { kind: "bar" | "line" }>;
export type ChartRow = Record<string, string | number | boolean | null>;
export type AnalyticsChartTheme = {
  foreground: string;
  muted: string;
  border: string;
  surface: string;
  series: string;
};

export type AnalyticsChartOption = ComposeOption<
  | AriaComponentOption
  | BarSeriesOption
  | DatasetComponentOption
  | GridComponentOption
  | LineSeriesOption
  | TooltipComponentOption
>;

export function buildEChartsOption(
  visualization: ChartVisualization,
  rows: ChartRow[],
  theme: AnalyticsChartTheme,
  reducedMotion: boolean,
): AnalyticsChartOption {
  const source = rows.slice(0, MAX_CHART_ROWS);
  if (visualization.kind === "bar") {
    source.sort((left, right) => numericValue(right[visualization.y]) - numericValue(left[visualization.y]));
  }

  const commonSeries = {
    id: `series-${visualization.id}`,
    datasetId: `data-${visualization.id}`,
    encode: {
      x: visualization.x,
      y: visualization.y,
      itemName: visualization.x,
      tooltip: [visualization.x, visualization.y],
    },
  };

  return {
    aria: {
      enabled: true,
      description: `${visualization.title}. ${source.length.toLocaleString()} data points.`,
    },
    animation: !reducedMotion,
    animationDuration: reducedMotion ? 0 : 280,
    backgroundColor: "transparent",
    dataset: {
      id: `data-${visualization.id}`,
      dimensions: [visualization.x, visualization.y],
      source,
    },
    grid: {
      id: `grid-${visualization.id}`,
      left: 10,
      right: 12,
      top: 10,
      bottom: 12,
      outerBoundsMode: "same",
      outerBoundsContain: "axisLabel",
    },
    tooltip: {
      trigger: visualization.kind === "line" ? "axis" : "item",
      renderMode: "richText",
      confine: true,
      backgroundColor: theme.surface,
      borderColor: theme.border,
      textStyle: { color: theme.foreground, fontSize: 11 },
    },
    xAxis: {
      id: `x-${visualization.id}`,
      type: "category",
      axisLine: { lineStyle: { color: theme.border } },
      axisTick: { lineStyle: { color: theme.border } },
      axisLabel: {
        color: theme.muted,
        fontSize: 11,
        hideOverlap: true,
        rotate: 32,
      },
    },
    yAxis: {
      id: `y-${visualization.id}`,
      type: "value",
      min: visualization.kind === "bar" ? 0 : undefined,
      axisLabel: { color: theme.muted, fontSize: 11 },
      axisLine: { show: false },
      axisTick: { show: false },
      splitLine: { lineStyle: { color: theme.border, opacity: 0.55 } },
    },
    series: visualization.kind === "bar"
      ? [{
          ...commonSeries,
          type: "bar",
          barMaxWidth: 42,
          itemStyle: { color: theme.series, borderRadius: [4, 4, 0, 0] },
        }]
      : [{
          ...commonSeries,
          type: "line",
          showSymbol: true,
          symbolSize: 6,
          itemStyle: { color: theme.series },
          lineStyle: { color: theme.series, width: 2 },
        }],
  };
}

function numericValue(value: ChartRow[string]): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : Number.NEGATIVE_INFINITY;
}
