import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { AssistantLinkCollector } from "../assistant-link-collector.ts";
import { CrossReferenceStore, crossReferencesMigrations, enableForeignKeys } from "../store.ts";
import { canonicalizeResource, projectionPayloadDigest, threadResource } from "../canonical.ts";
import type { CrossReferencesChangedSignal } from "../model.ts";

const source = threadResource("proj_a", "thr_a", { label: "Source" });
const sourceIdentity = { provider: source.provider, keys: source.keys };
const target = { provider: "url", keys: { href: "https://example.test/a" }, presentation: { label: "Original", url: "https://example.test/a" } };
function open(path = ":memory:", migrate = true) {
  const db = new Database(path);
  enableForeignKeys(db);
  if (migrate) for (const migration of crossReferencesMigrations) db.exec(migration);
  return { db, store: new CrossReferenceStore(db) };
}
function fixture(db: Database.Database, store: CrossReferenceStore, timeline?: () => Promise<any>) {
  const signals: CrossReferencesChangedSignal[] = [];
  const bb = {
    sdk: { threads: {
      get: async ({ threadId }: { threadId: string }) => ({ id: threadId, projectId: "proj_a", title: "Source", deletedAt: null }),
      timeline: timeline ?? (async () => ({ rows: [{ id: "msg_a", kind: "conversation", role: "assistant", text: "[Link](https://example.test/a)", createdAt: 100 }], timelinePage: { hasOlderRows: false, olderCursor: null } })),
    } },
    server: { experimental_appUrl: "https://bb.test" }, log: { warn: () => {} },
  } as any;
  return { collector: new AssistantLinkCollector(bb, db, store, signal => signals.push(signal)), signals };
}
function legacy(store: CrossReferenceStore) {
  store.applyProjection({ protocolVersion: 1, producerPluginId: "thread-links", mutationId: "00000000-0000-4000-8000-000000000001", source,
    revision: 1, expectedRevision: 0, tombstone: false, targets: [target],
    payloadDigest: projectionPayloadDigest("thread-links", canonicalizeResource(source), false, [canonicalizeResource(target)]) });
}

test("latest source time survives dedup with the earliest legacy presentation and updates without changing occurrence IDs", t => {
  const { db, store } = open(); t.after(() => db.close()); legacy(store);
  store.replaceObservedThreadReferences(source, [{ target, lastSeenAt: 10 }, { target, lastSeenAt: 20 }], true);
  assert.equal(store.listForwardReferences({ source: sourceIdentity }).total, 1);
  const row = store.listForwardReferences({ source: sourceIdentity }).rows[0]!;
  assert.equal(row.producerPluginId, "thread-links");
  assert.equal(row.lastSeenAt, 20);
  assert.equal(store.listBacklinks({ target: { provider: target.provider, keys: target.keys } }).rows[0]?.lastSeenAt, 20);
  const before = db.prepare("SELECT id FROM reference_occurrences").all();
  const signals = store.replaceObservedThreadReferences(source, [{ target, lastSeenAt: 30 }], true);
  assert.deepEqual(db.prepare("SELECT id FROM reference_occurrences").all(), before);
  assert.equal(signals.length, 1);
  assert.equal(store.listForwardReferences({ source: sourceIdentity }).rows[0]?.lastSeenAt, 30);
  assert.equal(store.getProjection({ producerPluginId: "thread-links", source: sourceIdentity }).projection?.tombstone, false);
});

test("incomplete scans retain native targets and times, complete scans remove stale native targets, deletion retires both producers", t => {
  const { db, store } = open(); t.after(() => db.close()); legacy(store);
  store.replaceObservedThreadReferences(source, [{ target, lastSeenAt: 20 }], true);
  store.replaceObservedThreadReferences(source, [], false);
  assert.equal(store.listForwardReferences({ source: sourceIdentity }).rows[0]?.lastSeenAt, 20);
  store.replaceObservedThreadReferences(source, [], true);
  assert.equal(store.listForwardReferences({ source: sourceIdentity }).total, 1); // retained historical/manual legacy assertion
  assert.equal(store.listForwardReferences({ source: sourceIdentity }).rows[0]?.lastSeenAt, null);
  store.replaceObservedThreadReferences(source, [], true, true);
  assert.equal(store.listForwardReferences({ source: sourceIdentity }).total, 0);
  assert.equal(store.getProjection({ producerPluginId: "thread-links", source: sourceIdentity }).projection?.tombstone, true);
});

test("pending collection resumes through an actual database reopen and publishes only committed message time", async t => {
  const dir = mkdtempSync(join(tmpdir(), "cross-links-")); t.after(() => rmSync(dir, { recursive: true }));
  const path = join(dir, "links.sqlite");
  const initial = open(path);
  fixture(initial.db, initial.store).collector.enqueue("proj_a", "thr_a");
  initial.db.close();
  const { db, store } = open(path, false); t.after(() => db.close());
  const { collector, signals } = fixture(db, store);
  assert.equal(await collector.processNext(new AbortController().signal), true);
  assert.equal(store.listForwardReferences({ source: sourceIdentity }).rows[0]?.lastSeenAt, 100);
  assert.equal(db.prepare("SELECT * FROM assistant_link_jobs").all().length, 0);
  assert.equal(signals.length, 1);
});

test("retry survives errors, repeated header reads coalesce, newer jobs and aborted scans cannot commit stale results", async t => {
  const { db, store } = open(); t.after(() => db.close());
  const failing = fixture(db, store, async () => { throw new Error("offline"); }).collector;
  failing.enqueue("proj_a", "thr_a"); failing.enqueue("proj_a", "thr_a");
  assert.equal((db.prepare("SELECT version FROM assistant_link_jobs").get() as any).version, 1);
  await failing.processNext(new AbortController().signal);
  assert.equal((db.prepare("SELECT attempts FROM assistant_link_jobs").get() as any).attempts, 1);
  assert.equal(store.listForwardReferences({ source: sourceIdentity }).total, 0);
  let release!: (page: any) => void;
  const pending = new Promise(resolve => { release = resolve; });
  const { collector } = fixture(db, store, () => pending);
  collector.enqueue("proj_a", "thr_a", false, true);
  const processing = collector.processNext(new AbortController().signal);
  await Promise.resolve(); await Promise.resolve();
  collector.enqueue("proj_a", "thr_a", true, true);
  release({ rows: [], timelinePage: { hasOlderRows: false, olderCursor: null } });
  await processing;
  assert.equal(store.getProjection({ producerPluginId: "cross-references", source: sourceIdentity }).projection, null);
  assert.equal((db.prepare("SELECT deleted FROM assistant_link_jobs").get() as any).deleted, 1);
  await collector.processNext(new AbortController().signal);
  assert.equal(store.getProjection({ producerPluginId: "cross-references", source: sourceIdentity }).projection?.tombstone, true);
  collector.enqueue("proj_a", "thr_b", false, true);
  const controller = new AbortController(); controller.abort();
  assert.equal(await collector.processNext(controller.signal), false);
  assert.ok(db.prepare("SELECT 1 FROM assistant_link_jobs WHERE thread_id = 'thr_b'").get());
});

test("a scan aborted during native timeline I/O leaves durable work and cannot publish", async t => {
  const { db, store } = open(); t.after(() => db.close());
  let release!: (page: any) => void;
  const pending = new Promise(resolve => { release = resolve; });
  const { collector, signals } = fixture(db, store, () => pending);
  collector.enqueue("proj_a", "thr_a");
  const controller = new AbortController();
  const processing = collector.processNext(controller.signal);
  await Promise.resolve(); await Promise.resolve();
  controller.abort();
  release({ rows: [], timelinePage: { hasOlderRows: false, olderCursor: null } });
  await processing;
  assert.equal(signals.length, 0);
  assert.equal(store.getProjection({ producerPluginId: "cross-references", source: sourceIdentity }).projection, null);
  assert.ok(db.prepare("SELECT 1 FROM assistant_link_jobs").get());
});

test("bounded incomplete timeline scans preserve known times and targets", async t => {
  const { db, store } = open(); t.after(() => db.close());
  store.replaceObservedThreadReferences(source, [{ target, lastSeenAt: 20 }], true);
  let pages = 0;
  const { collector } = fixture(db, store, async () => ({ rows: [], timelinePage: { hasOlderRows: true, olderCursor: { anchorSeq: ++pages, anchorId: `msg_${pages}` } } }));
  collector.enqueue("proj_a", "thr_a");
  await collector.processNext(new AbortController().signal);
  assert.equal(pages, 50);
  assert.equal(store.listForwardReferences({ source: sourceIdentity }).rows[0]?.lastSeenAt, 20);
});

test("viewed sources get priority without invalidating a pending scan or bypassing retry backoff", async t => {
  const { db, store } = open(); t.after(() => db.close());
  const collector = fixture(db, store, async () => { throw new Error("offline"); }).collector;
  collector.enqueue("proj_a", "thr_backfill");
  collector.enqueue("proj_a", "thr_viewed");
  collector.enqueue("proj_a", "thr_viewed", false, false, true);
  assert.deepEqual(db.prepare("SELECT thread_id, version FROM assistant_link_jobs ORDER BY retry_at, rowid LIMIT 1").get(), { thread_id: "thr_viewed", version: 1 });
  await collector.processNext(new AbortController().signal);
  const before = db.prepare("SELECT retry_at FROM assistant_link_jobs WHERE thread_id = 'thr_viewed'").get();
  collector.enqueue("proj_a", "thr_viewed", false, false, true);
  assert.deepEqual(db.prepare("SELECT retry_at FROM assistant_link_jobs WHERE thread_id = 'thr_viewed'").get(), before);
});
