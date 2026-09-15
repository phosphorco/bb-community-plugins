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

import { MachineTimelineChart } from "../timeline-chart.tsx";
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
