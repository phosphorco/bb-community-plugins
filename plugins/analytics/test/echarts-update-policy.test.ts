import assert from "node:assert/strict";
import test from "node:test";

import type { AnalyticsCompiledFigure } from "../echarts-options.ts";
import { decideFigureUpdate } from "../echarts-update-policy.ts";

const base = {
  renderer: "svg",
  instanceKey: "svg:v1",
  structuralSignature: "bar:x:y",
  componentTopology: {
    aria: ["aria"],
    dataset: ["data"],
    grid: ["grid"],
    series: ["series"],
    tooltip: ["tooltip"],
    xAxis: ["x"],
    yAxis: ["y"],
  },
} as unknown as AnalyticsCompiledFigure;

test("figure update policy preserves state only across compatible structures", () => {
  assert.deepEqual(decideFigureUpdate(null, base), { kind: "full-replacement" });
  assert.deepEqual(decideFigureUpdate(base, { ...base, option: {} }), { kind: "merge" });
  assert.deepEqual(decideFigureUpdate(base, { ...base, instanceKey: "canvas:v1" }), { kind: "rebuild-instance" });
  assert.deepEqual(decideFigureUpdate(base, { ...base, structuralSignature: "line:x:y" }), { kind: "full-replacement" });
  assert.deepEqual(decideFigureUpdate(base, {
    ...base,
    structuralSignature: "bar:x:y:two-series",
    componentTopology: { ...base.componentTopology, series: ["series", "series-2"] },
  }), { kind: "replace-families", families: ["series"] });
});
