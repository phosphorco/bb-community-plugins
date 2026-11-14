import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createPortal } from 'react-dom';
import { loadPluginApp, renderSlot } from '@get-bb/plugin-sdk/testing/app';
import { GALLERY_METHODS } from '../gallery/rpc.ts';
registerHooks({ load(url, context, next) {
  if (url.endsWith('.css')) return { format: 'module', shortCircuit: true, source: 'export default {}' };
  if (new URL(url).pathname.endsWith('.tsx')) {
    const parsed = new URL(url);
    let source = readFileSync(process.env.TURN_RESULTS_BASELINE_DIR && parsed.pathname.endsWith('/turn-results/app.tsx')
      ? `${process.env.TURN_RESULTS_BASELINE_DIR}/app.tsx` : parsed, 'utf8');
    if (parsed.search.startsWith('?startup-recovery-') && parsed.pathname.endsWith('/app.tsx')) {
      source = source.replaceAll("'./gallery/view.tsx'", "'./gallery/view.tsx" + parsed.search + "'")
        .replace('useSdk,', 'useSdk as originalUseSdk,')
        + '\nfunction useSdk() { const sdk = originalUseSdk(); return globalThis.__startupRecoveryProbe?.sdkOverride ?? sdk; }';
    }
    if (parsed.search.startsWith('?startup-recovery-') && parsed.pathname.endsWith('/view.tsx'))
      source = 'const startupProbe = globalThis.__startupRecoveryProbe; startupProbe.attempts++; await startupProbe.gate; startupProbe.evaluated = true;\n' + source;
    return { format: 'module', shortCircuit: true,
    source: ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } }).outputText };
  }
  return next(url, context);
} });
const definition = await import('../app.tsx');
const tick = ms => new Promise(resolve => setTimeout(resolve, ms));
async function settle(ms = 0) { await act(async () => { await tick(ms); }); }
async function until(condition) { for (let i = 0; i < 300; i++) { await settle(5); if (condition()) return; } assert.fail('App/Sentinel did not settle'); }
const publicRow = (status, end = 10, turnId = 'turn', threadId = 'thread') => ({
  id: 'opaque-stable', threadId, turnId, kind: 'turn', status, sourceSeqStart: 1, sourceSeqEnd: end,
});
function retained(turnId = 'turn') {
  const source = { threadId: 'thread', turnId, eventId: `event-${turnId}`, seq: 3, itemId: 'item', eventType: 'item/completed' };
  const identity = { version: 1, ref: { source, member: 'native-result', kind: 'example/result' },
    artifact: { provider: 'example', id: `artifact-${turnId}`, kind: 'image' }, specificity: 'typed',
    evidence: { basis: 'native-completion', sites: [], targetUrls: [], selectedDigest: 'a'.repeat(64) }, lookup: null };
  return { key: `retained-${turnId}`, owner: 'example', identity, unresolved: false, firstObservedOrder: 1, corrections: [],
    sourceExpired: null, retracted: null, freshness: 'stale', currentAvailability: null,
    resolution: { identity, proof: { kind: 'native-image', source, selectedDigest: 'a'.repeat(64) }, revision: { epoch: 'fixture', sequence: 1 },
      knowledge: 'confirmed', outcomeEvidence: { kind: 'observation', id: 'receipt', digest: 'b'.repeat(64), recordedAt: 1 },
      availability: { state: 'unknown', asOf: 1, expiresAt: null }, route: { kind: 'url', href: `https://fixture.invalid/${turnId}` },
      provenance: { originHost: { state: 'unknown', reason: 'not-recorded' }, artifactLocation: { state: 'unknown', reason: 'not-verified' } },
      fallback: { kind: 'card', title: `Saved ${turnId} result` }, spans: { width: 2, height: 1 } } };
}
async function fixture(status = 'pending', depth = 0, options = {}) {
  const dom = new JSDOM('<body><section data-split-pane-id="left"><header><div data-thread-header-workflow-actions><div data-bb-plugin-root data-bb-plugin="turn-results" class="contents"><span role="group" data-fixture-header></span></div></div></header><section data-thread-window><div data-timeline-row-list="top-level"><div data-timeline-row-id="opaque-stable"><button>Native content</button></div></div></section></section></body>',
    { pretendToBeVisual: true, ...(options.url ? { url: options.url } : {}) });
  const saved = Object.fromEntries(['window','document','Element','HTMLElement','MutationObserver','ResizeObserver','IntersectionObserver','IS_REACT_ACT_ENVIRONMENT'].map(key => [key, globalThis[key]]));
  class Observer { constructor(callback) { this.callback = callback; this.targets = new Set(); } observe(target) { this.targets.add(target); } unobserve(target) { this.targets.delete(target); } disconnect() { this.targets.clear(); } }
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
    MutationObserver: dom.window.MutationObserver, ResizeObserver: Observer, IntersectionObserver: Observer, IS_REACT_ACT_ENVIRONMENT: true });
  const box = { top: 0, bottom: 600, left: 0, right: 800, width: 800, height: 600, x: 0, y: 0, toJSON() {} };
  document.body.getBoundingClientRect = () => box;
  document.querySelector('[data-thread-window]').getBoundingClientRect = () => box;
  const native = document.querySelector('[data-timeline-row-id]'); native.getBoundingClientRect = () => ({ ...box, height: 80, bottom: 80 });
  // A genuine Header startup before a named native pane is available: the
  // Header route reader may run, while no Sentinel can acquire a pane mapping.
  if (options.headerOnly) document.querySelector('[data-thread-window]').removeAttribute('data-thread-window');
  if (options.nativeItems) {
    const items = document.createElement('div'); items.dataset.timelineItems = '';
    native.parentElement.append(items); items.append(native);
    native.insertAdjacentHTML('beforeend', '<a href="https://fixture.invalid/native">Native link</a>');
    document.querySelector('[data-thread-window]').insertAdjacentHTML('beforeend', '<aside data-fixture-native-chrome><div>Native status</div></aside>');
  }
  let rows = [publicRow(status)], snapshot = `snapshot-${status}`, hold = !!options.holdOlder, holdOlder = !!options.holdOlder, fail = false, maxOwned = 0;
  const calls = [], held = [], navigation = [], responses = [], cursors = new Map(), galleryReads = [], heldGalleryReads = []; let issued = 0;
  const subscriptions = new Set(), subscriptionCountsAtRead = [];
  const response = input => {
    const chain = input.beforeAnchorId ? cursors.get(input.beforeAnchorId) : {
      rows: structuredClone([...rows, ...Array.from({ length: depth }, (_, i) => ({ id: `newer-${i}`, threadId: 'thread',
        turnId: `newer-turn-${i}`, kind: 'turn', status: 'completed', sourceSeqStart: 100 + i * 4, sourceSeqEnd: 102 + i * 4 }))]),
      snapshot, end: rows.length + depth,
    };
    assert.ok(chain, 'fixture only accepts genuine issued opaque cursors');
    if (input.beforeAnchorId) assert.equal(input.beforeAnchorSeq, String(chain.seq));
    const selected = chain.rows.slice(Math.max(0, chain.end - 100), chain.end);
    let olderCursor = null;
    if (chain.end > 100) {
      olderCursor = { anchorId: `fixture-issued-${++issued}`, anchorSeq: selected[0].sourceSeqStart };
      cursors.set(olderCursor.anchorId, { ...chain, end: chain.end - 100, seq: olderCursor.anchorSeq });
    }
    // Even after set()/depth(), old cursors return the old captured rows/status.
    const value = { rows: structuredClone(selected), completedTurnDisplay: 'collapse', timelinePage: { historySnapshot: chain.snapshot, olderCursor } };
    responses.push(value); return value;
  };
  const sdk = { subscribe(input) {
    subscriptions.add(input);
    // The actual public SDK reports its last observed connection in a guarded
    // microtask; registration itself supplies no connected authority.
    if (input.event === 'realtime:connection') queueMicrotask(() => {
      if (subscriptions.has(input)) input.callback({ state: 'connected', reconnected: false, reconnectDelayMs: null });
    });
    return () => subscriptions.delete(input);
  }, threads: {
    async timeline(input) {
      subscriptionCountsAtRead.push(subscriptions.size);
      const value = response(input); calls.push(input); maxOwned = Math.max(maxOwned, calls.filter(call => !call.signal.aborted && !call.finished).length);
      try { if (hold && (!holdOlder || input.beforeAnchorId)) return await new Promise(resolve => held.push(() => resolve(value))); if (fail) throw Error('Fixture timeline offline'); return value; }
      finally { input.finished = true; }
    }, events: { async list() { return []; } },
  }, plugins: { async list() { return { plugins: [] }; }, async callRpc(args) {
    if (args.method === GALLERY_METHODS.read) {
      const turn = args.input.turnId;
      const value = args.outputSchema.parse({ page: { rows: [retained(turn)], next: null }, coverage: { state: 'partial', intervals: [] } });
      const read = { signal: args.signal, finished: false }; galleryReads.push(read);
      try { if (options.holdGalleryReads) await new Promise(resolve => heldGalleryReads.push(resolve)); return value; }
      finally { read.finished = true; }
    }
    if (args.method === GALLERY_METHODS.pending) return args.outputSchema.parse({ rows: [], next: null });
    throw Error(`Unexpected fixture RPC ${args.method}`);
  } } };
  const app = await loadPluginApp(await (options.definition ?? definition)), controller = new AbortController();
  const script = app.contentScripts[0].mount({ signal: controller.signal });
  const bridge = app.threadHeaderActions[0];
  const rendered = renderSlot({ ...bridge, component: props => createPortal(createElement(bridge.component, props), document.querySelector('[data-fixture-header]')) }, { threadId: 'thread', projectId: 'project', isCompactViewport: false }, { sdk,
    openUrl(url) { navigation.push(url); return true; }, realtimeConnectionState: 'connected' });
  return { dom, native, rendered, app, sdk, calls, held, galleryReads, heldGalleryReads, navigation, responses, subscriptions, subscriptionCountsAtRead,
    async replaceSdk() { globalThis.__startupRecoveryProbe.sdkOverride = Object.create(sdk); await act(async () => { rendered.lifecycle.rerender(createPortal(createElement(bridge.component, { threadId: 'thread', projectId: 'project', isCompactViewport: false }), document.querySelector('[data-fixture-header]'))); }); },
    changed(event, channel = 'thread:changed') { for (const subscription of [...subscriptions]) if (subscription.event === channel) subscription.callback(event); },
    depth(value) { depth = value; }, maxOwned: () => maxOwned,
    set(value, nextSnapshot = `snapshot-${JSON.stringify(value)}`) { rows = value; snapshot = nextSnapshot; },
    hold(value, olderOnly = false) { hold = value; holdOlder = olderOnly; }, fail(value) { fail = value; },
    mutate(text = 'Native changed') { native.querySelector('button').firstChild.data = text; },
    roots() { return [...document.querySelectorAll('[data-turn-results-gallery]')].filter(host => host.querySelector('.tr-gallery')); },
    notify() { return rendered.behavior.emitRealtime('results-changed', { threadId: 'thread' }); },
    async hidden(value) { Object.defineProperty(document, 'hidden', { configurable: true, value }); await act(async () => document.dispatchEvent(new dom.window.Event('visibilitychange'))); },
    async dispose() { await act(async () => rendered.unmount()); controller.abort(); if (typeof script === 'function') script();
      for (const release of held) release(); for (const release of heldGalleryReads) release(); await settle(); assert.equal(subscriptions.size, 0); Object.assign(globalThis, saved); dom.window.close(); },
  };
}

test('metadata-only thread notifications retain gallery proof, DOM and focus; mixed or ambiguous history still refreshes', async () => {
  const f = await fixture('completed');
  try {
    await until(() => f.roots()[0]?.querySelector('.tr-data-action'));
    await settle(200);
    const root = f.roots()[0], action = root.querySelector('.tr-data-action'), nativeButton = f.native.querySelector('button');
    nativeButton.focus(); const before = f.calls.length;
    for (const changes of [['title-changed'], ['read-state-changed'], ['pin-state-changed'], ['queue-changed'], ['title-changed', 'read-state-changed']]) {
      await act(async () => f.changed({ type: 'changed', entity: 'thread', id: 'thread', changes }));
    }
    await settle(200);
    assert.equal(f.calls.length, before, 'metadata-only SDK events do not retire Sentinel proof (default about:blank route)');
    assert.equal(f.roots()[0], root); assert.equal(root.querySelector('.tr-data-action'), action);
    assert.equal(document.activeElement, nativeButton); assert.deepEqual(f.navigation, []);
    for (const changes of [['title-changed', 'events-appended'], ['history-rewritten'], ['history-compacted'], ['status-changed'], ['future-unknown'], [], undefined]) {
      const count = f.calls.length;
      await act(async () => f.changed({ type: 'changed', entity: 'thread', id: 'thread', changes }));
      await until(() => f.calls.length > count && f.calls.at(-1).finished);
      await until(() => f.roots()[0]?.querySelector('.tr-data-action')); await settle(180);
    }
    assert.equal(f.roots()[0], root, 'fresh proof updates the retained root in place');
    assert.equal(document.activeElement, nativeButton); assert.deepEqual(f.navigation, []);
  } finally { await f.dispose(); }
});

test('metadata-only thread notifications preserve an active route-qualified Header job; history and reconnect revoke it', async () => {
  const f = await fixture('completed', 0, { url: 'https://fixture.invalid/projects/project/threads/thread', headerOnly: true, holdGalleryReads: true });
  try {
    await until(() => f.heldGalleryReads.length === 1);
    assert.equal(window.location.pathname, '/projects/project/threads/thread');
    assert.equal(document.querySelector('[data-turn-results-sentinel]'), null, 'this witness is Header work, not Sentinel activity');
    assert.equal(f.subscriptions.size, 3, 'the active Header owns its native event subscriptions');
    assert.ok(f.calls.length > 0 && f.calls.every(call => call.finished), 'Header completed real native boundary history');
    const first = f.galleryReads[0], before = f.calls.length;
    assert.equal(first.finished, false); assert.equal(first.signal.aborted, false, 'Header owns an active retained-read lease');
    for (const changes of [['title-changed'], ['read-state-changed'], ['pin-state-changed'], ['queue-changed'], ['title-changed', 'read-state-changed']])
      await act(async () => f.changed({ type: 'changed', entity: 'thread', id: 'thread', changes }));
    await settle(180);
    assert.equal(first.signal.aborted, false, 'metadata preserves the actual Header job and its retained read');
    assert.equal(f.calls.length, before); assert.equal(f.galleryReads.length, 1);

    await act(async () => f.changed({ type: 'changed', entity: 'thread', id: 'thread', changes: ['title-changed', 'history-rewritten'] }));
    assert.equal(first.signal.aborted, true, 'a mixed history notification revokes Header work');
    f.heldGalleryReads[0](); await until(() => first.finished); await settle(180);
    assert.equal(f.calls.length, before, 'history revocation does not pretend an old optional job is fresh');
    await act(async () => {
      f.changed({ state: 'connecting', reconnected: false, reconnectDelayMs: 0 }, 'realtime:connection');
      f.changed({ state: 'connected', reconnected: true, reconnectDelayMs: null }, 'realtime:connection');
    });
    await until(() => f.heldGalleryReads.length === 2);
    const second = f.galleryReads[1];
    assert.ok(f.calls.length > before, 'connected coverage starts fresh actual Header history');
    assert.equal(second.signal.aborted, false);
    const connected = f.calls.length;
    await act(async () => f.changed({ state: 'disconnected', reconnected: false, reconnectDelayMs: 1000 }, 'realtime:connection'));
    assert.equal(second.signal.aborted, true, 'coverage loss revokes the new Header job too');
    f.heldGalleryReads[1](); await until(() => second.finished);
    await act(async () => f.changed({ state: 'connected', reconnected: true, reconnectDelayMs: null }, 'realtime:connection'));
    await until(() => f.heldGalleryReads.length === 3);
    assert.ok(f.calls.length > connected); assert.equal(f.galleryReads[2].signal.aborted, false);
    assert.deepEqual(f.navigation, []);
  } finally { for (const release of f.heldGalleryReads) release(); await f.dispose(); }
});

for (const trigger of ['native-content', 'source-notification', 'reconnect', 'visibility']) test(`actual Sentinel recovers stable pending ID after ${trigger}`, async () => {
  const f = await fixture();
  try {
    await until(() => f.calls.length === 1 && f.calls[0].finished); assert.equal(f.roots().length, 0); assert.equal(document.querySelector('[data-turn-results-notice]'), null);
    f.set([publicRow('completed', 15)]);
    if (trigger === 'native-content') f.mutate();
    if (trigger === 'source-notification') await f.notify();
    if (trigger === 'reconnect') { await f.rendered.behavior.setRealtimeConnectionState('reconnecting'); await f.rendered.behavior.setRealtimeConnectionState('connected'); }
    if (trigger === 'visibility') { await f.hidden(true); f.mutate('Completed while hidden'); await settle(200); assert.equal(f.calls.length, 1); await f.hidden(false); }
    await until(() => f.roots().length === 1 && f.roots()[0].querySelector('[data-result-key]'));
    assert.equal(f.roots()[0].dataset.sourceRow, 'opaque-stable'); assert.equal(f.roots()[0].dataset.sourceTurn, 'turn');
    assert.equal(f.calls.length, 2); await settle(200); assert.equal(f.calls.length, 2, 'owned render and settled idle start no history reads');
  } finally { await f.dispose(); }
});

test('body-only hydration keeps one running fresh issued chain while semantic and structural changes retire it', async () => {
  const f = await fixture('completed', 150, { nativeItems: true, holdOlder: true });
  const latest = () => f.calls.filter(call => !call.beforeAnchorId).length;
  try {
    await until(() => f.held.length === 1);
    const initialOlder = f.calls.at(-1), issued = f.responses[0].timelinePage.olderCursor;
    assert.equal(initialOlder.beforeAnchorId, issued.anchorId); assert.equal(f.roots().length, 0);
    await act(async () => {
      const link = f.native.querySelector('a'); link.replaceWith(link.cloneNode(true));
      const button = document.createElement('button'); button.textContent = 'Native hydrated action'; f.native.append(button);
      // The real batch also contains proved nonstructural outside-row chrome.
      const chrome = document.querySelector('[data-fixture-native-chrome]');
      chrome.firstChild.replaceWith(document.createElement('div'));
      await tick();
    });
    await settle(180);
    assert.equal(f.calls.length, 2); assert.equal(f.roots().length, 0); assert.equal(f.navigation.length, 0);
    f.hold(false); f.held[0]();
    await until(() => f.roots()[0]?.querySelector('.tr-data-action'));
    console.log('BODY_HYDRATION_CHAIN', JSON.stringify({ latest: latest(), calls: f.calls.map(call => ({ before: call.beforeAnchorId ?? null, finished: call.finished })),
      subscribedBeforeRead: f.subscriptionCountsAtRead, sameIssuedOlder: f.calls[1] === initialOlder, maxOwned: f.maxOwned() }));
    assert.equal(latest(), 1, 'pure body hydration must not discard the already-running genuine fresh chain');
    assert.equal(f.calls.length, 2); assert.ok(f.subscriptionCountsAtRead.every(count => count === 3));
    await act(async () => f.roots()[0].querySelector('.tr-data-action').click());
    assert.deepEqual(f.navigation, ['https://fixture.invalid/turn']);

    // Current-thread semantic events are hard regardless of unchanged sequence
    // or opaque snapshot; no old captured completed response may restore input.
    f.hold(true, true);
    await act(async () => f.changed({ type: 'changed', entity: 'thread', id: 'thread', changes: ['events-appended'], metadata: { timelineSequence: 10 } }));
    await until(() => f.held.length === 2);
    const old = f.calls.at(-1), mark = latest();
    f.set([publicRow('pending')], 'snapshot-completed');
    await act(async () => {
      f.changed({ type: 'changed', entity: 'thread', id: 'thread', changes: ['events-appended'], metadata: { timelineSequence: 10 } });
      f.changed({ type: 'changed', entity: 'thread', id: 'thread', changes: ['history-rewritten'] });
    });
    f.hold(false); f.held[1]();
    await until(() => latest() === mark + 1 && f.calls.at(-1).finished && f.roots().length === 0);
    assert.equal(old.finished, true); assert.deepEqual(f.navigation, ['https://fixture.invalid/turn']);

    f.set([publicRow('completed')], 'snapshot-next'); f.hold(true, true);
    await act(async () => f.changed({ type: 'changed', entity: 'thread', id: 'thread', changes: ['status-changed'] }));
    await until(() => f.held.length === 3);
    const structuralMark = latest(), parent = f.native.parentElement;
    await act(async () => { f.native.remove(); parent.append(f.native); await tick(); });
    f.set([publicRow('pending')], 'snapshot-next');
    f.hold(false); f.held[2]();
    await until(() => latest() === structuralMark + 1 && f.calls.at(-1).finished && f.roots().length === 0);
    // Surface policy can change outside thread-detail events. Its public
    // config signal also retires an equal-token completed response.
    f.set([publicRow('completed')], 'surface-snapshot'); f.hold(true, true);
    await act(async () => f.changed({ type: 'changed', entity: 'thread', id: 'thread', changes: ['status-changed'] }));
    await until(() => f.held.length === 4);
    const surfaceMark = latest(); f.set([publicRow('pending')], 'surface-snapshot');
    await act(async () => f.changed({ type: 'changed', entity: 'system', id: 'config', changes: ['provider-policy'] }, 'system:config-changed'));
    f.hold(false); f.held[3]();
    await until(() => latest() === surfaceMark + 1 && f.calls.at(-1).finished && f.roots().length === 0);
    assert.equal(f.maxOwned(), 1);
    const idle = f.calls.length; await settle(200); assert.equal(f.calls.length, idle);
  } finally { await f.dispose(); }
});

for (const transport of ['plugin', 'SDK core']) test(`BH1 live ${transport} disconnect keeps later hydration hard until connected coverage`, async () => {
  const f = await fixture('completed', 150, { nativeItems: true, holdOlder: true });
  const latest = () => f.calls.filter(call => !call.beforeAnchorId).length;
  try {
    await until(() => f.held.length === 1);
    if (transport === 'plugin') await act(async () => f.rendered.behavior.setRealtimeConnectionState('disconnected'));
    else await act(async () => f.changed({ state: 'disconnected', reconnected: false, reconnectDelayMs: 1000 }, 'realtime:connection'));
    // SDK-core-only loss deliberately leaves the independent plugin hook at
    // its actual initial connected state. Registration remains installed.
    await settle(180); f.held[0](); await until(() => f.held.length === 2);
    const mark = latest(); f.set([publicRow('pending')], 'snapshot-completed');
    await act(async () => {
      const link = f.native.querySelector('a'); link.replaceWith(link.cloneNode(true));
      f.native.append(document.createElement('button'));
      document.querySelector('[data-fixture-native-chrome]').firstChild.replaceWith(document.createElement('div'));
      await tick();
    });
    await settle(180); f.hold(false); f.held[1]();
    await until(() => latest() === mark + 1 && f.calls.at(-1).finished && f.roots().length === 0);
    assert.deepEqual(f.navigation, []); assert.equal(f.maxOwned(), 1);
    // Actual recovery still needs a fresh latest after both channels regain
    // coverage; it cannot reinstate the captured older completed response.
    f.set([publicRow('completed')], 'fresh-connected');
    if (transport === 'plugin') await act(async () => f.rendered.behavior.setRealtimeConnectionState('connected'));
    else await act(async () => f.changed({ state: 'connected', reconnected: true, reconnectDelayMs: null }, 'realtime:connection'));
    await until(() => f.roots()[0]?.querySelector('.tr-data-action'));
    assert.equal(f.responses.at(-1).timelinePage.historySnapshot, 'fresh-connected');
    await act(async () => f.roots()[0].querySelector('.tr-data-action').click());
    assert.deepEqual(f.navigation, ['https://fixture.invalid/turn']);
    const count = f.calls.length; await settle(180); assert.equal(f.calls.length, count);
  } finally { await f.dispose(); }
});

test('native mutation bursts during held read queue one fresh demand; pending token bursts settle before completion read', async () => {
  const f = await fixture();
  try {
    await until(() => f.calls.length === 1 && f.calls[0].finished);
    f.hold(true); await f.notify(); await until(() => f.held.length === 1);
    for (let burst = 0; burst < 3; burst++) { for (let token = 0; token < 50; token++) f.mutate(`Pending token ${burst}:${token}`); await settle(20); }
    await settle(200); assert.equal(f.calls.length, 2, 'held read owns the only active refresh despite token hints');
    f.hold(false); f.held[0](); await until(() => f.calls.length === 3 && f.calls[2].finished); assert.equal(f.roots().length, 0);
    for (let burst = 0; burst < 4; burst++) { f.mutate(`Streaming ${burst}`); await settle(20); }
    f.set([publicRow('completed', 15)]); f.mutate('Completed');
    await until(() => f.roots().length === 1 && f.calls.length === 4);
    assert.equal(f.maxOwned(), 1); await settle(200); assert.equal(f.calls.length, 4);
  } finally { await f.dispose(); }
});

test('same-ID changed range keeps root; unchanged failure recovers; pending/foreign/reused boundaries revoke old controls', async () => {
  const f = await fixture('completed');
  try {
    await until(() => f.roots().length === 1 && f.roots()[0].querySelector('[data-result-key]'));
    const host = f.roots()[0]; host.getBoundingClientRect = () => ({ top: 0, bottom: 240, left: 0, right: 800, width: 800, height: 240, x: 0, y: 0, toJSON() {} });
    f.set([publicRow('completed', 15)]); await f.notify(); await until(() => f.calls.length === 2 && host.querySelector('[data-result-key]'));
    assert.equal(f.roots()[0], host);
    const failedAt = f.calls.length; f.fail(true); await f.notify(); await until(() => f.calls.length === failedAt + 1 && f.calls.every(call => call.finished));
    assert.equal(f.roots()[0], host, 'network failure retains last-good visual/layout');
    const failures = f.calls.length; await settle(200); assert.equal(f.calls.length, failures, 'unchanged failure does not retry itself');
    const before = f.navigation.length; await act(async () => host.querySelector('button.tr-data-action').click()); assert.equal(f.navigation.length, before, 'unvalidated boundary has no input authority');
    const recoveredAt = f.calls.length; f.fail(false); await f.notify(); await until(() => f.calls.length === recoveredAt + 1 && f.calls.every(call => call.finished));
    assert.equal(f.roots()[0], host);
    f.set([publicRow('pending', 15)]); await f.notify(); await until(() => f.roots().length === 0);
    assert.equal(host.style.minHeight, '240px'); assert.equal(host.querySelector('button'), null);
    f.set([publicRow('completed', 20, 'other-turn')]); await f.notify(); await until(() => f.roots().length === 1 && f.roots()[0].dataset.sourceTurn === 'other-turn');
    assert.equal(document.querySelectorAll('.tr-gallery').length, 1); assert.equal(document.querySelector('[data-result-key]').dataset.resultKey, 'retained-other-turn');
    f.set([publicRow('completed', 20, 'foreign', 'foreign-thread')]); await f.notify(); await until(() => f.roots().length === 0);
    assert.equal(document.querySelector('button.tr-data-action'), null);
  } finally { await f.dispose(); }
});

test('hidden invalidation and removed row ignore late old refresh and do not publish stale roots', async () => {
  const f = await fixture('completed');
  try {
    await until(() => f.roots().length === 1);
    f.hold(true); await f.notify(); await until(() => f.held.length === 1);
    await f.hidden(true); f.set([publicRow('pending', 15)]); f.mutate('Pending while hidden'); await f.notify();
    const count = f.calls.length; await settle(200); assert.equal(f.calls.length, count);
    const retired = f.calls.at(-1); assert.equal(retired.signal.aborted, true); assert.equal(retired.finished, undefined);
    f.hold(false); await f.hidden(false); await settle();
    assert.equal(f.calls.length, count, 'abort-ignoring old history retains the actual thread lane');
    // The fixture's raw promise ignores AbortSignal. A local abort is not a
    // transport settlement receipt; fresh proof must wait for this release.
    f.held[0](); await until(() => f.roots().length === 0 && f.calls.length === count + 1 && f.calls.at(-1).finished);
    assert.equal(retired.finished, true); assert.notEqual(f.calls.at(-1), retired);
    assert.equal(f.responses.at(-1).rows[0].status, 'pending'); assert.equal(f.maxOwned(), 1);
    f.held[0](); await settle(200); assert.equal(f.roots().length, 0);
    f.set([publicRow('completed', 20)]); await f.notify(); await until(() => f.roots().length === 1);
    f.native.remove(); f.set([]); await settle(200); assert.equal(document.querySelector('.tr-gallery'), null);
  } finally { await f.dispose(); }
});

test('same opaque ID on a replacement native element cannot inherit old controls or a held old refresh', async () => {
  const f = await fixture('completed');
  try {
    await until(() => f.roots().length === 1 && f.roots()[0].querySelector('[data-result-key]'));
    const oldHost = f.roots()[0]; f.hold(true); await f.notify(); await until(() => f.held.length === 1);
    const replacement = f.native.cloneNode(true);
    for (const owned of replacement.querySelectorAll('[data-turn-results-gallery]')) owned.remove(); // Native replaces its own subtree only.
    replacement.getBoundingClientRect = f.native.getBoundingClientRect;
    f.native.replaceWith(replacement); f.set([publicRow('completed', 40, 'replacement-turn')]);
    await settle(200); assert.equal(oldHost.isConnected, false); assert.equal(document.querySelector('.tr-gallery'), null);
    f.hold(false); f.held[0]();
    await until(() => f.roots().length === 1 && f.roots()[0].dataset.sourceTurn === 'replacement-turn' && f.roots()[0].querySelector('[data-result-key]'));
    assert.ok(replacement.contains(f.roots()[0])); assert.equal(document.querySelectorAll('.tr-gallery').length, 1);
    assert.equal(document.querySelector('[data-result-key]').dataset.resultKey, 'retained-replacement-turn');
  } finally { await f.dispose(); }
});

test('actual historical same-thread split Sentinels keep independent pinned public chains and hosts', async () => {
  const f = await fixture('completed', 150); let rightSlot;
  try {
    await until(() => f.roots().length === 1 && f.roots()[0].querySelector('[data-result-key]'));
    const rect = document.body.getBoundingClientRect;
    const left = document.querySelector('[data-thread-window]');
    const right = document.createElement('section'); right.dataset.threadWindow = ''; right.getBoundingClientRect = rect;
    const list = document.createElement('div'); list.dataset.timelineRowList = 'top-level';
    const row = f.native.cloneNode(true); for (const owned of row.querySelectorAll('[data-turn-results-gallery]')) owned.remove();
    row.getBoundingClientRect = f.native.getBoundingClientRect; list.append(row); right.append(list); document.body.append(right);
    let rightCalls = 0;
    const sdk = { ...f.sdk, threads: { ...f.sdk.threads, async timeline(input) {
      rightCalls++;
      if (input.beforeAnchorId) { assert.equal(input.beforeAnchorId, 'right-issued'); assert.equal(input.beforeAnchorSeq, '100'); }
      return { rows: input.beforeAnchorId ? [publicRow('completed')] : [{ id: 'right-newer', threadId: 'thread', turnId: 'right-newer-turn',
        kind: 'turn', status: 'completed', sourceSeqStart: 100, sourceSeqEnd: 102 }], completedTurnDisplay: 'collapse',
        timelinePage: { historySnapshot: 'right-proof', olderCursor: input.beforeAnchorId ? null : { anchorId: 'right-issued', anchorSeq: 100 } } };
    } } };
    const Sentinel = f.app.threadHeaderActions[0].component;
    const frame = document.createElement('section'); frame.dataset.splitPaneId = 'right';
    const group = document.createElement('span'); group.setAttribute('role', 'group'); frame.append(group, right); document.body.append(frame);
    // Test-only host placement; production galleries remain their real createRoot path.
    rightSlot = renderSlot({ component: () => createPortal(createElement(Sentinel, { threadId: 'thread', projectId: 'project', isCompactViewport: false }), group) }, {},
      { sdk, composer: { scope: { kind: 'thread', threadId: 'thread' } }, realtimeConnectionState: 'connected' });
    await until(() => !!right.querySelector('.tr-gallery'));
    const rightHost = right.querySelector('[data-turn-results-gallery]'); const before = rightCalls;
    f.set([publicRow('completed', 30, 'left-new-turn')]); f.mutate('Left pane completed a different boundary');
    await until(() => left.querySelector('[data-source-turn="left-new-turn"] .tr-gallery'));
    assert.equal(right.querySelector('[data-turn-results-gallery]'), rightHost); assert.equal(rightHost.dataset.sourceTurn, 'turn');
    assert.equal(rightCalls, before, 'left native mutation cannot invalidate another pane reader');
    await rightSlot.behavior.emitRealtime('results-changed', { threadId: 'thread' });
    await until(() => rightCalls === before + 2);
    assert.equal(left.querySelector('[data-turn-results-gallery]').dataset.sourceTurn, 'left-new-turn');
    assert.equal(rightHost.dataset.sourceTurn, 'turn'); assert.equal(left.querySelectorAll('.tr-gallery').length, 1); assert.equal(right.querySelectorAll('.tr-gallery').length, 1);
  } finally { if (rightSlot) await act(async () => rightSlot.unmount()); await f.dispose(); }
});

for (const trigger of ['native-content', 'source-notification', 'reconnect', 'visibility']) test(`historical pending status obtains fresh pinned snapshot chain after ${trigger}`, async () => {
  const f = await fixture('pending', 150);
  try {
    await until(() => f.calls.length === 2 && f.calls.every(call => call.finished));
    assert.equal(f.roots().length, 0); const oldSnapshot = f.responses[1].timelinePage.historySnapshot;
    f.set([publicRow('completed', 15)], 'snapshot-B');
    if (trigger === 'native-content') f.mutate('Historical turn completed');
    if (trigger === 'source-notification') await f.notify();
    if (trigger === 'reconnect') { await f.rendered.behavior.setRealtimeConnectionState('reconnecting'); await f.rendered.behavior.setRealtimeConnectionState('connected'); }
    if (trigger === 'visibility') { await f.hidden(true); f.mutate('Completed while hidden'); await f.notify(); await settle(200); assert.equal(f.calls.length, 2); await f.hidden(false); }
    await until(() => f.roots().length === 1 && f.roots()[0].querySelector('[data-result-key]'));
    assert.equal(f.calls.length, 4); assert.equal(f.calls[2].beforeAnchorId, undefined);
    assert.equal(f.calls.filter(call => !call.beforeAnchorId).length, 2);
    assert.equal(f.responses[1].timelinePage.historySnapshot, oldSnapshot);
    assert.equal(f.responses[1].rows.find(row => row.id === 'opaque-stable').status, 'pending');
    assert.equal(f.responses[3].timelinePage.historySnapshot, 'snapshot-B');
    assert.equal(f.responses[3].rows.find(row => row.id === 'opaque-stable').status, 'completed');
    await settle(200); assert.equal(f.calls.length, 4);
  } finally { await f.dispose(); }
});

test('history beyond800 remains bounded and quiet until genuine fresh public demand can prove the target', async () => {
  const f = await fixture('pending', 900);
  try {
    await until(() => f.calls.length === 8 && f.calls.every(call => call.finished));
    await settle(200); assert.equal(f.calls.length, 8); assert.equal(f.roots().length, 0);
    assert.equal(f.native.querySelector('[data-turn-results-notice]'), null);
    assert.equal(f.native.querySelector('.tr-gallery'), null);
    f.set([publicRow('completed', 15)], 'fresh-history-B'); await f.notify();
    await until(() => f.calls.length === 16 && f.calls.every(call => call.finished));
    assert.equal(f.calls[8].beforeAnchorId, undefined); assert.equal(f.roots().length, 0);
    assert.equal([...f.native.querySelectorAll('button')].some(b => /Continue|Show more|Previous|Next/.test(b.textContent)), false);
    await settle(220); assert.equal(f.calls.length, 16, 'one demand cannot start an all-history walk');
    f.depth(150); f.set([publicRow('completed', 20)], 'fresh-reachable-C'); await f.notify();
    await until(() => f.calls.length === 18 && f.roots().length === 1);
    assert.equal(f.calls[16].beforeAnchorId, undefined); assert.equal(f.responses.at(-1).timelinePage.historySnapshot, 'fresh-reachable-C');
    await settle(200); assert.equal(f.calls.length, 18);
  } finally { await f.dispose(); }
});

test('failed refresh retains last-good host without global status; bounded Open and genuine fresh proof retain late-response fences', async () => {
  const f = await fixture('completed', 150);
  try {
    await until(() => f.roots().length === 1 && f.roots()[0].querySelector('[data-result-key]'));
    const host = f.roots()[0], failedAt = f.calls.length; f.fail(true); await f.notify();
    await until(() => f.calls.length === failedAt + 1 && f.calls.every(call => call.finished));
    assert.equal(f.roots()[0], host); assert.equal(f.native.querySelector('[data-turn-results-notice]'), null);
    const navigation = f.navigation.length;
    await act(async () => host.querySelector('button.tr-data-action').click());
    await until(() => !host.textContent.includes('Checking')); assert.equal(f.navigation.length, navigation);
    const failedCalls = f.calls.length; await settle(200); assert.equal(f.calls.length, failedCalls);
    f.fail(false); f.depth(900); f.set([publicRow('completed', 15)], 'B'); await f.notify();
    await until(() => f.calls.length === failedCalls + 8 && f.calls.every(call => call.finished));
    assert.equal(f.roots()[0], host);
    const paneCursor = structuredClone(f.responses.at(-1).timelinePage.olderCursor); assert.ok(paneCursor);
    const beforeIntent = f.calls.length;
    await act(async () => host.querySelector('button.tr-data-action').click()); assert.equal(f.navigation.length, navigation);
    await until(() => f.calls.length === beforeIntent + 8 && f.calls.every(call => call.finished)
      && !host.textContent.includes('Checking') && host.textContent.includes('Results read capacity reached'));
    assert.equal(f.navigation.length, navigation); assert.equal(f.calls[beforeIntent].beforeAnchorId, undefined);
    for (let offset = 1; offset < 8; offset++) {
      const issued = f.responses[beforeIntent + offset - 1].timelinePage.olderCursor; assert.ok(issued);
      assert.equal(f.calls[beforeIntent + offset].beforeAnchorId, issued.anchorId);
      assert.equal(f.calls[beforeIntent + offset].beforeAnchorSeq, String(issued.anchorSeq));
    }
    assert.notEqual(f.responses.at(-1).timelinePage.olderCursor.anchorId, paneCursor.anchorId);
    const afterIntent = f.calls.length; await settle(200); assert.equal(f.calls.length, afterIntent, 'one Open spends only its bounded fresh slice');
    assert.equal(f.roots()[0], host);
    f.depth(150); f.set([publicRow('completed', 20)], 'B-reachable'); await f.notify();
    await until(() => f.calls.length === afterIntent + 2 && f.calls.every(call => call.finished));
    assert.equal(f.calls[afterIntent].beforeAnchorId, undefined, 'new public demand begins a genuine fresh chain');
    assert.equal(f.roots()[0], host);
    await act(async () => host.querySelector('button.tr-data-action').click()); assert.equal(f.navigation.length, navigation + 1);
    f.set([publicRow('pending', 10)], 'A-late'); f.hold(true, true); await f.notify(); await until(() => f.held.length === 1);
    assert.ok(f.calls.at(-1).beforeAnchorId, 'held A reply is an actual older snapshot-pinned continuation');
    const retired = f.calls.at(-1), heldCount = f.calls.length;
    await f.hidden(true); f.set([publicRow('completed', 30)], 'C-new'); f.hold(false); await f.hidden(false);
    await settle(); assert.equal(retired.signal.aborted, true); assert.equal(retired.finished, undefined);
    assert.equal(f.calls.length, heldCount, 'fresh C cannot overlap the still-pending raw A continuation');
    assert.equal(f.roots()[0], host);
    f.held[0](); // Settle actual old transport before admitting the fresh chain.
    await until(() => f.responses.at(-1).timelinePage.historySnapshot === 'C-new' && f.calls.at(-1).finished);
    assert.equal(retired.finished, true); assert.equal(f.calls.length, heldCount + 2);
    assert.equal(f.calls[heldCount].beforeAnchorId, undefined, 'C begins at fresh latest, not the retired A cursor');
    assert.equal(f.calls[heldCount + 1].beforeAnchorId, f.responses[heldCount].timelinePage.olderCursor.anchorId);
    assert.equal(f.roots()[0], host);
    const count = f.calls.length; f.held[0](); await settle(200);
    assert.equal(f.calls.length, count); assert.equal(f.roots()[0], host);
    assert.equal(f.responses.at(-1).timelinePage.historySnapshot, 'C-new'); assert.equal(f.maxOwned(), 1);
  } finally { await f.dispose(); }
});
test('successor: visible old target receives one finite second issued slice without controls', async () => {
 const f=await fixture('completed',650);
 try { await until(()=>f.roots().length===1);assert.equal(f.calls.length,7);assert.equal(f.calls.filter(c=>!c.beforeAnchorId).length,1);assert.equal(f.maxOwned(),1);for(let i=1;i<7;i++){const cursor=f.responses[i-1].timelinePage.olderCursor;assert.equal(f.calls[i].beforeAnchorId,cursor.anchorId);assert.equal(f.calls[i].beforeAnchorSeq,String(cursor.anchorSeq));}await settle(200);assert.equal(f.calls.length,7); }
 finally{console.log('SUCCESSOR_BEFORE_COUNTS',JSON.stringify({calls:f.calls.length,roots:f.roots().length,cursors:f.calls.map(c=>c.beforeAnchorId??null)}));await f.dispose();}
});

test('old visible target single Open obtains a NEW seven-page chain within the original eight-read action budget', async () => {
 const f=await fixture('completed',650);
 try{await until(()=>f.roots().length===1);const host=f.roots()[0];const initial=f.calls.length;assert.equal(initial,7);
 f.fail(true);await f.notify();await until(()=>f.calls.length===initial+1&&f.calls.at(-1).finished);f.fail(false);
 const mark=f.calls.length;await act(async()=>host.querySelector('button.tr-data-action').click());await until(()=>f.navigation.length===1);
 assert.equal(f.calls.length-mark,7);assert.equal(f.calls[mark].beforeAnchorId,undefined);for(let i=mark+1;i<f.calls.length;i++)assert.equal(f.calls[i].beforeAnchorId,f.responses[i-1].timelinePage.olderCursor.anchorId);
 assert.equal(f.roots()[0],host);assert.equal(f.maxOwned(),1);await settle(200);assert.equal(f.calls.length,mark+7);assert.equal(f.navigation.length,1);
 }finally{await f.dispose();}
});


test('startup module failure is contained without idle import retries; a genuine new frontend generation recovers', async () => {
  let failLoad;
  const failed = globalThis.__startupRecoveryProbe = { attempts: 0, evaluated: false, gate: new Promise((_, reject) => { failLoad = reject; }) };
  let f;
  try {
    f = await fixture('completed', 0, { definition: import('../app.tsx?startup-recovery-failed-generation') });
    await until(() => failed.attempts === 1 && f.calls.length > 0);
    await act(async () => { failLoad(Error('Actual held implementation failed to evaluate')); await tick(); });
    await until(() => document.querySelector('[data-turn-results-notice]')?.textContent.includes('could not load'));
    assert.equal(f.roots().length, 0); assert.deepEqual(f.navigation, []);
    const reads = f.calls.length; await settle(200); assert.equal(f.calls.length, reads); assert.equal(failed.attempts, 1);
    await act(async () => f.changed({ type: 'changed', entity: 'thread', id: 'thread', changes: ['events-appended'] }));
    await until(() => f.calls.length > reads && f.calls.at(-1).finished);
    assert.equal(failed.attempts, 1, 'a new proof demand does not loop failed ESM imports');
    assert.ok(document.querySelector('[data-turn-results-notice]'), 'restart alone cannot clear the actual load failure');
    await f.dispose(); f = null;
    // A new actual frontend-module generation, as after reload/update; no
    // production cache-busting or fabricated module value supplies recovery.
    const fresh = globalThis.__startupRecoveryProbe = { attempts: 0, evaluated: false, gate: Promise.resolve() };
    f = await fixture('completed', 0, { definition: import('../app.tsx?startup-recovery-new-generation') });
    await until(() => f.roots()[0]?.querySelector('.tr-data-action'));
    assert.equal(fresh.attempts, 1); assert.equal(fresh.evaluated, true);
    assert.equal(document.querySelector('[data-turn-results-notice]'), null);
    await act(async () => f.roots()[0].querySelector('.tr-data-action').click());
    assert.deepEqual(f.navigation, ['https://fixture.invalid/turn']);
  } finally { failLoad?.(Error('cleanup')); if (f) await f.dispose(); delete globalThis.__startupRecoveryProbe; }
});

for (const retirement of ['hide', 'semantic', 'SDK']) test(`startup late implementation cannot attach retired ${retirement} proof`, async () => {
  let release;
  const probe = globalThis.__startupRecoveryProbe = { attempts: 0, evaluated: false, gate: new Promise(resolve => { release = resolve; }) };
  let f;
  try {
    f = await fixture('completed', 0, { definition: import(`../app.tsx?startup-recovery-late-${retirement}`) });
    await until(() => probe.attempts === 1 && f.calls.length > 0 && f.calls.at(-1).finished);
    const initial = f.calls.length;
    f.set([publicRow('pending')], 'successor-pending');
    if (retirement === 'hide') await f.hidden(true);
    else if (retirement === 'semantic') await act(async () => f.changed({ type: 'changed', entity: 'thread', id: 'thread', changes: ['history-rewritten'] }));
    else await f.replaceSdk();
    release(); await until(() => probe.evaluated); await settle(200);
    assert.equal(f.roots().length, 0, 'old completed history must not gain placement when its code arrives late');
    assert.deepEqual(f.navigation, []);
    if (retirement === 'hide') assert.equal(f.calls.length, initial, 'hidden generation dispatches no fresh work');
    else assert.ok(f.calls.length > initial, 'successor proof comes from an actual fresh public request');
    f.set([publicRow('completed', 15)], 'genuinely-current');
    if (retirement === 'hide') await f.hidden(false);
    else await act(async () => f.changed({ type: 'changed', entity: 'thread', id: 'thread', changes: ['events-appended'] }));
    await until(() => f.roots()[0]?.querySelector('.tr-data-action'));
    assert.equal(f.responses.at(-1).timelinePage.historySnapshot, 'genuinely-current');
    assert.equal(probe.attempts, 1);
    await act(async () => f.roots()[0].querySelector('.tr-data-action').click());
    assert.deepEqual(f.navigation, ['https://fixture.invalid/turn']);
  } finally { release(); if (f) await f.dispose(); delete globalThis.__startupRecoveryProbe; }
});
