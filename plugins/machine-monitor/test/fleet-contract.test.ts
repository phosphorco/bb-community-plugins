import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  FLEET_CONTRACT_VERSION,
  FLEET_ATTACHMENT_SNAPSHOT_VERSION,
  FLEET_METRIC_CATALOG,
  LOCAL_BB_SERVER_MACHINE_ID,
  MAX_TIMELINE_BUCKETS,
  MAX_TIMELINE_GAPS,
  TIMELINE_EVENT_PRODUCER_CONTRACT_VERSION,
  bindCollectionToMachine,
  collectionEnvelopeSchema,
  fleetAttachmentSnapshotSchema,
  fleetInvalidationSignalSchema,
  fleetOverviewResultSchema,
  machineTimelineRequestKey,
  machineTimelineRequestSchema,
  machineTimelineResultSchema,
  timelineEventLaneSchema,
  timelineEventSchema,
} from "../fleet-contract.ts";
import { hostCoreSampleSchema } from "../host-contract.ts";
import { fleetRpcSchemas } from "../rpc-contract.ts";

const availability = { state: "available" as const, reason: null };
const generation = { dataRevision: 7, settingsRevision: 3 };

function corePayload() {
  return {
    contractVersion: FLEET_CONTRACT_VERSION,
    collectorSessionId: "session-1",
    sequence: 4,
    hostObservedAtMs: 1_000,
    metrics: [{ metricId: "cpu.utilization.percent" as const, value: 42, availability }],
  };
}

function event(eventId: string, atMs: number) {
  return {
    contractVersion: FLEET_CONTRACT_VERSION,
    producer: { id: "bb-background-jobs", version: 1 },
    eventId,
    time: { kind: "instant" as const, atMs },
    category: "bb-job" as const,
    status: "succeeded" as const,
    title: "Background job completed",
    detail: null,
    provenance: { kind: "bb-background-job" as const, jobId: "job-1", attempt: 0 },
    bbReference: { projectId: "project_1", threadId: "thr_1" },
  };
}

function intervalEvent(eventId: string, startMs: number, endMs: number) {
  return { ...event(eventId, startMs), time: { kind: "interval" as const, startMs, endMs } };
}

function timeline() {
  return {
    contractVersion: FLEET_CONTRACT_VERSION,
    machine: { source: "local-bb-server" as const, machineId: LOCAL_BB_SERVER_MACHINE_ID as typeof LOCAL_BB_SERVER_MACHINE_ID },
    generation,
    range: { startMs: 0, endMs: 60 },
    bucket: { alignment: "range-start" as const, widthMs: 30, count: 2 },
    coverage: { state: "complete" as const, firstObservedAtMs: 10, lastObservedAtMs: 50, retainedFromMs: 0, retainedToMs: 60 },
    timeNormalization: {
      basis: "local-observation" as const,
      sampleCount: 4,
      rawHostObservedRange: { firstMs: 10, lastMs: 50 },
      normalizedRange: { firstMs: 10, lastMs: 50 },
      maxClockUncertaintyMs: 0,
    },
    metrics: [{
      metricId: "cpu.utilization.percent" as const,
      availability,
      buckets: [
        { startMs: 0, endMs: 30, min: 20, average: 25, max: 30, last: 27, count: 2 },
        { startMs: 30, endMs: 60, min: 32, average: 35, max: 40, last: 36, count: 2 },
      ],
    }],
    gaps: [],
    events: { events: [event("event-1", 15)], totalCount: 1, truncated: false },
  };
}

test("a host payload cannot select its fleet identity", () => {
  const payload = corePayload();
  assert.equal(hostCoreSampleSchema.safeParse(payload).success, true);
  assert.equal(hostCoreSampleSchema.safeParse({ ...payload, machine: { source: "enrolled-host", machineId: "forged-host" } }).success, false);

  const envelope = bindCollectionToMachine(
    { source: "enrolled-host", machineId: "authenticated-host" },
    payload,
    { serverSentAtMs: 1_010, serverReceivedAtMs: 1_030, normalizedAtMs: 1_020, clockUncertaintyMs: 10 },
  );
  assert.equal(envelope.machine.machineId, "authenticated-host");
  assert.equal(collectionEnvelopeSchema.safeParse({ ...envelope, serverReceivedAtMs: 1_009 }).success, false);
});

test("the trusted metric boundary rejects unknown metrics and renderer configuration", () => {
  const payload = corePayload();
  assert.equal(hostCoreSampleSchema.safeParse({
    ...payload,
    metrics: [{ metricId: "made.up.metric", value: 1, availability }],
  }).success, false);
  assert.equal(hostCoreSampleSchema.safeParse({ ...payload, echarts: { series: [] } }).success, false);
});

test("a timeline is generation-keyed, bucket-complete, and preserves exact event references", () => {
  const result = timeline();
  assert.deepEqual(machineTimelineResultSchema.parse(result).events.events[0]?.bbReference, { projectId: "project_1", threadId: "thr_1" });

  const request = {
    contractVersion: FLEET_CONTRACT_VERSION,
    machine: result.machine,
    range: result.range,
    generation,
  };
  assert.equal(machineTimelineRequestSchema.safeParse(request).success, true);
  assert.equal(machineTimelineRequestKey(request), "1|local-bb-server:local-bb-server|0|60|d7:s3");

  const missingBucket = timeline();
  missingBucket.metrics[0]!.buckets.pop();
  assert.equal(machineTimelineResultSchema.safeParse(missingBucket).success, false);
});

test("gap capacity is exactly the catalog-by-bucket worst case, without a hidden 512 cut-off", () => {
  assert.equal(MAX_TIMELINE_GAPS, FLEET_METRIC_CATALOG.length * MAX_TIMELINE_BUCKETS);
  const gaps = [...FLEET_METRIC_CATALOG]
    .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
    .flatMap((metric) => Array.from({ length: 60 }, (_, index) => ({
      metricId: metric.id,
      startMs: 0,
      endMs: index + 1,
      reason: "no-samples" as const,
    })));
  assert.ok(gaps.length > 512);
  assert.equal(machineTimelineResultSchema.safeParse({ ...timeline(), gaps }).success, true);
});

test("timeline normalization preserves raw skew and constrains normalized coverage", () => {
  const remote = {
    ...timeline(),
    machine: { source: "enrolled-host" as const, machineId: "authenticated-host" },
    timeNormalization: {
      basis: "remote-server-request-midpoint" as const,
      sampleCount: 4,
      rawHostObservedRange: { firstMs: 9_000_000, lastMs: 9_000_040 },
      normalizedRange: { firstMs: 10, lastMs: 50 },
      maxClockUncertaintyMs: 42,
    },
  };
  assert.deepEqual(machineTimelineResultSchema.parse(remote).timeNormalization.rawHostObservedRange, { firstMs: 9_000_000, lastMs: 9_000_040 });

  const outsideRange = {
    ...remote,
    coverage: { ...remote.coverage, lastObservedAtMs: 61 },
    timeNormalization: { ...remote.timeNormalization, normalizedRange: { firstMs: 10, lastMs: 61 } },
  };
  assert.equal(machineTimelineResultSchema.safeParse(outsideRange).success, false);
  const emptyNormalization = {
    ...timeline(),
    timeNormalization: {
      basis: "local-observation" as const,
      sampleCount: 0,
      rawHostObservedRange: { firstMs: null, lastMs: null },
      normalizedRange: { firstMs: null, lastMs: null },
      maxClockUncertaintyMs: null,
    },
  };
  assert.equal(machineTimelineResultSchema.safeParse(emptyNormalization).success, false);
});

test("event lanes are bounded, ordered, and reject duplicate producer/event identities", () => {
  assert.equal(timelineEventLaneSchema.safeParse({
    events: [event("event-2", 20), event("event-1", 10)], totalCount: 2, truncated: false,
  }).success, false);
  assert.equal(timelineEventLaneSchema.safeParse({
    events: [event("event-1", 10), event("event-1", 20)], totalCount: 2, truncated: false,
  }).success, false);
});

test("timeline event producers have an explicit v1-only compatibility boundary", () => {
  assert.equal(TIMELINE_EVENT_PRODUCER_CONTRACT_VERSION, 1);
  assert.equal(timelineEventSchema.safeParse(event("producer-v1", 10)).success, true);
  assert.equal(timelineEventSchema.safeParse({
    ...event("producer-v2", 10),
    producer: { id: "bb-background-jobs", version: 2 },
  }).success, false);
  assert.equal(timelineEventSchema.safeParse({
    ...event("producer-zero", 10),
    producer: { id: "bb-background-jobs", version: 0 },
  }).success, false);
  assert.equal(timelineEventSchema.safeParse({
    ...event("producer-fraction", 10),
    producer: { id: "bb-background-jobs", version: 1.1 },
  }).success, false);
});

test("timeline intervals retain exact boundary-spanning truth while instants stay in range", () => {
  const overlapping = { ...timeline(), events: { events: [intervalEvent("event-spanning", 30, 75)], totalCount: 1, truncated: false } };
  assert.equal(machineTimelineResultSchema.safeParse(overlapping).success, true);
  const outsideInterval = { ...timeline(), events: { events: [intervalEvent("event-outside", 61, 75)], totalCount: 1, truncated: false } };
  assert.equal(machineTimelineResultSchema.safeParse(outsideInterval).success, false);
  const outsideInstant = { ...timeline(), events: { events: [event("event-instant-outside", 61)], totalCount: 1, truncated: false } };
  assert.equal(machineTimelineResultSchema.safeParse(outsideInstant).success, false);
});

test("fleet overview keeps manual attachments at fleet scope and fleet RPCs stay separate", () => {
  const overview = {
    contractVersion: FLEET_CONTRACT_VERSION,
    generatedAtMs: 100,
    generation,
    machines: [{
      machine: { source: "local-bb-server" as const, machineId: LOCAL_BB_SERVER_MACHINE_ID },
      label: "BB server",
      connection: "local" as const,
      freshness: "fresh" as const,
      latestCollectedAtMs: 100,
      lastError: null,
      capabilities: ["core-sampling"],
      latestMetrics: [],
      warnings: [],
      generation,
    }],
    attachments: {
      scope: "fleet" as const,
      snapshot: {
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
      },
    },
  };
  assert.equal(fleetOverviewResultSchema.safeParse(overview).success, true);
  assert.equal(fleetRpcSchemas.fleetOverview.input.safeParse({ contractVersion: FLEET_CONTRACT_VERSION }).success, true);
  assert.equal(fleetRpcSchemas.machineTimeline.input.safeParse({
    contractVersion: FLEET_CONTRACT_VERSION,
    machine: overview.machines[0]!.machine,
    range: { startMs: 0, endMs: 60 },
    generation: null,
  }).success, true);
});

test("fleet attachment snapshots stay browser-safe and retain the frozen attachment boundary", () => {
  assert.equal(FLEET_ATTACHMENT_SNAPSHOT_VERSION, 1);
  const snapshot = {
    sourceRevision: 2,
    targets: [{
      provider: "bb",
      keys: { project: "project_1", thread: "thread_1" },
      presentation: { label: "Investigate collector failure", detail: "Fleet remediation", url: "/threads/thread_1" },
    }],
    status: {
      state: "synced" as const,
      sourceRevision: 2,
      desiredRevision: 2,
      lastAckedRevision: 2,
      pending: false,
      inFlight: false,
      attempts: 0,
      nextAttemptAt: null,
      lastError: null,
      errorKind: null,
    },
  };
  assert.equal(fleetAttachmentSnapshotSchema.safeParse(snapshot).success, true);
  assert.equal(fleetAttachmentSnapshotSchema.safeParse({
    ...snapshot,
    targets: [{ ...snapshot.targets[0], provider: "BB", extra: "not allowed" }],
  }).success, false);
  assert.equal(fleetAttachmentSnapshotSchema.safeParse({
    ...snapshot,
    targets: [{ ...snapshot.targets[0], keys: { project: "project_1", thread: "thread_1", extra: "x" } }],
  }).success, false);

  // Importing this schema from a React surface must never pull node:crypto
  // through attachment projection/canonicalization code.
  const source = readFileSync(new URL("../fleet-contract.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /from\s+["']\.\/attachment-contract\.ts["']/);
});

test("fleet realtime invalidations reject malformed or unallowlisted bounded payloads", () => {
  const valid = {
    machine: { source: "enrolled-host" as const, machineId: "host-1" },
    dataRevision: 2,
    settingsRevision: 3,
    kinds: ["collection", "settings"],
  };
  assert.equal(fleetInvalidationSignalSchema.safeParse(valid).success, true);
  assert.equal(fleetInvalidationSignalSchema.safeParse({ ...valid, kinds: ["made-up"] }).success, false);
  assert.equal(fleetInvalidationSignalSchema.safeParse({ ...valid, kinds: [] }).success, false);
  assert.equal(fleetInvalidationSignalSchema.safeParse({ ...valid, kinds: ["collection", "collection"] }).success, false);
  assert.equal(fleetInvalidationSignalSchema.safeParse({ ...valid, unexpected: true }).success, false);
});
