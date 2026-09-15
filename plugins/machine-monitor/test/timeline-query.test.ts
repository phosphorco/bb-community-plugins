import assert from "node:assert/strict";
import test from "node:test";

import Database from "better-sqlite3";

import { FLEET_CONTRACT_VERSION, FLEET_METRIC_CATALOG, LOCAL_BB_SERVER_MACHINE_ID, MAX_FLEET_MACHINES, MAX_TIMELINE_GAPS, type FleetCollectionEnvelope, type FleetMachineIdentity, type FleetMetricId } from "../fleet-contract.ts";
import { FleetStore } from "../fleet-store.ts";
import { machineMonitorMigrations } from "../store.ts";
import { FLEET_FRESH_AFTER_MS, SqliteTimelineQuerySource, TimelineQueryService, timelineBucketWidthMs } from "../timeline-query.ts";

const host: FleetMachineIdentity = { source: "enrolled-host", machineId: "host-alpha" };

function makeStore(): { db: Database.Database; store: FleetStore } {
  const db = new Database(":memory:");
  for (const migration of machineMonitorMigrations) db.exec(migration);
  return { db, store: new FleetStore(db) };
}

function register(store: FleetStore, machine: FleetMachineIdentity, connection: "local" | "connected" | "disconnected" = machine.source === "local-bb-server" ? "local" : "connected"): void {
  store.registerMachine({
    machine,
    label: machine.source === "local-bb-server" ? "Local BB server" : machine.machineId,
    connection,
    capabilities: ["core-sample"],
    serverObservedAtMs: 100,
  });
}

function collection(sequence: number, normalizedAtMs: number, cpu: number, rawHostObservedAtMs = 9_000_000 + sequence): FleetCollectionEnvelope {
  return {
    contractVersion: FLEET_CONTRACT_VERSION,
    machine: host,
    collectorSessionId: "host-session",
    sequence,
    hostObservedAtMs: rawHostObservedAtMs,
    serverSentAtMs: normalizedAtMs - 5,
    serverReceivedAtMs: normalizedAtMs + 5,
    normalizedAtMs,
    clockUncertaintyMs: 5,
    metrics: [
      { metricId: "cpu.utilization.percent", value: cpu, availability: { state: "available", reason: null } },
      { metricId: "memory.pressure.some.percent", value: null, availability: { state: "unavailable", reason: "Not supported by this host." } },
    ],
  };
}

function memoryObservation(
  sequence: number,
  normalizedAtMs: number,
  values: Partial<{
    pressureSomePercent: number | null;
    pressureFullPercent: number | null;
    swapInPagesPerSecond: number | null;
    swapOutPagesPerSecond: number | null;
  }> = {},
) {
  return {
    collectorSessionId: "memory-session",
    sequence,
    hostObservedAtMs: 9_500_000 + sequence,
    serverSentAtMs: normalizedAtMs - 5,
    serverReceivedAtMs: normalizedAtMs + 5,
    normalizedAtMs,
    clockUncertaintyMs: 5,
    pressureSomePercent: values.pressureSomePercent === undefined ? 0 : values.pressureSomePercent,
    pressureFullPercent: values.pressureFullPercent === undefined ? 0 : values.pressureFullPercent,
    swapInPagesPerSecond: values.swapInPagesPerSecond === undefined ? 0 : values.swapInPagesPerSecond,
    swapOutPagesPerSecond: values.swapOutPagesPerSecond === undefined ? 0 : values.swapOutPagesPerSecond,
  };
}

function thresholdCollection(
  sequence: number,
  normalizedAtMs: number,
  cpu: number,
  memoryUsed: number | null,
  memoryTotal: number | null,
  diskUsed: number | null,
  diskTotal: number | null,
  machine: FleetMachineIdentity = host,
): FleetCollectionEnvelope {
  const observation = (metricId: FleetMetricId, value: number | null) => ({
    metricId,
    value,
    availability: value == null
      ? { state: "not-collected" as const, reason: "Not collected in this sample." }
      : { state: "available" as const, reason: null },
  });
  return {
    ...collection(sequence, normalizedAtMs, cpu),
    machine,
    metrics: [
      observation("cpu.utilization.percent", cpu),
      observation("memory.used.bytes", memoryUsed),
      observation("memory.total.bytes", memoryTotal),
      observation("disk.root.used.bytes", diskUsed),
      observation("disk.root.total.bytes", diskTotal),
    ],
  };
}

function event(eventId: string, startMs: number, endMs: number) {
  return {
    contractVersion: FLEET_CONTRACT_VERSION,
    producer: { id: "timeline-query-test", version: 1 },
    eventId,
    time: { kind: "interval" as const, startMs, endMs },
    category: "bb-job" as const,
    status: "running" as const,
    title: eventId,
    detail: null,
    provenance: { kind: "system" as const, component: "timeline-query-test" },
    bbReference: { projectId: "project_1", threadId: "thread_1" },
  };
}

function denyRawHistoryScans(store: FleetStore): FleetStore {
  const denied = new Set(["collections", "metricValues", "latestMetrics"]);
  return new Proxy(store, {
    get(target, property) {
      if (typeof property === "string" && denied.has(property)) {
        return () => { throw new Error(`raw FleetStore.${property} scan must not run`); };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as FleetStore;
}

test("builds deterministic range-start buckets, gaps, coverage, and raw-versus-normalized time summary", async (t) => {
  const { db, store } = makeStore();
  t.after(() => db.close());
  register(store, host);
  store.recordCollection(collection(0, 100, 10, 8_999_000));
  store.recordCollection(collection(1, 200, 30, 9_001_000));
  store.recordCollection(collection(2, 35_000, 50, 9_000_500));
  store.recordMachineError(host, { errorId: "collector-timeout", occurredAtMs: 45_000, kind: "timeout", message: "Timed out." });
  store.appendTimelineEvent(host, event("left-boundary", 0, 100));
  store.appendTimelineEvent(host, event("right-boundary", 60_100, 70_000));
  store.appendTimelineEvent(host, event("outside", 60_101, 70_000));

  const query = new TimelineQueryService(denyRawHistoryScans(store), new SqliteTimelineQuerySource(db), { now: () => 60_100 });
  const result = await query.machineTimeline({
    contractVersion: FLEET_CONTRACT_VERSION,
    machine: host,
    range: { startMs: 100, endMs: 60_100 },
    generation: null,
  });

  assert.deepEqual(result.bucket, { alignment: "range-start", widthMs: 30_000, count: 2 });
  const cpu = result.metrics.find((metric) => metric.metricId === "cpu.utilization.percent")!;
  assert.deepEqual(cpu.buckets, [
    { startMs: 100, endMs: 30_100, min: 10, average: 20, max: 30, last: 30, count: 2 },
    { startMs: 30_100, endMs: 60_100, min: 50, average: 50, max: 50, last: 50, count: 1 },
  ]);
  assert.equal(result.metrics.length, 11, "the complete declared metric catalog has an explicit series at the selected grain");
  assert.deepEqual(result.timeNormalization, {
    basis: "remote-server-request-midpoint",
    sampleCount: 3,
    rawHostObservedRange: { firstMs: 8_999_000, lastMs: 9_001_000 },
    normalizedRange: { firstMs: 100, lastMs: 35_000 },
    maxClockUncertaintyMs: 5,
  });
  assert.deepEqual(result.coverage, {
    state: "complete",
    firstObservedAtMs: 100,
    lastObservedAtMs: 35_000,
    retainedFromMs: 100,
    retainedToMs: 60_100,
  });
  assert.ok(result.gaps.some((gap) => gap.metricId === "memory.used.bytes" && gap.reason === "collector-error"));
  assert.deepEqual(result.events, {
    events: [event("left-boundary", 0, 100), event("right-boundary", 60_100, 70_000)],
    totalCount: 2,
    truncated: false,
  }, "overlap filtering retains exact interval endpoints and excludes only wholly non-overlapping events");
});

test("uses memory-only observations for normalized coverage and truthful bucket availability", async (t) => {
  const { db, store } = makeStore();
  t.after(() => db.close());
  register(store, host);
  store.recordMemoryObservation(host, memoryObservation(0, 100, {
    pressureSomePercent: 2,
    pressureFullPercent: 0,
    swapInPagesPerSecond: null,
    swapOutPagesPerSecond: 4,
  }));
  store.recordMemoryObservation(host, memoryObservation(1, 200, {
    pressureSomePercent: 6,
    pressureFullPercent: 2,
    swapInPagesPerSecond: null,
    swapOutPagesPerSecond: 8,
  }));
  const result = await new TimelineQueryService(denyRawHistoryScans(store), new SqliteTimelineQuerySource(db), { now: () => 30_100 }).machineTimeline({
    contractVersion: FLEET_CONTRACT_VERSION,
    machine: host,
    range: { startMs: 100, endMs: 30_100 },
    generation: null,
  });
  assert.deepEqual(result.coverage, {
    state: "complete",
    firstObservedAtMs: 100,
    lastObservedAtMs: 200,
    retainedFromMs: 100,
    retainedToMs: 30_100,
  }, "memory observations alone make the selected machine timeline non-empty");
  assert.deepEqual(result.timeNormalization, {
    basis: "remote-server-request-midpoint",
    sampleCount: 2,
    rawHostObservedRange: { firstMs: 9_500_000, lastMs: 9_500_001 },
    normalizedRange: { firstMs: 100, lastMs: 200 },
    maxClockUncertaintyMs: 5,
  }, "raw host skew remains visible beside server-midpoint timeline time");
  assert.deepEqual(result.metrics.find((metric) => metric.metricId === "memory.pressure.some.percent")?.buckets[0], {
    startMs: 100,
    endMs: 30_100,
    min: 2,
    average: 4,
    max: 6,
    last: 6,
    count: 2,
  });
  const swapIn = result.metrics.find((metric) => metric.metricId === "memory.swap.in.pages-per-second")!;
  assert.deepEqual(swapIn.buckets[0], {
    startMs: 100,
    endMs: 30_100,
    min: null,
    average: null,
    max: null,
    last: null,
    count: 0,
  }, "Linux/WSL warm-up nulls are never coerced to zero");
  assert.equal(swapIn.availability.state, "not-collected");
  assert.ok(result.gaps.some((gap) => gap.metricId === swapIn.metricId && gap.reason === "no-samples"),
    "a warm-up null reports missing data, not an unsupported capability");
});

test("memory observations replace Linux core placeholders without masking absent-platform availability", async (t) => {
  const { db, store } = makeStore();
  t.after(() => db.close());
  const darwin: FleetMachineIdentity = { source: "enrolled-host", machineId: "host-darwin" };
  register(store, host);
  register(store, darwin);
  const placeholder = (metricId: FleetMetricId) => ({
    metricId,
    value: null,
    availability: { state: "not-collected" as const, reason: "Collected by the Linux memory diagnostics lane." },
  });
  store.recordCollection({
    ...collection(0, 100, 42),
    metrics: [
      { metricId: "cpu.utilization.percent", value: 42, availability: { state: "available", reason: null } },
      placeholder("memory.pressure.some.percent"),
      placeholder("memory.pressure.full.percent"),
      placeholder("memory.swap.in.pages-per-second"),
      placeholder("memory.swap.out.pages-per-second"),
    ],
  });
  store.recordMemoryObservation(host, memoryObservation(0, 200, {
    pressureSomePercent: 1,
    pressureFullPercent: 2,
    swapInPagesPerSecond: 3,
    swapOutPagesPerSecond: 4,
  }));
  store.recordCollection({
    ...collection(0, 100, 1),
    machine: darwin,
    collectorSessionId: "darwin-session",
    metrics: [{
      metricId: "memory.pressure.some.percent",
      value: null,
      availability: { state: "unavailable", reason: "Linux/WSL memory-pressure capability is unavailable." },
    }],
  });
  const source = new SqliteTimelineQuerySource(db);
  const service = new TimelineQueryService(denyRawHistoryScans(store), source, { now: () => 200 });
  const overview = await service.fleetOverview();
  const linux = overview.machines.find((machine) => machine.machine.machineId === host.machineId)!;
  assert.deepEqual(
    linux.latestMetrics.filter((metric) => metric.metricId.startsWith("memory.") && metric.metricId !== "memory.used.bytes" && metric.metricId !== "memory.total.bytes")
      .map((metric) => [metric.metricId, metric.value]),
    [
      ["memory.pressure.some.percent", 1],
      ["memory.pressure.full.percent", 2],
      ["memory.swap.in.pages-per-second", 3],
      ["memory.swap.out.pages-per-second", 4],
    ],
    "the overview's latest values come from the dedicated memory lane, not core placeholders",
  );
  assert.equal(source.lastOverviewMetricRows, 6, "one bounded set query returns one replacement row for each visible memory metric");
  const linuxTimeline = await service.machineTimeline({
    contractVersion: FLEET_CONTRACT_VERSION,
    machine: host,
    range: { startMs: 100, endMs: 30_100 },
    generation: null,
  });
  assert.equal(linuxTimeline.metrics.find((metric) => metric.metricId === "memory.pressure.some.percent")?.buckets[0]?.count, 1,
    "the independent observation is not double-counted with its core placeholder");
  const darwinTimeline = await service.machineTimeline({
    contractVersion: FLEET_CONTRACT_VERSION,
    machine: darwin,
    range: { startMs: 100, endMs: 30_100 },
    generation: null,
  });
  const darwinPressure = darwinTimeline.metrics.find((metric) => metric.metricId === "memory.pressure.some.percent")!;
  assert.equal(darwinPressure.availability.state, "unavailable");
  assert.ok(darwinTimeline.gaps.some((gap) => gap.metricId === darwinPressure.metricId && gap.reason === "unavailable"),
    "Darwin's explicit unavailable capability is never converted into a memory-lane warm-up");
});

test("caps a detail response at 720 deterministic buckets and reports an empty machine honestly", async (t) => {
  const { db, store } = makeStore();
  t.after(() => db.close());
  register(store, host);
  const query = new TimelineQueryService(denyRawHistoryScans(store), new SqliteTimelineQuerySource(db), { now: () => 1 });
  const endMs = 720 * 30_000;
  assert.equal(timelineBucketWidthMs({ startMs: 0, endMs }), 30_000);
  const populated = await query.machineTimeline({
    contractVersion: FLEET_CONTRACT_VERSION,
    machine: host,
    range: { startMs: 0, endMs },
    generation: null,
  });
  assert.equal(populated.bucket.count, 720);
  assert.equal(populated.metrics[0]!.buckets.length, 720);
  assert.equal(populated.coverage.state, "empty");
  assert.ok(populated.gaps.every((gap) => gap.reason === "no-samples"), "a connected never-sampled machine does not overclaim retention");
  assert.deepEqual(populated.timeNormalization, {
    basis: "remote-server-request-midpoint",
    sampleCount: 0,
    rawHostObservedRange: { firstMs: null, lastMs: null },
    normalizedRange: { firstMs: null, lastMs: null },
    maxClockUncertaintyMs: null,
  });
});

test("keeps the ordered event lane independent from metrics with exact total and truncation", async (t) => {
  const { db, store } = makeStore();
  t.after(() => db.close());
  register(store, host);
  for (let index = 0; index < 201; index += 1) {
    store.appendTimelineEvent(host, event(`event-${String(index).padStart(3, "0")}`, 1_000 + index, 1_000 + index));
  }
  const result = await new TimelineQueryService(denyRawHistoryScans(store), new SqliteTimelineQuerySource(db), { now: () => 2_000 }).machineTimeline({
    contractVersion: FLEET_CONTRACT_VERSION,
    machine: host,
    range: { startMs: 1_000, endMs: 2_000 },
    generation: null,
  });
  assert.equal(result.events.totalCount, 201);
  assert.equal(result.events.events.length, 200);
  assert.equal(result.events.truncated, true);
  assert.deepEqual(result.events.events.slice(0, 2).map((entry) => entry.eventId), ["event-000", "event-001"]);
  assert.equal(result.events.events.at(-1)?.eventId, "event-199");
});

test("fleet overview is bounded to retained summaries and carries connection, freshness, capabilities, warnings, metrics, and generation", async (t) => {
  const { db, store } = makeStore();
  t.after(() => db.close());
  for (let index = 0; index < MAX_FLEET_MACHINES - 1; index += 1) {
    const machine = { source: "enrolled-host", machineId: `host-${String(index).padStart(3, "0")}` } as const;
    register(store, machine, index === 1 ? "disconnected" : "connected");
  }
  const currentHost = { source: "enrolled-host", machineId: "host-000" } as const;
  store.recordCollection({ ...collection(0, 100, 42), machine: currentHost });
  const source = new SqliteTimelineQuerySource(db);
  const query = new TimelineQueryService(denyRawHistoryScans(store), source, { now: () => 100 + FLEET_FRESH_AFTER_MS - 1 });
  const overview = await query.fleetOverview();
  assert.equal(overview.machines.length, MAX_FLEET_MACHINES);
  assert.equal(overview.machines.some((entry) => entry.machine.machineId === LOCAL_BB_SERVER_MACHINE_ID), true);
  const current = overview.machines.find((entry) => entry.machine.source === "enrolled-host" && entry.machine.machineId === "host-000")!;
  assert.equal(current.freshness, "fresh");
  assert.deepEqual(current.capabilities, ["core-sample"]);
  assert.equal(current.latestMetrics.find((metric) => metric.metricId === "cpu.utilization.percent")?.value, 42);
  const disconnected = overview.machines.find((entry) => entry.machine.source === "enrolled-host" && entry.machine.machineId === "host-001")!;
  assert.equal(disconnected.connection, "disconnected");
  assert.ok(disconnected.warnings.some((warning) => warning.kind === "disconnected"));
  assert.equal(JSON.stringify(overview).includes("buckets"), false, "overview never contains all machine histories");
  assert.equal(source.lastOverviewMetricRows, 2, "one set query returns only current metric rows, not every machine history");
});

test("overview selects only exact latest collections through indexed candidate lookups", async (t) => {
  const { db, store } = makeStore();
  t.after(() => db.close());
  const machines = ["host-history-a", "host-history-b", "host-history-c"].map((machineId) => ({ source: "enrolled-host" as const, machineId }));
  for (const [machineIndex, machine] of machines.entries()) {
    register(store, machine);
    for (let sequence = 0; sequence < 96; sequence += 1) {
      store.recordCollection({ ...collection(sequence, 1_000 + sequence * 30_000, sequence), machine });
    }
    store.recordCollection({ ...collection(96, 3_000_000, 10_000 + machineIndex), machine });
  }
  const source = new SqliteTimelineQuerySource(db);
  const overview = await new TimelineQueryService(denyRawHistoryScans(store), source, { now: () => 3_000_000 }).fleetOverview();
  for (const [machineIndex, machine] of machines.entries()) {
    const summary = overview.machines.find((entry) => entry.machine.source === machine.source && entry.machine.machineId === machine.machineId)!;
    assert.equal(summary.latestMetrics.find((metric) => metric.metricId === "cpu.utilization.percent")?.value, 10_000 + machineIndex);
  }
  assert.equal(source.lastOverviewMetricRows, machines.length * 2, "only the metric rows from one latest collection per machine are candidates");
  const queryPlan = source.overviewQueryPlan;
  const collectionTimeLookups = queryPlan.filter((detail) => detail.includes("machine_monitor_fleet_collections_machine_time"));
  assert.ok(collectionTimeLookups.length >= 2, "the per-machine latest candidate and its five-minute CPU range both use the collection-time index");
  assert.equal(queryPlan.some((detail) => /SCAN .*machine_monitor_fleet_metric_values/i.test(detail)), false, "the overview never ranks or scans retained metric history");
});

test("overview reads are not generation-cached across the freshness threshold", async (t) => {
  const { db, store } = makeStore();
  t.after(() => db.close());
  register(store, host);
  store.recordCollection(collection(0, 100, 42));
  let now = 100 + FLEET_FRESH_AFTER_MS - 1;
  const query = new TimelineQueryService(denyRawHistoryScans(store), new SqliteTimelineQuerySource(db), { now: () => now });
  const fresh = await query.fleetOverview();
  now = 100 + FLEET_FRESH_AFTER_MS + 1;
  const stale = await query.fleetOverview();
  const freshHost = fresh.machines.find((entry) => entry.machine.source === "enrolled-host" && entry.machine.machineId === host.machineId)!;
  const staleHost = stale.machines.find((entry) => entry.machine.source === "enrolled-host" && entry.machine.machineId === host.machineId)!;
  assert.deepEqual(fresh.generation, stale.generation, "no data/settings generation changed");
  assert.equal(fresh.generatedAtMs, 100 + FLEET_FRESH_AFTER_MS - 1);
  assert.equal(stale.generatedAtMs, 100 + FLEET_FRESH_AFTER_MS + 1);
  assert.equal(freshHost.freshness, "fresh");
  assert.equal(staleHost.freshness, "stale");
});

test("fleet overview emits isolated threshold warnings from smoothed CPU and current capacity ratios", async (t) => {
  const { db, store } = makeStore();
  t.after(() => db.close());
  const alpha = { source: "enrolled-host" as const, machineId: "host-threshold-alpha" };
  const beta = { source: "enrolled-host" as const, machineId: "host-threshold-beta" };
  register(store, alpha);
  register(store, beta);
  store.recordCollection(thresholdCollection(0, 1_000, 10, 900, 1_000, 950, 1_000, alpha));
  store.recordCollection(thresholdCollection(1, 61_000, 10, 900, 1_000, 950, 1_000, alpha));
  store.recordCollection(thresholdCollection(2, 121_000, 100, 900, 1_000, 950, 1_000, alpha));
  store.recordCollection(thresholdCollection(0, 121_000, 20, 100, 1_000, 100, 1_000, beta));
  const query = new TimelineQueryService(denyRawHistoryScans(store), new SqliteTimelineQuerySource(db), {
    now: () => 301_000,
    warningThresholds: async () => ({ cpu: 70, ram: 80, disk: 90 }),
  });

  const burst = await query.fleetOverview();
  const burstAlpha = burst.machines.find((entry) => entry.machine.machineId === alpha.machineId)!;
  assert.deepEqual(
    burstAlpha.warnings.filter((warning) => warning.kind === "metric-threshold").map((warning) => warning.metricId),
    ["memory.used.bytes", "disk.root.used.bytes"],
    "one 100% CPU burst is smoothed below the 70% five-minute threshold",
  );
  const burstBeta = burst.machines.find((entry) => entry.machine.machineId === beta.machineId)!;
  assert.equal(burstBeta.warnings.some((warning) => warning.kind === "metric-threshold"), false, "one machine's threshold state never bleeds into another summary");

  store.recordCollection(thresholdCollection(3, 181_000, 100, 900, 1_000, 950, 1_000, alpha));
  store.recordCollection(thresholdCollection(4, 241_000, 100, 900, 1_000, 950, 1_000, alpha));
  store.recordCollection(thresholdCollection(5, 301_000, 100, 900, 1_000, 950, 1_000, alpha));
  const crossed = await query.fleetOverview();
  const crossedAlpha = crossed.machines.find((entry) => entry.machine.machineId === alpha.machineId)!;
  assert.deepEqual(
    crossedAlpha.warnings.filter((warning) => warning.kind === "metric-threshold"),
    [
      { kind: "metric-threshold", metricId: "cpu.utilization.percent", message: "CPU 5m average 70% (threshold 70%)" },
      { kind: "metric-threshold", metricId: "memory.used.bytes", message: "RAM 90% (threshold 80%)" },
      { kind: "metric-threshold", metricId: "disk.root.used.bytes", message: "Root disk 95% (threshold 90%)" },
    ],
  );
});

test("fleet overview defaults threshold warnings off and requires current available ratio totals", async (t) => {
  const { db, store } = makeStore();
  t.after(() => db.close());
  register(store, host);
  store.recordCollection(thresholdCollection(0, 1_000, 100, 900, null, 950, 0));
  const source = new SqliteTimelineQuerySource(db);
  const defaultWarnings = await new TimelineQueryService(denyRawHistoryScans(store), source, { now: () => 1_000 }).fleetOverview();
  const defaultHost = defaultWarnings.machines.find((entry) => entry.machine.machineId === host.machineId)!;
  assert.equal(defaultHost.warnings.some((warning) => warning.kind === "metric-threshold"), false, "the service has no metric thresholds until server settings are wired in");

  const configuredWarnings = await new TimelineQueryService(denyRawHistoryScans(store), source, {
    now: () => 1_000,
    warningThresholds: () => ({ cpu: 90, ram: 80, disk: 80 }),
  }).fleetOverview();
  const configuredHost = configuredWarnings.machines.find((entry) => entry.machine.machineId === host.machineId)!;
  assert.deepEqual(
    configuredHost.warnings.filter((warning) => warning.kind === "metric-threshold").map((warning) => warning.metricId),
    ["cpu.utilization.percent"],
    "unavailable memory totals and zero disk totals cannot create ratio warnings",
  );
});

test("fleet overview rebuilds after deferred settings while a collection advances the durable generation", async (t) => {
  const { db, store } = makeStore();
  t.after(() => db.close());
  register(store, host);
  store.recordCollection(thresholdCollection(0, 100, 10, 100, 1_000, 100, 1_000));

  let thresholdCalls = 0;
  let releaseThresholds!: () => void;
  const thresholdsDeferred = new Promise<void>((resolve) => { releaseThresholds = resolve; });
  let thresholdsStarted!: () => void;
  const thresholdsStartedPromise = new Promise<void>((resolve) => { thresholdsStarted = resolve; });
  let thresholds = { cpu: 90, ram: 90, disk: 90 };
  const query = new TimelineQueryService(denyRawHistoryScans(store), new SqliteTimelineQuerySource(db), {
    now: () => 200,
    warningThresholds: async () => {
      thresholdCalls += 1;
      if (thresholdCalls === 1) {
        thresholdsStarted();
        await thresholdsDeferred;
      }
      return thresholds;
    },
  });

  const pendingOverview = query.fleetOverview();
  await thresholdsStartedPromise;
  store.recordCollection(thresholdCollection(1, 200, 100, 900, 1_000, 950, 1_000));
  thresholds = { cpu: 50, ram: 80, disk: 80 };
  releaseThresholds();
  const result = await pendingOverview;

  assert.equal(thresholdCalls, 2, "the generation change discards the partially read overview and re-reads settings");
  assert.deepEqual(result.generation, store.fleetGeneration());
  const summary = result.machines.find((entry) => entry.machine.machineId === host.machineId)!;
  assert.equal(summary.generation.dataRevision, result.generation.dataRevision);
  assert.equal(summary.latestCollectedAtMs, 200);
  assert.equal(summary.latestMetrics.find((metric) => metric.metricId === "cpu.utilization.percent")?.value, 100,
    "the newer machine revision never carries the older metric snapshot");
  assert.deepEqual(
    summary.warnings.filter((warning) => warning.kind === "metric-threshold"),
    [
      { kind: "metric-threshold", metricId: "cpu.utilization.percent", message: "CPU 5m average 55% (threshold 50%)" },
      { kind: "metric-threshold", metricId: "memory.used.bytes", message: "RAM 90% (threshold 80%)" },
      { kind: "metric-threshold", metricId: "disk.root.used.bytes", message: "Root disk 95% (threshold 80%)" },
    ],
    "threshold warnings are derived from the rebuilt metric snapshot and the re-read settings",
  );
});

test("a stale machine's formerly high CPU cannot survive outside the current five-minute warning window", async (t) => {
  const { db, store } = makeStore();
  t.after(() => db.close());
  register(store, host);
  store.recordCollection(thresholdCollection(0, 1_000, 100, 100, 1_000, 100, 1_000));
  const now = 1_000 + 5 * 60_000 + 1;
  const overview = await new TimelineQueryService(denyRawHistoryScans(store), new SqliteTimelineQuerySource(db), {
    now: () => now,
    warningThresholds: () => ({ cpu: 90, ram: 90, disk: 90 }),
  }).fleetOverview();
  const summary = overview.machines.find((entry) => entry.machine.machineId === host.machineId)!;
  assert.equal(overview.generatedAtMs, now);
  assert.equal(summary.freshness, "stale");
  assert.equal(summary.warnings.some((warning) => warning.kind === "metric-threshold" && warning.metricId === "cpu.utilization.percent"), false);
});

test("returns bounded SQL rows for a dense source population rather than hydrating raw samples", async (t) => {
  const { db, store } = makeStore();
  t.after(() => db.close());
  register(store, host);
  const range = { startMs: 1_000, endMs: 1_000 + 720 * 30_000 };
  let sequence = 0;
  for (let bucket = 0; bucket < 720; bucket += 1) {
    for (let point = 0; point < 5; point += 1) {
      const atMs = range.startMs + bucket * 30_000 + point * 5_000;
      store.recordCollection(collection(sequence, atMs, sequence % 100));
      sequence += 1;
    }
  }
  const source = new SqliteTimelineQuerySource(db);
  const result = await new TimelineQueryService(denyRawHistoryScans(store), source, { now: () => range.endMs }).machineTimeline({
    contractVersion: FLEET_CONTRACT_VERSION,
    machine: host,
    range,
    generation: null,
  });
  assert.equal(result.bucket.count, 720);
  assert.equal(result.metrics.find((metric) => metric.metricId === "cpu.utilization.percent")?.buckets.length, 720);
  assert.equal(source.lastTimelineRead.normalizationRows, 1);
  assert.ok(source.lastTimelineRead.metricBucketRows <= 11 * 720);
  assert.ok(source.lastTimelineRead.metricBucketRows < sequence, "rows returned to JS are bucket/cardinality bounded, not raw-sample bounded");
  assert.ok(source.lastTimelineRead.errorBucketRows <= 720);
});

test("returns every coalesced gap above the former 512 limit without claiming retention", async (t) => {
  const { db, store } = makeStore();
  t.after(() => db.close());
  register(store, host);
  const range = { startMs: 1_000, endMs: 1_000 + 720 * 30_000 };
  for (let bucket = 0; bucket < 720; bucket += 1) {
    const atMs = range.startMs + bucket * 30_000 + 1_000;
    const metrics = bucket % 2 === 0
      ? [{ metricId: "cpu.utilization.percent" as const, value: bucket, availability: { state: "available" as const, reason: null } }]
      : [{ metricId: "memory.used.bytes" as const, value: bucket, availability: { state: "available" as const, reason: null } }];
    store.recordCollection({ ...collection(bucket, atMs, bucket), metrics });
  }
  const result = await new TimelineQueryService(denyRawHistoryScans(store), new SqliteTimelineQuerySource(db), { now: () => range.endMs }).machineTimeline({
    contractVersion: FLEET_CONTRACT_VERSION,
    machine: host,
    range,
    generation: null,
  });
  const expectedGaps = 2 * 360 + (FLEET_METRIC_CATALOG.length - 2);
  assert.equal(result.gaps.length, expectedGaps);
  assert.ok(result.gaps.length > 512);
  assert.ok(result.gaps.length <= MAX_TIMELINE_GAPS);
  assert.ok(result.gaps.every((gap) => gap.reason === "no-samples"));
});
