import { FLEET_CONTRACT_VERSION } from "../../fleet-contract.ts";

/**
 * Deliberately test-only fleet data. It is served by the browser harness's
 * local RPC seam; it is never accepted from, or produced by, a machine host.
 */
export const FLEET_PERFORMANCE_FIXTURE_VERSION = "fleet-performance-fixture-v1";
export const FLEET_PERFORMANCE_MACHINE_COUNT = 32;
export const FLEET_PERFORMANCE_BUCKETS_PER_TRACK = 720;
export const FLEET_PERFORMANCE_SELECTED_EVENT_COUNT = 500;
export const FLEET_PERFORMANCE_SELECTED_MACHINE_ID = "latency-machine-00";
export const FLEET_PERFORMANCE_CORE_TRACKS = [
  "cpu.utilization.percent",
  "load.1",
  "load.5",
] as const;
export const FLEET_PERFORMANCE_START_MS = 1_700_000_000_000;
export const FLEET_PERFORMANCE_END_MS = FLEET_PERFORMANCE_START_MS + 24 * 60 * 60_000;

export type FleetPerformanceRange = Readonly<{ startMs: number; endMs: number }>;
export type FleetPerformanceGeneration = Readonly<{ dataRevision: number; settingsRevision: number }>;
export type FleetPerformanceMachine = Readonly<{
  machine: Readonly<{ source: "enrolled-host"; machineId: string }>;
  label: string;
  connection: "connected";
  freshness: "fresh";
  latestCollectedAtMs: number;
  lastError: null;
  capabilities: readonly ["core-sample"];
  latestMetrics: readonly unknown[];
  warnings: readonly unknown[];
  generation: FleetPerformanceGeneration;
}>;

type MutableFixture = {
  machines: FleetPerformanceMachine[];
  generations: Map<string, FleetPerformanceGeneration>;
};

function machineId(index: number): string {
  return `latency-machine-${String(index).padStart(2, "0")}`;
}

function generationFor(index: number, dataRevision = 1): FleetPerformanceGeneration {
  return { dataRevision, settingsRevision: 1 + (index % 2) };
}

function latestMetrics(index: number): readonly unknown[] {
  return [
    { metricId: "cpu.utilization.percent", value: 30 + (index % 40), availability: { state: "available", reason: null } },
    { metricId: "load.1", value: 1 + (index % 9) / 10, availability: { state: "available", reason: null } },
    { metricId: "load.5", value: 1.5 + (index % 7) / 10, availability: { state: "available", reason: null } },
  ];
}

function newFixture(): MutableFixture {
  const machines: FleetPerformanceMachine[] = [];
  const generations = new Map<string, FleetPerformanceGeneration>();
  for (let index = 0; index < FLEET_PERFORMANCE_MACHINE_COUNT; index += 1) {
    const machine = { source: "enrolled-host" as const, machineId: machineId(index) };
    const generation = generationFor(index);
    generations.set(machine.machineId, generation);
    machines.push({
      machine,
      label: `Latency machine ${String(index).padStart(2, "0")}`,
      connection: "connected",
      freshness: "fresh",
      latestCollectedAtMs: FLEET_PERFORMANCE_END_MS - index * 1_000,
      lastError: null,
      capabilities: ["core-sample"],
      latestMetrics: latestMetrics(index),
      warnings: [],
      generation,
    });
  }
  return { machines, generations };
}

function trackValue(track: (typeof FLEET_PERFORMANCE_CORE_TRACKS)[number], machineIndex: number, bucketIndex: number): number {
  const phase = (machineIndex * 37 + bucketIndex * 11) % 100;
  if (track === "cpu.utilization.percent") return 15 + phase * 0.7;
  if (track === "load.1") return 0.4 + phase / 22;
  return 0.7 + phase / 19;
}

function timelineEvents(machine: FleetPerformanceMachine, range: FleetPerformanceRange): readonly unknown[] {
  if (machine.machine.machineId !== FLEET_PERFORMANCE_SELECTED_MACHINE_ID) return [];
  const duration = range.endMs - range.startMs;
  return Array.from({ length: FLEET_PERFORMANCE_SELECTED_EVENT_COUNT }, (_, index) => ({
    contractVersion: FLEET_CONTRACT_VERSION,
    producer: { id: "latency-proof-fixture", version: 1 },
    eventId: `fixture-event-${String(index).padStart(3, "0")}`,
    time: { kind: "instant" as const, atMs: range.startMs + Math.floor((duration * index) / FLEET_PERFORMANCE_SELECTED_EVENT_COUNT) },
    category: "bb-job" as const,
    status: index % 11 === 0 ? "warning" as const : "succeeded" as const,
    title: `Fixture event ${String(index).padStart(3, "0")}`,
    detail: "Deterministic latency-proof event; not emitted by a production event producer.",
    provenance: { kind: "bb-background-job" as const, jobId: `fixture-job-${index}`, attempt: 0 },
    bbReference: null,
  }));
}

function timeline(machine: FleetPerformanceMachine, range: FleetPerformanceRange, generation: FleetPerformanceGeneration): Record<string, unknown> {
  const widthMs = Math.floor((range.endMs - range.startMs) / FLEET_PERFORMANCE_BUCKETS_PER_TRACK);
  const index = Number(machine.machine.machineId.slice(-2));
  const metrics = FLEET_PERFORMANCE_CORE_TRACKS.map((metricId) => ({
    metricId,
    availability: { state: "available" as const, reason: null },
    buckets: Array.from({ length: FLEET_PERFORMANCE_BUCKETS_PER_TRACK }, (_, bucketIndex) => {
      const average = trackValue(metricId, index, bucketIndex);
      const startMs = range.startMs + bucketIndex * widthMs;
      return {
        startMs,
        endMs: startMs + widthMs,
        min: average - 0.25,
        average,
        max: average + 0.25,
        last: average + 0.1,
        count: 1,
      };
    }),
  }));
  const events = timelineEvents(machine, range);
  return {
    contractVersion: FLEET_CONTRACT_VERSION,
    machine: machine.machine,
    generation,
    range,
    bucket: { alignment: "range-start", widthMs, count: FLEET_PERFORMANCE_BUCKETS_PER_TRACK },
    coverage: {
      state: "complete",
      firstObservedAtMs: range.startMs,
      lastObservedAtMs: range.endMs,
      retainedFromMs: range.startMs,
      retainedToMs: range.endMs,
    },
    timeNormalization: {
      basis: "remote-server-request-midpoint",
      sampleCount: FLEET_PERFORMANCE_BUCKETS_PER_TRACK,
      rawHostObservedRange: { firstMs: range.startMs, lastMs: range.endMs },
      normalizedRange: { firstMs: range.startMs, lastMs: range.endMs },
      maxClockUncertaintyMs: 0,
    },
    metrics,
    gaps: [],
    // This test-only browser witness intentionally exceeds the persisted API's
    // 200-event serving cap to stress the client rendering path with 500 exact
    // events. It never crosses the production schema or a real producer.
    events: { events, totalCount: events.length, truncated: false },
  };
}

function attachmentSnapshot() {
  return {
    sourceRevision: 0,
    targets: [],
    status: {
      state: "synced" as const,
      sourceRevision: 0,
      desiredRevision: 0,
      lastAckedRevision: 0,
      pending: false,
      inFlight: false,
      attempts: 0,
      nextAttemptAt: null,
      lastError: null,
      errorKind: null,
    },
  };
}

function fingerprint(value: unknown): string {
  const text = JSON.stringify(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, "0")}:${text.length}`;
}

export type FleetPerformanceFixture = ReturnType<typeof createFleetPerformanceFixture>;

export function createFleetPerformanceFixture() {
  const state = newFixture();
  const range = { startMs: FLEET_PERFORMANCE_START_MS, endMs: FLEET_PERFORMANCE_END_MS };
  const overview = () => ({
    contractVersion: FLEET_CONTRACT_VERSION,
    generatedAtMs: FLEET_PERFORMANCE_END_MS,
    generation: { dataRevision: 1, settingsRevision: 1 },
    machines: state.machines.map((machine) => ({ ...machine, generation: state.generations.get(machine.machine.machineId)! })),
    attachments: { scope: "fleet" as const, snapshot: attachmentSnapshot() },
  });
  const machine = (machineIdValue: string): FleetPerformanceMachine => {
    const result = state.machines.find((value) => value.machine.machineId === machineIdValue);
    if (result == null) throw new Error(`Unknown latency fixture machine ${machineIdValue}.`);
    return { ...result, generation: state.generations.get(machineIdValue)! };
  };
  const timelineFor = (machineIdValue: string, requestedRange = range, requestedGeneration?: FleetPerformanceGeneration) => {
    const selected = machine(machineIdValue);
    const current = state.generations.get(machineIdValue)!;
    if (requestedGeneration != null && (requestedGeneration.dataRevision !== current.dataRevision
      || requestedGeneration.settingsRevision !== current.settingsRevision)) {
      throw new Error(`Latency fixture rejected stale generation for ${machineIdValue}.`);
    }
    return timeline(selected, requestedRange, current);
  };
  const revise = (machineIdValue: string): FleetPerformanceGeneration => {
    const previous = state.generations.get(machineIdValue);
    if (previous == null) throw new Error(`Unknown latency fixture machine ${machineIdValue}.`);
    const next = { ...previous, dataRevision: previous.dataRevision + 1 };
    state.generations.set(machineIdValue, next);
    return next;
  };
  const fixtureFingerprint = fingerprint({
    version: FLEET_PERFORMANCE_FIXTURE_VERSION,
    range,
    overview: overview(),
    timelines: state.machines.map((value) => timelineFor(value.machine.machineId)),
  });
  return {
    version: FLEET_PERFORMANCE_FIXTURE_VERSION,
    fixtureFingerprint,
    range,
    machines: () => state.machines.map((value) => machine(value.machine.machineId)),
    overview,
    timelineFor,
    revise,
  };
}

/** Updated only with an intentional fixture change and its review. */
export const FLEET_PERFORMANCE_FIXTURE_FINGERPRINT = "fnv1a32:679b2fa2:10344868";

export function assertFleetPerformanceFixture(fixture: FleetPerformanceFixture): void {
  if (fixture.version !== FLEET_PERFORMANCE_FIXTURE_VERSION) throw new Error("Latency fixture version changed.");
  if (fixture.machines().length !== FLEET_PERFORMANCE_MACHINE_COUNT) throw new Error("Latency fixture machine count changed.");
  for (const machine of fixture.machines()) {
    const result = fixture.timelineFor(machine.machine.machineId);
    const metrics = result.metrics as Array<{ metricId: string; buckets: unknown[] }>;
    if (metrics.length !== FLEET_PERFORMANCE_CORE_TRACKS.length
      || metrics.some((metric, index) => metric.metricId !== FLEET_PERFORMANCE_CORE_TRACKS[index]
        || metric.buckets.length !== FLEET_PERFORMANCE_BUCKETS_PER_TRACK)) {
      throw new Error(`Latency fixture core-track bucket shape changed for ${machine.machine.machineId}.`);
    }
  }
  const selected = fixture.timelineFor(FLEET_PERFORMANCE_SELECTED_MACHINE_ID);
  if ((selected.events as { events: unknown[] }).events.length !== FLEET_PERFORMANCE_SELECTED_EVENT_COUNT) {
    throw new Error("Latency fixture selected event count changed.");
  }
  if (fixture.fixtureFingerprint !== FLEET_PERFORMANCE_FIXTURE_FINGERPRINT) {
    throw new Error(`Latency fixture fingerprint mismatch: expected ${FLEET_PERFORMANCE_FIXTURE_FINGERPRINT}, received ${fixture.fixtureFingerprint}.`);
  }
}
