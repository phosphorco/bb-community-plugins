import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { createRegisteredHandlerRpc } from '@phosphorco/bb-turn-results/testing';
import { registerTurnResultsParticipant, createResultsConsumerClient, createResultsSupplierClient } from '@phosphorco/bb-turn-results/bb';
import { buildResolveOutput, canonicalJson } from '@phosphorco/bb-turn-results';

// A baseline run substitutes only preserved pre-change source bytes. Imports
// still resolve from the canonical tree; no source rollback or runtime reload.
if (process.env.TURN_RESULTS_BASELINE_DIR) registerHooks({ load(url, context, next) {
  const path = new URL(url).pathname;
  const name = ['runtime.ts', 'index.ts'].find(name => path.endsWith(`/turn-results/gallery/${name}`));
  if (!name) return next(url, context);
  return { format: 'module', shortCircuit: true, source: stripTypeScriptTypes(
    readFileSync(`${process.env.TURN_RESULTS_BASELINE_DIR}/${name}`, 'utf8'), { mode: 'transform', sourceUrl: url }) };
} });
const [{ default: galleryPlugin }, { createGalleryRuntime }, { consumeTurnSource }, { GALLERY_METHODS }] = await Promise.all([
  import('../server.ts'), import('../gallery/runtime.ts'), import('../gallery/consume.ts'), import('../gallery/rpc.ts'),
]);
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const anchor = { threadId: 'thread', turnId: 'turn', rowId: 'opaque-row', sourceSeqStart: 1, sourceSeqEnd: 10,
  turnSeqStart: 1, turnSeqEnd: 10, historySnapshot: 'fixture-snapshot' };

async function fixture(t) {
  const dom = new JSDOM('', { pretendToBeVisual: true }), saved = globalThis.document;
  globalThis.document = dom.window.document;
  const host = createFakePluginHost({ pluginId: 'turn-results' }); galleryPlugin(host.bb);
  const galleryRpc = createRegisteredHandlerRpc(host, 'turn-results'), owners = ['owner-a', 'owner-b'], supplierHosts = [];
  const calls = [], applies = [], transports = new Map();
  let result = false, fail = false, runtime, lease, hold = null, rawCalls = 0, maxRawCalls = 0;
  const held = new Set(), leases = new Set();
  const identity = { version: 1, ref: { source: { threadId: 'thread', turnId: 'turn', eventId: 'result-event', itemId: 'item', seq: 3, eventType: 'item/completed' },
    member: 'result', kind: 'example/result' }, artifact: { provider: 'owner-a', id: 'result', kind: 'image' }, specificity: 'typed',
    evidence: { basis: 'native-completion', selectedDigest: 'a'.repeat(64), sites: [], targetUrls: [] }, lookup: null };
  const value = { identity, proof: { kind: 'native-image', source: identity.ref.source, selectedDigest: identity.evidence.selectedDigest },
    revision: { epoch: 'epoch-owner-a', sequence: 1 }, knowledge: 'confirmed',
    outcomeEvidence: { kind: 'observation', id: 'receipt', digest: 'b'.repeat(64), recordedAt: 100 },
    availability: { state: 'available', asOf: 100, expiresAt: null }, route: { kind: 'url', href: 'https://fixture.invalid/result' },
    provenance: { originHost: { state: 'unknown', reason: 'not-recorded' }, artifactLocation: { state: 'unknown', reason: 'not-verified' } },
    fallback: { kind: 'link', title: 'Saved result' }, spans: { width: 1, height: 1 } };
  for (const id of owners) {
    const supplier = createFakePluginHost({ pluginId: id }); supplierHosts.push(supplier);
    registerTurnResultsParticipant(supplier.bb, { pluginId: id, capabilities: { revision: 'v1', supplier: { recognize: false, resolve: true, enumerate: true,
      kinds: [{ kind: 'example/result', namespace: 'example', neutralLabel: 'Result', confirmedLabel: 'Created', specificity: 'typed', memberVersion: 'v1', equivalenceNamespaces: [] }] } },
      async enumerate() {
        if (fail && id === 'owner-a') { fail = false; throw Error('One fixture outage'); }
        return { state: 'page', epoch: `epoch-${id}`, phase: 'changes', throughRevision: result && id === 'owner-a' ? 1 : 0,
          rows: result && id === 'owner-a' ? [{ kind: 'upsert', value }] : [], nextCursor: `settled-${id}`, settled: true,
          coverage: { retainedFrom: null, unplaced: 0, complete: true } };
      },
      async resolve(input) { return buildResolveOutput(input, input.items.map(() => ({ state: 'resolved', value }))); },
    });
    transports.set(id, createRegisteredHandlerRpc(supplier, id));
  }
  const sdk = { plugins: {
    async list() { return { plugins: owners.map(id => ({ id, enabled: true, status: 'running' })) }; },
    async callRpc(input) {
      calls.push([input.pluginId, input.method]);
      rawCalls++; maxRawCalls = Math.max(maxRawCalls, rawCalls);
      try {
        const output = await (input.pluginId === 'turn-results' ? galleryRpc : transports.get(input.pluginId)).callRpc(input);
        if (hold && hold.owner === input.pluginId && hold.method === input.method) {
          const witness = hold; hold = null; held.add(witness);
          witness.signal = input.signal; witness.started = true;
          // The actual SDK promise stays unsettled even after local abort.
          // The registered handler's genuine result is released unchanged.
          await witness.gate; held.delete(witness);
        }
        if (input.method === GALLERY_METHODS.apply) applies.push(output);
        return output;
      } finally { rawCalls--; }
    },
  }, threads: { events: { async list() { return []; } } } };
  // Match the retained witness: completed persisted stages/cursors and zero
  // pending claims before the mounted runtime asks each owner again.
  runtime = createGalleryRuntime(sdk);
  const now = Date.now; Date.now = () => now() - 31000;
  try {
    for (const id of owners) {
      const described = await createResultsSupplierClient({ plugins: transports.get(id) }, id).describe();
      assert.equal(described.state, 'ready');
      const { consumerSource } = await import('../gallery/consume.ts');
      await consumeTurnSource(runtime.backend, sdk.threads.events, consumerSource(sdk, id, described.capabilities), anchor, new AbortController().signal);
    }
  } finally { Date.now = now; }
  calls.length = applies.length = 0;
  lease = runtime.retain(anchor); leases.add(lease);
  async function idle() {
    for (let i = 0; i < 600; i++) { if (!runtime.stats().running && !runtime.stats().queued && !lease.store.state.busy) return; await tick(); }
    assert.fail('Gallery did not settle within the bounded fixture wait');
  }
  t.after(async () => {
    for (const witness of held) witness.release();
    for (const retained of leases) retained.dispose(); runtime.dispose(); await runtime.whenDrained();
    await host.harness.lifecycle.dispose(); for (const supplier of supplierHosts) await supplier.harness.lifecycle.dispose();
    globalThis.document = saved; dom.window.close();
  });
  return { runtime, lease, calls, applies, idle, value,
    count(method) { return calls.filter(([, name]) => name === method).length; },
    clear() { calls.length = applies.length = 0; },
    retainHidden() { const retained = runtime.retain(anchor, false); leases.add(retained); return retained; },
    rawCalls: () => rawCalls, maxRawCalls: () => maxRawCalls,
    holdNext(method, owner = 'turn-results') {
      assert.equal(hold, null);
      let release; const gate = new Promise(resolve => { release = resolve; });
      return hold = { method, owner, gate, release, started: false, signal: null };
    },
    async started(witness) {
      for (let i = 0; i < 600; i++) { if (witness.started) return; await tick(); }
      assert.fail('Selected actual SDK call did not start');
    },
    async quiet() { const before = calls.length; for (let i = 0; i < 12; i++) await tick(); assert.equal(calls.length, before, 'settled demand must issue no follow-on work'); },
    async invalidateResult() {
      result = true;
      const consumer = createResultsConsumerClient({ plugins: galleryRpc }, 'turn-results');
      assert.equal((await consumer.invalidate({ version: 1, supplierPluginId: 'owner-a', threadId: 'thread',
        revision: { epoch: 'epoch-owner-a', sequence: 1 }, affected: 'thread' }, new AbortController().signal)).state, 'dirty');
      runtime.invalidate('thread');
    },
    failOnce() { fail = true; runtime.invalidate('thread'); },
    hidden(hidden) { Object.defineProperty(document, 'hidden', { configurable: true, value: hidden }); document.dispatchEvent(new dom.window.Event('visibilitychange')); },
  };
}

test('settled empty feeds and proof suspension do not renew the gallery read/source cycle', async t => {
  const f = await fixture(t); await f.idle();
  assert.equal(f.count('turnResultsV1Enumerate'), 2);
  assert.equal(f.count(GALLERY_METHODS.read), 1, 'empty-owner stage/heartbeat commits must not reread retained results');
  assert.equal(f.lease.store.state.loaded, true); assert.deepEqual(f.lease.store.state.rows, []);
  await f.quiet(); f.clear();
  for (let i = 0; i < 4; i++) { f.lease.visible(false); await tick(); f.lease.visible(true); await f.idle(); }
  assert.equal(f.calls.length, 0, 'proof suspension alone preserves the completed owner pass');
  const now = Date.now; Date.now = () => now() + 31000;
  try {
    // Unknown semantic/native invalidation remains conservative. It still
    // checks both suppliers, but real freshness writes cannot mint read work.
    f.runtime.invalidate('thread'); await f.idle();
    assert.equal(f.count('turnResultsV1Enumerate'), 2); assert.equal(f.count(GALLERY_METHODS.read), 1);
    assert.ok(f.applies.some(output => output.state === 'committed' && output.observationsChanged === false), 'real SQLite heartbeat remains durable');
    await f.quiet();
  } finally { Date.now = now; }
});

test('genuine later result, source invalidation, transient retry and hidden reactivation retain freshness and identity', async t => {
  const f = await fixture(t); await f.idle(); f.clear();
  await f.invalidateResult(); await f.idle();
  assert.equal(f.lease.store.state.rows.length, 1);
  assert.equal(canonicalJson(f.lease.store.state.rows[0].identity), canonicalJson(f.value.identity));
  assert.deepEqual(f.lease.store.state.rows[0].resolution.route, f.value.route);
  const facts = canonicalJson(f.lease.store.state.rows.map(row => [row.identity, row.resolution]));
  assert.equal(f.lease.store.state.rows[0].freshness, 'fresh'); await f.quiet();
  f.clear(); f.failOnce(); await f.idle();
  assert.equal(f.count('turnResultsV1Enumerate'), 3, 'one bounded failed owner retry follows the healthy owner');
  assert.equal(f.lease.store.state.error, null); assert.equal(f.lease.store.state.rows[0].freshness, 'fresh');
  assert.equal(canonicalJson(f.lease.store.state.rows.map(row => [row.identity, row.resolution])), facts); await f.quiet();
  f.clear(); f.hidden(true); f.runtime.invalidate('thread'); await f.quiet(); assert.equal(f.calls.length, 0);
  assert.equal(f.lease.store.state.rows.length, 1, 'hidden invalidation retains saved content');
  f.hidden(false); await f.idle(); assert.equal(f.count('turnResultsV1Enumerate'), 2);
  assert.equal(canonicalJson(f.lease.store.state.rows.map(row => [row.identity, row.resolution])), facts); await f.quiet();
});

test('source generation invalidation survives a settled invisible retained lease without hidden dispatch', async t => {
  const f = await fixture(t); await f.idle(); f.clear();
  f.lease.visible(false); f.runtime.invalidateReadiness();
  await f.quiet(); assert.equal(f.calls.length, 0, 'invisible retained demand must not dispatch');
  f.lease.visible(true); await f.idle();
  assert.equal(f.count(GALLERY_METHODS.read), 1, 'generation change requires a fresh retained read');
  assert.equal(f.count('turnResultsV1Enumerate'), 2, 'both owners must be revisited from a fresh cursor');
  assert.equal(f.lease.store.state.loaded, true); await f.quiet();
});

for (const phase of ['read', 'source']) test(`last visible lease disposal preserves interrupted ${phase} work for its retained hidden sibling`, async t => {
  const f = await fixture(t); await f.idle();
  const sibling = f.retainHidden(); await f.idle(); f.clear();
  const method = phase === 'read' ? GALLERY_METHODS.read : 'turnResultsV1Enumerate';
  const witness = f.holdNext(method, phase === 'read' ? 'turn-results' : 'owner-a');
  f.runtime.invalidate('thread'); await f.started(witness);
  assert.equal(f.rawCalls(), 1); assert.equal(f.runtime.stats().running, 1);
  f.lease.dispose();
  assert.equal(witness.signal.aborted, true, 'loss of last visible demand aborts the local consumer');
  await f.quiet(); assert.equal(f.rawCalls(), 1, 'ignored raw promise retains its lane until real settlement');
  assert.equal(f.runtime.stats().running, 1); assert.equal(f.runtime.stats().queued, 0);
  witness.release(); await f.idle();
  assert.equal(f.rawCalls(), 0); f.clear();
  sibling.visible(true); await f.idle();
  assert.equal(f.count(GALLERY_METHODS.read), 1, 'the interrupted pass resumes from a fresh retained read');
  assert.deepEqual(f.calls.filter(([, name]) => name === 'turnResultsV1Enumerate').map(([owner]) => owner), ['owner-a', 'owner-b'],
    'the incomplete first owner cannot be skipped by a surviving afterOwner cursor');
  assert.equal(f.maxRawCalls(), 1, 'same-thread raw transports never overlap across suspension/reactivation');
  assert.equal(sibling.store.state.loaded, true); assert.equal(sibling.store.state.error, null); await f.quiet();
});
