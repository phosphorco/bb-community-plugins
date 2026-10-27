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
  const warnings: string[] = [];
  const bb = {
    sdk: { threads: {
      get: async ({ threadId }: { threadId: string }) => ({ id: threadId, projectId: "proj_a", title: "Source", deletedAt: null }),
      timeline: timeline ?? (async () => ({ rows: [{ id: "msg_a", threadId:"thr_a", sourceSeqStart:1, messageSeq:1, kind: "conversation", role: "assistant", text: "[Link](https://example.test/a)", createdAt: 100 }], timelinePage: { hasOlderRows: false, olderCursor: null } })),
    } },
    server: { experimental_appUrl: "https://bb.test" }, log: { warn: (message: string) => warnings.push(message) },
  } as any;
  return { collector: new AssistantLinkCollector(bb, db, store, signal => signals.push(signal)), signals, warnings, bb };
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
  let entered!: () => void;
  const timelineEntered = new Promise<void>(resolve => { entered = resolve; });
  const { collector } = fixture(db, store, () => { entered(); return pending; });
  collector.enqueue("proj_a", "thr_a", false, true);
  const processing = collector.processNext(new AbortController().signal);
  await timelineEntered;
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
  let entered!: () => void;
  const timelineEntered = new Promise<void>(resolve => { entered = resolve; });
  const { collector, signals } = fixture(db, store, () => { entered(); return pending; });
  collector.enqueue("proj_a", "thr_a");
  const controller = new AbortController();
  const processing = collector.processNext(controller.signal);
  await timelineEntered;
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
  collector.enqueue("proj_a", "thr_viewed", false, false, 2);
  assert.deepEqual(db.prepare("SELECT thread_id, version FROM assistant_link_jobs ORDER BY priority DESC, retry_at, rowid LIMIT 1").get(), { thread_id: "thr_viewed", version: 1 });
  await collector.processNext(new AbortController().signal);
  const before = db.prepare("SELECT retry_at FROM assistant_link_jobs WHERE thread_id = 'thr_viewed'").get();
  collector.enqueue("proj_a", "thr_viewed", false, false, 2);
  assert.deepEqual(db.prepare("SELECT retry_at FROM assistant_link_jobs WHERE thread_id = 'thr_viewed'").get(), before);
});

test("disposed collectors permanently reject queued DB entrypoints and cannot restart, including close without a disposal hook", async t => {
  for (const explicitDispose of [true, false]) {
    const {db, store} = open();
    const {collector, bb, signals, warnings} = fixture(db, store);
    let sdkReads = 0;
    Object.defineProperty(bb, "sdk", {get() { sdkReads++; throw new Error("stale SDK access"); }});
    if (explicitDispose) { collector.dispose(); collector.dispose(); }
    db.close();
    assert.doesNotThrow(() => collector.invalidateSuppliers());
    assert.doesNotThrow(() => collector.seed());
    assert.doesNotThrow(() => collector.enqueue("proj_a", "thr_a", true, true));
    assert.equal(await collector.processNext(new AbortController().signal), false);
    await collector.start(new AbortController().signal);
    collector.dispose();
    assert.equal(sdkReads, 0);
    assert.deepEqual(signals, []);
    assert.deepEqual(warnings, []);
  }
});

for (const seam of ["discovery", "source", "timeline", "context", "timeline-error"] as const) {
  test('dispose during '+seam+' cancels active wait, fences late success/retry writes and retains durable work on reopen', {timeout: 2000}, async t => {
    const dir = mkdtempSync(join(tmpdir(), "cross-dispose-"));
    t.after(() => rmSync(dir, {recursive: true, force: true}));
    const path = join(dir, "links.sqlite");
    const {db, store} = open(path);
    t.after(() => { if (db.open) db.close(); });
    const {collector, bb, signals, warnings} = fixture(db, store);
    let enter!: () => void, release!: (value: any) => void, reject!: (error: Error) => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const held = new Promise<any>((resolve, fail) => { release = resolve; reject = fail; });
    let portSignal!: AbortSignal;
    const port = ({signal}: any) => { portSignal = signal; enter(); return held; };
    bb.sdk.plugins = {list: seam === "discovery" ? port : async () => ({plugins: []})};
    if (seam === "source") bb.sdk.threads.get = port;
    if (seam.startsWith("timeline")) bb.sdk.threads.timeline = port;
    bb.sdk.projects = {get: seam === "context" ? port : async () => ({gitRemoteUrl: null})};
    collector.enqueue("proj_a", "thr_a");
    const before = db.prepare("SELECT * FROM assistant_link_jobs").all();
    const running = collector.processNext(new AbortController().signal);
    await entered; // prove the intended real collector port was entered
    collector.dispose(); // no caller abort; the collector owns cancellation too
    assert.equal(portSignal.aborted, true);
    db.close(); // runtime closes SQLite after disposal, before a late SDK response
    await running; // must settle without relying on that response
    if (seam === "timeline-error") reject(new Error("late offline failure"));
    else release(seam === "discovery" ? {plugins: []} :
      seam === "source" ? {id: "thr_a", projectId: "proj_a"} :
      seam === "context" ? {gitRemoteUrl: null} : {rows: [], timelinePage: {olderCursor: null}});
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(signals, []);
    assert.deepEqual(warnings, []);
    const reopened = open(path, false);t.after(() => reopened.db.close());
    assert.deepEqual(reopened.db.prepare("SELECT * FROM assistant_link_jobs").all(), before);
    assert.equal(reopened.store.getProjection({producerPluginId: "cross-references", source: sourceIdentity}).projection, null);
    assert.equal(reopened.store.mentionState(sourceIdentity).occurrences.length, 0);
  });
}

test("externally closed DB fences late timeline failure without relying on a disposal hook or caller abort", {timeout: 2000}, async t => {
  const {db, store} = open();
  t.after(() => { if (db.open) db.close(); });
  let enter!: () => void, fail!: (error: Error) => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const held = new Promise<any>((_, reject) => { fail = reject; });
  const {collector, signals, warnings} = fixture(db, store, () => { enter(); return held; });
  collector.enqueue("proj_a", "thr_a");
  const running = collector.processNext(new AbortController().signal);
  await entered;
  db.close();
  fail(new Error("late offline failure"));
  await running;
  assert.deepEqual(signals, []);
  assert.deepEqual(warnings, []);
  assert.equal(await collector.processNext(new AbortController().signal), false);
});

test("viewing an already failed job promotes only durable priority; due retries beat 3500 cold jobs while backoff leaves them runnable", async t => {
  const {db, store} = open();t.after(() => db.close());
  const {collector, bb} = fixture(db, store, async () => ({rows: [], timelinePage: {olderCursor: null}}));
  let now = 100_000, failures = 2;
  t.mock.method(Date, "now", () => now);
  const selected: string[] = [];
  bb.sdk.threads.get = async ({threadId}: any) => {
    selected.push(threadId);
    if (threadId === "thr_viewed" && failures-- > 0) throw new Error("offline");
    return {id: threadId, projectId: "proj_a"};
  };
  const job = () => db.prepare("SELECT * FROM assistant_link_jobs WHERE thread_id='thr_viewed'").get() as any;
  collector.enqueue("proj_a", "thr_viewed");
  await collector.processNext(new AbortController().signal);
  const failed = job();assert.equal(failed.attempts, 1);
  for (let i = 0; i < 3500; i++) collector.enqueue("proj_a", "thr_cold_"+i);
  collector.enqueue("proj_a", "thr_viewed", false, false, 2);
  assert.deepEqual(job(), {...failed, priority: 2});
  collector.enqueue("proj_a", "thr_viewed", false, false, 2);
  assert.deepEqual(job(), {...failed, priority: 2});
  collector.enqueue("proj_a", "thr_settled", false, false, 1);
  now = failed.retry_at-1;
  await collector.processNext(new AbortController().signal);
  assert.deepEqual(selected, ["thr_viewed", "thr_settled"]);
  await collector.processNext(new AbortController().signal);
  assert.equal(selected.at(-1), "thr_cold_0");
  collector.enqueue("proj_a", "thr_settled_after", false, false, 1);
  now = failed.retry_at;
  await collector.processNext(new AbortController().signal);
  assert.equal(selected.at(-1), "thr_viewed");
  const retried = job();assert.equal(retried.attempts, 2);assert.equal(retried.priority, 2);
  assert.equal(retried.version, failed.version);assert.equal(retried.retry_at, now+2000);
  await collector.processNext(new AbortController().signal);
  assert.equal(selected.at(-1), "thr_settled_after");
  await collector.processNext(new AbortController().signal);
  assert.equal(selected.at(-1), "thr_cold_1");
  assert.deepEqual(job(), retried);
  now = retried.retry_at;
  await collector.processNext(new AbortController().signal);
  assert.equal(selected.at(-1), "thr_viewed");
  assert.equal(job(), undefined);
  assert.equal((db.prepare("SELECT COUNT(*) n FROM assistant_link_jobs").get() as any).n, 3498);
  assert.equal(store.getProjection({producerPluginId: "cross-references", source: {provider: "bb", keys: {project: "proj_a", thread: "thr_viewed"}}}).projection!.revision, 1);
});

for (const priority of [1, 2] as const) test("rank"+priority+" retry priority/backoff/attempts/generation survive actual reopen and worker startup reconciliation", {timeout: 2000}, async t => {
  const dir = mkdtempSync(join(tmpdir(), "cross-priority-"));t.after(() => rmSync(dir, {recursive: true, force: true}));
  const path = join(dir, "queue.sqlite");
  let now = 100_000;t.mock.method(Date, "now", () => now);
  const initial = open(path);legacy(initial.store);
  const first = fixture(initial.db, initial.store, async () => { throw new Error("offline"); });
  first.collector.enqueue("proj_a", "thr_a", false, false, priority);
  await first.collector.processNext(new AbortController().signal);
  const before = initial.db.prepare("SELECT * FROM assistant_link_jobs").all();
  first.collector.dispose();initial.db.close();
  const reopened = open(path, false);t.after(() => reopened.db.close());
  const f = fixture(reopened.db, reopened.store);
  f.bb.sdk.plugins = {list: async () => ({plugins: []})};
  f.bb.sdk.subscribe = () => () => {};
  let idle!: () => void;
  const idleEntered = new Promise<void>(resolve => { idle = resolve; });
  const prepare = reopened.db.prepare.bind(reopened.db);
  t.mock.method(reopened.db, "prepare", ((sql: string) => {
    const statement = prepare(sql);
    if (sql === "SELECT MIN(retry_at) AS retry_at FROM assistant_link_jobs") {
      const get = statement.get.bind(statement);statement.get = (...args: any[]) => { const result = get(...args);idle();return result; };
    }
    return statement;
  }) as any);
  const controller = new AbortController();t.after(() => controller.abort());
  const running = f.collector.start(controller.signal);
  await idleEntered;
  assert.deepEqual(reopened.db.prepare("SELECT * FROM assistant_link_jobs").all(), before);
  assert.equal((before[0] as any).priority, priority);
  controller.abort();await running;
  assert.deepEqual(reopened.db.prepare("SELECT * FROM assistant_link_jobs").all(), before);
  assert.deepEqual(f.signals, []);
});

test("new source generation retains viewed priority and stale completion cannot delete it", async t => {
  const {db, store} = open();t.after(() => db.close());
  let entered!: () => void, release!: (value: any) => void;
  const timelineEntered = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<any>(resolve => { release = resolve; });
  const {collector, signals} = fixture(db, store, () => { entered();return held; });
  collector.enqueue("proj_a", "thr_a", false, false, 2);
  const running = collector.processNext(new AbortController().signal);await timelineEntered;
  collector.enqueue("proj_a", "thr_a", true, true);
  const next = db.prepare("SELECT * FROM assistant_link_jobs").get() as any;
  assert.equal(next.version, 2);assert.equal(next.priority, 2);
  release({rows: [], timelinePage: {olderCursor: null}});await running;
  assert.deepEqual(db.prepare("SELECT * FROM assistant_link_jobs").get(), next);
  assert.deepEqual(signals, []);
  await collector.processNext(new AbortController().signal);
  assert.equal(db.prepare("SELECT * FROM assistant_link_jobs").get(), undefined);
  assert.equal(store.getProjection({producerPluginId: "cross-references", source: sourceIdentity}).projection!.tombstone, true);
});

test("actual eligible worker orders viewed then active events then cold and lower-rank demand never downgrades viewed intent", async t => {
  const {db, store} = open();t.after(() => db.close());
  const {collector, bb} = fixture(db, store, async () => ({rows: [], timelinePage: {olderCursor: null}}));
  const selected: string[] = [];
  bb.sdk.threads.get = async ({threadId}: any) => { selected.push(threadId);return {id: threadId, projectId: "proj_a"}; };
  collector.enqueue("proj_a", "thr_cold");
  collector.enqueue("proj_a", "thr_settled", false, false, 1);
  collector.enqueue("proj_a", "thr_viewed", false, false, 2);
  const before = db.prepare("SELECT * FROM assistant_link_jobs WHERE thread_id='thr_viewed'").get();
  collector.enqueue("proj_a", "thr_viewed", false, false, 1);
  collector.enqueue("proj_a", "thr_viewed");
  assert.deepEqual(db.prepare("SELECT * FROM assistant_link_jobs WHERE thread_id='thr_viewed'").get(), before);
  for (let n = 0; n < 3; n++) await collector.processNext(new AbortController().signal);
  assert.deepEqual(selected, ["thr_viewed", "thr_settled", "thr_cold"]);
});
