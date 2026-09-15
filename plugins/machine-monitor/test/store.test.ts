import assert from "node:assert/strict";
import test from "node:test";

import Database from "better-sqlite3";

import { FleetStore } from "../fleet-store.ts";
import { LOCAL_BB_SERVER_MACHINE_ID } from "../fleet-contract.ts";
import { MachineMonitorStore, machineMonitorMigrations } from "../store.ts";

const LEGACY_MIGRATION_COUNT = 15;

test("append-only fleet migrations bind retained local history to the reserved server identity", (t) => {
  const db = new Database(":memory:");
  t.after(() => db.close());
  for (const migration of machineMonitorMigrations.slice(0, LEGACY_MIGRATION_COUNT)) db.exec(migration);
  db.prepare(`INSERT INTO machine_samples
    (collected_at, cpu_percent, memory_used_bytes, memory_total_bytes, disk_used_bytes, disk_total_bytes, load1, load5)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(100, 25, 300, 1_000, 500, 2_000, 1, 2);
  db.prepare(`INSERT INTO directory_samples (collected_at, location, bytes, on_root_filesystem, partial)
    VALUES (?, ?, ?, ?, ?)`).run(110, "bun", 700, 1, 0);
  db.prepare(`INSERT INTO memory_diagnostics
    (collected_at, sample_interval_ms, pressure_some_percent, pressure_full_percent,
     swap_in_pages_per_second, swap_out_pages_per_second, refault_pages_per_second,
     reclaim_pages_per_second, bb_cgroup_memory_bytes, processes_json, process_details_collected_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(120, 30_000, 1, 0, 2, 3, 4, 5, 6, "[]", null);
  for (const migration of machineMonitorMigrations.slice(LEGACY_MIGRATION_COUNT)) db.exec(migration);

  const store = new FleetStore(db);
  const local = store.localMachine();
  assert.deepEqual(local.machine, { source: "local-bb-server", machineId: LOCAL_BB_SERVER_MACHINE_ID });
  assert.equal(local.connection, "local");
  assert.equal(local.latestCollectedAtMs, 120);
  assert.equal(local.generation.dataRevision, 1);
  assert.deepEqual(store.metricValues(local.machine, 0, 200).map((value) => [value.atMs, value.observation.metricId, value.observation.value]), [
    [100, "cpu.utilization.percent", 25],
    [100, "disk.root.total.bytes", 2_000],
    [100, "disk.root.used.bytes", 500],
    [100, "load.1", 1],
    [100, "load.5", 2],
    [100, "memory.total.bytes", 1_000],
    [100, "memory.used.bytes", 300],
    [120, "memory.pressure.full.percent", 0],
    [120, "memory.pressure.some.percent", 1],
    [120, "memory.swap.in.pages-per-second", 2],
    [120, "memory.swap.out.pages-per-second", 3],
  ]);
  assert.deepEqual(store.directoryDetails(local.machine, 0, 200), [{ collectedAt: 110, location: "bun", bytes: 700, onRootFilesystem: true, partial: false }]);
  assert.equal(store.memoryDetails(local.machine, 0, 200)[0]?.bbCgroupMemoryBytes, 6);
  const memoryObservationColumns = (db.prepare("PRAGMA table_info(machine_monitor_fleet_memory_observations)").all() as Array<{ name: string }>)
    .map((column) => column.name);
  assert.equal(memoryObservationColumns.some((column) => /process/i.test(column)), false,
    "the normalized metric observation table never carries process payload fields");
  assert.deepEqual(memoryObservationColumns.filter((column) => /pressure|swap/.test(column)), [
    "pressure_some_percent",
    "pressure_full_percent",
    "swap_in_pages_per_second",
    "swap_out_pages_per_second",
  ]);
});

test("the legacy local store remains usable after fleet migrations", (t) => {
  const db = new Database(":memory:");
  t.after(() => db.close());
  for (const migration of machineMonitorMigrations) db.exec(migration);
  const store = new MachineMonitorStore(db);
  store.insert({
    collectedAt: 100,
    cpuPercent: 40,
    memoryUsedBytes: 2,
    memoryTotalBytes: 4,
    diskUsedBytes: 3,
    diskTotalBytes: 6,
    load1: 0.5,
    load5: 0.25,
  });
  assert.deepEqual(store.latest(), {
    collectedAt: 100,
    cpuPercent: 40,
    memoryUsedBytes: 2,
    memoryTotalBytes: 4,
    diskUsedBytes: 3,
    diskTotalBytes: 6,
    load1: 0.5,
    load5: 0.25,
  });
});
