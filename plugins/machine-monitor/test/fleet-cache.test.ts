import assert from "node:assert/strict";
import test from "node:test";

import {
  FleetCache,
  fleetOverviewCacheKey,
  fleetTimelineCacheKey,
} from "../fleet-cache.ts";

const hostA = { source: "enrolled-host", machineId: "host-a" } as const;
const hostB = { source: "enrolled-host", machineId: "host-b" } as const;
const generation = { dataRevision: 4, settingsRevision: 2 };
const range = { startMs: 0, endMs: 30_000 };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

test("uses generation-keyed stable cache identities and bounds entries by serialized bytes", async () => {
  assert.equal(fleetTimelineCacheKey(hostA, range, generation), "machine-timeline|enrolled-host:host-a|0|30000|d4:s2");
  assert.equal(fleetOverviewCacheKey(generation), "fleet-overview|d4:s2");

  const cache = new FleetCache({ maxBytes: 16 });
  await cache.getOrLoad("first", { kind: "timeline", machine: hostA }, () => "aaaaaa");
  await cache.getOrLoad("second", { kind: "timeline", machine: hostA }, () => "bbbbbb");
  assert.equal(cache.entryCount, 2);
  assert.equal(cache.get("first"), "aaaaaa", "a read promotes the LRU entry");
  await cache.getOrLoad("third", { kind: "timeline", machine: hostA }, () => "cccccc");
  assert.equal(cache.has("first"), true);
  assert.equal(cache.has("second"), false, "the least-recently-used entry is evicted first");
  assert.equal(cache.has("third"), true);
  assert.ok(cache.byteSize <= 16);
});

test("deduplicates matching work and invalidates only the named machine/detail kind", async () => {
  const cache = new FleetCache({ maxBytes: 1_024 });
  const keyA = fleetTimelineCacheKey(hostA, range, generation);
  const keyB = fleetTimelineCacheKey(hostB, range, generation);
  const overview = fleetOverviewCacheKey(generation);
  const load = deferred<{ id: string }>();
  let calls = 0;
  const first = cache.getOrLoad(keyA, { kind: "timeline", machine: hostA }, () => {
    calls += 1;
    return load.promise;
  });
  const joined = cache.getOrLoad(keyA, { kind: "timeline", machine: hostA }, () => {
    calls += 1;
    return { id: "should-not-run" };
  });
  assert.equal(first, joined);
  assert.equal(calls, 1);
  load.resolve({ id: "host-a" });
  await first;

  await cache.getOrLoad(keyB, { kind: "timeline", machine: hostB }, () => ({ id: "host-b" }));
  await cache.getOrLoad(overview, { kind: "overview" }, () => ({ id: "overview" }));
  cache.invalidateMachine(hostA, "timeline");
  assert.equal(cache.has(keyA), false);
  assert.equal(cache.has(keyB), true);
  assert.equal(cache.has(overview), true);
  cache.invalidateMachine(hostA, "overview");
  assert.equal(cache.has(keyB), true);
  assert.equal(cache.has(overview), false);
});

test("late fulfillment and rejection cannot repopulate or erase a newer generation flight", async () => {
  const cache = new FleetCache({ maxBytes: 1_024 });
  const key = fleetTimelineCacheKey(hostA, range, generation);
  const old = deferred<{ generation: "old" }>();
  const replacement = deferred<{ generation: "new" }>();
  const first = cache.getOrLoad(key, { kind: "timeline", machine: hostA }, () => old.promise);
  cache.invalidateMachine(hostA, "timeline");
  const second = cache.getOrLoad(key, { kind: "timeline", machine: hostA }, () => replacement.promise);
  old.resolve({ generation: "old" });
  await first;
  assert.equal(cache.has(key), false, "an obsolete fulfillment cannot cache stale data");
  assert.equal(cache.inFlightCount, 1, "an obsolete settlement cannot remove the replacement flight");
  replacement.resolve({ generation: "new" });
  assert.deepEqual(await second, { generation: "new" });
  assert.deepEqual(cache.get(key), { generation: "new" });

  const rejected = deferred<{ generation: "rejected" }>();
  const newest = deferred<{ generation: "newest" }>();
  const rejectionFlight = cache.getOrLoad("rejection", { kind: "timeline", machine: hostA }, () => rejected.promise);
  cache.invalidateMachine(hostA, "timeline");
  const newestFlight = cache.getOrLoad("rejection", { kind: "timeline", machine: hostA }, () => newest.promise);
  rejected.reject(new Error("obsolete failure"));
  await assert.rejects(rejectionFlight, /obsolete failure/);
  assert.equal(cache.inFlightCount, 1, "an obsolete rejection cannot erase the replacement flight");
  newest.resolve({ generation: "newest" });
  assert.deepEqual(await newestFlight, { generation: "newest" });
  assert.deepEqual(cache.get("rejection"), { generation: "newest" });
});
