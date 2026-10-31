import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { createRegisteredHandlerRpc } from '@phosphorco/bb-turn-results/testing';
import { createResultsSupplierClient } from '@phosphorco/bb-turn-results/bb';
import { canonicalJson, claimKey } from '@phosphorco/bb-turn-results';
import galleryPlugin from '../server.ts';
import imagePlugin from '../../turn-result-images/server.ts';
import { JSDOM } from 'jsdom';
import { createGalleryRuntime } from '../gallery/runtime.ts';
import { galleryAnchors } from '../gallery/anchors.ts';
import { consumeTurnSource } from '../gallery/consume.ts';
import { adaptCompletedEvent } from '@phosphorco/bb-turn-results/events';
import { createGalleryIndex } from '../gallery/index.ts';
import { GALLERY_METHODS } from '../gallery/rpc.ts';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=', 'base64');
const sha256 = createHash('sha256').update(png).digest('hex');
const native = { id: 'event', threadId: 'thread', seq: 3, createdAt: 100, scope: { kind: 'turn', turnId: 'turn' }, type: 'item/completed',
  data: { item: { id: 'item', type: 'imageGeneration', status: 'completed', error: null, path: '/saved/image.png', result: png.toString('base64'), transparentBackground: false } } };
const timeline = [
  { id: 'work1', threadId: 'thread', turnId: 'turn', kind: 'turn', sourceSeqStart: 1, sourceSeqEnd: 7 },
  { id: 'work2', threadId: 'thread', turnId: 'turn', kind: 'turn', sourceSeqStart: 8, sourceSeqEnd: 10 },
  { id: 'opaque-row', threadId: 'thread', turnId: 'turn', kind: 'conversation', role: 'assistant', sourceSeqStart: 11, sourceSeqEnd: 12 },
  { id: 'adjacent', threadId: 'thread', turnId: 'next', kind: 'conversation', role: 'assistant', sourceSeqStart: 13, sourceSeqEnd: 16 },
];
const anchor = galleryAnchors(timeline, 'thread', 'snapshot', true)[0];
async function fixture(t) {
  let events = [structuredClone(native)], reads = 0;
  const queries = [];
  const filtered = args => events.filter(row => row.threadId === args.threadId
    && row.seq > Number(args.afterSeq ?? -1) && row.seq < Number(args.beforeSeq ?? Infinity))
    .sort((a, b) => args.order === 'desc' ? b.seq - a.seq : a.seq - b.seq).slice(0, Number(args.limit ?? 32));
  const imageHost = createFakePluginHost({ pluginId: 'turn-result-images', sdk: {
    threads: { events: { async list(args) { return filtered(args); } }, async get() { return { environmentId: 'environment' }; } },
    environments: { async get() { return { hostId: 'host' }; } },
    files: { async read() { reads++; return { path: '/saved/image.png', content: png.toString('base64'), contentEncoding: 'base64', sizeBytes: png.length, mimeType: 'image/png', sha256 }; } },
  } });
  imagePlugin(imageHost.bb);
  let galleryHost = createFakePluginHost({ pluginId: 'turn-results' }); galleryPlugin(galleryHost.bb);
  const call = (method, input) => galleryHost.harness.behavior.callRpc(method, JSON.parse(canonicalJson(input, 262144)));
  const lookups = [], applications = [];
  const backend = {
    pending: input => call(GALLERY_METHODS.pending, input),
    knownIdentities: (threadId, owner, refs) => { lookups.push({ threadId, owner, refs }); return call(GALLERY_METHODS.known, { threadId, owner, refs }); },
    read: (threadId, turnId, _signal, after) => call(GALLERY_METHODS.read, { threadId, turnId, ...(after ? { after } : {}) }),
    stage: (threadId, owner, id) => call(GALLERY_METHODS.stage, { threadId, owner, id }),
    async apply(page) { applications.push(page); const value = await call(GALLERY_METHODS.apply, page); assert.ok(['committed', 'unchanged'].includes(value.state), JSON.stringify(value)); },
  };
  const imageRpc = createRegisteredHandlerRpc(imageHost, 'turn-result-images');
  const client = createResultsSupplierClient({ plugins: imageRpc }, 'turn-result-images');
  const described = await client.describe(); assert.equal(described.state, 'ready');
  const source = { pluginId: 'turn-result-images', client, capabilities: described.capabilities };
  t.after(async () => { await galleryHost.harness.lifecycle.dispose(); await imageHost.harness.lifecycle.dispose(); });
  return { backend, source, call, lookups, applications, get db() { return galleryHost.bb.storage.database(); }, runtimeSdk: { plugins: {
    async list() { return { plugins: [{ id: 'turn-result-images', enabled: true, status: 'running' }] }; },
    async callRpc(args) { return args.pluginId === 'turn-results' ? args.outputSchema.parse(await call(args.method, args.input)) : imageRpc.callRpc(args); },
  } }, queries, add(row) { events.push(row); },
    pruneResult(seq) { const event = events.find(row => row.seq === seq); event.data.item.result = '';
      event.data.item.truncation = { result: { originalLength: png.toString('base64').length, retainedHeadLength: 0, retainedTailLength: 0, truncatedAt: 1000 } }; return event; }, reader: { async list(args) { queries.push(args); return filtered(args); } }, get reads() { return reads; },
    prune() { events = []; }, async reopen() { galleryHost = await galleryHost.harness.lifecycle.reload(galleryPlugin); } };
}
test('actual pure selector/source RPC/index atomically retains original occurrence across native pruning and host reload', async t => {
  const f = await fixture(t), signal = new AbortController().signal;
  const result = await consumeTurnSource(f.backend, f.reader, f.source, anchor, signal); assert.equal(result.continued, false);
  assert.deepEqual([anchor.rowId, anchor.sourceSeqStart, anchor.sourceSeqEnd, anchor.turnSeqStart, anchor.turnSeqEnd], ['opaque-row', 11, 12, 1, 12]);
  assert.deepEqual(f.queries.map(q => [q.afterSeq, q.beforeSeq]), [['0', '13']]);
  const first = await f.backend.read('thread', 'turn', signal); assert.equal(first.page.rows.length, 1);
  const row = first.page.rows[0]; assert.equal(row.resolution.knowledge, 'confirmed'); assert.equal(row.identity.ref.source.eventId, 'event');
  assert.equal(row.resolution.route.target.hostId, 'host'); assert.equal(f.reads, 1);
  f.prune(); await f.reopen(); await consumeTurnSource(f.backend, f.reader, f.source, anchor, signal);
  const second = await f.backend.read('thread', 'turn', signal);
  assert.deepEqual(second.page.rows[0].identity, row.identity); assert.deepEqual(second.page.rows[0].resolution.proof, row.resolution.proof);
  assert.equal(f.reads, 1); assert.equal(second.page.rows[0].unresolved, false);
});
test('unscoped native prefix parks atomically without consuming cursor or creating guessed result', async t => {
  const f = await fixture(t), signal = new AbortController().signal;
  const broken = { ...native, scope: { kind: 'thread' } };
  const result = await consumeTurnSource(f.backend, { async list() { return [broken]; } }, f.source, anchor, signal);
  assert.equal(result.continued, false); assert.match(result.reason, /gap/);
  const stage = await f.backend.stage('thread', 'turn-result-images', 'native:turn', signal);
  assert.equal(stage.value.status, 'parked'); assert.equal(stage.value.debt.afterSeq, 0);
  assert.equal((await f.backend.read('thread', 'turn', signal)).page.rows.length, 0); assert.equal(f.reads, 0);
});
test('abort-ignoring native read cannot reach recognition or any backend write', async t => {
  const f = await fixture(t), controller = new AbortController();
  let release, recognized = 0, applied = 0;
  const source = { ...f.source, client: { ...f.source.client, async recognize() { recognized++; throw Error('must not run'); } } };
  const operation = consumeTurnSource({ ...f.backend, async apply() { applied++; } }, { list: () => new Promise(resolve => { release = resolve; }) }, source, anchor, controller.signal);
  while (!release) await new Promise(resolve => setTimeout(resolve, 0));
  controller.abort(); await assert.rejects(operation); release([native]); await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(recognized, 0); assert.equal(applied, 0);
});

test('real timeline start expansion with unchanged end restarts a complete persisted native stage', async t => {
  const f = await fixture(t), signal = new AbortController().signal;
  const narrow = galleryAnchors(timeline.slice(1), 'thread', 'older-snapshot', true)[0];
  assert.equal(narrow.turnSeqStart, 8); assert.equal(narrow.turnSeqEnd, 12);
  await consumeTurnSource(f.backend, f.reader, f.source, narrow, signal);
  let stage = await f.backend.stage('thread', 'turn-result-images', 'native:turn', signal);
  assert.equal(stage.value.status, 'complete'); assert.equal(stage.value.debt.fromSeq, 8); assert.equal(stage.value.debt.throughSeq, 12);
  assert.equal((await f.backend.read('thread', 'turn', signal)).page.rows.length, 0);
  await f.reopen();
  await consumeTurnSource(f.backend, f.reader, f.source, anchor, signal);
  stage = await f.backend.stage('thread', 'turn-result-images', 'native:turn', signal);
  assert.equal(stage.value.status, 'complete'); assert.equal(stage.value.debt.fromSeq, 1); assert.equal(stage.value.debt.throughSeq, 12);
  assert.deepEqual(f.queries.map(q => [q.afterSeq, q.beforeSeq]), [['7', '13'], ['0', '13']]);
  const row = (await f.backend.read('thread', 'turn', signal)).page.rows[0];
  assert.equal(row.identity.ref.source.seq, 3); assert.equal(row.resolution.knowledge, 'confirmed'); assert.equal(f.reads, 1);
  assert.equal(narrow.rowId, anchor.rowId); assert.equal(narrow.sourceSeqStart, anchor.sourceSeqStart);
});
test('native scope correction drops old recognition cursors and legacy end-only completion', async t => {
  for (const legacy of [false, true]) {
    const f = await fixture(t), signal = new AbortController().signal;
    await f.backend.apply({ threadId: 'thread', owner: 'turn-result-images', changes: [],
      stage: { id: 'native:turn', expectedVersion: null, value: { stage: 'recognize', cursor: legacy ? null : 'stale-recognition-cursor',
        status: legacy ? 'complete' : 'ready', debt: { afterSeq: 10, throughSeq: 12, ...(legacy ? {} : { fromSeq: 8 }) } } } });
    await consumeTurnSource(f.backend, f.reader, f.source, anchor, signal);
    assert.deepEqual(f.queries.map(q => [q.afterSeq, q.beforeSeq]), [['0', '13']]);
    const rows = (await f.backend.read('thread', 'turn', signal)).page.rows;
    assert.equal(rows.length, 1); assert.equal(rows[0].resolution.knowledge, 'confirmed');
    const stage = await f.backend.stage('thread', 'turn-result-images', 'native:turn', signal);
    assert.equal(stage.value.cursor, null); assert.equal(stage.value.status, 'complete');
    assert.equal(stage.value.debt.fromSeq, 1); assert.equal(stage.value.debt.throughSeq, 12);
  }
});
test('production partial/adjacent/interleaved timeline rules do not discover adjacent images', async t => {
  const f = await fixture(t), signal = new AbortController().signal;
  f.add({ ...structuredClone(native), id: 'next-image', seq: 15, scope: { kind: 'turn', turnId: 'next' } });
  const partial = galleryAnchors(timeline, 'thread', 'partial', false);
  assert.equal(partial.some(a => a.turnId === 'turn'), false);
  const interleaved = [timeline[0], { ...timeline[3], sourceSeqStart: 8, sourceSeqEnd: 9 }, timeline[1], timeline[2]];
  assert.equal(galleryAnchors(interleaved, 'thread', 'bad', true).some(a => a.turnId === 'turn'), false);
  await consumeTurnSource(f.backend, f.reader, f.source, anchor, signal);
  assert.deepEqual(f.queries.map(q => [q.afterSeq, q.beforeSeq]), [['0', '13']]);
  assert.equal((await f.backend.read('thread', 'next', signal)).page.rows.length, 0);
  const rows = (await f.backend.read('thread', 'turn', signal)).page.rows;
  assert.equal(rows.length, 1); assert.equal(rows[0].identity.ref.source.seq, 3); assert.equal(f.reads, 1);
});

test('feed scope restart clears a persisted cursor on changed start with unchanged end', async t => {
  const f = await fixture(t), signal = new AbortController().signal;
  await consumeTurnSource(f.backend, f.reader, f.source, anchor, signal);
  const epoch = (await f.backend.read('thread', 'turn', signal)).page.rows[0].resolution.revision.epoch;
  await f.backend.apply({ threadId: 'thread', owner: 'turn-result-images', changes: [],
    stage: { id: 'feed:turn', expectedVersion: null, value: { stage: 'feed', cursor: 'narrow-only', status: 'complete', debt: { fromSeq: 8, throughSeq: 12 } } } });
  const calls = [];
  const source = { ...f.source, capabilities: { ...f.source.capabilities, supplier: { ...f.source.capabilities.supplier, enumerate: true } },
    client: { ...f.source.client, async enumerate(input) {
      calls.push(input);
      return { state: 'page', epoch, phase: 'changes', throughRevision: 0, rows: [], nextCursor: 'full-only', settled: true,
        coverage: { retainedFrom: null, unplaced: 0, complete: true } };
    } } };
  await consumeTurnSource(f.backend, f.reader, source, anchor, signal);
  assert.deepEqual(calls[0].range, { fromSeq: 1, throughSeq: 12 }); assert.equal(calls[0].cursor, null);
  const stage = await f.backend.stage('thread', 'turn-result-images', 'feed:turn', signal);
  assert.equal(stage.value.cursor, 'full-only'); assert.equal(stage.value.debt.fromSeq, 1); assert.equal(stage.value.debt.throughSeq, 12);
  await consumeTurnSource(f.backend, f.reader, source, anchor, signal);
  assert.equal(calls[1].cursor, 'full-only');
  assert.equal((await f.backend.read('thread', 'turn', signal)).page.rows.length, 1);
});

for (const changed of ['start', 'end']) test(`runtime aborts stale native work and reschedules on changed ${changed}`, async t => {
  const f = await fixture(t), dom = new JSDOM('', { pretendToBeVisual: true });
  const saved = globalThis.document; globalThis.document = dom.window.document;
  const wait = async condition => { for (let n = 0; n < 200; n++) { if (condition()) return; await new Promise(resolve => setTimeout(resolve, 5)); } assert.fail('runtime did not advance'); };
  let release, firstSignal;
  const queries = [];
  const sdk = { ...f.runtimeSdk, threads: { events: { list(args) {
    queries.push(args);
    if (queries.length === 1) { firstSignal = args.signal; return new Promise(resolve => { release = resolve; }); }
    return f.reader.list(args);
  } } } };
  const runtime = createGalleryRuntime(sdk);
  runtime.backend.pending = f.backend.pending;
  let first, second;
  try {
    const initial = changed === 'start' ? galleryAnchors(timeline.slice(1), 'thread', 'initial', true)[0] : anchor;
    const updated = changed === 'start' ? anchor : galleryAnchors(timeline.map(row => row.id === 'opaque-row' ? { ...row, sourceSeqEnd: 13 } : row.id === 'adjacent' ? { ...row, sourceSeqStart: 14 } : row), 'thread', 'next', true)[0];
    first = runtime.retain(initial);
    await wait(() => !!release);
    assert.equal(firstSignal.aborted, false);
    first.dispose(); // This view replaces its scope; an independent split lease must not be cancelled.
    second = runtime.retain(updated);
    assert.equal(firstSignal.aborted, true, 'bound change synchronously retires old native slice');
    await wait(() => second.store.state.rows.some(row => row.resolution?.knowledge === 'confirmed') && !second.store.state.busy);
    assert.deepEqual(queries.map(q => [q.afterSeq, q.beforeSeq]), changed === 'start' ? [['7', '13'], ['0', '13']] : [['0', '13'], ['0', '14']]);
    const before = await f.backend.read('thread', 'turn');
    release([native]); await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual((await f.backend.read('thread', 'turn')).page.rows[0].identity, before.page.rows[0].identity);
    const stage = await f.backend.stage('thread', 'turn-result-images', 'native:turn');
    assert.equal(stage.version, 1, 'retired slice did not commit a stage before or after its late result');
    assert.equal(stage.value.debt.fromSeq, updated.turnSeqStart); assert.equal(stage.value.debt.throughSeq, updated.turnSeqEnd);
    assert.equal(f.reads, 1);
  } finally { first?.dispose(); second?.dispose(); runtime.dispose(); globalThis.document = saved; dom.window.close(); }
});

test('derived narrow seq9 survives pruning/reopen while same-end expansion admits healthy seq3 atomically', async t => {
  const f = await fixture(t), signal = new AbortController().signal;
  f.add({ ...structuredClone(native), id: 'event9', seq: 9, data: { item: { ...structuredClone(native.data.item), id: 'item9' } } });
  const narrow = galleryAnchors(timeline.slice(1), 'thread', 'narrow', true)[0];
  await consumeTurnSource(f.backend, f.reader, f.source, narrow, signal);
  const before = (await f.backend.read('thread', 'turn')).page.rows[0];
  assert.equal(before.identity.ref.source.seq, 9); assert.equal(before.resolution.knowledge, 'confirmed');
  const pruned = f.pruneResult(9), selected = await adaptCompletedEvent(pruned); assert.equal(selected.state, 'admitted');
  const fresh = await f.source.client.recognize({ version: 1, context: { consumer: { pluginId: 'turn-results', surface: 'inline-gallery' },
    threadId: 'thread', range: { fromSeq: 1, throughSeq: 12 } }, events: [selected.event], page: { cursor: null, limit: 8 } });
  assert.notEqual(fresh.candidates[0].identity.evidence.selectedDigest, before.identity.evidence.selectedDigest);
  assert.equal(claimKey('turn-result-images', fresh.candidates[0].identity.ref), before.key);
  const conflict = await f.call(GALLERY_METHODS.apply, { threadId: 'thread', owner: 'turn-result-images',
    changes: [{ kind: 'candidate', identity: fresh.candidates[0].identity }] });
  assert.deepEqual(conflict, { state: 'conflict', reason: 'immutable-identity-conflict' });
  const narrowStage = await f.backend.stage('thread', 'turn-result-images', 'native:turn');
  await f.reopen();
  const result = await consumeTurnSource(f.backend, f.reader, f.source, anchor, signal); assert.equal(result.continued, false);
  const after = (await f.backend.read('thread', 'turn')).page.rows;
  assert.deepEqual(after.map(row => row.identity.ref.source.seq), [3, 9]);
  assert.ok(after.every(row => row.resolution.knowledge === 'confirmed'));
  assert.deepEqual(after[1].identity, before.identity); assert.deepEqual(after[1].resolution.proof, before.resolution.proof);
  assert.deepEqual(f.queries.map(q => [q.afterSeq, q.beforeSeq]), [['7', '13'], ['0', '13']]);
  const applied = f.applications.filter(page => page.stage?.id === 'native:turn');
  assert.equal(applied.length, 2); assert.equal(applied[1].stage.expectedVersion, narrowStage.version);
  assert.deepEqual(applied[1].changes.map(row => row.identity.ref.source.seq), [3, 9]);
  assert.deepEqual(applied[1].changes[1].identity, before.identity);
  const fullStage = await f.backend.stage('thread', 'turn-result-images', 'native:turn');
  assert.equal(fullStage.value.status, 'complete'); assert.equal(fullStage.value.debt.fromSeq, 1); assert.equal(fullStage.value.debt.throughSeq, 12);
  const fullVersion = fullStage.version;
  await f.reopen(); await consumeTurnSource(f.backend, f.reader, f.source, anchor, signal);
  assert.equal((await f.backend.stage('thread', 'turn-result-images', 'native:turn')).version, fullVersion);
  assert.deepEqual((await f.backend.read('thread', 'turn')).page.rows.map(row => row.identity), after.map(row => row.identity));
  // Replay the earlier demand again, then widen: neither rescoped page replaces seq9.
  await consumeTurnSource(f.backend, f.reader, f.source, narrow, signal);
  await consumeTurnSource(f.backend, f.reader, f.source, anchor, signal);
  const replay = (await f.backend.read('thread', 'turn')).page.rows;
  assert.deepEqual(replay[1].identity, before.identity); assert.deepEqual(replay[1].resolution.proof, before.resolution.proof);
  assert.equal(f.reads, 2, 'healthy seq3 resolves once; pruned known seq9 uses retained proof');
  assert.ok(f.lookups.every(call => call.refs.length <= 8));
});

test('multiple recognition pages reuse exact retained identities across repeated scope replay', async t => {
  const f = await fixture(t), signal = new AbortController().signal;
  f.prune();
  for (let seq = 1; seq <= 10; seq++) f.add({ ...structuredClone(native), id: `event${seq}`, seq,
    data: { item: { ...structuredClone(native.data.item), id: `item${seq}` } } });
  const narrow = galleryAnchors(timeline.slice(1), 'thread', 'narrow', true)[0];
  await consumeTurnSource(f.backend, f.reader, f.source, narrow, signal);
  const old = (await f.backend.read('thread', 'turn')).page.rows;
  for (const seq of [8, 9, 10]) f.pruneResult(seq);
  await f.reopen();
  for (let replay = 0; replay < 2; replay++) {
    let continued = true, demands = 0;
    while (continued && demands++ < 5) continued = (await consumeTurnSource(f.backend, f.reader, f.source, anchor, signal)).continued;
    assert.equal(continued, false); assert.equal(demands, 2);
    const first = await f.backend.read('thread', 'turn');
    const second = await f.backend.read('thread', 'turn', signal, first.page.next);
    const rows = [...first.page.rows, ...second.page.rows];
    assert.deepEqual(rows.map(row => row.identity.ref.source.seq), [1,2,3,4,5,6,7,8,9,10]);
    for (const prior of old) {
      const row = rows.find(row => row.key === prior.key);
      assert.deepEqual(row.identity, prior.identity); assert.deepEqual(row.resolution.proof, prior.resolution.proof);
    }
    await consumeTurnSource(f.backend, f.reader, f.source, narrow, signal);
    await f.reopen();
  }
  assert.ok(f.lookups.some(call => call.refs.length === 8)); assert.ok(f.lookups.every(call => call.refs.length <= 8));
});

test('registered known-identity lookup is strict owner/thread/ref bounded and read-only', async t => {
  const f = await fixture(t), signal = new AbortController().signal;
  await consumeTurnSource(f.backend, f.reader, f.source, anchor, signal);
  const old = (await f.backend.read('thread', 'turn')).page.rows[0], ref = old.identity.ref;
  const input = { threadId: 'thread', owner: 'turn-result-images', refs: [ref] };
  const changes = f.db.prepare('SELECT total_changes() n').get().n;
  assert.deepEqual(await f.call(GALLERY_METHODS.known, input), [old.identity]);
  assert.equal(f.db.prepare('SELECT total_changes() n').get().n, changes);
  assert.ok(Buffer.byteLength(canonicalJson(await f.call(GALLERY_METHODS.known, input))) <= 65536);
  assert.deepEqual(await f.call(GALLERY_METHODS.known, { ...input, owner: 'other-owner' }), []);
  assert.deepEqual(await f.call(GALLERY_METHODS.known, { ...input, refs: [{ ...ref, source: { ...ref.source, eventId: 'missing' } }] }), []);
  for (const bad of [
    { ...input, keys: [old.key] }, { ...input, refs: [old.key] }, { ...input, owner: 'INVALID OWNER' },
    { ...input, threadId: 'foreign-thread' }, { ...input, refs: Array(9).fill(ref) },
    { ...input, refs: [ref, ref] }, { ...input, refs: [{ ...ref, key: old.key }] },
    { ...input, refs: [{ ...ref, source: { ...ref.source, threadId: 'foreign-thread' } }] },
  ]) await assert.rejects(f.call(GALLERY_METHODS.known, bad));
  assert.equal(f.db.prepare('SELECT total_changes() n').get().n, changes);
});

test('aborted or foreign retained lookup cannot apply a recognition page or advance native stage', async t => {
  for (const mode of ['aborted', 'foreign']) {
    const f = await fixture(t), controller = new AbortController();
    await consumeTurnSource(f.backend, f.reader, f.source, anchor, controller.signal);
    const old = (await f.backend.read('thread', 'turn')).page.rows[0];
    const stage = await f.backend.stage('thread', 'turn-result-images', 'native:turn');
    let release;
    const corrected = { ...anchor, turnSeqStart: 0 };
    const backend = { ...f.backend, knownIdentities() {
      if (mode === 'aborted') return new Promise(resolve => { release = resolve; });
      return Promise.resolve([{ ...old.identity, ref: { ...old.identity.ref, source: { ...old.identity.ref.source, threadId: 'foreign-thread' } } }]);
    } };
    const operation = consumeTurnSource(backend, f.reader, f.source, corrected, controller.signal);
    if (mode === 'aborted') {
      while (!release) await new Promise(resolve => setTimeout(resolve, 0));
      controller.abort(); await assert.rejects(operation); release([old.identity]);
      await new Promise(resolve => setTimeout(resolve, 0));
    } else await assert.rejects(operation, /Invalid retained claim lookup/);
    assert.deepEqual(await f.backend.stage('thread', 'turn-result-images', 'native:turn'), stage);
    assert.deepEqual((await f.backend.read('thread', 'turn')).page.rows[0].identity, old.identity);
  }
});


test('known lookup performs at most eight exact primary-key claim reads with no scan or mutation', async t => {
  const f = await fixture(t), signal = new AbortController().signal;
  await consumeTurnSource(f.backend, f.reader, f.source, anchor, signal);
  const old = (await f.backend.read('thread', 'turn')).page.rows[0];
  const reads = [];
  const db = new Proxy(f.db, { get(target, prop) {
    if (prop === 'prepare') return sql => {
      const statement = target.prepare(sql);
      return new Proxy(statement, { get(stmt, method) {
        if (method === 'get' || method === 'all' || method === 'run') return (...args) => {
          reads.push({ sql, method, args }); return stmt[method](...args);
        };
        const value = Reflect.get(stmt, method); return typeof value === 'function' ? value.bind(stmt) : value;
      } });
    };
    const value = Reflect.get(target, prop); return typeof value === 'function' ? value.bind(target) : value;
  } });
  const index = createGalleryIndex(db); reads.length = 0;
  const refs = [old.identity.ref, ...Array.from({ length: 7 }, (_, n) => ({ ...old.identity.ref,
    source: { ...old.identity.ref.source, eventId: `not-retained${n}` } }))];
  assert.deepEqual(index.knownIdentities('thread', 'turn-result-images', refs), [old.identity]);
  assert.equal(reads.length, 9, 'one thread tombstone read plus eight claim key reads');
  assert.ok(reads.every(row => row.method === 'get' && row.sql === 'SELECT * FROM gallery_records WHERE kind=? AND record_key=?'));
  assert.equal(reads.filter(row => row.args[0] === 'claim').length, 8);
});

test('fault during reconciled image page rolls back new claim and full-scope stage together', async t => {
  const f = await fixture(t), signal = new AbortController().signal;
  f.add({ ...structuredClone(native), id: 'event9', seq: 9, data: { item: { ...structuredClone(native.data.item), id: 'item9' } } });
  const narrow = galleryAnchors(timeline.slice(1), 'thread', 'narrow', true)[0];
  await consumeTurnSource(f.backend, f.reader, f.source, narrow, signal);
  const before = (await f.backend.read('thread', 'turn')).page.rows[0];
  const stage = await f.backend.stage('thread', 'turn-result-images', 'native:turn');
  f.pruneResult(9); await f.reopen();
  f.db.exec("CREATE TRIGGER reject_expansion BEFORE INSERT ON gallery_records WHEN NEW.kind='claim' AND NEW.seq=3 BEGIN SELECT RAISE(ABORT,'fixture rollback'); END;");
  await assert.rejects(consumeTurnSource(f.backend, f.reader, f.source, anchor, signal));
  assert.deepEqual((await f.backend.read('thread', 'turn')).page.rows.map(row => row.identity), [before.identity]);
  assert.deepEqual(await f.backend.stage('thread', 'turn-result-images', 'native:turn'), stage);
  f.db.exec('DROP TRIGGER reject_expansion');
  await consumeTurnSource(f.backend, f.reader, f.source, anchor, signal);
  const after = (await f.backend.read('thread', 'turn')).page.rows;
  assert.deepEqual(after.map(row => row.identity.ref.source.seq), [3,9]);
  assert.deepEqual(after[1].identity, before.identity); assert.deepEqual(after[1].resolution.proof, before.resolution.proof);
  assert.equal((await f.backend.stage('thread', 'turn-result-images', 'native:turn')).value.debt.fromSeq, 1);
});
