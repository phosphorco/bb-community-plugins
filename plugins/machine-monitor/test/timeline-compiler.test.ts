import assert from "node:assert/strict";
import test from "node:test";

import { machineTimelineResultSchema, type MachineTimelineResult } from "../fleet-contract.ts";
import {
  compileMachineTimeline,
  decideMachineTimelineUpdate,
  resolveMachineTimelineChartIntent,
  timelineEventDatumKey,
} from "../timeline-compiler.ts";

function timeline(overrides: Partial<MachineTimelineResult> = {}): MachineTimelineResult {
  return {
    contractVersion: 1,
    machine: { source: "local-bb-server", machineId: "local-bb-server" },
    generation: { dataRevision: 7, settingsRevision: 3 },
    range: { startMs: 0, endMs: 3_000 },
    bucket: { alignment: "range-start", widthMs: 1_000, count: 3 },
    coverage: { state: "complete", firstObservedAtMs: 100, lastObservedAtMs: 2_800, retainedFromMs: 0, retainedToMs: 3_000 },
    metrics: [
      {
        metricId: "cpu.utilization.percent",
        availability: { state: "available", reason: null },
        buckets: [
          { startMs: 0, endMs: 1_000, min: 10, average: 25, max: 40, last: 30, count: 2 },
          { startMs: 1_000, endMs: 2_000, min: null, average: null, max: null, last: null, count: 0 },
          { startMs: 2_000, endMs: 3_000, min: 50, average: 65, max: 95, last: 90, count: 4 },
        ],
      },
      {
        metricId: "load.1",
        availability: { state: "available", reason: null },
        buckets: [
          { startMs: 0, endMs: 1_000, min: 1, average: 2, max: 3, last: 2, count: 2 },
          { startMs: 1_000, endMs: 2_000, min: 2, average: 3, max: 4, last: 4, count: 2 },
          { startMs: 2_000, endMs: 3_000, min: 3, average: 5, max: 8, last: 7, count: 4 },
        ],
      },
    ],
    gaps: [{ metricId: "cpu.utilization.percent", startMs: 1_000, endMs: 2_000, reason: "host-offline" }],
    events: {
      events: [
        {
          contractVersion: 1,
          producer: { id: "job-producer", version: 1 },
          eventId: "job-1",
          time: { kind: "instant", atMs: 400 },
          category: "bb-job",
          status: "started",
          title: "Deploy",
          detail: "first deployment",
          provenance: { kind: "bb-background-job", jobId: "job-1", attempt: 0 },
          bbReference: { projectId: "project_1", threadId: "thread_1" },
        },
        {
          contractVersion: 1,
          producer: { id: "another-producer", version: 1 },
          eventId: "job-1",
          time: { kind: "interval", startMs: 2_100, endMs: 2_900 },
          category: "deployment",
          status: "succeeded",
          title: "Deploy",
          detail: null,
          provenance: { kind: "system", component: "release" },
          bbReference: { projectId: "project_2", threadId: "thread_2" },
        },
      ],
      totalCount: 5,
      truncated: true,
    },
    ...overrides,
    timeNormalization: overrides.timeNormalization ?? {
      basis: "local-observation",
      sampleCount: 6,
      rawHostObservedRange: { firstMs: 100, lastMs: 2_800 },
      normalizedRange: { firstMs: 100, lastMs: 2_800 },
      maxClockUncertaintyMs: 0,
    },
  };
}

function series(figure: ReturnType<typeof compileMachineTimeline>): Array<Record<string, unknown>> {
  return figure.option.series as Array<Record<string, unknown>>;
}

test("compiles server-owned buckets into independent metric scales without ECharts reduction", () => {
  const figure = compileMachineTimeline(timeline());
  const cpuAverage = series(figure).find((entry) => entry.id === "machine-monitor:timeline:series:metric:cpu.utilization.percent:average")!;
  const cpuMinimum = series(figure).find((entry) => entry.id === "machine-monitor:timeline:series:metric:cpu.utilization.percent:minimum")!;
  const cpuMaximum = series(figure).find((entry) => entry.id === "machine-monitor:timeline:series:metric:cpu.utilization.percent:maximum")!;

  assert.deepEqual(cpuAverage.data, [[500, 25], [1_500, null], [2_500, 65]]);
  assert.deepEqual(cpuMinimum.data, [[500, 10], [1_500, null], [2_500, 50]]);
  assert.deepEqual(cpuMaximum.data, [[500, 40], [1_500, null], [2_500, 95]]);
  assert.equal("sampling" in cpuAverage, false, "ECharts must not use LTTB or another client reduction");
  assert.deepEqual((cpuAverage.markArea as { data: unknown }).data, [[{ xAxis: 1_000 }, { xAxis: 2_000 }]]);
  assert.equal(figure.plottedBucketCount, 6);
  assert.equal(figure.explicitGapCount, 1);
  const loadAverage = series(figure).find((entry) => entry.id === "machine-monitor:timeline:series:metric:load.1:average")!;
  assert.notEqual(cpuAverage.yAxisId, loadAverage.yAxisId, "percent and load never share a y scale");
  assert.notEqual(cpuAverage.xAxisId, loadAverage.xAxisId, "each metric has an aligned small-multiple grid");
  assert.equal(figure.visibleMetricCount, 2);
  for (const id of [
    "machine-monitor:timeline:grid:metric:cpu.utilization.percent",
    "machine-monitor:timeline:x-axis:metric:cpu.utilization.percent",
    "machine-monitor:timeline:y-axis:metric:cpu.utilization.percent",
    "machine-monitor:timeline:grid:metric:load.1",
    "machine-monitor:timeline:x-axis:metric:load.1",
    "machine-monitor:timeline:y-axis:metric:load.1",
    "machine-monitor:timeline:grid:events",
    "machine-monitor:timeline:series:events:duration",
    "machine-monitor:timeline:series:events",
  ]) assert.ok(figure.components.some((component) => component.id === id), `stable component ${id}`);
});

test("omits hidden metrics and keeps metric colors stable when tracks are omitted", () => {
  const input = timeline();
  const hiddenMemoryTotal = { ...input.metrics[0]!, metricId: "memory.total.bytes" as const };
  const mixed = timeline({ metrics: [input.metrics[0]!, hiddenMemoryTotal, input.metrics[1]!] });
  const fullFigure = compileMachineTimeline(input);
  const mixedFigure = compileMachineTimeline(mixed);
  const fullCpu = series(fullFigure).find((entry) => entry.id === "machine-monitor:timeline:series:metric:cpu.utilization.percent:average")!;
  const mixedCpu = series(mixedFigure).find((entry) => entry.id === "machine-monitor:timeline:series:metric:cpu.utilization.percent:average")!;
  const fullLoad = series(fullFigure).find((entry) => entry.id === "machine-monitor:timeline:series:metric:load.1:average")!;
  const mixedLoad = series(mixedFigure).find((entry) => entry.id === "machine-monitor:timeline:series:metric:load.1:average")!;

  assert.equal(mixedFigure.visibleMetricCount, 2);
  assert.equal(series(mixedFigure).some((entry) => String(entry.id).includes("memory.total.bytes")), false);
  assert.equal(mixedFigure.components.some((component) => component.id.includes("memory.total.bytes")), false);
  assert.deepEqual(mixedFigure.metricSeriesIds, fullFigure.metricSeriesIds);
  assert.equal((fullCpu.lineStyle as { color: string }).color, (mixedCpu.lineStyle as { color: string }).color);
  assert.equal((fullLoad.lineStyle as { color: string }).color, (mixedLoad.lineStyle as { color: string }).color);
});

test("formats independent metric tracks and tooltip envelopes for monitoring rather than raw storage values", () => {
  const input = timeline({
    metrics: [
      ...timeline().metrics,
      {
        metricId: "memory.used.bytes",
        availability: { state: "available", reason: null },
        buckets: [
          { startMs: 0, endMs: 1_000, min: 90_000_000_000, average: 100_000_000_000, max: 110_000_000_000, last: 105_000_000_000, count: 2 },
          { startMs: 1_000, endMs: 2_000, min: null, average: null, max: null, last: null, count: 0 },
          { startMs: 2_000, endMs: 3_000, min: 120_000_000_000, average: 130_000_000_000, max: 140_000_000_000, last: 135_000_000_000, count: 4 },
        ],
      },
    ],
  });
  const figure = compileMachineTimeline(input, {
    theme: { foreground: "#f8fafc", muted: "#94a3b8", border: "#334155", surface: "#172033", gap: "#64748b" },
  });
  const axes = figure.option.yAxis as Array<Record<string, unknown>>;
  const cpuAxis = axes.find((axis) => axis.id === "machine-monitor:timeline:y-axis:metric:cpu.utilization.percent")!;
  const memoryAxis = axes.find((axis) => axis.id === "machine-monitor:timeline:y-axis:metric:memory.used.bytes")!;
  const cpuFormatter = (cpuAxis.axisLabel as { formatter: (value: number) => string }).formatter;
  const memoryFormatter = (memoryAxis.axisLabel as { formatter: (value: number) => string }).formatter;
  assert.equal(cpuAxis.nameRotate, 0);
  assert.equal(cpuAxis.name, "CPU utilization");
  assert.equal(cpuFormatter(30.120645894727012), "30%");
  assert.equal(memoryFormatter(150_000_000_000), "140 GiB");

  const tooltip = figure.option.tooltip as {
    backgroundColor: string;
    borderColor: string;
    formatter: (parameters: unknown) => string;
    rich: Record<string, unknown>;
  };
  const rendered = tooltip.formatter([
    { seriesId: "machine-monitor:timeline:series:metric:cpu.utilization.percent:average", value: [500, 30.120645894727012] },
    { seriesId: "machine-monitor:timeline:series:metric:cpu.utilization.percent:minimum", value: [500, 22.537358120798057] },
    { seriesId: "machine-monitor:timeline:series:metric:cpu.utilization.percent:maximum", value: [500, 45.27146550551095] },
  ]);
  assert.equal(tooltip.backgroundColor, "#172033");
  assert.equal(tooltip.borderColor, "#334155");
  assert.ok("heading" in tooltip.rich);
  assert.match(rendered, /CPU utilization/);
  assert.match(rendered, /30\.1%/);
  assert.match(rendered, /22\.5%–45\.3%/);
  assert.doesNotMatch(rendered, /30\.120645/);
});

test("event activation resolves only an opaque generation-scoped key, never ECharts indexes", () => {
  const input = timeline();
  const figure = compileMachineTimeline(input);
  const [first, second] = figure.accessibleEvents;
  assert.notEqual(first!.datumKey, second!.datumKey, "duplicate display titles and event IDs remain distinct by producer");
  assert.equal(first!.datumKey, timelineEventDatumKey(input.machine, input.generation, input.events.events[0]!));

  const resolved = resolveMachineTimelineChartIntent(figure, {
    componentType: "series",
    seriesId: figure.eventSeriesId,
    // These hostile positions must have no effect on identity resolution.
    seriesIndex: 99,
    dataIndex: 44,
    data: { datumKey: second!.datumKey },
  });
  assert.equal(resolved?.kind, "activate-event");
  assert.equal(resolved?.activation.event.bbReference?.threadId, "thread_2");
  const duration = series(figure).find((entry) => entry.id === figure.eventDurationSeriesId)!;
  assert.deepEqual(duration.data, [{ coords: [[2_100, 0], [2_900, 0]], datumKey: second!.datumKey }], "interval geometry retains both endpoints");
  const eventMarkers = series(figure).find((entry) => entry.id === figure.eventSeriesId)!;
  assert.deepEqual((eventMarkers.data as Array<{ value: readonly [number, number]; datumKey: string }>).filter((point) => point.datumKey === second!.datumKey).map((point) => point.value), [[2_100, 0], [2_900, 0]]);
  assert.equal(resolveMachineTimelineChartIntent(figure, {
    componentType: "series", seriesId: figure.eventDurationSeriesId, data: { datumKey: second!.datumKey },
  })?.activation.event.bbReference?.threadId, "thread_2", "duration clicks resolve the exact same activation");
  assert.equal(resolveMachineTimelineChartIntent(figure, {
    componentType: "series", seriesId: figure.eventSeriesId, seriesIndex: 0, dataIndex: 0, data: { datumKey: "stale-key" },
  }), null);

  const newer = compileMachineTimeline(timeline({ generation: { dataRevision: 8, settingsRevision: 3 } }));
  assert.equal(resolveMachineTimelineChartIntent(newer, {
    componentType: "series", seriesId: newer.eventSeriesId, data: { datumKey: first!.datumKey },
  }), null, "a late event cannot retarget a newer generation");
});

test("an interval crossing the requested range keeps exact endpoints while the event lane clips its drawing", () => {
  const input = timeline();
  const crossing = {
    ...input.events.events[1]!,
    eventId: "crossing-job",
    time: { kind: "interval" as const, startMs: 2_500, endMs: 3_200 },
  };
  const result = timeline({
    events: { events: [input.events.events[0]!, crossing], totalCount: 2, truncated: false },
  });
  const canonical = machineTimelineResultSchema.parse(result);
  const figure = compileMachineTimeline(canonical);
  const activation = figure.accessibleEvents[1]!;
  const duration = series(figure).find((entry) => entry.id === figure.eventDurationSeriesId)!;

  assert.deepEqual(duration.data, [{ coords: [[2_500, 0], [3_200, 0]], datumKey: activation.datumKey }]);
  assert.equal(duration.clip, true, "the axis clips only the visual segment, not canonical event time");
  assert.equal(activation.event.time.kind, "interval");
  if (activation.event.time.kind === "interval") assert.deepEqual(activation.event.time, { kind: "interval", startMs: 2_500, endMs: 3_200 });
  assert.deepEqual(figure.timeNormalization, canonical.timeNormalization);
});

function componentIds(figure: ReturnType<typeof compileMachineTimeline>): string[] {
  return figure.components.map((component) => component.id);
}

test("update policy merges values, replaces every track family, and fully replaces a selected machine", () => {
  const twoTracks = compileMachineTimeline(timeline());
  const valuesChanged = compileMachineTimeline(timeline({ generation: { dataRevision: 8, settingsRevision: 3 } }));
  const oneTrack = compileMachineTimeline(timeline({ metrics: timeline().metrics.slice(0, 1) }));
  const zeroTracks = compileMachineTimeline(timeline({ metrics: [] }));
  const reorderedTracks = compileMachineTimeline(timeline({ metrics: [...timeline().metrics].reverse() }));
  const machineChanged = compileMachineTimeline(timeline({ machine: { source: "enrolled-host", machineId: "host_1" } }));
  const allTrackFamilies = { kind: "replace-families", families: ["grid", "xAxis", "yAxis", "series"], reason: "metric tracks changed" } as const;

  assert.deepEqual(decideMachineTimelineUpdate(twoTracks, valuesChanged), { kind: "merge" });
  assert.deepEqual(decideMachineTimelineUpdate(twoTracks, oneTrack), allTrackFamilies);
  assert.deepEqual(decideMachineTimelineUpdate(oneTrack, zeroTracks), allTrackFamilies);
  assert.deepEqual(decideMachineTimelineUpdate(zeroTracks, reorderedTracks), allTrackFamilies);
  assert.deepEqual(decideMachineTimelineUpdate(twoTracks, machineChanged), { kind: "full-replacement", reason: "machine changed" });

  assert.ok(componentIds(twoTracks).some((id) => id.includes("metric:load.1")));
  assert.equal(componentIds(oneTrack).some((id) => id.includes("metric:load.1")), false, "one-track option cannot retain removed load components");
  assert.equal(componentIds(zeroTracks).some((id) => id.includes("grid:metric:")), false, "zero-track option contains no metric grids");
  assert.deepEqual(componentIds(reorderedTracks).filter((id) => id.includes("grid:metric:")), [
    "machine-monitor:timeline:grid:metric:load.1",
    "machine-monitor:timeline:grid:metric:cpu.utilization.percent",
  ]);
});
