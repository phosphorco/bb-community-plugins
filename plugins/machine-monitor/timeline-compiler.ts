import type { EChartsCoreOption } from "echarts/core";

import {
  FLEET_CONTRACT_VERSION,
  metricCatalogEntry,
  machineIdentityKey,
  timelineGenerationKey,
  type FleetMetricId,
  type FleetMachineIdentity,
  type MachineTimelineResult,
  type TimelineGeneration,
} from "./fleet-contract.ts";

/**
 * This module is the trusted boundary between the server-owned timeline
 * result and ECharts.  It deliberately has no React or ECharts lifecycle
 * concerns: the result remains the source of truth for exact event actions.
 */

export type TimelineChartTheme = Readonly<{
  foreground: string;
  muted: string;
  border: string;
  surface: string;
  gap: string;
}>;

export type TimelineChartPresentation = Readonly<{
  theme?: Partial<TimelineChartTheme>;
  /** The monitoring timeline never animates; this records the live policy. */
  reducedMotion?: boolean;
}>;

export const DEFAULT_TIMELINE_CHART_THEME: TimelineChartTheme = {
  foreground: "#111827",
  muted: "#6b7280",
  border: "#d1d5db",
  surface: "#ffffff",
  gap: "#9ca3af",
};

// These are keyed by the closed metric namespace, never by the set or order
// returned for one request. A track therefore keeps its visual identity when
// another track is omitted by capability or selected range.
const METRIC_COLORS: Readonly<Record<FleetMetricId, string>> = {
  "cpu.utilization.percent": "#7c3aed",
  "memory.used.bytes": "#db2777",
  "memory.total.bytes": "#9d174d",
  "disk.root.used.bytes": "#059669",
  "disk.root.total.bytes": "#047857",
  "load.1": "#2563eb",
  "load.5": "#1d4ed8",
  "memory.pressure.some.percent": "#d97706",
  "memory.pressure.full.percent": "#b45309",
  "memory.swap.in.pages-per-second": "#0891b2",
  "memory.swap.out.pages-per-second": "#4f46e5",
};
const COMPILER_VERSION = "machine-timeline-v2";
const EVENT_SERIES_ROLE = "events";
const TRACK_TOP = 12;
const TRACK_STRIDE = 106;
const TRACK_HEIGHT = 74;
const EVENT_LANE_HEIGHT = 30;

export type TimelineComponentFamily = "grid" | "xAxis" | "yAxis" | "series" | "tooltip";

export type TimelineComponent = Readonly<{
  family: TimelineComponentFamily;
  id: string;
  kind: string;
  bindingSignature: string;
}>;

export type TimelineEvent = MachineTimelineResult["events"]["events"][number];

export type TimelineEventActivation = Readonly<{
  figureId: string;
  datumKey: string;
  generation: TimelineGeneration;
  generationKey: string;
  machine: FleetMachineIdentity;
  machineKey: string;
  event: TimelineEvent;
  provenance: TimelineEvent["provenance"];
  bbReference: TimelineEvent["bbReference"];
}>;

export type TimelineChartIntent = Readonly<{
  kind: "activate-event";
  activation: TimelineEventActivation;
}>;

export type CompiledMachineTimeline = Readonly<{
  figureId: string;
  instanceKey: "machine-timeline:svg";
  machine: FleetMachineIdentity;
  machineKey: string;
  generation: TimelineGeneration;
  generationKey: string;
  option: EChartsCoreOption;
  components: readonly TimelineComponent[];
  metricSeriesIds: readonly string[];
  eventSeriesId: string;
  eventDurationSeriesId: string;
  datumIndex: ReadonlyMap<string, TimelineEventActivation>;
  accessibleEvents: readonly TimelineEventActivation[];
  plottedBucketCount: number;
  plottedEventCount: number;
  totalEventCount: number;
  eventTruncated: boolean;
  explicitGapCount: number;
  timeNormalization: MachineTimelineResult["timeNormalization"];
  visibleMetricCount: number;
  minimumHeight: number;
  trackSignature: string;
  semanticSignature: string;
  structuralSignature: string;
  valueSignature: string;
  renderSignature: string;
}>;

export type TimelineUpdateDecision =
  | Readonly<{ kind: "merge" }>
  | Readonly<{ kind: "replace-families"; families: readonly ["grid", "xAxis", "yAxis", "series"]; reason: "metric tracks changed" }>
  | Readonly<{ kind: "full-replacement"; reason: "machine changed" | "event semantics changed" | "structure changed" }>
  | Readonly<{ kind: "rebuild-instance"; reason: "renderer changed" }>;

type EChartsEventLike = Readonly<{
  componentType?: unknown;
  seriesId?: unknown;
  data?: unknown;
}>;

type EventPoint = Readonly<{
  value: readonly [number, number];
  datumKey: string;
  eventPart: "instant" | "start" | "end";
}>;

type MetricTrackIds = Readonly<{
  grid: string;
  xAxis: string;
  yAxis: string;
}>;

const figureId = "machine-monitor:timeline";
const ids = {
  eventsGrid: "machine-monitor:timeline:grid:events",
  eventsXAxis: "machine-monitor:timeline:x-axis:events",
  eventsYAxis: "machine-monitor:timeline:y-axis:events",
  eventsSeries: `machine-monitor:timeline:series:${EVENT_SERIES_ROLE}`,
  eventDurationSeries: `machine-monitor:timeline:series:${EVENT_SERIES_ROLE}:duration`,
  tooltip: "machine-monitor:timeline:tooltip",
} as const;

function metricSeriesId(metricId: string, role: "average" | "minimum" | "maximum"): string {
  return `machine-monitor:timeline:series:metric:${metricId}:${role}`;
}

function metricTrackIds(metricId: FleetMetricId): MetricTrackIds {
  return {
    grid: `machine-monitor:timeline:grid:metric:${metricId}`,
    xAxis: `machine-monitor:timeline:x-axis:metric:${metricId}`,
    yAxis: `machine-monitor:timeline:y-axis:metric:${metricId}`,
  };
}

function normalizeTheme(theme?: Partial<TimelineChartTheme>): TimelineChartTheme {
  return {
    foreground: theme?.foreground || DEFAULT_TIMELINE_CHART_THEME.foreground,
    muted: theme?.muted || DEFAULT_TIMELINE_CHART_THEME.muted,
    border: theme?.border || DEFAULT_TIMELINE_CHART_THEME.border,
    surface: theme?.surface || DEFAULT_TIMELINE_CHART_THEME.surface,
    gap: theme?.gap || DEFAULT_TIMELINE_CHART_THEME.gap,
  };
}

function stable(value: unknown): string {
  return JSON.stringify(value);
}

function bucketCenter(startMs: number, endMs: number): number {
  return startMs + Math.floor((endMs - startMs) / 2);
}

function point(value: number | null, startMs: number, endMs: number): readonly [number, number | null] {
  return [bucketCenter(startMs, endMs), value];
}

/** Stable only inside one timeline generation, by design. */
export function timelineEventDatumKey(
  machine: FleetMachineIdentity,
  generation: TimelineGeneration,
  event: TimelineEvent,
): string {
  return stable([machineIdentityKey(machine), timelineGenerationKey(generation), event.producer.id, event.eventId]);
}

function eventActivation(
  machine: FleetMachineIdentity,
  generation: TimelineGeneration,
  event: TimelineEvent,
): TimelineEventActivation {
  const machineKey = machineIdentityKey(machine);
  const generationKey = timelineGenerationKey(generation);
  return Object.freeze({
    figureId,
    datumKey: timelineEventDatumKey(machine, generation, event),
    generation,
    generationKey,
    machine,
    machineKey,
    event,
    provenance: event.provenance,
    bbReference: event.bbReference,
  });
}

function gapWindows(timeline: MachineTimelineResult, metricId: string): Array<readonly [{ xAxis: number }, { xAxis: number }]> {
  return timeline.gaps
    .filter((gap) => gap.metricId === metricId)
    .map((gap) => [{ xAxis: gap.startMs }, { xAxis: gap.endMs }] as const);
}

/**
 * Deterministically compiles already-reduced server data.  The compiler never
 * sorts, samples, aggregates, or asks ECharts to reduce these buckets.
 */
export function compileMachineTimeline(
  timeline: MachineTimelineResult,
  presentation: TimelineChartPresentation = {},
): CompiledMachineTimeline {
  const theme = normalizeTheme(presentation.theme);
  const machineKey = machineIdentityKey(timeline.machine);
  const generationKey = timelineGenerationKey(timeline.generation);
  const visibleMetrics = timeline.metrics.filter((metric) => metricCatalogEntry(metric.metricId).visualization !== "hidden");
  const eventTop = TRACK_TOP + visibleMetrics.length * TRACK_STRIDE;
  const minimumHeight = Math.max(180, eventTop + EVENT_LANE_HEIGHT + 52);
  const components: TimelineComponent[] = [
    { family: "grid", id: ids.eventsGrid, kind: "cartesian2d", bindingSignature: "events" },
    { family: "xAxis", id: ids.eventsXAxis, kind: "time", bindingSignature: "events-time" },
    { family: "yAxis", id: ids.eventsYAxis, kind: "value", bindingSignature: "events-lane" },
    { family: "tooltip", id: ids.tooltip, kind: "axis", bindingSignature: "metrics-and-events" },
  ];
  const metricSeriesIds: string[] = [];
  const series: object[] = [];
  const grids: object[] = [];
  const xAxes: object[] = [];
  const yAxes: object[] = [];

  for (const [metricIndex, metric] of visibleMetrics.entries()) {
    const catalog = metricCatalogEntry(metric.metricId);
    const track = metricTrackIds(metric.metricId);
    const color = METRIC_COLORS[metric.metricId];
    const averageId = metricSeriesId(metric.metricId, "average");
    const minimumId = metricSeriesId(metric.metricId, "minimum");
    const maximumId = metricSeriesId(metric.metricId, "maximum");
    const gaps = gapWindows(timeline, metric.metricId);
    const averageData = metric.buckets.map((bucket) => point(bucket.average, bucket.startMs, bucket.endMs));
    const minimumData = metric.buckets.map((bucket) => point(bucket.min, bucket.startMs, bucket.endMs));
    const maximumData = metric.buckets.map((bucket) => point(bucket.max, bucket.startMs, bucket.endMs));

    metricSeriesIds.push(averageId, minimumId, maximumId);
    components.push(
      { family: "grid", id: track.grid, kind: "cartesian2d", bindingSignature: `${metric.metricId}:track` },
      { family: "xAxis", id: track.xAxis, kind: "time", bindingSignature: `${metric.metricId}:time` },
      { family: "yAxis", id: track.yAxis, kind: "value", bindingSignature: `${metric.metricId}:${catalog.unit}` },
      { family: "series", id: averageId, kind: "line", bindingSignature: `${metric.metricId}:average` },
      { family: "series", id: minimumId, kind: "line", bindingSignature: `${metric.metricId}:minimum` },
      { family: "series", id: maximumId, kind: "line", bindingSignature: `${metric.metricId}:maximum` },
    );
    grids.push({
      id: track.grid,
      left: 84,
      right: 16,
      top: TRACK_TOP + metricIndex * TRACK_STRIDE,
      height: TRACK_HEIGHT,
      outerBoundsMode: "same",
      outerBoundsContain: "axisLabel",
    });
    xAxes.push({
      id: track.xAxis,
      type: "time",
      gridId: track.grid,
      min: timeline.range.startMs,
      max: timeline.range.endMs,
      axisLabel: { show: false },
      axisLine: { lineStyle: { color: theme.border } },
      axisPointer: { triggerEmphasis: true },
    });
    yAxes.push({
      id: track.yAxis,
      type: "value",
      gridId: track.grid,
      min: 0,
      name: `${catalog.label} (${catalog.unit})`,
      nameLocation: "middle",
      nameGap: 60,
      nameTextStyle: { color: theme.muted, fontSize: 10 },
      axisLabel: { color: theme.muted, fontSize: 10, hideOverlap: true },
      splitLine: { lineStyle: { color: theme.border } },
      axisLine: { lineStyle: { color: theme.border } },
    });
    // Min/max are the truthful server envelope; the average is never inferred
    // from a rendered line or from ECharts-side sampling.
    series.push(
      {
        id: averageId,
        type: "line",
        name: `${catalog.label} average`,
        xAxisId: track.xAxis,
        yAxisId: track.yAxis,
        data: averageData,
        showSymbol: false,
        connectNulls: false,
        animation: false,
        lineStyle: { color, width: 2 },
        itemStyle: { color },
        step: catalog.visualization === "step" ? "middle" : undefined,
        areaStyle: catalog.visualization === "area" ? { color, opacity: 0.12 } : undefined,
        emphasis: { focus: "none", scale: false },
        markArea: gaps.length === 0 ? undefined : {
          silent: true,
          label: { show: false },
          itemStyle: { color: theme.gap, opacity: 0.11 },
          data: gaps,
        },
      },
      {
        id: minimumId,
        type: "line",
        name: `${catalog.label} minimum`,
        xAxisId: track.xAxis,
        yAxisId: track.yAxis,
        data: minimumData,
        showSymbol: false,
        connectNulls: false,
        animation: false,
        lineStyle: { color, width: 1, type: "dashed", opacity: 0.48 },
        itemStyle: { color, opacity: 0.48 },
        emphasis: { focus: "none", scale: false },
      },
      {
        id: maximumId,
        type: "line",
        name: `${catalog.label} peak`,
        xAxisId: track.xAxis,
        yAxisId: track.yAxis,
        data: maximumData,
        showSymbol: false,
        connectNulls: false,
        animation: false,
        lineStyle: { color, width: 1, type: "dashed", opacity: 0.72 },
        itemStyle: { color, opacity: 0.72 },
        emphasis: { focus: "none", scale: false },
      },
    );
  }

  const datumIndex = new Map<string, TimelineEventActivation>();
  const accessibleEvents = timeline.events.events.map((event) => {
    const activation = eventActivation(timeline.machine, timeline.generation, event);
    datumIndex.set(activation.datumKey, activation);
    return activation;
  });
  const eventPoints: EventPoint[] = [];
  for (const activation of accessibleEvents) {
    if (activation.event.time.kind === "instant") {
      eventPoints.push({ value: [activation.event.time.atMs, 0], datumKey: activation.datumKey, eventPart: "instant" });
    } else {
      eventPoints.push(
        { value: [activation.event.time.startMs, 0], datumKey: activation.datumKey, eventPart: "start" },
        { value: [activation.event.time.endMs, 0], datumKey: activation.datumKey, eventPart: "end" },
      );
    }
  }
  const intervalLines = accessibleEvents.flatMap((activation) => activation.event.time.kind === "interval"
    ? [{ coords: [[activation.event.time.startMs, 0], [activation.event.time.endMs, 0]], datumKey: activation.datumKey }]
    : []);
  components.push(
    { family: "series", id: ids.eventDurationSeries, kind: "lines", bindingSignature: "event-lane:duration:v1" },
    { family: "series", id: ids.eventsSeries, kind: "scatter", bindingSignature: "event-lane:markers:v1" },
  );
  series.push({
    id: ids.eventDurationSeries,
    type: "lines",
    name: "Timeline event duration",
    coordinateSystem: "cartesian2d",
    xAxisId: ids.eventsXAxis,
    yAxisId: ids.eventsYAxis,
    data: intervalLines,
    clip: true,
    animation: false,
    lineStyle: { color: "#dc2626", width: 3, opacity: 0.85 },
    emphasis: { lineStyle: { color: "#b91c1c", width: 3, opacity: 1 } },
    z: 2,
  }, {
    id: ids.eventsSeries,
    type: "scatter",
    name: "Timeline events",
    xAxisId: ids.eventsXAxis,
    yAxisId: ids.eventsYAxis,
    data: eventPoints,
    clip: true,
    symbol: "diamond",
    symbolSize: 9,
    animation: false,
    itemStyle: { color: "#dc2626" },
    emphasis: { scale: false, itemStyle: { color: "#b91c1c" } },
    z: 3,
  });

  const trackSignature = stable(visibleMetrics.map((metric) => metric.metricId));
  const semanticSignature = stable({
    contractVersion: FLEET_CONTRACT_VERSION,
    compiler: COMPILER_VERSION,
    machineKey,
    eventSemantics: "event-datum-key-with-intervals-v2",
  });
  const structuralSignature = stable({
    compiler: COMPILER_VERSION,
    components: components.map(({ family, id, kind, bindingSignature }) => [family, id, kind, bindingSignature]),
    trackSignature,
  });
  const valueSignature = stable({
    generationKey,
    metrics: visibleMetrics,
    gaps: timeline.gaps.filter((gap) => metricCatalogEntry(gap.metricId).visualization !== "hidden"),
    events: timeline.events,
    coverage: timeline.coverage,
    timeNormalization: timeline.timeNormalization,
  });
  const renderSignature = stable({
    valueSignature,
    theme,
    // The chart is intentionally motionless even when motion is allowed: a
    // frequently refreshed monitoring view should not imply continuity.
    reducedMotion: presentation.reducedMotion === true,
  });

  return Object.freeze({
    figureId,
    instanceKey: "machine-timeline:svg",
    machine: timeline.machine,
    machineKey,
    generation: timeline.generation,
    generationKey,
    option: {
      animation: false,
      backgroundColor: "transparent",
      aria: { enabled: true, description: "Machine metric buckets with an aligned event lane. Exact events are available in the event list." },
      tooltip: {
        id: ids.tooltip,
        trigger: "axis",
        renderMode: "richText",
        confine: true,
        backgroundColor: theme.surface,
        borderColor: theme.border,
        textStyle: { color: theme.foreground, fontSize: 11 },
      },
      grid: [
        ...grids,
        { id: ids.eventsGrid, left: 84, right: 16, top: eventTop, height: EVENT_LANE_HEIGHT },
      ],
      xAxis: [
        ...xAxes,
        { id: ids.eventsXAxis, type: "time", gridId: ids.eventsGrid, min: timeline.range.startMs, max: timeline.range.endMs, axisLabel: { color: theme.muted, fontSize: 10, hideOverlap: true }, axisLine: { lineStyle: { color: theme.border } }, axisTick: { lineStyle: { color: theme.border } } },
      ],
      yAxis: [
        ...yAxes,
        { id: ids.eventsYAxis, type: "value", gridId: ids.eventsGrid, min: -1, max: 1, show: false },
      ],
      series,
    },
    components: Object.freeze(components),
    metricSeriesIds: Object.freeze(metricSeriesIds),
    eventSeriesId: ids.eventsSeries,
    eventDurationSeriesId: ids.eventDurationSeries,
    datumIndex,
    accessibleEvents: Object.freeze(accessibleEvents),
    plottedBucketCount: visibleMetrics.reduce((count, metric) => count + metric.buckets.length, 0),
    plottedEventCount: accessibleEvents.length,
    totalEventCount: timeline.events.totalCount,
    eventTruncated: timeline.events.truncated,
    explicitGapCount: timeline.gaps.filter((gap) => metricCatalogEntry(gap.metricId).visualization !== "hidden").length,
    timeNormalization: timeline.timeNormalization,
    visibleMetricCount: visibleMetrics.length,
    minimumHeight,
    trackSignature,
    semanticSignature,
    structuralSignature,
    valueSignature,
    renderSignature,
  });
}

/** The host calls this before every native BB action; raw ECharts data never escapes. */
export function activateMachineTimelineEvent(
  figure: CompiledMachineTimeline,
  datumKey: string,
): TimelineChartIntent | null {
  const activation = figure.datumIndex.get(datumKey);
  if (activation == null || activation.generationKey !== figure.generationKey || activation.machineKey !== figure.machineKey) return null;
  return Object.freeze({ kind: "activate-event", activation });
}

/**
 * Resolves a component event through the opaque datum key embedded by this
 * compiler.  `seriesIndex`, `dataIndex`, and pixel positions are deliberately
 * not read, so reordering and stale renderer events cannot retarget a thread.
 */
export function resolveMachineTimelineChartIntent(
  figure: CompiledMachineTimeline,
  rawEvent: unknown,
): TimelineChartIntent | null {
  if (rawEvent == null || typeof rawEvent !== "object") return null;
  const event = rawEvent as EChartsEventLike;
  if (event.componentType !== "series" || (event.seriesId !== figure.eventSeriesId && event.seriesId !== figure.eventDurationSeriesId)) return null;
  if (event.data == null || typeof event.data !== "object") return null;
  const datumKey = (event.data as { datumKey?: unknown }).datumKey;
  return typeof datumKey === "string" ? activateMachineTimelineEvent(figure, datumKey) : null;
}

/** Chooses the narrowest safe long-lived ECharts update for two trusted figures. */
export function decideMachineTimelineUpdate(
  previous: CompiledMachineTimeline | null,
  next: CompiledMachineTimeline,
): TimelineUpdateDecision {
  if (previous == null) return { kind: "full-replacement", reason: "structure changed" };
  if (previous.instanceKey !== next.instanceKey) return { kind: "rebuild-instance", reason: "renderer changed" };
  if (previous.machineKey !== next.machineKey || previous.semanticSignature !== next.semanticSignature) {
    return { kind: "full-replacement", reason: previous.machineKey !== next.machineKey ? "machine changed" : "event semantics changed" };
  }
  // Small multiples are four coupled ECharts component families. Replacing
  // only series would leave removed grids/axes in the long-lived model.
  if (previous.trackSignature !== next.trackSignature) {
    return { kind: "replace-families", families: ["grid", "xAxis", "yAxis", "series"], reason: "metric tracks changed" };
  }
  if (previous.structuralSignature !== next.structuralSignature) return { kind: "full-replacement", reason: "structure changed" };
  return { kind: "merge" };
}
