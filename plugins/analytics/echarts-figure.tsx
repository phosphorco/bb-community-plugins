import { memo, useEffect, useLayoutEffect, useRef } from "react";

import type { ChartIntent, FigureRuntimeController } from "./analytics-model.ts";
import type { AnalyticsCompiledFigure } from "./echarts-options.ts";
import { echarts } from "./echarts-registry.ts";
import { decideFigureUpdate } from "./echarts-update-policy.ts";

type Runtime = {
  chart: ReturnType<typeof echarts.init> | null;
  figure: AnalyticsCompiledFigure | null;
  resizeFrame: number | null;
  lastWidth: number;
  lastHeight: number;
  renderSettled: boolean;
  renderWaiters: Set<() => void>;
};

export const EChartsFigure = memo(function EChartsFigure({
  figure,
  onIntent,
  onController,
}: {
  figure: AnalyticsCompiledFigure;
  onIntent?: (intent: ChartIntent) => void;
  onController?: (controller: FigureRuntimeController | null) => void;
}) {
  const container = useRef<HTMLDivElement | null>(null);
  const runtime = useRef<Runtime>({
    chart: null,
    figure: null,
    resizeFrame: null,
    lastWidth: 0,
    lastHeight: 0,
    renderSettled: false,
    renderWaiters: new Set(),
  });
  const latestFigure = useRef(figure);
  const latestIntent = useRef(onIntent);
  const latestController = useRef(onController);
  latestFigure.current = figure;
  latestIntent.current = onIntent;
  latestController.current = onController;

  useLayoutEffect(() => {
    const target = container.current;
    if (target == null) return;
    const state = runtime.current;
    const consumedEvents = new WeakSet<object>();

    const emitContextIntent = (rawEvent: unknown, hitTarget: ChartIntent["target"]) => {
      const event = rawEvent instanceof MouseEvent ? rawEvent : null;
      if (event != null) {
        if (consumedEvents.has(event)) return;
        consumedEvents.add(event);
        event.preventDefault();
      }
      latestIntent.current?.({
        kind: "open-context-menu",
        figureId: latestFigure.current.visualization.id,
        clientX: event?.clientX ?? target.getBoundingClientRect().left + 12,
        clientY: event?.clientY ?? target.getBoundingClientRect().top + 12,
        target: hitTarget,
        source: "pointer",
      });
    };

    const bindEvents = (chart: NonNullable<Runtime["chart"]>) => {
      chart.on("finished", () => {
        state.renderSettled = true;
        for (const resolve of state.renderWaiters) resolve();
        state.renderWaiters.clear();
      });
      chart.on("contextmenu", (parameters: unknown) => {
        const eventParameters = parameters as { dataIndex?: number; seriesId?: string; event?: { event?: unknown } };
        const current = latestFigure.current;
        const datum = typeof eventParameters.dataIndex === "number"
          && eventParameters.seriesId === current.componentTopology.series[0]
          ? current.dataIndex.get(eventParameters.dataIndex)
          : undefined;
        emitContextIntent(eventParameters.event?.event, datum == null ? { kind: "figure" } : { kind: "datum", datum });
      });
      chart.getZr().on("contextmenu", (parameters: unknown) => {
        const zr = parameters as { target?: unknown; event?: unknown };
        if (zr.target != null) return;
        emitContextIntent(zr.event, { kind: "figure" });
      });
    };

    const initialize = () => {
      const bounds = target.getBoundingClientRect();
      if (bounds.width <= 0 || bounds.height <= 0 || state.chart != null) return;
      state.chart = echarts.init(target, null, { renderer: latestFigure.current.renderer });
      bindEvents(state.chart);
      state.renderSettled = false;
      state.chart.setOption(latestFigure.current.option, { notMerge: true, lazyUpdate: false, silent: true });
      state.figure = latestFigure.current;
      state.lastWidth = Math.round(bounds.width);
      state.lastHeight = Math.round(bounds.height);
      latestController.current?.({
        exportSvg: async () => {
          if (!state.renderSettled) {
            await Promise.race([
              new Promise<void>((resolve) => state.renderWaiters.add(resolve)),
              new Promise<void>((resolve) => window.setTimeout(resolve, 1_000)),
            ]);
          }
          return state.chart?.getDataURL({ type: "svg", pixelRatio: 1, excludeComponents: ["toolbox"] }) ?? null;
        },
      });
    };

    const observer = new ResizeObserver(([entry]) => {
      const width = Math.round(entry?.contentRect.width ?? 0);
      const height = Math.round(entry?.contentRect.height ?? 0);
      if (width <= 0 || height <= 0 || (width === state.lastWidth && height === state.lastHeight)) return;
      state.lastWidth = width;
      state.lastHeight = height;
      if (state.resizeFrame != null) cancelAnimationFrame(state.resizeFrame);
      state.resizeFrame = requestAnimationFrame(() => {
        state.resizeFrame = null;
        if (state.chart == null) initialize();
        else state.chart.resize({ width, height, silent: true });
      });
    });
    observer.observe(target);
    initialize();

    return () => {
      observer.disconnect();
      if (state.resizeFrame != null) cancelAnimationFrame(state.resizeFrame);
      state.resizeFrame = null;
      latestController.current?.(null);
      state.chart?.dispose();
      state.chart = null;
      state.figure = null;
      for (const resolve of state.renderWaiters) resolve();
      state.renderWaiters.clear();
    };
  }, [figure.instanceKey]);

  useEffect(() => {
    const state = runtime.current;
    if (state.chart == null) return;
    if (state.figure === figure) return;
    const decision = decideFigureUpdate(state.figure, figure);
    if (decision.kind === "rebuild-instance") return;
    state.renderSettled = false;
    if (decision.kind === "merge") {
      state.chart.setOption(figure.option, { notMerge: false, lazyUpdate: true, silent: true });
    } else if (decision.kind === "replace-families") {
      state.chart.setOption(figure.option, {
        notMerge: false,
        replaceMerge: [...decision.families],
        lazyUpdate: true,
        silent: true,
      });
    } else {
      state.chart.setOption(figure.option, { notMerge: true, lazyUpdate: false, silent: true });
    }
    state.figure = figure;
  }, [figure]);

  return <div ref={container} className="analytics-echart" data-renderer={figure.renderer} />;
});
