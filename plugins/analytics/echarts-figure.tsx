import { memo, useEffect, useLayoutEffect, useRef } from "react";

import type { ChartIntent, FigureRuntimeController } from "./analytics-model.ts";
import type { AnalyticsCompiledFigure } from "./echarts-options.ts";
import { echarts } from "./echarts-registry.ts";
import { decideFigureUpdate } from "./echarts-update-policy.ts";

type EChartsInstance = ReturnType<typeof echarts.init>;
type FigureSetOptionOptions = Readonly<{
  notMerge: boolean;
  lazyUpdate: false;
  silent: boolean;
  replaceMerge?: string[];
}>;

type CommittedTuple = Readonly<{
  figure: AnalyticsCompiledFigure;
  onIntent?: (intent: ChartIntent) => void;
  onController?: (controller: FigureRuntimeController | null) => void;
  commitToken: object;
}>;

type AppliedTuple = Readonly<CommittedTuple & {
  instanceToken: object;
}>;

type ChartBinding = Readonly<{
  chart: EChartsInstance;
  instanceToken: object;
  onFinished: () => void;
  onContextMenu: (parameters: unknown) => void;
  onZrContextMenu: (parameters: unknown) => void;
}>;

type Runtime = {
  chart: EChartsInstance | null;
  binding: ChartBinding | null;
  committed: CommittedTuple | null;
  applied: AppliedTuple | null;
  instanceToken: object | null;
  effectToken: object | null;
  controller: FigureRuntimeController | null;
  controllerPublication: Readonly<{
    callback: (controller: FigureRuntimeController | null) => void;
    controller: FigureRuntimeController;
    instanceToken: object;
  }> | null;
  applying: boolean;
  interactionsValid: boolean;
  resizeFrame: number | null;
  lastWidth: number;
  lastHeight: number;
  renderSettled: boolean;
  pendingFinished: boolean;
  renderWaiters: Set<() => void>;
  applyCommittedOption: ((
    tuple: CommittedTuple,
    chart: EChartsInstance,
    instanceToken: object,
    options: FigureSetOptionOptions,
  ) => boolean) | null;
  invalidateInstance: ((chart: EChartsInstance, instanceToken: object) => void) | null;
};

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

function clearControllerPublication(state: Runtime): void {
  const publication = state.controllerPublication;
  state.controllerPublication = null;
  try {
    publication?.callback(null);
  } catch {
    // Callback cleanup cannot make the chart owner live again.
  }
}

function publishController(state: Runtime, tuple: AppliedTuple, controller: FigureRuntimeController): void {
  const previous = state.controllerPublication;
  if (previous?.callback === tuple.onController && previous?.controller === controller && previous.instanceToken === tuple.instanceToken) return;
  try {
    previous?.callback(null);
  } catch {
    // The new publication remains owned by the committed tuple.
  }
  const callback = tuple.onController;
  if (callback == null) {
    state.controllerPublication = null;
    return;
  }
  state.controllerPublication = {
    callback,
    controller,
    instanceToken: tuple.instanceToken,
  };
  callback(controller);
}

function ownsRuntimeInstance(
  state: Runtime,
  effectToken: object,
  chart: EChartsInstance,
  instanceToken: object,
): boolean {
  return state.effectToken === effectToken
    && state.chart === chart
    && state.binding?.instanceToken === instanceToken
    && state.instanceToken === instanceToken;
}

function isLiveRuntimeInstance(
  state: Runtime,
  effectToken: object,
  chart: EChartsInstance,
  instanceToken: object,
): boolean {
  return ownsRuntimeInstance(state, effectToken, chart, instanceToken)
    && !(typeof chart.isDisposed === "function" && chart.isDisposed());
}

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
    binding: null,
    committed: null,
    applied: null,
    instanceToken: null,
    effectToken: null,
    controller: null,
    controllerPublication: null,
    applying: false,
    interactionsValid: false,
    resizeFrame: null,
    lastWidth: 0,
    lastHeight: 0,
    renderSettled: false,
    pendingFinished: false,
    renderWaiters: new Set(),
    applyCommittedOption: null,
    invalidateInstance: null,
  });

  useLayoutEffect(() => {
    const state = runtime.current;
    const committed: CommittedTuple = Object.freeze({
      figure,
      onIntent,
      onController,
      commitToken: {},
    });
    state.committed = committed;
    const applied = state.applied;
    const chart = state.chart;
    const effectToken = state.effectToken;
    if (
      applied != null
      && applied.figure === figure
      && chart != null
      && effectToken != null
      && isLiveRuntimeInstance(state, effectToken, chart, applied.instanceToken)
      && state.instanceToken === applied.instanceToken
      && state.interactionsValid
    ) {
      const nextApplied: AppliedTuple = Object.freeze({
        ...applied,
        onIntent,
        onController,
        commitToken: committed.commitToken,
      });
      state.applied = nextApplied;
      if (state.controller != null) publishController(state, nextApplied, state.controller);
    } else if (applied?.figure !== figure) {
      clearControllerPublication(state);
    }
  }, [figure, onController, onIntent]);

  useLayoutEffect(() => {
    const target = container.current;
    if (target == null) return;
    const state = runtime.current;
    const effectToken = {};
    state.effectToken = effectToken;
    const consumedEvents = new WeakSet<object>();

    const ownsInstance = (chart: EChartsInstance, instanceToken: object): boolean => ownsRuntimeInstance(state, effectToken, chart, instanceToken);
    const isLiveInstance = (chart: EChartsInstance, instanceToken: object): boolean => isLiveRuntimeInstance(state, effectToken, chart, instanceToken);

    const canInteract = (chart: EChartsInstance, instanceToken: object): boolean => {
      const applied = state.applied;
      return isLiveInstance(chart, instanceToken)
        && state.interactionsValid
        && !state.applying
        && applied?.instanceToken === instanceToken
        && state.committed?.figure === applied.figure;
    };

    const resolveRenderWaiters = (): void => {
      const waiters = [...state.renderWaiters];
      state.renderWaiters.clear();
      for (const resolve of waiters) resolve();
    };

    const invalidateInstance = (chart: EChartsInstance, instanceToken: object): void => {
      if (!ownsInstance(chart, instanceToken)) return;
      const binding = state.binding;
      state.chart = null;
      state.binding = null;
      state.instanceToken = null;
      state.applied = null;
      state.controller = null;
      state.interactionsValid = false;
      state.applying = false;
      state.renderSettled = false;
      state.pendingFinished = false;
      state.lastWidth = 0;
      state.lastHeight = 0;
      clearControllerPublication(state);
      resolveRenderWaiters();
      try {
        binding?.chart.off("finished", binding.onFinished);
      } catch {
        // Disposal remains fail-closed even if an exact handler removal fails.
      }
      try {
        binding?.chart.off("contextmenu", binding.onContextMenu);
      } catch {
        // Disposal remains fail-closed even if an exact handler removal fails.
      }
      try {
        binding?.chart.getZr().off("contextmenu", binding.onZrContextMenu);
      } catch {
        // Disposal remains fail-closed even if an exact handler removal fails.
      }
      try {
        chart.dispose();
      } catch {
        // The owner/token was invalidated before disposal and cannot receive events.
      }
    };

    const emitContextIntent = (
      chart: EChartsInstance,
      instanceToken: object,
      rawEvent: unknown,
      hitTarget: ChartIntent["target"],
    ): void => {
      if (!canInteract(chart, instanceToken)) return;
      const applied = state.applied;
      if (applied == null) return;
      const event = rawEvent instanceof MouseEvent ? rawEvent : null;
      if (event != null) {
        if (consumedEvents.has(event)) return;
        consumedEvents.add(event);
        event.preventDefault();
      }
      const bounds = target.getBoundingClientRect();
      applied.onIntent?.({
        kind: "open-context-menu",
        figureId: applied.figure.visualization.id,
        clientX: event?.clientX ?? bounds.left + 12,
        clientY: event?.clientY ?? bounds.top + 12,
        target: hitTarget,
        source: "pointer",
      });
    };

    const bindEvents = (chart: EChartsInstance, instanceToken: object): ChartBinding => {
      const onFinished = (): void => {
        if (!isLiveInstance(chart, instanceToken)) return;
        if (state.applying) {
          state.pendingFinished = true;
          return;
        }
        state.renderSettled = true;
        resolveRenderWaiters();
      };
      const onContextMenu = (parameters: unknown): void => {
        if (!canInteract(chart, instanceToken)) return;
        const eventParameters = isRecord(parameters) ? parameters : {};
        const current = state.applied?.figure;
        if (current == null) return;
        const seriesId = typeof eventParameters.seriesId === "string" ? eventParameters.seriesId : null;
        const dataIndex = typeof eventParameters.dataIndex === "number" ? eventParameters.dataIndex : null;
        if (
          seriesId !== current.componentTopology.series[0]
          || dataIndex == null
          || !Number.isInteger(dataIndex)
          || dataIndex < 0
          || dataIndex >= current.dataIndex.size
        ) return;
        const datum = current.dataIndex.get(dataIndex);
        if (datum == null) return;
        const eventPacket = isRecord(eventParameters.event) ? eventParameters.event : null;
        emitContextIntent(chart, instanceToken, eventPacket?.event, { kind: "datum", datum });
      };
      const onZrContextMenu = (parameters: unknown): void => {
        if (!canInteract(chart, instanceToken)) return;
        const zr = isRecord(parameters) ? parameters : {};
        const hasTarget = Object.prototype.hasOwnProperty.call(zr, "target");
        const hasTopTarget = Object.prototype.hasOwnProperty.call(zr, "topTarget");
        if (!hasTarget || !hasTopTarget) return;
        if (zr.target !== null && zr.target !== undefined) return;
        if (zr.topTarget !== null && zr.topTarget !== undefined) return;
        if (!(zr.event instanceof MouseEvent)) return;
        emitContextIntent(chart, instanceToken, zr.event, { kind: "figure" });
      };
      chart.on("finished", onFinished);
      chart.on("contextmenu", onContextMenu);
      chart.getZr().on("contextmenu", onZrContextMenu);
      return Object.freeze({ chart, instanceToken, onFinished, onContextMenu, onZrContextMenu });
    };

    const applyCommittedOption = (
      tuple: CommittedTuple,
      chart: EChartsInstance,
      instanceToken: object,
      options: FigureSetOptionOptions,
    ): boolean => {
      if (!isLiveInstance(chart, instanceToken) || state.committed !== tuple) return false;
      state.applying = true;
      state.pendingFinished = false;
      state.renderSettled = false;
      try {
        chart.setOption(tuple.figure.option, options);
      } catch {
        invalidateInstance(chart, instanceToken);
        return false;
      }
      if (!ownsInstance(chart, instanceToken)) return false;
      if (!isLiveInstance(chart, instanceToken)) {
        invalidateInstance(chart, instanceToken);
        return false;
      }
      if (state.committed !== tuple) {
        state.applying = false;
        return false;
      }
      const applied: AppliedTuple = Object.freeze({ ...tuple, instanceToken });
      state.applied = applied;
      state.interactionsValid = true;
      if (state.pendingFinished) {
        state.pendingFinished = false;
        state.renderSettled = true;
        resolveRenderWaiters();
      }
      state.applying = false;
      if (state.controller != null && isLiveInstance(chart, instanceToken)) publishController(state, applied, state.controller);
      return true;
    };

    const waitForRender = (chart: EChartsInstance, instanceToken: object): Promise<void> => new Promise((resolve) => {
      let finished = false;
      let timer: number | null = null;
      const complete = (): void => {
        if (finished) return;
        finished = true;
        if (timer != null) window.clearTimeout(timer);
        state.renderWaiters.delete(complete);
        resolve();
      };
      state.renderWaiters.add(complete);
      timer = window.setTimeout(complete, 1_000);
      if (!isLiveInstance(chart, instanceToken) || state.renderSettled) complete();
    });

    const createController = (chart: EChartsInstance, instanceToken: object): FigureRuntimeController => ({
      exportSvg: async () => {
        if (!canInteract(chart, instanceToken)) return null;
        if (!state.renderSettled) await waitForRender(chart, instanceToken);
        if (!canInteract(chart, instanceToken) || !state.renderSettled) return null;
        try {
          const result = chart.getDataURL({ type: "svg", pixelRatio: 1, excludeComponents: ["toolbox"] });
          return canInteract(chart, instanceToken) ? result : null;
        } catch {
          invalidateInstance(chart, instanceToken);
          return null;
        }
      },
    });

    state.applyCommittedOption = applyCommittedOption;
    state.invalidateInstance = invalidateInstance;

    const initialize = (): void => {
      if (state.effectToken !== effectToken || state.chart != null) return;
      const tuple = state.committed;
      if (tuple == null) return;
      const bounds = target.getBoundingClientRect();
      if (bounds.width <= 0 || bounds.height <= 0) return;
      const chart = echarts.init(target, null, { renderer: tuple.figure.renderer });
      const instanceToken = {};
      state.chart = chart;
      state.instanceToken = instanceToken;
      state.interactionsValid = false;
      state.applied = null;
      const binding = bindEvents(chart, instanceToken);
      state.binding = binding;
      const options: FigureSetOptionOptions = { notMerge: true, lazyUpdate: false, silent: true };
      if (!applyCommittedOption(tuple, chart, instanceToken, options)) return;
      if (!isLiveInstance(chart, instanceToken) || state.committed !== tuple || state.applied == null) return;
      const applied = state.applied;
      state.lastWidth = Math.round(bounds.width);
      state.lastHeight = Math.round(bounds.height);
      const controller = createController(chart, instanceToken);
      state.controller = controller;
      publishController(state, applied, controller);
    };

    const observer = new ResizeObserver(([entry]) => {
      if (state.effectToken !== effectToken) return;
      const width = Math.round(entry?.contentRect.width ?? 0);
      const height = Math.round(entry?.contentRect.height ?? 0);
      if (width <= 0 || height <= 0 || (width === state.lastWidth && height === state.lastHeight)) return;
      state.lastWidth = width;
      state.lastHeight = height;
      if (state.resizeFrame != null) cancelAnimationFrame(state.resizeFrame);
      state.resizeFrame = requestAnimationFrame(() => {
        state.resizeFrame = null;
        if (state.effectToken !== effectToken) return;
        const chart = state.chart;
        const instanceToken = state.instanceToken;
        if (chart == null || instanceToken == null) {
          initialize();
          return;
        }
        if (!canInteract(chart, instanceToken)) return;
        try {
          chart.resize({ width, height, silent: true });
        } catch {
          invalidateInstance(chart, instanceToken);
        }
      });
    });
    observer.observe(target);
    initialize();

    return () => {
      observer.disconnect();
      if (state.resizeFrame != null) cancelAnimationFrame(state.resizeFrame);
      state.resizeFrame = null;
      const chart = state.chart;
      const instanceToken = state.instanceToken;
      if (chart != null && instanceToken != null) invalidateInstance(chart, instanceToken);
      else {
        state.applied = null;
        state.controller = null;
        state.interactionsValid = false;
        state.applying = false;
        state.renderSettled = false;
        resolveRenderWaiters();
        clearControllerPublication(state);
      }
      if (state.effectToken === effectToken) {
        state.applyCommittedOption = null;
        state.invalidateInstance = null;
        state.effectToken = null;
      }
    };
  }, [figure.instanceKey]);

  useEffect(() => {
    const state = runtime.current;
    const tuple = state.committed;
    const applied = state.applied;
    const chart = state.chart;
    const instanceToken = state.instanceToken;
    if (tuple == null || tuple.figure !== figure || applied == null || chart == null || instanceToken == null) return;
    if (applied.figure === figure) return;
    const decision = decideFigureUpdate(applied.figure, figure);
    if (decision.kind === "rebuild-instance") return;
    const options: FigureSetOptionOptions = decision.kind === "merge"
      ? { notMerge: false, lazyUpdate: false, silent: true }
      : decision.kind === "replace-families"
        ? { notMerge: false, replaceMerge: [...decision.families], lazyUpdate: false, silent: true }
        : { notMerge: true, lazyUpdate: false, silent: true };
    if (state.effectToken == null || state.applyCommittedOption == null) return;
    state.applyCommittedOption(tuple, chart, instanceToken, options);
  }, [figure]);

  return <div ref={container} className="analytics-echart" data-renderer={figure.renderer} />;
});
