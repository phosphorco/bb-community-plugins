// @vitest-environment jsdom

import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { FleetClient, fleetClientTimelineKey, mergeFleetOverview } from "../fleet-client.ts";

const echartsMock = vi.hoisted(() => {
  const instances: Array<{ on: ReturnType<typeof vi.fn>; off: ReturnType<typeof vi.fn>; setOption: ReturnType<typeof vi.fn>; resize: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }> = [];
  const init = vi.fn(() => {
    const chart = { on: vi.fn(), off: vi.fn(), setOption: vi.fn(), resize: vi.fn(), dispose: vi.fn() };
    instances.push(chart);
    return chart;
  });
  return { init, instances, use: vi.fn() };
});

vi.mock("echarts/core", () => ({ init: echartsMock.init, use: echartsMock.use }));

class ObservableSize {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe(): void {
    queueMicrotask(() => this.callback([{ contentRect: { width: 640, height: 320 } } as ResizeObserverEntry], this as unknown as ResizeObserver));
  }
  disconnect() {}
}

const attachmentSnapshot = {
  sourceRevision: 0,
  targets: [],
  status: {
    state: "synced" as const, sourceRevision: 0, desiredRevision: 0, lastAckedRevision: 0,
    pending: false, inFlight: false, attempts: 0, nextAttemptAt: null, lastError: null, errorKind: null,
  },
};

const alpha = { source: "enrolled-host" as const, machineId: "machine-alpha" };
const bravo = { source: "enrolled-host" as const, machineId: "machine-bravo" };

function overview(machines = [machine(alpha, "Alpha"), machine(bravo, "Bravo")], generation = { dataRevision: 1, settingsRevision: 1 }) {
  return {
    contractVersion: 1,
    generatedAtMs: 1_000,
    generation,
    machines,
    attachments: { scope: "fleet" as const, snapshot: attachmentSnapshot },
  };
}

function machine(identity: { source: "enrolled-host"; machineId: string }, label: string, overrides: Record<string, unknown> = {}) {
  return {
    machine: identity,
    label,
    connection: "connected" as const,
    freshness: "fresh" as const,
    latestCollectedAtMs: 1_000,
    lastError: null,
    capabilities: ["core-sampling"],
    latestMetrics: [
      { metricId: "cpu.utilization.percent", value: 42, availability: { state: "available" as const, reason: null } },
      { metricId: "memory.pressure.full.percent", value: null, availability: { state: "unavailable" as const, reason: "Unsupported on this host" } },
    ],
    warnings: [],
    generation: { dataRevision: 1, settingsRevision: 1 },
    ...overrides,
  };
}

function timeline(request: { machine: { source: "enrolled-host"; machineId: string }; range: { startMs: number; endMs: number }; generation: { dataRevision: number; settingsRevision: number } }, options: { event?: boolean; empty?: boolean; partial?: boolean } = {}) {
  const { range } = request;
  const event = options.event ? [{
    contractVersion: 1,
    producer: { id: "test-producer", version: 1 },
    eventId: `event-${request.machine.machineId}`,
    time: { kind: "instant" as const, atMs: range.startMs + 1 },
    category: "bb-job" as const,
    status: "failed" as const,
    title: "Repair thread",
    detail: "A precise event.",
    provenance: { kind: "bb-background-job" as const, jobId: "job-1", attempt: 1 },
    bbReference: { projectId: "proj_events", threadId: "thr_events" },
  }] : [];
  const empty = options.empty === true;
  return {
    contractVersion: 1,
    machine: request.machine,
    generation: request.generation,
    range,
    bucket: { alignment: "range-start" as const, widthMs: range.endMs - range.startMs, count: 1 },
    coverage: empty
      ? { state: "empty" as const, firstObservedAtMs: null, lastObservedAtMs: null, retainedFromMs: null, retainedToMs: null }
      : { state: options.partial ? "partial" as const : "complete" as const, firstObservedAtMs: range.startMs + 1, lastObservedAtMs: range.endMs - 1, retainedFromMs: range.startMs, retainedToMs: range.endMs },
    timeNormalization: empty
      ? { basis: "remote-server-request-midpoint" as const, sampleCount: 0, rawHostObservedRange: { firstMs: null, lastMs: null }, normalizedRange: { firstMs: null, lastMs: null }, maxClockUncertaintyMs: null }
      : { basis: "remote-server-request-midpoint" as const, sampleCount: 2, rawHostObservedRange: { firstMs: range.startMs + 1, lastMs: range.endMs - 1 }, normalizedRange: { firstMs: range.startMs + 1, lastMs: range.endMs - 1 }, maxClockUncertaintyMs: 10 },
    metrics: empty ? [] : [{
      metricId: "cpu.utilization.percent",
      availability: { state: "available" as const, reason: null },
      buckets: [{ startMs: range.startMs, endMs: range.endMs, min: 20, average: 30, max: 40, last: 35, count: 2 }],
    }],
    gaps: [],
    events: { events: event, totalCount: event.length, truncated: false },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => { resolve = nextResolve; reject = nextReject; });
  return { promise, resolve, reject };
}

function fleetRpc(overviews: () => unknown, onTimeline: (request: any) => unknown) {
  return {
    fleetOverview: () => overviews(),
    machineTimeline: (request: any) => onTimeline(request),
    machineInventory: ({ machine: identity }: any) => ({
      contractVersion: 1,
      machine: identity,
      generation: { dataRevision: 1, settingsRevision: 1 },
      receivedAtMs: 1_000,
      lastError: null,
      lastErrorAtMs: null,
      inventory: {
        contractVersion: 1, collectorSessionId: "inventory-session", observedAtMs: 1_000, visibility: "host-visible",
        os: { name: "Test Linux", version: "1", kernel: "test", architecture: "x64" },
        cpu: { logicalCores: 4, observedPhysicalCores: 2, observedPackages: 1, model: "Test CPU", speedMHz: 2400, availability: { state: "available", reason: null } },
        memory: { usableBytes: 16_000, availability: { state: "available", reason: null } },
        disks: [], disksAvailability: { state: "partial", reason: "No disks in fixture." },
        raid: { state: "not-detected", arrays: [], source: "linux-mdstat", reason: "No active Linux md arrays were reported." },
        location: { value: null, source: "unavailable" }, limitations: ["Location is not inferred."],
      },
    }),
    getAttachments: () => attachmentSnapshot,
    searchThreads: () => ({ threads: [] }),
    health: () => ({ hostName: "test", latest: null, lastError: null, warnings: [] }),
  };
}

async function openDetailedTimeline(slot: { findByText: (value: RegExp) => Promise<HTMLElement> }): Promise<void> {
  const summary = (await slot.findByText(/Full metric timeline and events/)).closest("summary");
  if (summary == null) throw new Error("The selected machine did not render a full-timeline disclosure.");
  const details = summary.parentElement as HTMLDetailsElement;
  if (!details.open) fireEvent.click(summary);
}

function cachedTimeline(
  identity: typeof alpha,
  range: { startMs: number; endMs: number },
  generation = { dataRevision: 1, settingsRevision: 1 },
  padding = "",
) {
  return { ...timeline({ machine: identity, range, generation }), padding } as any;
}

beforeEach(() => {
  echartsMock.init.mockClear();
  echartsMock.instances.length = 0;
  vi.stubGlobal("ResizeObserver", ObservableSize);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    queueMicrotask(() => callback(0));
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
  vi.stubGlobal("requestIdleCallback", vi.fn(() => 1));
  vi.stubGlobal("cancelIdleCallback", vi.fn());
});

afterEach(async () => {
  cleanup();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("bounds the detailed LRU by bytes, rejects oversize entries, and keys exact range plus revision", async () => {
  const rangeA = { startMs: 0, endMs: 60 };
  const rangeB = { startMs: 1, endMs: 61 };
  const generationA = { dataRevision: 1, settingsRevision: 1 };
  const generationB = { dataRevision: 2, settingsRevision: 1 };
  let calls = 0;
  const client = new FleetClient({
    readOverview: async () => overview() as any,
    readTimeline: async (request) => {
      calls += 1;
      return cachedTimeline(request.machine as typeof alpha, request.range, request.generation!, "x".repeat(1_800));
    },
  }, { maxTimelineBytes: 3_000 });

  expect(fleetClientTimelineKey(alpha, rangeA, generationA)).not.toBe(fleetClientTimelineKey(alpha, rangeB, generationA));
  expect(fleetClientTimelineKey(alpha, rangeA, generationA)).not.toBe(fleetClientTimelineKey(alpha, rangeA, generationB));
  await client.readTimeline(alpha, rangeA, generationA);
  await client.readTimeline(alpha, rangeA, generationA);
  await client.readTimeline(alpha, rangeB, generationA);
  await client.readTimeline(alpha, rangeA, generationB);
  expect(calls).toBe(3);
  expect(client.timelineByteSize).toBeLessThanOrEqual(3_000);
  expect(client.timelineEntryCount).toBe(1);
  expect(client.getTimeline(alpha, rangeA, generationA)).toBeUndefined();

  const oversize = new FleetClient({
    readOverview: async () => overview() as any,
    readTimeline: async (request) => cachedTimeline(request.machine as typeof alpha, request.range, request.generation!, "x".repeat(4_000)),
  }, { maxTimelineBytes: 100 });
  await oversize.readTimeline(alpha, rangeA, generationA);
  expect(oversize.timelineEntryCount).toBe(0);
  expect(oversize.timelineByteSize).toBe(0);
});

test("lifecycle reuse makes old flights obsolete without preventing a Strict Mode-style remount", async () => {
  const first = deferred<any>();
  const second = deferred<any>();
  const responses = [first.promise, second.promise];
  const client = new FleetClient({
    readOverview: async () => overview() as any,
    readTimeline: () => responses.shift()!,
  });
  const range = { startMs: 0, endMs: 60 };
  const generation = { dataRevision: 1, settingsRevision: 1 };
  client.activate();
  const oldRead = client.readTimeline(alpha, range, generation);
  client.dispose();
  client.activate();
  const currentRead = client.readTimeline(alpha, range, generation);
  first.resolve(cachedTimeline(alpha, range, generation));
  await oldRead;
  expect(client.getTimeline(alpha, range, generation)).toBeUndefined();
  second.resolve(cachedTimeline(alpha, range, generation));
  await currentRead;
  expect(client.getTimeline(alpha, range, generation)).toBeTruthy();
});

test("obsolete invalidated responses never repopulate the detailed cache", async () => {
  const pending = deferred<any>();
  const client = new FleetClient({ readOverview: async () => overview() as any, readTimeline: () => pending.promise });
  const range = { startMs: 0, endMs: 60 };
  const generation = { dataRevision: 1, settingsRevision: 1 };
  const read = client.readTimeline(alpha, range, generation);
  client.invalidateMachine(alpha);
  pending.resolve(cachedTimeline(alpha, range, generation));
  await read;
  expect(client.getTimeline(alpha, range, generation)).toBeUndefined();
  expect(client.timelineFlightCount).toBe(0);
});

test("bounds live detail flights while an invalidated request waits to settle", async () => {
  const charlie = { source: "enrolled-host" as const, machineId: "machine-charlie" };
  const first = deferred<any>();
  const second = deferred<any>();
  const replacement = deferred<any>();
  const pending = [first, second, replacement];
  const calls: any[] = [];
  const client = new FleetClient({
    readOverview: async () => overview() as any,
    readTimeline: (request) => {
      calls.push(request);
      return pending.shift()!.promise;
    },
  }, { maxTimelineFlights: 2 });
  const range = { startMs: 0, endMs: 60 };
  const firstGeneration = { dataRevision: 1, settingsRevision: 1 };
  const currentGeneration = { dataRevision: 2, settingsRevision: 1 };

  const invalidatedRead = client.readTimeline(alpha, range, firstGeneration);
  const unrelatedRead = client.readTimeline(charlie, range, firstGeneration);
  client.invalidateMachine(alpha);
  const currentRead = client.readTimeline(alpha, range, currentGeneration);

  expect(calls).toHaveLength(2);
  expect(client.timelineOutstandingFlightCount).toBe(2);
  expect(client.timelineFlightCount).toBe(2);

  first.resolve(cachedTimeline(alpha, range, firstGeneration));
  await invalidatedRead;
  await waitFor(() => expect(calls).toHaveLength(3));
  expect(client.timelineOutstandingFlightCount).toBeLessThanOrEqual(2);

  replacement.resolve(cachedTimeline(alpha, range, currentGeneration));
  await currentRead;
  second.resolve(cachedTimeline(charlie, range, firstGeneration));
  await unrelatedRead;
  expect(client.getTimeline(alpha, range, currentGeneration)).toBeTruthy();
});

test("keeps Linked threads fleet-scoped while preserving add, native navigation, and remove", async () => {
  const app = await loadPluginApp(() => import("../app.tsx"));
  const target = {
    provider: "bb",
    keys: { project: "proj_picker01", thread: "thr_picker01" },
    presentation: { label: "Fix disk pressure", detail: "Project proj_picker01" },
  };
  const updated = { ...attachmentSnapshot, sourceRevision: 1, targets: [target], status: { ...attachmentSnapshot.status, sourceRevision: 1, desiredRevision: 1, state: "pending" as const, pending: true } };
  const replacements: unknown[] = [];
  const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, {
    rpc: {
      ...fleetRpc(() => overview(), (request) => timeline(request)),
      getAttachments: () => replacements.length === 0 ? attachmentSnapshot : updated,
      searchThreads: () => ({ threads: [{ id: "thr_picker01", projectId: "proj_picker01", title: "Fix disk pressure", detail: "Root disk warning", archived: false }] }),
      getThread: () => ({ id: "thr_picker01", projectId: "proj_picker01", title: "Fix disk pressure", detail: "Root disk warning", archived: false }),
      replaceAttachments: (input: unknown) => {
        replacements.push(input);
        return { outcome: "applied", ...(replacements.length === 1 ? updated : attachmentSnapshot) };
      },
    },
  } as any);

  expect(await slot.findByText("Keep the BB threads that explain or repair this fleet close at hand.")).toBeTruthy();
  fireEvent.change(slot.getByRole("searchbox", { name: "Add a BB thread" }), { target: { value: "disk" } });
  await slot.findByText(/Root disk warning/);
  fireEvent.click(slot.getByRole("button", { name: "Link Fix disk pressure" }));
  await waitFor(() => expect(replacements).toHaveLength(1));
  expect(replacements[0]).toEqual({ expectedSourceRevision: 0, targets: [target] });
  fireEvent.click(await slot.findByRole("link", { name: "Fix disk pressure" }));
  expect(slot.inspection.navigateCalls).toContainEqual({ method: "toThread", threadId: "thr_picker01" });
  fireEvent.click(slot.getByRole("button", { name: "Remove Fix disk pressure" }));
  await waitFor(() => expect(replacements).toHaveLength(2));
  slot.lifecycle.unmount();
});

test("keeps overview resident and reuses a cached timeline without a third RPC", async () => {
  const app = await loadPluginApp(() => import("../app.tsx"));
  const calls: string[] = [];
  const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, {
    rpc: fleetRpc(() => overview(), (request) => {
      calls.push(request.machine.machineId);
      return timeline(request, { event: true });
    }),
  } as any);

  await slot.findByRole("button", { name: /Alpha\. connected/ });
  await waitFor(() => expect(calls).toEqual(["machine-alpha"]));
  await slot.findByRole("img", { name: /Operational history for machine-alpha/ });
  // Context owns a stable shell while its deliberately idle inventory read is
  // pending; the selected chart does not move or remount when it arrives.
  expect(slot.getByRole("heading", { name: "Machine context" })).toBeTruthy();
  expect(slot.getByText("Loading machine context…")).toBeTruthy();
  const selectedPanel = slot.getByRole("heading", { name: "Alpha" }).closest(".machine-monitor__selected-machine")!;
  const fleetPanel = slot.getByRole("heading", { name: "Fleet overview" }).closest(".machine-monitor__fleet-picker")!;
  expect(selectedPanel.compareDocumentPosition(fleetPanel) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  const historySummary = slot.getByText(/^History data/).closest("summary")!;
  const historyDetails = historySummary.parentElement as HTMLDetailsElement;
  historyDetails.open = true;
  fireEvent(historyDetails, new Event("toggle", { bubbles: true }));
  expect(slot.getByRole("table")).toBeTruthy();
  expect(slot.getByText(/Coverage is complete for the requested bounded range/)).toBeTruthy();

  fireEvent.click(slot.getByRole("button", { name: /Bravo\. connected/ }));
  await waitFor(() => expect(calls).toEqual(["machine-alpha", "machine-bravo"]));
  expect(slot.getByRole("button", { name: /Alpha\. connected/ })).toBeTruthy();
  expect(slot.getByRole("img", { name: /Operational history for machine-bravo/ })).toBeTruthy();

  fireEvent.click(slot.getByRole("button", { name: /Alpha\. connected/ }));
  expect(calls).toEqual(["machine-alpha", "machine-bravo"]);
  expect(slot.getByRole("heading", { name: "Alpha" })).toBeTruthy();
  expect(slot.getByRole("img", { name: /Operational history for machine-alpha/ })).toBeTruthy();
  slot.lifecycle.unmount();
});

test("renders the daemon-visible static profile after timeline work yields to idle", async () => {
  vi.stubGlobal("requestIdleCallback", (callback: (deadline: IdleDeadline) => void) => {
    queueMicrotask(() => callback({ didTimeout: false, timeRemaining: () => 50 }));
    return 1;
  });
  const app = await loadPluginApp(() => import("../app.tsx"));
  const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, {
    rpc: fleetRpc(() => overview(), (request) => timeline(request)),
  } as any);

  expect(await slot.findByText("4 logical cores")).toBeTruthy();
  expect(slot.getByText("Not reported")).toBeTruthy();
  expect(slot.getByText(/Usable memory visible to this daemon/)).toBeTruthy();
  slot.lifecycle.unmount();
});

test("retains machine context through telemetry reconciliation without re-reading static inventory", async () => {
  vi.stubGlobal("requestIdleCallback", (callback: (deadline: IdleDeadline) => void) => {
    queueMicrotask(() => callback({ didTimeout: false, timeRemaining: () => 50 }));
    return 1;
  });
  const initial = overview([machine(alpha, "Alpha")]);
  const reconciled = overview([machine(alpha, "Alpha current", { generation: { dataRevision: 2, settingsRevision: 1 } })], { dataRevision: 2, settingsRevision: 1 });
  let current = initial;
  let inventoryCalls = 0;
  const app = await loadPluginApp(() => import("../app.tsx"));
  const rpc = fleetRpc(() => current, (request) => timeline(request));
  const originalInventory = rpc.machineInventory;
  rpc.machineInventory = (request: unknown) => {
    inventoryCalls += 1;
    return originalInventory(request);
  };
  const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc } as any);

  await slot.findByText("4 logical cores");
  expect(inventoryCalls).toBe(1);
  const context = slot.getByRole("heading", { name: "Machine context" }).closest(".machine-monitor__machine-context")!;
  const chart = slot.getByRole("img", { name: /Operational history for machine-alpha/ });

  current = reconciled;
  void slot.behavior.emitRealtime("machine-monitor-fleet", { machine: alpha, dataRevision: 2, settingsRevision: 1, kinds: ["collection"] });
  await slot.findByRole("heading", { name: "Alpha current" });
  await waitFor(() => expect(slot.getByRole("img", { name: /Operational history for machine-alpha/ })).toBe(chart));
  expect(slot.getByRole("heading", { name: "Machine context" }).closest(".machine-monitor__machine-context")).toBe(context);
  expect(slot.getByText("4 logical cores")).toBeTruthy();
  expect(inventoryCalls).toBe(1);
  slot.lifecycle.unmount();
});

test("keeps the atlas in keyboard order while a stale, collector-failing source is selected", async () => {
  const healthy = machine(alpha, "Alpha", {
    latestMetrics: [
      { metricId: "cpu.utilization.percent", value: 24, availability: { state: "available" as const, reason: null } },
      { metricId: "memory.pressure.full.percent", value: 99, availability: { state: "available" as const, reason: null } },
      { metricId: "memory.used.bytes", value: 4, availability: { state: "available" as const, reason: null } },
      { metricId: "memory.total.bytes", value: 10, availability: { state: "available" as const, reason: null } },
      { metricId: "disk.root.used.bytes", value: 3, availability: { state: "available" as const, reason: null } },
      { metricId: "disk.root.total.bytes", value: 10, availability: { state: "available" as const, reason: null } },
    ],
  });
  const degraded = machine(bravo, "Bravo", {
    freshness: "stale" as const,
    lastError: "Collector timed out",
    warnings: [{ kind: "collector-error" as const, message: "No current collection.", metricId: null }],
    latestMetrics: [
      { metricId: "cpu.utilization.percent", value: 96, availability: { state: "available" as const, reason: null } },
      { metricId: "memory.pressure.full.percent", value: 91, availability: { state: "available" as const, reason: null } },
      { metricId: "disk.root.used.bytes", value: 95, availability: { state: "available" as const, reason: null } },
      { metricId: "disk.root.total.bytes", value: 100, availability: { state: "available" as const, reason: null } },
    ],
  });
  const app = await loadPluginApp(() => import("../app.tsx"));
  const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, {
    rpc: fleetRpc(() => overview([healthy, degraded]), (request) => timeline(request)),
  } as any);

  const alphaButton = await slot.findByRole("button", { name: /^Alpha\. connected\. fresh\. Current\./ }) as HTMLButtonElement;
  const bravoButton = slot.getByRole("button", { name: /^Bravo\. connected\. stale\. Stale data\./ }) as HTMLButtonElement;
  const atlasButtons = slot.getAllByRole("button", { name: /^(Alpha|Bravo)\. connected\./ }) as HTMLButtonElement[];
  expect(atlasButtons).toEqual([alphaButton, bravoButton]);
  expect(alphaButton.tabIndex).toBe(0);
  expect(bravoButton.tabIndex).toBe(0);
  expect(alphaButton.getAttribute("aria-pressed")).toBe("true");
  expect(bravoButton.dataset.anomalous).toBe("true");
  expect(bravoButton.dataset.collector).toBe("failure");
  expect(bravoButton.dataset.pressure).toBe("critical");
  expect(bravoButton.dataset.freshness).toBe("stale");
  const description = document.getElementById(bravoButton.getAttribute("aria-describedby") ?? "");
  expect(description?.textContent).toContain("Collector failure: Collector timed out.");
  expect(description?.textContent).toContain("CPU utilization 96.0 percent");
  expect(description?.textContent).toContain("Memory utilization unavailable");
  expect(description?.textContent).toContain("Root disk utilization 95.0 percent");

  const host = await slot.findByRole("img", { name: /Operational history for machine-alpha/ });
  bravoButton.focus();
  expect(document.activeElement).toBe(bravoButton);
  fireEvent.click(bravoButton);
  await slot.findByRole("heading", { name: "Bravo" });
  expect(alphaButton.getAttribute("aria-pressed")).toBe("false");
  expect(bravoButton.getAttribute("aria-pressed")).toBe("true");
  const dashboard = slot.getByRole("img", { name: /Operational history for machine-bravo/ });
  const notices = slot.getByLabelText("Machine notices");
  expect(dashboard.compareDocumentPosition(notices) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(notices.textContent).toContain("Collector error: Collector timed out");
  expect(notices.textContent).toContain("No current collection.");
  expect(slot.getByRole("heading", { name: "Bravo" }).closest(".machine-monitor__selected-machine")?.getAttribute("data-stale")).toBe("true");
  slot.lifecycle.unmount();
});

test("coalesces uncached selection work and disables retained other-machine event actions", async () => {
  const app = await loadPluginApp(() => import("../app.tsx"));
  const bravoPending = deferred<any>();
  const calls: string[] = [];
  let bravoRequest: any;
  const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, {
    rpc: fleetRpc(() => overview(), (request) => {
      calls.push(request.machine.machineId);
      if (request.machine.machineId === "machine-bravo") {
        bravoRequest = request;
        return bravoPending.promise;
      }
      return timeline(request, { event: true });
    }),
  } as any);
  await slot.findByRole("heading", { name: "Alpha" });
  await waitFor(() => expect(calls).toEqual(["machine-alpha"]));
  await openDetailedTimeline(slot);

  const bravoButton = slot.getByRole("button", { name: /Bravo\. connected/ });
  fireEvent.click(bravoButton);
  fireEvent.click(bravoButton);
  await waitFor(() => expect(calls).toEqual(["machine-alpha", "machine-bravo"]));
  expect(slot.getByText(/Showing retained timeline for machine-alpha; Bravo is loading/)).toBeTruthy();
  expect(slot.getByRole("img", { name: /Operational history for machine-alpha\. Showing retained history/ })).toBeTruthy();
  // Retained history remains visible while a new source loads, but its exact
  // event controls stay absent until the matching generation arrives.
  expect(slot.queryByRole("button", { name: "Open linked thread for Repair thread" })).toBeNull();
  bravoPending.resolve(timeline(bravoRequest, { event: true }));
  await openDetailedTimeline(slot);
  await waitFor(() => expect((slot.getByRole("button", { name: "Open linked thread for Repair thread" }) as HTMLButtonElement).disabled).toBe(false));
  expect(slot.getByRole("img", { name: /Machine timeline/ }).getAttribute("aria-disabled")).toBeNull();
  slot.lifecycle.unmount();
});

test("an invalidated selected response cannot reclaim event navigation across a newer generation or machine", async () => {
  const initial = overview([machine(alpha, "Alpha"), machine(bravo, "Bravo")]);
  const reconciled = {
    ...overview([
      machine(alpha, "Alpha current", { generation: { dataRevision: 2, settingsRevision: 1 } }),
      initial.machines[1]!,
    ], { dataRevision: 2, settingsRevision: 1 }),
    generatedAtMs: 2_000,
  };
  const reconciliation = deferred<any>();
  const staleAlpha = deferred<any>();
  const currentAlpha = deferred<any>();
  const currentBravo = deferred<any>();
  const requests: any[] = [];
  let overviewCalls = 0;
  const app = await loadPluginApp(() => import("../app.tsx"));
  const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, {
    rpc: fleetRpc(() => {
      overviewCalls += 1;
      return overviewCalls === 1 ? initial : reconciliation.promise;
    }, (request) => {
      requests.push(request);
      if (request.machine.machineId === alpha.machineId && request.generation.dataRevision === 1) return staleAlpha.promise;
      if (request.machine.machineId === alpha.machineId) return currentAlpha.promise;
      return currentBravo.promise;
    }),
  } as any);
  await slot.findByRole("heading", { name: "Alpha" });
  await waitFor(() => expect(requests).toHaveLength(1));

  void slot.behavior.emitRealtime("machine-monitor-fleet", { machine: alpha, dataRevision: 2, settingsRevision: 1, kinds: ["collection"] });
  await waitFor(() => expect(overviewCalls).toBe(2));
  expect(slot.getByText("Loading timeline for Alpha…")).toBeTruthy();

  // This answer began before the invalidation and must not briefly render a
  // current Alpha chart or expose its pointer/list event action.
  staleAlpha.resolve(timeline(requests[0]!, { event: true }));
  await waitFor(() => expect(slot.queryByRole("button", { name: "Open linked thread for Repair thread" })).toBeNull());
  expect(slot.getByText("No retained timeline is available yet.")).toBeTruthy();

  reconciliation.resolve(reconciled);
  await waitFor(() => expect(requests).toHaveLength(2));
  expect(requests[1]).toMatchObject({ machine: alpha, generation: { dataRevision: 2, settingsRevision: 1 } });

  fireEvent.click(slot.getByRole("button", { name: /Bravo\. connected/ }));
  await waitFor(() => expect(requests).toHaveLength(3));
  currentAlpha.resolve(timeline(requests[1]!, { event: true }));
  await Promise.resolve();
  expect(slot.getByRole("heading", { name: "Bravo" })).toBeTruthy();
  expect(slot.queryByRole("button", { name: "Open linked thread for Repair thread" })).toBeNull();

  currentBravo.resolve(timeline(requests[2]!, { event: true }));
  await openDetailedTimeline(slot);
  const action = await slot.findByRole("button", { name: "Open linked thread for Repair thread" }) as HTMLButtonElement;
  expect(action.disabled).toBe(false);
  fireEvent.click(action);
  expect(slot.inspection.navigateCalls).toContainEqual({ method: "toThread", threadId: "thr_events" });
  slot.lifecycle.unmount();
});

test("coalesced A then B invalidations reconcile both changed summaries and retain only unchanged row identity", async () => {
  const charlie = { source: "enrolled-host" as const, machineId: "machine-charlie" };
  const initial = overview([machine(alpha, "Alpha"), machine(bravo, "Bravo"), machine(charlie, "Charlie")]);
  const reconciled = overview([
    machine(alpha, "Alpha revised", { latestCollectedAtMs: 2_000, generation: { dataRevision: 2, settingsRevision: 1 } }),
    machine(bravo, "Bravo revised", { warnings: [{ kind: "collector-error", message: "Collector recovered", metricId: null }], generation: { dataRevision: 2, settingsRevision: 1 } }),
    initial.machines[2]!,
  ], { dataRevision: 2, settingsRevision: 1 });
  const pending = deferred<any>();
  let overviewCalls = 0;
  const client = new FleetClient({
    readOverview: () => {
      overviewCalls += 1;
      return (overviewCalls === 1 ? initial : pending.promise) as any;
    },
    readTimeline: async (request) => timeline(request as any) as any,
  });
  await client.readOverview();
  const afterA = client.readOverview();
  const afterB = client.readOverview();
  expect(afterA).toBe(afterB);
  expect(overviewCalls).toBe(2);
  pending.resolve(reconciled);
  const authoritative = await afterB;
  expect(authoritative.machines.map((value) => value.label)).toEqual(["Alpha revised", "Bravo revised", "Charlie"]);

  const merged = mergeFleetOverview(initial as any, reconciled as any);
  expect(merged.machines[0]).not.toBe(initial.machines[0]);
  expect(merged.machines[1]).not.toBe(initial.machines[1]);
  expect(merged.machines[2]).toBe(initial.machines[2]);
});

test("anchors initial, user-selected, and reconciliation ranges to server time despite browser clock skew", async () => {
  const now = vi.spyOn(Date, "now").mockReturnValue(9_000_000_000_000);
  const first = { ...overview([machine(alpha, "Alpha")]), generatedAtMs: 100_000_000 };
  const second = {
    ...overview([machine(alpha, "Alpha", { generation: { dataRevision: 2, settingsRevision: 1 } })], { dataRevision: 2, settingsRevision: 1 }),
    generatedAtMs: 200_000_000,
  };
  let current = first;
  const calls: any[] = [];
  const app = await loadPluginApp(() => import("../app.tsx"));
  const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, {
    rpc: fleetRpc(() => current, (request) => {
      calls.push(request);
      return timeline(request);
    }),
  } as any);
  await slot.findByRole("heading", { name: "Alpha" });
  await waitFor(() => expect(calls).toHaveLength(1));
  expect(calls[0]!.range).toEqual({ startMs: 13_600_000, endMs: 100_000_000 });
  fireEvent.change(slot.getByRole("combobox", { name: "History" }), { target: { value: "1" } });
  await waitFor(() => expect(calls).toHaveLength(2));
  expect(calls[1]!.range).toEqual({ startMs: 96_400_000, endMs: 100_000_000 });
  current = second;
  void slot.behavior.emitRealtime("machine-monitor-fleet", { machine: alpha, dataRevision: 2, settingsRevision: 1, kinds: ["collection"] });
  await waitFor(() => expect(calls).toHaveLength(3));
  expect(calls[2]!.range).toEqual({ startMs: 196_400_000, endMs: 200_000_000 });
  slot.lifecycle.unmount();
  now.mockRestore();
});

test("bounds focus/pointer prefetch and exposes disconnected, stale, unsupported, empty, partial, and refresh-error states", async () => {
  const machines = Array.from({ length: 10 }, (_, index) => machine(
    { source: "enrolled-host", machineId: `machine-${String(index).padStart(2, "0")}` },
    `Machine ${index}`,
    index === 0 ? {
      connection: "disconnected", freshness: "stale", lastError: "Collector unavailable",
      warnings: [{ kind: "disconnected", message: "Machine is disconnected.", metricId: null }],
    } : {},
  ));
  const app = await loadPluginApp(() => import("../app.tsx"));
  const calls: string[] = [];
  const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, {
    rpc: fleetRpc(() => overview(machines), (request) => {
      calls.push(request.machine.machineId);
      if (request.machine.machineId === "machine-00") return timeline(request, { empty: true });
      if (request.machine.machineId === "machine-01") return timeline(request, { partial: true });
      if (request.machine.machineId === "machine-09") throw new Error("timeline RPC failed");
      return timeline(request);
    }),
  } as any);
  await slot.findByRole("heading", { name: "Machine 0" });
  expect(slot.getAllByText(/Machine is disconnected/).length).toBeGreaterThan(0);
  fireEvent.click(slot.getByText(/Full metric timeline and events/));
  expect(await slot.findByText("Coverage: no observations in this range.")).toBeTruthy();

  for (const button of slot.getAllByRole("button", { name: /Machine [0-9]+\./ })) fireEvent.focus(button);
  await waitFor(() => expect(calls.length).toBeLessThanOrEqual(1 + 6));

  fireEvent.click(slot.getByRole("button", { name: /Machine 1\. connected/ }));
  await slot.findByText("Coverage: partial; the timeline does not represent the complete requested range.");
  fireEvent.click(slot.getByRole("button", { name: /Machine 9\. connected/ }));
  expect((await slot.findByRole("alert")).textContent).toContain("timeline RPC failed");
  slot.lifecycle.unmount();
});

test("renders one generation-safe fleet utilization strip with a visible attention target and native-card-equivalent selection", async () => {
  const healthy = machine(alpha, "Alpha", {
    latestMetrics: [
      { metricId: "cpu.utilization.percent", value: 24, availability: { state: "available" as const, reason: null } },
      { metricId: "memory.used.bytes", value: 4, availability: { state: "available" as const, reason: null } },
      { metricId: "memory.total.bytes", value: 10, availability: { state: "available" as const, reason: null } },
      { metricId: "disk.root.used.bytes", value: 3, availability: { state: "available" as const, reason: null } },
      { metricId: "disk.root.total.bytes", value: 10, availability: { state: "available" as const, reason: null } },
    ],
  });
  const overTarget = machine(bravo, "Bravo", {
    latestMetrics: [
      { metricId: "cpu.utilization.percent", value: 92, availability: { state: "available" as const, reason: null } },
      { metricId: "memory.used.bytes", value: 4, availability: { state: "available" as const, reason: null } },
      { metricId: "memory.total.bytes", value: 10, availability: { state: "available" as const, reason: null } },
      { metricId: "disk.root.used.bytes", value: 3, availability: { state: "available" as const, reason: null } },
      { metricId: "disk.root.total.bytes", value: 10, availability: { state: "available" as const, reason: null } },
    ],
  });
  const stale = machine({ source: "enrolled-host" as const, machineId: "machine-charlie" }, "Charlie", {
    freshness: "stale" as const,
    latestMetrics: [
      { metricId: "cpu.utilization.percent", value: 5, availability: { state: "available" as const, reason: null } },
      { metricId: "memory.used.bytes", value: 1, availability: { state: "available" as const, reason: null } },
      { metricId: "memory.total.bytes", value: 10, availability: { state: "available" as const, reason: null } },
      { metricId: "disk.root.used.bytes", value: 1, availability: { state: "available" as const, reason: null } },
      { metricId: "disk.root.total.bytes", value: 10, availability: { state: "available" as const, reason: null } },
    ],
  });
  const app = await loadPluginApp(() => import("../app.tsx"));
  const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, {
    rpc: fleetRpc(() => overview([healthy, overTarget, stale]), (request) => timeline(request)),
  } as any);

  const chartHost = await slot.findByRole("img", { name: /Fleet utilization for 3 machines/i });
  await waitFor(() => expect(echartsMock.instances.some((chart) => chart.setOption.mock.calls.some(([option]) => (
    (option as { series?: Array<{ id?: string }> }).series?.some((series) => series.id === "machine-monitor:fleet-utilization:series:utilization")
  )))).toBe(true));
  const chart = echartsMock.instances.find((candidate) => candidate.setOption.mock.calls.some(([option]) => (
    (option as { series?: Array<{ id?: string }> }).series?.some((series) => series.id === "machine-monitor:fleet-utilization:series:utilization")
  )))!;
  const option = chart.setOption.mock.calls.at(-1)![0] as { series: Array<{ id: string; data: Array<{ value: number | null; machineKey: string }>; markLine?: { data: Array<{ yAxis: number }> } }> };
  const series = option.series.find((candidate) => candidate.id === "machine-monitor:fleet-utilization:series:utilization")!;
  // 99% memory PSI must not replace the ratio-based 40% memory utilization.
  expect(series.data.map((datum) => datum.value)).toEqual([40, 92, null]);
  expect(series.data.map((datum) => datum.machineKey)).toEqual(["enrolled-host:machine-alpha", "enrolled-host:machine-bravo", "enrolled-host:machine-charlie"]);
  expect(series.markLine?.data).toEqual([{ yAxis: 70 }]);
  expect(chartHost.getAttribute("aria-label")).toContain("Use the native source controls below");
  expect(slot.getAllByText("40.0%").length).toBeGreaterThan(0);
  expect(slot.getByText("22 pt · CPU")).toBeTruthy();
  expect(slot.getByText(/1 at ≥70%/)).toBeTruthy();
  expect(slot.getByRole("button", { name: /Charlie\. connected\. stale/i }).getAttribute("data-utilization")).toBe("below-attention");

  const chartCount = echartsMock.init.mock.calls.length;
  const click = chart.on.mock.calls.find(([name]) => name === "click")![1] as (event: unknown) => void;
  click({ componentType: "series", seriesId: series.id, dataIndex: 1, data: { machineKey: "enrolled-host:machine-bravo" } });
  await slot.findByRole("heading", { name: "Bravo" });
  expect(echartsMock.init).toHaveBeenCalledTimes(chartCount);
  slot.lifecycle.unmount();
});

test("uses the same native BB navigation for exact event list and chart-pointer activation", async () => {
  const app = await loadPluginApp(() => import("../app.tsx"));
  const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, {
    rpc: fleetRpc(() => overview(), (request) => timeline(request, { event: true })),
  } as any);
  await slot.findByRole("heading", { name: "Alpha" });
  await openDetailedTimeline(slot);
  const listAction = await slot.findByRole("button", { name: "Open linked thread for Repair thread" });
  fireEvent.click(listAction);
  expect(slot.inspection.navigateCalls).toContainEqual({ method: "toThread", threadId: "thr_events" });

  await waitFor(() => expect(echartsMock.instances.length).toBeGreaterThan(0));
  const chart = echartsMock.instances.at(-1)!;
  const option = chart.setOption.mock.calls.at(-1)![0] as { series: Array<{ id: string; data: Array<{ datumKey?: string }> }> };
  const events = option.series.find((series) => series.id === "machine-monitor:timeline:series:events")!;
  const click = chart.on.mock.calls.find(([name]) => name === "click")![1] as (event: unknown) => void;
  click({ componentType: "series", seriesId: events.id, data: { datumKey: events.data[0]!.datumKey } });
  expect(slot.inspection.navigateCalls.filter((call) => call.method === "toThread" && call.threadId === "thr_events")).toHaveLength(2);
  slot.lifecycle.unmount();
});

test("a nonselected summary reconciliation keeps the selected chart and exact event subtree stable", async () => {
  const initial = overview([machine(alpha, "Alpha"), machine(bravo, "Bravo")]);
  const reconciled = overview([
    initial.machines[0]!,
    machine(bravo, "Bravo current", { generation: { dataRevision: 2, settingsRevision: 1 } }),
  ], { dataRevision: 2, settingsRevision: 1 });
  let overviewCalls = 0;
  const app = await loadPluginApp(() => import("../app.tsx"));
  const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, {
    rpc: fleetRpc(() => {
      overviewCalls += 1;
      return overviewCalls === 1 ? initial : reconciled;
    }, (request) => timeline(request, { event: true })),
  } as any);
  await slot.findByRole("heading", { name: "Alpha" });
  await openDetailedTimeline(slot);
  const initialAction = await slot.findByRole("button", { name: "Open linked thread for Repair thread" });
  const initialHost = slot.getByRole("img", { name: /Machine timeline/ });
  const chart = echartsMock.instances.at(-1)!;
  const optionApplications = chart.setOption.mock.calls.length;

  void slot.behavior.emitRealtime("machine-monitor-fleet", { machine: bravo, dataRevision: 2, settingsRevision: 1, kinds: ["collection"] });
  await slot.findByRole("button", { name: /Bravo current\. connected/ });
  await Promise.resolve();

  expect(overviewCalls).toBe(2);
  expect(slot.getByRole("img", { name: /Machine timeline/ })).toBe(initialHost);
  expect(slot.getByRole("button", { name: "Open linked thread for Repair thread" })).toBe(initialAction);
  expect(chart.setOption.mock.calls).toHaveLength(optionApplications);
  slot.lifecycle.unmount();
});

test("coalesced A then B invalidations refresh selected A once and reconnect reconciliation remains current", async () => {
  const initial = overview([machine(alpha, "Alpha"), machine(bravo, "Bravo")]);
  const reconciled = {
    ...overview([
      machine(alpha, "Alpha current", { latestCollectedAtMs: 2_000, generation: { dataRevision: 2, settingsRevision: 1 } }),
      machine(bravo, "Bravo current", { warnings: [{ kind: "collector-error", message: "Recovered", metricId: null }], generation: { dataRevision: 2, settingsRevision: 1 } }),
    ], { dataRevision: 2, settingsRevision: 1 }),
    generatedAtMs: 2_000,
  };
  const pendingOverview = deferred<any>();
  const app = await loadPluginApp(() => import("../app.tsx"));
  const timelineRequests: any[] = [];
  let overviewCalls = 0;
  const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, {
    rpc: fleetRpc(() => {
      overviewCalls += 1;
      if (overviewCalls === 1) return initial;
      if (overviewCalls === 2) return pendingOverview.promise;
      return reconciled;
    }, (request) => {
      timelineRequests.push(request);
      return timeline(request);
    }),
  } as any);
  await slot.findByRole("heading", { name: "Alpha" });
  await waitFor(() => expect(timelineRequests).toHaveLength(1));

  void slot.behavior.emitRealtime("machine-monitor-fleet", { machine: bravo, dataRevision: 2, settingsRevision: 1, kinds: ["unrecognized"] });
  await Promise.resolve();
  expect(overviewCalls).toBe(1);
  void slot.behavior.emitRealtime("machine-monitor-fleet", { machine: alpha, dataRevision: 2, settingsRevision: 1, kinds: ["collection"] });
  void slot.behavior.emitRealtime("machine-monitor-fleet", { machine: bravo, dataRevision: 2, settingsRevision: 1, kinds: ["settings"] });
  await waitFor(() => expect(overviewCalls).toBe(2));
  pendingOverview.resolve(reconciled);
  await waitFor(() => expect(timelineRequests).toHaveLength(2));
  expect(timelineRequests[1]).toMatchObject({
    machine: alpha,
    generation: { dataRevision: 2, settingsRevision: 1 },
    range: { startMs: 0, endMs: 2_000 },
  });
  expect(slot.getByRole("button", { name: /Alpha current\. connected/ })).toBeTruthy();
  expect(slot.getByRole("button", { name: /Bravo current\. connected/ })).toBeTruthy();

  await slot.behavior.setRealtimeConnectionState("reconnecting");
  expect(slot.queryByText("Stale: showing a retained prior generation.")).toBeNull();
  expect(slot.getByRole("img", { name: /Operational history for machine-alpha\. Showing retained history/ }).parentElement?.getAttribute("data-stale")).toBe("true");
  await slot.behavior.setRealtimeConnectionState("connected");
  await waitFor(() => expect(overviewCalls).toBe(3));
  await waitFor(() => expect(timelineRequests).toHaveLength(3));
  expect(timelineRequests[2]).toMatchObject({ machine: alpha, generation: { dataRevision: 2, settingsRevision: 1 } });
  slot.lifecycle.unmount();
});
