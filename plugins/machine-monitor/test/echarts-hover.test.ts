import assert from "node:assert/strict";
import test from "node:test";

import { LineChart } from "echarts/charts";
import { DatasetComponent, GridComponent, MarkAreaComponent, MarkLineComponent, TooltipComponent } from "echarts/components";
import * as echarts from "echarts/core";
import { SVGRenderer } from "echarts/renderers";

echarts.use([DatasetComponent, GridComponent, LineChart, MarkAreaComponent, MarkLineComponent, SVGRenderer, TooltipComponent]);

test("axis tooltip leaves every SVG line visible", () => {
  const chart = echarts.init(null, null, { renderer: "svg", ssr: true, width: 640, height: 320 });
  chart.setOption({
    animation: false,
    dataset: { id: "utilization", dimensions: ["time", "CPU", "Memory", "Disk"], source: [[0, 25, 55, 90], [30_000, 30, 58, 89], [60_000, 22, 54, 92]] },
    tooltip: { trigger: "axis", axisPointer: { type: "line", snap: true } },
    xAxis: { type: "time", axisPointer: { triggerEmphasis: true } },
    yAxis: { type: "value" },
    series: ["CPU", "Memory", "Disk"].map((name, index) => ({
      id: name, type: "line", name, datasetId: "utilization", encode: { x: "time", y: name }, showSymbol: false, sampling: "lttb",
      lineStyle: { width: 1.75, color: ["#b78bfa", "#fb7185", "#34d399"][index], opacity: 1 },
      emphasis: { focus: "none", scale: false, symbolSize: 8, lineStyle: { width: 1.75, color: ["#b78bfa", "#fb7185", "#34d399"][index], opacity: 1 }, itemStyle: { color: ["#b78bfa", "#fb7185", "#34d399"][index], opacity: 1 } },
      blur: { lineStyle: { width: 1.75, color: ["#b78bfa", "#fb7185", "#34d399"][index], opacity: 1 } },
      markLine: index === 0 ? { lineStyle: { color: "#f59e0b" }, data: [{ yAxis: 70 }] } : undefined,
      markArea: index === 0 ? { itemStyle: { color: "#06b6d4", opacity: .1 }, data: [[{ xAxis: 0 }, { xAxis: 30_000 }]] } : undefined,
    })),
  });
  const [x, y] = chart.convertToPixel({ xAxisIndex: 0, yAxisIndex: 0 }, [30_000, 30]);
  chart.dispatchAction({ type: "updateAxisPointer", x, y });
  const svg = chart.renderToSVGString();
  for (const color of ["#b78bfa", "#fb7185", "#34d399"]) assert.match(svg, new RegExp(`stroke=\\"${color}\\"`));
  assert.match(svg, /#f59e0b/, "renders the configured threshold line");
  assert.match(svg, /#06b6d4/, "renders the configured warning area");
  chart.dispose();
});
