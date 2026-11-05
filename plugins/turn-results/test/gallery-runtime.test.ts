import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { buildResolveOutput, METHODS } from '@phosphorco/bb-turn-results';
import { registerTurnResultsParticipant, ResultsCallError } from '@phosphorco/bb-turn-results/bb';
import type { RegistrationPort } from '@phosphorco/bb-turn-results/bb';
import { createGalleryRuntime, GALLERY_RUNTIME_LIMITS } from '../gallery/runtime.ts';
import { GALLERY_METHODS } from '../gallery/rpc.ts';
import type { GalleryAnchor } from '../gallery/anchors.ts';
import type { StageRecord, GalleryObservation } from '../gallery/index.ts';
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
    assert.equal(descriptions.length, 32); assert.equal(h.sourceCalls.length, 0, 'suspended proof cannot consume');
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
      await until(() => listCalls === 2 && h.runtime.stats().running === 0);
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
  let held = true, clock = performance.now();
  const monotonic = mock.method(performance, 'now', () => clock);
  h.sdk.plugins.callRpc = async args => {
    if (args.method === METHODS.describe) {
      const count = (counts.get(args.pluginId) ?? 0) + 1; counts.set(args.pluginId, count);
      perUnit.set(h.reads.length, (perUnit.get(h.reads.length) ?? 0) + 1);
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
  h.sdk.plugins.list = async args => { if (++lists === 2) throw transientDescribeError(); return list(args); };
  h.sdk.plugins.callRpc = async args => {
    if (args.method === METHODS.describe && args.pluginId === 'source-000' && ++descriptions === 1) throw transientDescribeError();
    return rpc(args);
  };
  const lease = h.runtime.retain(anchor('thread'));
  try {
    await until(() => lists === 2 && h.runtime.stats().running === 0);
    assert.equal(descriptions, 1); assert.equal(h.runtime.isReadyOwner('source-001'), true);
    assert.equal(h.runtime.isReadyOwner('source-000'), false);
    await tick(); await tick(); assert.equal(lists, 2);
    h.runtime.invalidate('thread');
    await until(() => h.runtime.isReadyOwner('source-000') && h.runtime.stats().running === 0);
    assert.equal(descriptions, 2); assert.equal(lists, 3);
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
      assert.equal(lists, 2, 'one bounded fresh membership admission for the retry');
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
      const result = await list(args); if (++lists === 1) return result;
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
      await until(() => lists === 2 && h.runtime.stats().running === 0);
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
      assert.deepEqual(calls, ['source-000', 'source-001'], kind); assert.equal(lists, 1);
    } finally { lease.dispose(); h.dispose(); }
  }
});

test('hidden or retired failed-feed membership read fences ignored late results and cannot Enumerate again', async () => {
  for (const retirement of ['hidden', 'dispose'] as const) {
    const h = setup(2), rpc = h.sdk.plugins.callRpc, list = h.sdk.plugins.list;
    let lists = 0, release!: () => void, held!: AbortSignal; const calls: string[] = [];
    h.sdk.plugins.list = async args => {
      if (++lists === 2) { held = args?.signal!; await new Promise<void>(resolve => { release = resolve; }); }
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
      assert.equal(held.aborted, true); await until(() => h.runtime.stats().running === 0);
      release(); await tick(); await tick();
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

for (const mode of ['unsupported', 'failure', 'malformed', 'overbound'] as const) test(`optional advertised membership ${mode} falls back to genuine bounded discovery`, async () => {
  const h = setup(1), original = h.sdk.plugins.callRpc; let described = 0;
  if (mode !== 'unsupported') h.sdk.plugins.experimental_discoverRpc = async () => {
    if (mode === 'failure') throw Error('Unsupported RPC discovery');
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
    await until(() => h.runtime.isReadyOwner('source-031') && h.runtime.stats().running === 0);
    assert.equal(described.length, 32); assert.equal(h.runtime.isReadyOwner('source-032'), false);
    assert.equal(h.sourceCalls.length, 0); assert.deepEqual(h.reads, [], 'readiness-only task never collects or consumes sources');
    for (const demand of demands) demand.warm('same');
    await tick(); await tick(); assert.equal(described.length, 32, 'no automatic continuation or idle retry from visible roots');
    await h.runtime.readScope('same', controller.signal, signal => h.runtime.discoverReady(signal));
    assert.equal(described.length, 33); assert.equal(h.runtime.isReadyOwner('source-032'), true, 'later genuine discovery demand uses the existing issued discovery cursor');
    disabled = true; h.runtime.invalidateReadiness();
    assert.equal(h.runtime.readyOwners.state.size, 0);
    for (const demand of demands) demand.warm('same');
    await until(() => h.runtime.readyOwners.state.size === 32 && h.runtime.stats().running === 0);
    assert.equal(described.length, 65); assert.equal(described.filter(id => id === 'source-000').length, 1);
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
    await until(() => h.runtime.readyOwners.state.size === 2 && h.runtime.stats().running === 0);
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
