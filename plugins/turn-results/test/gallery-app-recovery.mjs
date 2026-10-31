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
  if (url.endsWith('.tsx')) return { format: 'module', shortCircuit: true,
    source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } }).outputText };
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
async function fixture(status = 'pending', depth = 0) {
  const dom = new JSDOM('<body><section data-split-pane-id="left"><header><div data-thread-header-workflow-actions><div data-bb-plugin-root data-bb-plugin="turn-results" class="contents"><span role="group" data-fixture-header></span></div></div></header><section data-thread-window><div data-timeline-row-list="top-level"><div data-timeline-row-id="opaque-stable"><button>Native content</button></div></div></section></section></body>', { pretendToBeVisual: true });
  const saved = Object.fromEntries(['window','document','Element','HTMLElement','MutationObserver','ResizeObserver','IntersectionObserver','IS_REACT_ACT_ENVIRONMENT'].map(key => [key, globalThis[key]]));
  class Observer { constructor(callback) { this.callback = callback; this.targets = new Set(); } observe(target) { this.targets.add(target); } unobserve(target) { this.targets.delete(target); } disconnect() { this.targets.clear(); } }
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
    MutationObserver: dom.window.MutationObserver, ResizeObserver: Observer, IntersectionObserver: Observer, IS_REACT_ACT_ENVIRONMENT: true });
  const box = { top: 0, bottom: 600, left: 0, right: 800, width: 800, height: 600, x: 0, y: 0, toJSON() {} };
  document.body.getBoundingClientRect = () => box;
  document.querySelector('[data-thread-window]').getBoundingClientRect = () => box;
  const native = document.querySelector('[data-timeline-row-id]'); native.getBoundingClientRect = () => ({ ...box, height: 80, bottom: 80 });
  let rows = [publicRow(status)], snapshot = `snapshot-${status}`, hold = false, holdOlder = false, fail = false, maxOwned = 0;
  const calls = [], held = [], navigation = [], responses = [], cursors = new Map(); let issued = 0;
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
  const sdk = { threads: {
    async timeline(input) {
      const value = response(input); calls.push(input); maxOwned = Math.max(maxOwned, calls.filter(call => !call.signal.aborted && !call.finished).length);
      try { if (hold && (!holdOlder || input.beforeAnchorId)) return await new Promise(resolve => held.push(() => resolve(value))); if (fail) throw Error('Fixture timeline offline'); return value; }
      finally { input.finished = true; }
    }, events: { async list() { return []; } },
  }, plugins: { async list() { return { plugins: [] }; }, async callRpc(args) {
    if (args.method === GALLERY_METHODS.read) {
      const turn = args.input.turnId;
      return args.outputSchema.parse({ page: { rows: [retained(turn)], next: null }, coverage: { state: 'partial', intervals: [] } });
    }
    if (args.method === GALLERY_METHODS.pending) return args.outputSchema.parse({ rows: [], next: null });
    throw Error(`Unexpected fixture RPC ${args.method}`);
  } } };
  const app = await loadPluginApp(definition), controller = new AbortController();
  const script = app.contentScripts[0].mount({ signal: controller.signal });
  const bridge = app.threadHeaderActions[0];
  const rendered = renderSlot({ ...bridge, component: props => createPortal(createElement(bridge.component, props), document.querySelector('[data-fixture-header]')) }, { threadId: 'thread', projectId: 'project', isCompactViewport: false }, { sdk,
    openUrl(url) { navigation.push(url); return true; }, realtimeConnectionState: 'connected' });
  return { dom, native, rendered, app, sdk, calls, held, navigation, responses, depth(value) { depth = value; }, maxOwned: () => maxOwned,
    set(value, nextSnapshot = `snapshot-${JSON.stringify(value)}`) { rows = value; snapshot = nextSnapshot; },
    hold(value, olderOnly = false) { hold = value; holdOlder = olderOnly; }, fail(value) { fail = value; },
    mutate(text = 'Native changed') { native.querySelector('button').firstChild.data = text; },
    roots() { return [...document.querySelectorAll('[data-turn-results-gallery]')].filter(host => host.querySelector('.tr-gallery')); },
    notify() { return rendered.behavior.emitRealtime('results-changed', { threadId: 'thread' }); },
    async hidden(value) { Object.defineProperty(document, 'hidden', { configurable: true, value }); await act(async () => document.dispatchEvent(new dom.window.Event('visibilitychange'))); },
    async dispose() { await act(async () => rendered.unmount()); controller.abort(); if (typeof script === 'function') script();
      for (const release of held) release(); await settle(); Object.assign(globalThis, saved); dom.window.close(); },
  };
}

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
    const before = f.navigation.length; await act(async () => host.querySelector('.tr-caption button').click()); assert.equal(f.navigation.length, before, 'unvalidated boundary has no input authority');
    const recoveredAt = f.calls.length; f.fail(false); await f.notify(); await until(() => f.calls.length === recoveredAt + 1 && f.calls.every(call => call.finished));
    assert.equal(f.roots()[0], host);
    f.set([publicRow('pending', 15)]); await f.notify(); await until(() => f.roots().length === 0);
    assert.equal(host.style.minHeight, '240px'); assert.equal(host.querySelector('button'), null);
    f.set([publicRow('completed', 20, 'other-turn')]); await f.notify(); await until(() => f.roots().length === 1 && f.roots()[0].dataset.sourceTurn === 'other-turn');
    assert.equal(document.querySelectorAll('.tr-gallery').length, 1); assert.equal(document.querySelector('[data-result-key]').dataset.resultKey, 'retained-other-turn');
    f.set([publicRow('completed', 20, 'foreign', 'foreign-thread')]); await f.notify(); await until(() => f.roots().length === 0);
    assert.equal(document.querySelector('.tr-caption button'), null);
  } finally { await f.dispose(); }
});

test('hidden invalidation and removed row ignore late old refresh and do not publish stale roots', async () => {
  const f = await fixture('completed');
  try {
    await until(() => f.roots().length === 1);
    f.hold(true); await f.notify(); await until(() => f.held.length === 1);
    await f.hidden(true); f.set([publicRow('pending', 15)]); f.mutate('Pending while hidden'); await f.notify();
    const count = f.calls.length; await settle(200); assert.equal(f.calls.length, count);
    f.hold(false); await f.hidden(false); await until(() => f.roots().length === 0 && f.calls.length === count + 1);
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
    await act(async () => host.querySelector('.tr-caption button').click());
    await until(() => !host.textContent.includes('Checking')); assert.equal(f.navigation.length, navigation);
    const failedCalls = f.calls.length; await settle(200); assert.equal(f.calls.length, failedCalls);
    f.fail(false); f.depth(900); f.set([publicRow('completed', 15)], 'B'); await f.notify();
    await until(() => f.calls.length === failedCalls + 8 && f.calls.every(call => call.finished));
    assert.equal(f.roots()[0], host);
    const paneCursor = structuredClone(f.responses.at(-1).timelinePage.olderCursor); assert.ok(paneCursor);
    const beforeIntent = f.calls.length;
    await act(async () => host.querySelector('.tr-caption button').click()); assert.equal(f.navigation.length, navigation);
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
    await act(async () => host.querySelector('.tr-caption button').click()); assert.equal(f.navigation.length, navigation + 1);
    f.set([publicRow('pending', 10)], 'A-late'); f.hold(true, true); await f.notify(); await until(() => f.held.length === 1);
    assert.ok(f.calls.at(-1).beforeAnchorId, 'held A reply is an actual older snapshot-pinned continuation');
    await f.hidden(true); f.set([publicRow('completed', 30)], 'C-new'); f.hold(false); await f.hidden(false);
    await until(() => f.responses.at(-1).timelinePage.historySnapshot === 'C-new' && f.calls.at(-1).finished);
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
 const mark=f.calls.length;await act(async()=>host.querySelector('.tr-open-icon').click());await until(()=>f.navigation.length===1);
 assert.equal(f.calls.length-mark,7);assert.equal(f.calls[mark].beforeAnchorId,undefined);for(let i=mark+1;i<f.calls.length;i++)assert.equal(f.calls[i].beforeAnchorId,f.responses[i-1].timelinePage.olderCursor.anchorId);
 assert.equal(f.roots()[0],host);assert.equal(f.maxOwned(),1);await settle(200);assert.equal(f.calls.length,mark+7);assert.equal(f.navigation.length,1);
 }finally{await f.dispose();}
});
