import assert from "node:assert/strict";
import test from "node:test";

import {
  assertFleetPerformanceFixture,
  createFleetPerformanceFixture,
  FLEET_PERFORMANCE_BUCKETS_PER_TRACK,
  FLEET_PERFORMANCE_CORE_TRACKS,
  FLEET_PERFORMANCE_FIXTURE_FINGERPRINT,
  FLEET_PERFORMANCE_MACHINE_COUNT,
  FLEET_PERFORMANCE_SELECTED_EVENT_COUNT,
  FLEET_PERFORMANCE_SELECTED_MACHINE_ID,
} from "./fixtures/fleet-performance.fixture.ts";

test("latency fixture preflight pins 32 machines, 720 core buckets, 500 selected events, and its content fingerprint", () => {
  const fixture = createFleetPerformanceFixture();
  assertFleetPerformanceFixture(fixture);
  assert.equal(fixture.fixtureFingerprint, FLEET_PERFORMANCE_FIXTURE_FINGERPRINT);
  assert.equal(fixture.machines().length, FLEET_PERFORMANCE_MACHINE_COUNT);
  const selected = fixture.timelineFor(FLEET_PERFORMANCE_SELECTED_MACHINE_ID);
  assert.equal((selected.events as { events: unknown[] }).events.length, FLEET_PERFORMANCE_SELECTED_EVENT_COUNT);
  assert.deepEqual((selected.metrics as Array<{ metricId: string; buckets: unknown[] }>).map((metric) => [metric.metricId, metric.buckets.length]),
    FLEET_PERFORMANCE_CORE_TRACKS.map((metricId) => [metricId, FLEET_PERFORMANCE_BUCKETS_PER_TRACK]));
});

test("fixture-sized detail payloads retain only an 8 MiB LRU working set", () => {
  const fixture = createFleetPerformanceFixture();
  assertFleetPerformanceFixture(fixture);
  const maxTimelineBytes = 8 * 1024 * 1024;
  const encoder = new TextEncoder();
  const resident: Array<{ machineId: string; bytes: number }> = [];
  let residentBytes = 0;
  const machines = fixture.machines();
  for (const machine of machines) {
    const bytes = encoder.encode(JSON.stringify(fixture.timelineFor(machine.machine.machineId))).byteLength;
    while (residentBytes + bytes > maxTimelineBytes && resident.length > 0) residentBytes -= resident.shift()!.bytes;
    if (bytes <= maxTimelineBytes) {
      resident.push({ machineId: machine.machine.machineId, bytes });
      residentBytes += bytes;
    }
  }
  assert.ok(residentBytes <= maxTimelineBytes, `fixture cache working set exceeded 8 MiB: ${residentBytes}`);
  assert.ok(resident.length < FLEET_PERFORMANCE_MACHINE_COUNT,
    "the full 32-machine fixture unexpectedly fits in the bounded detail cache");
  assert.equal(resident.at(-1)?.machineId, machines.at(-1)?.machine.machineId,
    "the newest fixture detail must remain resident after bounded LRU eviction");
});
