import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";

import {
  RestartResumeStore,
  restartResumeMigrations,
} from "../store.ts";

function makeStore(): { db: Database.Database; store: RestartResumeStore } {
  const db = new Database(":memory:");
  for (const migration of restartResumeMigrations) db.exec(migration);
  return { db, store: new RestartResumeStore(db) };
}

test("project messages are durable and can be cleared", (t) => {
  const { db, store } = makeStore();
  t.after(() => db.close());

  assert.equal(store.getProjectMessage("proj_1"), null);
  store.setProjectMessage("proj_1", "Recover carefully.", 10);
  assert.equal(store.getProjectMessage("proj_1"), "Recover carefully.");
  assert.deepEqual(store.listProjectMessages(), [
    { projectId: "proj_1", message: "Recover carefully." },
  ]);
  store.clearProjectMessage("proj_1");
  assert.equal(store.getProjectMessage("proj_1"), null);
});

test("recovery claims are idempotent, retryable, and terminal", (t) => {
  const { db, store } = makeStore();
  t.after(() => db.close());

  const firstLease = store.claim("th_1", 4, 100, 1_000);
  assert.notEqual(firstLease, null);
  assert.equal(store.claim("th_1", 4, 100, 1_001), null);
  assert.equal(store.getAttempt("th_1", 4)?.attempts, 1);

  assert.equal(store.markRetry("th_1", 4, firstLease!, "host unavailable", 2_000), true);
  assert.equal(store.claim("th_1", 4, 100, 6_999), null);
  const secondLease = store.claim("th_1", 4, 100, 7_000);
  assert.notEqual(secondLease, null);
  assert.equal(store.getAttempt("th_1", 4)?.attempts, 2);
  assert.equal(store.getAttempt("th_1", 4)?.lastError, null);

  assert.equal(store.markSent("th_1", 4, secondLease!, 8_000), true);
  assert.equal(store.claim("th_1", 4, 100, 100_000), null);
  assert.deepEqual(store.counts(), { pending: 0, resumed: 1 });
});

test("leases renew and fence stale workers", (t) => {
  const { db, store } = makeStore();
  t.after(() => db.close());

  const firstLease = store.claim("th_lease", 3, 50, 1_000)!;
  assert.equal(store.renewLease("th_lease", 3, firstLease, 40_000), true);
  assert.equal(store.claim("th_lease", 3, 50, 61_000), null);
  const secondLease = store.claim("th_lease", 3, 50, 101_000);
  assert.notEqual(secondLease, null);
  assert.equal(store.markSent("th_lease", 3, firstLease, 102_000), false);
  assert.equal(store.markRetry("th_lease", 3, firstLease, "stale", 102_000), false);
  assert.equal(store.markSent("th_lease", 3, secondLease!, 103_000), true);
});

test("keeps sent state when a later eligibility check tries to skip it", (t) => {
  const { db, store } = makeStore();
  t.after(() => db.close());

  const lease = store.claim("th_sent", 2, 40, 1_000)!;
  assert.equal(store.markSent("th_sent", 2, lease, 2_000), true);
  store.markSkipped("th_sent", 2, 40, 3_000);
  assert.equal(store.getAttempt("th_sent", 2)?.status, "sent");
});

test("records crash-window sends and returns only due retries", (t) => {
  const { db, store } = makeStore();
  t.after(() => db.close());

  store.recordSent("th_recorded", 11, 500, 1_000);
  assert.equal(store.getAttempt("th_recorded", 11)?.status, "sent");
  const lease = store.claim("th_retry", 12, 600, 2_000)!;
  assert.equal(store.markRetry("th_retry", 12, lease, "temporary", 3_000), true);
  assert.deepEqual(store.dueThreadIds(7_999, 100), []);
  assert.deepEqual(store.dueThreadIds(8_000, 100), ["th_retry"]);
});

test("skipped interruptions do not become resumable later", (t) => {
  const { db, store } = makeStore();
  t.after(() => db.close());

  store.markSkipped("th_2", 7, 200, 300);
  assert.equal(store.claim("th_2", 7, 200, 100_000), null);
  assert.equal(store.getAttempt("th_2", 7)?.status, "skipped");
});
