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
  db.pragma("journal_mode = WAL");
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

test("obsolete page response stops paging and leaves the successor job untouched, which then collects its reference", async t => {
  const { db, store } = open(); t.after(() => db.close());
  let release!: (page: any) => void, enter!: () => void;
  const held = new Promise<any>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { enter = resolve; });
  let pages = 0, contextReads = 0;
  const { collector, bb, signals } = fixture(db, store, async () => {
    pages++;
    if (pages === 1) { enter(); return held; }
    return { rows: [{ id: "msg_new", threadId:"thr_a", sourceSeqStart:2, messageSeq:2, kind:"conversation", role:"assistant", text:"[Link](https://example.test/a)", createdAt:200 }], timelinePage:{olderCursor:null} };
  });
  bb.sdk.projects = { get: async () => { contextReads++; return { gitRemoteUrl:null }; } };
  collector.enqueue("proj_a", "thr_a");
  const running = collector.processNext(new AbortController().signal);
  await entered;
  collector.enqueue("proj_a", "thr_a", false, true, 2);
  const successor = db.prepare("SELECT * FROM assistant_link_jobs WHERE thread_id='thr_a'").get();
  release({ rows: [{ id:"msg_old", threadId:"thr_a", sourceSeqStart:1, messageSeq:1, kind:"conversation", role:"assistant", text:"old", createdAt:100 }], timelinePage:{olderCursor:{anchorSeq:1,anchorId:"msg_old"}} });
  await running;
  assert.equal(pages, 1, "obsolete olderCursor must not trigger page 2");
  assert.equal(contextReads, 0, "obsolete scan must not fetch context");
  assert.deepEqual(db.prepare("SELECT * FROM assistant_link_jobs WHERE thread_id='thr_a'").get(), successor);
  assert.deepEqual(signals, []);
  assert.equal(store.getProjection({producerPluginId:"cross-references",source:sourceIdentity}).projection, null);
  await collector.processNext(new AbortController().signal);
  assert.equal(pages, 2);
  assert.equal(store.listForwardReferences({source:sourceIdentity}).rows[0]?.target.keys.href, "https://example.test/a");
});

test("supplier invalidation makes an in-flight page rejection neutral instead of retrying the current job", async t => {
  const { db, store } = open(); t.after(() => db.close());
  let reject!: (error: Error) => void, enter!: () => void;
  const held = new Promise<any>((_, fail) => { reject = fail; });
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const { collector, warnings } = fixture(db, store, () => { enter(); return held; });
  collector.enqueue("proj_a", "thr_a", false, true, 1);
  const running = collector.processNext(new AbortController().signal);
  await entered;
  collector.invalidateSuppliers();
  const afterInvalidation = db.prepare("SELECT * FROM assistant_link_jobs WHERE thread_id='thr_a'").get();
  reject(new Error("obsolete page failure"));
  await running;
  assert.deepEqual(db.prepare("SELECT * FROM assistant_link_jobs WHERE thread_id='thr_a'").get(), afterInvalidation);
  assert.deepEqual(warnings, []);
});

test("supplier invalidation during awaited context prevents subsequent native mention recognition", async t => {
  const { db, store } = open(); t.after(() => db.close());
  let release!: (value:any)=>void, enter!: ()=>void;
  const held = new Promise<any>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { enter = resolve; });
  let gets = 0;
  const { collector, bb } = fixture(db, store, async () => ({ rows:[{id:"msg_a",threadId:"thr_a",sourceSeqStart:1,messageSeq:1,kind:"conversation",role:"assistant",text:"See https://bb.test/projects/proj_a/threads/thr_target",createdAt:100}], timelinePage:{olderCursor:null} }));
  bb.sdk.threads.get = async ({threadId}:any) => { gets++; return {id:threadId,projectId:"proj_a"}; };
  bb.sdk.projects = { get: () => { enter(); return held; } };
  collector.enqueue("proj_a", "thr_a");
  const running = collector.processNext(new AbortController().signal);
  await entered;
  collector.invalidateSuppliers();
  release({gitRemoteUrl:null});
  await running;
  assert.equal(gets, 1, "only the source prefetch may have run; target recognition must not start");
  assert.equal(store.getProjection({producerPluginId:"cross-references",source:sourceIdentity}).projection, null);
});

test("late invalidated supplier response cannot poison the successor cache; same supplier produces its current reference", async t => {
  const { db, store } = open(); t.after(() => db.close());
  let release!: (value:any)=>void, enter!: ()=>void, calls=0, describes=0;
  const held = new Promise<any>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const { collector, bb, signals } = fixture(db, store, async () => ({rows:[{id:"msg_a",threadId:"thr_a",sourceSeqStart:1,messageSeq:1,kind:"conversation",role:"assistant",text:"TOKEN",createdAt:100}],timelinePage:{olderCursor:null}}));
  const candidate={span:{start:0,end:5},match:"TOKEN",source:{provider:"review.issue",id:"NEW",kind:"issue"},confidence:"high",provenance:{basis:"explicit",explanation:"current supplier"}};
  bb.sdk.plugins={list:async()=>({plugins:[{id:"review-supplier",name:"Review",status:"running"}]}),callRpc:async({method}:any)=>{
    if(method==="contextRecognitionDescribe"){describes++;return{protocol:"bb-context-recognition",versions:[1],capabilities:{revision:"same",linkify:{providers:[{provider:"review.issue",kinds:["issue"]}]}}};}
    assert.equal(method,"contextRecognitionV1Linkify");calls++;if(calls===1){enter();return held;}return{candidates:[candidate]};
  }};
  collector.enqueue("proj_a","thr_a");
  const first=collector.processNext(new AbortController().signal);await entered;
  collector.invalidateSuppliers();
  const successor=db.prepare("SELECT * FROM assistant_link_jobs WHERE thread_id='thr_a'").get();
  release({candidates:[]});await first;
  assert.equal((collector as any).recognitionCache.size,0,"late response writes only to its detached attempt cache");
  assert.deepEqual(db.prepare("SELECT * FROM assistant_link_jobs WHERE thread_id='thr_a'").get(),successor);
  assert.deepEqual(signals,[]);assert.equal((collector as any).activeAttempts.size,0);
  await collector.processNext(new AbortController().signal);
  assert.equal(describes,2);assert.equal(calls,2);
  assert.equal(store.listForwardReferences({source:sourceIdentity}).total,1,"successor must recognize the reference at the same supplier revision");
  assert.equal(db.prepare("SELECT * FROM assistant_link_jobs WHERE thread_id='thr_a'").get(),undefined);
  assert.equal((collector as any).activeAttempts.size,0);
});

for(const mode of ["version","epoch"] as const)test("attempt abort prevents the next native target call after "+mode+" supersession",async t=>{
  const {db,store}=open();t.after(()=>db.close());
  let enter!:()=>void,release!:(value:any)=>void;
  const entered=new Promise<void>(resolve=>{enter=resolve;});
  const held=new Promise<any>(resolve=>{release=resolve;});
  const {collector,bb,signals}=fixture(db,store,async()=>({rows:[{id:"msg_a",threadId:"thr_a",sourceSeqStart:1,messageSeq:1,kind:"conversation",role:"assistant",text:"https://bb.test/projects/proj_a/threads/thr_one https://bb.test/projects/proj_a/threads/thr_two",createdAt:100}],timelinePage:{olderCursor:null}}));
  const gets:string[]=[];
  bb.sdk.threads.get=async({threadId}:any)=>{gets.push(threadId);if(threadId==="thr_one"){enter();return held;}return{id:threadId,projectId:"proj_a"};};
  collector.enqueue("proj_a","thr_a");
  const first=collector.processNext(new AbortController().signal);await entered;
  if(mode==="version")collector.enqueue("proj_a","thr_a",false,true,2);else collector.invalidateSuppliers();
  const successor=db.prepare("SELECT * FROM assistant_link_jobs WHERE thread_id='thr_a'").get();
  release({id:"thr_one",projectId:"proj_a"});await first;
  assert.deepEqual(gets,["thr_a","thr_one"],"no second target verification may begin after abort");
  assert.deepEqual(db.prepare("SELECT * FROM assistant_link_jobs WHERE thread_id='thr_a'").get(),successor);
  assert.deepEqual(signals,[]);assert.equal((collector as any).activeAttempts.size,0);
  await collector.processNext(new AbortController().signal);
  assert.ok(gets.includes("thr_two"),"successor remains eligible to verify the later target");
  assert.equal(db.prepare("SELECT * FROM assistant_link_jobs WHERE thread_id='thr_a'").get(),undefined);
  assert.ok(store.listForwardReferences({source:sourceIdentity}).total>0);
  assert.equal((collector as any).activeAttempts.size,0);
});

test("priority-only upgrade does not abort a held native target attempt",async t=>{
  const {db,store}=open();t.after(()=>db.close());
  let enter!:()=>void,release!:(value:any)=>void;
  const entered=new Promise<void>(resolve=>{enter=resolve;});
  const held=new Promise<any>(resolve=>{release=resolve;});
  const {collector,bb}=fixture(db,store,async()=>({rows:[{id:"msg_a",threadId:"thr_a",sourceSeqStart:1,messageSeq:1,kind:"conversation",role:"assistant",text:"https://bb.test/projects/proj_a/threads/thr_one https://bb.test/projects/proj_a/threads/thr_two",createdAt:100}],timelinePage:{olderCursor:null}}));
  const gets:string[]=[];
  bb.sdk.threads.get=async({threadId}:any)=>{gets.push(threadId);if(threadId==="thr_one"){enter();return held;}return{id:threadId,projectId:"proj_a"};};
  collector.enqueue("proj_a","thr_a");
  const running=collector.processNext(new AbortController().signal);await entered;
  collector.enqueue("proj_a","thr_a",false,false,2);
  assert.equal((collector as any).activeAttempts.values().next().value.controller.signal.aborted,false);
  release({id:"thr_one",projectId:"proj_a"});await running;
  assert.ok(gets.includes("thr_two"));assert.equal(db.prepare("SELECT * FROM assistant_link_jobs WHERE thread_id='thr_a'").get(),undefined);
  assert.equal((collector as any).activeAttempts.size,0);
});

test("attempt abort during native file verification prevents later file verification calls",async t=>{
  const {db,store}=open();t.after(()=>db.close());
  let enter!:()=>void,release!:(value:any)=>void,gets=0,storageReads=0;
  const entered=new Promise<void>(resolve=>{enter=resolve;});
  const held=new Promise<any>(resolve=>{release=resolve;});
  const {collector,bb}=fixture(db,store,async()=>({rows:[{id:"msg_a",threadId:"thr_a",sourceSeqStart:1,messageSeq:1,kind:"conversation",role:"assistant",text:"plans/one.md plans/two.md",createdAt:100}],timelinePage:{olderCursor:null}}));
  bb.sdk.threads.get=async()=>{gets++;if(gets===2){enter();return held;}return{id:"thr_a",projectId:"proj_a"};};
  bb.sdk.environments={get:async()=>{storageReads++;return{id:"env_a",projectId:"proj_a",path:"/tmp/workspace"};}};
  bb.sdk.threads.storageLocation=async()=>({hostId:"host_a",storageRootPath:"/tmp/storage"});
  bb.hosts={experimental_client:()=>({call:async()=>({exists:true})})};
  collector.enqueue("proj_a","thr_a");
  const running=collector.processNext(new AbortController().signal);await entered;
  collector.invalidateSuppliers();release({id:"thr_a",projectId:"proj_a"});await running;
  await new Promise<void>(resolve=>setImmediate(resolve));
  assert.equal(gets,2,"source prefetch and first file owner only");
  assert.equal(storageReads,0,"aborted first file verification must not continue to storage or a second file owner");
  assert.equal((db.prepare("SELECT * FROM assistant_link_jobs WHERE thread_id='thr_a'").get() as any)?.attempts,0);
  assert.equal((collector as any).activeAttempts.size,0);
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
  for(let quantum=0;quantum<50;quantum++)await collector.processNext(new AbortController().signal);
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

for(const seam of ['source','timeline'] as const)test('actual '+seam+' prefetch timeout is outer1s, safe and preserves failed durable job',async t=>{
 const {db,store}=open();t.after(()=>{if(db.open)db.close();});const f=fixture(db,store);
 let portSignal!:AbortSignal,release!:(value:any)=>void;
 const held=new Promise<any>(resolve=>release=resolve);
 const port=({signal}:any)=>{portSignal=signal;return held;};
 if(seam==='source')f.bb.sdk.threads.get=port;else f.bb.sdk.threads.timeline=port;
 f.collector.enqueue('proj_a','thr_a',false,true,2);
 const before=db.prepare('SELECT * FROM assistant_link_jobs').get() as any;
 const started=Date.now();await f.collector.processNext(new AbortController().signal);
 assert.equal(portSignal.aborted,true);assert.equal(f.warnings.length,1);
 const rows=JSON.parse(f.warnings[0]!.split('Diagnostics: ')[1]!).groups;
 assert.equal(rows.length,1);assert.equal(rows[0].stage,seam==='source'?'source-prefetch':'timeline-prefetch');assert.equal(rows[0].reason,'outer-timeout');
 assert.ok(rows[0].elapsedMsMin>=900);assert.equal(rows[0].remainingMsMin,undefined);
 const after=db.prepare('SELECT * FROM assistant_link_jobs').get() as any;
 assert.equal(after.priority,before.priority);assert.equal(after.version,before.version);assert.equal(after.attempts,1);assert.ok(after.retry_at>=started+1000);
 assert.deepEqual(f.signals,[]);const warnings=[...f.warnings];db.close();
 release(seam==='source'?{id:'thr_a',projectId:'proj_a'}:{rows:[],timelinePage:{olderCursor:null}});
 await new Promise<void>(resolve=>setImmediate(resolve));assert.deepEqual(f.warnings,warnings);
});

test('actual source404 remains a tombstone; project context failure remains a silent fallback on complete scans',async t=>{
 for(const kind of ['source404','context'] as const){
  const {db,store}=open();t.after(()=>db.close());const f=fixture(db,store);
  f.bb.sdk.plugins={list:async()=>({plugins:[]})};
  const error=Object.assign(new Error('SECRET /private/root https://secret.test'),{status:404,name:'TimeoutError'});
  if(kind==='source404')f.bb.sdk.threads.get=async()=>{throw error;};else f.bb.sdk.projects={get:async()=>{throw error;}};
  f.collector.enqueue('proj_a','thr_a');await f.collector.processNext(new AbortController().signal);
  assert.deepEqual(f.warnings,[]);assert.equal(db.prepare('SELECT * FROM assistant_link_jobs').all().length,0);
  if(kind==='source404')assert.equal(store.getProjection({producerPluginId:'cross-references',source:sourceIdentity}).projection?.tombstone,true);
  else assert.equal(store.listForwardReferences({source:sourceIdentity}).total,1);
 }
});

test('actual SDK failure warning never renders error text or guesses timeout from the error name',async t=>{
 const {db,store}=open();t.after(()=>db.close());const f=fixture(db,store);
 f.bb.sdk.threads.timeline=async()=>{throw Object.assign(new Error('SECRET /absolute/root https://secret.test/?token=SECRET'),{name:'TimeoutError',status:503});};
 f.collector.enqueue('proj_a','thr_a');await f.collector.processNext(new AbortController().signal);
 const log=f.warnings[0]!;assert.doesNotMatch(log,/SECRET|absolute|secret\.test|TimeoutError|503|stack/);
 const rows=JSON.parse(log.split('Diagnostics: ')[1]!).groups;assert.equal(rows.length,1);assert.equal(rows[0].stage,'timeline-prefetch');assert.equal(rows[0].reason,'sdk-failure');
});

test('actual unclassified transaction exception stays unknown even after an earlier recoverable context failure',async t=>{
 const {db,store}=open();t.after(()=>db.close());const f=fixture(db,store);
 f.bb.sdk.plugins={list:async()=>({plugins:[]})};
 f.bb.sdk.projects={get:async()=>{throw new Error('SECRET context');}};
 t.mock.method(store,'replaceConversationMentions',()=>{throw 'SECRET transaction';});
 f.collector.enqueue('proj_a','thr_a');await f.collector.processNext(new AbortController().signal);
 assert.equal(f.warnings.length,1);assert.doesNotMatch(f.warnings[0]!,/SECRET/);
 const rows=JSON.parse(f.warnings[0]!.split('Diagnostics: ')[1]!).groups;
 assert.deepEqual(rows.map((r:any)=>[r.stage,r.reason]),[['project-context','sdk-failure'],['collection','unknown']]);
 assert.equal(rows[1].elapsedMsMin,undefined);assert.equal((db.prepare('SELECT attempts FROM assistant_link_jobs').get() as any).attempts,1);
});

test('actual collector commits primary excerpt/href/binding once and read-only supplier snapshot never reseeds',async t=>{
 const {db,store}=open();t.after(()=>db.close());const {collector}=fixture(db,store);t.after(()=>collector.dispose());
 collector.enqueue('proj_a','thr_a');await collector.processNext(new AbortController().signal);
 const stream=db.prepare('SELECT * FROM mention_streams').get() as any,projection=store.getProjection({producerPluginId:'cross-references',source:sourceIdentity}).projection!;
 assert.equal(stream.bound_graph_revision,projection.revision);assert.equal((db.prepare('SELECT COUNT(*) n FROM mention_excerpts').get() as any).n,1);
 const location=store.mentionState(sourceIdentity).occurrences[0]!;assert.equal(location.excerpt?.state,'ready');assert.equal(location.authoredUrlState,'exact');assert.equal(location.exactAuthoredHref,'https://example.test/a');
 const before=db.prepare('SELECT * FROM assistant_link_jobs').all();collector.lookupSnapshot();assert.deepEqual(db.prepare('SELECT * FROM assistant_link_jobs').all(),before);
});


async function finish(collector:AssistantLinkCollector, db:Database.Database) {
  for(let quantum=0;quantum<60 && db.prepare('SELECT 1 FROM assistant_link_jobs').get();quantum++)
    await collector.processNext(new AbortController().signal);
  assert.equal((db.prepare('SELECT COUNT(*) n FROM assistant_link_jobs').get() as {n:number}).n,0);
}
function supplier(bb:any, revision:()=>string, calls:string[]) {
  bb.sdk.plugins={list:async()=>({plugins:[{id:'test-supplier',name:'Test',status:'running'}]}),callRpc:async({method,input}:any)=>{
    if(method==='contextRecognitionDescribe')return {protocol:'bb-context-recognition',versions:[1],capabilities:{revision:revision(),linkify:{providers:[{provider:'test.issue',kinds:['issue']}]}}};
    calls.push(JSON.stringify(input));return {candidates:[]};
  }};
}
const row=(id:string,seq:number,text:string)=>({id,threadId:'thr_a',sourceSeqStart:seq,messageSeq:seq,kind:'conversation',role:'assistant',text,createdAt:seq*100});

test('one page per quantum; unchanged forced generations reuse history and pure recognition while native targets stay fresh',async t=>{
  const {db,store}=open();t.after(()=>db.close());let pages=0,heads=0,targetReads=0,targetDeleted=false;
  const f=fixture(db,store,async()=>({maxSeq:10,rows:pages++%2===0?[row('new',2,'TOKEN https://bb.test/projects/proj_a/threads/thr_target')]:[row('old',1,'older TOKEN')],
    timelinePage:{olderCursor:pages%2===1?{anchorSeq:1,anchorId:'old'}:null}}));
  const calls:string[]=[];supplier(f.bb,()=> 'rev1',calls);
  f.bb.sdk.threads.events={list:async()=>{heads++;return [{seq:10}];}};
  f.bb.sdk.threads.get=async({threadId}:any)=>{if(threadId==='thr_target'){targetReads++;return {id:threadId,projectId:'proj_a',deletedAt:targetDeleted?123:null};}return {id:threadId,projectId:'proj_a'};};
  f.collector.enqueue('proj_a','thr_a');await f.collector.processNext(new AbortController().signal);
  assert.equal(pages,1);assert.equal(store.getProjection({producerPluginId:'cross-references',source:sourceIdentity}).projection,null);
  assert.ok(db.prepare('SELECT 1 FROM assistant_link_jobs').get());
  await finish(f.collector,db);const initialCalls=calls.length;assert.ok(initialCalls>0);assert.equal(pages,2);assert.equal(targetReads,1);
  targetDeleted=true;f.collector.enqueue('proj_a','thr_a',false,true);await finish(f.collector,db);
  assert.equal(pages,2);assert.equal(heads,1);assert.equal(calls.length,initialCalls);assert.equal(targetReads,2);
  assert.equal(store.listForwardReferences({source:sourceIdentity}).rows.some(r=>r.target.provider==='bb'),false);
});

test('append and historical correction rescan source, recognize only changed inputs, and retire removed locations',async t=>{
  const {db,store}=open();t.after(()=>db.close());let seq=10,pages=0;
  let rows=[row('old',1,'[Original](https://example.test/original)')];
  const f=fixture(db,store,async()=>{pages++;return {maxSeq:seq,rows,timelinePage:{olderCursor:null}};});
  const calls:string[]=[];supplier(f.bb,()=> 'rev1',calls);f.bb.sdk.threads.events={list:async()=>[{seq}]};
  f.collector.enqueue('proj_a','thr_a');await finish(f.collector,db);const before=calls.length;
  rows=[row('new',2,'[New](https://example.test/new)'),...rows];seq++;
  f.collector.enqueue('proj_a','thr_a',false,true);await finish(f.collector,db);
  assert.equal(pages,2);assert.equal(calls.length,before*2,'only new message recognition windows miss');
  rows=[rows[0]!,row('old',1,'corrected without links')];seq++;
  f.collector.enqueue('proj_a','thr_a',false,true);await finish(f.collector,db);
  assert.equal(pages,3);assert.equal(calls.length,before*2+1);
  assert.deepEqual(store.listForwardReferences({source:sourceIdentity}).rows.map(r=>r.target.keys.href),['https://example.test/new']);
});

test('page checkpoints survive a real database reopen and resume the older cursor without replaying page one',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'cross-checkpoint-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const path=join(dir,'queue.sqlite');let pages=0;
  const initial=open(path);const first=fixture(initial.db,initial.store,async()=>{pages++;return {maxSeq:10,rows:[row('new',2,'https://example.test/new')],timelinePage:{olderCursor:{anchorSeq:1,anchorId:'older'}}};});
  first.collector.enqueue('proj_a','thr_a');await first.collector.processNext(new AbortController().signal);first.collector.dispose();initial.db.close();
  assert.equal(pages,1);
  const reopened=open(path,false);t.after(()=>reopened.db.close());
  const next=fixture(reopened.db,reopened.store);next.bb.sdk.threads.events={list:async()=>[{seq:10}]};
  next.bb.sdk.threads.timeline=async(args:any)=>{if(args.afterSequence)return {maxSeq:10,contextBoundarySeq:undefined,rows:[],delta:{upsertRows:[]},timelinePage:{olderCursor:null}};pages++;assert.equal(args.beforeAnchorId,'older');return {maxSeq:10,rows:[row('old',1,'https://example.test/old')],timelinePage:{olderCursor:null}};};
  next.bb.sdk.subscribe=()=>()=>{};
  let idle!:()=>void;const reachedIdle=new Promise<void>(resolve=>{idle=resolve;});
  const process=next.collector.processNext.bind(next.collector);
  next.collector.processNext=async signal=>{const worked=await process(signal);if(!worked)idle();return worked;};
  const controller=new AbortController();const running=next.collector.start(controller.signal);await reachedIdle;controller.abort();await running;
  assert.equal(pages,2);assert.equal(reopened.store.listForwardReferences({source:sourceIdentity}).total,2);
});

test('completed source and recognition checkpoints survive reopen; changed suppliers re-recognize without timeline reconstruction',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'cross-supplier-checkpoint-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const path=join(dir,'queue.sqlite');
  let revision='rev1',pages=0;const calls:string[]=[];
  const initial=open(path);const first=fixture(initial.db,initial.store,async()=>{pages++;return {maxSeq:10,rows:[row('m',1,'TOKEN')],timelinePage:{olderCursor:null}};});
  first.bb.sdk.threads.events={list:async()=>[{seq:10}]};supplier(first.bb,()=>revision,calls);
  first.collector.enqueue('proj_a','thr_a');await finish(first.collector,initial.db);assert.equal(calls.length,1);first.collector.dispose();initial.db.close();
  const reopened=open(path,false);t.after(()=>reopened.db.close());const next=fixture(reopened.db,reopened.store,async()=>{throw new Error('unchanged timeline must not be read');});
  next.bb.sdk.threads.events={list:async()=>[{seq:10}]};supplier(next.bb,()=>revision,calls);
  next.collector.seed();await finish(next.collector,reopened.db);assert.equal(calls.length,1);assert.equal(pages,1);
  revision='rev2';next.collector.invalidateSuppliers();await finish(next.collector,reopened.db);assert.equal(calls.length,2);assert.equal(pages,1);
});


test('an unchanged source larger than the hot cache does not thrash supplier recognition',async t=>{
  const {db,store}=open();t.after(()=>db.close());let pages=0;const calls:string[]=[];
  const f=fixture(db,store,async()=>{pages++;return {maxSeq:100,rows:Array.from({length:80},(_,i)=>row('m'+i,i,'TOKEN '+i)),timelinePage:{olderCursor:null}};});
  supplier(f.bb,()=> 'rev1',calls);f.bb.sdk.threads.events={list:async()=>[{seq:100}]};
  f.collector.enqueue('proj_a','thr_a');await finish(f.collector,db);assert.equal(calls.length,80);
  f.collector.enqueue('proj_a','thr_a',false,true);await finish(f.collector,db);assert.equal(calls.length,80);assert.equal(pages,1);
});

for(const mode of ['missing-head','expired-cursor'] as const)test(mode+' discards reconstructible source checkpoint while preserving durable retry intent',async t=>{
  const {db,store}=open();t.after(()=>db.close());let pages=0;
  const f=fixture(db,store,async()=>{pages++;return {maxSeq:10,rows:[row('m',1,'https://example.test/old')],timelinePage:{olderCursor:mode==='expired-cursor'?{anchorSeq:1,anchorId:'old'}:null}};});
  f.collector.enqueue('proj_a','thr_a');await f.collector.processNext(new AbortController().signal);
  if(mode==='missing-head')f.collector.enqueue('proj_a','thr_a',false,true);
  f.bb.sdk.threads.events={list:async()=>{throw new Error('offline');}};
  f.bb.sdk.threads.timeline=async()=>{pages++;if(mode==='expired-cursor')throw Object.assign(new Error('expired'),{status:400});return {maxSeq:11,rows:[],timelinePage:{olderCursor:null}};};
  await f.collector.processNext(new AbortController().signal);assert.equal(pages,2);
  if(mode==='expired-cursor'){
    assert.equal(db.prepare('SELECT 1 FROM assistant_link_checkpoints').get(),undefined);
    assert.equal((db.prepare('SELECT attempts FROM assistant_link_jobs').get() as any).attempts,1);
  }else assert.equal(store.listForwardReferences({source:sourceIdentity}).total,0);
});


for(const mode of ['append','correction','gap','boundary','server-cache-miss'] as const)test('latest-window '+mode+' uses incremental append only with complete overlapping source proof',async t=>{
 const {db,store}=open();t.after(()=>db.close());let seq=10,pages=0;const calls:string[]=[];let phase='cold';
 const f=fixture(db,store);supplier(f.bb,()=> 'rev1',calls);
 f.bb.sdk.threads.events={list:async()=>[{seq}]};
 f.bb.sdk.threads.timeline=async(args:any)=>{
  pages++;
  if(phase==='cold')return {maxSeq:10,contextBoundarySeq:null,rows:[row('old',1,'https://example.test/old')],timelinePage:{olderCursor:args.beforeAnchorId?null:{anchorSeq:1,anchorId:'old'}}};
  if(args.afterSequence){
   assert.equal(args.afterSequence,'10');
   if(mode==='server-cache-miss')return {maxSeq:11,contextBoundarySeq:null,rows:[row('new',11,'https://example.test/new')],timelinePage:{olderCursor:null}};
   return {maxSeq:11,contextBoundarySeq:mode==='boundary'?11:null,rows:[],delta:{upsertRows:[mode==='correction'?row('old',1,'corrected'):row('new',11,'https://example.test/new')],rowOrder:mode==='gap'?['new']:['old','new']},timelinePage:{olderCursor:null}};
  }
  return {maxSeq:11,contextBoundarySeq:null,rows:[row('new',11,'https://example.test/new')],timelinePage:{olderCursor:null}};
 };
 f.collector.enqueue('proj_a','thr_a');await finish(f.collector,db);assert.equal(pages,2);const before=calls.length;
 phase='warm';seq=11;f.collector.enqueue('proj_a','thr_a',false,true);await finish(f.collector,db);
 if(mode==='append'){
  assert.equal(pages,3,'one append page, zero old-page reads');assert.equal(calls.length,before+2);
  assert.equal(store.listForwardReferences({source:sourceIdentity}).total,2);
 }else {
  assert.equal(pages,mode==='server-cache-miss'?3:4);assert.equal(store.listForwardReferences({source:sourceIdentity}).total,1);
 }
});

test('4536 durable jobs do not allocate 4536 source bodies: eviction bounds collected checkpoints and keeps every queued intent',async t=>{
 const {db,store}=open();t.after(()=>db.close());const f=fixture(db,store);
 f.bb.sdk.plugins={list:async()=>({plugins:[]})};
 f.bb.sdk.threads.get=async({threadId}:any)=>({id:threadId,projectId:'proj_a'});
 f.bb.sdk.threads.timeline=async({threadId}:any)=>({maxSeq:1,contextBoundarySeq:null,rows:[{...row('m',1,'plain'),threadId}],timelinePage:{olderCursor:null}});
 for(let i=0;i<4536;i++)f.collector.enqueue('proj_a','thr_'+i);
 for(let i=0;i<40;i++)await f.collector.processNext(new AbortController().signal);
 assert.equal((db.prepare('SELECT COUNT(*) n FROM assistant_link_checkpoints').get() as any).n,32);
 assert.equal((db.prepare('SELECT COUNT(*) n FROM assistant_link_checkpoint_messages').get() as any).n,32);
 assert.equal((db.prepare('SELECT COUNT(*) n FROM assistant_link_jobs').get() as any).n,4496);
 assert.equal((db.prepare('SELECT COUNT(*) n FROM assistant_link_checkpoint_messages m LEFT JOIN assistant_link_checkpoints c ON c.thread_id=m.thread_id WHERE c.thread_id IS NULL').get() as any).n,0);
});


test('production service reconciles completed snapshots on startup and invalidates same-sequence source proofs on surface/history signals',async t=>{
 const {db,store}=open();t.after(()=>db.close());let pages=0;
 const f=fixture(db,store,async()=>{pages++;return {maxSeq:10,contextBoundarySeq:null,rows:[row('m',1,'https://example.test/a')],timelinePage:{olderCursor:null}};});
 f.bb.sdk.plugins={list:async()=>({plugins:[]})};f.bb.sdk.threads.events={list:async()=>[{seq:10}]};
 const callbacks=new Map<string,(event:any)=>void>();f.bb.sdk.subscribe=({event,threadId,callback}:any)=>{if(event==='thread:changed')assert.equal(threadId,'thr_a','compaction requires a scoped thread-detail target');callbacks.set(event,callback);return()=>callbacks.delete(event);};
 f.collector.enqueue('proj_a','thr_a');await finish(f.collector,db);assert.equal(pages,1);
 let idleCount=0;const waiting=new Map<number,()=>void>();
 const atIdle=(count:number)=>idleCount>=count?Promise.resolve():new Promise<void>(resolve=>waiting.set(count,resolve));
 const process=f.collector.processNext.bind(f.collector);f.collector.processNext=async signal=>{const worked=await process(signal);if(!worked){idleCount++;waiting.get(idleCount)?.();}return worked;};
 const controller=new AbortController();t.after(()=>controller.abort());const running=f.collector.start(controller.signal);
 await atIdle(1);assert.equal(pages,2,'startup cannot certify preferences stayed unchanged while stopped');
 callbacks.get('system:changed')!({changes:['ui-preferences-changed']});assert.equal(db.prepare('SELECT 1 FROM assistant_link_checkpoints').get(),undefined);f.collector.enqueue('proj_a','thr_a',false,true);await atIdle(2);assert.equal(pages,3);
 callbacks.get('thread:changed')!({id:'thr_a',metadata:{projectId:'proj_a'},changes:['history-rewritten']});assert.equal(db.prepare('SELECT 1 FROM assistant_link_checkpoints').get(),undefined);assert.ok(db.prepare('SELECT 1 FROM assistant_link_jobs').get());await atIdle(3);assert.equal(pages,4);
 controller.abort();await running;assert.equal(callbacks.size,0);
});

for(const kind of ['history-rewritten','history-compacted','events-appended'] as const)test('same-maxSeq earlier message '+kind+' cannot retain stale source bodies through native detail invalidation',async t=>{
 const {db,store}=open();t.after(()=>db.close());let changed=false;let pages=0;
 const f=fixture(db,store);f.bb.sdk.plugins={list:async()=>({plugins:[]})};f.bb.sdk.threads.events={list:async()=>[{seq:10}]};
 f.bb.sdk.threads.timeline=async(args:any)=>{pages++;return {maxSeq:10,contextBoundarySeq:null,
  rows:args.beforeAnchorId?(changed?(kind==='history-compacted'?[]:[row('older',1,'https://example.test/corrected')]):[row('older',1,'https://example.test/original')]):[row('newer',2,'https://example.test/newer')],
  timelinePage:{olderCursor:args.beforeAnchorId?null:{anchorSeq:1,anchorId:'older'}}};};
 let detail:((event:any)=>void)|undefined;
 f.bb.sdk.subscribe=({event,threadId,callback}:any)=>{
  if(event==='thread:changed'){assert.equal(threadId,'thr_a');detail=callback;return()=>{if(detail===callback)detail=undefined;};}
  return()=>{};
 };
 let idleCount=0;const waiting=new Map<number,()=>void>();const atIdle=(n:number)=>idleCount>=n?Promise.resolve():new Promise<void>(resolve=>waiting.set(n,resolve));
 const process=f.collector.processNext.bind(f.collector);f.collector.processNext=async signal=>{const worked=await process(signal);if(!worked){idleCount++;waiting.get(idleCount)?.();}return worked;};
 const controller=new AbortController();t.after(()=>controller.abort());f.collector.enqueue('proj_a','thr_a');const running=f.collector.start(controller.signal);await atIdle(1);
 assert.equal(pages,2);assert.ok(store.listForwardReferences({source:sourceIdentity}).rows.some(r=>r.target.keys.href==='https://example.test/original'));
 const cached=db.prepare('SELECT 1 FROM assistant_link_checkpoints').get();if(cached)assert.ok(detail,'a cached source needs the native scoped detail subscription');
 changed=true;if(detail){detail({id:'thr_a',metadata:{timelineSequence:10},changes:[kind]});assert.ok(db.prepare('SELECT 1 FROM assistant_link_jobs').get(),'late source signals own a durable successor without another view request');}else f.collector.enqueue('proj_a','thr_a',false,true);
 await atIdle(2);
 const hrefs=store.listForwardReferences({source:sourceIdentity}).rows.map(r=>r.target.keys.href);
 assert.equal(pages,4);assert.equal(hrefs.includes('https://example.test/original'),false);
 assert.equal(hrefs.includes('https://example.test/corrected'),kind!=='history-compacted');
 controller.abort();await running;assert.equal(detail,undefined);
});

test('offline same-sequence mutation without a native delta witness discards partial bodies before resuming',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'cross-offline-rewrite-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const path=join(dir,'queue.sqlite');
 const initial=open(path);const first=fixture(initial.db,initial.store,async()=>({maxSeq:10,contextBoundarySeq:null,rows:[row('m',2,'https://example.test/removed')],timelinePage:{olderCursor:{anchorSeq:1,anchorId:'older'}}}));
 first.collector.enqueue('proj_a','thr_a');await first.collector.processNext(new AbortController().signal);first.collector.dispose();initial.db.close();
 const reopened=open(path,false);t.after(()=>reopened.db.close());let witnesses=0;
 const next=fixture(reopened.db,reopened.store);next.bb.sdk.plugins={list:async()=>({plugins:[]})};next.bb.sdk.threads.events={list:async()=>[{seq:10}]};next.bb.sdk.subscribe=()=>()=>{};
 next.bb.sdk.threads.timeline=async(args:any)=>{if(args.afterSequence)witnesses++;return {maxSeq:10,contextBoundarySeq:null,rows:[row('m',2,'https://example.test/current')],timelinePage:{olderCursor:null}};};
 let idle!:()=>void;const reachedIdle=new Promise<void>(resolve=>{idle=resolve;});const process=next.collector.processNext.bind(next.collector);
 next.collector.processNext=async signal=>{const worked=await process(signal);if(!worked)idle();return worked;};
 const controller=new AbortController();const running=next.collector.start(controller.signal);await reachedIdle;controller.abort();await running;
 assert.equal(witnesses,1);assert.deepEqual(reopened.store.listForwardReferences({source:sourceIdentity}).rows.map(r=>r.target.keys.href),['https://example.test/current']);
});


test('pure unchanged-source reuse refreshes observedAt without changing evidence revision',async t=>{
 const {db,store}=open();t.after(()=>db.close());let now=100000,pages=0;t.mock.method(Date,'now',()=>now);
 const f=fixture(db,store,async()=>{pages++;return {maxSeq:10,rows:[row('m',1,'https://example.test/a')],timelinePage:{olderCursor:null}};});
 f.bb.sdk.plugins={list:async()=>({plugins:[]})};f.bb.sdk.threads.events={list:async()=>[{seq:10}]};
 f.collector.enqueue('proj_a','thr_a');await finish(f.collector,db);const before=store.mentionState(sourceIdentity);assert.equal(before.occurrences[0]!.observedAt,now);
 now+=1000;f.collector.enqueue('proj_a','thr_a',false,true);await finish(f.collector,db);const after=store.mentionState(sourceIdentity);
 assert.equal(after.occurrences[0]!.observedAt,now);assert.equal(after.revision,before.revision);assert.equal(pages,1);
});
