import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { BarChart, LineChart, LinesChart, ScatterChart } from "echarts/charts";
import { AriaComponent, GridComponent, MarkAreaComponent, MarkLineComponent, TooltipComponent } from "echarts/components";
import * as echarts from "echarts/core";
import type { EChartsCoreOption } from "echarts/core";
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

// This is the sole ECharts registry and lifecycle owner for fleet monitoring.
echarts.use([AriaComponent, BarChart, GridComponent, LineChart, LinesChart, MarkAreaComponent, MarkLineComponent, ScatterChart, SVGRenderer, TooltipComponent]);

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

type ResolvedChartTheme = TimelineChartTheme & Readonly<{
  primary: string;
  destructive: string;
}>;

type EChartsFigure = Readonly<{
  option: EChartsCoreOption;
  renderSignature: string;
}>;

type EChartsUpdateDecision =
  | Readonly<{ kind: "merge" }>
  | Readonly<{ kind: "replace-families"; families: readonly string[] }>
  | Readonly<{ kind: "full-replacement"; reason: string }>
  | Readonly<{ kind: "rebuild-instance"; reason: string }>;

type EChartsHostProps<Figure extends EChartsFigure, Intent> = Readonly<{
  compile: (theme: ResolvedChartTheme) => Figure;
  label: string;
  minimumHeight?: number;
  activationDisabled?: boolean;
  onIntent?: (intent: Intent) => void;
  decideUpdate: (previous: Figure | null, next: Figure) => EChartsUpdateDecision;
  resolveIntent?: (compiled: Figure, event: unknown) => Intent | null;
}>;

function cssColor(value: string, fallback: string): string {
  return value.length > 0 && value !== "rgba(0, 0, 0, 0)" && value !== "transparent" ? value : fallback;
}

function resolveTheme(element: HTMLElement): ResolvedChartTheme {
  const style = getComputedStyle(element);
  return {
    foreground: cssColor(style.color, "#111827"),
    muted: cssColor(style.borderTopColor, "#6b7280"),
    border: cssColor(style.borderRightColor, "#d1d5db"),
    surface: cssColor(style.backgroundColor, "#ffffff"),
    gap: cssColor(style.textDecorationColor, "#9ca3af"),
    primary: cssColor(style.borderBottomColor, "#7c3aed"),
    destructive: cssColor(style.borderLeftColor, "#b91c1c"),
  };
}

function themeFingerprint(theme: ResolvedChartTheme): string {
  return JSON.stringify(theme);
}

/**
 * Imperative ECharts is fully contained here.  It observes only its owned
 * element, never mirrors resize or hover into React state, and its event
 * listener resolves the current compiler-owned datum map before publication.
 */
function EChartsHost<Figure extends EChartsFigure, Intent>({ compile, label, minimumHeight = 240, activationDisabled = false, onIntent, decideUpdate, resolveIntent }: EChartsHostProps<Figure, Intent>) {
  const target = useRef<HTMLDivElement | null>(null);
  const compileRef = useRef(compile);
  const intentRef = useRef(onIntent);
  const resolveIntentRef = useRef(resolveIntent);
  const scheduleApplyRef = useRef<(() => void) | null>(null);
  compileRef.current = compile;
  intentRef.current = onIntent;
  resolveIntentRef.current = resolveIntent;

  useLayoutEffect(() => {
    const element = target.current;
    if (element == null) return;

    let chart: ReturnType<typeof echarts.init> | null = null;
    let applied: Figure | null = null;
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
          const intent = resolveIntentRef.current?.(applied ?? next, event);
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
      const decision = decideUpdate(applied, next);
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
          const intent = resolveIntentRef.current?.(next, event);
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
  }, [decideUpdate]);

  // Canonical input can change while the host instance remains mounted. The
  // signature gate inside apply keeps equal data/theme updates completely quiet.
  useEffect(() => {
    scheduleApplyRef.current?.();
  }, [compile]);

  return <div ref={target} className="machine-monitor__echarts-theme" role="img" aria-label={label} aria-disabled={activationDisabled || undefined} style={{ minHeight: minimumHeight, minWidth: 0, width: "100%" }} />;
}

type MachineTimelineEChartsHostProps = Readonly<{
  compile: (theme: TimelineChartTheme) => CompiledMachineTimeline;
  label: string;
  minimumHeight?: number;
  activationDisabled?: boolean;
  onIntent?: (intent: TimelineChartIntent) => void;
}>;

export function MachineTimelineEChartsHost({ compile, label, minimumHeight, activationDisabled, onIntent }: MachineTimelineEChartsHostProps) {
  return <EChartsHost
    compile={compile}
    label={label}
    minimumHeight={minimumHeight}
    activationDisabled={activationDisabled}
    onIntent={onIntent}
    decideUpdate={decideMachineTimelineUpdate}
    resolveIntent={resolveMachineTimelineChartIntent}
  />;
}

export const FLEET_UTILIZATION_ATTENTION_PERCENT = 70;
const FLEET_UTILIZATION_FIGURE_ID = "machine-monitor:fleet-utilization";
const FLEET_UTILIZATION_SERIES_ID = `${FLEET_UTILIZATION_FIGURE_ID}:series:utilization`;

/** Canonical, bounded input for the fleet overview chart; cards remain exact UI. */
export type FleetUtilizationDatum = Readonly<{
  machineKey: string;
  label: string;
  utilization: number | null;
  headroomToAttention: number | null;
  status: "current" | "stale" | "disconnected" | "unavailable";
  statusLabel: string;
  selected: boolean;
}>;

type CompiledFleetUtilization = EChartsFigure & Readonly<{
  structuralSignature: string;
  datumByIndex: readonly FleetUtilizationDatum[];
}>;

type FleetUtilizationIntent = Readonly<{ kind: "select-machine"; machineKey: string }>;

function utilizationColor(datum: FleetUtilizationDatum, theme: ResolvedChartTheme): string {
  if (datum.status !== "current") return theme.muted;
  return datum.utilization != null && datum.utilization >= FLEET_UTILIZATION_ATTENTION_PERCENT ? theme.destructive : theme.primary;
}

function compileFleetUtilization(data: readonly FleetUtilizationDatum[], theme: ResolvedChartTheme): CompiledFleetUtilization {
  const structuralSignature = JSON.stringify(data.map((datum) => datum.machineKey));
  const renderSignature = JSON.stringify({
    structuralSignature,
    values: data.map((datum) => [datum.utilization, datum.headroomToAttention, datum.status, datum.selected]),
    theme,
  });
  const denseLabels = data.length > 12;
  const labelInterval = denseLabels ? Math.max(1, Math.ceil(data.length / 8) - 1) : 0;
  const option: EChartsCoreOption = {
    animation: false,
    aria: { enabled: true },
    grid: { id: `${FLEET_UTILIZATION_FIGURE_ID}:grid`, top: 18, right: 10, bottom: denseLabels ? 54 : 36, left: 34, containLabel: false },
    tooltip: { show: true, trigger: "axis", axisPointer: { type: "shadow" } },
    xAxis: {
      id: `${FLEET_UTILIZATION_FIGURE_ID}:x`,
      type: "category",
      data: data.map((datum) => datum.label),
      axisLabel: { show: true, color: theme.muted, fontSize: 9, interval: labelInterval, rotate: denseLabels ? 36 : 0, margin: 8, overflow: "truncate", width: denseLabels ? 68 : 120 },
      axisTick: { show: false },
      axisLine: { lineStyle: { color: theme.border } },
    },
    yAxis: {
      id: `${FLEET_UTILIZATION_FIGURE_ID}:y`,
      type: "value",
      min: 0,
      max: 100,
      interval: 25,
      axisLabel: { color: theme.muted, fontSize: 9, formatter: "{value}%" },
      splitLine: { lineStyle: { color: theme.border } },
      axisLine: { lineStyle: { color: theme.border } },
    },
    series: [{
      id: FLEET_UTILIZATION_SERIES_ID,
      name: "Worst current utilization",
      type: "bar",
      silent: false,
      barMaxWidth: data.length > 8 ? 28 : 42,
      showBackground: true,
      backgroundStyle: { color: theme.border, opacity: 0.34 },
      emphasis: { disabled: true },
      data: data.map((datum) => ({
        // ECharts returns this exact datum on click.  The resolver below checks
        // it against the current index map, so a delayed event from a reordered
        // chart can never select a different machine.
        machineKey: datum.machineKey,
        name: datum.label,
        value: datum.utilization,
        itemStyle: {
          color: utilizationColor(datum, theme),
          opacity: datum.status === "current" ? 1 : 0.52,
          borderColor: datum.selected ? theme.foreground : "transparent",
          borderWidth: datum.selected ? 2 : 0,
        },
        label: datum.selected
          ? { show: true, position: "top", color: theme.foreground, fontSize: 10, fontWeight: 650, formatter: datum.utilization == null ? "—" : `${datum.utilization.toFixed(0)}%` }
          : { show: false },
      })),
      markLine: {
        silent: true,
        symbol: "none",
        lineStyle: { color: theme.foreground, type: "dashed", opacity: 0.65 },
        label: { color: theme.muted, fontSize: 9, formatter: `Attention ${FLEET_UTILIZATION_ATTENTION_PERCENT}%` },
        data: [{ yAxis: FLEET_UTILIZATION_ATTENTION_PERCENT }],
      },
    }],
  };
  return { option, renderSignature, structuralSignature, datumByIndex: data };
}

function decideFleetUtilizationUpdate(previous: CompiledFleetUtilization | null, next: CompiledFleetUtilization): EChartsUpdateDecision {
  if (previous == null || previous.structuralSignature !== next.structuralSignature) {
    return { kind: "full-replacement", reason: "fleet machine set changed" };
  }
  return { kind: "merge" };
}

function resolveFleetUtilizationIntent(compiled: CompiledFleetUtilization, event: unknown): FleetUtilizationIntent | null {
  if (event == null || typeof event !== "object") return null;
  const candidate = event as { componentType?: unknown; seriesId?: unknown; dataIndex?: unknown; data?: { machineKey?: unknown } };
  if (candidate.componentType !== "series" || candidate.seriesId !== FLEET_UTILIZATION_SERIES_ID || typeof candidate.dataIndex !== "number" || !Number.isSafeInteger(candidate.dataIndex)) return null;
  const datum = compiled.datumByIndex[candidate.dataIndex];
  if (datum == null || candidate.data?.machineKey !== datum.machineKey) return null;
  return { kind: "select-machine", machineKey: datum.machineKey };
}

export type FleetUtilizationChartProps = Readonly<{
  machines: readonly FleetUtilizationDatum[];
  className?: string;
  onSelectMachine?: (machineKey: string) => void;
}>;

/**
 * One compact, source-ordered ECharts overview for the entire fleet. Native
 * cards beneath it remain the exact-value and keyboard selection surface.
 */
export function FleetUtilizationChart({ machines, className, onSelectMachine }: FleetUtilizationChartProps) {
  const compile = useCallback((theme: ResolvedChartTheme) => compileFleetUtilization(machines, theme), [machines]);
  const onIntent = useCallback((intent: FleetUtilizationIntent) => {
    if (intent.kind === "select-machine") onSelectMachine?.(intent.machineKey);
  }, [onSelectMachine]);
  const label = `Fleet utilization for ${machines.length} machines. Each bar is the worst current CPU, memory, or root-disk percentage. Attention begins at ${FLEET_UTILIZATION_ATTENTION_PERCENT} percent. Use the native source controls below for exact values and machine status.`;

  return <section className={className} aria-label="Fleet utilization overview">
    <EChartsHost
      compile={compile}
      label={label}
      minimumHeight={152}
      onIntent={onIntent}
      decideUpdate={decideFleetUtilizationUpdate}
      resolveIntent={resolveFleetUtilizationIntent}
    />
    <p>{`Current utilization · ${FLEET_UTILIZATION_ATTENTION_PERCENT}% attention target · select a bar or source to inspect.`}</p>
  </section>;
}

const MACHINE_DASHBOARD_FIGURE_ID = "machine-monitor:machine-dashboard";
const MACHINE_DASHBOARD_ATTENTION_PERCENT = FLEET_UTILIZATION_ATTENTION_PERCENT;

type CompiledMachineDashboard = EChartsFigure & Readonly<{
  structuralSignature: string;
}>;

export type MachineDashboardChartProps = Readonly<{
  timeline: MachineTimelineResult;
  stale?: boolean;
  className?: string;
}>;

type DashboardSeries = Readonly<{
  metricId: "cpu.utilization.percent" | "memory.used.bytes" | "disk.root.used.bytes" | "load.5";
  label: string;
  color: string;
  axisIndex: 0 | 1;
  data: readonly (readonly [number, number | null])[];
}>;

function timelineMetricBuckets(timeline: MachineTimelineResult, metricId: DashboardSeries["metricId"]) {
  return timeline.metrics.find((series) => series.metricId === metricId)?.buckets ?? [];
}

function ratioAt(
  numerator: ReturnType<typeof timelineMetricBuckets>,
  denominator: ReturnType<typeof timelineMetricBuckets>,
  index: number,
): number | null {
  const value = numerator[index]?.average;
  const total = denominator[index]?.average;
  if (value == null || total == null || !Number.isFinite(value) || !Number.isFinite(total) || total <= 0) return null;
  return Math.min(100, Math.max(0, value / total * 100));
}

function dashboardTimeLabel(value: number): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric" }).format(date);
}

function dashboardTooltip(values: unknown): string {
  const rows = Array.isArray(values) ? values : [];
  const timestamp = rows.find((value) => value != null && typeof value === "object" && "axisValue" in value) as { axisValue?: unknown } | undefined;
  const heading = typeof timestamp?.axisValue === "number" ? dashboardTimeLabel(timestamp.axisValue) : "Selected time";
  const items = rows.flatMap((value) => {
    if (value == null || typeof value !== "object") return [];
    const row = value as { seriesName?: unknown; value?: unknown };
    const point = Array.isArray(row.value) ? row.value.at(-1) : row.value;
    if (typeof row.seriesName !== "string" || typeof point !== "number" || !Number.isFinite(point)) return [];
    const formatted = row.seriesName === "Load (5 min)" ? point.toFixed(point >= 10 ? 0 : 2) : `${point.toFixed(1)}%`;
    return [`${row.seriesName}: ${formatted}`];
  });
  return [heading, ...items].join("<br/>");
}

function machineDashboardSeries(timeline: MachineTimelineResult): readonly DashboardSeries[] {
  const cpu = timelineMetricBuckets(timeline, "cpu.utilization.percent");
  const memoryUsed = timelineMetricBuckets(timeline, "memory.used.bytes");
  const memoryTotal = timeline.metrics.find((series) => series.metricId === "memory.total.bytes")?.buckets ?? [];
  const diskUsed = timelineMetricBuckets(timeline, "disk.root.used.bytes");
  const diskTotal = timeline.metrics.find((series) => series.metricId === "disk.root.total.bytes")?.buckets ?? [];
  const load = timelineMetricBuckets(timeline, "load.5");
  const points = timeline.bucket.count;
  const timeAt = (index: number) => timeline.range.startMs + index * timeline.bucket.widthMs;
  return [
    {
      metricId: "cpu.utilization.percent", label: "CPU", color: "#60a5fa", axisIndex: 0,
      data: Array.from({ length: points }, (_, index) => [timeAt(index), cpu[index]?.average ?? null] as const),
    },
    {
      metricId: "memory.used.bytes", label: "Memory", color: "#fb7185", axisIndex: 0,
      data: Array.from({ length: points }, (_, index) => [timeAt(index), ratioAt(memoryUsed, memoryTotal, index)] as const),
    },
    {
      metricId: "disk.root.used.bytes", label: "Root disk", color: "#2dd4bf", axisIndex: 0,
      data: Array.from({ length: points }, (_, index) => [timeAt(index), ratioAt(diskUsed, diskTotal, index)] as const),
    },
    {
      metricId: "load.5", label: "Load (5 min)", color: "#c084fc", axisIndex: 1,
      data: Array.from({ length: points }, (_, index) => [timeAt(index), load[index]?.average ?? null] as const),
    },
  ];
}

/**
 * One persistent chart owns two deliberately separated grids. This keeps
 * selected-machine switches cheap while avoiding the visual ambiguity of
 * mixing percentage utilization with absolute load on one axis.
 */
function compileMachineDashboard(timeline: MachineTimelineResult, theme: ResolvedChartTheme): CompiledMachineDashboard {
  const series = machineDashboardSeries(timeline);
  const structuralSignature = `${MACHINE_DASHBOARD_FIGURE_ID}:two-grid:v3`;
  const renderSignature = JSON.stringify({
    structuralSignature,
    generation: timeline.generation,
    range: timeline.range,
    values: series.map((entry) => entry.data),
    theme,
  });
  const option: EChartsCoreOption = {
    animation: false,
    aria: {
      enabled: true,
      description: `Operational history for ${timeline.machine.machineId}. The left pane compares CPU, memory, and root-disk utilization against a ${MACHINE_DASHBOARD_ATTENTION_PERCENT} percent attention line. The right pane shows five-minute load average, which has no percentage target.`,
    },
    tooltip: {
      show: true,
      trigger: "axis",
      confine: true,
      backgroundColor: theme.surface,
      borderColor: theme.border,
      textStyle: { color: theme.foreground, fontSize: 11 },
      formatter: dashboardTooltip,
    },
    grid: [
      { id: `${MACHINE_DASHBOARD_FIGURE_ID}:grid:utilization`, left: "7%", top: 18, width: "39%", bottom: 38, containLabel: true },
      { id: `${MACHINE_DASHBOARD_FIGURE_ID}:grid:load`, left: "56%", top: 18, width: "37%", bottom: 38, containLabel: true },
    ],
    xAxis: [0, 1].map((axisIndex) => ({
      id: `${MACHINE_DASHBOARD_FIGURE_ID}:x:${axisIndex === 0 ? "utilization" : "load"}`,
      gridIndex: axisIndex,
      type: "time" as const,
      min: timeline.range.startMs,
      max: timeline.range.endMs,
      axisLabel: { color: theme.muted, fontSize: 9, formatter: dashboardTimeLabel, hideOverlap: true },
      axisTick: { show: false },
      axisLine: { lineStyle: { color: theme.border } },
      splitLine: { show: false },
    })),
    yAxis: [
      {
        id: `${MACHINE_DASHBOARD_FIGURE_ID}:y:utilization`, gridIndex: 0, type: "value", min: 0, max: 100, interval: 25,
        axisLabel: { color: theme.muted, fontSize: 9, formatter: "{value}%" },
        axisLine: { lineStyle: { color: theme.border } }, splitLine: { lineStyle: { color: theme.border, opacity: 0.72 } },
      },
      {
        id: `${MACHINE_DASHBOARD_FIGURE_ID}:y:load`, gridIndex: 1, type: "value", min: 0, scale: true,
        axisLabel: { color: theme.muted, fontSize: 9 }, axisLine: { lineStyle: { color: theme.border } }, splitLine: { lineStyle: { color: theme.border, opacity: 0.72 } },
      },
    ],
    series: series.map((entry) => ({
      id: `${MACHINE_DASHBOARD_FIGURE_ID}:series:${entry.metricId}`,
      name: entry.label,
      type: "line" as const,
      xAxisIndex: entry.axisIndex,
      yAxisIndex: entry.axisIndex,
      data: entry.data,
      showSymbol: false,
      connectNulls: false,
      emphasis: { disabled: true },
      lineStyle: { color: entry.color, width: entry.metricId === "load.5" ? 2.2 : 2 },
      itemStyle: { color: entry.color },
      markLine: entry.metricId === "cpu.utilization.percent" ? {
        silent: true,
        symbol: "none",
        lineStyle: { color: theme.destructive, type: "dashed", opacity: 0.82 },
        label: { color: theme.muted, fontSize: 9, formatter: `Attention ${MACHINE_DASHBOARD_ATTENTION_PERCENT}%` },
        data: [{ yAxis: MACHINE_DASHBOARD_ATTENTION_PERCENT }],
      } : undefined,
    })),
    media: [{
      query: { maxWidth: 640 },
      option: {
        grid: [
          { id: `${MACHINE_DASHBOARD_FIGURE_ID}:grid:utilization`, left: "12%", right: "7%", top: 18, height: "31%", containLabel: true },
          { id: `${MACHINE_DASHBOARD_FIGURE_ID}:grid:load`, left: "12%", right: "7%", top: "60%", bottom: 38, containLabel: true },
        ],
      },
    }],
  };
  return { option, renderSignature, structuralSignature };
}

function decideMachineDashboardUpdate(previous: CompiledMachineDashboard | null, next: CompiledMachineDashboard): EChartsUpdateDecision {
  if (previous == null || previous.structuralSignature !== next.structuralSignature) {
    return { kind: "full-replacement", reason: "machine dashboard structure changed" };
  }
  return { kind: "merge" };
}

export function MachineDashboardChart({ timeline, stale = false, className }: MachineDashboardChartProps) {
  const compile = useCallback((theme: ResolvedChartTheme) => compileMachineDashboard(timeline, theme), [timeline]);
  const retained = stale ? "Showing retained history. " : "";
  return <section className={className} aria-label="Operational history charts" data-machine-id={timeline.machine.machineId} data-stale={stale || undefined}>
    <div className="machine-monitor__dashboard-captions" aria-hidden="true">
      <div><strong>Utilization</strong><span>CPU · Memory · Root disk · {MACHINE_DASHBOARD_ATTENTION_PERCENT}% attention</span></div>
      <div><strong>Load average</strong><span>Five-minute window · no percentage target</span></div>
    </div>
    <EChartsHost
      compile={compile}
      label={`Operational history for ${timeline.machine.machineId}. ${retained}Utilization compares CPU, memory, and root disk to the ${MACHINE_DASHBOARD_ATTENTION_PERCENT} percent attention line. Five-minute load average is shown separately and has no percentage target.`}
      minimumHeight={300}
      decideUpdate={decideMachineDashboardUpdate}
    />
  </section>;
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
