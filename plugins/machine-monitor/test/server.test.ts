import assert from "node:assert/strict";
import test from "node:test";

import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import Database from "better-sqlite3";

import {
  FLEET_CONTRACT_VERSION,
  LOCAL_BB_SERVER_MACHINE_ID,
  type FleetOverviewResult,
  type MachineTimelineResult,
} from "../fleet-contract.ts";
import plugin, { createLegacyLocalProjection } from "../server.ts";
import { FleetStore } from "../fleet-store.ts";
import { MachineMonitorStore, machineMonitorMigrations } from "../store.ts";

const LOCAL_MACHINE = { source: "local-bb-server" as const, machineId: LOCAL_BB_SERVER_MACHINE_ID as "local-bb-server" };

function localCollections(host: ReturnType<typeof createFakePluginHost>) {
  const store = new FleetStore(host.bb.storage.database());
  return store.collections(LOCAL_MACHINE, 0, Number.MAX_SAFE_INTEGER);
}

function hostPayload(method: string, input: unknown): unknown {
  if (method === "describe") {
    return {
      contractVersion: FLEET_CONTRACT_VERSION,
      collectorSessionId: "remote-session",
      observedAtMs: 1_000,
      hostName: "remote-linux",
      platform: "linux",
      platformDetail: "Linux",
      capabilities: ["core-sampling", "directory-sampling", "memory-diagnostics", "linux-memory-pressure"],
    };
  }
  if (method === "coreSample") {
    return {
      contractVersion: FLEET_CONTRACT_VERSION,
      collectorSessionId: "remote-session",
      sequence: 0,
      hostObservedAtMs: 9_000_000,
      metrics: [{ metricId: "cpu.utilization.percent", value: 11, availability: { state: "available", reason: null } }],
    };
  }
  if (method === "directorySample") {
    const directoryId = typeof input === "object" && input != null && typeof Reflect.get(input, "directoryId") === "string"
      ? Reflect.get(input, "directoryId") as string
      : "unknown";
    return {
      contractVersion: FLEET_CONTRACT_VERSION,
      collectorSessionId: "remote-session",
      sequence: 0,
      observedAtMs: 9_000_000,
      directoryId,
      bytes: 1,
      onRootFilesystem: true,
      partial: false,
      availability: "available",
      reason: null,
    };
  }
  if (method === "memoryDiagnostics") {
    return {
      contractVersion: FLEET_CONTRACT_VERSION,
      collectorSessionId: "remote-session",
      sequence: 0,
      observedAtMs: 9_000_000,
      processDetailsCollectedAtMs: null,
      sampleIntervalMs: null,
      pressureSomePercent: 0,
      pressureFullPercent: 0,
      swapInPagesPerSecond: 0,
      swapOutPagesPerSecond: 0,
      refaultPagesPerSecond: 0,
      reclaimPagesPerSecond: 0,
      bbCgroupMemoryBytes: 0,
      processes: [],
    };
  }
  throw new Error(`Unexpected host method ${method}`);
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail("timed out waiting for fleet collection");
}

function enrolledHost(id: string, name: string) {
  return {
    createdAt: 0,
    id,
    lastRejectedProtocolVersion: null,
    lastSeenAt: null,
    maxPermissionMode: "full" as const,
    name,
    status: "connected" as const,
    type: "persistent" as const,
    updatedAt: 0,
  };
}

test("server runs one fleet service, targets authenticated enrolled hosts, and preserves attachment RPCs", async (t) => {
  const host = createFakePluginHost({
    pluginId: "machine-monitor",
    settings: { showProcessDetails: true },
    sdk: {
      subscribe: () => () => {},
      hosts: {
        list: async () => [enrolledHost("remote-auth", "Remote authenticated")],
      },
    },
    experimental_callHostRpc: ({ method, input }) => hostPayload(method, input),
  });
  t.after(async () => host.harness.dispose());
  await plugin(host.bb);

  const service = host.harness.runService("machine-monitor-fleet");
  try {
    await waitFor(() => host.harness.experimental_hostRpcCalls.some((call) => call.method === "coreSample"));
    await waitFor(() => host.harness.experimental_hostRpcCalls.some((call) => call.method === "memoryDiagnostics"));
    const calls = host.harness.experimental_hostRpcCalls;
    assert.ok(calls.some((call) => call.method === "coreSample" && call.hostId === "remote-auth"));
    assert.ok(calls.every((call) => call.hostId === "remote-auth"), "all remote collection calls use the SDK-selected host ID");
    const firstMemory = calls.find((call) => call.method === "memoryDiagnostics");
    assert.deepEqual(firstMemory?.input, { includeProcessDetails: true }, "the initial collection awaits the saved process-detail setting");
    assert.deepEqual(await host.harness.callRpc("getAttachments", null), {
      sourceRevision: 0,
      targets: [],
      status: {
        state: "synced",
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
    });

    // Stop collection before exercising the read paths. A fleet overview and
    // a switch between two machine timelines must use only committed SQLite
    // state, never prompt an enrolled daemon.
    service.controller.abort();
    await service.done;
    const callsBeforeFleetReads = host.harness.experimental_hostRpcCalls.length;
    const overview = await host.harness.callRpc("fleetOverview", {
      contractVersion: FLEET_CONTRACT_VERSION,
    }) as FleetOverviewResult;
    const remote = overview.machines.find((machine) => machine.machine.source === "enrolled-host");
    const local = overview.machines.find((machine) => machine.machine.source === "local-bb-server");
    assert.ok(remote, "overview includes the authenticated enrolled machine");
    assert.ok(local, "overview includes the BB-server machine");
    const endMs = Date.now();
    const range = { startMs: endMs - 60 * 60_000, endMs };
    const remoteTimeline = await host.harness.callRpc("machineTimeline", {
      contractVersion: FLEET_CONTRACT_VERSION,
      machine: remote.machine,
      range,
      generation: remote.generation,
    }) as MachineTimelineResult;
    const localTimeline = await host.harness.callRpc("machineTimeline", {
      contractVersion: FLEET_CONTRACT_VERSION,
      machine: local.machine,
      range,
      generation: local.generation,
    }) as MachineTimelineResult;
    assert.deepEqual(remoteTimeline.generation, remote.generation, "remote detail returns the committed generation");
    assert.deepEqual(localTimeline.generation, local.generation, "machine switches preserve each committed generation");
    assert.equal(
      host.harness.experimental_hostRpcCalls.length,
      callsBeforeFleetReads,
      "fleet reads and machine switches do not synchronously call a daemon",
    );

    const fleetSignals = host.harness.realtimeSignals.filter((signal) => signal.channel === "machine-monitor-fleet");
    assert.ok(fleetSignals.length > 0, "committed fleet changes publish a bounded invalidation");
    for (const signal of fleetSignals) {
      assert.deepEqual(
        Object.keys(signal.payload as object).sort(),
        ["dataRevision", "kinds", "machine", "settingsRevision"],
        "fleet realtime carries identity, generation, and changed-kind metadata only",
      );
    }
  } finally {
    service.controller.abort();
    await service.done;
  }
});

test("legacy local projections write before their established realtime signals and retain core-error refresh", (t) => {
  const db = new Database(":memory:");
  for (const migration of machineMonitorMigrations) db.exec(migration);
  t.after(() => db.close());
  const store = new MachineMonitorStore(db);
  let lastError: string | null = null;
  const signals: Array<{ channel: string; payload: Record<string, boolean | number>; visibleAt: number | null }> = [];
  const projection = createLegacyLocalProjection(store, (channel, payload) => {
    signals.push({ channel, payload, visibleAt: store.latest()?.collectedAt ?? null });
  }, (value) => { lastError = value; });

  projection.onLocalCollection({
    contractVersion: FLEET_CONTRACT_VERSION,
    collectorSessionId: "local-session",
    sequence: 0,
    hostObservedAtMs: 123,
    metrics: [{ metricId: "cpu.utilization.percent", value: 10, availability: { state: "available", reason: null } }],
  }, 123);
  projection.onLocalDirectories([{ collectedAt: 124, location: "cache", bytes: 10, onRootFilesystem: true, partial: false }]);
  projection.onLocalMemory({
    collectedAt: 125,
    processDetailsCollectedAt: null,
    sampleIntervalMs: null,
    pressureSomePercent: 0,
    pressureFullPercent: 0,
    swapInPagesPerSecond: 0,
    swapOutPagesPerSecond: 0,
    refaultPagesPerSecond: 0,
    reclaimPagesPerSecond: 0,
    bbCgroupMemoryBytes: 0,
    processes: [],
  });
  projection.onLocalError("core", "collector unavailable", 126);

  assert.deepEqual(signals.map((signal) => signal.channel), [
    "machine-monitor-sample",
    "machine-monitor-directories",
    "machine-monitor-memory",
    "machine-monitor-sample",
  ]);
  assert.equal(signals[0]?.visibleAt, 123, "the sample signal follows its legacy table write");
  assert.equal(store.directorySummary(0, 1_000).length, 1, "directory projection remains available to the snapshot RPC");
  assert.equal(store.latestMemoryDiagnostics()?.collectedAt, 125, "memory projection remains available to the snapshot RPC");
  assert.equal(lastError, "collector unavailable");
  assert.deepEqual(signals.at(-1)?.payload, { collectedAt: 126, error: true }, "a local core failure still refreshes the old sample channel");
});

test("a local server reload commits a fresh collector session while duplicate retries remain idempotent", async (t) => {
  let host = createFakePluginHost({
    pluginId: "machine-monitor",
    sdk: {
      subscribe: () => () => {},
      hosts: { list: async () => [] },
    },
  });
  let service: { controller: AbortController; done: Promise<void> } | null = null;
  t.after(async () => {
    service?.controller.abort();
    await service?.done;
    await host.harness.dispose();
  });

  await plugin(host.bb);
  service = host.harness.runService("machine-monitor-fleet");
  await waitFor(() => localCollections(host).length === 1);

  const firstLifecycle = localCollections(host);
  const first = firstLifecycle[0];
  assert.ok(first, "the first local server lifecycle commits a core collection");
  assert.match(first.collectorSessionId, /^local-bb-server:/, "the local session is server-assigned");
  const firstGeneration = new FleetStore(host.bb.storage.database()).machine(LOCAL_MACHINE)?.generation;
  assert.deepEqual(
    new FleetStore(host.bb.storage.database()).recordCollection(first),
    { outcome: "duplicate", generation: firstGeneration },
    "an ordinary retry in one lifecycle is still idempotent",
  );
  assert.equal(localCollections(host).length, 1, "a duplicate retry does not add durable history");

  // The fake host reload closes the current SQLite handle, then loads the
  // replacement against the same persistent database file.
  host = await host.harness.reload(plugin);
  service = host.harness.runService("machine-monitor-fleet");
  await waitFor(() => localCollections(host).length === 2);

  const secondLifecycle = localCollections(host);
  const second = secondLifecycle.find((collection) => collection.collectorSessionId !== first.collectorSessionId);
  assert.ok(second, "the replacement server lifecycle commits under a new session identity");
  assert.equal(second.sequence, 0, "the replacement lifecycle may safely restart its local sequence");
  assert.equal(secondLifecycle.length, 2, "retained history and the new lifecycle collection coexist");
});
