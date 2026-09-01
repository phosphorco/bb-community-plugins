import { memo, useEffect, useRef } from "react";
import { BarChart, LineChart } from "echarts/charts";
import { AriaComponent, DatasetComponent, GridComponent, TooltipComponent } from "echarts/components";
import * as echarts from "echarts/core";
import { SVGRenderer } from "echarts/renderers";

import type { AnalyticsVisualization } from "./bundle-contract.ts";
import {
  buildEChartsOption,
  type AnalyticsChartTheme,
  type ChartRow,
} from "./echarts-options.ts";

echarts.use([
  AriaComponent,
  BarChart,
  DatasetComponent,
  GridComponent,
  LineChart,
  SVGRenderer,
  TooltipComponent,
]);

type ChartVisualization = Extract<AnalyticsVisualization, { kind: "bar" | "line" }>;
type ChartController = { apply: () => void };

export const EChartsFigure = memo(function EChartsFigure({
  visualization,
  rows,
}: {
  visualization: ChartVisualization;
  rows: ChartRow[];
}) {
  const container = useRef<HTMLDivElement | null>(null);
  const latest = useRef({ visualization, rows });
  const controller = useRef<ChartController | null>(null);
  latest.current = { visualization, rows };

  useEffect(() => {
    const target = container.current;
    if (target == null) return;

    let chart: ReturnType<typeof echarts.init> | null = null;
    let lastWidth = 0;
    let lastHeight = 0;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

    const apply = () => {
      const bounds = target.getBoundingClientRect();
      if (bounds.width <= 0 || bounds.height <= 0) return;
      chart ??= echarts.init(target, null, { renderer: "svg" });
      const current = latest.current;
      chart.setOption(
        buildEChartsOption(current.visualization, current.rows, readChartTheme(target), reducedMotion.matches),
        { notMerge: true, lazyUpdate: true, silent: true },
      );
    };

    const resizeObserver = new ResizeObserver(([entry]) => {
      if (entry == null) return;
      const width = Math.round(entry.contentRect.width);
      const height = Math.round(entry.contentRect.height);
      if (width <= 0 || height <= 0 || (width === lastWidth && height === lastHeight)) return;
      lastWidth = width;
      lastHeight = height;
      if (chart == null) apply();
      else chart.resize({ width, height, silent: true });
    });
    resizeObserver.observe(target);

    const themeObserver = new MutationObserver(apply);
    for (let ancestor = target.parentElement; ancestor != null; ancestor = ancestor.parentElement) {
      themeObserver.observe(ancestor, {
        attributes: true,
        attributeFilter: ["class", "style", "data-theme"],
      });
    }

    reducedMotion.addEventListener("change", apply);
    controller.current = { apply };

    return () => {
      controller.current = null;
      reducedMotion.removeEventListener("change", apply);
      resizeObserver.disconnect();
      themeObserver.disconnect();
      chart?.dispose();
    };
  }, []);

  useEffect(() => {
    controller.current?.apply();
  }, [rows, visualization]);

  return <div ref={container} className="analytics-echart" data-renderer="echarts" />;
});

function readChartTheme(target: HTMLElement): AnalyticsChartTheme {
  const probe = document.createElement("span");
  probe.className = "analytics-echart-theme-probe";
  target.append(probe);
  const style = getComputedStyle(probe);
  const theme = {
    foreground: style.color,
    muted: style.borderTopColor,
    border: style.borderRightColor,
    surface: style.backgroundColor,
    series: style.borderBottomColor,
  };
  probe.remove();
  return theme;
}
