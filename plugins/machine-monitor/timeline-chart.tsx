import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { LineChart, LinesChart, ScatterChart } from "echarts/charts";
import { AriaComponent, GridComponent, MarkAreaComponent, TooltipComponent } from "echarts/components";
import * as echarts from "echarts/core";
import { SVGRenderer } from "echarts/renderers";

import type { MachineTimelineResult } from "./fleet-contract.ts";
import {
  activateMachineTimelineEvent,
  compileMachineTimeline,
  decideMachineTimelineUpdate,
  resolveMachineTimelineChartIntent,
  type CompiledMachineTimeline,
  type TimelineChartIntent,
  type TimelineChartTheme,
  type TimelineEventActivation,
} from "./timeline-compiler.ts";

// This is the sole ECharts registry and lifecycle owner for fleet timelines.
echarts.use([AriaComponent, GridComponent, LineChart, LinesChart, MarkAreaComponent, ScatterChart, SVGRenderer, TooltipComponent]);

export type MachineTimelineChartProps = Readonly<{
  timeline: MachineTimelineResult;
  /** A retained cached generation is still useful, but must be visibly stale. */
  stale?: boolean;
  refreshing?: boolean;
  /** Retained data for another selected machine must not look actionable. */
  activationDisabled?: boolean;
  className?: string;
  onActivateEvent?: (activation: TimelineEventActivation) => void;
}>;

type MachineTimelineEChartsHostProps = Readonly<{
  compile: (theme: TimelineChartTheme) => CompiledMachineTimeline;
  label: string;
  minimumHeight?: number;
  activationDisabled?: boolean;
  onIntent?: (intent: TimelineChartIntent) => void;
}>;

function cssColor(value: string, fallback: string): string {
  return value.length > 0 && value !== "rgba(0, 0, 0, 0)" && value !== "transparent" ? value : fallback;
}

function resolveTheme(element: HTMLElement): TimelineChartTheme {
  const style = getComputedStyle(element);
  return {
    foreground: cssColor(style.color, "#111827"),
    muted: cssColor(style.borderTopColor, "#6b7280"),
    border: cssColor(style.borderRightColor, "#d1d5db"),
    surface: cssColor(style.backgroundColor, "#ffffff"),
    gap: cssColor(style.borderBottomColor, "#9ca3af"),
  };
}

function themeFingerprint(theme: TimelineChartTheme): string {
  return JSON.stringify(theme);
}

/**
 * Imperative ECharts is fully contained here.  It observes only its owned
 * element, never mirrors resize or hover into React state, and its event
 * listener resolves the current compiler-owned datum map before publication.
 */
export function MachineTimelineEChartsHost({ compile, label, minimumHeight = 240, activationDisabled = false, onIntent }: MachineTimelineEChartsHostProps) {
  const target = useRef<HTMLDivElement | null>(null);
  const compileRef = useRef(compile);
  const intentRef = useRef(onIntent);
  const scheduleApplyRef = useRef<(() => void) | null>(null);
  compileRef.current = compile;
  intentRef.current = onIntent;

  useLayoutEffect(() => {
    const element = target.current;
    if (element == null) return;

    let chart: ReturnType<typeof echarts.init> | null = null;
    let applied: CompiledMachineTimeline | null = null;
    let disposed = false;
    let resizeFrame = 0;
    let pendingSize: { width: number; height: number } | null = null;
    let appliedSize: { width: number; height: number } | null = null;
    let resolvedThemeKey = "";
    const scheduleFrame = (callback: FrameRequestCallback): number => typeof window.requestAnimationFrame === "function"
      ? window.requestAnimationFrame(callback)
      : window.setTimeout(() => callback(Date.now()), 0);
    const cancelFrame = (frame: number): void => {
      if (frame === 0) return;
      if (typeof window.cancelAnimationFrame === "function") window.cancelAnimationFrame(frame);
      else window.clearTimeout(frame);
    };

    const apply = () => {
      if (disposed) return;
      const measured = pendingSize ?? (() => {
        const bounds = element.getBoundingClientRect();
        return { width: Math.round(bounds.width), height: Math.round(bounds.height) };
      })();
      pendingSize = null;
      const { width, height } = measured;
      if (width <= 0 || height <= 0) return;

      const theme = resolveTheme(element);
      const nextThemeKey = themeFingerprint(theme);
      const next = compileRef.current(theme);
      const sizeChanged = appliedSize?.width !== width || appliedSize?.height !== height;

      if (chart == null) {
        chart = echarts.init(element, undefined, { renderer: "svg", useDirtyRect: true, width, height });
        const activeChart = chart;
        const onClick = (event: unknown) => {
          const intent = resolveMachineTimelineChartIntent(applied ?? next, event);
          if (intent != null) intentRef.current?.(intent);
        };
        activeChart.on("click", onClick);
        // We own this exact listener rather than relying on dispose() to infer it.
        (activeChart as unknown as { __machineTimelineClick?: (event: unknown) => void }).__machineTimelineClick = onClick;
      } else if (sizeChanged) {
        chart.resize({ width, height, silent: true });
      }
      appliedSize = { width, height };

      if (applied?.renderSignature === next.renderSignature && resolvedThemeKey === nextThemeKey) return;
      const decision = decideMachineTimelineUpdate(applied, next);
      if (decision.kind === "replace-families") {
        chart.setOption(next.option, { replaceMerge: [...decision.families], lazyUpdate: false, silent: true });
      } else if (decision.kind === "full-replacement") {
        chart.setOption(next.option, { notMerge: true, lazyUpdate: false, silent: true });
      } else if (decision.kind === "merge") {
        chart.setOption(next.option, { lazyUpdate: false, silent: true });
      } else {
        // Renderer is initialization-bound.  This compiler currently fixes SVG,
        // but retaining the branch keeps a future renderer policy safe.
        const oldChart = chart;
        const onClick = (oldChart as unknown as { __machineTimelineClick?: (event: unknown) => void }).__machineTimelineClick;
        if (onClick != null) oldChart.off("click", onClick);
        oldChart.dispose();
        chart = echarts.init(element, undefined, { renderer: "svg", useDirtyRect: true, width, height });
        const activeChart = chart;
        const onClickForNewChart = (event: unknown) => {
          const intent = resolveMachineTimelineChartIntent(next, event);
          if (intent != null) intentRef.current?.(intent);
        };
        activeChart.on("click", onClickForNewChart);
        (activeChart as unknown as { __machineTimelineClick?: (event: unknown) => void }).__machineTimelineClick = onClickForNewChart;
        chart.setOption(next.option, { notMerge: true, lazyUpdate: false, silent: true });
      }
      applied = next;
      resolvedThemeKey = nextThemeKey;
    };

    const scheduleApply = () => {
      if (resizeFrame !== 0 || disposed) return;
      resizeFrame = scheduleFrame(() => {
        resizeFrame = 0;
        apply();
      });
    };
    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver((entries) => {
      const entry = entries.at(-1);
      if (entry == null) return;
      const width = Math.round(entry.contentRect.width);
      const height = Math.round(entry.contentRect.height);
      if (width <= 0 || height <= 0
        || (pendingSize?.width === width && pendingSize.height === height)
        || (appliedSize?.width === width && appliedSize.height === height)) return;
      pendingSize = { width, height };
      scheduleApply();
    });
    const themeObserver = new MutationObserver(scheduleApply);

    resizeObserver?.observe(element);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });
    scheduleApplyRef.current = scheduleApply;
    apply();

    return () => {
      disposed = true;
      if (scheduleApplyRef.current === scheduleApply) scheduleApplyRef.current = null;
      resizeObserver?.disconnect();
      themeObserver.disconnect();
      cancelFrame(resizeFrame);
      if (chart != null) {
        const onClick = (chart as unknown as { __machineTimelineClick?: (event: unknown) => void }).__machineTimelineClick;
        if (onClick != null) chart.off("click", onClick);
        chart.dispose();
      }
      chart = null;
      applied = null;
      pendingSize = null;
    };
  }, []);

  // Canonical input can change while the host instance remains mounted. The
  // signature gate inside apply keeps equal data/theme updates completely quiet.
  useEffect(() => {
    scheduleApplyRef.current?.();
  }, [compile]);

  return <div ref={target} role="img" aria-label={label} aria-disabled={activationDisabled || undefined} style={{ minHeight: minimumHeight, minWidth: 0, width: "100%" }} />;
}

function timeLabel(atMs: number): string {
  const date = new Date(atMs);
  return Number.isFinite(date.getTime()) ? date.toISOString() : `${atMs} ms`;
}

function coverageLabel(timeline: MachineTimelineResult): string {
  if (timeline.coverage.state === "empty") return "Coverage: no observations in this range.";
  if (timeline.coverage.state === "partial") return "Coverage: partial; the timeline does not represent the complete requested range.";
  return "Coverage: complete for the requested bounded range.";
}

function timeNormalizationLabel(timeline: MachineTimelineResult): string {
  const summary = timeline.timeNormalization;
  if (summary.sampleCount === 0) return `Timeline time basis: ${summary.basis}; no normalized observations.`;
  const uncertainty = summary.maxClockUncertaintyMs === 0 ? "no clock uncertainty" : `up to ${summary.maxClockUncertaintyMs} ms clock uncertainty`;
  return `Timeline time basis: ${summary.basis}; ${summary.sampleCount} normalized observations; ${uncertainty}.`;
}

/**
 * Graphical interaction and the native list converge on the same normalized
 * `TimelineEventActivation`; consumers perform BB navigation only from that
 * typed activation, never from ECharts callback data.
 */
export function MachineTimelineChart({
  timeline,
  stale = false,
  refreshing = false,
  activationDisabled = false,
  className,
  onActivateEvent,
}: MachineTimelineChartProps) {
  const accessibleFigure = useMemo(() => compileMachineTimeline(timeline), [timeline]);
  const compile = useCallback((theme: TimelineChartTheme) => compileMachineTimeline(timeline, { theme, reducedMotion: true }), [timeline]);
  const onIntent = useCallback((intent: TimelineChartIntent) => {
    if (!activationDisabled && intent.kind === "activate-event") onActivateEvent?.(intent.activation);
  }, [activationDisabled, onActivateEvent]);
  const activateFromList = useCallback((datumKey: string) => {
    const intent = activateMachineTimelineEvent(accessibleFigure, datumKey);
    if (intent != null) onIntent(intent);
  }, [accessibleFigure, onIntent]);
  const label = `Machine timeline for ${accessibleFigure.machineKey}`;

  return <section className={className} aria-label={label} data-event-activation-disabled={activationDisabled || undefined}>
    <MachineTimelineEChartsHost
      compile={compile}
      label={label}
      minimumHeight={accessibleFigure.minimumHeight}
      activationDisabled={activationDisabled}
      onIntent={onIntent}
    />
    <div aria-live="polite">
      <p>{coverageLabel(timeline)}</p>
      {stale && <p>Stale: showing a retained prior generation.</p>}
      {refreshing && <p>Refreshing timeline data.</p>}
      {activationDisabled && <p role="status">Event activation is unavailable until this machine’s current timeline is visible.</p>}
      <p>{timeNormalizationLabel(timeline)}</p>
      <p>{`Server buckets: ${timeline.bucket.count} at ${timeline.bucket.widthMs} ms each.`}</p>
      {accessibleFigure.explicitGapCount > 0 && <p>{`Explicit metric gaps: ${accessibleFigure.explicitGapCount}.`}</p>}
      {accessibleFigure.eventTruncated && <p>{`Events truncated: showing ${accessibleFigure.plottedEventCount} of ${accessibleFigure.totalEventCount}.`}</p>}
    </div>
    <section aria-label="Exact timeline events">
      <h3>Timeline events</h3>
      <p>{accessibleFigure.eventTruncated
        ? `Showing ${accessibleFigure.plottedEventCount} of ${accessibleFigure.totalEventCount} events.`
        : `${accessibleFigure.plottedEventCount} exact events.`}</p>
      {accessibleFigure.accessibleEvents.length === 0 ? <p>No events in this range.</p> : <ol>
        {accessibleFigure.accessibleEvents.map((activation) => <li key={activation.datumKey}>
          <strong>{activation.event.title}</strong>
          <span>{` · ${timeLabel(activation.event.time.kind === "instant" ? activation.event.time.atMs : activation.event.time.startMs)}`}</span>
          {activation.event.detail != null && <p>{activation.event.detail}</p>}
          {activation.bbReference != null
            ? <button type="button" disabled={activationDisabled} onClick={() => activateFromList(activation.datumKey)}>{`Open linked thread for ${activation.event.title}`}</button>
            : <span> · No linked BB thread.</span>}
        </li>)}
      </ol>}
    </section>
  </section>;
}
