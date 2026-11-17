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
