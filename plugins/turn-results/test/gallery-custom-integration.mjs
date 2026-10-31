import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { getEventListeners } from 'node:events';
import ts from 'typescript';
import { JSDOM } from 'jsdom';
import { act, createElement as h, useEffect, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { loadPluginApp, renderSlot } from '@get-bb/plugin-sdk/testing/app';
import { registerPresentation } from '@phosphorco/bb-context-recognition/presentation';
import { registerTurnResultsParticipant } from '@phosphorco/bb-turn-results/bb';
import { buildResolveOutput } from '@phosphorco/bb-turn-results';
import { GALLERY_METHODS } from '../gallery/rpc.ts';
import { createGalleryRuntime } from '../gallery/runtime.ts';
import { mountGalleryPane } from '../gallery/pane.ts';
registerHooks({ load(url, context, next) {
  if (url.endsWith('.css')) return { format: 'module', shortCircuit: true, source: 'export default {}' };
  if (url.endsWith('.tsx')) return { format: 'module', shortCircuit: true,
    source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } }).outputText };
  return next(url, context);
} });
const definition = await import('../app.tsx');
const { ResultCard } = await import('../gallery/view.tsx');
const tick = ms => new Promise(resolve => setTimeout(resolve, ms));
async function settle(ms = 0) { await act(async () => { await tick(ms); }); }
async function until(condition) { for (let i = 0; i < 400; i++) { await settle(5); if (condition()) return; } assert.fail('Custom integration did not settle'); }
const owner = 'custom-fixture', schema = 'custom-fixture/card@1';
function record(i) {
  const source = { threadId: 'thread', turnId: `turn-${i}`, eventId: `event-${i}`, seq: i * 10 + 3, itemId: `item-${i}`, eventType: 'item/completed' };
  const identity = { version: 1, ref: { source, member: 'native-result', kind: 'example/result' },
    artifact: { provider: 'different-artifact-provider', id: `artifact-${i}`, kind: 'referent' }, specificity: 'typed',
    evidence: { basis: 'native-completion', sites: [], targetUrls: [], selectedDigest: 'a'.repeat(64) }, lookup: null };
  return { key: `row-${i}`, owner, identity, unresolved: false, firstObservedOrder: i, corrections: [], sourceExpired: null, retracted: null,
    freshness: 'stale', currentAvailability: null, resolution: { identity, proof: { kind: 'native-image', source, selectedDigest: 'a'.repeat(64) },
      revision: { epoch: 'fixture', sequence: 1 }, knowledge: 'confirmed', outcomeEvidence: { kind: 'observation', id: 'receipt', digest: 'b'.repeat(64), recordedAt: 1 },
      availability: { state: 'unknown', asOf: 1, expiresAt: null }, route: { kind: 'url', href: `https://fixture.invalid/${i}` },
      provenance: { originHost: { state: 'unknown', reason: 'not-recorded' }, artifactLocation: { state: 'unknown', reason: 'not-verified' } },
      fallback: { kind: 'card', title: `Saved result ${i}` }, spans: { width: 2, height: 2 }, presentation: { schema, data: { label: `Referent ${i}` } } } };
}
async function fixture(count = 6, mount = true, contribution = {}) {
  const registeredOwner = contribution.owner ?? owner, registeredSchema = contribution.schema ?? schema;
  const kind = contribution.kind ?? 'example/result', namespace = kind.split('/')[0];
  const dom = new JSDOM(`<body data-thread-window><div data-timeline-row-list="top-level">${Array.from({ length: count }, (_, i) => `<div data-timeline-row-id="opaque-${i}"><button>Native ${i}</button></div>`).join('')}</div></body>`, { pretendToBeVisual: true });
  const keys = ['window','document','Element','HTMLElement','MutationObserver','ResizeObserver','IntersectionObserver','IS_REACT_ACT_ENVIRONMENT'];
  const saved = Object.fromEntries(keys.map(key => [key, globalThis[key]]));
  const changes = new Map(), eventPrototype = EventTarget.prototype, addEvent = eventPrototype.addEventListener, removeEvent = eventPrototype.removeEventListener;
  let subscriptions = 0, subscriptionPeak = 0;
  eventPrototype.addEventListener = function(type, listener, options) {
    if (type === 'change' && listener) {
      const listeners = changes.get(this) ?? new Set();
      if (!listeners.has(listener)) { listeners.add(listener); changes.set(this, listeners); subscriptions++; subscriptionPeak = Math.max(subscriptionPeak, subscriptions); }
    }
    return addEvent.call(this, type, listener, options);
  };
  eventPrototype.removeEventListener = function(type, listener, options) {
    if (type === 'change' && changes.get(this)?.delete(listener)) { subscriptions--; if (!changes.get(this).size) changes.delete(this); }
    return removeEvent.call(this, type, listener, options);
  };
  class Observer { constructor(callback) { this.callback = callback; } observe() {} unobserve() {} disconnect() {} }
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
    MutationObserver: dom.window.MutationObserver, ResizeObserver: Observer, IntersectionObserver: Observer, IS_REACT_ACT_ENVIRONMENT: true });
  const box = { top: 0, bottom: 600, left: 0, right: 800, width: 800, height: 600, x: 0, y: 0, toJSON() {} };
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () { return this.hasAttribute('data-thread-window') ? box : { ...box, width: 400, right: 400, height: 216, bottom: 216 }; };
  let rows = Array.from({ length: count }, (_, i) => record(i)), enabled = true, listCalls = 0, rpc = 0, live = 0, peak = 0, setups = 0, cleanups = 0, full = 0, fullPeak = 0;
  const captured = [], navigation = [], registrations = [], nativeCalls = [], handlers = new Map();
  const bb = { rpc: { register(_contract, value) { for (const [method, handler] of Object.entries(value)) handlers.set(method, handler); } } };
  registerTurnResultsParticipant(bb, { pluginId: registeredOwner, capabilities: { revision: 'supplier-r1', supplier: {
    recognize: false, resolve: true, enumerate: false, kinds: [{ kind, namespace, neutralLabel: 'Result', confirmedLabel: 'Created', specificity: 'typed', memberVersion: 'v1', equivalenceNamespaces: [] }] } },
    resolve(input) { return buildResolveOutput(input, input.items.map(() => ({ state: 'unavailable', reason: 'not used' }))); } });
  const sdk = { threads: { async timeline(input) {
    nativeCalls.push(input); return { rows: rows.map((row, i) => ({ id: `opaque-${i}`, threadId: 'thread', turnId: row.identity.ref.source.turnId,
      kind: 'turn', status: 'completed', sourceSeqStart: i * 10 + 1, sourceSeqEnd: i * 10 + 5 })), completedTurnDisplay: 'collapse', timelinePage: { historySnapshot: 'public-snapshot', olderCursor: null } };
  }, events: { async list() { throw Error('No native event read is allowed in this fixture'); } } }, plugins: {
    async list() { listCalls++; return { plugins: [{ id: registeredOwner, enabled, status: enabled ? 'running' : 'disabled' }] }; },
    async callRpc(args) {
      let value;
      if (args.pluginId === 'turn-results') {
        if (args.method === GALLERY_METHODS.read) value = { page: { rows: rows.filter(row => !args.input.turnId || row.identity.ref.source.turnId === args.input.turnId).slice(0, 8), next: null }, coverage: { state: 'partial', intervals: [] } };
        else if (args.method === GALLERY_METHODS.pending) value = { rows: [], next: null };
        else if (args.method === GALLERY_METHODS.stage) value = null;
        else if (args.method === GALLERY_METHODS.known) value = [];
        else value = { state: 'committed' };
      } else if (handlers.has(args.method)) value = await handlers.get(args.method)(args.input, { experimental_caller: { kind: 'client' } });
      else { rpc++; throw Error('Presentation owner RPC is forbidden'); }
      return args.outputSchema.parse(value);
    },
  } };
  function View(props) {
    captured.push(props);
    useEffect(() => { live++; setups++; peak = Math.max(peak, live); if (props.mode === 'full') { full++; fullPeak = Math.max(fullPeak, full); }
      return () => { live--; cleanups++; if (props.mode === 'full') full--; }; }, []);
    return h('button', { 'data-supplier': props.identity.id, 'data-mode': props.mode, onClick: () => props.navigate.openUrl('https://fixture.invalid/referent') }, props.data.label ?? `${props.data.repository}#${props.data.pullNumber}`);
  }
  let generation = 0;
  function register(load = async () => View, methods = []) {
    const controller = new AbortController();
    const dispose = registerPresentation({ pluginId: registeredOwner, generation: ++generation, signal: controller.signal }, { schema: registeredSchema, methods, decode: value => value, load });
    registrations.push(dispose); return dispose;
  }
  register();
  const app = await loadPluginApp(definition), controller = new AbortController();
  let script = await app.contentScripts[0].mount({ pluginId: 'turn-results', generation: 1, signal: controller.signal });
  const renderBanner = () => renderSlot(app.composerCustomizations[0].banners[0], {}, { sdk, composer: { scope: { kind: 'thread', threadId: 'thread' } },
    openUrl(url) { navigation.push(url); return true; }, realtimeConnectionState: 'connected' });
  let rendered = null; if (mount) act(() => { rendered = renderBanner(); }); const slots = [];
  return { dom, sdk, app, controller, captured, navigation, nativeCalls, register, renderer: View,
    stats: () => ({ listCalls, rpc, live, peak, setups, cleanups, full, fullPeak, subscriptions, subscriptionPeak }),
    rows: () => rows, setRows(value) { rows = value; }, enabled(value) { enabled = value; },
    notify: () => act(async () => { await rendered.behavior.emitRealtime('results-changed', { threadId: 'thread' }); await tick(); }),
    async hidden(value) { Object.defineProperty(document, 'hidden', { configurable: true, value }); await act(async () => document.dispatchEvent(new dom.window.Event('visibilitychange'))); },
    panel() { let slot; act(() => { slot = renderSlot(app.threadPanelActions[0], { threadId: 'thread' }, { sdk, composer: { scope: { kind: 'thread', threadId: 'thread' } }, openUrl(url) { navigation.push(url); return true; } }); }); slots.push(slot); return slot; },
    async replaceGeneration() {
      const previous = script; const nextController = new AbortController();
      let next; act(() => { next = app.contentScripts[0].mount({ pluginId: 'turn-results', generation: 2, signal: nextController.signal });
        let finished = false; Promise.resolve(next).then(() => { finished = true; });
        assert.equal(finished, false); const old = captured.at(-1); old?.navigate.openUrl('https://fixture.invalid/stale'); });
      await act(async () => { script = await next; rendered.unmount(); await tick(); });
      act(() => { rendered = renderBanner(); }); return { previous, nextController };
    },
    async replaceLatest() {
      const skipped = new AbortController(), latest = new AbortController(); let first, next;
      act(() => { first = app.contentScripts[0].mount({ pluginId: 'turn-results', generation: 2, signal: skipped.signal });
        next = app.contentScripts[0].mount({ pluginId: 'turn-results', generation: 3, signal: latest.signal }); });
      await act(async () => { assert.equal(await first, undefined); script = await next; rendered.unmount(); await tick(); });
      act(() => { rendered = renderBanner(); }); return { skipped, latest };
    },
    async dispose() {
      let drained; act(() => { for (const slot of slots) slot.unmount(); rendered?.unmount(); if (typeof script === 'function') drained = script(); });
      await act(async () => { await drained; await tick(); });
      await act(async () => { controller.abort(); for (const dispose of registrations.reverse()) dispose(); await tick(); });
      await settle();
      eventPrototype.addEventListener = addEvent; eventPrototype.removeEventListener = removeEvent;
      const counters = { live, peak, setups, cleanups, full, fullPeak, rpc, subscriptions, subscriptionPeak };
      Object.assign(globalThis, saved); dom.window.close();
      console.log('CUSTOM_HOST_COUNTERS', JSON.stringify(counters));
      assert.equal(live, 0); assert.equal(setups, cleanups); assert.equal(subscriptions, 0); assert.ok(subscriptionPeak <= 132);
    },
  };
}

test('actual app readiness/realm/revision/retry fences, four resources, panel and quiet idle', async () => {
  const f = await fixture();
  try {
    await until(() => f.stats().live === 4 && document.querySelectorAll('[data-result-key]').length === 6);
    assert.equal(f.stats().rpc, 0); assert.equal(f.stats().peak, 4);
    const first = f.captured.at(-1); assert.equal(first.identity.provider, 'different-artifact-provider'); assert.equal(first.owner.pluginId, owner);
    assert.ok(first.size.maxWidth > 0 && first.size.maxWidth <= 400); assert.ok(first.size.maxHeight > 0 && first.size.maxHeight <= 216);
    const native = f.nativeCalls.length, lists = f.stats().listCalls; await settle(200);
    assert.equal(f.nativeCalls.length, native); assert.equal(f.stats().listCalls, lists);
    f.enabled(false); await f.notify(); await until(() => f.stats().live === 0);
    const navigations = f.navigation.length; first.navigate.openUrl('https://fixture.invalid/stale'); first.requestFull(); first.refresh();
    assert.equal(f.navigation.length, navigations); assert.equal(document.querySelector('dialog'), null);
    f.enabled(true); await f.notify(); await until(() => f.stats().live === 4);
    const old = f.captured.at(-1); await act(async () => { f.register(); old.navigate.openUrl('https://fixture.invalid/stale'); await tick(); });
    assert.equal(f.navigation.length, navigations); await until(() => f.stats().live === 4);
    const changed = structuredClone(f.rows()); for (const row of changed) { row.resolution.revision.sequence = 2; row.resolution.presentation.data.label = 'Updated referent'; }
    f.setRows(changed); await f.notify(); await until(() => document.querySelector('[data-supplier]')?.textContent === 'Updated referent');
    const slot = f.panel(); await until(() => slot.container.querySelectorAll('[data-result-key]').length === 6 && f.stats().live === 4);
    assert.equal(f.stats().live, 4); assert.equal(f.stats().peak, 4); assert.equal(f.stats().rpc, 0);
    await f.hidden(true); await until(() => f.stats().live === 0); await settle(100);
    const count = f.stats().listCalls; await settle(100); assert.equal(f.stats().listCalls, count);
    await f.hidden(false); await until(() => f.stats().live === 4);
  } finally { await f.dispose(); }
});

test('one lazy accessible full dialog transfers same4 credit and restores only live opener', async () => {
  const f = await fixture();
  try {
    await until(() => f.stats().live === 4);
    const opener = document.querySelector('.tr-caption button'); await act(async () => { opener.focus(); opener.click(); });
    await until(() => f.stats().full === 1 && document.querySelector('dialog [data-supplier]'));
    const dialog = document.querySelector('dialog'); assert.equal(document.querySelectorAll('dialog').length, 1);
    assert.equal(dialog.getAttribute('aria-label'), 'Expanded result'); assert.equal(document.activeElement.textContent, 'Close expanded result');
    assert.equal(f.stats().peak, 4); assert.equal(f.stats().fullPeak, 1);
    assert.ok(dialog.querySelector('.tr-caption')); assert.ok(dialog.querySelector('.tr-fallback strong'));
    const controls = dialog.querySelectorAll('button'), last = controls[controls.length - 1];
    await act(async () => { last.focus(); last.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })); });
    assert.equal(document.activeElement.textContent, 'Close expanded result');
    const full = f.captured.findLast(props => props.mode === 'full'), before = f.navigation.length;
    await act(async () => dialog.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    full.navigate.openUrl('https://fixture.invalid/stale-full'); assert.equal(f.navigation.length, before);
    await until(() => !document.querySelector('dialog') && f.stats().live === 4);
    assert.ok(document.activeElement === opener, 'close should restore the same live opener');
    await settle(200); assert.equal(f.stats().listCalls, 1, 'owned detached host cleanup must not invalidate native history'); assert.equal(f.stats().peak, 4); assert.equal(f.stats().rpc, 0);
  } finally { await f.dispose(); }
});

test('async content-script disposal drains real roots before replacement and stale disposer cannot stop successor', async () => {
  const f = await fixture();
  try {
    await until(() => f.stats().live === 4); const before = f.navigation.length;
    const replacement = await f.replaceGeneration(); assert.equal(f.navigation.length, before);
    await until(() => f.stats().live === 4);
    await act(async () => { if (typeof replacement.previous === 'function') await replacement.previous(); });
    assert.equal(f.stats().live, 4); assert.equal(f.stats().peak, 4); await act(async () => replacement.nextController.abort());
    await until(() => f.stats().live === 0);
  } finally { await f.dispose(); }
});

test('pane holds exact root disposal credit past real passive cleanup/watchdog; fifth waits and diagnostics clear', async () => {
  const f = await fixture(5, false), runtime = createGalleryRuntime(f.sdk), signal = new AbortController();
  let pane, release = () => {}, held = false; const events = [];
  try {
    await runtime.readScope('thread', signal.signal, bounded => runtime.discoverReady(bounded));
    const sentinel = document.createElement('span'); sentinel.dataset.turnResultsSentinel = ''; document.body.append(sentinel);
    const anchors = f.rows().map((row, i) => ({ threadId: 'thread', turnId: row.identity.ref.source.turnId, rowId: `opaque-${i}`,
      sourceSeqStart: i * 10 + 1, sourceSeqEnd: i * 10 + 5, turnSeqStart: i * 10 + 1, turnSeqEnd: i * 10 + 5, historySnapshot: 'public-snapshot' }));
    act(() => { pane = mountGalleryPane(sentinel, 'thread', anchors, (host, anchor, current, lifetime) => {
      const root = createRoot(host), scope = runtime.presentationRoot(lifetime, current);
      const row = f.rows().find(row => row.identity.ref.source.turnId === anchor.turnId);
      root.render(h(ResultCard, { row, runtime, sdk: f.sdk, navigate: { openUrl: () => { f.navigation.push('nav'); return true; }, toThread() {} }, current, lifetime, presentationRoot: scope }));
      lifetime.addEventListener('abort', () => { if (anchor.turnId === 'turn-0') events.push('abort'); });
      return { beginDisposal() {
        const finish = scope.beginDisposal(); if (anchor.turnId === 'turn-0') events.push('begin');
        return () => { if (anchor.turnId === 'turn-0') events.push('finish'); finish(); };
      }, dispose() {
        root.unmount();
        if (anchor.turnId === 'turn-0' && !held) { held = true; events.push('unmount'); return new Promise(resolve => { release = resolve; }); }
      }, whenDrained: scope.whenDrained };
    }); });
    await until(() => f.stats().live === 4);
    const first = f.captured.find(props => props.identity.id === 'artifact-0'), before = f.navigation.length;
    await act(async () => { document.querySelector('[data-timeline-row-id="opaque-0"]').remove(); await tick(); });
    first.navigate.openUrl('https://fixture.invalid/stale'); assert.equal(f.navigation.length, before);
    assert.deepEqual(events, ['begin', 'abort', 'unmount']); assert.equal(f.stats().live, 3);
    assert.equal(runtime.canvases.counts().occupied, 4); assert.equal(runtime.canvases.counts().retiring, 1);
    await settle(1550); assert.equal(runtime.canvases.counts().occupied, 4); assert.equal(runtime.presentationStatus.state.stalled, 1);
    assert.match(document.body.textContent, /waiting for cleanup/); assert.equal(f.stats().peak, 4);
    await act(async () => { release(); await tick(); }); await until(() => f.stats().live === 4);
    assert.deepEqual(events, ['begin', 'abort', 'unmount', 'finish']); assert.equal(runtime.presentationStatus.state.stalled, 0);
    assert.equal(f.stats().peak, 4); assert.equal(f.stats().rpc, 0);
  } finally {
    release(); let drained;
    await act(async () => { drained = pane?.dispose(); runtime.dispose(); await tick(); });
    await drained; await runtime.whenDrained(); await f.dispose();
  }
});

test('denied sites do not grow64 admitted records; never-committed root needs actual disposal before drain', async () => {
  const f = await fixture(0, false), runtime = createGalleryRuntime(f.sdk), controller = new AbortController();
  const element = document.createElement('div'); document.body.append(element); const root = createRoot(element);
  const scope = runtime.presentationRoot(controller.signal, () => true);
  try {
    for (let i = 0; i < 200; i++) {
      const site = scope.site(`request-${i}`, { visible: true, focused: false, dialog: false, order: i, activation: 0 }, () => true);
      site.request.setAvailable(true);
    }
    assert.equal(runtime.canvases.counts().requests, 64); assert.equal(runtime.canvases.counts().occupied, 4);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 64, 'denied requests must not accumulate root listeners');
    const finish = scope.beginDisposal(); assert.equal(scope.beginDisposal(), finish);
    runtime.dispose(); let drained = false; void runtime.whenDrained().then(() => { drained = true; });
    await settle(); assert.equal(drained, false); assert.equal(runtime.canvases.counts().occupied, 4);
    assert.equal(runtime.presentationRoot(controller.signal, () => true).site('late', { visible: true, focused: false, dialog: true, order: 0, activation: 0 }, () => true), null);
    await act(async () => { root.unmount(); finish(); await tick(); });
    await scope.whenDrained(); await runtime.whenDrained(); assert.equal(runtime.canvases.counts().requests, 0);
  } finally { element.remove(); await f.dispose(); }
});

test('lazy renderer late completion after disable stays inert; nonempty owner methods never mount or call', async () => {
  const f = await fixture(1); let release = () => {};
  try {
    await until(() => f.stats().live === 1);
    await act(async () => { f.register(() => new Promise(resolve => { release = resolve; })); await tick(); });
    await until(() => f.stats().live === 0);
    f.enabled(false); await f.notify();
    await act(async () => { release(f.renderer); await tick(); });
    await settle(50); assert.equal(f.stats().live, 0); assert.equal(f.stats().rpc, 0);
    assert.match(document.querySelector('.tr-fallback').textContent, /Saved result 0/);
    f.enabled(true); await act(async () => { f.register(async () => f.renderer, ['requires-io']); }); await f.notify();
    await settle(100); assert.equal(f.stats().live, 0); assert.equal(f.stats().rpc, 0);
    await act(async () => { f.register(); }); await until(() => f.stats().live === 1);
  } finally { release(f.renderer); await f.dispose(); }
});

test('lazy failure leaves saved data and explicit retry recovers unchanged source without repeated reads', async () => {
  const f = await fixture(1); let loads = 0;
  try {
    await until(() => f.stats().live === 1);
    await act(async () => { f.register(async () => { if (++loads === 1) throw Error('intentional pure fixture load failure'); return f.renderer; }); });
    await until(() => document.querySelector('.tr-custom-status button'));
    assert.match(document.body.textContent, /Saved result 0/); assert.ok(document.querySelector('.tr-caption button'));
    const lists = f.stats().listCalls; await settle(120); assert.equal(loads, 1); assert.equal(f.stats().listCalls, lists);
    await act(async () => document.querySelector('.tr-custom-status button').click());
    await until(() => f.stats().live === 1 && !document.querySelector('.tr-custom-status'));
    assert.equal(loads, 2); assert.equal(f.stats().rpc, 0); assert.equal(f.stats().peak, 1);
  } finally { await f.dispose(); }
});

test('dialog failure retains usable dated data; late ignored refresh cannot restore a closed or reused opener', async () => {
  const f = await fixture(1); let release = () => {};
  try {
    await until(() => f.stats().live === 1);
    const opener = document.querySelector('.tr-caption button'); await act(async () => { opener.focus(); opener.click(); });
    await until(() => f.stats().full === 1);
    const original = f.sdk.plugins.callRpc; let failure = true;
    f.sdk.plugins.callRpc = async args => { if (failure && args.pluginId === 'turn-results' && args.method === GALLERY_METHODS.read) throw Error('fixture unavailable'); return original(args); };
    await act(async () => [...document.querySelectorAll('dialog button')].find(button => button.textContent === 'Refresh saved result').click());
    await until(() => /could not be refreshed/.test(document.querySelector('dialog').textContent));
    const before = f.navigation.length;
    await act(async () => [...document.querySelectorAll('dialog .tr-caption button')].find(button => button.textContent === 'Open').click());
    assert.equal(f.navigation.length, before + 1, 'retained data route remains usable during custom authority failure');
    failure = false;
    await act(async () => [...document.querySelectorAll('dialog button')].find(button => button.textContent === 'Refresh saved result').click());
    await until(() => !/could not be refreshed/.test(document.querySelector('dialog').textContent) && f.stats().full === 1);
    const oldFull = f.captured.findLast(props => props.mode === 'full');
    f.sdk.plugins.callRpc = async args => { if (args.pluginId === 'turn-results' && args.method === GALLERY_METHODS.read) { const value = await original(args); return new Promise(resolve => { release = () => resolve(value); }); } return original(args); };
    await act(async () => [...document.querySelectorAll('dialog button')].find(button => button.textContent === 'Refresh saved result').click());
    await settle();
    await act(async () => { document.querySelector('[data-timeline-row-id]').dataset.timelineRowId = 'opaque-reused'; });
    await act(async () => document.querySelector('dialog').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    await until(() => !document.querySelector('dialog'));
    assert.ok(document.activeElement !== opener, 'foreign/reused boundary cannot regain focus');
    const currentNavigation = f.navigation.length;
    await act(async () => { oldFull.navigate.openUrl('https://fixture.invalid/stale'); release(); await tick(); });
    await settle(200); assert.equal(document.querySelector('dialog'), null); assert.equal(f.navigation.length, currentNavigation);
    f.sdk.plugins.callRpc = original;
  } finally { release(); await f.dispose(); }
});

test('live discovery reaches supplier33 across bounded passes and revokes removed ready membership despite retained captions', async () => {
  const f = await fixture(0, false), runtime = createGalleryRuntime(f.sdk), controller = new AbortController();
  try {
    const ids = Array.from({ length: 33 }, (_, i) => `supplier-${String(i).padStart(2, '0')}`), original = f.sdk.plugins.list;
    f.sdk.plugins.list = async () => ({ plugins: ids.map(id => ({ id, enabled: true, status: 'running' })) });
    let passes = 0, continued;
    do { const read = await runtime.readScope('thread', controller.signal, signal => runtime.discoverReady(signal)); assert.equal(read.state, 'ready'); continued = read.value.continued; passes++; assert.ok(passes <= 4); } while (continued);
    assert.ok(passes >= 2); assert.equal(runtime.readyOwners.state.size, 33); assert.equal(runtime.isReadyOwner('supplier-32'), true);
    f.sdk.plugins.list = async () => ({ plugins: [{ id: 'supplier-32', enabled: true, status: 'running' }] });
    runtime.invalidateReadiness(); assert.equal(runtime.readyOwners.state.size, 0);
    await runtime.readScope('thread', controller.signal, signal => runtime.discoverReady(signal));
    assert.deepEqual([...runtime.readyOwners.state], ['supplier-32']); assert.equal(runtime.isReadyOwner('supplier-00'), false);
    f.sdk.plugins.list = original;
  } finally { runtime.dispose(); await runtime.whenDrained(); await f.dispose(); }
});

test('reverification waits quietly for exact shell disposal instead of microtask retrying a held root', async () => {
  const f = await fixture(1, false), runtime = createGalleryRuntime(f.sdk), controller = new AbortController();
  let pane, release = () => {}, mounts = 0, hold = true;
  try {
    await runtime.readScope('thread', controller.signal, signal => runtime.discoverReady(signal));
    const sentinel = document.createElement('span'); sentinel.dataset.turnResultsSentinel = ''; document.body.append(sentinel);
    const anchors = [{ threadId: 'thread', turnId: 'turn-0', rowId: 'opaque-0', sourceSeqStart: 1, sourceSeqEnd: 5, turnSeqStart: 1, turnSeqEnd: 5, historySnapshot: 'snapshot' }];
    act(() => { pane = mountGalleryPane(sentinel, 'thread', anchors, (host, _anchor, current, lifetime) => {
      mounts++; const root = createRoot(host), scope = runtime.presentationRoot(lifetime, current);
      root.render(h(ResultCard, { row: f.rows()[0], runtime, sdk: f.sdk, navigate: { openUrl() {}, toThread() {} }, current, lifetime, presentationRoot: scope }));
      return { beginDisposal: scope.beginDisposal, dispose() { root.unmount(); if (hold) { hold = false; return new Promise(resolve => { release = resolve; }); } }, whenDrained: scope.whenDrained };
    }); });
    await until(() => f.stats().live === 1);
    act(() => { pane.update([], ['opaque-0']); pane.update(anchors, ['opaque-0']); });
    await settle(80); assert.equal(mounts, 1); assert.equal(pane.capacity, true);
    assert.equal(runtime.canvases.counts().occupied, 1); assert.equal(f.stats().live, 0);
    await act(async () => { release(); await tick(); }); await until(() => f.stats().live === 1);
    assert.equal(mounts, 2); assert.equal(f.stats().peak, 1); assert.equal(pane.capacity, false);
  } finally {
    release(); let drained; await act(async () => { drained = pane?.dispose(); runtime.dispose(); await tick(); });
    await drained; await runtime.whenDrained(); await f.dispose();
  }
});

test('repeated empty successor panes share one stalled root barrier and never create another root', async () => {
  const f = await fixture(1, false); let release = () => {}, mounts = 0, latest, original;
  try {
    const sentinel = document.createElement('span'); sentinel.dataset.turnResultsSentinel = ''; document.body.append(sentinel);
    const anchors = [{ threadId: 'thread', turnId: 'turn-0', rowId: 'opaque-0', sourceSeqStart: 1, sourceSeqEnd: 5, turnSeqStart: 1, turnSeqEnd: 5, historySnapshot: 'snapshot' }];
    original = mountGalleryPane(sentinel, 'thread', anchors, () => { mounts++; return { dispose: () => new Promise(resolve => { release = resolve; }) }; });
    const barrier = original.dispose(); await settle();
    for (let i = 0; i < 200; i++) {
      const next = mountGalleryPane(sentinel, 'thread', anchors, () => { mounts++; return { dispose() {} }; });
      latest = next; assert.equal(next.capacity, true); assert.equal(next.pendingRoots, false);
      assert.ok(next.dispose() === barrier, 'empty remount must reuse exact shared barrier');
    }
    latest = mountGalleryPane(sentinel, 'thread', anchors, () => { mounts++; return { dispose() {} }; });
    await settle(60); assert.equal(mounts, 1); assert.equal(latest.capacity, true);
    release(); await barrier; await settle(); assert.equal(mounts, 2); assert.equal(latest.capacity, false);
  } finally { release(); await original?.dispose(); await latest?.dispose(); await f.dispose(); }
});

test('focused queued tile progresses; latest dialog intent wins once; hidden/revision callbacks stay fenced', async () => {
  const f = await fixture(6);
  try {
    await until(() => f.stats().live === 4);
    const fifth = document.querySelector('[data-result-key="row-5"] .tr-caption button');
    await act(async () => fifth.focus()); await until(() => document.querySelector('[data-supplier="artifact-5"]'));
    assert.ok(document.activeElement === fifth); assert.equal(f.stats().peak, 4);
    const fourth = document.querySelector('[data-result-key="row-4"] .tr-caption button');
    await act(async () => { fifth.click(); fourth.focus(); fourth.click(); });
    await until(() => document.querySelector('dialog [data-supplier="artifact-4"]') && f.stats().full === 1);
    assert.equal(document.querySelectorAll('dialog').length, 1); assert.equal(f.stats().fullPeak, 1); assert.equal(f.stats().peak, 4);
    const full = f.captured.findLast(props => props.mode === 'full'), nav = f.navigation.length;
    assert.equal(full.navigate.openFile({ kind: 'thread-storage', threadId: 'thread', path: 'unknown-origin.txt' }), false);
    await f.hidden(true); await until(() => f.stats().live === 0);
    full.navigate.openUrl('https://fixture.invalid/hidden'); assert.equal(f.navigation.length, nav);
    const lists = f.stats().listCalls; await settle(100); assert.equal(f.stats().listCalls, lists);
    await f.hidden(false); await until(() => f.stats().full === 1 && f.stats().live === 4);
    const changed = structuredClone(f.rows()); changed[4].resolution.revision.sequence++;
    changed[4].resolution.presentation.data.label = 'Fresh full snapshot'; f.setRows(changed); await f.notify();
    await until(() => document.querySelector('dialog [data-supplier]')?.textContent === 'Fresh full snapshot');
    full.navigate.openUrl('https://fixture.invalid/old-revision'); assert.equal(f.navigation.length, nav);
    assert.equal(f.stats().peak, 4); assert.equal(f.stats().fullPeak, 1); assert.equal(f.stats().rpc, 0);
  } finally { await f.dispose(); }
});

test('unchanged source-generated GitHub occurrence crosses gallery dock/full with actual owner and source revision', async () => {
  // Byte-identical source-factory output from the independent contributor lane.
  // This is gallery framing/data conformance with a pure fixture renderer,
  // not contributor implementation acceptance or a real GitHub occurrence.
  const input = JSON.parse(readFileSync(new URL('./github-source-occurrence.fixture.json', import.meta.url), 'utf8'));
  const resolution = input.resolution, f = await fixture(0, false, { owner: input.owner, schema: resolution.presentation.schema, kind: resolution.identity.ref.kind });
  const runtime = createGalleryRuntime(f.sdk), controller = new AbortController(), original = JSON.stringify(input);
  const element = document.createElement('div'); document.body.append(element); const root = createRoot(element);
  const scope = runtime.presentationRoot(controller.signal, () => !controller.signal.aborted);
  try {
    await runtime.readScope(resolution.identity.ref.source.threadId, controller.signal, signal => runtime.discoverReady(signal));
    const row = { ...record(0), key: 'unchanged-source-fixture', owner: input.owner, identity: resolution.identity, resolution };
    await act(async () => root.render(h(ResultCard, { row, runtime, sdk: f.sdk, navigate: { openUrl: url => f.navigation.push(url), toThread() {} },
      current: () => !controller.signal.aborted, lifetime: controller.signal, presentationRoot: scope })));
    await until(() => f.stats().live === 1);
    const docked = f.captured.at(-1);
    assert.equal(docked.owner.pluginId, 'github-review'); assert.deepEqual(docked.identity, resolution.identity.artifact);
    assert.equal(docked.identity.id, 'a/b/pull/12'); assert.deepEqual(docked.data, resolution.presentation.data);
    assert.equal(docked.revision, JSON.stringify([resolution.revision.epoch, resolution.revision.sequence]));
    const opener = element.querySelector('.tr-caption button'); await act(async () => { opener.focus(); opener.click(); });
    await until(() => f.stats().full === 1);
    const full = f.captured.findLast(props => props.mode === 'full'); assert.deepEqual(full.identity, docked.identity); assert.deepEqual(full.data, docked.data);
    assert.match(document.querySelector('dialog .tr-caption').textContent, /Open/);
    assert.equal(JSON.stringify(input), original); assert.equal(f.stats().rpc, 0); assert.equal(f.stats().peak, 1);
  } finally {
    let drained;
    await act(async () => { const finish = scope.beginDisposal(); controller.abort(); root.unmount(); finish(); runtime.dispose(); drained = runtime.whenDrained(); await tick(); });
    await drained; element.remove(); await f.dispose();
  }
});

test('queued content-script replacements activate only latest generation after old root drain', async () => {
  const f = await fixture(5);
  try {
    await until(() => f.stats().live === 4);
    const { skipped } = await f.replaceLatest(); await until(() => f.stats().live === 4);
    await act(async () => skipped.abort()); await settle(50);
    assert.equal(f.stats().live, 4); assert.equal(f.stats().peak, 4); assert.equal(f.stats().rpc, 0);
  } finally { await f.dispose(); }
});

// Independent h5 v1 authority probes retained as production regressions.
test('independent: an already-loaded dialog rejects an opener reused during predecessor retirement', async () => {
  const f = await fixture(2); const observed = {};
  try {
    await until(() => f.stats().live === 2);
    const first = document.querySelector('[data-result-key="row-0"] .tr-caption button');
    await act(async () => { first.focus(); first.click(); });
    await until(() => f.stats().full === 1);
    const second = document.querySelector('[data-result-key="row-1"] .tr-caption button');
    const before = f.navigation.length;
    await act(async () => {
      second.focus(); second.click();
      document.querySelector('[data-timeline-row-id="opaque-1"]').dataset.timelineRowId = 'reused-foreign-row';
      await tick();
    });
    await settle(50);
    const full = f.captured.findLast(props => props.mode === 'full');
    observed.dialog = Boolean(document.querySelector('dialog'));
    observed.fullIdentity = document.querySelector('dialog [data-supplier]')?.getAttribute('data-supplier') ?? null;
    observed.nativeReused = !second.isConnected || second.closest('[data-timeline-row-id]')?.dataset.timelineRowId !== 'opaque-1';
    full?.navigate.openUrl('https://fixture.invalid/reused-opener');
    observed.acceptedStaleNavigation = f.navigation.length > before;
    console.log('INDEPENDENT_STALE_OPENER', JSON.stringify(observed));
    assert.equal(observed.fullIdentity, null, 'a reused pending opener must not gain a new full renderer');
    assert.equal(observed.acceptedStaleNavigation, false);
  } finally { await f.dispose(); }
});

test('independent: retained panel data Open after content-script shutdown', async () => {
  const f = await fixture(1); const observed = {};
  try {
    await until(() => f.stats().live === 1);
    const slot = f.panel(); await until(() => slot.container.querySelector('[data-result-key]'));
    const open = [...slot.container.querySelectorAll('.tr-caption button')].find(b=>b.textContent==='Open');
    const before = f.navigation.length; const oldCustom = f.captured.at(-1);
    await act(async () => { f.controller.abort(); await tick(); });
    await until(() => f.stats().live === 0);
    oldCustom.navigate.openUrl('https://fixture.invalid/retired-custom');
    observed.customNavigationAfterShutdown = f.navigation.length-before;
    await act(async () => open.click());
    observed.navigationAfterShutdown = f.navigation.length-before;
    console.log('INDEPENDENT_PANEL_SHUTDOWN',JSON.stringify(observed));
    assert.equal(observed.navigationAfterShutdown,0,'retired window generation cannot navigate from a still-owned native panel');
  } finally { await f.dispose(); }
});


test('independent control: already-loaded dialog replacement with current opener remains functional', async () => {
  const f = await fixture(2);
  try {
    await until(() => f.stats().live === 2);
    const first = document.querySelector('[data-result-key="row-0"] .tr-caption button');
    await act(async () => { first.focus(); first.click(); });
    await until(() => f.stats().full === 1);
    const second = document.querySelector('[data-result-key="row-1"] .tr-caption button');
    await act(async () => { second.focus(); second.click(); await tick(); });
    await until(() => document.querySelector('dialog [data-supplier="artifact-1"]'));
    const before = f.navigation.length;
    f.captured.findLast(p=>p.mode==='full').navigate.openUrl('https://fixture.invalid/current-opener');
    assert.equal(f.navigation.length,before+1); assert.equal(f.stats().fullPeak,1);
    console.log('INDEPENDENT_CURRENT_OPENER',JSON.stringify({fullIdentity:'artifact-1',navigation:1,fullPeak:f.stats().fullPeak,peak:f.stats().peak}));
  } finally { await f.dispose(); }
});

test('loaded dialog rejects a removed queued opener; a fresh verified replacement remains admissible', async () => {
  const f = await fixture(2);
  try {
    await until(() => f.stats().live === 2);
    const first = document.querySelector('[data-result-key="row-0"] .tr-caption button');
    await act(async () => { first.focus(); first.click(); }); await until(() => f.stats().full === 1);
    const second = document.querySelector('[data-result-key="row-1"] .tr-caption button');
    await act(async () => {
      second.focus(); second.click(); document.querySelector('[data-timeline-row-id="opaque-1"]').remove(); await tick();
    });
    await until(() => !document.querySelector('dialog'));
    assert.ok(!f.captured.some(props => props.mode === 'full' && props.identity.id === 'artifact-1'));
    await act(async () => {
      const replacement = document.createElement('div'); replacement.dataset.timelineRowId = 'opaque-1';
      replacement.innerHTML = '<button>Replacement native row</button>'; document.querySelector('[data-timeline-row-list]').append(replacement);
    });
    await until(() => document.querySelector('[data-result-key="row-1"] .tr-caption button') && document.querySelector('[data-supplier="artifact-1"]'));
    const replacement = document.querySelector('[data-result-key="row-1"] .tr-caption button');
    await act(async () => { replacement.focus(); replacement.click(); });
    await until(() => document.querySelector('dialog [data-supplier="artifact-1"]'));
    assert.equal(f.stats().fullPeak, 1); assert.equal(f.stats().peak, 2);
  } finally { await f.dispose(); }
});

test('loaded dialog retains only latest current replacement intent while predecessor drains', async () => {
  const f = await fixture(3);
  try {
    await until(() => f.stats().live === 3);
    const opener = document.querySelector('[data-result-key="row-0"] .tr-caption button');
    await act(async () => { opener.focus(); opener.click(); }); await until(() => f.stats().full === 1);
    const second = document.querySelector('[data-result-key="row-1"] .tr-caption button');
    const latest = document.querySelector('[data-result-key="row-2"] .tr-caption button');
    await act(async () => { second.focus(); second.click(); latest.focus(); latest.click(); await tick(); });
    await until(() => document.querySelector('dialog [data-supplier="artifact-2"]'));
    assert.ok(!f.captured.some(props => props.mode === 'full' && props.identity.id === 'artifact-1'));
    const navigation = f.navigation.length;
    f.captured.findLast(props => props.mode === 'full').navigate.openUrl('https://fixture.invalid/latest-current');
    assert.equal(f.navigation.length, navigation + 1); assert.equal(f.stats().fullPeak, 1); assert.equal(f.stats().peak, 3);
  } finally { await f.dispose(); }
});

test('already accepted full selection keeps independent saved-data lifetime when original native opener virtualizes away', async () => {
  const f = await fixture(2);
  try {
    await until(() => f.stats().live === 2);
    const opener = document.querySelector('[data-result-key="row-0"] .tr-caption button');
    await act(async () => { opener.focus(); opener.click(); });
    await until(() => document.querySelector('dialog [data-supplier="artifact-0"]'));
    await act(async () => document.querySelector('[data-timeline-row-id="opaque-0"]').remove());
    await until(() => !opener.isConnected && document.querySelector('dialog [data-supplier="artifact-0"]'));
    const navigation = f.navigation.length;
    await act(async () => [...document.querySelectorAll('dialog .tr-caption button')].find(button => button.textContent === 'Open').click());
    assert.equal(f.navigation.length, navigation + 1);
    f.captured.findLast(props => props.mode === 'full').navigate.openUrl('https://fixture.invalid/accepted-independent');
    assert.equal(f.navigation.length, navigation + 2); assert.equal(f.stats().fullPeak, 1);
  } finally { await f.dispose(); }
});

test('native panel dated data works through active source faults but fences synchronously on retirement and stays inert after replacement', async () => {
  const f = await fixture(1);
  try {
    await until(() => f.stats().live === 1);
    const slot = f.panel(); await until(() => slot.container.querySelector('[data-result-key]'));
    const open = [...slot.container.querySelectorAll('.tr-caption button')].find(button => button.textContent === 'Open');
    const original = f.sdk.plugins.callRpc;
    f.sdk.plugins.callRpc = async args => {
      if (args.pluginId === 'turn-results' && args.method === GALLERY_METHODS.read) throw Error('intentional active-generation read outage');
      return original(args);
    };
    await f.hidden(true); await f.hidden(false);
    await until(() => /Results history is temporarily unavailable/.test(slot.container.textContent));
    const before = f.navigation.length; await act(async () => open.click());
    assert.equal(f.navigation.length, before + 1, 'source read outage does not retire accepted data authority');
    f.sdk.plugins.callRpc = original;
    await f.hidden(true); await f.hidden(false);
    await until(() => !/Results history is temporarily unavailable/.test(slot.container.textContent) && f.stats().live > 0);
    const fallback = slot.container.querySelector('.tr-fallback button'), oldCustom = f.captured.at(-1), beforeStop = f.navigation.length;
    act(() => {
      f.controller.abort();
      open.click(); fallback.click(); oldCustom.navigate.openUrl('https://fixture.invalid/retired');
      assert.equal(f.navigation.length, beforeStop, 'stop fences old data/custom actions before passive native-slot cleanup');
    });
    await until(() => f.stats().live === 0); assert.ok(open.isConnected, 'native panel remains mounted during stop');
    await f.replaceGeneration(); await until(() => f.stats().live === 1);
    await act(async () => open.click()); assert.equal(f.navigation.length, beforeStop, 'old runtime never revives with successor');
    const fresh = f.panel(); await until(() => fresh.container.querySelector('[data-result-key]'));
    await act(async () => [...fresh.container.querySelectorAll('.tr-caption button')].find(button => button.textContent === 'Open').click());
    assert.equal(f.navigation.length, beforeStop + 1, 'current replacement generation remains usable');
  } finally { await f.dispose(); }
});
