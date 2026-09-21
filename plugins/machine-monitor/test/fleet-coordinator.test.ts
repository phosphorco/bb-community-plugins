import assert from "node:assert/strict";
import test from "node:test";

import Database from "better-sqlite3";

import {
  FleetCoordinator,
  deterministicJitter,
  FLEET_GLOBAL_CONCURRENCY,
  FLEET_RETENTION_INTERVAL_MS,
  targetMonitoredDirectories,
  type FleetCollectorTarget,
} from "../fleet-coordinator.ts";
import { FLEET_CONTRACT_VERSION, type FleetMachineIdentity } from "../fleet-contract.ts";
import { FleetStore } from "../fleet-store.ts";
import { machineMonitorMigrations } from "../store.ts";
import { RETENTION_MS } from "../monitor.ts";

const local: FleetMachineIdentity = { source: "local-bb-server", machineId: "local-bb-server" };

function core(session = "session-1", sequence = 0, observedAtMs = 1_000) {
  return {
    contractVersion: FLEET_CONTRACT_VERSION,
    collectorSessionId: session,
    sequence,
    hostObservedAtMs: observedAtMs,
    metrics: [{ metricId: "cpu.utilization.percent" as const, value: 42, availability: { state: "available" as const, reason: null } }],
  };
}

function description(session = "session-1", platform: "linux" | "darwin" | "wsl" | "unknown" = "linux") {
  return {
    contractVersion: FLEET_CONTRACT_VERSION,
    collectorSessionId: session,
    observedAtMs: 1_000,
    hostName: "worker",
    platform,
    platformDetail: platform,
    capabilities: ["core-sampling" as const, "directory-sampling" as const, "memory-diagnostics" as const],
  };
}

function directory(session = "session-1", sequence = 0) {
  return {
    contractVersion: FLEET_CONTRACT_VERSION,
    collectorSessionId: session,
    sequence,
    observedAtMs: 1_000,
    directoryId: "cache",
    bytes: 10,
    onRootFilesystem: true,
    partial: false,
    availability: "available" as const,
    reason: null,
  };
}

function memory(session = "session-1", sequence = 0, pressure = false) {
  return {
    contractVersion: FLEET_CONTRACT_VERSION,
    collectorSessionId: session,
    sequence,
    observedAtMs: 1_000,
    processDetailsCollectedAtMs: null,
    sampleIntervalMs: null,
    pressureSomePercent: pressure ? 1 : 0,
    pressureFullPercent: 0,
    swapInPagesPerSecond: 0,
    swapOutPagesPerSecond: 0,
    refaultPagesPerSecond: 0,
    reclaimPagesPerSecond: 0,
    bbCgroupMemoryBytes: 0,
    processes: [],
  };
}

function inventory(session = "session-1", logicalCores = 4) {
  return {
    contractVersion: FLEET_CONTRACT_VERSION,
    collectorSessionId: session,
    observedAtMs: 1_000,
    visibility: "host-visible" as const,
    os: { name: "Test Linux", version: "1", kernel: "test", architecture: "x64" },
    cpu: { logicalCores, observedPhysicalCores: 2, observedPackages: 1, model: "Test CPU", speedMHz: 2_400, availability: { state: "available" as const, reason: null } },
    memory: { usableBytes: 16_000, availability: { state: "available" as const, reason: null } },
    disks: [],
    disksAvailability: { state: "partial" as const, reason: "No disks in test fixture." },
    raid: { state: "not-detected" as const, arrays: [], source: "linux-mdstat" as const, reason: "No active Linux md arrays were reported." },
    location: { value: null, source: "unavailable" as const },
    limitations: ["Test inventory."],
  };
}

function immediateTarget(session = "local-session"): FleetCollectorTarget {
  return {
    description: async () => description(session),
    core: async () => core(session),
    directory: async (request) => ({ ...directory(session), directoryId: request.directoryId }),
    memory: async () => memory(session),
  };
}

function makeStore(t: test.TestContext): FleetStore {
  const db = new Database(":memory:");
  for (const migration of machineMonitorMigrations) db.exec(migration);
  t.after(() => db.close());
  return new FleetStore(db);
}

async function allowWork(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function waitFor(predicate: () => boolean, message = "timed out waiting for fleet work"): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await allowWork();
  }
  assert.fail(message);
}

test("prunes API-classified ephemeral machines without discarding missing persistent history", async (t) => {
  const store = makeStore(t);
  const ephemeral = { source: "enrolled-host" as const, machineId: "host-ephemeral" };
  const persistent = { source: "enrolled-host" as const, machineId: "host-persistent" };
  for (const machine of [ephemeral, persistent]) {
    store.registerMachine({ machine, label: machine.machineId, connection: "connected", capabilities: [], serverObservedAtMs: 1_000 });
  }
  let remoteCalls = 0;
  let failRemovalInvalidation = true;
  const invalidations: string[] = [];
  const coordinator = new FleetCoordinator({
    store,
    now: () => 2_000,
    listEnrolledHosts: async () => [
      { id: ephemeral.machineId, name: "Sandbox", status: "disconnected", type: "ephemeral" },
      { id: ephemeral.machineId, name: "Conflicting duplicate", status: "connected", type: "persistent" },
      { id: persistent.machineId, name: "Legacy persistent", status: "disconnected" },
    ],
    remote: () => {
      remoteCalls += 1;
      return immediateTarget("unexpected-remote");
    },
    local: { ...immediateTarget(), label: "BB server", capabilities: ["core-sampling"] },
    directories: () => [],
    publish: ({ machine, kinds }) => {
      if (!kinds.includes("retention")) return;
      if (failRemovalInvalidation) {
        failRemovalInvalidation = false;
        throw new Error("realtime unavailable");
      }
      invalidations.push(machine.machineId);
    },
  });

  await coordinator.runOnce();
  await coordinator.whenIdle();

  assert.equal(store.machine(ephemeral), null, "the sandbox registry row and retained telemetry are pruned");
  assert.equal(store.machine(persistent)?.connection, "disconnected", "a host with no type keeps the prior persistent behavior");
  assert.equal(remoteCalls, 1, "only the untyped persistent host receives a dormant target; the ephemeral host is never scheduled");
  assert.deepEqual(invalidations, [], "the committed removal retains its failed invalidation for retry");
  await coordinator.runOnce();
  assert.deepEqual(invalidations, [ephemeral.machineId]);
});

test("an ephemeral reclassification fences an in-flight persistent-host response", async (t) => {
  const store = makeStore(t);
  const machine = { source: "enrolled-host" as const, machineId: "host-reclassified" };
  let hostType: "persistent" | "ephemeral" = "persistent";
  let releaseCore: (() => void) | undefined;
  let markCoreStarted: (() => void) | undefined;
  const coreStarted = new Promise<void>((resolve) => { markCoreStarted = resolve; });
  const coordinator = new FleetCoordinator({
    store,
    listEnrolledHosts: async () => [{ id: machine.machineId, name: "Reclassified", status: "connected", type: hostType }],
    remote: () => ({
      description: async () => description("reclassified-worker"),
      core: async () => {
        markCoreStarted?.();
        return await new Promise<ReturnType<typeof core>>((resolve) => { releaseCore = () => resolve(core("reclassified-worker")); });
      },
      directory: async (request) => ({ ...directory("reclassified-worker"), directoryId: request.directoryId }),
      memory: async () => memory("reclassified-worker"),
    }),
    local: { ...immediateTarget(), label: "BB server", capabilities: ["core-sampling"] },
    directories: () => [],
  });
  const lifecycle = new AbortController();
  const running = coordinator.start(lifecycle.signal);
  try {
    await coreStarted;
    assert.notEqual(store.machine(machine), null);
    hostType = "ephemeral";
    coordinator.requestReconcile();
    await waitFor(() => store.machine(machine) == null, "the ephemeral reclassification did not remove the machine");
    await coordinator.whenIdle();
    releaseCore?.();
    await allowWork();
    assert.equal(store.machine(machine), null, "the late response cannot recreate pruned telemetry");
  } finally {
    lifecycle.abort();
    releaseCore?.();
    await running;
  }
});

test("binds a remote payload to its authenticated target, midpoint-normalizes time, and invalidates after the commit", async (t) => {
  const store = makeStore(t);
  const invalidations: Array<{ machineId: string; collections: number }> = [];
  let now = 1_000;
  const coordinator = new FleetCoordinator({
    store,
    now: () => now,
    listEnrolledHosts: async () => [{ id: "host-authenticated", name: "Authenticated worker", status: "connected" }],
    remote: () => ({
      description: async () => description(),
      core: async () => {
        now = 1_040;
        return core("remote-session", 7, 9_999_999);
      },
      directory: async (request) => ({ ...directory("remote-session"), directoryId: request.directoryId }),
      memory: async () => memory("remote-session"),
    }),
    local: { ...immediateTarget(), label: "BB server", capabilities: ["core-sampling"] },
    directories: () => [],
    publish: ({ machine, kinds }) => {
      if (kinds.includes("collection")) {
        invalidations.push({ machineId: machine.machineId, collections: store.collections(machine, 0, Number.MAX_SAFE_INTEGER).length });
      }
    },
  });
  const lifecycle = new AbortController();
  const running = coordinator.start(lifecycle.signal);
  await allowWork();
  await coordinator.whenIdle();

  const remote = { source: "enrolled-host" as const, machineId: "host-authenticated" };
  const [recorded] = store.collections(remote, 0, Number.MAX_SAFE_INTEGER);
  assert.deepEqual(recorded?.machine, remote, "the response never chose its own machine ID");
  assert.equal(recorded?.hostObservedAtMs, 9_999_999);
  assert.equal(recorded?.normalizedAtMs, 1_020);
  assert.equal(recorded?.clockUncertaintyMs, 20);
  assert.deepEqual(invalidations.filter((entry) => entry.machineId === "host-authenticated"), [{ machineId: "host-authenticated", collections: 1 }], "the notification observes the committed row");

  lifecycle.abort();
  await running;
});

test("clamps collection chronology when the wall clock rolls back", async (t) => {
  const store = makeStore(t);
  let now = 1_000;
  let coreCalls = 0;
  const coordinator = new FleetCoordinator({
    store,
    now: () => now,
    listEnrolledHosts: async () => [{ id: "host-clock", name: "Clock", status: "connected" }],
    remote: () => ({
      description: async () => description("clock-worker"),
      core: async () => {
        coreCalls += 1;
        if (coreCalls === 1) now = 1_040;
        else now = 900;
        return core("clock-worker", coreCalls - 1);
      },
      directory: async (request) => ({ ...directory("clock-worker"), directoryId: request.directoryId }),
      memory: async () => memory("clock-worker"),
    }),
    local: { ...immediateTarget(), label: "BB server", capabilities: ["core-sampling"] },
    directories: () => [],
  });
  const lifecycle = new AbortController();
  const running = coordinator.start(lifecycle.signal);
  try {
    await waitFor(() => coreCalls === 1);
    now = 1_060;
    coordinator.settingsChanged();
    await waitFor(() => coreCalls === 2, "the prompted collection did not run after the clock change");
    await coordinator.whenIdle();

    const remote = { source: "enrolled-host" as const, machineId: "host-clock" };
    const collections = store.collections(remote, 0, Number.MAX_SAFE_INTEGER);
    assert.equal(collections.length, 2);
    assert.deepEqual(
      collections.map((entry) => ({
        sentAt: entry.serverSentAtMs,
        receivedAt: entry.serverReceivedAtMs,
        normalizedAt: entry.normalizedAtMs,
      })),
      [
        { sentAt: 1_000, receivedAt: 1_040, normalizedAt: 1_020 },
        { sentAt: 1_060, receivedAt: 1_060, normalizedAt: 1_060 },
      ],
      "server-side timing never regresses when the wall clock does",
    );
  } finally {
    lifecycle.abort();
    await running;
  }
});

test("commits the Linux memory lane once with its timing before legacy projection and invalidation", async (t) => {
  const db = new Database(":memory:");
  for (const migration of machineMonitorMigrations) db.exec(migration);
  t.after(() => db.close());
  const store = new FleetStore(db);
  let now = 1_000;
  let releaseDescription: (() => void) | undefined;
  const descriptionReady = new Promise<void>((resolve) => { releaseDescription = resolve; });
  const memoryInvalidations: number[] = [];
  let localProjectionSawCommittedObservation = false;
  const coordinator = new FleetCoordinator({
    store,
    now: () => now,
    listEnrolledHosts: async () => [],
    remote: () => immediateTarget(),
    local: {
      label: "BB server",
      capabilities: ["core-sampling"],
      description: async () => {
        releaseDescription?.();
        return description("memory-session", "linux");
      },
      core: async () => core("memory-session", 0),
      directory: async (request) => ({ ...directory("memory-session"), directoryId: request.directoryId }),
      memory: async () => {
        await descriptionReady;
        await allowWork();
        now = 1_040;
        return {
          ...memory("memory-session", 0, true),
          observedAtMs: 9_999_999,
          pressureFullPercent: 2,
          swapInPagesPerSecond: 3,
          swapOutPagesPerSecond: 4,
        };
      },
    },
    directories: () => [],
    onLocalMemory: () => {
      localProjectionSawCommittedObservation = (db.prepare("SELECT COUNT(*) AS count FROM machine_monitor_fleet_memory_observations").get() as { count: number }).count === 1;
    },
    publish: ({ machine, generation, kinds }) => {
      if (machine.source === "local-bb-server" && kinds.includes("memory")) {
        assert.deepEqual(generation, store.generation(machine), "memory invalidation follows the one committed transaction");
        memoryInvalidations.push(generation.dataRevision);
      }
    },
  });
  const lifecycle = new AbortController();
  const running = coordinator.start(lifecycle.signal);
  try {
    await waitFor(() => memoryInvalidations.length === 1, "the Linux memory observation did not commit");
    assert.equal(localProjectionSawCommittedObservation, true, "legacy local projection remains after the canonical commit");
    assert.deepEqual(
      db.prepare(`SELECT collector_session_id AS collectorSessionId, sequence,
        host_observed_at AS hostObservedAtMs, server_sent_at AS serverSentAtMs,
        server_received_at AS serverReceivedAtMs, normalized_at AS normalizedAtMs,
        clock_uncertainty_ms AS clockUncertaintyMs, pressure_some_percent AS pressureSomePercent,
        pressure_full_percent AS pressureFullPercent, swap_in_pages_per_second AS swapInPagesPerSecond,
        swap_out_pages_per_second AS swapOutPagesPerSecond
        FROM machine_monitor_fleet_memory_observations`).get(),
      {
        collectorSessionId: "memory-session",
        sequence: 0,
        hostObservedAtMs: 9_999_999,
        serverSentAtMs: 1_000,
        serverReceivedAtMs: 1_040,
        normalizedAtMs: 1_020,
        clockUncertaintyMs: 20,
        pressureSomePercent: 1,
        pressureFullPercent: 2,
        swapInPagesPerSecond: 3,
        swapOutPagesPerSecond: 4,
      },
    );
  } finally {
    lifecycle.abort();
    await running;
  }
});

test("rejects delayed old-session directory data and same-session stale core sequences", async (t) => {
  const store = makeStore(t);
  let now = 1_000;
  let markDirectoryStarted: (() => void) | undefined;
  const directoryStarted = new Promise<void>((resolve) => { markDirectoryStarted = resolve; });
  let allowDirectory: (() => void) | undefined;
  const directoryRelease = new Promise<void>((resolve) => { allowDirectory = resolve; });
  let coreCalls = 0;
  const coordinator = new FleetCoordinator({
    store,
    now: () => now,
    listEnrolledHosts: async () => [{ id: "host-a", name: "A", status: "connected" }],
    remote: () => ({
      description: async () => description("new-session"),
      core: async () => core("new-session", coreCalls++ === 0 ? 4 : 4),
      directory: async (request) => {
        markDirectoryStarted?.();
        await directoryRelease;
        return { ...directory("old-session"), directoryId: request.directoryId };
      },
      memory: async () => memory("new-session"),
    }),
    local: { ...immediateTarget(), label: "BB server", capabilities: ["core-sampling"] },
    directories: () => [{ id: "cache", label: "cache", paths: [".cache"] }],
  });
  const lifecycle = new AbortController();
  const running = coordinator.start(lifecycle.signal);
  const remote = { source: "enrolled-host" as const, machineId: "host-a" };
  // The initial parallel directory pass may observe no authoritative core
  // session. A settings prompt brings that independent lane forward without
  // changing this test's worker lifecycle.
  await waitFor(() => store.machine(remote) != null && store.collections(remote, 0, Number.MAX_SAFE_INTEGER).length === 1);
  coordinator.settingsChanged();
  await directoryStarted;
  // Core already established new-session while an old directory RPC remains in flight.
  now = 50_000;
  allowDirectory?.();
  await coordinator.whenIdle();
  assert.equal(store.directoryDetails(remote, 0, Number.MAX_SAFE_INTEGER).length, 0, "an older worker cannot append a directory result");
  assert.equal(store.collections(remote, 0, Number.MAX_SAFE_INTEGER).length, 1);

  now = 100_000;
  await coordinator.runOnce();
  await coordinator.whenIdle();
  assert.equal(store.collections(remote, 0, Number.MAX_SAFE_INTEGER).length, 1, "same-session non-increasing sequence is ignored before a durable write");

  lifecycle.abort();
  await running;
});

test("slow directory lanes leave reserved capacity for every host core sample", async (t) => {
  const store = makeStore(t);
  let releaseDirectories: (() => void) | undefined;
  const directoriesBlocked = new Promise<void>((resolve) => { releaseDirectories = resolve; });
  const startedCores: string[] = [];
  const hosts = Array.from({ length: 8 }, (_, index) => ({ id: `host-${index}`, name: `Host ${index}`, status: "connected" as const }));
  const coordinator = new FleetCoordinator({
    store,
    listEnrolledHosts: async () => hosts,
    remote: (hostId) => ({
      description: async () => description(hostId),
      core: async () => {
        startedCores.push(hostId);
        return core(hostId);
      },
      directory: async (request) => {
        await directoriesBlocked;
        return { ...directory(hostId), directoryId: request.directoryId };
      },
      memory: async () => memory(hostId),
    }),
    local: { ...immediateTarget(), label: "BB server", capabilities: ["core-sampling"] },
    directories: () => [{ id: "cache", label: "cache", paths: [".cache"] }],
  });
  const lifecycle = new AbortController();
  const running = coordinator.start(lifecycle.signal);
  try {
    for (let index = 0; index < 12 && startedCores.length < hosts.length; index += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    assert.deepEqual([...startedCores].sort(), hosts.map((host) => host.id), "directory calls may occupy only non-core slots");
  } finally {
    releaseDirectories?.();
    await coordinator.whenIdle();
    lifecycle.abort();
    await running;
  }
});

test("a host-connected event prompts collection even when a periodic list never observed the brief disconnect", async (t) => {
  const store = makeStore(t);
  let coreCalls = 0;
  const coordinator = new FleetCoordinator({
    store,
    listEnrolledHosts: async () => [{ id: "host-reconnect", name: "Reconnect", status: "connected" }],
    remote: () => ({
      description: async () => description("reconnect-session"),
      core: async () => core("reconnect-session", coreCalls++),
      directory: async (request) => ({ ...directory("reconnect-session"), directoryId: request.directoryId }),
      memory: async () => memory("reconnect-session"),
    }),
    local: { ...immediateTarget(), label: "BB server", capabilities: ["core-sampling"] },
    directories: () => [],
  });
  const lifecycle = new AbortController();
  const running = coordinator.start(lifecycle.signal);
  await allowWork();
  await coordinator.whenIdle();
  assert.equal(coreCalls, 1);
  coordinator.noteHostConnected("host-reconnect");
  await allowWork();
  await coordinator.whenIdle();
  assert.equal(coreCalls, 2);
  lifecycle.abort();
  await running;
});

test("an inventory refresh failure publishes its retained-profile error with inventory invalidation", async (t) => {
  const store = makeStore(t);
  const invalidations: Array<readonly string[]> = [];
  let failInventory = false;
  const coordinator = new FleetCoordinator({
    store,
    listEnrolledHosts: async () => [{ id: "host-inventory-error", name: "Inventory error", status: "connected" }],
    remote: () => ({
      description: async () => description("inventory-worker"),
      core: async () => core("inventory-worker"),
      directory: async (request) => ({ ...directory("inventory-worker"), directoryId: request.directoryId }),
      memory: async () => memory("inventory-worker"),
      inventory: async () => {
        if (failInventory) throw new Error("Inventory probe timed out");
        return inventory("inventory-worker");
      },
    }),
    local: { ...immediateTarget(), label: "BB server", capabilities: ["core-sampling"] },
    directories: () => [],
    publish: ({ machine, kinds }) => {
      if (machine.machineId === "host-inventory-error") invalidations.push(kinds);
    },
  });
  const lifecycle = new AbortController();
  const running = coordinator.start(lifecycle.signal);
  const remote = { source: "enrolled-host" as const, machineId: "host-inventory-error" };
  try {
    await waitFor(() => store.inventory(remote) != null, "the initial inventory did not persist");
    failInventory = true;
    coordinator.noteHostConnected(remote.machineId);
    await waitFor(() => invalidations.some((kinds) => kinds.includes("error") && kinds.includes("inventory")), "inventory failure did not invalidate both consumers");
    assert.equal(store.inventory(remote)?.lastError, "Inventory probe timed out");
  } finally {
    lifecycle.abort();
    await running;
  }
});

test("a host-connected lifecycle boundary aborts an old core before its late response can persist", async (t) => {
  const store = makeStore(t);
  let workerSession = "old-worker";
  let coreCalls = 0;
  let releaseOldCore: (() => void) | undefined;
  let oldCoreStarted: (() => void) | undefined;
  const oldCore = new Promise<void>((resolve) => { oldCoreStarted = resolve; });
  const coordinator = new FleetCoordinator({
    store,
    listEnrolledHosts: async () => [{ id: "host-connected-boundary", name: "Boundary", status: "connected" }],
    remote: () => ({
      description: async () => description(workerSession),
      core: async () => {
        coreCalls += 1;
        if (coreCalls === 1) {
          oldCoreStarted?.();
          return new Promise((resolve) => { releaseOldCore = () => resolve(core("old-worker", 0)); });
        }
        return core("replacement-worker", 0);
      },
      directory: async (request) => ({ ...directory(workerSession), directoryId: request.directoryId }),
      memory: async () => memory(workerSession),
    }),
    local: { ...immediateTarget(), label: "BB server", capabilities: ["core-sampling"] },
    directories: () => [],
  });
  const lifecycle = new AbortController();
  const running = coordinator.start(lifecycle.signal);
  try {
    await oldCore;
    workerSession = "replacement-worker";
    coordinator.noteHostConnected("host-connected-boundary");
    const remote = { source: "enrolled-host" as const, machineId: "host-connected-boundary" };
    await waitFor(() => coreCalls >= 2 && store.collections(remote, 0, Number.MAX_SAFE_INTEGER).length === 1);
    // The old transport resolves only after the replacement is already durable.
    releaseOldCore?.();
    await allowWork();
    assert.deepEqual(store.collections(remote, 0, Number.MAX_SAFE_INTEGER).map((entry) => entry.collectorSessionId), ["replacement-worker"]);
  } finally {
    lifecycle.abort();
    await running;
  }
});

test("settings prompts received during an active core coalesce into one non-overlapping rerun", async (t) => {
  const store = makeStore(t);
  let coreCalls = 0;
  let activeCores = 0;
  let maxActiveCores = 0;
  let releaseFirstCore: (() => void) | undefined;
  let firstCoreStarted: (() => void) | undefined;
  const firstCore = new Promise<void>((resolve) => { firstCoreStarted = resolve; });
  const coordinator = new FleetCoordinator({
    store,
    listEnrolledHosts: async () => [{ id: "host-pending-prompt", name: "Pending prompt", status: "connected" }],
    remote: () => ({
      description: async () => description("prompt-worker"),
      core: async () => {
        coreCalls += 1;
        activeCores += 1;
        maxActiveCores = Math.max(maxActiveCores, activeCores);
        try {
          if (coreCalls === 1) {
            firstCoreStarted?.();
            await new Promise<void>((resolve) => { releaseFirstCore = resolve; });
          }
          return core("prompt-worker", coreCalls - 1);
        } finally {
          activeCores -= 1;
        }
      },
      directory: async (request) => ({ ...directory("prompt-worker"), directoryId: request.directoryId }),
      memory: async () => memory("prompt-worker"),
    }),
    local: { ...immediateTarget(), label: "BB server", capabilities: ["core-sampling"] },
    directories: () => [],
  });
  const lifecycle = new AbortController();
  const running = coordinator.start(lifecycle.signal);
  try {
    await firstCore;
    coordinator.settingsChanged();
    releaseFirstCore?.();
    await waitFor(() => coreCalls === 2, "the pending settings prompt did not rerun core after release");
    assert.equal(maxActiveCores, 1, "the prompt did not overlap the active core lane");
  } finally {
    lifecycle.abort();
    await running;
  }
});

test("a worker exit aborts the old lifecycle and only a prompted replacement session can persist", async (t) => {
  const store = makeStore(t);
  let resolveOldCore: (() => void) | undefined;
  const oldCoreStarted = new Promise<void>((resolve) => { resolveOldCore = () => resolve(); });
  let coreCalls = 0;
  let releaseOldCore: (() => void) | undefined;
  const coordinator = new FleetCoordinator({
    store,
    listEnrolledHosts: async () => [{ id: "host-exit", name: "Exit", status: "connected" }],
    remote: () => ({
      description: async () => description("old-worker"),
      core: async () => {
        coreCalls += 1;
        if (coreCalls === 1) {
          resolveOldCore?.();
          return new Promise((resolve) => { releaseOldCore = () => resolve(core("old-worker", 0)); });
        }
        return core("replacement-worker", 0);
      },
      directory: async (request) => ({ ...directory("replacement-worker"), directoryId: request.directoryId }),
      memory: async () => memory("replacement-worker"),
    }),
    local: { ...immediateTarget(), label: "BB server", capabilities: ["core-sampling"] },
    directories: () => [],
  });
  const lifecycle = new AbortController();
  const running = coordinator.start(lifecycle.signal);
  try {
    await oldCoreStarted;
    coordinator.noteWorkerExit("host-exit");
    coordinator.noteHostConnected("host-exit");
    // Simulate a transport that ignores cancellation and resolves after exit.
    releaseOldCore?.();
    const remote = { source: "enrolled-host" as const, machineId: "host-exit" };
    await waitFor(() => coreCalls >= 2 && store.collections(remote, 0, Number.MAX_SAFE_INTEGER).length === 1);
    assert.deepEqual(
      store.collections(remote, 0, Number.MAX_SAFE_INTEGER).map((entry) => entry.collectorSessionId),
      ["replacement-worker"],
      "a late core response from the exited worker cannot cross the lifecycle epoch",
    );
  } finally {
    lifecycle.abort();
    await running;
  }
});

test("directory batches revalidate the stable core session immediately before one durable commit", async (t) => {
  const store = makeStore(t);
  let workerSession = "old-worker";
  let coreCalls = 0;
  let releaseSecondDirectory: (() => void) | undefined;
  let secondDirectoryStarted: (() => void) | undefined;
  const secondDirectory = new Promise<void>((resolve) => { secondDirectoryStarted = resolve; });
  let directoryCalls = 0;
  const coordinator = new FleetCoordinator({
    store,
    listEnrolledHosts: async () => [{ id: "host-directory-batch", name: "Directory batch", status: "connected" }],
    remote: () => ({
      description: async () => description(workerSession),
      core: async () => core(workerSession, coreCalls++),
      directory: async (request) => {
        directoryCalls += 1;
        if (directoryCalls === 2) {
          secondDirectoryStarted?.();
          await new Promise<void>((resolve) => { releaseSecondDirectory = resolve; });
        }
        return { ...directory("old-worker", directoryCalls), directoryId: request.directoryId };
      },
      memory: async () => memory(workerSession),
    }),
    local: { ...immediateTarget(), label: "BB server", capabilities: ["core-sampling"] },
    directories: () => [
      { id: "first", label: "first", paths: ["first"] },
      { id: "second", label: "second", paths: ["second"] },
    ],
  });
  const lifecycle = new AbortController();
  const running = coordinator.start(lifecycle.signal);
  try {
    const remote = { source: "enrolled-host" as const, machineId: "host-directory-batch" };
    await waitFor(() => store.machine(remote) != null && store.collections(remote, 0, Number.MAX_SAFE_INTEGER).length === 1);
    coordinator.settingsChanged();
    await secondDirectory;
    const coresBeforeReplacement = coreCalls;
    workerSession = "replacement-worker";
    coordinator.settingsChanged();
    await waitFor(() => coreCalls > coresBeforeReplacement, "the core lane did not establish the replacement session");
    releaseSecondDirectory?.();
    await coordinator.whenIdle();
    assert.equal(store.directoryDetails(remote, 0, Number.MAX_SAFE_INTEGER).length, 0, "no old-session prefix may survive the batch commit boundary");
  } finally {
    lifecycle.abort();
    await running;
  }
});

test("settings revisions commit before publication, prompt connected lanes, and retention invalidates only after pruning", async (t) => {
  const store = makeStore(t);
  let now = 1_000;
  let remoteCoreCalls = 0;
  const settingsPublications: Array<{ machineId: string; revision: number; durableRevision: number }> = [];
  const retentionPublications: string[] = [];
  const coordinator = new FleetCoordinator({
    store,
    now: () => now,
    listEnrolledHosts: async () => [{ id: "host-settings", name: "Settings", status: "connected" }],
    remote: () => ({
      description: async () => description("settings-worker"),
      core: async () => core("settings-worker", remoteCoreCalls++),
      directory: async (request) => ({ ...directory("settings-worker"), directoryId: request.directoryId }),
      memory: async () => memory("settings-worker"),
    }),
    local: { ...immediateTarget(), label: "BB server", capabilities: ["core-sampling"] },
    directories: () => [],
    publish: ({ machine, generation, kinds }) => {
      if (kinds.includes("settings")) {
        settingsPublications.push({ machineId: machine.machineId, revision: generation.settingsRevision, durableRevision: store.generation(machine).settingsRevision });
      }
      if (kinds.includes("retention") && machine.machineId === "host-settings") retentionPublications.push(machine.machineId);
    },
  });
  const lifecycle = new AbortController();
  const running = coordinator.start(lifecycle.signal);
  try {
    await waitFor(() => remoteCoreCalls === 1);
    const before = new Map(store.machines().map((machine) => [machine.machine.machineId, machine.generation.settingsRevision]));
    coordinator.settingsChanged();
    await waitFor(() => remoteCoreCalls === 2, "settings did not promptly repoll the connected core lane");
    assert.equal(settingsPublications.length, 2, "each registered machine has an independent durable settings revision");
    for (const publication of settingsPublications) {
      assert.equal(publication.revision, publication.durableRevision, "settings publication follows its committed revision");
      assert.equal(publication.revision, before.get(publication.machineId)! + 1);
    }

    const remote = { source: "enrolled-host" as const, machineId: "host-settings" };
    store.recordCollection({
      machine: remote,
      contractVersion: FLEET_CONTRACT_VERSION,
      collectorSessionId: "expired-worker",
      sequence: 0,
      hostObservedAtMs: 1,
      metrics: core().metrics,
      serverSentAtMs: 1,
      serverReceivedAtMs: 1,
      normalizedAtMs: 1,
      clockUncertaintyMs: 0,
    });
    now = RETENTION_MS + FLEET_RETENTION_INTERVAL_MS + 2_000;
    await coordinator.runOnce();
    assert.ok(
      store.collections(remote, 0, Number.MAX_SAFE_INTEGER).every((entry) => entry.collectorSessionId !== "expired-worker"),
      "the stale collection was pruned before its retention invalidation",
    );
    assert.deepEqual(retentionPublications, ["host-settings"], "retention invalidation follows the prune transaction for changed machine data");
  } finally {
    lifecycle.abort();
    await running;
  }
});

test("Linux memory pressure schedules the exact five-second follow-up and shutdown cancels active RPCs", async (t) => {
  const store = makeStore(t);
  let now = 1_000;
  const active = { signal: null as AbortSignal | null };
  let beginCore: (() => void) | undefined;
  const coreStarted = new Promise<void>((resolve) => { beginCore = resolve; });
  const coordinator = new FleetCoordinator({
    store,
    now: () => now,
    listEnrolledHosts: async () => [{ id: "host-linux", name: "Linux", status: "connected" }],
    remote: () => ({
      description: async () => description("linux-session", "linux"),
      core: async (signal) => new Promise((_, reject) => {
        active.signal = signal;
        beginCore?.();
        signal.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true });
      }),
      directory: async (request) => ({ ...directory("linux-session"), directoryId: request.directoryId }),
      memory: async () => memory("linux-session", 0, true),
    }),
    local: { ...immediateTarget(), label: "BB server", capabilities: ["core-sampling"] },
    directories: () => [],
  });
  const lifecycle = new AbortController();
  const running = coordinator.start(lifecycle.signal);
  await coreStarted;
  await allowWork();
  // The memory lane can commit while core is still hung; pressure does not
  // couple the lanes and therefore cannot block cancellation.
  assert.equal(active.signal?.aborted, false);
  lifecycle.abort();
  await running;
  assert.equal(active.signal?.aborted, true);
  assert.deepEqual(coordinator.inspect(), { timers: 0, activeCalls: 0, gate: { active: 0, nonCoreActive: 0 } });
  assert.equal(now, 1_000);
});

test("shutdown releases a lane whose transport ignores AbortSignal", async (t) => {
  const store = makeStore(t);
  let coreStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { coreStarted = resolve; });
  const coordinator = new FleetCoordinator({
    store,
    listEnrolledHosts: async () => [{ id: "host-uncooperative", name: "Uncooperative", status: "connected" }],
    remote: () => ({
      description: async () => description("uncooperative-worker"),
      core: async () => {
        coreStarted?.();
        return new Promise<never>(() => undefined);
      },
      directory: async (request) => ({ ...directory("uncooperative-worker"), directoryId: request.directoryId }),
      memory: async () => memory("uncooperative-worker"),
    }),
    local: { ...immediateTarget(), label: "BB server", capabilities: ["core-sampling"] },
    directories: () => [],
  });
  const lifecycle = new AbortController();
  const running = coordinator.start(lifecycle.signal);
  await started;
  lifecycle.abort();
  await running;
  assert.deepEqual(coordinator.inspect(), { timers: 0, activeCalls: 0, gate: { active: 0, nonCoreActive: 0 } });
});

test("an abort-ignoring RPC deadline records failure, quarantines its lane, and retries only after settlement", async (t) => {
  const store = makeStore(t);
  let now = 1_000;
  let coreCalls = 0;
  let releaseFirstCore: (() => void) | undefined;
  let firstCoreStarted: (() => void) | undefined;
  const firstCore = new Promise<void>((resolve) => { firstCoreStarted = resolve; });
  const coordinator = new FleetCoordinator({
    store,
    now: () => now,
    rpcTimeoutMs: 10,
    listEnrolledHosts: async () => [{ id: "host-timeout", name: "Timeout", status: "connected" }],
    remote: () => ({
      description: async () => description("timeout-worker"),
      core: async () => {
        coreCalls += 1;
        if (coreCalls === 1) {
          firstCoreStarted?.();
          return new Promise((resolve) => { releaseFirstCore = () => resolve(core("timeout-worker", 0)); });
        }
        return core("timeout-worker", coreCalls - 2);
      },
      directory: async (request) => ({ ...directory("timeout-worker"), directoryId: request.directoryId }),
      memory: async () => memory("timeout-worker"),
    }),
    local: { ...immediateTarget(), label: "BB server", capabilities: ["core-sampling"] },
    directories: () => [],
  });
  const lifecycle = new AbortController();
  const running = coordinator.start(lifecycle.signal);
  try {
    const remote = { source: "enrolled-host" as const, machineId: "host-timeout" };
    await firstCore;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    await waitFor(() => store.machine(remote)?.lastError === "Fleet RPC timed out", "the RPC deadline did not record a machine error");
    await coordinator.whenIdle();
    assert.deepEqual(coordinator.inspect().gate, { active: 1, nonCoreActive: 0 }, "the unresolved transport retains its physical concurrency slot");
    now = 61_000;
    await coordinator.runOnce();
    await allowWork();
    assert.equal(coreCalls, 1, "the host lane cannot begin a second physical RPC while its timed-out call remains stuck");
    releaseFirstCore?.();
    await waitFor(() => coreCalls === 2 && store.collections(remote, 0, Number.MAX_SAFE_INTEGER).length === 1, "the bounded retry did not collect after its transport settled");
    await coordinator.whenIdle();
    await allowWork();
    assert.deepEqual(coordinator.inspect().gate, { active: 0, nonCoreActive: 0 }, "settlement releases the quarantined slot");
  } finally {
    lifecycle.abort();
    await running;
  }
});

test("stuck timed-out transports never exceed the physical global concurrency cap", async (t) => {
  const store = makeStore(t);
  let now = 1_000;
  let coreCalls = 0;
  let activeTransports = 0;
  let maxActiveTransports = 0;
  const releases = new Set<() => void>();
  const hosts = Array.from({ length: FLEET_GLOBAL_CONCURRENCY + 2 }, (_, index) => ({
    id: `host-cap-${index}`,
    name: `Cap ${index}`,
    status: "connected" as const,
  }));
  const coordinator = new FleetCoordinator({
    store,
    now: () => now,
    rpcTimeoutMs: 10,
    listEnrolledHosts: async () => hosts,
    remote: (hostId) => ({
      description: async () => description(`${hostId}-worker`),
      core: async () => {
        coreCalls += 1;
        activeTransports += 1;
        maxActiveTransports = Math.max(maxActiveTransports, activeTransports);
        return new Promise((resolve) => {
          let released = false;
          const release = () => {
            if (released) return;
            released = true;
            releases.delete(release);
            activeTransports -= 1;
            resolve(core(`${hostId}-worker`, coreCalls));
          };
          releases.add(release);
        });
      },
      directory: async (request) => ({ ...directory(`${hostId}-worker`), directoryId: request.directoryId }),
      memory: async () => memory(`${hostId}-worker`),
    }),
    local: { ...immediateTarget(), label: "BB server", capabilities: ["core-sampling"] },
    directories: () => [],
  });
  const lifecycle = new AbortController();
  const running = coordinator.start(lifecycle.signal);
  try {
    // Gate denials are deliberately retried rather than queued. Advance the
    // deterministic scheduler clock through those retry turns to fill every
    // physical slot without relying on wall-clock scheduling.
    for (let attempt = 0; attempt < FLEET_GLOBAL_CONCURRENCY + 2 && coreCalls < FLEET_GLOBAL_CONCURRENCY; attempt += 1) {
      now += 100;
      await coordinator.runOnce();
      await allowWork();
    }
    await waitFor(() => coreCalls === FLEET_GLOBAL_CONCURRENCY, "the initial physical calls did not fill the global cap");
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    await waitFor(
      () => hosts.slice(0, FLEET_GLOBAL_CONCURRENCY).every((host) => store.machine({ source: "enrolled-host", machineId: host.id })?.lastError === "Fleet RPC timed out"),
      "the stuck physical calls did not reach their deadlines",
    );
    now = 100_000;
    await coordinator.runOnce();
    await allowWork();
    assert.equal(coreCalls, FLEET_GLOBAL_CONCURRENCY, "deadline retries cannot start while every physical slot remains quarantined");
    assert.equal(activeTransports, FLEET_GLOBAL_CONCURRENCY);
    assert.equal(maxActiveTransports, FLEET_GLOBAL_CONCURRENCY);
    assert.deepEqual(coordinator.inspect().gate, { active: FLEET_GLOBAL_CONCURRENCY, nonCoreActive: 0 });

    const [releaseOne] = releases;
    releaseOne?.();
    await waitFor(() => coreCalls === FLEET_GLOBAL_CONCURRENCY + 1, "a settled transport did not make exactly one slot available");
    assert.equal(activeTransports, FLEET_GLOBAL_CONCURRENCY, "a replacement starts only after the prior physical transport has settled");
    assert.equal(maxActiveTransports, FLEET_GLOBAL_CONCURRENCY);
  } finally {
    lifecycle.abort();
    await running;
    for (const release of releases) release();
  }
});

test("jitter and target directory parsing are deterministic and never expand a server home path", () => {
  const host = { source: "enrolled-host" as const, machineId: "host-a" };
  assert.equal(deterministicJitter(host, "core"), deterministicJitter(host, "core"));
  assert.notEqual(deterministicJitter(host, "core"), deterministicJitter(host, "directory"));
  const directories = targetMonitoredDirectories("cache/path\n/tmp/target-only\n");
  assert.deepEqual(directories.slice(-2).map((entry) => entry.paths), [["cache/path"], ["/tmp/target-only"]]);
});
