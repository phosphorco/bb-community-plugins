import assert from "node:assert/strict";
import test from "node:test";

import { LineChart, LinesChart, ScatterChart } from "echarts/charts";
import { AriaComponent, GridComponent, MarkAreaComponent, TooltipComponent } from "echarts/components";
import * as echarts from "echarts/core";
import { SVGRenderer } from "echarts/renderers";

import type { MachineTimelineResult } from "../fleet-contract.ts";
import { compileMachineTimeline, resolveMachineTimelineChartIntent } from "../timeline-compiler.ts";

echarts.use([AriaComponent, GridComponent, LineChart, LinesChart, MarkAreaComponent, ScatterChart, SVGRenderer, TooltipComponent]);

function timeline(): MachineTimelineResult {
  return {
    contractVersion: 1,
    machine: { source: "local-bb-server", machineId: "local-bb-server" },
    generation: { dataRevision: 3, settingsRevision: 1 },
    range: { startMs: 0, endMs: 60_000 },
    bucket: { alignment: "range-start", widthMs: 20_000, count: 3 },
    coverage: { state: "complete", firstObservedAtMs: 0, lastObservedAtMs: 59_000, retainedFromMs: 0, retainedToMs: 60_000 },
    timeNormalization: {
      basis: "local-observation",
      sampleCount: 5,
      rawHostObservedRange: { firstMs: 0, lastMs: 59_000 },
      normalizedRange: { firstMs: 0, lastMs: 59_000 },
      maxClockUncertaintyMs: 0,
    },
    metrics: [{
      metricId: "cpu.utilization.percent",
      availability: { state: "available", reason: null },
      buckets: [
        { startMs: 0, endMs: 20_000, min: 10, average: 25, max: 40, last: 30, count: 2 },
        { startMs: 20_000, endMs: 40_000, min: null, average: null, max: null, last: null, count: 0 },
        { startMs: 40_000, endMs: 60_000, min: 22, average: 54, max: 92, last: 60, count: 3 },
      ],
    }],
    gaps: [{ metricId: "cpu.utilization.percent", startMs: 20_000, endMs: 40_000, reason: "host-offline" }],
    events: {
      events: [{
        contractVersion: 1,
        producer: { id: "fleet-job", version: 1 },
        eventId: "job-1",
        time: { kind: "interval", startMs: 42_000, endMs: 52_000 },
        category: "bb-job",
        status: "failed",
        title: "Build failed",
        detail: null,
        provenance: { kind: "bb-background-job", jobId: "job-1", attempt: 0 },
        bbReference: { projectId: "project_1", threadId: "thread_1" },
      }],
      totalCount: 1,
      truncated: false,
    },
  };
}

test("the SVG renderer preserves server extrema and resolves an event by its compiler key", () => {
  const figure = compileMachineTimeline(timeline());
  const chart = echarts.init(null, null, { renderer: "svg", ssr: true, width: 640, height: 320 });
  chart.setOption(figure.option);
  const [x, y] = chart.convertToPixel({ xAxisId: "machine-monitor:timeline:x-axis:metric:cpu.utilization.percent", yAxisId: "machine-monitor:timeline:y-axis:metric:cpu.utilization.percent" }, [10_000, 25]);
  chart.dispatchAction({ type: "updateAxisPointer", x, y });
  const svg = chart.renderToSVGString();
  assert.match(svg, /#7c3aed/, "renders the compiler-owned metric color");
  assert.match(svg, /#9ca3af/, "renders the explicit server gap");
  assert.match(svg, /#dc2626/, "renders the truthful interval duration in the aligned event lane");
  assert.equal((figure.option.series as Array<{ sampling?: unknown }>).some((series) => series.sampling != null), false, "does not ask ECharts to LTTB-reduce canonical buckets");

  const datumKey = figure.accessibleEvents[0]!.datumKey;
  const intent = resolveMachineTimelineChartIntent(figure, {
    componentType: "series",
    seriesId: figure.eventDurationSeriesId,
    seriesIndex: 0,
    dataIndex: 0,
    data: { datumKey },
  });
  assert.equal(intent?.activation.event.bbReference?.threadId, "thread_1");
  chart.dispose();
});
