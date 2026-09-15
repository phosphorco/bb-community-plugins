// @vitest-environment jsdom

import Database from "better-sqlite3";
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
  return {
    init: vi.fn(() => {
      const chart = { on: vi.fn(), off: vi.fn(), setOption: vi.fn(), resize: vi.fn(), dispose: vi.fn() };
      instances.push(chart);
      return chart;
    }),
    use: vi.fn(),
    instances,
  };
});

vi.mock("echarts/core", () => ({ init: echartsMock.init, use: echartsMock.use }));

import {
  FLEET_CONTRACT_VERSION,
  TIMELINE_EVENT_PRODUCER_CONTRACT_VERSION,
  type FleetCollectionEnvelope,
  type FleetMachineIdentity,
} from "../fleet-contract.ts";
import { FleetStore } from "../fleet-store.ts";
import { machineMonitorMigrations } from "../store.ts";
import { MachineTimelineChart } from "../timeline-chart.tsx";
import { compileMachineTimeline, resolveMachineTimelineChartIntent } from "../timeline-compiler.ts";
import { SqliteTimelineQuerySource, TimelineQueryService } from "../timeline-query.ts";

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

let nextFrame = 0;
let frames = new Map<number, FrameRequestCallback>();

function flushFrames(): void {
  const pending = [...frames.entries()];
  frames = new Map();
  for (const [, callback] of pending) callback(0);
}

beforeEach(() => {
  echartsMock.init.mockClear();
  echartsMock.use.mockClear();
  echartsMock.instances.length = 0;
  ControlledResizeObserver.instances.length = 0;
  nextFrame = 0;
  frames = new Map();
  vi.stubGlobal("ResizeObserver", ControlledResizeObserver);
  vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
    nextFrame += 1;
    frames.set(nextFrame, callback);
    return nextFrame;
  }));
  vi.stubGlobal("cancelAnimationFrame", vi.fn((frame: number) => { frames.delete(frame); }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const machine: FleetMachineIdentity = { source: "enrolled-host", machineId: "event-seam-host" };
const switchedMachine: FleetMachineIdentity = { source: "enrolled-host", machineId: "event-seam-other-host" };
const bbThread = { projectId: "project_event_seam", threadId: "thr_event_seam" } as const;
const duplicateTitle = "Nightly backup";

function collection(sequence: number, normalizedAtMs: number, cpu: number): FleetCollectionEnvelope {
  return {
    contractVersion: FLEET_CONTRACT_VERSION,
    machine,
    collectorSessionId: "event-seam-collector",
    sequence,
    // The remote raw clock is intentionally skewed; only the server-selected
    // normalized timestamps determine metric placement.
    hostObservedAtMs: 9_000_000 + sequence,
    serverSentAtMs: normalizedAtMs - 5,
    serverReceivedAtMs: normalizedAtMs + 5,
    normalizedAtMs,
    clockUncertaintyMs: 5,
    metrics: [{ metricId: "cpu.utilization.percent", value: cpu, availability: { state: "available", reason: null } }],
  };
}

function backgroundJobEvent(phase: "started" | "succeeded", atMs: number) {
  return {
    contractVersion: FLEET_CONTRACT_VERSION,
    producer: { id: "synthetic-background-job-witness", version: TIMELINE_EVENT_PRODUCER_CONTRACT_VERSION },
    eventId: `background-job-42-attempt-0-${phase}`,
    time: { kind: "instant" as const, atMs },
    category: "bb-job" as const,
    status: phase,
    title: duplicateTitle,
    detail: phase === "started" ? "Background job started." : "Background job completed.",
    provenance: { kind: "bb-background-job" as const, jobId: "background-job-42", attempt: 0 },
    bbReference: bbThread,
  };
}

function register(store: FleetStore, target: FleetMachineIdentity): void {
  store.registerMachine({
    machine: target,
    label: target.machineId,
    connection: "connected",
    capabilities: ["core-sample"],
    serverObservedAtMs: 0,
  });
}

test("witnesses one synthetic background-job lifecycle from durable fleet data to pointer and keyboard BB-thread activation", async () => {
  const db = new Database(":memory:");
  for (const migration of machineMonitorMigrations) db.exec(migration);
  try {
    const store = new FleetStore(db);
    register(store, machine);
    expect(store.recordCollection(collection(0, 10_000, 10)).outcome).toBe("inserted");
    expect(store.recordCollection(collection(1, 20_000, 90)).outcome).toBe("inserted");

    const started = backgroundJobEvent("started", 15_000);
    const terminal = backgroundJobEvent("succeeded", 21_000);
    const firstStarted = store.appendTimelineEvent(machine, started);
    const retriedStarted = store.appendTimelineEvent(machine, started);
    const firstTerminal = store.appendTimelineEvent(machine, terminal);
    const retriedTerminal = store.appendTimelineEvent(machine, terminal);
    expect(firstStarted.outcome).toBe("inserted");
    expect(retriedStarted).toEqual({ outcome: "duplicate", generation: firstStarted.generation });
    expect(firstTerminal.outcome).toBe("inserted");
    expect(retriedTerminal).toEqual({ outcome: "duplicate", generation: firstTerminal.generation });
    expect(store.timelineEvents(machine, 0, 60_000).events.map((event) => event.bbReference)).toEqual([bbThread, bbThread]);

    const query = new TimelineQueryService(store, new SqliteTimelineQuerySource(db), { now: () => 60_000 });
    const timeline = await query.machineTimeline({
      contractVersion: FLEET_CONTRACT_VERSION,
      machine,
      range: { startMs: 0, endMs: 60_000 },
      generation: null,
    });
    const cpu = timeline.metrics.find((metric) => metric.metricId === "cpu.utilization.percent")!;
    expect(cpu.buckets[0]).toEqual({ startMs: 0, endMs: 30_000, min: 10, average: 50, max: 90, last: 90, count: 2 });
    expect(timeline.events.events.map((event) => [event.status, event.time, event.bbReference])).toEqual([
      ["started", { kind: "instant", atMs: 15_000 }, bbThread],
      ["succeeded", { kind: "instant", atMs: 21_000 }, bbThread],
    ]);
    expect(timeline.timeNormalization).toMatchObject({
      basis: "remote-server-request-midpoint",
      rawHostObservedRange: { firstMs: 9_000_000, lastMs: 9_000_001 },
      normalizedRange: { firstMs: 10_000, lastMs: 20_000 },
    });

    const figure = compileMachineTimeline(timeline);
    const terminalActivation = figure.accessibleEvents.find((activation) => activation.event.status === "succeeded")!;
    expect(figure.accessibleEvents.map((activation) => activation.event.title)).toEqual([duplicateTitle, duplicateTitle]);
    expect(terminalActivation.bbReference).toEqual(bbThread);

    const nativeBbThreadTargets: Array<{ projectId: string; threadId: string }> = [];
    render(<MachineTimelineChart
      timeline={timeline}
      onActivateEvent={(activation) => {
        if (activation.bbReference != null) nativeBbThreadTargets.push(activation.bbReference);
      }}
    />);
    const host = screen.getByRole("img", { name: /Machine timeline/ });
    Object.defineProperty(host, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ width: 640, height: 320, top: 0, right: 640, bottom: 320, left: 0, x: 0, y: 0, toJSON: () => ({}) }),
    });
    act(() => {
      ControlledResizeObserver.instances[0]!.emit(640, 320);
      flushFrames();
    });

    expect(screen.getAllByText(duplicateTitle)).toHaveLength(2);
    const chart = echartsMock.instances[0]!;
    const chartClick = chart.on.mock.calls.find(([eventName]) => eventName === "click")![1] as (event: unknown) => void;
    // A stale visual index would point at the first lifecycle row after a
    // reorder. The compiler uses only the opaque datum key, so this pointer
    // event still selects the terminal event.
    act(() => chartClick({
      componentType: "series",
      seriesId: figure.eventSeriesId,
      seriesIndex: 99,
      dataIndex: 0,
      data: { datumKey: terminalActivation.datumKey },
    }));

    const terminalButton = screen.getAllByRole("button", { name: `Open linked thread for ${duplicateTitle}` })[1]!;
    expect(terminalButton.tagName).toBe("BUTTON");
    // JSDOM does not synthesize a button click from keyboard defaults. These
    // literal Enter events plus its native click default model browser button
    // activation without adding an application-specific key handler.
    fireEvent.keyDown(terminalButton, { key: "Enter", code: "Enter" });
    fireEvent.click(terminalButton, { detail: 0 });
    fireEvent.keyUp(terminalButton, { key: "Enter", code: "Enter" });
    expect(nativeBbThreadTargets).toEqual([bbThread, bbThread]);

    const staleIndexIntent = resolveMachineTimelineChartIntent(figure, {
      componentType: "series",
      seriesId: figure.eventSeriesId,
      seriesIndex: 0,
      dataIndex: 0,
      data: { datumKey: terminalActivation.datumKey },
    });
    expect(staleIndexIntent?.activation.event.eventId).toBe(terminal.eventId);

    // A real generation change invalidates every datum key from the retained
    // figure, even if the lifecycle itself is unchanged.
    store.advanceSettingsGeneration(machine);
    const newerFigure = compileMachineTimeline(await query.machineTimeline({
      contractVersion: FLEET_CONTRACT_VERSION,
      machine,
      range: { startMs: 0, endMs: 60_000 },
      generation: null,
    }));
    expect(resolveMachineTimelineChartIntent(newerFigure, {
      componentType: "series", seriesId: newerFigure.eventSeriesId, data: { datumKey: terminalActivation.datumKey },
    })).toBeNull();

    register(store, switchedMachine);
    const switchedFigure = compileMachineTimeline(await query.machineTimeline({
      contractVersion: FLEET_CONTRACT_VERSION,
      machine: switchedMachine,
      range: { startMs: 0, endMs: 60_000 },
      generation: null,
    }));
    expect(resolveMachineTimelineChartIntent(switchedFigure, {
      componentType: "series", seriesId: switchedFigure.eventSeriesId, data: { datumKey: terminalActivation.datumKey },
    })).toBeNull();
  } finally {
    db.close();
  }
});
