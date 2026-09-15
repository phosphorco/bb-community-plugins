import * as core from "../../../../node_modules/echarts/core.js";

export * from "../../../../node_modules/echarts/core.js";

type Instrumentation = {
  instrumentation?: { chartProxy?: boolean };
  counters?: { chartInit?: number; chartDispose?: number; chartUpdate?: number };
};

function probes(): Instrumentation | undefined {
  return (globalThis as typeof globalThis & { __fleetPerformance?: Instrumentation }).__fleetPerformance;
}

/** Counts real ECharts instance work without altering its options or renderer. */
export function init(...args: Parameters<typeof core.init>): ReturnType<typeof core.init> {
  const probe = probes();
  if (probe?.instrumentation != null) probe.instrumentation.chartProxy = true;
  if (probe?.counters != null) probe.counters.chartInit = (probe.counters.chartInit ?? 0) + 1;
  const chart = core.init(...args);
  const mutable = chart as unknown as {
    dispose: (...values: never[]) => void;
    setOption: (...values: never[]) => void;
  };
  const dispose = mutable.dispose.bind(chart);
  const setOption = mutable.setOption.bind(chart);
  mutable.dispose = (...values) => {
    const active = probes();
    if (active?.counters != null) active.counters.chartDispose = (active.counters.chartDispose ?? 0) + 1;
    return dispose(...values);
  };
  mutable.setOption = (...values) => {
    const active = probes();
    if (active?.counters != null) active.counters.chartUpdate = (active.counters.chartUpdate ?? 0) + 1;
    return setOption(...values);
  };
  return chart;
}
