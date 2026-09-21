import assert from "node:assert/strict";
import test from "node:test";

import Database from "better-sqlite3";

import { FleetStore } from "../fleet-store.ts";
import { FLEET_CONTRACT_VERSION, LOCAL_BB_SERVER_MACHINE_ID, MAX_FLEET_MACHINES, type FleetCollectionEnvelope, type FleetMachineIdentity, type MachineInventoryEnvelope } from "../fleet-contract.ts";
import { MAX_REPORTED_DIRECTORIES } from "../monitor.ts";
import { machineMonitorMigrations } from "../store.ts";

const local: FleetMachineIdentity = { source: "local-bb-server", machineId: LOCAL_BB_SERVER_MACHINE_ID };
const host: FleetMachineIdentity = { source: "enrolled-host", machineId: "host_alpha" };
const otherHost: FleetMachineIdentity = { source: "enrolled-host", machineId: "host_beta" };

function makeStore(): { db: Database.Database; store: FleetStore } {
  const db = new Database(":memory:");
  for (const migration of machineMonitorMigrations) db.exec(migration);
  db.pragma("foreign_keys = ON");
  return { db, store: new FleetStore(db) };
}

function collection(machine: FleetMachineIdentity, sequence: number, normalizedAtMs = 1_005): FleetCollectionEnvelope {
  return {
    contractVersion: FLEET_CONTRACT_VERSION,
    machine,
    collectorSessionId: "session-a",
    sequence,
    hostObservedAtMs: 9_999_999,
    serverSentAtMs: normalizedAtMs - 5,
    serverReceivedAtMs: normalizedAtMs + 5,
    normalizedAtMs,
    clockUncertaintyMs: 5,
    metrics: [
      { metricId: "cpu.utilization.percent", value: 42, availability: { state: "available", reason: null } },
      { metricId: "memory.used.bytes", value: 64, availability: { state: "available", reason: null } },
    ],
  };
}

function memoryObservation(sequence: number, normalizedAtMs = 1_105) {
  return {
    collectorSessionId: "memory-session-a",
    sequence,
    hostObservedAtMs: 9_999_999 + sequence,
    serverSentAtMs: normalizedAtMs - 5,
    serverReceivedAtMs: normalizedAtMs + 5,
    normalizedAtMs,
    clockUncertaintyMs: 5,
    pressureSomePercent: 2,
    pressureFullPercent: 0,
    swapInPagesPerSecond: 3,
    swapOutPagesPerSecond: 4,
  };
}

function register(store: FleetStore, machine: FleetMachineIdentity, connection: "local" | "connected" | "disconnected" = machine.source === "local-bb-server" ? "local" : "connected"): void {
  store.registerMachine({
    machine,
    label: machine.source === "local-bb-server" ? "Local BB server" : machine.machineId,
    connection,
    capabilities: ["core-sample"],
    serverObservedAtMs: 1_000,
  });
}

function inventory(machine: FleetMachineIdentity, observedAtMs = 2_000): MachineInventoryEnvelope {
  return {
    machine,
    serverSentAtMs: observedAtMs - 10,
    serverReceivedAtMs: observedAtMs,
    inventory: {
      contractVersion: FLEET_CONTRACT_VERSION,
      collectorSessionId: "inventory-session",
      observedAtMs: observedAtMs - 5,
      visibility: "host-visible",
      os: { name: "Test Linux", version: "1", kernel: "test", architecture: "x64" },
      cpu: { logicalCores: 4, observedPhysicalCores: 2, observedPackages: 1, model: "Test CPU", speedMHz: 2400, availability: { state: "available", reason: null } },
      memory: { usableBytes: 16_000, availability: { state: "available", reason: null } },
      disks: [{ id: "disk-0", kind: "block", sizeBytes: 1_000, model: "Test disk", rotational: false, readOnly: false }],
      disksAvailability: { state: "available", reason: null },
      raid: { state: "not-detected", arrays: [], source: "linux-mdstat", reason: "No active Linux md arrays were reported." },
      location: { value: null, source: "unavailable" },
      limitations: ["Location is not inferred."],
    },
  };
}

test("persists one bounded static inventory per machine without revision churn on a routine refresh", (t) => {
  const { db, store } = makeStore();
  t.after(() => db.close());
  register(store, host);
  register(store, otherHost);
  const before = store.generation(host);
  const first = store.recordInventory(inventory(host));
  assert.equal(first.outcome, "inserted");
  assert.equal(first.generation.dataRevision, before.dataRevision + 1);
  const refreshed = store.recordInventory(inventory(host, 3_000));
  assert.equal(refreshed.outcome, "unchanged", "timing/session refreshes do not change static profile generations");
  assert.equal(store.inventory(host)?.receivedAtMs, 3_000);
  assert.equal(store.inventory(otherHost), null, "inventory remains machine-scoped");
  const changed = store.recordInventory({ ...inventory(host, 4_000), inventory: { ...inventory(host, 4_000).inventory, memory: { usableBytes: 32_000, availability: { state: "available", reason: null } } } });
  assert.equal(changed.outcome, "changed");
  assert.equal(store.inventory(host)?.inventory.memory.usableBytes, 32_000);
  assert.equal(store.inventory(host)?.inventory.location.value, null);
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM machine_monitor_fleet_inventory").get() as { count: number }).count, 1);
});

test("requires server registration, validates trusted timing, and makes collection retries idempotent", (t) => {
  const { db, store } = makeStore();
  t.after(() => db.close());
  assert.throws(() => store.recordCollection(collection(host, 0)), /not registered/);
  assert.throws(() => store.registerMachine({
    machine: host,
    label: "host",
    connection: "local",
    capabilities: [],
    serverObservedAtMs: 1,
  }), /reserved local BB server/);

  register(store, host);
  const first = store.recordCollection(collection(host, 0));
  assert.equal(first.outcome, "inserted");
  const retry = store.recordCollection(collection(host, 0));
  assert.equal(retry.outcome, "duplicate");
  assert.deepEqual(retry.generation, first.generation);
  assert.throws(() => store.recordCollection({ ...collection(host, 0), metrics: [
    { metricId: "cpu.utilization.percent", value: 99, availability: { state: "available", reason: null } },
  ] }), /reused with a different payload/);
  assert.throws(() => store.recordCollection({ ...collection(host, 1), normalizedAtMs: 2_000 }), /inside its request\/response interval/);
  assert.equal(store.recordCollection(collection(host, 2, 1_025)).outcome, "inserted");
  assert.throws(() => store.recordCollection(collection(host, 1, 1_015)), /out-of-order sequence/);
});

test("authoritatively removes an ephemeral enrolled machine and all of its retained data", (t) => {
  const { db, store } = makeStore();
  t.after(() => db.close());
  register(store, host);
  register(store, otherHost);
  store.recordCollection(collection(host, 0));
  store.recordInventory(inventory(host));
  store.recordDirectoryDetails(host, [{ collectedAt: 1_020, location: "cache", bytes: 10, onRootFilesystem: true, partial: false }]);
  store.recordMemory(host, memoryObservation(0), {
    collectedAt: 1_105,
    processDetailsCollectedAt: null,
    sampleIntervalMs: 30_000,
    pressureSomePercent: 2,
    pressureFullPercent: 0,
    swapInPagesPerSecond: 3,
    swapOutPagesPerSecond: 4,
    refaultPagesPerSecond: 0,
    reclaimPagesPerSecond: 0,
    bbCgroupMemoryBytes: 1,
    processes: [],
  });
  store.recordMachineError(host, { errorId: "collector-1", occurredAtMs: 1_120, kind: "collector", message: "timeout" });
  store.appendTimelineEvent(host, {
    contractVersion: FLEET_CONTRACT_VERSION,
    producer: { id: "fleet-store-test", version: 1 },
    eventId: "ephemeral-event",
    time: { kind: "instant", atMs: 1_130 },
    category: "unknown",
    status: "info",
    title: "Ephemeral event",
    detail: null,
    provenance: { kind: "system", component: "fleet-store-test" },
    bbReference: null,
  });
  const before = store.fleetGeneration();

  const dependentTables = [
    "machine_monitor_fleet_collections",
    "machine_monitor_fleet_metric_values",
    "machine_monitor_fleet_directory_details",
    "machine_monitor_fleet_memory_details",
    "machine_monitor_fleet_memory_observations",
    "machine_monitor_fleet_events",
    "machine_monitor_fleet_errors",
    "machine_monitor_fleet_inventory",
  ];
  for (const table of dependentTables) {
    const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE machine_source = ? AND machine_id = ?`)
      .get(host.source, host.machineId) as { count: number };
    assert.ok(row.count > 0, `${table} exercises the removal transaction`);
  }

  const result = store.removeEnrolledMachine(host);

  assert.equal(result.removed, true);
  assert.equal(result.generation.dataRevision, before.dataRevision + 1);
  assert.equal(store.machine(host), null);
  assert.notEqual(store.machine(otherHost), null, "persistent peers remain registered");
  for (const table of dependentTables) {
    const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE machine_source = ? AND machine_id = ?`)
      .get(host.source, host.machineId) as { count: number };
    assert.equal(row.count, 0, `${table} no longer retains the ephemeral host`);
  }
  assert.deepEqual(db.pragma("foreign_key_check"), [], "removal leaves the fleet schema referentially intact");
  assert.deepEqual(store.removeEnrolledMachine(host), { removed: false, generation: result.generation }, "removal is idempotent");
  assert.throws(() => store.removeEnrolledMachine(local), /cannot be removed/);
});

test("stores bounded normalized memory observations atomically with private detail rows", (t) => {
  const { db, store } = makeStore();
  t.after(() => db.close());
  register(store, host);
  register(store, otherHost);
  const detail = {
    collectedAt: 1_105,
    processDetailsCollectedAt: 1_105,
    sampleIntervalMs: 30_000,
    pressureSomePercent: 2,
    pressureFullPercent: 0,
    swapInPagesPerSecond: 3,
    swapOutPagesPerSecond: 4,
    refaultPagesPerSecond: 5,
    reclaimPagesPerSecond: 6,
    bbCgroupMemoryBytes: 7,
    processes: [{
      pid: 42,
      startTime: 1,
      name: "bun",
      workload: "Machine Monitor",
      workloadDetail: "private process detail",
      rssBytes: 512,
      rssDeltaBytes: 1,
      minorFaultsPerSecond: 2,
      majorFaultsPerSecond: 3,
    }],
  };
  const before = store.generation(host);
  const first = store.recordMemory(host, memoryObservation(0), detail);
  assert.deepEqual(
    { outcome: first.outcome, observation: first.observationOutcome, detail: first.detailOutcome },
    { outcome: "inserted", observation: "inserted", detail: "inserted" },
  );
  assert.equal(first.generation.dataRevision, before.dataRevision + 1,
    "one memory-lane durable outcome advances the generation exactly once");
  const retry = store.recordMemory(host, memoryObservation(0), detail);
  assert.equal(retry.outcome, "duplicate");
  assert.deepEqual(retry.generation, first.generation, "same-session retries are idempotent");
  assert.throws(
    () => store.recordMemoryObservation(host, { ...memoryObservation(0), serverSentAtMs: 1_099, normalizedAtMs: 1_104 }),
    /reused with a different payload/,
  );
  assert.equal(store.recordMemoryObservation(host, memoryObservation(2, 1_125)).outcome, "inserted");
  assert.throws(() => store.recordMemoryObservation(host, memoryObservation(1, 1_115)), /out-of-order sequence/);
  assert.equal(store.recordMemoryObservation(otherHost, memoryObservation(0)).outcome, "inserted",
    "server-bound machines may use the same collector identity without bleeding together");
  assert.equal(
    (db.prepare(`SELECT COUNT(*) AS count FROM machine_monitor_fleet_memory_observations
      WHERE machine_source = ? AND machine_id = ?`).get(host.source, host.machineId) as { count: number }).count,
    2,
  );
  const columns = (db.prepare("PRAGMA table_info(machine_monitor_fleet_memory_observations)").all() as Array<{ name: string }>).map((row) => row.name);
  assert.equal(columns.some((column) => /process/i.test(column)), false,
    "process payloads stay only in the detail table and cannot enter timeline observations");
  const pruned = store.prune(1_200);
  assert.equal(pruned.memoryObservations, 3);
  assert.equal(pruned.affectedMachines, 2, "retention identifies every machine with a removed memory observation");
  assert.equal(store.memoryDetails(host, 0, 2_000).length, 0, "paired process details share the same retention boundary");
});

test("keeps every host's normalized samples, details, errors, and chronology isolated", (t) => {
  const { db, store } = makeStore();
  t.after(() => db.close());
  register(store, host);
  register(store, otherHost);
  store.recordCollection(collection(host, 0, 1_005));
  store.recordCollection({ ...collection(otherHost, 0, 1_006), metrics: [
    { metricId: "cpu.utilization.percent", value: 7, availability: { state: "available", reason: null } },
  ] });
  const directories = [{ collectedAt: 1_020, location: "cache", bytes: 10, onRootFilesystem: true, partial: false }];
  assert.equal(store.recordDirectoryDetails(host, directories).inserted, 1);
  assert.equal(store.recordDirectoryDetails(host, directories).duplicate, 1);
  assert.deepEqual(store.directoryDetails(otherHost, 0, 2_000), []);
  const memory = {
    collectedAt: 1_030,
    processDetailsCollectedAt: null,
    sampleIntervalMs: 30_000,
    pressureSomePercent: 1,
    pressureFullPercent: 0,
    swapInPagesPerSecond: 0,
    swapOutPagesPerSecond: 0,
    refaultPagesPerSecond: 0,
    reclaimPagesPerSecond: 0,
    bbCgroupMemoryBytes: 1,
    processes: [{
      pid: 42,
      startTime: 1,
      name: "bun",
      workload: "Machine Monitor",
      workloadDetail: null,
      rssBytes: 512,
      rssDeltaBytes: -64,
      minorFaultsPerSecond: 0,
      majorFaultsPerSecond: 0,
    }],
  };
  assert.equal(store.recordMemoryDetail(host, memory).outcome, "inserted");
  assert.equal(store.recordMemoryDetail(host, memory).outcome, "duplicate");
  assert.equal(store.memoryDetails(host, 0, 2_000)[0]?.processes[0]?.rssDeltaBytes, -64, "process RSS deltas remain signed across durable round-trips");
  assert.equal(store.memoryDetails(otherHost, 0, 2_000).length, 0);
  assert.equal(store.recordMachineError(host, { errorId: "collector-1", occurredAtMs: 1_040, kind: "collector", message: "timeout" }).outcome, "inserted");
  assert.equal(store.machine(host)?.lastError, "timeout");
  store.recordCollection(collection(host, 3, 1_050));
  assert.equal(store.machine(host)?.lastError, null, "a newer successful collection clears a stale error summary");
  assert.deepEqual(store.metricValues(host, 0, 2_000).map((entry) => entry.atMs), [1_005, 1_005, 1_050, 1_050]);
  assert.equal(store.latestMetrics(host).find((entry) => entry.metricId === "cpu.utilization.percent")?.value, 42);
  assert.equal(store.latestMetrics(otherHost).find((entry) => entry.metricId === "cpu.utilization.percent")?.value, 7);
});

test("rejects fleet and directory bounds before mutating any durable state", (t) => {
  const { db, store } = makeStore();
  t.after(() => db.close());
  for (let index = 0; index < MAX_FLEET_MACHINES - 1; index += 1) {
    register(store, { source: "enrolled-host", machineId: `host-${String(index).padStart(3, "0")}` });
  }
  assert.equal(store.machines().length, MAX_FLEET_MACHINES, "the reserved local server counts toward the fleet bound");
  const fleetGeneration = store.fleetGeneration();
  assert.throws(() => register(store, { source: "enrolled-host", machineId: "host-overflow" }), /at most 256 machines/);
  assert.equal(store.machines().length, MAX_FLEET_MACHINES);
  assert.deepEqual(store.fleetGeneration(), fleetGeneration, "rejected registration cannot bump a generation");

  const registered = { source: "enrolled-host", machineId: "host-000" } as const;
  const machineGeneration = store.generation(registered);
  const oversized = Array.from({ length: MAX_REPORTED_DIRECTORIES + 1 }, (_, index) => ({
    collectedAt: 2_000,
    location: `directory-${index}`,
    bytes: index,
    onRootFilesystem: true,
    partial: false,
  }));
  assert.throws(() => store.recordDirectoryDetails(registered, oversized), /at most/);
  assert.deepEqual(store.directoryDetails(registered, 0, 3_000), []);
  assert.deepEqual(store.generation(registered), machineGeneration, "rejected detail batches cannot bump a machine generation");
});

test("returns exact timeline intervals that overlap the selected range", (t) => {
  const { db, store } = makeStore();
  t.after(() => db.close());
  register(store, host);
  const event = (eventId: string, startMs: number, endMs: number) => ({
    contractVersion: FLEET_CONTRACT_VERSION,
    producer: { id: "timeline-test", version: 1 },
    eventId,
    time: { kind: "interval" as const, startMs, endMs },
    category: "bb-job" as const,
    status: "running" as const,
    title: eventId,
    detail: null,
    provenance: { kind: "system" as const, component: "fleet-store-test" },
    bbReference: null,
  });
  store.appendTimelineEvent(host, event("left-overlap", 900, 1_000));
  store.appendTimelineEvent(host, event("right-overlap", 1_100, 1_200));
  store.appendTimelineEvent(host, event("before-range", 800, 999));
  store.appendTimelineEvent(host, event("after-range", 1_101, 1_300));

  const lane = store.timelineEvents(host, 1_000, 1_100);
  assert.equal(lane.totalCount, 2);
  assert.equal(lane.truncated, false);
  assert.deepEqual(lane.events.map((entry) => entry.eventId), ["left-overlap", "right-overlap"]);
  assert.deepEqual(lane.events.map((entry) => entry.time), [
    { kind: "interval", startMs: 900, endMs: 1_000 },
    { kind: "interval", startMs: 1_100, endMs: 1_200 },
  ]);
});

test("bounds and versions timeline events, retains summaries and attachment outbox through pruning", (t) => {
  const { db, store } = makeStore();
  t.after(() => db.close());
  register(store, host, "disconnected");
  const firstEvent = {
    contractVersion: FLEET_CONTRACT_VERSION,
    producer: { id: "bb-jobs", version: 1 },
    eventId: "job-1",
    time: { kind: "instant" as const, atMs: 1_100 },
    category: "bb-job" as const,
    status: "started" as const,
    title: "Job started",
    detail: null,
    provenance: { kind: "bb-background-job" as const, jobId: "job-1", attempt: 0 },
    bbReference: { projectId: "proj_123", threadId: "thr_123" },
  };
  const secondEvent = { ...firstEvent, eventId: "job-2", time: { kind: "interval" as const, startMs: 1_200, endMs: 1_220 }, title: "Job finished" };
  assert.equal(store.appendTimelineEvent(host, secondEvent).outcome, "inserted");
  assert.equal(store.appendTimelineEvent(host, firstEvent).outcome, "inserted");
  assert.equal(store.appendTimelineEvent(host, firstEvent).outcome, "duplicate");
  assert.throws(() => store.appendTimelineEvent(host, { ...firstEvent, title: "different" }), /reused with a different payload/);
  const lane = store.timelineEvents(host, 1_000, 1_300, 1);
  assert.equal(lane.totalCount, 2);
  assert.equal(lane.truncated, true);
  assert.deepEqual(lane.events.map((event) => event.eventId), ["job-1"]);

  db.prepare(`INSERT INTO machine_monitor_reference_outbox
    (singleton, slot, revision, mutation_id, expected_remote_revision, payload_json, payload_digest,
     attempts, next_attempt_at, lease_until, last_error, error_kind, updated_at)
    VALUES (1, 'pending', 1, 'keep-outbox', 0, '{}', ?, 0, 0, NULL, NULL, NULL, 0)`)
    .run("a".repeat(64));
  const result = store.prune(1_250);
  assert.equal(result.events, 2);
  assert.deepEqual(store.timelineEvents(host, 0, 2_000).events, []);
  assert.equal(store.machine(host)?.connection, "disconnected", "offline registry summary survives retention");
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM machine_monitor_reference_outbox").get() as { count: number }).count, 1);
  const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'machine_monitor_fleet_%_machine_time' ORDER BY name").all() as Array<{ name: string }>;
  assert.deepEqual(indexes.map((index) => index.name), [
    "machine_monitor_fleet_collections_machine_time",
    "machine_monitor_fleet_directory_details_machine_time",
    "machine_monitor_fleet_errors_machine_time",
    "machine_monitor_fleet_events_machine_time",
    "machine_monitor_fleet_memory_details_machine_time",
    "machine_monitor_fleet_memory_observations_machine_time",
    "machine_monitor_fleet_metric_values_machine_time",
  ]);
});
