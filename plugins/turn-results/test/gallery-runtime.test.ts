import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { buildResolveOutput } from '@phosphorco/bb-turn-results';
import { registerTurnResultsParticipant } from '@phosphorco/bb-turn-results/bb';
import type { RegistrationPort } from '@phosphorco/bb-turn-results/bb';
import { createGalleryRuntime, GALLERY_RUNTIME_LIMITS } from '../gallery/runtime.ts';
import { GALLERY_METHODS } from '../gallery/rpc.ts';
import type { GalleryAnchor } from '../gallery/anchors.ts';
import type { StageRecord } from '../gallery/index.ts';
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
async function until(condition: () => boolean) { for (let i = 0; i < 500; i++) { if (condition()) return; await tick(); } assert.fail('Demand did not settle.'); }
function anchor(threadId: string, turnId = 'turn', start = 1): GalleryAnchor {
  return { threadId, turnId, rowId: 'opaque-public-row', sourceSeqStart: 90, sourceSeqEnd: 100,
    turnSeqStart: start, turnSeqEnd: 100, historySnapshot: 'public-snapshot' };
}
function setup(count = 0, failed = '', productive = false) {
  const dom = new JSDOM('', { pretendToBeVisual: true }), saved = globalThis.document;
  globalThis.document = dom.window.document;
  const handlers = new Map<string, Parameters<RegistrationPort['rpc']['register']>[1]>();
  const sourceCalls: string[] = [], reads: string[] = [], stages = new Map<string, StageRecord>();
  let holding: ((threadId: string, signal: AbortSignal) => Promise<void>) | null = null;
  const ids = Array.from({ length: count }, (_, i) => `source-${String(i).padStart(3, '0')}`);
  for (const id of ids) registerTurnResultsParticipant({ rpc: { register(_contract, methods) { handlers.set(id, methods); } } }, {
    pluginId: id, capabilities: { revision: 'r1', supplier: { recognize: false, resolve: true, enumerate: true,
      kinds: [{ kind: 'example/result', namespace: 'example', neutralLabel: 'Result', confirmedLabel: 'Created', specificity: 'typed', memberVersion: 'v1', equivalenceNamespaces: [] }] } },
    async resolve(input) { return buildResolveOutput(input, input.items.map(() => ({ state: 'unavailable' as const, reason: 'No fixture result' }))); },
    async enumerate() {
      sourceCalls.push(id); if (id === failed) throw Error('Disconnected owner');
      return { state: 'page', epoch: 'epoch', phase: 'changes', throughRevision: sourceCalls.length,
        rows: [], nextCursor: `cursor-${sourceCalls.length}`, settled: !productive,
        coverage: { retainedFrom: null, unplaced: 0, complete: true } };
    },
  });
  const sdk: Parameters<typeof createGalleryRuntime>[0] = { plugins: {
    async list() { return { plugins: ids.map(id => ({ id, enabled: true, status: 'running' })) }; },
    async callRpc(args) {
      let value: unknown;
      if (args.pluginId !== 'turn-results') value = await handlers.get(args.pluginId)![args.method]!(args.input, { experimental_caller: { kind: 'client' } });
      else {
        const input = args.input as Record<string, unknown>;
        if (args.method === GALLERY_METHODS.read) {
          reads.push(String(input.threadId)); if (holding) await holding(String(input.threadId), args.signal!);
          value = { page: { rows: [], next: null }, coverage: { state: 'unindexed', intervals: [] } };
        } else if (args.method === GALLERY_METHODS.pending) value = { rows: [], next: null };
        else if (args.method === GALLERY_METHODS.stage) value = stages.get(JSON.stringify([input.threadId, input.owner, input.id])) ?? null;
        else if (args.method === GALLERY_METHODS.known) value = [];
        else {
          const page = input as unknown as { threadId: string; owner: string; stage?: { id: string; value: StageRecord['value'] } };
          if (page.stage) {
            const key = JSON.stringify([page.threadId, page.owner, page.stage.id]);
            stages.set(key, { version: (stages.get(key)?.version ?? -1) + 1, value: page.stage.value });
          }
          value = { state: 'committed' };
        }
      }
      return args.outputSchema.parse(value);
    },
  }, threads: { events: { async list() { return []; } } } };
  const runtime = createGalleryRuntime(sdk);
  return { runtime, reads, sourceCalls, setHold(value: typeof holding) { holding = value; },
    hidden(value: boolean) { Object.defineProperty(document, 'hidden', { configurable: true, value }); document.dispatchEvent(new dom.window.Event('visibilitychange')); },
    dispose() { runtime.dispose(); globalThis.document = saved; dom.window.close(); } };
}
test('65 distinct demanded threads pass two read lanes fairly; no permanent64 admission', async () => {
  const h = setup(), leases = Array.from({ length: 65 }, (_, i) => h.runtime.retain(anchor(`thread-${i}`)));
  try {
    await until(() => h.reads.length === 130 && h.runtime.stats().running === 0);
    assert.equal(new Set(h.reads).size, 65); for (let i = 0; i < 65; i++) assert.equal(h.reads.filter(id => id === `thread-${i}`).length, 2);
    assert.equal(h.runtime.stats().leases, 65); assert.equal(h.runtime.stats().queued, 0);
    const count = h.reads.length; await tick(); assert.equal(h.reads.length, count, 'settled idle is quiet');
  } finally { for (const lease of leases) lease.dispose(); h.dispose(); }
});
test('source33 progresses after first owner fails; bounded productive debt parks without idle retry', async () => {
  const h = setup(33, 'source-000', true), lease = h.runtime.retain(anchor('thread'));
  try {
    await until(() => h.sourceCalls.length === 37 && !lease.store.state.busy && h.runtime.stats().running === 0);
    assert.deepEqual(h.sourceCalls.slice(0, 33), Array.from({ length: 33 }, (_, i) => `source-${String(i).padStart(3, '0')}`));
    assert.equal(h.sourceCalls.filter(id => id === 'source-000').length, 1);
    assert.equal(lease.store.state.continued, true);
    await tick(); assert.equal(h.sourceCalls.length, 37);
    lease.more(); await until(() => h.sourceCalls.length === 74 && h.runtime.stats().running === 0);
  } finally { lease.dispose(); h.dispose(); }
});
test('same-scope split shares snapshot; narrower proof cannot abort/widen other pane; one lane per thread', async () => {
  const h = setup(); let release!: () => void, heldSignal!: AbortSignal;
  h.setHold((_thread, signal) => { heldSignal = signal; return new Promise(resolve => { release = resolve; }); });
  const wide = h.runtime.retain(anchor('same')), duplicate = h.runtime.retain(anchor('same'));
  const narrow = h.runtime.retain(anchor('same', 'turn', 50)), other = h.runtime.retain(anchor('other'));
  try {
    await until(() => h.reads.length === 2);
    assert.equal(wide.store, duplicate.store); assert.notEqual(wide.store, narrow.store);
    assert.equal(h.runtime.stats().running, 2); assert.equal(h.reads.filter(id => id === 'same').length, 1);
    assert.equal(heldSignal.aborted, false);
    h.setHold(null); wide.dispose(); duplicate.dispose(); other.dispose(); release();
    await until(() => h.runtime.stats().running === 0 && h.reads.filter(id => id === 'same').length >= 3);
    assert.equal(narrow.store.state.error, null);
  } finally { wide.dispose(); duplicate.dispose(); narrow.dispose(); other.dispose(); h.dispose(); }
});
test('hidden/abort-ignoring transport retires lanes; no follow-on source calls or stale publications', async () => {
  const h = setup(1); const releases: (() => void)[] = [];
  h.setHold(() => new Promise(resolve => releases.push(resolve)));
  const lease = h.runtime.retain(anchor('held'));
  try {
    await until(() => releases.length === 1); h.hidden(true);
    await until(() => h.runtime.stats().running === 0); assert.equal(h.sourceCalls.length, 0);
    releases[0]!(); await tick(); assert.equal(h.sourceCalls.length, 0); assert.equal(lease.store.state.rows.length, 0);
    h.setHold(null); h.hidden(false); await until(() => h.sourceCalls.length === 1 && h.runtime.stats().running === 0);
    assert.equal(lease.store.state.error, null);
  } finally { lease.dispose(); h.dispose(); }
});
test('128 leases expose explicit retryable capacity; unleased cache stays64 and no hidden work', async () => {
  const h = setup(); const leases = Array.from({ length: 128 }, (_, i) => h.runtime.retain(anchor(`t-${i}`), false));
  try {
    const excess = h.runtime.retain(anchor('excess')); assert.equal(excess.capacity, true); assert.equal(excess.store.state.coverage, 'view-capacity');
    assert.equal(h.runtime.stats().leases, 128); await tick(); assert.equal(h.reads.length, 0);
    leases[0]!.dispose(); const retry = h.runtime.retain(anchor('excess'), false); assert.equal(retry.capacity, false); retry.dispose();
    for (const lease of leases) lease.dispose();
    assert.equal(h.runtime.stats().cached, GALLERY_RUNTIME_LIMITS.cached); assert.ok(h.runtime.stats().bytes <= GALLERY_RUNTIME_LIMITS.totalSnapshotBytes);
    assert.equal(h.runtime.stats().queued, 0);
  } finally { for (const lease of leases) lease.dispose(); h.dispose(); }
});

test('history and supplier work share2 lanes and1/thread; history-heavy requeue cannot starve supplier', async () => {
  const h = setup(1), controller = new AbortController();
  const active = new Map<string, number>(), order: string[] = []; let total = 0, maximum = 0;
  const operation = async (threadId: string) => {
    active.set(threadId, (active.get(threadId) ?? 0) + 1); total++; maximum = Math.max(maximum, total);
    assert.equal(active.get(threadId), 1); assert.ok(total <= 2);
    order.push(threadId); await tick(); active.set(threadId, active.get(threadId)! - 1); total--;
  };
  h.setHold((threadId) => operation(threadId));
  const history = (async () => { for (let page = 0; page < 12; page++) {
    const result = await h.runtime.readScope('history-heavy', controller.signal, () => operation('history-heavy'));
    assert.equal(result.state, 'ready');
  } })();
  const supplier = h.runtime.retain(anchor('healthy-supplier'));
  const sameThreadHistory = h.runtime.readScope('healthy-supplier', controller.signal, () => operation('healthy-supplier'));
  try {
    await Promise.all([history, sameThreadHistory]); await until(() => h.sourceCalls.length === 1 && h.runtime.stats().running === 0);
    assert.equal(maximum, 2); assert.ok(order.indexOf('healthy-supplier') < order.lastIndexOf('history-heavy'));
    assert.equal(h.runtime.stats().historyReads, 0); assert.equal(supplier.store.state.error, null);
  } finally { controller.abort(); supplier.dispose(); h.dispose(); }
});
test('history saturation returns capacity without cursor/debt loss; queued cancellation and hidden ignored work retire', async () => {
  const h = setup(), controllers = Array.from({ length: 128 }, () => new AbortController());
  const started: string[] = [], releases: (() => void)[] = [];
  const tasks = controllers.map((controller, i) => h.runtime.readScope(`history-${i}`, controller.signal, async () => {
    started.push(`history-${i}`); await new Promise<void>(resolve => releases.push(resolve)); return i;
  }));
  const settled = Promise.allSettled(tasks);
  try {
    const capacity = await h.runtime.readScope('capacity', new AbortController().signal, async () => assert.fail('capacity must not start read'));
    assert.deepEqual(capacity, { state: 'capacity' }); assert.equal(h.runtime.stats().historyReads, 128);
    await until(() => started.length === 2); controllers[64]!.abort();
    assert.equal(h.runtime.stats().historyReads, 127); assert.equal(started.includes('history-64'), false);
    h.hidden(true); await settled; await until(() => h.runtime.stats().running === 0);
    assert.equal(h.runtime.stats().historyReads, 0); assert.equal(h.runtime.stats().queued, 0);
    for (const release of releases) release(); await tick(); assert.equal(started.length, 2, 'ignored late reads cannot admit continuation');
    h.hidden(false);
    const recovered = await h.runtime.readScope('capacity', new AbortController().signal, async () => 'same requested page');
    assert.deepEqual(recovered, { state: 'ready', value: 'same requested page' });
  } finally { for (const controller of controllers) controller.abort(); for (const release of releases) release(); h.dispose(); }
});
