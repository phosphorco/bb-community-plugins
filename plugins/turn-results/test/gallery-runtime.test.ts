import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { buildResolveOutput, canonicalByteLength, METHODS } from '@phosphorco/bb-turn-results';
import { registerTurnResultsParticipant, ResultsCallError } from '@phosphorco/bb-turn-results/bb';
import type { RegistrationPort } from '@phosphorco/bb-turn-results/bb';
import { createGalleryRuntime, GALLERY_RUNTIME_LIMITS } from '../gallery/runtime.ts';
import { GALLERY_METHODS } from '../gallery/rpc.ts';
import { createGalleryAnchorReader } from '../gallery/anchors.ts';
import { createGalleryWorkOwner } from '../gallery/work-owner.ts';
import type { GalleryAnchor, GalleryTimelinePort } from '../gallery/anchors.ts';
import type { StageRecord, GalleryObservation } from '../gallery/index.ts';
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
async function until(condition: () => boolean) { for (let i = 0; i < 500; i++) { if (condition()) return; await tick(); } assert.fail('Demand did not settle.'); }
function anchor(threadId: string, turnId = 'turn', start = 1): GalleryAnchor {
  return { threadId, turnId, rowId: 'opaque-public-row', sourceSeqStart: 90, sourceSeqEnd: 100,
    turnSeqStart: start, turnSeqEnd: 100, historySnapshot: 'public-snapshot' };
}
function setup(count = 0, failed = '', productive = false, recognizing = false, enumerating = true) {
  const dom = new JSDOM('', { pretendToBeVisual: true }), saved = globalThis.document;
  globalThis.document = dom.window.document;
  const handlers = new Map<string, Parameters<RegistrationPort['rpc']['register']>[1]>();
  const sourceCalls: string[] = [], reads: string[] = [], stages = new Map<string, StageRecord>();
  let holding: ((threadId: string, signal: AbortSignal) => Promise<void>) | null = null;
  const ids = Array.from({ length: count }, (_, i) => `source-${String(i).padStart(3, '0')}`);
  for (const id of ids) registerTurnResultsParticipant({ rpc: { register(_contract, methods) { handlers.set(id, methods); } } }, {
    pluginId: id, capabilities: { revision: 'r1', supplier: { recognize: recognizing, resolve: true, enumerate: enumerating,
      kinds: [{ kind: 'example/result', namespace: 'example', neutralLabel: 'Result', confirmedLabel: 'Created', specificity: 'typed', memberVersion: 'v1', equivalenceNamespaces: [] }] } },
    ...(recognizing ? { async recognize() { return { candidates: [], page: { state: 'complete' as const, nextCursor: null } }; } } : {}),
    async resolve(input) { return buildResolveOutput(input, input.items.map(() => ({ state: 'unavailable' as const, reason: 'No fixture result' }))); },
    ...(enumerating ? { async enumerate() {
      sourceCalls.push(id); if (id === failed) throw Error('Disconnected owner');
      return { state: 'page', epoch: 'epoch', phase: 'changes', throughRevision: sourceCalls.length,
        rows: [], nextCursor: `cursor-${sourceCalls.length}`, settled: !productive,
        coverage: { retainedFrom: null, unplaced: 0, complete: true } };
    } } : {}),
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
        } else if (args.method === GALLERY_METHODS.prepare) value = Object.fromEntries(['resolve', 'invalidation', 'feed', 'native'].map(name => [name, stages.get(JSON.stringify([input.threadId, input.owner, name === 'invalidation' ? 'source-invalidation' : `${name}:${input.turnId}`])) ?? null]));
        else if (args.method === GALLERY_METHODS.pending) value = { rows: [], next: null };
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
  return { runtime, sdk, reads, sourceCalls, setHold(value: typeof holding) { holding = value; },
    hidden(value: boolean) { Object.defineProperty(document, 'hidden', { configurable: true, value }); document.dispatchEvent(new dom.window.Event('visibilitychange')); },
    dispose() { runtime.dispose(); globalThis.document = saved; dom.window.close(); } };
}
test('65 distinct demanded threads pass two read lanes fairly; no permanent64 admission', async () => {
  const h = setup(), leases = Array.from({ length: 65 }, (_, i) => h.runtime.retain(anchor(`thread-${i}`)));
  try {
    await until(() => h.reads.length === 65 && h.runtime.stats().running === 0);
    assert.equal(new Set(h.reads).size, 65); for (let i = 0; i < 65; i++) assert.equal(h.reads.filter(id => id === `thread-${i}`).length, 1);
    assert.equal(h.runtime.stats().leases, 65); assert.equal(h.runtime.stats().queued, 0);
    const count = h.reads.length; await tick(); assert.equal(h.reads.length, count, 'settled idle is quiet');
  } finally { for (const lease of leases) lease.dispose(); h.dispose(); }
});

test('proof suspension retains finite discovery lane; same-thread history waits and healthy supplier33 progresses', async () => {
  const h = setup(33, 'source-000'), original = h.sdk.plugins.callRpc;
  const descriptions: string[] = []; let release!: () => void, describeSignal!: AbortSignal;
  h.sdk.plugins.callRpc = async args => {
    if (args.method === METHODS.describe) {
      descriptions.push(args.pluginId);
      if (descriptions.length === 1) { describeSignal = args.signal!; await new Promise<void>(resolve => { release = resolve; }); }
    }
    return original(args);
  };
  const demand = h.runtime.retainDiscoveryDemand()!; demand.visible(true);
  const lease = h.runtime.retain(anchor('same')), signal = new AbortController();
  const history: string[] = [];
  try {
    await until(() => descriptions.length === 1);
    lease.visible(false); await tick();
    assert.equal(describeSignal.aborted, false, 'proof suspension is not loss of actual pane demand');
    assert.equal(h.runtime.stats().running, 1, 'initiating lane remains occupied until bounded discovery settles');
    const same = h.runtime.readScope('same', signal.signal, async () => { history.push('same'); });
    const other = h.runtime.readScope('other', signal.signal, async () => { history.push('other'); });
    await until(() => history.includes('other')); assert.deepEqual(history, ['other']);
    assert.ok(h.runtime.stats().running <= 2); assert.equal(h.sourceCalls.length, 0);
    release(); await Promise.all([same, other]); await until(() => h.runtime.stats().running === 0);
    assert.equal(descriptions.length, 1); assert.equal(h.sourceCalls.length, 0, 'suspended proof cannot consume');
    lease.visible(true);
    await until(() => h.runtime.isReadyOwner('source-032') && h.sourceCalls.length === 34 && h.runtime.stats().running === 0);
    assert.equal(h.sourceCalls.filter(id => id === 'source-000').length, 2, 'one bounded transient feed retry');
    assert.equal(new Set(h.sourceCalls).size, 33, 'every healthy first-pass owner still progresses');
    assert.equal(descriptions.length, 33, 'continuation retains its finite cursor instead of restarting owner1');
    assert.equal(new Set(descriptions).size, 33); assert.deepEqual(history, ['other', 'same']);
    const reads = h.reads.length; await tick(); await tick(); assert.equal(h.reads.length, reads);
  } finally { release?.(); lease.dispose(); demand.dispose(); h.dispose(); }
});

test('discovery demand is bounded128, does not start work, and actual hide/unload fence ignored late describe', async () => {
  const h = setup(1), original = h.sdk.plugins.callRpc;
  const demands = Array.from({ length: 128 }, () => h.runtime.retainDiscoveryDemand()!);
  let release!: () => void, started = false, bounded!: AbortSignal;
  h.sdk.plugins.callRpc = async args => {
    if (args.method === METHODS.describe) { started = true; bounded = args.signal!; await new Promise<void>(resolve => { release = resolve; }); }
    return original(args);
  };
  let lease: ReturnType<typeof h.runtime.retain> | undefined;
  try {
    assert.equal(h.runtime.retainDiscoveryDemand(), null); demands[0]!.visible(true);
    await tick(); assert.equal(started, false); assert.equal(h.runtime.stats().discoveryDemands, 128);
    lease = h.runtime.retain(anchor('thread')); await until(() => started);
    lease.visible(false); demands[0]!.visible(false); assert.equal(bounded.aborted, true);
    await tick(); assert.equal(h.runtime.stats().running, 1, 'ignored raw Describe still owns its lane after local cancellation');
    h.hidden(true); release(); await until(() => h.runtime.stats().running === 0);
    assert.equal(h.runtime.isReadyOwner('source-000'), false);
    assert.equal(h.sourceCalls.length, 0);
    for (const demand of demands) demand.dispose(); assert.equal(h.runtime.stats().discoveryDemands, 0);
    h.runtime.dispose(); await tick(); assert.equal(h.runtime.stats().visibleDiscoveryDemands, 0);
  } finally { release?.(); lease?.dispose(); for (const demand of demands) demand.dispose(); h.dispose(); }
});
test('source33 progresses after first owner fails; bounded productive debt parks without idle retry', async () => {
  const h = setup(33, 'source-000', true), lease = h.runtime.retain(anchor('thread'));
  try {
    await until(() => h.sourceCalls.length === 37 && !lease.store.state.busy && h.runtime.stats().running === 0);
    assert.deepEqual(h.sourceCalls.slice(0, 33), Array.from({ length: 33 }, (_, i) => `source-${String(i).padStart(3, '0')}`));
    assert.equal(h.sourceCalls.filter(id => id === 'source-000').length, 2, 'one transient feed revisit spends one of the same four debt credits');
    assert.equal(lease.store.state.continued, true);
    await tick(); assert.equal(h.sourceCalls.length, 37);
    lease.more(); await until(() => h.sourceCalls.length === 74 && h.runtime.stats().running === 0);
  } finally { lease.dispose(); h.dispose(); }
});
test('same-scope split shares snapshot; narrower proof cannot abort/widen other pane; one lane per thread', async () => {
  const h = setup(); let heldSignal!: AbortSignal; const releases: (() => void)[] = [];
  h.setHold((_thread, signal) => { heldSignal = signal; return new Promise(resolve => { releases.push(resolve); }); });
  const wide = h.runtime.retain(anchor('same')), duplicate = h.runtime.retain(anchor('same'));
  const narrow = h.runtime.retain(anchor('same', 'turn', 50)), other = h.runtime.retain(anchor('other'));
  try {
    await until(() => h.reads.length === 2);
    assert.equal(wide.store, duplicate.store); assert.notEqual(wide.store, narrow.store);
    assert.equal(h.runtime.stats().running, 2); assert.equal(h.reads.filter(id => id === 'same').length, 1);
    assert.equal(heldSignal.aborted, false);
    h.setHold(null); wide.dispose(); duplicate.dispose(); other.dispose(); for (const release of releases) release();
    await until(() => h.runtime.stats().running === 0 && h.reads.filter(id => id === 'same').length === 2);
    assert.equal(narrow.store.state.error, null);
  } finally { for (const release of releases) release(); wide.dispose(); duplicate.dispose(); narrow.dispose(); other.dispose(); h.dispose(); }
});
test('hidden/abort-ignoring transport retires lanes; no follow-on source calls or stale publications', async () => {
  const h = setup(1); const releases: (() => void)[] = [];
  h.setHold(() => new Promise(resolve => releases.push(resolve)));
  const lease = h.runtime.retain(anchor('held'));
  try {
    await until(() => releases.length === 1); h.hidden(true);
    await tick(); assert.equal(h.runtime.stats().running, 1, 'ignored abort retains actual occupancy'); assert.equal(h.sourceCalls.length, 0);
    releases[0]!(); await until(() => h.runtime.stats().running === 0); assert.equal(h.sourceCalls.length, 0); assert.equal(lease.store.state.rows.length, 0);
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
    h.hidden(true); await settled;
    assert.equal(h.runtime.stats().running, 2); assert.equal(h.runtime.stats().historyReads, 2); assert.equal(h.runtime.stats().queued, 0);
    for (const release of releases) release(); await until(() => h.runtime.stats().running === 0);
    assert.equal(h.runtime.stats().historyReads, 0); assert.equal(started.length, 2, 'ignored late reads cannot admit continuation');
    h.hidden(false);
    const recovered = await h.runtime.readScope('capacity', new AbortController().signal, async () => 'same requested page');
    assert.deepEqual(recovered, { state: 'ready', value: 'same requested page' });
  } finally { for (const controller of controllers) controller.abort(); for (const release of releases) release(); h.dispose(); }
});

const transientDescribeError = () => Object.assign(new Error('Transient fixture Describe failure'), {
  status: 500, body: { error: { code: 'handler_error' } },
});
test('one shared yielded Describe retry recovers without rediscovering healthy owners or duplicating roots', async () => {
  const h = setup(2), rpc = h.sdk.plugins.callRpc;
  const descriptions: string[] = [];
  let release!: () => void, retrySignal!: AbortSignal;
  h.sdk.plugins.callRpc = async args => {
    if (args.method === METHODS.describe) {
      descriptions.push(args.pluginId);
      if (args.pluginId === 'source-000') {
        if (descriptions.filter(id => id === args.pluginId).length === 1) throw transientDescribeError();
        retrySignal = args.signal!; await new Promise<void>(resolve => { release = resolve; });
      }
    }
    return rpc(args);
  };
  const leases = [h.runtime.retain(anchor('first')), h.runtime.retain(anchor('second'))];
  try {
    await until(() => Boolean(release));
    assert.equal(h.runtime.isReadyOwner('source-001'), true);
    assert.equal(h.runtime.isReadyOwner('source-000'), false);
    assert.equal(descriptions.filter(id => id === 'source-000').length, 2);
    assert.equal(descriptions.filter(id => id === 'source-001').length, 1);
    assert.ok(h.reads.length >= 3, 'retry starts in a new queued unit after initial discovery');
    assert.ok(h.runtime.stats().running <= 2); assert.equal(retrySignal.aborted, false);
    release(); await until(() => h.runtime.isReadyOwner('source-000') && h.runtime.stats().running === 0);
    assert.equal(descriptions.length, 3); assert.ok(h.sourceCalls.includes('source-000'));
    const calls = h.reads.length; await tick(); await tick(); assert.equal(h.reads.length, calls);
  } finally { release?.(); for (const lease of leases) lease.dispose(); h.dispose(); }
});

test('persistent transient Describe parks after one automatic retry; genuine new demand retries only debt', async () => {
  const h = setup(2), rpc = h.sdk.plugins.callRpc;
  const descriptions: string[] = []; let fail = true;
  h.sdk.plugins.callRpc = async args => {
    if (args.method === METHODS.describe) {
      descriptions.push(args.pluginId);
      if (args.pluginId === 'source-000' && fail) throw transientDescribeError();
    }
    return rpc(args);
  };
  const leases = [h.runtime.retain(anchor('first')), h.runtime.retain(anchor('second'))];
  try {
    await until(() => descriptions.length === 3 && h.runtime.stats().running === 0 && h.runtime.stats().queued === 0);
    assert.equal(h.runtime.isReadyOwner('source-000'), false); assert.equal(h.runtime.isReadyOwner('source-001'), true);
    assert.ok(leases.every(lease => lease.store.state.continued));
    const quiet = { reads: h.reads.length, calls: descriptions.length }; await tick(); await tick(); await tick();
    assert.deepEqual({ reads: h.reads.length, calls: descriptions.length }, quiet);
    fail = false; h.runtime.invalidate('first'); h.runtime.invalidate('second');
    await until(() => h.runtime.isReadyOwner('source-000') && h.runtime.stats().running === 0);
    assert.equal(descriptions.filter(id => id === 'source-000').length, 3);
    assert.equal(descriptions.filter(id => id === 'source-001').length, 1);
    const calls = h.reads.length; await tick(); await tick(); assert.equal(h.reads.length, calls);
  } finally { for (const lease of leases) lease.dispose(); h.dispose(); }
});

test('targeted retry fresh listing rejects removed and disabled debt; incompatible descriptor cannot grant readiness', async () => {
  for (const state of ['removed', 'disabled', 'incompatible'] as const) {
    const h = setup(2), rpc = h.sdk.plugins.callRpc, list = h.sdk.plugins.list;
    let descriptions = 0, listCalls = 0;
    h.sdk.plugins.list = async args => {
      const result = await list(args); listCalls++;
      if (listCalls > 1 && state !== 'incompatible') return { plugins: result.plugins.flatMap(row => row.id !== 'source-000'
        ? [row] : state === 'removed' ? [] : [{ ...row, enabled: false }]) };
      return result;
    };
    h.sdk.plugins.callRpc = async args => {
      if (args.method === METHODS.describe && args.pluginId === 'source-000') {
        descriptions++;
        if (descriptions === 1) throw transientDescribeError();
        return args.outputSchema.parse({ incompatible: 'not a public descriptor' });
      }
      return rpc(args);
    };
    const lease = h.runtime.retain(anchor('thread'));
    try {
      await until(() => listCalls >= 2 && h.runtime.stats().running === 0);
      assert.equal(listCalls, state === 'incompatible' ? 3 : 2, 'two finite legacy owner slices; a still-listed failed owner also gets the genuine named retry list');
      assert.equal(h.runtime.isReadyOwner('source-000'), false, state);
      assert.equal(h.runtime.isReadyOwner('source-001'), true, state);
      assert.equal(descriptions, state === 'incompatible' ? 2 : 1);
      const reads = h.reads.length; await tick(); await tick(); assert.equal(h.reads.length, reads);
    } finally { lease.dispose(); h.dispose(); }
  }
});

test('hidden or disposed targeted retry ignores late valid descriptor and cannot restore readiness', async () => {
  for (const retire of ['hidden', 'dispose'] as const) {
    const h = setup(1), rpc = h.sdk.plugins.callRpc;
    let descriptions = 0, release!: () => void, bounded!: AbortSignal;
    h.sdk.plugins.callRpc = async args => {
      if (args.method === METHODS.describe) {
        descriptions++;
        if (descriptions === 1) throw transientDescribeError();
        bounded = args.signal!; await new Promise<void>(resolve => { release = resolve; });
      }
      return rpc(args);
    };
    const lease = h.runtime.retain(anchor('thread'));
    try {
      await until(() => Boolean(release));
      if (retire === 'hidden') h.hidden(true); else h.runtime.dispose();
      assert.equal(bounded.aborted, true); await tick();
      assert.equal(h.runtime.stats().running, 1, 'retired generation keeps ignored raw retry occupancy');
      let drained = false; const drainage = h.runtime.whenDrained().then(() => { drained = true; });
      await tick(); assert.equal(drained, false);
      release(); await drainage; await until(() => h.runtime.stats().running === 0);
      assert.equal(h.runtime.isReadyOwner('source-000'), false); assert.equal(h.sourceCalls.length, 0);
      assert.equal(descriptions, 2);
    } finally { release?.(); lease.dispose(); h.dispose(); }
  }
});

test('named Describe retry debt yields at32 owners, advances past persistent prefix, and shares a finite wave', async () => {
  const h = setup(33), rpc = h.sdk.plugins.callRpc;
  const counts = new Map<string, number>(), perUnit = new Map<number, number>();
  let held = true, clock = performance.now(), discoveryUnit = 0;
  const list = h.sdk.plugins.list;
  h.sdk.plugins.list = async input => { discoveryUnit++; return list(input); };
  const monotonic = mock.method(performance, 'now', () => clock);
  h.sdk.plugins.callRpc = async args => {
    if (args.method === METHODS.describe) {
      const count = (counts.get(args.pluginId) ?? 0) + 1; counts.set(args.pluginId, count);
      perUnit.set(discoveryUnit, (perUnit.get(discoveryUnit) ?? 0) + 1);
      if (count === 1) throw transientDescribeError();
      if (held && ['source-000', 'source-001'].includes(args.pluginId)) {
        clock += 3001; // Exercise the existing overall-deadline path without a real3s sleep.
        throw transientDescribeError();
      }
    }
    return rpc(args);
  };
  const leases = [h.runtime.retain(anchor('first')), h.runtime.retain(anchor('second'))];
  try {
    await until(() => h.runtime.isReadyOwner('source-032') && h.runtime.stats().running === 0 && h.runtime.stats().queued === 0);
    assert.equal(h.runtime.readyOwners.state.size, 31); assert.equal(h.runtime.isReadyOwner('source-000'), false);
    assert.ok([...counts.values()].every(count => count === 2), 'each owner gets one initial attempt and one window-shared retry');
    assert.ok([...perUnit.values()].every(count => count <= 32), 'each discovery/retry unit admits at most32 descriptor attempts');
    assert.ok(perUnit.size >= 5, 'deadline-deferred suffix advances in separate yielded units after two failed prefix attempts');
    const calls = [...counts.values()].reduce((a, b) => a + b, 0); await tick(); await tick();
    assert.equal([...counts.values()].reduce((a, b) => a + b, 0), calls);
    held = false; h.runtime.invalidate('first'); h.runtime.invalidate('second');
    await until(() => h.runtime.readyOwners.state.size === 33 && h.runtime.stats().running === 0);
    assert.equal(counts.get('source-000'), 3); assert.equal(counts.get('source-001'), 3);
    assert.equal(counts.get('source-032'), 2, 'healthy suffix is not redundantly described');
  } finally { for (const lease of leases) lease.dispose(); h.dispose(); monotonic.mock.restore(); }
});

test('actual public500ms Describe timeout retries once; ignored late initial descriptor has no authority', async () => {
  const h = setup(1), rpc = h.sdk.plugins.callRpc;
  let descriptions = 0, release!: () => void, firstSignal!: AbortSignal;
  h.sdk.plugins.callRpc = async args => {
    if (args.method === METHODS.describe && ++descriptions === 1) {
      firstSignal = args.signal!; await new Promise<void>(resolve => { release = resolve; });
    }
    return rpc(args);
  };
  const lease = h.runtime.retain(anchor('thread'));
  try {
    await until(() => firstSignal?.aborted);
    assert.equal(firstSignal.aborted, true, 'the unchanged public default call deadline aborted the first request');
    assert.equal(descriptions, 1, 'a timed-out ignored transport must settle before a second Describe dispatch');
    assert.equal(h.runtime.isReadyOwner('source-000'), false); assert.equal(h.runtime.stats().running, 1);
    release();
    await until(() => descriptions === 2 && h.runtime.isReadyOwner('source-000') && h.runtime.stats().running === 0);
    h.runtime.invalidateReadiness(); assert.equal(h.runtime.isReadyOwner('source-000'), false);
    await tick(); await tick();
    assert.equal(h.runtime.isReadyOwner('source-000'), false, 'settled old work cannot readmit an invalidated generation');
    assert.equal(descriptions, 2); assert.equal(h.runtime.stats().running, 0);
  } finally { release?.(); lease.dispose(); h.dispose(); }
});

test('optional retry list failure parks without revoking a healthy owner, then new demand obtains a fresh descriptor', async () => {
  const h = setup(2), rpc = h.sdk.plugins.callRpc, list = h.sdk.plugins.list;
  let lists = 0, descriptions = 0;
  h.sdk.plugins.list = async args => { if (++lists === 3) throw transientDescribeError(); return list(args); };
  h.sdk.plugins.callRpc = async args => {
    if (args.method === METHODS.describe && args.pluginId === 'source-000' && ++descriptions === 1) throw transientDescribeError();
    return rpc(args);
  };
  const lease = h.runtime.retain(anchor('thread'));
  try {
    await until(() => lists === 3 && h.runtime.stats().running === 0);
    assert.equal(descriptions, 1); assert.equal(h.runtime.isReadyOwner('source-001'), true);
    assert.equal(h.runtime.isReadyOwner('source-000'), false);
    await tick(); await tick(); assert.equal(lists, 3);
    h.runtime.invalidate('thread');
    await until(() => h.runtime.isReadyOwner('source-000') && h.runtime.stats().running === 0);
    assert.equal(descriptions, 2); assert.equal(lists, 4);
  } finally { lease.dispose(); h.dispose(); }
});

test('one transient Enumerate retry yields behind healthy owners and shared roots stay quiet after recovery', async () => {
  for (const kind of ['source-error', 'transport-error', 'timeout'] as const) {
    const h = setup(2), rpc = h.sdk.plugins.callRpc, list = h.sdk.plugins.list;
    const calls: string[] = [], descriptions: string[] = []; let lists = 0;
    h.sdk.plugins.list = async args => { lists++; return list(args); };
    h.sdk.plugins.callRpc = async args => {
      if (args.method === METHODS.describe) descriptions.push(args.pluginId);
      if (args.method === METHODS.enumerate) {
        calls.push(args.pluginId);
        if (calls.length === 1) throw new ResultsCallError(kind);
      }
      return rpc(args);
    };
    const first = h.runtime.retain(anchor('thread')), duplicate = h.runtime.retain(anchor('thread'));
    try {
      await until(() => calls.length === 3 && !first.store.state.busy && h.runtime.stats().running === 0);
      assert.deepEqual(calls, ['source-000', 'source-001', 'source-000'], kind);
      assert.deepEqual(descriptions, ['source-000', 'source-001'], 'healthy descriptors are not restarted');
      assert.equal(lists, 3, 'two initial owner slices plus one bounded fresh membership admission for the retry');
      assert.equal(first.store, duplicate.store); assert.equal(first.store.state.error, null);
      assert.equal(h.runtime.isReadyOwner('source-001'), true);
      const quiet = h.reads.length; await tick(); await tick(); assert.equal(h.reads.length, quiet);
    } finally { first.dispose(); duplicate.dispose(); h.dispose(); }
  }
});

test('persistent transient Enumerate parks after one retry then a genuine new demand can recover', async () => {
  const h = setup(2), rpc = h.sdk.plugins.callRpc;
  let failed = true; const calls: string[] = [];
  h.sdk.plugins.callRpc = async args => {
    if (args.method === METHODS.enumerate) {
      calls.push(args.pluginId);
      if (failed && args.pluginId === 'source-000') throw new ResultsCallError('source-error');
    }
    return rpc(args);
  };
  const lease = h.runtime.retain(anchor('thread'));
  try {
    await until(() => calls.length === 3 && h.runtime.stats().running === 0);
    assert.deepEqual(calls, ['source-000', 'source-001', 'source-000']);
    const quiet = h.reads.length; await tick(); await tick(); assert.equal(h.reads.length, quiet);
    failed = false; h.runtime.invalidate('thread');
    await until(() => calls.length === 5 && h.runtime.stats().running === 0);
    assert.deepEqual(calls.slice(3), ['source-000', 'source-001']);
    assert.equal(lease.store.state.error, null); assert.equal(h.runtime.stats().queued, 0);
  } finally { lease.dispose(); h.dispose(); }
});

test('failed-feed revisit refuses removed disabled and malformed public membership without a second call', async () => {
  for (const state of ['removed', 'disabled', 'malformed'] as const) {
    const h = setup(2), rpc = h.sdk.plugins.callRpc, list = h.sdk.plugins.list;
    let lists = 0; const calls: string[] = [];
    h.sdk.plugins.list = async args => {
      const result = await list(args); if (++lists <= 2) return result;
      if (state === 'malformed') return { plugins: [...result.plugins, result.plugins[0]!] };
      return { plugins: result.plugins.flatMap(row => row.id !== 'source-000' ? [row]
        : state === 'removed' ? [] : [{ ...row, enabled: false }]) };
    };
    h.sdk.plugins.callRpc = async args => {
      if (args.method === METHODS.enumerate) {
        calls.push(args.pluginId); if (args.pluginId === 'source-000') throw new ResultsCallError('source-error');
      }
      return rpc(args);
    };
    const lease = h.runtime.retain(anchor('thread'));
    try {
      await until(() => lists === 3 && h.runtime.stats().running === 0);
      assert.deepEqual(calls, ['source-000', 'source-001'], state);
      const quiet = h.reads.length; await tick(); await tick(); assert.equal(h.reads.length, quiet);
    } finally { lease.dispose(); h.dispose(); }
  }
});

test('nontransient feed errors and backend Apply failure gain no Enumerate retry authority', async () => {
  for (const kind of ['incompatible', 'unauthorized', 'aborted', 'disabled', 'unknown-plugin', 'backend'] as const) {
    const h = setup(2), rpc = h.sdk.plugins.callRpc, list = h.sdk.plugins.list;
    let lists = 0; const calls: string[] = [];
    h.sdk.plugins.list = async args => { lists++; return list(args); };
    h.sdk.plugins.callRpc = async args => {
      if (args.method === METHODS.enumerate) {
        calls.push(args.pluginId);
        if (args.pluginId === 'source-000' && kind !== 'backend') throw new ResultsCallError(kind);
      }
      if (kind === 'backend' && args.method === GALLERY_METHODS.apply) {
        const input = args.input as { owner?: string; stage?: unknown };
        if (input.owner === 'source-000' && input.stage) throw new ResultsCallError('source-error');
      }
      return rpc(args);
    };
    const lease = h.runtime.retain(anchor('thread'));
    try {
      await until(() => calls.length === 2 && h.runtime.stats().running === 0);
      assert.deepEqual(calls, ['source-000', 'source-001'], kind); assert.equal(lists, 2, 'one fresh list per initial legacy owner slice, with no retry list');
    } finally { lease.dispose(); h.dispose(); }
  }
});

test('hidden or retired failed-feed membership read fences ignored late results and cannot Enumerate again', async () => {
  for (const retirement of ['hidden', 'dispose'] as const) {
    const h = setup(2), rpc = h.sdk.plugins.callRpc, list = h.sdk.plugins.list;
    let lists = 0, release!: () => void, held!: AbortSignal; const calls: string[] = [];
    h.sdk.plugins.list = async args => {
      if (++lists === 3) { held = args?.signal!; await new Promise<void>(resolve => { release = resolve; }); }
      return list(args);
    };
    h.sdk.plugins.callRpc = async args => {
      if (args.method === METHODS.enumerate) {
        calls.push(args.pluginId); if (args.pluginId === 'source-000') throw new ResultsCallError('source-error');
      }
      return rpc(args);
    };
    const lease = h.runtime.retain(anchor('thread'));
    try {
      await until(() => Boolean(release));
      if (retirement === 'hidden') h.hidden(true); else h.runtime.dispose();
      assert.equal(held.aborted, true); await tick();
      assert.equal(h.runtime.stats().running, 1, 'ignored raw membership read retains actual occupancy');
      release(); await until(() => h.runtime.stats().running === 0); await tick();
      assert.deepEqual(calls, ['source-000', 'source-001']); assert.equal(h.runtime.stats().queued, 0);
    } finally { release?.(); lease.dispose(); h.dispose(); }
  }
});

test('explicit action read yields retained collection, precedes passive history and resumes finite supplier work', async () => {
  const h = setup(2, '', true), lease = h.runtime.retain(anchor('same')); let held!: AbortSignal, once = true;
  const order: string[] = [];
  try {
    await until(() => h.runtime.stats().running === 0 && h.sourceCalls.length === 6);
    const firstPass = [...h.sourceCalls];
    h.setHold(async (_thread, signal) => {
      if (!once) { order.push('resumed'); return; }
      once = false; held = signal; order.push('held');
      await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    });
    lease.more(); await until(() => !!held);
    const passive = h.runtime.readScope('same', new AbortController().signal, async () => { order.push('passive'); return 'passive'; });
    const action = h.runtime.readScope('same', new AbortController().signal, async () => { order.push('action'); return 'verified'; }, true);
    assert.deepEqual(await action, { state: 'ready', value: 'verified' }); await passive;
    await until(() => h.runtime.stats().running === 0 && h.runtime.stats().queued === 0);
    assert.equal(held.aborted, true); assert.ok(order.indexOf('action') < order.indexOf('passive'));
    assert.ok(order.indexOf('action') < order.indexOf('resumed')); assert.deepEqual(h.sourceCalls.slice(0, firstPass.length), firstPass);
    assert.equal(h.sourceCalls.length, 12); assert.equal(lease.store.state.error, null); assert.equal(lease.store.state.continued, true);
    const quiet = h.reads.length; await tick(); assert.equal(h.reads.length, quiet); assert.equal(h.runtime.stats().historyReads, 0);
  } finally { lease.dispose(); h.dispose(); }
});

test('uncancellable retained read holds occupancy, aborted priority cannot run late, and another thread retains its lane', async () => {
  const h = setup(1); let release!: () => void, held!: AbortSignal, actionCalls = 0;
  h.setHold(async (thread, signal) => { if (thread !== 'same') return; held = signal; await new Promise<void>(resolve => { release = resolve; }); });
  const lease = h.runtime.retain(anchor('same')), controller = new AbortController();
  try {
    await until(() => !!held);
    const action = h.runtime.readScope('same', controller.signal, async () => { actionCalls++; }, true);
    const rejected = assert.rejects(action); assert.equal(held.aborted, true); await tick();
    assert.equal(h.runtime.stats().running, 1); assert.equal(actionCalls, 0);
    const other = await h.runtime.readScope('other', new AbortController().signal, async () => 'healthy');
    assert.deepEqual(other, { state: 'ready', value: 'healthy' }); assert.ok(h.runtime.stats().running <= 2);
    controller.abort('superseded'); await rejected; assert.equal(actionCalls, 0);
    h.setHold(null); release(); await until(() => h.sourceCalls.length === 1 && h.runtime.stats().running === 0);
    assert.equal(actionCalls, 0); assert.equal(lease.store.state.error, null); assert.equal(h.runtime.stats().historyReads, 0);
    // The final action read wraps backend.read -> rpc -> untilAborted(raw).
    // Its outer callback can reject while the real SDK promise remains held.
    let finalStarted = false;
    h.setHold(async (_thread, signal) => { held = signal; finalStarted = true; await new Promise<void>(resolve => { release = resolve; }); });
    const finalController = new AbortController();
    const final = h.runtime.readScope('same', finalController.signal, signal => h.runtime.backend.read('same', 'turn', signal), true);
    const finalRejected = assert.rejects(final);
    await until(() => finalStarted); finalController.abort('retired'); await finalRejected; await tick();
    assert.equal(held.aborted, true); assert.equal(h.runtime.stats().running, 1);
    assert.equal(h.runtime.stats().historyReads, 1, 'raw final-read occupancy outlives its rejected abort wrapper');
    const healthy = await h.runtime.readScope('other', new AbortController().signal, async () => 'still healthy');
    assert.deepEqual(healthy, { state: 'ready', value: 'still healthy' });
    h.runtime.dispose(); let drained = false;
    const drainage = h.runtime.whenDrained().then(() => { drained = true; });
    await tick(); assert.equal(drained, false, 'replacement cannot bypass the old raw-call occupancy');
    h.setHold(null); release(); await drainage; await until(() => h.runtime.stats().running === 0);
    assert.equal(h.runtime.stats().historyReads, 0); assert.equal(actionCalls, 0);
  } finally { release?.(); controller.abort(); lease.dispose(); h.dispose(); }
});

test('advertised public Describe membership skips nonparticipants but still requires fresh list and real descriptors', async () => {
  const h = setup(5), original = h.sdk.plugins.callRpc, ids = Array.from({ length: 5 }, (_, i) => `source-${String(i).padStart(3, '0')}`);
  const described: string[] = []; let metadataCalls = 0, listed = ids, disabled = '', invalid = '';
  h.sdk.plugins.experimental_discoverRpc = async args => {
    assert.equal(args?.method, METHODS.describe); metadataCalls++;
    return [...ids, 'absent-owner', 'turn-results'].map(pluginId => ({ pluginId, method: METHODS.describe }));
  };
  h.sdk.plugins.list = async () => ({ plugins: [...listed.map(id => ({ id, enabled: id !== disabled, status: 'running' })),
    ...Array.from({ length: 70 }, (_, i) => ({ id: `noise-${i}`, enabled: true, status: 'running' }))] });
  h.sdk.plugins.callRpc = async args => {
    if (args.method === METHODS.describe) { described.push(args.pluginId); if (args.pluginId === invalid) return args.outputSchema.parse({ version: -1 }); }
    return original(args);
  };
  const lease = h.runtime.retain(anchor('advertised'));
  try {
    await until(() => h.sourceCalls.length === 5 && h.runtime.stats().running === 0);
    assert.deepEqual(described, ids); assert.equal(metadataCalls, 1);
    assert.equal(h.runtime.isReadyOwner('absent-owner'), false);
    const idle = { calls: metadataCalls, descriptions: described.length, reads: h.reads.length };
    await tick(); await tick(); assert.deepEqual({ calls: metadataCalls, descriptions: described.length, reads: h.reads.length }, idle);
    // A stale advertised name cannot override fresh removal, disabling or a
    // malformed genuine descriptor; reconnect uses new metadata/list admission.
    listed = ids.slice(1); disabled = ids[1]!; invalid = ids[2]!;
    h.runtime.invalidate(undefined, true);
    await until(() => metadataCalls === 2 && h.runtime.stats().running === 0);
    for (const id of ids.slice(0, 3)) assert.equal(h.runtime.isReadyOwner(id), false);
    assert.deepEqual(described.slice(5), ids.slice(2));
    listed = ids; disabled = ''; invalid = ''; h.runtime.invalidate(undefined, true);
    await until(() => metadataCalls === 3 && h.runtime.stats().running === 0);
    for (const id of ids) assert.equal(h.runtime.isReadyOwner(id), true);
    assert.ok(described.every(id => ids.includes(id)), 'zero nonparticipant Describe calls across membership generations');
  } finally { lease.dispose(); h.dispose(); }
});

for (const mode of ['unsupported', 'failure', 'route404', 'malformed', 'overbound'] as const) test(`optional advertised membership ${mode} falls back to genuine bounded discovery`, async () => {
  const h = setup(1), original = h.sdk.plugins.callRpc; let described = 0;
  if (mode !== 'unsupported') h.sdk.plugins.experimental_discoverRpc = async () => {
    if (mode === 'failure') throw Object.assign(Error('Unsupported RPC discovery'), { status: 404, body: { error: { code: 'unknown_method' } } });
    if (mode === 'route404') throw { status: 404, body: { error: 'Not Found' } };
    if (mode === 'malformed') return [{ pluginId: 'INVALID ID', method: METHODS.describe }];
    return Array.from({ length: 257 }, (_, i) => ({ pluginId: `listed-${i}`, method: METHODS.describe }));
  };
  h.sdk.plugins.callRpc = async args => { if (args.method === METHODS.describe) described++; return original(args); };
  const lease = h.runtime.retain(anchor(`metadata-${mode}`));
  try {
    await until(() => h.sourceCalls.length === 1 && h.runtime.stats().running === 0);
    assert.equal(described, 1); assert.equal(h.runtime.isReadyOwner('source-000'), true);
  } finally { lease.dispose(); h.dispose(); }
});

test('valid empty advertised membership grants nothing; later genuine membership demand can discover', async () => {
  const h = setup(1); let empty = true, metadata = 0;
  h.sdk.plugins.experimental_discoverRpc = async () => { metadata++; return empty ? [] : [{ pluginId: 'source-000', method: METHODS.describe }]; };
  const lease = h.runtime.retain(anchor('empty-membership'));
  try {
    await until(() => metadata === 1 && h.runtime.stats().running === 0);
    assert.equal(h.runtime.isReadyOwner('source-000'), false); assert.equal(h.sourceCalls.length, 0);
    await tick(); assert.equal(metadata, 1);
    empty = false; h.runtime.invalidate(undefined, true);
    await until(() => h.runtime.isReadyOwner('source-000') && h.runtime.stats().running === 0);
    assert.equal(metadata, 2); assert.equal(h.sourceCalls.length, 1);
  } finally { lease.dispose(); h.dispose(); }
});

test('ignored metadata/list cancellation retains actual lane and late old membership cannot regain readiness', async () => {
  const h = setup(1), originalList = h.sdk.plugins.list;
  let release!: () => void, entered = false, settled = false;
  h.sdk.plugins.experimental_discoverRpc = async () => [{ pluginId: 'source-000', method: METHODS.describe }];
  h.sdk.plugins.list = async () => {
    entered = true; await new Promise<void>(done => { release = done; }); settled = true; return originalList();
  };
  const lease = h.runtime.retain(anchor('ignored-metadata'));
  try {
    await until(() => entered); h.hidden(true); await tick();
    assert.equal(settled, false); assert.equal(h.runtime.stats().running, 1);
    assert.equal(h.runtime.isReadyOwner('source-000'), false); assert.equal(h.sourceCalls.length, 0);
    release(); await until(() => h.runtime.stats().running === 0);
    assert.equal(h.runtime.isReadyOwner('source-000'), false);
    h.sdk.plugins.list = originalList; h.sdk.plugins.experimental_discoverRpc = async () => [{ pluginId: 'source-000', method: METHODS.describe }];
    h.hidden(false); await until(() => h.runtime.isReadyOwner('source-000') && h.runtime.stats().running === 0);
    assert.equal(h.sourceCalls.length, 1);
    lease.dispose(); h.runtime.dispose(); await h.runtime.whenDrained();
    assert.equal(h.runtime.stats().running, 0); assert.equal(h.runtime.stats().queued, 0);
  } finally { release?.(); lease.dispose(); h.dispose(); }
});

function prefixRow(i: number, padding = 0): GalleryObservation {
  const source = { threadId: 'prefix', turnId: 'turn', eventId: `event-${i}`, seq: i + 1, itemId: `item-${i}`, eventType: 'item/completed' as const };
  const identity: GalleryObservation['identity'] = { version: 1, ref: { source, member: 'result', kind: 'example/result' },
    artifact: { provider: 'example', id: `artifact-${i}`, kind: 'image' }, specificity: 'typed',
    evidence: { basis: 'native-completion', sites: [], targetUrls: [], selectedDigest: 'a'.repeat(64) }, lookup: null };
  return { key: `prefix-${i}`, owner: 'source-000', identity, unresolved: false, firstObservedOrder: i,
    corrections: [], sourceExpired: null, retracted: null, freshness: 'stale', currentAvailability: null,
    resolution: { identity, revision: { epoch: 'fixture', sequence: 1 }, proof: { kind: 'native-image', source, selectedDigest: 'a'.repeat(64) },
      knowledge: 'confirmed', outcomeEvidence: { kind: 'observation', id: `receipt-${i}`, digest: 'b'.repeat(64), recordedAt: 1 },
      availability: { state: 'unknown', asOf: 1, expiresAt: null }, route: { kind: 'url', href: `https://fixture.invalid/${i}` },
      provenance: { originHost: { state: 'unknown', reason: 'not-recorded' }, artifactLocation: { state: 'unknown', reason: 'not-verified' } },
      fallback: { kind: 'card', title: `Useful retained ${i}` }, spans: { width: 1, height: 1 },
      ...(padding ? { presentation: { schema: 'example/card@1', data: { padding: 'x'.repeat(padding) } } } : {}) } };
}
const prefixRead = (rows: GalleryObservation[], next: { seq: number; key: string } | null = null) => ({ page: { rows, next }, coverage: { state: 'partial', intervals: [] } });

test('incomplete initial prefix survives restart/omission but explicit retraction revokes; only complete membership replaces', async () => {
  const h = setup(), original = h.sdk.plugins.callRpc, a = prefixRow(0), b = prefixRow(1);
  const cursor = { seq: 1, key: a.key }; let wave = 0, release!: () => void, held = false;
  h.sdk.plugins.callRpc = async args => {
    if (args.method !== GALLERY_METHODS.read) return original(args);
    const input = args.input as { after?: typeof cursor };
    if (!input.after) return args.outputSchema.parse(prefixRead(wave === 0 ? [a] : wave === 1 ? [b] : [{ ...a,
      retracted: { revision: { epoch: 'fixture', sequence: 2 }, supersedesEvidenceDigest: 'b'.repeat(64), reason: 'Corrected' } }], cursor));
    assert.deepEqual(input.after, cursor); held = true;
    await new Promise<void>(done => { release = done; });
    return args.outputSchema.parse(prefixRead([]));
  };
  const lease = h.runtime.retain(anchor('prefix'));
  try {
    await until(() => held && lease.store.state.rows.length === 1);
    assert.equal(lease.store.state.loaded, false); assert.deepEqual(lease.store.state.rows, [a]);
    assert.ok(h.runtime.stats().bytes > Buffer.byteLength(JSON.stringify(lease.store.state)), 'in-flight pass memory is charged alongside the published prefix');
    h.hidden(true); release(); await until(() => h.runtime.stats().running === 0);
    assert.deepEqual(lease.store.state.rows, [a]); assert.equal(lease.store.state.loaded, false, 'abort cannot complete provisional membership');
    assert.equal(h.runtime.stats().bytes, Buffer.byteLength(JSON.stringify(lease.store.state)), 'retired pass memory releases only after actual raw settlement');
    wave = 1; held = false; h.hidden(false);
    await until(() => held && lease.store.state.rows.length === 2);
    assert.deepEqual(lease.store.state.rows.map(row => row.key), [a.key, b.key], 'a restarted prefix omission does not withdraw earlier positive');
    assert.equal(lease.store.state.loaded, false);
    h.hidden(true); release(); await until(() => h.runtime.stats().running === 0);
    wave = 2; held = false; h.hidden(false);
    await until(() => held && lease.store.state.rows.length === 1);
    assert.deepEqual(lease.store.state.rows, [b], 'explicit returned retraction revokes its own earlier positive');
    assert.equal(lease.store.state.loaded, false);
    release(); await until(() => lease.store.state.loaded === true && h.runtime.stats().running === 0);
    assert.equal(lease.store.state.rows.length, 1); assert.equal(lease.store.state.rows[0]!.key, a.key);
    assert.ok(lease.store.state.rows[0]!.retracted, 'complete snapshot alone replaces provisional membership');
  } finally { release?.(); lease.dispose(); h.dispose(); }
});

test('page continuation keeps its original deadline across queue wait and releases parked pass memory', async () => {
  const h = setup(), original = h.sdk.plugins.callRpc, a = prefixRow(0), b = prefixRow(1);
  const cursor = { seq: 1, key: a.key }, queuedSignal = new AbortController();
  let now = performance.now(), reads = 0, waitQueued = false, waitFinished = false;
  const clock = mock.method(performance, 'now', () => now);
  let queued: ReturnType<typeof h.runtime.readScope> | undefined;
  h.sdk.plugins.callRpc = async args => {
    if (args.method !== GALLERY_METHODS.read) return original(args);
    reads++;
    const input = args.input as { after?: typeof cursor };
    if (!input.after) {
      if (!waitQueued) {
        waitQueued = true;
        queued = h.runtime.readScope('prefix', queuedSignal.signal, async () => {
          now += GALLERY_RUNTIME_LIMITS.sliceMs + 1; waitFinished = true;
        });
      }
      return args.outputSchema.parse(prefixRead([a], cursor));
    }
    assert.deepEqual(input.after, cursor);
    return args.outputSchema.parse(prefixRead([b]));
  };
  const lease = h.runtime.retain(anchor('prefix'));
  try {
    await until(() => waitFinished && h.runtime.stats().running === 0 && h.runtime.stats().queued === 0);
    await queued;
    assert.equal(reads, 1, 'queue wait cannot start page two with a renewed six-second deadline');
    assert.equal(lease.store.state.loaded, false); assert.deepEqual(lease.store.state.rows, [a]);
    assert.match(lease.store.state.error!, /deadline/);
    assert.equal(h.runtime.stats().bytes, Buffer.byteLength(JSON.stringify(lease.store.state)), 'parked private pass is no longer retained');
    await tick(); await tick(); assert.equal(reads, 1, 'expired collection stays parked while idle');
    lease.more();
    await until(() => lease.store.state.loaded === true && h.runtime.stats().running === 0);
    assert.equal(reads, 3, 'genuine later demand restarts latest, then uses its newly issued continuation');
    assert.deepEqual(lease.store.state.rows, [a, b]);
    assert.equal(h.runtime.stats().bytes, Buffer.byteLength(JSON.stringify(lease.store.state)), 'completion transfers rows without retaining a second collection');
  } finally { queuedSignal.abort(); lease.dispose(); h.dispose(); clock.mock.restore(); }
});

test('early readiness shares one first slice across visible roots, preserves cursor debt and rechecks new membership', async () => {
  const h = setup(33), rpc = h.sdk.plugins.callRpc, listed = h.sdk.plugins.list;
  const described: string[] = []; let release!: () => void, entered = false, disabled = false;
  h.sdk.plugins.callRpc = async args => { if (args.method === METHODS.describe) described.push(args.pluginId); return rpc(args); };
  h.sdk.plugins.list = async input => {
    const value = await listed(input);
    return { plugins: value.plugins.map(row => row.id === 'source-000' && disabled ? { ...row, enabled: false } : row) };
  };
  const demands = Array.from({ length: 3 }, () => h.runtime.retainDiscoveryDemand()!);
  const controller = new AbortController();
  const firstHistory = h.runtime.readScope('same', controller.signal, async () => {
    entered = true; await new Promise<void>(done => { release = done; });
  });
  try {
    await until(() => entered);
    for (const [index, demand] of demands.entries()) { demand.visible(true); demand.warm(index === 2 ? 'other' : 'same'); }
    assert.equal(h.runtime.stats().queued, 1, 'one queued first slice for the window generation, not one per root');
    assert.deepEqual(described, []); release(); await firstHistory;
    await until(() => h.runtime.isReadyOwner('source-000') && h.runtime.stats().running === 0);
    assert.equal(described.length, 1); assert.equal(h.runtime.isReadyOwner('source-032'), false);
    assert.equal(h.sourceCalls.length, 0); assert.deepEqual(h.reads, [], 'readiness-only task never collects or consumes sources');
    for (const demand of demands) demand.warm('same');
    await tick(); await tick(); assert.equal(described.length, 1, 'no automatic continuation or idle retry from visible roots');
    for (let i = 1; i < 33; i++) await h.runtime.readScope('same', controller.signal, signal => h.runtime.discoverReady(signal));
    assert.equal(described.length, 33); assert.equal(h.runtime.isReadyOwner('source-032'), true, 'later genuine discovery demand uses the existing issued discovery cursor');
    disabled = true; h.runtime.invalidateReadiness();
    assert.equal(h.runtime.readyOwners.state.size, 0);
    for (const demand of demands) demand.warm('same');
    await until(() => h.runtime.readyOwners.state.size === 1 && h.runtime.stats().running === 0);
    for (let i = 1; i < 32; i++) await h.runtime.readScope('same', controller.signal, signal => h.runtime.discoverReady(signal));
    assert.equal(h.runtime.readyOwners.state.size, 32); assert.equal(described.length, 65); assert.equal(described.filter(id => id === 'source-000').length, 1);
    assert.equal(h.runtime.isReadyOwner('source-000'), false, 'new generation requires fresh enabled membership');
    const calls = described.length; await tick(); await tick(); assert.equal(described.length, calls);
  } finally { release?.(); controller.abort(); for (const demand of demands) demand.dispose(); h.dispose(); }
});

test('early discovery owns ignored raw timeout, skips expired helper dispatch and refuses no-demand/hide/retirement', async () => {
  const h = setup(2), rpc = h.sdk.plugins.callRpc;
  let release!: () => void, held: AbortSignal | undefined, settled = false;
  const described: string[] = [];
  h.sdk.plugins.callRpc = async args => {
    if (args.method === METHODS.describe) {
      described.push(args.pluginId);
      if (described.length === 1) { held = args.signal; await new Promise<void>(done => { release = done; }); settled = true; }
    }
    return rpc(args);
  };
  const demand = h.runtime.retainDiscoveryDemand()!; demand.visible(true); demand.warm('same');
  const controller = new AbortController(); let sameDispatched = false;
  try {
    await until(() => held?.aborted === true);
    assert.equal(settled, false); assert.deepEqual(described, ['source-000']);
    assert.equal(h.runtime.stats().running, 1); assert.equal(h.runtime.stats().historyReads, 1);
    const same = h.runtime.readScope('same', controller.signal, async () => { sameDispatched = true; });
    const sameRejected = assert.rejects(same);
    const other = await h.runtime.readScope('other', new AbortController().signal, async () => 'other-thread-progress');
    assert.deepEqual(other, { state: 'ready', value: 'other-thread-progress' }); assert.equal(sameDispatched, false);
    await new Promise(done => setTimeout(done, 520)); // The second helper's unchanged500ms deadline expires while queued behind raw work.
    assert.deepEqual(described, ['source-000']); assert.equal(h.runtime.stats().running, 1);
    demand.visible(false); controller.abort('retired'); await sameRejected;
    assert.equal(h.runtime.isReadyOwner('source-000'), false); assert.equal(sameDispatched, false);
    h.hidden(true); release(); await until(() => h.runtime.stats().running === 0);
    assert.deepEqual(described, ['source-000'], 'expired queued helper must not dispatch after old raw settles');
    assert.equal(h.runtime.readyOwners.state.size, 0); assert.equal(h.runtime.stats().historyReads, 0);
    h.hidden(false); demand.visible(true); demand.warm('same');
    await until(() => h.runtime.readyOwners.state.size === 1 && h.runtime.stats().running === 0);
    await h.runtime.readScope('same', new AbortController().signal, signal => h.runtime.discoverReady(signal));
    assert.equal(h.runtime.readyOwners.state.size, 2);
    assert.deepEqual(described, ['source-000', 'source-000', 'source-001']); assert.equal(h.sourceCalls.length, 0);
    demand.dispose(); h.runtime.dispose(); await h.runtime.whenDrained();
    assert.equal(h.runtime.stats().running, 0); assert.equal(h.runtime.stats().historyReads, 0);
  } finally { release?.(); controller.abort(); demand.dispose(); h.dispose(); }
});

test('conflicting duplicate page cannot complete a prefix and complete last-good data is not replaced by refresh prefix', async () => {
  const h = setup(), original = h.sdk.plugins.callRpc, a = prefixRow(0), b = prefixRow(1);
  let complete = false, held = false, release!: () => void;
  h.sdk.plugins.callRpc = async args => {
    if (args.method !== GALLERY_METHODS.read) return original(args);
    const input = args.input as { after?: { seq: number; key: string } };
    if (!input.after) return args.outputSchema.parse(complete ? prefixRead([a]) : prefixRead([b], { seq: 2, key: b.key }));
    held = true; await new Promise<void>(done => { release = done; });
    return args.outputSchema.parse(prefixRead([b])); // Exact duplicate in the issued chain is refused.
  };
  const lease = h.runtime.retain(anchor('prefix'));
  try {
    await until(() => held && lease.store.state.rows.length === 1); release();
    await until(() => h.runtime.stats().running === 0);
    assert.equal(lease.store.state.loaded, false); assert.match(lease.store.state.error!, /collection changed/);
    assert.deepEqual(lease.store.state.rows, [b]);
    complete = true; lease.more(); await until(() => lease.store.state.loaded === true && h.runtime.stats().running === 0);
    assert.deepEqual(lease.store.state.rows, [a]);
    complete = false; held = false; lease.more(); await until(() => held);
    assert.deepEqual(lease.store.state.rows, [a]); assert.equal(lease.store.state.loaded, true, 'existing complete last-good behavior is unchanged');
    release(); await until(() => h.runtime.stats().running === 0);
    assert.deepEqual(lease.store.state.rows, [a]);
  } finally { release?.(); lease.dispose(); h.dispose(); }
});

test('prefix union and incomplete collection obey existing row/byte/page limits and park without authority or idle work', async () => {
  const h = setup(), original = h.sdk.plugins.callRpc, rows = Array.from({ length: 64 }, (_, i) => prefixRow(i, 4000));
  let reads = 0;
  h.sdk.plugins.callRpc = async args => {
    if (args.method !== GALLERY_METHODS.read) return original(args);
    reads++; const input = args.input as { after?: { seq: number; key: string } };
    const start = input.after ? rows.findIndex(row => row.key === input.after!.key) + 1 : 0;
    const page = rows.slice(start, start + 8), last = page.at(-1)!;
    return args.outputSchema.parse(prefixRead(page, start + 8 < rows.length ? { seq: last.identity.ref.source.seq, key: last.key } : null));
  };
  const lease = h.runtime.retain(anchor('prefix'));
  try {
    await until(() => h.runtime.stats().running === 0 && lease.store.state.limited === true);
    assert.equal(lease.store.state.loaded, false); assert.equal(lease.store.state.continued, true);
    assert.ok(lease.store.state.rows.length > 0 && lease.store.state.rows.length < 64);
    assert.ok(Buffer.byteLength(JSON.stringify(lease.store.state)) <= GALLERY_RUNTIME_LIMITS.snapshotBytes);
    assert.ok(reads <= GALLERY_RUNTIME_LIMITS.collectionPages); assert.equal(h.runtime.isReadyOwner('source-000'), false);
    const count = reads; await tick(); await tick(); assert.equal(reads, count, 'finite capacity stays parked without polling');
  } finally { lease.dispose(); h.dispose(); }
});

test('queued warm Media promotes through its shared entry; Open and raw ownership stay ahead of speculative work', async () => {
  const h = setup(), row = prefixRow(0), original = h.sdk.plugins.callRpc;
  const data = new Uint8Array([137, 80, 78, 71]), sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))].map(v => v.toString(16).padStart(2, '0')).join('');
  const target = { kind: 'host' as const, hostId: 'recorded-host', path: '/saved/result.png' };
  row.owner = 'turn-result-images'; row.resolution!.route = { kind: 'file', target };
  row.resolution!.fallback = { kind: 'image', title: 'Verified image', alt: 'Verified scene' };
  row.resolution!.provenance.artifactLocation = { state: 'verified', target, observedAt: 1, basis: 'explicit-host-read', sha256: sha };
  let releaseRaw!: () => void, releaseMedia!: () => void, rawStarted = false, mediaCalls = 0;
  const raw = new Promise<void>(done => { releaseRaw = done; }), media = new Promise<void>(done => { releaseMedia = done; });
  const calls: string[] = [], controller = new AbortController(), queued = new AbortController();
  const fetch = mock.method(globalThis, 'fetch', async () => new Response(data, { headers: { 'content-type': 'image/png' } }));
  h.sdk.plugins.callRpc = async args => {
    if (args.method !== 'turnResultImagesV1Media') return original(args);
    calls.push('media'); mediaCalls++; assert.equal(args.signal, undefined, 'dispatched response is owned, not locally aborted/reissued');
    await media;
    const { sha256Canonical } = await import('@phosphorco/bb-turn-results');
    const now = Date.now(); return args.outputSchema.parse({ version: 1, state: 'ready',
      image: { mimeType: 'image/png', sha256: sha, width: 1, height: 1, sizeBytes: data.length },
      lease: { targetFingerprint: await sha256Canonical({ target, sha256: sha }), leaseGeneration: 'test', baseUrl: '/api/v1/file-previews/test',
        url: '/api/v1/file-previews/test/image.png', resolvedAt: now, expiresAtMs: now + 60000 } });
  };
  type ImageResource = Awaited<ReturnType<typeof h.runtime.image>>;
  let warm: ImageResource = null, foreground: ImageResource = null, remount: ImageResource = null;
  try {
    const blocked = h.runtime.readScope('prefix', controller.signal, async () => { rawStarted = true; await raw; }).catch(() => null);
    await until(() => rawStarted);
    warm = await h.runtime.image(row, true, true); assert.ok(warm);
    await until(() => h.runtime.stats().historyReads === 2);
    const laterSpec = h.runtime.readScope('prefix', queued.signal, async () => { calls.push('speculative'); }, false, true);
    const ordinary = h.runtime.readScope('prefix', queued.signal, async () => { calls.push('foreground'); });
    foreground = await h.runtime.image(row, true); assert.ok(foreground); assert.equal(warm.store, foreground.store);
    const open = h.runtime.readScope('prefix', queued.signal, async () => { calls.push('Open'); }, true);
    controller.abort(); await blocked; await tick();
    assert.equal(h.runtime.stats().running, 1); assert.equal(calls.length, 0, 'ignored raw read still owns this thread');
    await h.runtime.readScope('other', queued.signal, async () => { calls.push('other-thread'); });
    assert.deepEqual(calls, ['other-thread']);
    releaseRaw(); await until(() => mediaCalls === 1);
    assert.deepEqual(calls, ['other-thread', 'Open', 'media'], 'queued shared Media is promoted, not recreated behind later foreground work');
    warm.dispose(); warm = null;
    assert.equal(h.runtime.stats().running, 1); assert.equal(mediaCalls, 1);
    releaseMedia(); await Promise.all([open, ordinary, laterSpec]); await until(() => foreground!.store.state.state === 'ready' && h.runtime.stats().running === 0);
    assert.deepEqual(calls, ['other-thread', 'Open', 'media', 'foreground', 'speculative']);
    assert.equal(fetch.mock.callCount(), 1);
    remount = await h.runtime.image(row, true); assert.equal(remount!.store.state.url, foreground.store.state.url); assert.equal(mediaCalls, 1);
    const quiet = calls.length; await tick(); assert.equal(calls.length, quiet);
  } finally { releaseRaw(); releaseMedia(); warm?.dispose(); foreground?.dispose(); remount?.dispose(); h.dispose(); await h.runtime.whenDrained(); fetch.mock.restore(); }
});

test('nearby retains at most two existing turn entries and retirement keeps data provisional until a fresh foreground read', async () => {
  const h = setup(); const a = h.runtime.retain(anchor('a'), true, undefined, true), b = h.runtime.retain(anchor('b'), true, undefined, true);
  const c = h.runtime.retain(anchor('c'), true, undefined, true);
  try {
    assert.equal(c.capacity, true); await until(() => h.runtime.stats().running === 0 && h.runtime.stats().queued === 0);
    assert.equal(a.store.state.loaded, true); a.passive(); assert.equal(a.store.state.loaded, false);
    const before = h.reads.length, visible = h.runtime.retain(anchor('a'));
    try { await until(() => a.store.state.loaded === true && h.runtime.stats().running === 0); assert.ok(h.reads.length > before); }
    finally { visible.dispose(); }
    const count = h.reads.length; await tick(); assert.equal(h.reads.length, count);
  } finally { a.dispose(); b.dispose(); c.dispose(); h.dispose(); }
});


test('passive visible image admission remains distinct from conservative speculative availability hints', async () => {
  const h = setup(), base = prefixRow(0), target = { kind: 'host' as const, hostId: 'recorded-host', path: '/saved/result.png' };
  base.owner = 'turn-result-images'; base.resolution!.route = { kind: 'file', target };
  base.resolution!.fallback = { kind: 'image', title: 'Saved image', alt: 'Retained scene' };
  base.resolution!.provenance.artifactLocation = { state: 'verified', target, observedAt: 1, basis: 'explicit-host-read', sha256: 'a'.repeat(64) };
  try {
    for (const kind of ['saved-unavailable', 'current-unavailable', 'expired', 'retracted'] as const) {
      const row = structuredClone(base); row.key = kind;
      if (kind === 'saved-unavailable') row.resolution!.availability = { state: 'unavailable', asOf: 1, expiresAt: null, reason: 'source-refused' };
      if (kind === 'current-unavailable') row.currentAvailability = { state: 'unavailable', asOf: 1, expiresAt: null, reason: 'source-refused' };
      if (kind === 'expired') row.sourceExpired = { epoch: 'fixture', sequence: 2 };
      if (kind === 'retracted') row.retracted = { revision: { epoch: 'fixture', sequence: 2 }, supersedesEvidenceDigest: 'b'.repeat(64), reason: 'source-retracted' };
      const facts = JSON.stringify(row), entries = h.runtime.media.stats().entries;
      assert.equal(await h.runtime.image(row, true, true), null, kind);
      assert.equal(h.runtime.media.stats().entries, entries, 'refused hint creates no media lease');
      const visible = await h.runtime.image(row, false); assert.ok(visible, kind);
      visible.dispose(); assert.equal(JSON.stringify(row), facts);
    }
    assert.equal(h.runtime.stats().running, 0); assert.equal(h.runtime.stats().historyReads, 0);
  } finally { h.dispose(); await h.runtime.whenDrained(); }
});


const latestInput = (signal: AbortSignal) => ({ threadId: 'cohort', includeNestedRows: 'false' as const,
  segmentLimit: '100', deferContent: 'true' as const, signal });
const latestPage = () => ({ rows: [], completedTurnDisplay: 'collapse', timelinePage: { historySnapshot: 'fresh-public', olderCursor: null } });

test('queued latest cohort cancellation detaches one waiter; last abort holds actual raw credit and other thread progresses', async () => {
  const h = setup(), scope = {}, a = new AbortController(), b = new AbortController(), blocker = new AbortController();
  let releaseBlock!: () => void, releaseRaw!: () => void, rawSignal!: AbortSignal, calls = 0;
  const block = new Promise<void>(done => { releaseBlock = done; }), raw = new Promise<void>(done => { releaseRaw = done; });
  const client: GalleryTimelinePort = { async timeline(input) { calls++; rawSignal = input.signal; await raw; return latestPage(); } };
  const notices: string[] = [];
  const held = h.runtime.readScope('cohort', blocker.signal, () => block);
  await until(() => h.runtime.stats().running === 1);
  const left = h.runtime.readTimeline(latestInput(a.signal), client, { scope, current: () => true, speculative: true, dispatched() { notices.push('a'); } }).catch(() => null);
  const right = h.runtime.readTimeline(latestInput(b.signal), client, { scope, current: () => true, dispatched() { notices.push('b'); } }).catch(() => null);
  try {
    assert.equal(h.runtime.stats().historyReads, 3); releaseBlock(); await held;
    await until(() => calls === 1); assert.deepEqual(new Set(notices), new Set(['a', 'b']));
    b.abort(); await right; assert.equal(rawSignal.aborted, false, 'surviving speculative owner keeps the shared raw response');
    assert.equal(h.runtime.stats().running, 1); assert.equal(h.runtime.stats().historyReads, 2, 'each waiter remains charged through raw settlement');
    await h.runtime.readScope('other-thread', new AbortController().signal, async () => {});
    await until(() => h.runtime.stats().running === 1); // wait for its raw-finally acknowledgement
    a.abort(); await left; assert.equal(rawSignal.aborted, true); assert.equal(h.runtime.stats().running, 1);
    releaseRaw(); await until(() => h.runtime.stats().running === 0); assert.equal(calls, 1);
    assert.equal(h.runtime.stats().historyReads, 0);
  } finally { releaseBlock(); releaseRaw(); a.abort(); b.abort(); h.dispose(); await h.runtime.whenDrained(); }
});

test('reset between queued grouping and SDK dispatch removes retired members without cancelling surviving progress', async () => {
  const h = setup(), scope = {}; let calls = 0, liveA = true, liveB = true, reply: Promise<void> | null = null, releaseReply!: () => void; const notices: string[] = [];
  const client: GalleryTimelinePort = { async timeline() { calls++; if (reply) await reply; return latestPage(); } };
  const a = h.runtime.readTimeline(latestInput(new AbortController().signal), client, { scope, current: () => liveA, dispatched() { notices.push('a'); } }).catch(() => null);
  const b = h.runtime.readTimeline(latestInput(new AbortController().signal), client, { scope, current: () => liveB, dispatched() { notices.push('b'); } }).catch(() => null);
  // pump/grouping runs first; this is before its deferred SDK call.
  queueMicrotask(() => { liveA = false; });
  try {
    const values = await Promise.all([a, b]); await until(() => h.runtime.stats().running === 0);
    assert.equal(values[0], null); assert.equal(values[1]?.state, 'ready'); assert.equal(calls, 1); assert.deepEqual(notices, ['b']);
    liveA = true; liveB = true; const before = calls;
    const c = h.runtime.readTimeline(latestInput(new AbortController().signal), client, { scope, current: () => liveA, dispatched() { notices.push('retired-a'); } }).catch(() => null);
    const d = h.runtime.readTimeline(latestInput(new AbortController().signal), client, { scope, current: () => liveB, dispatched() { notices.push('retired-b'); } }).catch(() => null);
    queueMicrotask(() => { liveA = false; liveB = false; });
    assert.deepEqual(await Promise.all([c, d]), [null, null]); await until(() => h.runtime.stats().running === 0);
    assert.equal(calls, before, 'all retired before SDK dispatch means zero raw requests'); assert.deepEqual(notices, ['b']);
    liveA = true; liveB = true; reply = new Promise<void>(done => { releaseReply = done; });
    const e = h.runtime.readTimeline(latestInput(new AbortController().signal), client, { scope, current: () => liveA }).catch(() => null);
    const f = h.runtime.readTimeline(latestInput(new AbortController().signal), client, { scope, current: () => liveB }).catch(() => null);
    await until(() => calls === before + 1); liveA = false; releaseReply();
    const late = await Promise.all([e, f]); assert.equal(late[0], null); assert.equal(late[1]?.state, 'ready');
    await until(() => h.runtime.stats().running === 0); assert.equal(calls, before + 1, 'late retired member receives no shared value; live peer still progresses');

  } finally { releaseReply?.(); h.dispose(); await h.runtime.whenDrained(); }
});

test('latest sharing excludes started calls, older cursors, reset watermarks and changed common scope; no completed cache', async () => {
  const h = setup(), scope = {}; let release!: () => void, calls = 0, current = true;
  const raw = new Promise<void>(done => { release = done; });
  const client: GalleryTimelinePort = { async timeline() { if (++calls === 1) await raw; return latestPage(); } };
  const first = h.runtime.readTimeline(latestInput(new AbortController().signal), client, { scope, current: () => true });
  await until(() => calls === 1);
  const later = h.runtime.readTimeline(latestInput(new AbortController().signal), client, { scope, current: () => true });
  try {
    release(); await Promise.all([first, later]); await until(() => h.runtime.stats().running === 0); assert.equal(calls, 2, 'already-dispatched records cannot join');
    await h.runtime.readTimeline(latestInput(new AbortController().signal), client, { scope, current: () => true });
    await until(() => h.runtime.stats().running === 0); assert.equal(calls, 3, 'completed response is never cached for joining');
    const cursor = () => ({ ...latestInput(new AbortController().signal), beforeAnchorId: 'actual-issued-cursor', beforeAnchorSeq: '100' });
    await Promise.all([h.runtime.readTimeline(cursor(), client, { scope, current: () => true }), h.runtime.readTimeline(cursor(), client, { scope, current: () => true })]);
    await until(() => h.runtime.stats().running === 0); assert.equal(calls, 5, 'even identical older cursor work stays independent');
    const heldController = new AbortController(); let unblock!: () => void;
    const held = h.runtime.readScope('cohort', heldController.signal, () => new Promise<void>(done => { unblock = done; }));
    await until(() => h.runtime.stats().running === 1);
    const obsolete = h.runtime.readTimeline(latestInput(new AbortController().signal), client, { scope, current: () => current });
    const fresh = h.runtime.readTimeline(latestInput(new AbortController().signal), client, { scope: {}, current: () => true });
    current = false; unblock(); await held; await Promise.all([obsolete, fresh]); await until(() => h.runtime.stats().running === 0);
    assert.equal(calls, 7, 'retired matching eligibility falls back to independent ordinary fresh reads, preserving progress');
  } finally { release(); h.dispose(); await h.runtime.whenDrained(); }
});

test('queued latest waiters each consume existing128 budget even when one raw dispatch serves them all', async () => {
  const h = setup(), scope = {}; let unblock!: () => void, release!: () => void, calls = 0;
  const held = h.runtime.readScope('cohort', new AbortController().signal, () => new Promise<void>(done => { unblock = done; }));
  await until(() => h.runtime.stats().running === 1);
  const client: GalleryTimelinePort = { async timeline() { calls++; await new Promise<void>(done => { release = done; }); return latestPage(); } };
  const waiters = Array.from({ length: 127 }, () => h.runtime.readTimeline(latestInput(new AbortController().signal), client, { scope, current: () => true }));
  try {
    assert.equal(h.runtime.stats().historyReads, 128);
    assert.equal((await h.runtime.readTimeline(latestInput(new AbortController().signal), client, { scope, current: () => true })).state, 'capacity');
    unblock(); await held; await until(() => calls === 1); assert.equal(h.runtime.stats().historyReads, 127); assert.equal(h.runtime.stats().running, 1);
    release(); const values = await Promise.all(waiters); assert.ok(values.every(value => value.state === 'ready'));
    await until(() => h.runtime.stats().running === 0); assert.equal(calls, 1); assert.equal(h.runtime.stats().historyReads, 0);
  } finally { unblock(); release?.(); h.dispose(); await h.runtime.whenDrained(); }
});

test('anchor reset callbacks include target additions, explicit invalidation, internal mismatch and adopted ownership', async () => {
  let marks = 0, replacementMarks = 0, page = 0;
  const client: GalleryTimelinePort = { async timeline() {
    page++; return { rows: [{ id: 'row', threadId: 'thread', turnId: 'turn', kind: 'turn', status: 'completed', sourceSeqStart: 1, sourceSeqEnd: 2 }],
      completedTurnDisplay: 'collapse', timelinePage: { historySnapshot: `snapshot-${page}`, olderCursor: page < 3 ? { anchorId: `issued-${page}`, anchorSeq: 0 } : null } };
  } };
  const reader = createGalleryAnchorReader(client, 'thread', () => { marks++; });
  await reader.read(['row'], new AbortController().signal, false, 1); assert.equal(marks, 1);
  await reader.read(['new-target'], new AbortController().signal, false, 1); assert.equal(marks, 2, 'target addition reset is observable');
  await assert.rejects(reader.read(['new-target'], new AbortController().signal, false, 1), /Timeline changed/); assert.equal(marks, 3);
  reader.invalidate(); assert.equal(marks, 4);
  await reader.read(['row'], new AbortController().signal); assert.equal(marks, 5);
  assert.equal(reader.adopt(['row'], client, () => { replacementMarks++; }), true); assert.equal(replacementMarks, 1);
  reader.invalidate(); assert.equal(marks, 5); assert.equal(replacementMarks, 2);
});


test('transient metadata has one shared yielded retry, then parks until genuine demand without caching empty success', async () => {
  const h = setup(1), list = h.sdk.plugins.list, rpc = h.sdk.plugins.callRpc;
  let metadata = 0, lists = 0, descriptions = 0, healthy = false;
  h.sdk.plugins.experimental_discoverRpc = async () => {
    metadata++; if (!healthy) throw Object.assign(Error('temporary metadata transport'), { status: 500 });
    return [{ pluginId: 'source-000', method: METHODS.describe }];
  };
  h.sdk.plugins.list = async input => { lists++; return list(input); };
  h.sdk.plugins.callRpc = async input => { if (input.method === METHODS.describe) descriptions++; return rpc(input); };
  const leases = [h.runtime.retain(anchor('same')), h.runtime.retain(anchor('same'))];
  try {
    await until(() => metadata === 2 && h.runtime.stats().running === 0);
    assert.equal(lists, 0); assert.equal(descriptions, 0); assert.equal(h.sourceCalls.length, 0);
    assert.equal(h.runtime.isReadyOwner('source-000'), false); assert.equal(leases[0]!.store.state.continued, true);
    assert.equal(h.reads.length, 1, 'metadata-only retries do not walk retained rows again');
    await tick(); await tick(); assert.equal(metadata, 2, 'persistent failure has no idle retry');
    healthy = true; leases[0]!.more();
    await until(() => h.runtime.isReadyOwner('source-000') && h.runtime.stats().running === 0);
    assert.equal(metadata, 3); assert.equal(descriptions, 1); assert.equal(h.sourceCalls.length, 1);
    const idle = metadata; await tick(); assert.equal(metadata, idle);
  } finally { for (const lease of leases) lease.dispose(); h.dispose(); }
});

test('permanent optional metadata refusal cannot fan out or retry without a new readiness generation', async () => {
  const h = setup(1), rpc = h.sdk.plugins.callRpc; let metadata = 0, descriptions = 0;
  h.sdk.plugins.experimental_discoverRpc = async () => { metadata++; throw Object.assign(Error('forbidden'), { status: 403 }); };
  h.sdk.plugins.callRpc = async input => { if (input.method === METHODS.describe) descriptions++; return rpc(input); };
  const lease = h.runtime.retain(anchor('refused'));
  try {
    await until(() => metadata === 1 && h.runtime.stats().running === 0); lease.more();
    await until(() => h.runtime.stats().running === 0 && h.runtime.stats().queued === 0);
    assert.equal(metadata, 1); assert.equal(descriptions, 0); assert.equal(h.sourceCalls.length, 0);
    assert.equal(h.runtime.readyOwners.state.size, 0);
    h.sdk.plugins.experimental_discoverRpc = async () => { metadata++; return [{ pluginId: 'source-000', method: METHODS.describe }]; };
    h.runtime.invalidate(undefined, true);
    await until(() => h.runtime.isReadyOwner('source-000') && h.runtime.stats().running === 0);
    assert.equal(metadata, 2); assert.equal(descriptions, 1);
  } finally { lease.dispose(); h.dispose(); }
});

test('legacy negative owner slices yield foreground FIFO through owner33 without multiplying retained reads', async () => {
  const h = setup(1), list = h.sdk.plugins.list, rpc = h.sdk.plugins.callRpc;
  const calls: string[] = [], noise = Array.from({ length: 32 }, (_, i) => `aaa-noise-${String(i).padStart(2, '0')}`);
  const controller = new AbortController(); let foreground: Promise<unknown> | undefined;
  h.sdk.plugins.list = async input => ({ plugins: [...noise.map(id => ({ id, enabled: true, status: 'running' })), ...(await list(input)).plugins] });
  h.sdk.plugins.callRpc = async input => {
    if (input.method === METHODS.describe) {
      calls.push(input.pluginId);
      if (input.pluginId === noise[0]) queueMicrotask(() => {
        foreground = h.runtime.readScope('same', controller.signal, async signal => {
          calls.push('foreground'); return h.runtime.backend.read('same', 'turn', signal);
        });
      });
      if (noise.includes(input.pluginId)) throw Object.assign(Error('not a participant'), { status: 404, body: { error: { code: 'unknown_method' } } });
    }
    return rpc(input);
  };
  const lease = h.runtime.retain(anchor('same'));
  try {
    await until(() => h.runtime.isReadyOwner('source-000') && h.runtime.stats().running === 0 && h.runtime.stats().queued === 0);
    await foreground;
    assert.equal(calls.filter(value => value !== 'foreground').length, 33);
    assert.equal(new Set(calls).size, 34); assert.deepEqual(calls.slice(0, 3), [noise[0], 'foreground', noise[1]]);
    assert.equal(h.sourceCalls.length, 1); assert.equal(h.reads.length, 3, 'one initial, one real foreground, one post-source retained read; none per negative Describe');
    console.log('LEGACY_FAIR_TOTAL', JSON.stringify({ descriptions: 33, retainedReads: h.reads.length, sourceUnits: h.sourceCalls.length, calls: calls.length }));
    const idle = calls.length; await tick(); await tick(); assert.equal(calls.length, idle);
  } finally { controller.abort(); lease.dispose(); h.dispose(); }
});


test('actual metadata timeout retains ignored raw ownership then yields fresh retry behind foreground history', async () => {
  const h = setup(1), rpc = h.sdk.plugins.callRpc;
  let metadata = 0, descriptions = 0, release!: () => void, bounded!: AbortSignal, rawSettled = false;
  const order: string[] = [], controller = new AbortController();
  h.sdk.plugins.experimental_discoverRpc = async input => {
    order.push('metadata'); metadata++;
    if (metadata === 1) { bounded = input!.signal!; await new Promise<void>(done => { release = done; }); rawSettled = true; }
    return [{ pluginId: 'source-000', method: METHODS.describe }];
  };
  h.sdk.plugins.callRpc = async input => { if (input.method === METHODS.describe) descriptions++; return rpc(input); };
  const lease = h.runtime.retain(anchor('same'));
  try {
    await until(() => !!bounded);
    const same = h.runtime.readScope('same', controller.signal, async () => { order.push('foreground'); });
    const other = await h.runtime.readScope('other', controller.signal, async () => 'other progress');
    assert.deepEqual(other, { state: 'ready', value: 'other progress' });
    await new Promise(done => setTimeout(done, 520));
    assert.equal(bounded.aborted, true); assert.equal(rawSettled, false);
    assert.equal(h.runtime.stats().running, 1); assert.equal(descriptions, 0); assert.equal(h.runtime.readyOwners.state.size, 0);
    assert.deepEqual(order, ['metadata']); release(); await same;
    await until(() => h.runtime.isReadyOwner('source-000') && h.runtime.stats().running === 0);
    assert.deepEqual(order, ['metadata', 'foreground', 'metadata']); assert.equal(descriptions, 1);
    assert.equal(h.sourceCalls.length, 1); assert.equal(h.runtime.stats().historyReads, 0);
    const idle = metadata; await tick(); assert.equal(metadata, idle);
  } finally { release?.(); controller.abort(); lease.dispose(); h.dispose(); }
});


test('fresh legacy continuation removal retires failed owner debt while the healthy suffix finishes and idle parks', async () => {
  const h = setup(2), list = h.sdk.plugins.list, rpc = h.sdk.plugins.callRpc;
  let lists = 0; const enumerated: string[] = [];
  h.sdk.plugins.list = async input => {
    const result = await list(input); return { plugins: ++lists === 1 ? result.plugins : result.plugins.filter(row => row.id !== 'source-000') };
  };
  h.sdk.plugins.callRpc = async input => {
    if (input.method === METHODS.enumerate) {
      enumerated.push(input.pluginId); if (input.pluginId === 'source-000') throw new ResultsCallError('source-error');
    }
    return rpc(input);
  };
  const lease = h.runtime.retain(anchor('removed-debt'));
  try {
    await until(() => h.runtime.isReadyOwner('source-001') && h.runtime.stats().running === 0 && h.runtime.stats().queued === 0);
    assert.deepEqual(enumerated, ['source-000', 'source-001']); assert.equal(h.runtime.isReadyOwner('source-000'), false);
    const idle = { lists, reads: h.reads.length }; await tick(); await tick(); assert.deepEqual({ lists, reads: h.reads.length }, idle);
  } finally { lease.dispose(); h.dispose(); }
});


test('metadata failure after readiness revocation parks failed-feed debt without inferring absent owners or spinning', async () => {
  const h = setup(2), rpc = h.sdk.plugins.callRpc;
  let revoked = false, metadata = 0, healthy = false; const enumerated: string[] = [];
  h.sdk.plugins.callRpc = async input => {
    if (input.method === METHODS.enumerate) {
      enumerated.push(input.pluginId);
      if (!revoked) {
        revoked = true;
        h.sdk.plugins.experimental_discoverRpc = async () => {
          metadata++; if (!healthy) throw Object.assign(Error('temporary metadata failure'), { status: 500 });
          return ['source-000', 'source-001'].map(pluginId => ({ pluginId, method: METHODS.describe }));
        };
        h.runtime.invalidateReadiness(); throw new ResultsCallError('source-error');
      }
    }
    return rpc(input);
  };
  const lease = h.runtime.retain(anchor('thread'));
  try {
    await until(() => metadata === 2 && h.runtime.stats().running === 0 && h.runtime.stats().queued === 0);
    assert.deepEqual(enumerated, ['source-000']); assert.equal(h.runtime.readyOwners.state.size, 0);
    assert.equal(lease.store.state.continued, true, 'failed metadata is pending work, not successful empty membership');
    const idle = h.reads.length; await tick(); await tick(); assert.equal(h.reads.length, idle); assert.equal(metadata, 2);
    healthy = true; lease.more();
    await until(() => h.runtime.readyOwners.state.size === 2 && h.runtime.stats().running === 0);
    assert.deepEqual(enumerated, ['source-000', 'source-000', 'source-001']); assert.equal(metadata, 3);
  } finally { lease.dispose(); h.dispose(); }
});


test('source helper timeout cannot overlap backend status writes; actual raw settlement owns thread credit through the original deadline', async () => {
  const h = setup(2), rpc = h.sdk.plugins.callRpc, control = new AbortController();
  let release!: () => void, bounded!: AbortSignal, slice!: AbortSignal, live = 0, peak = 0, rawSettled = false;
  let statusWrites = 0; const order: string[] = [];
  h.sdk.plugins.callRpc = async input => {
    if (input.method === GALLERY_METHODS.prepare && input.input && (input.input as { owner: string }).owner === 'source-000') slice = input.signal!;
    if (input.method === METHODS.enumerate && input.pluginId === 'source-000' && !rawSettled) {
      bounded = input.signal!; live++; peak = Math.max(peak, live); order.push('raw');
      try { await new Promise<void>(done => { release = done; }); rawSettled = true; return await rpc(input); }
      finally { live--; }
    }
    if (input.method === GALLERY_METHODS.apply) {
      if ((input.input as { supplier?: { connection: string } }).supplier?.connection === 'disconnected') statusWrites++;
      assert.equal(live, 0, 'backend transport must follow actual source transport settlement');
    }
    return rpc(input);
  };
  const lease = h.runtime.retain(anchor('same'));
  try {
    await until(() => !!release);
    const same = h.runtime.readScope('same', control.signal, async () => { order.push('same'); });
    const other = await h.runtime.readScope('other', control.signal, async () => { order.push('other'); });
    assert.equal(other.state, 'ready');
    await new Promise<void>(done => bounded.addEventListener('abort', () => done(), { once: true }));
    await tick(); assert.equal(rawSettled, false); assert.equal(statusWrites, 0); assert.deepEqual(order, ['raw', 'other']);
    assert.equal(h.runtime.stats().running, 1);
    await new Promise<void>(done => slice.aborted ? done() : slice.addEventListener('abort', () => done(), { once: true }));
    await tick(); assert.equal(statusWrites, 0); assert.equal(h.runtime.stats().running, 1);
    release(); await same; await until(() => h.runtime.stats().running === 0 && h.runtime.stats().queued === 0);
    assert.equal(peak, 1); assert.equal(statusWrites, 0, 'expired queued status dispatches zero, even after raw settlement');
    assert.deepEqual(order, ['raw', 'other', 'same']); assert.ok(h.sourceCalls.includes('source-001'), 'healthy suffix progresses after the safe yield');
    const idle = h.reads.length; await tick(); assert.equal(h.reads.length, idle);
  } finally { release?.(); control.abort(); lease.dispose(); h.dispose(); await h.runtime.whenDrained(); assert.equal(live, 0); assert.equal(h.runtime.stats().bytes, 0); }
});

test('held native selection cannot relabel or refill a successor full anchor; actual raw drain precedes fresh work', async () => {
  const h = setup(1, '', false, true), calls: string[] = [];
  let release!: () => void, count = 0, oldSignal!: AbortSignal;
  h.sdk.threads.events.list = async input => {
    count++; calls.push(`native-${count}`);
    if (count === 1) { oldSignal = input.signal; await new Promise<void>(done => { release = done; }); }
    return [];
  };
  const first = h.runtime.retain(anchor('same'));
  let successor: ReturnType<typeof h.runtime.retain> | undefined;
  try {
    await until(() => count === 1);
    successor = h.runtime.retain({ ...anchor('same'), rowId: 'successor-physical-row', historySnapshot: 'fresh-other-snapshot' });
    assert.equal(oldSignal.aborted, true); await tick(); assert.equal(count, 1); assert.equal(h.runtime.stats().running, 1);
    release(); await until(() => count === 2 && h.runtime.stats().running === 0 && h.runtime.stats().queued === 0);
    assert.deepEqual(calls, ['native-1', 'native-2']); assert.equal(successor.store.state.error, null);
    const idle = count; await tick(); assert.equal(count, idle);
  } finally { release?.(); first.dispose(); successor?.dispose(); h.dispose(); await h.runtime.whenDrained(); assert.equal(h.runtime.stats().bytes, 0); }
});

test('a completely unchanged non-enumerating owner yields without another retained collection or supplier freshness write', async () => {
  const h = setup(1, '', false, false, false), rpc = h.sdk.plugins.callRpc;
  let value: unknown, applies = 0;
  h.sdk.plugins.callRpc = async input => {
    if (input.method === GALLERY_METHODS.apply) {
      applies++; const next = (input.input as { stage: { value: unknown } }).stage.value;
      if (JSON.stringify(next) === JSON.stringify(value)) return input.outputSchema.parse({ state: 'unchanged' });
      value = structuredClone(next);
    }
    return rpc(input);
  };
  const lease = h.runtime.retain(anchor('unchanged'));
  try {
    await until(() => applies === 1 && h.runtime.stats().running === 0); assert.equal(h.reads.length, 2); assert.equal(h.sourceCalls.length, 0);
    lease.more(); await until(() => applies === 2 && h.runtime.stats().running === 0);
    assert.equal(h.reads.length, 3, 'new demanded retained read remains; semantic no-op causes no post-owner reread');
    const idle = applies; await tick(); await tick(); assert.equal(applies, idle);
  } finally { lease.dispose(); h.dispose(); }
});

test('optional selected-window memory yields to a larger valid complete foreground collection without evicting last-good facts', async () => {
  const h = setup(1, '', false, true), rpc = h.sdk.plugins.callRpc;
  const small = Array.from({ length: 8 }, (_, n) => prefixRow(n, 3500)), large = Array.from({ length: 40 }, (_, n) => prefixRow(n, 3500));
  let expanded = false, nativeCalls = 0, during = 0, sawWindow = false;
  h.sdk.threads.events.list = async () => { nativeCalls++; return Array.from({ length: 10 }, (_, n) => ({ id: `event-${n}`, threadId: 'prefix', seq: n + 1,
    createdAt: 1, scope: { kind: 'turn', turnId: 'turn' }, type: 'item/completed', data: { item: { id: `item-${n}`, type: 'toolCall', status: 'completed',
      error: null, tool: 'example', result: 'x'.repeat(9500) } } })); };
  h.sdk.plugins.callRpc = async input => {
    if (input.method === GALLERY_METHODS.read) {
      const after = (input.input as { after?: { key: string } }).after;
      const rows = expanded ? large : small, start = after ? rows.findIndex(row => row.key === after.key) + 1 : 0;
      if (expanded) { during++; sawWindow ||= h.runtime.stats().bytes > 150000; }
      const part = rows.slice(start, start + 8), last = part.at(-1)!;
      return input.outputSchema.parse(prefixRead(part, start + part.length < rows.length ? { seq: last.identity.ref.source.seq, key: last.key } : null));
    }
    const result = await rpc(input);
    if (input.method === GALLERY_METHODS.apply && (input.input as { stage?: { id: string } }).stage?.id === 'resolve:turn') expanded = true;
    return result;
  };
  const lease = h.runtime.retain(anchor('prefix'));
  try {
    try { await until(() => expanded && h.runtime.stats().running === 0 && h.runtime.stats().queued === 0); } catch (error) { console.log('SOURCE_MEMORY_STATE', { expanded, nativeCalls, during, stats: h.runtime.stats(), state: { ...lease.store.state, rows: lease.store.state.rows.length } }); throw error; }
    assert.ok(sawWindow); assert.equal(nativeCalls, 1); assert.equal(during, 5);
    assert.equal(lease.store.state.loaded, true); assert.equal(lease.store.state.rows.length, 40); assert.equal(lease.store.state.limited, false);
    assert.equal(lease.store.state.error, null);
    console.log('SOURCE_MEMORY_COMPLETE', { stats: h.runtime.stats(), canonical: canonicalByteLength(lease.store.state, GALLERY_RUNTIME_LIMITS.snapshotBytes), json: Buffer.byteLength(JSON.stringify(lease.store.state)) });
    assert.equal(h.runtime.stats().bytes, canonicalByteLength(lease.store.state, GALLERY_RUNTIME_LIMITS.snapshotBytes), 'optional window charge is shed; only complete facts remain');
    const idle = during; await tick(); await tick(); assert.equal(during, idle);
  } finally { lease.dispose(); h.dispose(); assert.equal(h.runtime.stats().bytes, 0); }
});

test('selected native reuse expires at its originating slice while queued owner work keeps its own fresh unit', async () => {
  const h = setup(2, '', false, true), rpc = h.sdk.plugins.callRpc, controller = new AbortController();
  let release!: () => void, held = false, nativeCalls = 0, queued: Promise<unknown> | undefined;
  h.sdk.threads.events.list = async () => { nativeCalls++; return []; };
  h.sdk.plugins.callRpc = async input => {
    const result = await rpc(input);
    if (!held && input.method === GALLERY_METHODS.apply && (input.input as { stage?: { id: string } }).stage?.id === 'native:turn') {
      held = true;
      queued = h.runtime.readScope('same', controller.signal, async () => { await new Promise<void>(done => { release = done; }); });
    }
    return result;
  };
  const lease = h.runtime.retain(anchor('same'));
  try {
    await until(() => !!release); assert.equal(nativeCalls, 1);
    await new Promise(done => setTimeout(done, GALLERY_RUNTIME_LIMITS.sliceMs + 5));
    assert.equal(nativeCalls, 1); assert.equal(h.runtime.stats().running, 1, 'held ordinary work owns the real lane');
    release(); await queued;
    await until(() => h.sourceCalls.length === 2 && h.runtime.stats().running === 0 && h.runtime.stats().queued === 0);
    assert.equal(nativeCalls, 2, 'the next owner cannot reuse selected data past the first unit deadline');
    assert.equal(lease.store.state.error, null); const idle = nativeCalls; await tick(); assert.equal(nativeCalls, idle);
  } finally { release?.(); controller.abort(); lease.dispose(); h.dispose(); await h.runtime.whenDrained(); }
});


test('actual preparation memory pressure refuses the owner truthfully without disconnecting it or evicting complete retained facts', async () => {
  const h = setup(1), rpc = h.sdk.plugins.callRpc, rows = Array.from({ length: 24 }, (_, n) => prefixRow(n, 3500));
  let applies = 0;
  h.sdk.plugins.callRpc = async input => {
    if (input.method === GALLERY_METHODS.read) {
      const after = (input.input as { after?: { key: string } }).after, start = after ? rows.findIndex(row => row.key === after.key) + 1 : 0;
      const part = rows.slice(start, start + 8), last = part.at(-1)!;
      return input.outputSchema.parse(prefixRead(part, start + part.length < rows.length ? { seq: last.identity.ref.source.seq, key: last.key } : null));
    }
    if (input.method === GALLERY_METHODS.prepare) return input.outputSchema.parse(Object.fromEntries(['resolve', 'invalidation', 'feed', 'native'].map(name => [name,
      { version: 1, value: { stage: 'feed', cursor: null, status: 'ready', debt: { bounded: 'x'.repeat(45000) } } }])));
    if (input.method === GALLERY_METHODS.apply) applies++;
    return rpc(input);
  };
  const lease = h.runtime.retain(anchor('prefix'));
  try {
    await until(() => h.runtime.stats().running === 0 && h.runtime.stats().queued === 0 && !!lease.store.state.error);
    assert.equal(lease.store.state.loaded, true); assert.equal(lease.store.state.rows.length, 24);
    assert.match(lease.store.state.error!, /source preparation capacity/); assert.equal(applies, 0); assert.equal(h.sourceCalls.length, 0);
    assert.equal(h.runtime.stats().bytes, canonicalByteLength(lease.store.state, GALLERY_RUNTIME_LIMITS.snapshotBytes));
    const reads = h.reads.length; await tick(); await tick(); assert.equal(h.reads.length, reads);
  } finally { lease.dispose(); h.dispose(); }
});

test('borrowed selected-window expiry yields one charged fresh selection after foreground and healthy suffix', async () => {
  const h = setup(3, '', false, true), rpc = h.sdk.plugins.callRpc;
  let clock = 1000, nativeCalls = 0, advanced = false, straddled = false, statusWrites = 0, bSignal!: AbortSignal;
  const recognized: string[] = [], order: string[] = [];
  const controller = new AbortController(); let foreground: Promise<unknown> | undefined;
  const monotonic = mock.method(performance, 'now', () => clock);
  h.sdk.threads.events.list = async () => { nativeCalls++; return [{ id: 'event-in-window', threadId: 'same', seq: 1, createdAt: 1, scope: { kind: 'turn', turnId: 'turn' }, type: 'item/completed', data: { item: { id: 'item-in-window', type: 'toolCall', status: 'completed', error: null, tool: 'example', result: 'bounded fixture result' } } }]; };
  h.sdk.plugins.callRpc = async input => {
    const page = input.input as { owner?: string; stage?: { id: string }; supplier?: { connection: string } };
    if (input.method === GALLERY_METHODS.prepare && page.owner === 'source-001' && !bSignal) bSignal = input.signal!;
    if (input.method === GALLERY_METHODS.apply && page.supplier?.connection === 'disconnected') statusWrites++;
    if (input.method === METHODS.recognize) {
      recognized.push(input.pluginId); order.push(input.pluginId);
      if (input.pluginId === 'source-001' && !straddled) {
        assert.equal(nativeCalls, 1, 'borrower used the live originating selection before expiry');
        assert.equal(bSignal.aborted, false);
        const value = await rpc(input);
        foreground = h.runtime.readScope('same', controller.signal, async () => { order.push('foreground'); });
        straddled = true; clock = 7010; // after old7000, before this owner's12900 deadline
        return value;
      }
    }
    const value = await rpc(input);
    if (!advanced && input.method === GALLERY_METHODS.apply && page.owner === 'source-000' && page.stage?.id === 'resolve:turn') {
      advanced = true; clock = 6900; // first owner succeeds; next unit starts near old expiry
    }
    return value;
  };
  const lease = h.runtime.retain(anchor('same'));
  try {
    await until(() => straddled && h.sourceCalls.includes('source-002') && h.runtime.stats().running === 0 && h.runtime.stats().queued === 0);
    await foreground;
    assert.deepEqual(recognized, ['source-000', 'source-001', 'source-002', 'source-001']);
    assert.deepEqual(order, ['source-000', 'source-001', 'foreground', 'source-002', 'source-001'], 'foreground and healthy suffix precede the recovery');
    assert.equal(nativeCalls, 3, 'one recovery uses a genuinely fresh selection rather than the healthy suffix cache');
    assert.equal(statusWrites, 0); assert.equal(bSignal.aborted, false);
    assert.equal(lease.store.state.continued, false); assert.equal(lease.store.state.error, null);
    const idle = { nativeCalls, recognized: recognized.length, reads: h.reads.length }; await tick(); await tick();
    assert.deepEqual({ nativeCalls, recognized: recognized.length, reads: h.reads.length }, idle);
    console.log('BORROWED_SELECTION_AUTOMATIC_RECOVERY', JSON.stringify({ nativeCalls, recognized, order, statusWrites, continued: lease.store.state.continued }));
    lease.more(); await until(() => h.runtime.stats().running === 0 && h.runtime.stats().queued === 0);
    assert.equal(nativeCalls, 3, 'committed recovery does not repeat recognition on ordinary demand');
    assert.equal(recognized.length, 4);
  } finally { controller.abort(); lease.dispose(); h.dispose(); await h.runtime.whenDrained(); monotonic.mock.restore(); assert.equal(h.runtime.stats().bytes, 0); }
});

test('borrowed expiry debt spends only the existing four credits and stays pending until genuinely demanded when exhausted', async () => {
  const h = setup(11, '', false, true), rpc = h.sdk.plugins.callRpc;
  let clock = 1000, nativeCalls = 0, statusWrites = 0;
  const straddled = new Set<string>(), recognized: string[] = [];
  const monotonic = mock.method(performance, 'now', () => clock);
  h.sdk.threads.events.list = async () => { nativeCalls++; return [{ id: 'event', threadId: 'same', seq: 1, createdAt: 1,
    scope: { kind: 'turn', turnId: 'turn' }, type: 'item/completed', data: { item: { id: 'item', type: 'toolCall', status: 'completed', tool: 'example', result: 'bounded' } } }]; };
  h.sdk.plugins.callRpc = async input => {
    const page = input.input as { owner?: string; stage?: { id: string }; supplier?: { connection: string } };
    if (input.method === GALLERY_METHODS.apply && page.supplier?.connection === 'disconnected') statusWrites++;
    const value = await rpc(input);
    if (input.method === METHODS.recognize) {
      recognized.push(input.pluginId); const n = Number(input.pluginId.slice(-3));
      if (n % 2 && !straddled.has(input.pluginId)) { straddled.add(input.pluginId); clock += 110; }
    }
    if (input.method === GALLERY_METHODS.apply && page.stage?.id === 'resolve:turn' && Number(page.owner!.slice(-3)) % 2 === 0) clock += 5900;
    return value;
  };
  const lease = h.runtime.retain(anchor('same'));
  try {
    await until(() => straddled.size === 5 && h.runtime.stats().running === 0 && h.runtime.stats().queued === 0);
    assert.equal(recognized.length, 11 + GALLERY_RUNTIME_LIMITS.automaticDebtUnits);
    for (const id of ['source-001', 'source-003', 'source-005', 'source-007']) assert.equal(recognized.filter(value => value === id).length, 2);
    assert.equal(recognized.filter(id => id === 'source-009').length, 1, 'exhausted debt cannot dispatch an uncounted fifth recovery');
    assert.equal(nativeCalls, 6 + GALLERY_RUNTIME_LIMITS.automaticDebtUnits); assert.equal(statusWrites, 0);
    assert.equal(lease.store.state.continued, true, 'remaining selected-window debt cannot report completion');
    const idle = { calls: recognized.length, nativeCalls, reads: h.reads.length }; await tick(); await tick();
    assert.deepEqual({ calls: recognized.length, nativeCalls, reads: h.reads.length }, idle);
    lease.more(); await until(() => recognized.filter(id => id === 'source-009').length === 2 && h.runtime.stats().running === 0 && h.runtime.stats().queued === 0);
    assert.equal(nativeCalls, 11); assert.equal(lease.store.state.continued, false); assert.equal(lease.store.state.error, null); assert.equal(statusWrites, 0);
  } finally { lease.dispose(); h.dispose(); await h.runtime.whenDrained(); monotonic.mock.restore(); assert.equal(h.runtime.stats().bytes, 0); }
});

test('local helper timeout notices expired borrow without a false disconnect or releasing ignored raw ownership', async () => {
  const h = setup(3, '', false, true), rpc = h.sdk.plugins.callRpc, controller = new AbortController();
  let clock = 1000, nativeCalls = 0, release!: () => void, rawSignal!: AbortSignal, held = false, statusWrites = 0, healthy = false;
  const recognized: string[] = [], order: string[] = [];
  const monotonic = mock.method(performance, 'now', () => clock);
  h.sdk.threads.events.list = async () => { nativeCalls++; return [{ id: 'event', threadId: 'same', seq: 1, createdAt: 1,
    scope: { kind: 'turn', turnId: 'turn' }, type: 'item/completed', data: { item: { id: 'item', type: 'toolCall', status: 'completed', tool: 'example', result: 'bounded' } } }]; };
  h.sdk.plugins.callRpc = async input => {
    const page = input.input as { owner?: string; stage?: { id: string }; supplier?: { connection: string } };
    if (input.method === GALLERY_METHODS.apply && page.supplier?.connection === 'disconnected') statusWrites++;
    if (input.method === METHODS.recognize) {
      recognized.push(input.pluginId); order.push(input.pluginId);
      if (input.pluginId === 'source-001' && !held) { held = true; rawSignal = input.signal!; clock = 7010;
        await new Promise<void>(done => { release = done; }); }
      else if (input.pluginId === 'source-001' && !healthy) throw new ResultsCallError('source-error');
    }
    const value = await rpc(input);
    if (input.method === GALLERY_METHODS.apply && page.owner === 'source-000' && page.stage?.id === 'resolve:turn') clock = 6900;
    return value;
  };
  const lease = h.runtime.retain(anchor('same'));
  try {
    await until(() => !!release);
    const same = h.runtime.readScope('same', controller.signal, async () => { order.push('foreground'); });
    const other = await h.runtime.readScope('other', controller.signal, async () => 'other-thread'); assert.equal(other.state, 'ready');
    await new Promise<void>(done => rawSignal.aborted ? done() : rawSignal.addEventListener('abort', () => done(), { once: true }));
    await tick(); assert.equal(h.runtime.stats().running, 1); assert.deepEqual(order, ['source-000', 'source-001']); assert.equal(statusWrites, 0);
    release(); await same; await until(() => h.runtime.stats().running === 0 && h.runtime.stats().queued === 0);
    assert.deepEqual(order, ['source-000', 'source-001', 'foreground', 'source-002', 'source-001']);
    assert.equal(nativeCalls, 3); assert.equal(statusWrites, 1, 'only the fresh retry genuinely failed at the supplier');
    assert.equal(lease.store.state.continued, true, 'failed fresh recovery is parked pending work');
    const idle = recognized.length; await tick(); await tick(); assert.equal(recognized.length, idle);
    healthy = true; lease.more();
    await until(() => recognized.filter(id => id === 'source-001').length === 3 && h.runtime.stats().running === 0 && h.runtime.stats().queued === 0);
    assert.equal(nativeCalls, 4); assert.equal(statusWrites, 1); assert.equal(lease.store.state.continued, false); assert.equal(lease.store.state.error, null);
  } finally { release?.(); controller.abort(); lease.dispose(); h.dispose(); await h.runtime.whenDrained(); monotonic.mock.restore(); assert.equal(h.runtime.stats().bytes, 0); }
});


test('lean history queue declines unknown or explicit undefined wire from latest cohorts without changing dispatch inputs', async () => {
  const h = setup(), scope = {}, calls: Record<string, unknown>[] = [];
  const client: GalleryTimelinePort = { async timeline(input) { calls.push(input); return latestPage(); } };
  try {
    for (const extra of [{ beforeAnchorId: undefined }, { beforeAnchorSeq: undefined }, { unknownWire: 'value' }]) {
      const input = () => ({ ...latestInput(new AbortController().signal), ...extra }) as unknown as Parameters<GalleryTimelinePort['timeline']>[0];
      const before = calls.length;
      await Promise.all([h.runtime.readTimeline(input(), client, { scope, current: () => true }), h.runtime.readTimeline(input(), client, { scope, current: () => true })]);
      await until(() => h.runtime.stats().running === 0);
      assert.equal(calls.length, before + 2, 'unsupported wire stays independent rather than gaining shared eligibility');
      for (const call of calls.slice(before)) for (const key of Object.keys(extra)) {
        assert.ok(Object.hasOwn(call, key)); assert.equal(call[key], extra[key as keyof typeof extra]);
      }
    }
    const before = calls.length;
    await Promise.all([h.runtime.readTimeline(latestInput(new AbortController().signal), client, { scope, current: () => true }),
      h.runtime.readTimeline(latestInput(new AbortController().signal), client, { scope, current: () => true })]);
    await until(() => h.runtime.stats().running === 0);
    assert.equal(calls.length, before + 1, 'exact known latest wire still shares one queued physical call');
    assert.equal(h.runtime.stats().historyReads, 0);
  } finally { h.dispose(); await h.runtime.whenDrained(); }
});


test('deferred runtime adopts the SAME early queue and cannot release ignored raw lanes or bypass queued Open', async () => {
  const h = setup(); h.runtime.dispose(); await h.runtime.whenDrained();
  const work = createGalleryWorkOwner(), early = new AbortController(), order: string[] = [];
  let release!: () => void, started = false, rawSettled = false;
  const raw = work.readScope('same', early.signal, async () => { started = true; await new Promise<void>(done => { release = done; }); rawSettled = true; }, false, false, false).catch(() => null);
  let runtime: ReturnType<typeof createGalleryRuntime> | null = null;
  try {
    await until(() => started); assert.equal(work.running, 1);
    runtime = createGalleryRuntime(h.sdk, work);
    const queued = runtime.readScope('same', new AbortController().signal, async () => { order.push('ordinary'); });
    const open = runtime.readScope('same', new AbortController().signal, async () => { order.push('Open'); }, true);
    early.abort(); await raw;
    assert.equal(rawSettled, false); assert.equal(runtime.stats().running, 1);
    await runtime.readScope('other', new AbortController().signal, async () => { assert.equal(work.running, 2); order.push('other'); });
    await until(() => work.running === 1);
    assert.deepEqual(order, ['other'], 'no same-thread replacement can bypass the already-issued raw call');
    release(); await Promise.all([queued, open]);
    await until(() => work.running === 0);
    assert.equal(rawSettled, true); assert.deepEqual(order, ['other', 'Open', 'ordinary']);
    assert.equal(runtime.stats().historyReads, 0); assert.equal(runtime.stats().queued, 0);
    runtime.dispose(); await runtime.whenDrained(); assert.equal(work.isActive(), false);
    await assert.rejects(work.readScope('after-dispose', new AbortController().signal, async () => assert.fail('retired owner must not dispatch')));
  } finally { release(); runtime?.dispose(); work.dispose(); await work.whenDrained(); h.dispose(); }
});
