import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";

import type { ToolExecutionFact } from "../fact-projection.ts";
import {
  AnalyticsRefreshCoordinator,
  AnalyticsStore,
  analyticsMigrations,
} from "../store.ts";

function facts(count: number): ToolExecutionFact[] {
  const now = Date.now();
  return Array.from({ length: count }, (_, index) => ({
    sourceEventId: `event-${index}`,
    threadId: `thread-${index % 80}`,
    turnId: `turn-${index % 400}`,
    sequence: index,
    projectId: `project-${index % 4}`,
    providerId: `provider-${index % 3}`,
    createdAtMs: now - (index % 14) * 3_600_000,
    capabilityKind: "tool" as const,
    capabilityKey: `bb:tool_${index % 24}`,
    status: index % 17 === 0 ? "failed" as const : "completed" as const,
    durationMs: index % 10_000,
    failed: index % 17 === 0,
    errorClass: index % 17 === 0 ? "network" : null,
    errorSignature: index % 17 === 0 ? "0123456789abcdef" : null,
  }));
}

test("atomically replaces and serializes a bounded 25k-fact snapshot", (context) => {
  const db = new Database(":memory:");
  context.after(() => db.close());
  for (const migration of analyticsMigrations) db.exec(migration);
  const store = new AnalyticsStore(db);

  const loadStarted = performance.now();
  store.replaceFacts(facts(25_000));
  const loadElapsed = performance.now() - loadStarted;
  assert.ok(loadElapsed < 2_000, `25k SQLite fact load took ${loadElapsed.toFixed(1)} ms`);

  const serializeStarted = performance.now();
  const ndjson = store.factsAsNdjson(14);
  const serializeElapsed = performance.now() - serializeStarted;
  assert.equal(ndjson.split("\n").length - 1, 25_000);
  assert.ok(serializeElapsed < 1_000, `25k fact serialization took ${serializeElapsed.toFixed(1)} ms`);
  assert.doesNotMatch(ndjson, /arguments|private output|free-text/);

  store.replaceFacts(facts(10));
  assert.equal(store.factsAsNdjson(14).split("\n").length - 1, 10);
});

test("publishes generation, thread coverage, removals, and facts atomically", (context) => {
  const db = new Database(":memory:");
  context.after(() => db.close());
  for (const migration of analyticsMigrations) db.exec(migration);
  const store = new AnalyticsStore(db);
  const first = facts(2).map((fact, index) => ({ ...fact, threadId: index === 0 ? "keep" : "remove" }));

  store.commitSnapshot({
    completedAt: 1_000,
    durationMs: 10,
    selectedThreadIds: ["keep", "remove"],
    threads: [
      { threadId: "keep", projectId: "project", providerId: "provider", updatedAt: 10, outcome: "loaded", facts: [first[0]!], maxObservedSeq: 3, truncated: false },
      { threadId: "remove", projectId: "project", providerId: "provider", updatedAt: 9, outcome: "loaded", facts: [first[1]!], maxObservedSeq: 2, truncated: true },
    ],
    loadedThreads: 2,
    factCount: 2,
    truncatedThreads: 1,
    degraded: false,
    lastError: null,
    factsChanged: true,
    lastFullReconciliationAt: 1_000,
  });
  assert.equal(store.getIndexState().generationId, 1);
  assert.equal(store.getIndexState().snapshotUpdatedAt, 1_000);
  assert.deepEqual(store.listThreadStates().map((thread) => thread.threadId), ["keep", "remove"]);

  store.commitSnapshot({
    completedAt: 2_000,
    durationMs: 12,
    selectedThreadIds: ["keep"],
    threads: [{ threadId: "keep", projectId: "project", providerId: "provider", updatedAt: 11, outcome: "loaded", facts: [], maxObservedSeq: 4, truncated: false }],
    loadedThreads: 1,
    factCount: 0,
    truncatedThreads: 0,
    degraded: false,
    lastError: null,
    factsChanged: true,
  });
  assert.equal(store.getIndexState().generationId, 2);
  assert.equal(store.factsAsNdjson(90, 3_000), "");
  assert.deepEqual(store.listThreadStates().map((thread) => thread.threadId), ["keep"]);
  assert.equal(store.listThreadStates()[0]?.maxObservedSeq, 4);
});

test("failed rereads preserve prior facts and mark the published snapshot degraded", (context) => {
  const db = new Database(":memory:");
  context.after(() => db.close());
  for (const migration of analyticsMigrations) db.exec(migration);
  const store = new AnalyticsStore(db);
  const prior = facts(1).map((fact) => ({ ...fact, threadId: "thread-1" }));
  store.commitSnapshot({
    completedAt: 1_000,
    durationMs: 1,
    selectedThreadIds: ["thread-1"],
    threads: [{ threadId: "thread-1", projectId: "project", providerId: "provider", updatedAt: 10, outcome: "loaded", facts: prior, maxObservedSeq: 8, truncated: true }],
    loadedThreads: 1,
    factCount: 1,
    truncatedThreads: 1,
    degraded: false,
    lastError: null,
    factsChanged: true,
  });
  store.commitSnapshot({
    completedAt: 2_000,
    durationMs: 1,
    selectedThreadIds: ["thread-1"],
    threads: [{ threadId: "thread-1", projectId: "project", providerId: "provider", updatedAt: 12, outcome: "failed", error: "temporary read failure" }],
    loadedThreads: 1,
    factCount: 1,
    truncatedThreads: 1,
    degraded: true,
    lastError: "temporary read failure",
    factsChanged: false,
  });
  const state = store.getIndexState();
  assert.equal(state.generationId, 1, "preserving prior facts must not invalidate DuckDB caches");
  assert.equal(state.degraded, true);
  assert.equal(state.lastError, "temporary read failure");
  assert.equal(store.factsAsNdjson(90, 3_000).split("\n").length - 1, 1);
  assert.equal(store.listThreadStates()[0]?.lastError, "temporary read failure");
  assert.equal(store.listThreadStates()[0]?.factCount, 1);
  assert.equal(store.listThreadStates()[0]?.updatedAt, 10, "failed source revision must remain retryable");
});

test("a new failed thread keeps an unobserved revision so the next pull retries", (context) => {
  const db = new Database(":memory:");
  context.after(() => db.close());
  for (const migration of analyticsMigrations) db.exec(migration);
  const store = new AnalyticsStore(db);
  store.commitSnapshot({
    completedAt: 1_000,
    durationMs: 1,
    selectedThreadIds: ["new-thread"],
    threads: [{
      threadId: "new-thread",
      projectId: "project",
      providerId: "provider",
      updatedAt: 99,
      outcome: "failed",
      error: "temporary read failure",
    }],
    loadedThreads: 0,
    factCount: 0,
    truncatedThreads: 0,
    degraded: true,
    lastError: "temporary read failure",
    factsChanged: false,
  });
  assert.equal(store.listThreadStates()[0]?.updatedAt, 0);
  assert.equal(store.listThreadStates()[0]?.lastError, "temporary read failure");
});

test("refresh coordinator starts one shared flight for concurrent stale requests", async () => {
  let now = 2_000;
  let snapshotUpdatedAt: number | null = 1_000;
  let calls = 0;
  let release: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const coordinator = new AnalyticsRefreshCoordinator(
    () => ({ snapshotUpdatedAt }),
    async () => {
      calls += 1;
      await pending;
      snapshotUpdatedAt = now;
    },
    () => now,
  );

  coordinator.getOrRefresh(500);
  coordinator.getOrRefresh(500);
  assert.equal(calls, 1);
  assert.equal(coordinator.isRefreshing(), true);
  release?.();
  while (coordinator.isRefreshing()) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(snapshotUpdatedAt, 2_000);
  coordinator.getOrRefresh(500);
  assert.equal(calls, 1);
});

test("strict freshness waits on the same shared refresh flight", async () => {
  let snapshotUpdatedAt: number | null = null;
  let calls = 0;
  let release: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const coordinator = new AnalyticsRefreshCoordinator(
    () => ({ snapshotUpdatedAt }),
    async () => {
      calls += 1;
      await pending;
      snapshotUpdatedAt = 10_000;
    },
    () => 10_000,
  );

  const first = coordinator.waitForRefresh(1_000);
  const second = coordinator.waitForRefresh(1_000);
  assert.equal(calls, 1);
  release?.();
  assert.equal((await first).snapshotUpdatedAt, 10_000);
  assert.equal((await second).snapshotUpdatedAt, 10_000);
});
