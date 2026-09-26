import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";

import {
  AnalyticsCursorExpiredError,
  AnalyticsSnapshotProvider,
  type AnalyticsDeltaPage,
  type TrustedAnalyticsDeltaSource,
} from "../../snapshot-provider.ts";
import { AnalyticsStore, analyticsMigrations } from "../../store.ts";

function store(): { db: Database.Database; store: AnalyticsStore } {
  const db = new Database(":memory:");
  for (const migration of analyticsMigrations) db.exec(migration);
  return { db, store: new AnalyticsStore(db) };
}

const coverage = {
  asOfMs: 10_000_000_000, retainedAfterMs: 10_000_000_000 - 8 * 86_400_000,
  earliestRetainedInclusiveMs: 10_000_000_000 - 8 * 86_400_000, resetWatermark: "journal-100",
  sourceComplete: true, incompleteReasons: [],
} as const;

function page(input: Partial<AnalyticsDeltaPage> = {}): AnalyticsDeltaPage {
  return { sourceGeneration: "journal-a", nextCursor: "cursor-1", exhausted: true, responseBytes: 120, events: [], coverage, ...input };
}

test("incremental cursors publish immutable data once and share it across consumers", async () => {
  const { db, store: analytics } = store();
  let calls = 0;
  let now = 10_000_000_000;
  const source: TrustedAnalyticsDeltaSource = {
    readDelta: async ({ cursor }) => {
      calls++;
      return cursor === null
        ? page({ events: [{ id: "event-1", operation: "upsert", fact: { metric: "tool", count: 1 } }] })
        : page({ nextCursor: "cursor-2" });
    },
  };
  const provider = new AnalyticsSnapshotProvider({ source, store: analytics, clock: () => now, limits: { minimumIntervalMs: 1 } });
  try {
    const first = await provider.collect({ dataset: "tool-execution-v1", sourceScope: "scope-a", factProjectionVersion: 1 });
    assert.equal(first.status, "published");
    if (first.status !== "published") return;
    assert.equal(first.snapshot.generationId, 1);
    assert.equal(first.snapshot.coverage.fastPathCoverage, "complete");
    assert.deepEqual(first.snapshot.facts, [{ id: "event-1", metric: "tool", count: 1 }]);
    const lease = provider.readSnapshot({ dataset: "tool-execution-v1", sourceScope: "scope-a" });
    assert.ok(lease);
    assert.throws(() => { (lease!.snapshot.facts as Array<unknown>).push("mutate"); }, /extensible|read only|frozen/i);
    provider.releaseSnapshot(lease!.leaseId);
    now++;
    const second = await provider.collect({ dataset: "tool-execution-v1", sourceScope: "scope-a", factProjectionVersion: 1 });
    assert.equal(second.status, "unchanged");
    assert.equal(second.snapshot?.snapshotId, first.snapshot.snapshotId);
    assert.equal(calls, 2, "one shared collector is independent of viewer count");
    assert.equal(analytics.readAnalyticsSnapshotCursor({ dataset: "tool-execution-v1", sourceScope: "scope-a" }), "cursor-2");
  } finally { db.close(); }
});

test("failure and cancellation preserve the durable cursor and last good snapshot", async () => {
  const { db, store: analytics } = store();
  let mode: "good" | "bad" | "hang" = "good";
  let now = 10_000_000_000;
  const source: TrustedAnalyticsDeltaSource = {
    readDelta: async ({ signal }) => {
      if (mode === "bad") throw new Error("source unavailable");
      if (mode === "hang") await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      return page({ events: [{ id: "event-1", operation: "upsert", fact: { metric: "tool" } }] });
    },
  };
  const provider = new AnalyticsSnapshotProvider({ source, store: analytics, clock: () => now, limits: { minimumIntervalMs: 1 } });
  try {
    await provider.collect({ dataset: "tool-execution-v1", sourceScope: "scope-a", factProjectionVersion: 1 });
    const before = analytics.readAnalyticsSnapshotCursor({ dataset: "tool-execution-v1", sourceScope: "scope-a" });
    mode = "bad";
    now++;
    const failed = await provider.collect({ dataset: "tool-execution-v1", sourceScope: "scope-a", factProjectionVersion: 1 });
    assert.equal(failed.status, "failed");
    assert.equal(failed.snapshot?.rowCount, 1);
    assert.equal(analytics.readAnalyticsSnapshotCursor({ dataset: "tool-execution-v1", sourceScope: "scope-a" }), before);
    mode = "hang";
    now++;
    const abort = new AbortController();
    const collecting = provider.collect({ dataset: "tool-execution-v1", sourceScope: "scope-a", factProjectionVersion: 1, signal: abort.signal });
    abort.abort(new Error("test cancellation"));
    assert.equal((await collecting).status, "cancelled");
    assert.equal(analytics.readAnalyticsSnapshotCursor({ dataset: "tool-execution-v1", sourceScope: "scope-a" }), before);
  } finally { db.close(); }
});

test("cursor expiry stops invalid retries; an explicit full reset atomically replaces the old epoch", async () => {
  const { db, store: analytics } = store();
  let now = 10_000_000_000;
  let phase: "initial" | "expired" | "outage" | "rebuild" = "initial";
  let calls = 0;
  const resetCoverage = { ...coverage, resetWatermark: "journal-reset-watermark" };
  const source: TrustedAnalyticsDeltaSource = {
    readDelta: async ({ cursor }) => {
      calls++;
      if (phase === "expired") throw new AnalyticsCursorExpiredError("journal-reset", "reset-start", "journal retention expired");
      if (phase === "outage") throw new Error("source outage during reset");
      if (phase === "initial") return page({ events: [{ id: "legacy", operation: "upsert", fact: { value: "old" } }] });
      if (cursor === "reset-start") return page({
        sourceGeneration: "journal-reset", nextCursor: "reset-next", exhausted: false,
        events: [{ id: "fresh", operation: "upsert", fact: { value: "new" } }], coverage: resetCoverage,
      });
      return page({
        sourceGeneration: "journal-reset", nextCursor: "reset-done", exhausted: true,
        // A backfill may include a tombstone, but reset starts empty so it
        // cannot retain any fact from the old cursor epoch.
        events: [{ id: "legacy", operation: "delete" }], coverage: resetCoverage,
      });
    },
  };
  const provider = new AnalyticsSnapshotProvider({ source, store: analytics, clock: () => now, limits: { minimumIntervalMs: 1 } });
  try {
    const initial = await provider.collect({ dataset: "tool-execution-v1", sourceScope: "scope-a", factProjectionVersion: 1 });
    assert.equal(initial.status, "published");
    const oldCursor = analytics.readAnalyticsSnapshotCursor({ dataset: "tool-execution-v1", sourceScope: "scope-a" });
    phase = "expired";
    now++;
    const expired = await provider.collect({ dataset: "tool-execution-v1", sourceScope: "scope-a", factProjectionVersion: 1 });
    assert.equal(expired.status, "reset-required");
    assert.equal(analytics.readAnalyticsSnapshotCursor({ dataset: "tool-execution-v1", sourceScope: "scope-a" }), oldCursor);
    assert.deepEqual(analytics.readAnalyticsSnapshotReset({ dataset: "tool-execution-v1", sourceScope: "scope-a" }), {
      sourceGeneration: "journal-reset", cursor: "reset-start", requestedAtMs: now, error: "journal retention expired",
    });
    now++;
    const beforeRetry = calls;
    assert.equal((await provider.collect({ dataset: "tool-execution-v1", sourceScope: "scope-a", factProjectionVersion: 1 })).status, "reset-required");
    assert.equal(calls, beforeRetry, "pending reset never retries the expired cursor");
    phase = "outage";
    now++;
    const failedReset = await provider.rebuild({ dataset: "tool-execution-v1", sourceScope: "scope-a", factProjectionVersion: 1 });
    assert.equal(failedReset.status, "failed");
    assert.deepEqual(failedReset.snapshot?.facts, [{ id: "legacy", value: "old" }], "outage preserves the last good snapshot");
    assert.ok(analytics.readAnalyticsSnapshotReset({ dataset: "tool-execution-v1", sourceScope: "scope-a" }), "failed rebuild remains explicitly pending");
    phase = "rebuild";
    now++;
    const rebuilt = await provider.rebuild({ dataset: "tool-execution-v1", sourceScope: "scope-a", factProjectionVersion: 1 });
    assert.equal(rebuilt.status, "published");
    assert.deepEqual(rebuilt.status === "published" ? rebuilt.snapshot.facts : [], [{ id: "fresh", value: "new" }]);
    assert.equal(analytics.readAnalyticsSnapshotCursor({ dataset: "tool-execution-v1", sourceScope: "scope-a" }), "reset-done");
    assert.equal(analytics.readAnalyticsSnapshotReset({ dataset: "tool-execution-v1", sourceScope: "scope-a" }), null);
  } finally { db.close(); }
});

test("incremental tombstones remove only the named fact", async () => {
  const { db, store: analytics } = store();
  let now = 10_000_000_000;
  let pass = 0;
  const source: TrustedAnalyticsDeltaSource = {
    readDelta: async () => page({ responseBytes: 512, events: pass++ === 0
      ? [
        { id: "event-1", operation: "upsert", fact: { metric: "one" } },
        { id: "event-2", operation: "upsert", fact: { metric: "two" } },
      ]
      : [{ id: "event-1", operation: "delete" }],
    }),
  };
  const provider = new AnalyticsSnapshotProvider({ source, store: analytics, clock: () => now, limits: { minimumIntervalMs: 1 } });
  try {
    assert.equal((await provider.collect({ dataset: "tool-execution-v1", sourceScope: "scope-a", factProjectionVersion: 1 })).status, "published");
    now++;
    const result = await provider.collect({ dataset: "tool-execution-v1", sourceScope: "scope-a", factProjectionVersion: 1 });
    assert.equal(result.status, "published");
    assert.deepEqual(result.status === "published" ? result.snapshot.facts : [], [{ id: "event-2", metric: "two" }]);
  } finally { db.close(); }
});

test("provider rejects feature datasets and unsafe fact authority fields", async () => {
  const { db, store: analytics } = store();
  const source: TrustedAnalyticsDeltaSource = { readDelta: async () => page({ events: [{ id: "event-1", operation: "upsert", fact: { filePath: "/operational/db" } }] }) };
  const provider = new AnalyticsSnapshotProvider({ source, store: analytics, clock: () => 10_000_000_000 });
  try {
    await assert.rejects(provider.collect({ dataset: "feature-local", sourceScope: "scope-a", factProjectionVersion: 1 }), /allowlisted/);
    const result = await provider.collect({ dataset: "tool-execution-v1", sourceScope: "scope-a", factProjectionVersion: 1 });
    assert.equal(result.status, "failed");
    assert.match(result.error, /forbidden field/i);
  } finally { db.close(); }
});

test("pinned generations block collection before the hard generation allowance is exceeded", async () => {
  const { db, store: analytics } = store();
  let now = 10_000_000_000;
  let sourceGeneration = "journal-a";
  let eventId = "event-1";
  const source: TrustedAnalyticsDeltaSource = {
    readDelta: async () => page({
      sourceGeneration,
      events: [{ id: eventId, operation: "upsert", fact: { metric: "tool" } }],
    }),
  };
  const provider = new AnalyticsSnapshotProvider({
    source, store: analytics, clock: () => now,
    limits: { minimumIntervalMs: 1, maxRetainedGenerations: 1, maxRetainedBytes: 1024 * 1024 },
  });
  try {
    assert.equal((await provider.collect({ dataset: "tool-execution-v1", sourceScope: "scope-a", factProjectionVersion: 1 })).status, "published");
    const lease = provider.readSnapshot({ dataset: "tool-execution-v1", sourceScope: "scope-a" });
    assert.ok(lease);
    now++;
    sourceGeneration = "journal-b";
    eventId = "event-2";
    const blocked = await provider.collect({ dataset: "tool-execution-v1", sourceScope: "scope-a", factProjectionVersion: 1 });
    assert.equal(blocked.status, "retention-blocked");
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM analytics_snapshot_generations_v1").get() as { count: number }).count, 1, "a live lease prevents retention overshoot");
    provider.releaseSnapshot(lease!.leaseId);
    now++;
    assert.equal((await provider.collect({ dataset: "tool-execution-v1", sourceScope: "scope-a", factProjectionVersion: 1 })).status, "published");
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM analytics_snapshot_generations_v1").get() as { count: number }).count, 1, "only confirmed release permits pruning");
  } finally { db.close(); }
});

test("pinned bytes block a replacement without expiring the lease", async () => {
  const { db, store: analytics } = store();
  let now = 10_000_000_000;
  let eventId = "event-1";
  const source: TrustedAnalyticsDeltaSource = {
    readDelta: async () => page({ events: [{ id: eventId, operation: "upsert", fact: { metric: "tool" } }] }),
  };
  const initialProvider = new AnalyticsSnapshotProvider({
    source, store: analytics, clock: () => now,
    limits: { minimumIntervalMs: 1, maxRetainedGenerations: 5, maxRetainedBytes: 1024 * 1024 },
  });
  try {
    const first = await initialProvider.collect({ dataset: "tool-execution-v1", sourceScope: "scope-bytes", factProjectionVersion: 1 });
    assert.equal(first.status, "published");
    if (first.status !== "published") return;
    const lease = initialProvider.readSnapshot({ dataset: "tool-execution-v1", sourceScope: "scope-bytes" });
    assert.ok(lease);
    eventId = "event-2";
    now++;
    const constrainedProvider = new AnalyticsSnapshotProvider({
      source, store: analytics, clock: () => now,
      limits: { minimumIntervalMs: 1, maxRetainedGenerations: 5, maxRetainedBytes: first.snapshot.byteCount },
    });
    const blocked = await constrainedProvider.collect({ dataset: "tool-execution-v1", sourceScope: "scope-bytes", factProjectionVersion: 1 });
    assert.equal(blocked.status, "retention-blocked");
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM analytics_snapshot_generations_v1 WHERE source_scope='scope-bytes'").get() as { count: number }).count, 1);
    // There is deliberately no age-based lease reaper: only the trusted
    // execution exit path may call releaseSnapshot.
    assert.ok(initialProvider.readSnapshot({ dataset: "tool-execution-v1", sourceScope: "scope-bytes" }));
    initialProvider.releaseSnapshot(lease!.leaseId);
  } finally { db.close(); }
});
