// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const echartsMock = vi.hoisted(() => {
  const instances: Array<{
    on: ReturnType<typeof vi.fn>;
    off: ReturnType<typeof vi.fn>;
    setOption: ReturnType<typeof vi.fn>;
    resize: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  }> = [];
  const init = vi.fn(() => {
    const chart = { on: vi.fn(), off: vi.fn(), setOption: vi.fn(), resize: vi.fn(), dispose: vi.fn() };
    instances.push(chart);
    return chart;
  });
  return { init, use: vi.fn(), instances };
});

vi.mock("echarts/core", () => ({ init: echartsMock.init, use: echartsMock.use }));

import { FleetUtilizationChart, MachineDashboardChart, MachineTimelineChart } from "../timeline-chart.tsx";
import type { MachineTimelineResult } from "../fleet-contract.ts";

class ControlledResizeObserver {
  static instances: ControlledResizeObserver[] = [];
  readonly observe = vi.fn();
  readonly disconnect = vi.fn();
  constructor(readonly callback: ResizeObserverCallback) {
    ControlledResizeObserver.instances.push(this);
  }
  emit(width: number, height: number): void {
    this.callback([{ contentRect: { width, height } } as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
}

class ControlledMutationObserver {
  static instances: ControlledMutationObserver[] = [];
  readonly observe = vi.fn();
  readonly disconnect = vi.fn();
  constructor(readonly callback: MutationCallback) {
    ControlledMutationObserver.instances.push(this);
  }
}

let frameId = 0;
let frames = new Map<number, FrameRequestCallback>();

function flushFrames(): void {
  const pending = [...frames.entries()];
  frames = new Map();
  for (const [, callback] of pending) callback(0);
}

function optionIds(option: unknown, family: "grid" | "xAxis" | "yAxis" | "series"): string[] {
  const value = (option as Record<string, unknown>)[family];
  return (Array.isArray(value) ? value : []).flatMap((component) => {
    const id = component != null && typeof component === "object" ? (component as { id?: unknown }).id : null;
    return typeof id === "string" ? [id] : [];
  });
}

function timeline(overrides: Partial<MachineTimelineResult> = {}): MachineTimelineResult {
  return {
    contractVersion: 1,
    machine: { source: "local-bb-server", machineId: "local-bb-server" },
    generation: { dataRevision: 7, settingsRevision: 3 },
    range: { startMs: 0, endMs: 1_000 },
    bucket: { alignment: "range-start", widthMs: 1_000, count: 1 },
    coverage: { state: "partial", firstObservedAtMs: 100, lastObservedAtMs: 800, retainedFromMs: 0, retainedToMs: 1_000 },
    metrics: [
      {
        metricId: "cpu.utilization.percent",
        availability: { state: "available", reason: null },
        buckets: [{ startMs: 0, endMs: 1_000, min: 10, average: 20, max: 30, last: 25, count: 2 }],
      },
      {
        metricId: "load.1",
        availability: { state: "available", reason: null },
        buckets: [{ startMs: 0, endMs: 1_000, min: 1, average: 2, max: 3, last: 2, count: 2 }],
      },
    ],
    gaps: [{ metricId: "cpu.utilization.percent", startMs: 400, endMs: 600, reason: "collector-error" }],
    events: {
      events: [{
        contractVersion: 1,
        producer: { id: "job-producer", version: 1 },
        eventId: "job-1",
        time: { kind: "instant", atMs: 500 },
        category: "bb-job",
        status: "failed",
        title: "Build failed",
        detail: "See exact thread for the failure.",
        provenance: { kind: "bb-background-job", jobId: "job-1", attempt: 2 },
        bbReference: { projectId: "project_1", threadId: "thread_1" },
      }],
      totalCount: 3,
      truncated: true,
    },
    ...overrides,
    timeNormalization: overrides.timeNormalization ?? {
      basis: "local-observation",
      sampleCount: 4,
      rawHostObservedRange: { firstMs: 100, lastMs: 800 },
      normalizedRange: { firstMs: 100, lastMs: 800 },
      maxClockUncertaintyMs: 0,
    },
  };
}

beforeEach(() => {
  echartsMock.init.mockClear();
  echartsMock.use.mockClear();
  echartsMock.instances.length = 0;
  ControlledResizeObserver.instances.length = 0;
  ControlledMutationObserver.instances.length = 0;
  frameId = 0;
  frames = new Map();
  vi.stubGlobal("ResizeObserver", ControlledResizeObserver);
  vi.stubGlobal("MutationObserver", ControlledMutationObserver);
  vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
    frameId += 1;
    frames.set(frameId, callback);
    return frameId;
  }));
  vi.stubGlobal("cancelAnimationFrame", vi.fn((id: number) => { frames.delete(id); }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test("defers zero-size initialization, coalesces resize, selects merge/replace, and cleans every resource", () => {
  const initial = timeline();
  const rendered = render(<MachineTimelineChart timeline={initial} />);
  const host = screen.getByRole("img", { name: /Machine timeline/ });
  let layout = { width: 0, height: 0 };
  Object.defineProperty(host, "getBoundingClientRect", {
    configurable: true,
    value: () => ({ ...layout, top: 0, right: layout.width, bottom: layout.height, left: 0, x: 0, y: 0, toJSON: () => ({}) }),
  });

  expect(echartsMock.init).not.toHaveBeenCalled();
  const resizeObserver = ControlledResizeObserver.instances[0]!;
  const themeObserver = ControlledMutationObserver.instances[0]!;
  expect(resizeObserver.observe).toHaveBeenCalledWith(host);

  layout = { width: 400, height: 320 };
  act(() => {
    resizeObserver.emit(400, 320);
    flushFrames();
  });
  expect(echartsMock.init).toHaveBeenCalledTimes(1);
  const chart = echartsMock.instances[0]!;
  expect(chart.on).toHaveBeenCalledTimes(1);
  expect(chart.setOption).toHaveBeenCalledTimes(1);
  expect(chart.setOption.mock.calls[0]![1]).toMatchObject({ notMerge: true, lazyUpdate: false, silent: true });

  act(() => {
    layout = { width: 500, height: 320 };
    resizeObserver.emit(500, 320);
    layout = { width: 640, height: 320 };
    resizeObserver.emit(640, 320);
    expect(frames.size).toBe(1);
    flushFrames();
  });
  expect(chart.resize).toHaveBeenCalledTimes(1);
  expect(chart.resize).toHaveBeenLastCalledWith({ width: 640, height: 320, silent: true });
  expect(chart.setOption).toHaveBeenCalledTimes(1);

  act(() => resizeObserver.emit(640, 320));
  expect(frames.size).toBe(0);
  expect(chart.setOption).toHaveBeenCalledTimes(1);

  // A fresh result object with identical canonical content reaches the host,
  // but its compiler signature prevents any ECharts mutation.
  rendered.rerender(<MachineTimelineChart timeline={timeline()} />);
  expect(frames.size).toBe(1);
  act(flushFrames);
  expect(chart.resize).toHaveBeenCalledTimes(1);
  expect(chart.setOption).toHaveBeenCalledTimes(1);

  const valuesChanged = timeline({ generation: { dataRevision: 8, settingsRevision: 3 } });
  rendered.rerender(<MachineTimelineChart timeline={valuesChanged} />);
  act(flushFrames);
  expect(chart.setOption).toHaveBeenCalledTimes(2);
  expect(chart.setOption.mock.calls[1]![1]).toEqual({ lazyUpdate: false, silent: true });

  const oneTrack = timeline({ metrics: valuesChanged.metrics.slice(0, 1) });
  rendered.rerender(<MachineTimelineChart timeline={oneTrack} />);
  act(flushFrames);
  expect(chart.setOption).toHaveBeenCalledTimes(3);
  expect(chart.setOption.mock.calls[2]![1]).toEqual({ replaceMerge: ["grid", "xAxis", "yAxis", "series"], lazyUpdate: false, silent: true });
  for (const family of ["grid", "xAxis", "yAxis", "series"] as const) {
    expect(optionIds(chart.setOption.mock.calls[2]![0], family).some((id) => id.includes("load.1"))).toBe(false);
  }

  const zeroTracks = timeline({ metrics: [] });
  rendered.rerender(<MachineTimelineChart timeline={zeroTracks} />);
  act(flushFrames);
  expect(chart.setOption).toHaveBeenCalledTimes(4);
  expect(chart.setOption.mock.calls[3]![1]).toEqual({ replaceMerge: ["grid", "xAxis", "yAxis", "series"], lazyUpdate: false, silent: true });
  for (const family of ["grid", "xAxis", "yAxis"] as const) {
    expect(optionIds(chart.setOption.mock.calls[3]![0], family).some((id) => id.includes("metric:"))).toBe(false);
  }

  const reorderedTracks = timeline({ metrics: [...valuesChanged.metrics].reverse() });
  rendered.rerender(<MachineTimelineChart timeline={reorderedTracks} />);
  act(flushFrames);
  expect(chart.setOption).toHaveBeenCalledTimes(5);
  expect(chart.setOption.mock.calls[4]![1]).toEqual({ replaceMerge: ["grid", "xAxis", "yAxis", "series"], lazyUpdate: false, silent: true });
  expect(optionIds(chart.setOption.mock.calls[4]![0], "grid").filter((id) => id.includes("grid:metric:"))).toEqual([
    "machine-monitor:timeline:grid:metric:load.1",
    "machine-monitor:timeline:grid:metric:cpu.utilization.percent",
  ]);

  act(() => resizeObserver.emit(700, 320));
  expect(frames.size).toBe(1);
  rendered.unmount();
  expect(window.cancelAnimationFrame).toHaveBeenCalledTimes(1);
  expect(resizeObserver.disconnect).toHaveBeenCalledTimes(1);
  expect(themeObserver.disconnect).toHaveBeenCalledTimes(1);
  expect(chart.off).toHaveBeenCalledWith("click", chart.on.mock.calls[0]![1]);
  expect(chart.dispose).toHaveBeenCalledTimes(1);
});

test("composes the operational dashboard as two deliberate grids in one persistent ECharts host", () => {
  const metric = (metricId: string, average: number) => ({
    metricId: metricId as any,
    availability: { state: "available" as const, reason: null },
    buckets: [{ startMs: 0, endMs: 1_000, min: average, average, max: average, last: average, count: 1 }],
  });
  const dashboard = timeline({
    metrics: [
      metric("cpu.utilization.percent", 24),
      metric("memory.used.bytes", 4_000_000_000),
      metric("memory.total.bytes", 10_000_000_000),
      metric("disk.root.used.bytes", 6_000_000_000),
      metric("disk.root.total.bytes", 20_000_000_000),
      metric("load.5", 2.5),
    ],
  });
  const rendered = render(<MachineDashboardChart timeline={dashboard} />);
  const host = screen.getByRole("img", { name: /Operational history for local-bb-server/ });
  Object.defineProperty(host, "getBoundingClientRect", {
    configurable: true,
    value: () => ({ width: 800, height: 320, top: 0, right: 800, bottom: 320, left: 0, x: 0, y: 0, toJSON: () => ({}) }),
  });
  act(() => {
    ControlledResizeObserver.instances[0]!.emit(800, 320);
    flushFrames();
  });
  expect(echartsMock.init).toHaveBeenCalledTimes(1);
  const option = echartsMock.instances[0]!.setOption.mock.calls[0]![0] as {
    grid: Array<{ id: string }>;
    yAxis: Array<{ max?: number }>;
    series: Array<{ id: string; data: Array<[number, number | null]> }>;
    media: Array<{ query: { maxWidth: number } }>;
  };
  expect(option.grid.map((grid) => grid.id)).toEqual([
    "machine-monitor:machine-dashboard:grid:utilization",
    "machine-monitor:machine-dashboard:grid:load",
  ]);
  expect(option.yAxis[0]!.max).toBe(100);
  expect(option.series.map((series) => series.id)).toEqual([
    "machine-monitor:machine-dashboard:series:cpu.utilization.percent",
    "machine-monitor:machine-dashboard:series:memory.used.bytes",
    "machine-monitor:machine-dashboard:series:disk.root.used.bytes",
    "machine-monitor:machine-dashboard:series:load.5",
  ]);
  expect(option.series[1]!.data[0]![1]).toBe(40);
  expect(option.series[2]!.data[0]![1]).toBe(30);
  expect(option.media[0]!.query.maxWidth).toBe(640);
  rendered.unmount();
});

test("reuses the same ECharts lifecycle host for a bounded fleet utilization strip", () => {
  const selected: string[] = [];
  const machines = [
    { machineKey: "machine-alpha", label: "Alpha", utilization: 40, headroomToAttention: 30, status: "current" as const, statusLabel: "Current", selected: true },
    { machineKey: "machine-bravo", label: "Bravo", utilization: 92, headroomToAttention: -22, status: "current" as const, statusLabel: "Current", selected: false },
    { machineKey: "machine-charlie", label: "Charlie", utilization: null, headroomToAttention: null, status: "unavailable" as const, statusLabel: "Disconnected", selected: false },
  ] as const;
  const rendered = render(<FleetUtilizationChart machines={machines} onSelectMachine={(machineKey) => selected.push(machineKey)} />);
  const host = screen.getByRole("img", { name: /Fleet utilization for 3 machines/i });
  let layout = { width: 640, height: 152 };
  Object.defineProperty(host, "getBoundingClientRect", {
    configurable: true,
    value: () => ({ ...layout, top: 0, right: layout.width, bottom: layout.height, left: 0, x: 0, y: 0, toJSON: () => ({}) }),
  });
  const resizeObserver = ControlledResizeObserver.instances[0]!;
  act(() => {
    resizeObserver.emit(640, 152);
    flushFrames();
  });
  const chart = echartsMock.instances[0]!;
  const option = chart.setOption.mock.calls[0]![0] as { series: Array<{ id: string; data: Array<{ value: number | null; machineKey: string }>; markLine?: { data: Array<{ yAxis: number }> } }> };
  const series = option.series.find((candidate) => candidate.id === "machine-monitor:fleet-utilization:series:utilization")!;
  expect(series.data.map((datum) => datum.value)).toEqual([40, 92, null]);
  expect(series.data.map((datum) => datum.machineKey)).toEqual(["machine-alpha", "machine-bravo", "machine-charlie"]);
  expect(series.markLine?.data).toEqual([{ yAxis: 70 }]);

  const click = chart.on.mock.calls.find(([name]) => name === "click")![1] as (event: unknown) => void;
  click({ componentType: "series", seriesId: series.id, dataIndex: 1, data: { machineKey: "machine-bravo" } });
  click({ componentType: "series", seriesId: series.id, dataIndex: 99, data: { machineKey: "machine-bravo" } });
  click({ componentType: "series", seriesId: series.id, dataIndex: 1, data: { machineKey: "machine-alpha" } });
  expect(selected).toEqual(["machine-bravo"]);

  rendered.rerender(<FleetUtilizationChart machines={[...machines]} onSelectMachine={(machineKey) => selected.push(machineKey)} />);
  act(flushFrames);
  expect(chart.setOption).toHaveBeenCalledTimes(1);

  rendered.rerender(<FleetUtilizationChart machines={[...machines].reverse()} onSelectMachine={(machineKey) => selected.push(machineKey)} />);
  act(flushFrames);
  expect(echartsMock.init).toHaveBeenCalledTimes(1);
  expect(chart.setOption.mock.calls.at(-1)![1]).toEqual({ notMerge: true, lazyUpdate: false, silent: true });
  // An old index after reorder must be refused; the current datum identity is
  // the only permitted selection key.
  click({ componentType: "series", seriesId: series.id, dataIndex: 0, data: { machineKey: "machine-alpha" } });
  click({ componentType: "series", seriesId: series.id, dataIndex: 2, data: { machineKey: "machine-alpha" } });
  expect(selected).toEqual(["machine-bravo", "machine-alpha"]);

  rendered.unmount();
  expect(resizeObserver.disconnect).toHaveBeenCalledTimes(1);
  expect(chart.dispose).toHaveBeenCalledTimes(1);
});

test("keeps a 256-machine utilization overview dense, concise, and single-hosted", () => {
  const machines = Array.from({ length: 256 }, (_, index) => ({
    machineKey: `machine-${index}`,
    label: `Machine ${index}`,
    utilization: index % 101,
    headroomToAttention: 70 - index % 101,
    status: "current" as const,
    statusLabel: "Current",
    selected: index === 0,
  }));
  const rendered = render(<FleetUtilizationChart machines={machines} />);
  const host = screen.getByRole("img", { name: /Fleet utilization for 256 machines/i });
  Object.defineProperty(host, "getBoundingClientRect", {
    configurable: true,
    value: () => ({ width: 320, height: 152, top: 0, right: 320, bottom: 152, left: 0, x: 0, y: 0, toJSON: () => ({}) }),
  });
  act(() => {
    ControlledResizeObserver.instances[0]!.emit(320, 152);
    flushFrames();
  });
  const option = echartsMock.instances[0]!.setOption.mock.calls[0]![0] as {
    xAxis: { data: string[]; axisLabel: { interval: number } };
    series: Array<{ data: unknown[] }>;
  };
  expect(option.xAxis.data).toHaveLength(256);
  expect(option.xAxis.axisLabel.interval).toBeGreaterThan(0);
  expect(option.series[0]!.data).toHaveLength(256);
  expect(echartsMock.init).toHaveBeenCalledTimes(1);
  expect(host.getAttribute("aria-label")).not.toContain("Machine 255");
  rendered.unmount();
});

test("resolves semantic chart colors from the host theme without a remount", () => {
  const theme = {
    color: "rgb(17, 24, 39)",
    borderTopColor: "rgb(107, 114, 128)",
    borderRightColor: "rgb(209, 213, 219)",
    backgroundColor: "rgb(255, 255, 255)",
    textDecorationColor: "rgb(156, 163, 175)",
    borderBottomColor: "rgb(124, 58, 237)",
    borderLeftColor: "rgb(185, 28, 28)",
  };
  const originalGetComputedStyle = window.getComputedStyle.bind(window);
  const getStyle = vi.spyOn(window, "getComputedStyle").mockImplementation((element) => {
    const computed = originalGetComputedStyle(element);
    return new Proxy(computed, {
      get(target, property, receiver) {
        if (typeof property === "string" && property in theme) return theme[property as keyof typeof theme];
        return Reflect.get(target, property, receiver);
      },
    });
  });
  const machines = [{ machineKey: "machine-alpha", label: "Alpha", utilization: 70, headroomToAttention: 0, status: "current" as const, statusLabel: "Current", selected: true }];
  const rendered = render(<FleetUtilizationChart machines={machines} />);
  const host = screen.getByRole("img", { name: /Fleet utilization for 1 machines/i });
  Object.defineProperty(host, "getBoundingClientRect", {
    configurable: true,
    value: () => ({ width: 320, height: 152, top: 0, right: 320, bottom: 152, left: 0, x: 0, y: 0, toJSON: () => ({}) }),
  });
  act(() => {
    ControlledResizeObserver.instances[0]!.emit(320, 152);
    flushFrames();
  });
  const chart = echartsMock.instances[0]!;
  const first = chart.setOption.mock.calls.at(-1)![0] as { series: Array<{ data: Array<{ itemStyle: { color: string } }> }> };
  expect(first.series[0]!.data[0]!.itemStyle.color).toBe("rgb(185, 28, 28)");
  theme.borderBottomColor = "rgb(12, 140, 233)";
  theme.borderLeftColor = "rgb(224, 72, 72)";
  act(() => {
    ControlledMutationObserver.instances[0]!.callback([], ControlledMutationObserver.instances[0] as unknown as MutationObserver);
    flushFrames();
  });
  const second = chart.setOption.mock.calls.at(-1)![0] as { series: Array<{ data: Array<{ itemStyle: { color: string } }> }> };
  expect(second.series[0]!.data[0]!.itemStyle.color).toBe("rgb(224, 72, 72)");
  expect(echartsMock.init).toHaveBeenCalledTimes(1);
  rendered.unmount();
  getStyle.mockRestore();
});

test("keeps the machine timeline tooltip compact and on the active chart surface across a theme change", () => {
  const theme = {
    color: "rgb(248, 250, 252)",
    borderTopColor: "rgb(148, 163, 184)",
    borderRightColor: "rgb(51, 65, 85)",
    backgroundColor: "rgb(23, 32, 51)",
    textDecorationColor: "rgb(100, 116, 139)",
    borderBottomColor: "rgb(124, 58, 237)",
    borderLeftColor: "rgb(185, 28, 28)",
  };
  const originalGetComputedStyle = window.getComputedStyle.bind(window);
  const getStyle = vi.spyOn(window, "getComputedStyle").mockImplementation((element) => {
    const computed = originalGetComputedStyle(element);
    return new Proxy(computed, {
      get(target, property, receiver) {
        if (typeof property === "string" && property in theme) return theme[property as keyof typeof theme];
        return Reflect.get(target, property, receiver);
      },
    });
  });
  const rendered = render(<MachineTimelineChart timeline={timeline()} />);
  const host = screen.getByRole("img", { name: /Machine timeline/ });
  Object.defineProperty(host, "getBoundingClientRect", {
    configurable: true,
    value: () => ({ width: 640, height: 320, top: 0, right: 640, bottom: 320, left: 0, x: 0, y: 0, toJSON: () => ({}) }),
  });
  act(() => {
    ControlledResizeObserver.instances.at(-1)!.emit(640, 320);
    flushFrames();
  });
  const chart = echartsMock.instances.at(-1)!;
  const first = chart.setOption.mock.calls.at(-1)![0] as {
    tooltip: { backgroundColor: string; borderColor: string; rich: Record<string, { color: string }> };
  };
  expect(first.tooltip.backgroundColor).toBe("rgb(23, 32, 51)");
  expect(first.tooltip.borderColor).toBe("rgb(51, 65, 85)");
  expect(first.tooltip.rich.value!.color).toBe("rgb(248, 250, 252)");
  expect(first.tooltip.rich.heading!.color).toBe("rgb(148, 163, 184)");

  theme.backgroundColor = "rgb(15, 23, 42)";
  theme.color = "rgb(226, 232, 240)";
  act(() => {
    ControlledMutationObserver.instances.at(-1)!.callback([], ControlledMutationObserver.instances.at(-1) as unknown as MutationObserver);
    flushFrames();
  });
  const second = chart.setOption.mock.calls.at(-1)![0] as { tooltip: { backgroundColor: string; rich: Record<string, { color: string }> } };
  expect(second.tooltip.backgroundColor).toBe("rgb(15, 23, 42)");
  expect(second.tooltip.rich.value!.color).toBe("rgb(226, 232, 240)");
  expect(echartsMock.init).toHaveBeenCalledTimes(1);
  rendered.unmount();
  getStyle.mockRestore();
});

test("provides partial/stale/truncated disclosure and a native exact event action", () => {
  const activated: Array<{ threadId: string | null }> = [];
  render(<MachineTimelineChart
    timeline={timeline()}
    stale
    refreshing
    onActivateEvent={(activation) => activated.push({ threadId: activation.bbReference?.threadId ?? null })}
  />);

  expect(screen.getByText("Coverage: partial; the timeline does not represent the complete requested range.")).toBeTruthy();
  expect(screen.getByText("Stale: showing a retained prior generation.")).toBeTruthy();
  expect(screen.getByText("Refreshing timeline data.")).toBeTruthy();
  expect(screen.getByText("Timeline time basis: local-observation; 4 normalized observations; no clock uncertainty.")).toBeTruthy();
  expect(screen.getByText("Explicit metric gaps: 1.")).toBeTruthy();
  expect(screen.getByText("Events truncated: showing 1 of 3.")).toBeTruthy();
  expect(screen.getByRole("region", { name: "Exact timeline events" })).toBeTruthy();
  expect(screen.getByText("Build failed")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Open linked thread for Build failed" }));
  expect(activated).toEqual([{ threadId: "thread_1" }]);
});

test("disables retained cross-machine event activation without remounting the chart host", () => {
  const activated: string[] = [];
  const rendered = render(<MachineTimelineChart
    timeline={timeline()}
    activationDisabled
    onActivateEvent={(activation) => activated.push(activation.bbReference?.threadId ?? "none")}
  />);
  const host = screen.getByRole("img", { name: /Machine timeline/ });
  let layout = { width: 400, height: 320 };
  Object.defineProperty(host, "getBoundingClientRect", {
    configurable: true,
    value: () => ({ ...layout, top: 0, right: layout.width, bottom: layout.height, left: 0, x: 0, y: 0, toJSON: () => ({}) }),
  });
  act(() => {
    ControlledResizeObserver.instances.at(-1)!.emit(400, 320);
    flushFrames();
  });
  const chart = echartsMock.instances.at(-1)!;
  const option = chart.setOption.mock.calls.at(-1)![0] as { series: Array<{ id: string; data: Array<{ datumKey?: string }> }> };
  const events = option.series.find((series) => series.id === "machine-monitor:timeline:series:events")!;
  const click = chart.on.mock.calls.find(([name]) => name === "click")![1] as (event: unknown) => void;
  const listAction = screen.getByRole("button", { name: "Open linked thread for Build failed" });

  expect(host.getAttribute("aria-disabled")).toBe("true");
  expect((listAction as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText(/Event activation is unavailable/)).toBeTruthy();
  click({ componentType: "series", seriesId: events.id, data: { datumKey: events.data[0]!.datumKey } });
  fireEvent.click(listAction);
  expect(activated).toEqual([]);

  rendered.rerender(<MachineTimelineChart timeline={timeline()} onActivateEvent={(activation) => activated.push(activation.bbReference?.threadId ?? "none")} />);
  act(flushFrames);
  expect(screen.getByRole("img", { name: /Machine timeline/ })).toBe(host);
  expect((screen.getByRole("button", { name: "Open linked thread for Build failed" }) as HTMLButtonElement).disabled).toBe(false);
  click({ componentType: "series", seriesId: events.id, data: { datumKey: events.data[0]!.datumKey } });
  fireEvent.click(screen.getByRole("button", { name: "Open linked thread for Build failed" }));
  expect(activated).toEqual(["thread_1", "thread_1"]);
});
