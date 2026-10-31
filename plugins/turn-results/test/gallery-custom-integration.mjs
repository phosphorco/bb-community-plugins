import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { getEventListeners } from 'node:events';
import ts from 'typescript';
import { JSDOM } from 'jsdom';
import { act, createElement as h, useEffect, StrictMode, Suspense, startTransition } from 'react';
import { createRoot } from 'react-dom/client';
import { createPortal } from 'react-dom';
import { loadPluginApp, renderSlot } from '@get-bb/plugin-sdk/testing/app';
import { registerPresentation } from '@phosphorco/bb-context-recognition/presentation';
import { registerTurnResultsParticipant } from '@phosphorco/bb-turn-results/bb';
import { buildResolveOutput, METHODS, sha256Canonical } from '@phosphorco/bb-turn-results';
import { GALLERY_METHODS } from '../gallery/rpc.ts';
import { createGalleryRuntime } from '../gallery/runtime.ts';
import { mountGalleryPane } from '../gallery/pane.ts';
const navigationVariantUrl = new URL('../app.tsx?public-navigation-reference-fixture', import.meta.url).href;
const runtimeVariantUrl = new URL('../app.tsx?public-runtime-constructor-fixture', import.meta.url).href;
const navigationHookFixture = `
function useBbNavigate() {
  const api = originalUseBbNavigate(), probe = globalThis.__turnResultsNavigationFixture;
  const version = probe ? ++probe.rendered : 0;
  useLayoutEffect(() => {
    if (!probe) return;
    probe.committed = version;
    return () => { if (probe.committed === version) probe.committed = null; };
  }, [probe, version]);
  if (!probe) return api;
  return { ...api,
    openUrl(...args) { probe.calls.push({ version, method: 'openUrl' }); return api.openUrl(...args); },
    openThreadPanel(...args) { probe.calls.push({ version, method: 'openThreadPanel' }); return api.openThreadPanel(...args); },
  };
}
function useSdk() {
  const api = originalUseSdk(), probe = globalThis.__turnResultsNavigationFixture;
  if (probe) probe.originalSdk = api;
  return probe?.sdkOverride ?? api;
}
`;
registerHooks({ load(url, context, next) {
  if (url.endsWith('.css')) return { format: 'module', shortCircuit: true, source: 'export default {}' };
  if (new URL(url).pathname.endsWith('.tsx')) {
    let source = readFileSync(new URL(url), 'utf8');
    if (url === navigationVariantUrl) source = source.replace('useBbNavigate,', 'useBbNavigate as originalUseBbNavigate,')
      .replace('useSdk,', 'useSdk as originalUseSdk,') + navigationHookFixture;
    if (url === runtimeVariantUrl) source = source.replace('import { createGalleryRuntime }', 'import { createGalleryRuntime as originalCreateGalleryRuntime }')
      + '\nfunction createGalleryRuntime(...args) { const owner = originalCreateGalleryRuntime(...args); globalThis.__turnResultsRuntimeFixture?.push(owner); return owner; }';
    return { format: 'module', shortCircuit: true,
      source: ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } }).outputText };
  }
  return next(url, context);
} });
const definition = await import('../app.tsx');
const navigationDefinition = await import(navigationVariantUrl);
const runtimeDefinition = await import(runtimeVariantUrl);
const { ResultCard } = await import('../gallery/view.tsx');

// Exact independent h5 OI1/OI2 interleavings (retained probe SHA872b6d88...).
test('independent: superseding a held Checking with direct Open cannot publish the cancelled outcome', async () => {
  const h = await heldImageIntent({ holdValidation: true });
  try {
    await act(async () => { h.gates.shift()(); await tick(); });
    await until(() => h.gates.length === 1);
    // The ordinary pane proof has now resumed this same card. The private
    // action timeline is held; a new explicit Open takes the synchronous path.
    await act(async () => h.image.closest('button').click());
    assert.equal(h.f.fileOpenCalls.length, 1);
    await settle(25);
    console.log('INDEPENDENT_SUPERSEDED_DIRECT', JSON.stringify({ calls: h.f.fileOpenCalls.length, status: h.card.querySelector('[data-turn-result-open-status]')?.textContent ?? null }));
    const staleStatus = h.card.querySelector('[data-turn-result-open-status]')?.textContent ?? null;
    console.log('CLEANUP_RELEASE_START'); await h.release(); console.log('CLEANUP_RELEASE_FINISHED');
    assert.equal(staleStatus, null, 'successful later direct Open must not display an old cancelled intent decline');
  } finally { console.log('CLEANUP_CLOSE_START'); await h.close(); console.log('CLEANUP_CLOSE_FINISHED'); }
});

test('independent: synchronous Open checks explicit expiry already published by its actual resource store', async () => {
  const f = await fixture(1, true, { owner: 'turn-result-images', fileRoute: true, loadedImage: true, nativeItems: true, captureRuntime: true });
  let lease;
  try {
    await until(() => document.querySelector('[data-result-key="row-0"] img'));
    const image = document.querySelector('[data-result-key="row-0"] img');
    lease = f.runtime().retain({ threadId: 'thread', turnId: 'turn-0', rowId: 'opaque-0', sourceSeqStart: 1,
      sourceSeqEnd: 5, turnSeqStart: 1, turnSeqEnd: 5, historySnapshot: 'public-snapshot' }, false);
    await act(async () => {
      lease.store.setState(previous => ({ ...previous, rows: previous.rows.map(row => ({ ...row,
        sourceExpired: { epoch: 'fixture', sequence: 2 }, currentAvailability: { state: 'unknown', asOf: 2, expiresAt: null } })) }));
      image.closest('button').click();
    });
    console.log('INDEPENDENT_PUBLISHED_EXPIRY', JSON.stringify({ sourceExpired: lease.store.state.rows[0].sourceExpired, calls: f.fileOpenCalls.length }));
    assert.equal(f.fileOpenCalls.length, 0, 'already-published explicit expiry must refuse before the direct branch, including before React commits the new props');
  } finally { lease?.dispose(); await f.dispose(); }
});
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
  const structuralRows = contribution.structuralRows ?? [];
  const nativeMarkup = Array.from({ length: count }, (_, i) => `<div data-timeline-row-id="opaque-${i}"><button>Native ${i}</button></div>`).join('')
    + structuralRows.map(row => `<div data-timeline-row-id="${row.id}"><button>Native public row</button></div>`).join('');
  const dom = new JSDOM(`<body><section data-split-pane-id="left"><header><div data-thread-header-workflow-actions><div data-bb-plugin-root data-bb-plugin="turn-results" class="contents"><span role="group" data-fixture-header></span></div></div></header><section data-thread-window>${contribution.nativeItems ? '<div data-native-chrome><div></div></div>' : ''}<div data-timeline-row-list="top-level">${structuralRows.length || contribution.nativeItems ? `<div data-timeline-items class="relative w-full">${nativeMarkup}</div>` : nativeMarkup}</div></section></section></body>`, { pretendToBeVisual: true });
  const keys = ['window','document','Element','HTMLElement','MutationObserver','ResizeObserver','IntersectionObserver','IS_REACT_ACT_ENVIRONMENT','fetch'];
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
  class Observer { constructor(callback) { this.callback = callback; } observe(target) {
    if (contribution.loadedImage && target.classList.contains('tr-canvas')) this.callback([{ target, isIntersecting: true }]);
  } unobserve() {} disconnect() {} }
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
    MutationObserver: dom.window.MutationObserver, ResizeObserver: Observer, IntersectionObserver: Observer, IS_REACT_ACT_ENVIRONMENT: true });
  const box = { top: 0, bottom: 600, left: 0, right: 800, width: 800, height: 600, x: 0, y: 0, toJSON() {} };
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () { return this.hasAttribute('data-thread-window') ? box : { ...box, width: 400, right: 400, height: 216, bottom: 216 }; };
  let rows = Array.from({ length: count }, (_, i) => record(i)), enabled = true, listCalls = 0, rpc = 0, live = 0, peak = 0, setups = 0, cleanups = 0, full = 0, fullPeak = 0;
  if (contribution.fileRoute) rows = rows.map(row => ({ ...row, resolution: { ...row.resolution,
    route: { kind: 'file', target: { kind: 'host', hostId: 'recorded-host', path: '/saved/result.png' } } } }));
  if (contribution.savedUnavailable) rows = rows.map(row => ({ ...row, currentAvailability: { state: 'unknown', asOf: 1, expiresAt: null },
    resolution: { ...row.resolution, availability: { state: 'unavailable', asOf: 1, expiresAt: null, reason: 'source-refused' } } }));
  const mediaBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=', 'base64');
  const mediaSha = createHash('sha256').update(mediaBytes).digest('hex'); let mediaCalls = 0, mediaFetches = 0;
  if (contribution.loadedImage) {
    rows = rows.map(row => { const { presentation, ...resolution } = row.resolution; return { ...row, owner: registeredOwner,
      resolution: { ...resolution, fallback: { kind: 'image', title: 'Saved image', alt: 'Retained fixture image' },
        provenance: { ...resolution.provenance, artifactLocation: { state: 'verified', target: resolution.route.target,
          observedAt: 1, basis: 'explicit-host-read', sha256: mediaSha } } } }; });
    globalThis.fetch = async () => { mediaFetches++; return new Response(mediaBytes, { headers: { 'content-type': 'image/png' } }); };
  }
  const fileOpenCalls = []; let fileOpenAccepted = true;
  const captured = [], navigation = [], registrations = [], nativeCalls = [], handlers = new Map();
  const bb = { rpc: { register(_contract, value) { for (const [method, handler] of Object.entries(value)) handlers.set(method, handler); } } };
  registerTurnResultsParticipant(bb, { pluginId: registeredOwner, capabilities: { revision: 'supplier-r1', supplier: {
    recognize: false, resolve: true, enumerate: false, kinds: [{ kind, namespace, neutralLabel: 'Result', confirmedLabel: 'Created', specificity: 'typed', memberVersion: 'v1', equivalenceNamespaces: [] }] } },
    resolve(input) { return buildResolveOutput(input, input.items.map(() => ({ state: 'unavailable', reason: 'not used' }))); } });
  const sdk = { threads: { async timeline(input) {
    nativeCalls.push(input); return { rows: rows.map((row, i) => ({ id: `opaque-${i}`, threadId: 'thread', turnId: row.identity.ref.source.turnId,
      kind: 'turn', status: 'completed', sourceSeqStart: i * 10 + 1, sourceSeqEnd: i * 10 + 5 })).concat(structuralRows), completedTurnDisplay: 'collapse', timelinePage: { historySnapshot: 'public-snapshot', olderCursor: null } };
  }, events: { async list() { throw Error('No native event read is allowed in this fixture'); } } }, plugins: {
    async list() { listCalls++; return { plugins: [{ id: registeredOwner, enabled, status: enabled ? 'running' : 'disabled' }] }; },
    async callRpc(args) {
      let value;
      if (contribution.loadedImage && args.method === 'turnResultImagesV1Media') {
        mediaCalls++; const now = Date.now(), target = rows[0].resolution.route.target;
        value = { version: 1, state: 'ready', image: { mimeType: 'image/png', sha256: mediaSha, width: 1, height: 1, sizeBytes: mediaBytes.length },
          lease: { targetFingerprint: await sha256Canonical({ target, sha256: mediaSha }), leaseGeneration: 'fixture',
            baseUrl: '/api/v1/file-previews/fixture', url: '/api/v1/file-previews/fixture/image.png', resolvedAt: now, expiresAtMs: now + 60000 } };
      } else if (args.pluginId === 'turn-results') {
        if (args.method === GALLERY_METHODS.read) {
          const all = rows.filter(row => !args.input.turnId || row.identity.ref.source.turnId === args.input.turnId);
          const start = args.input.after ? all.findIndex(row => row.key === args.input.after.key) + 1 : 0, page = all.slice(start, start + 8), last = page.at(-1);
          value = { page: { rows: page, next: last && start + 8 < all.length ? { seq: last.identity.ref.source.seq, key: last.key } : null }, coverage: { state: 'partial', intervals: [] } };
        }
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
    if (contribution.customExpand && props.mode === 'docked') return h('button', {
      'data-supplier': props.identity.id, 'data-mode': props.mode, 'data-contributor-expand': '', onClick: props.requestFull,
    }, 'Expand contributor result');
    return h('button', { 'data-supplier': props.identity.id, 'data-mode': props.mode, onClick: () => props.navigate.openUrl('https://fixture.invalid/referent') }, props.data.label ?? `${props.data.repository}#${props.data.pullNumber}`);
  }
  let generation = 0;
  function register(load = async () => View, methods = []) {
    const controller = new AbortController();
    const dispose = registerPresentation({ pluginId: registeredOwner, generation: ++generation, signal: controller.signal }, { schema: registeredSchema, methods, decode: value => value, load });
    registrations.push(dispose); return dispose;
  }
  register();
  const runtimeProbe = []; if (contribution.captureRuntime) globalThis.__turnResultsRuntimeFixture = runtimeProbe;
  const app = await loadPluginApp(contribution.definition ?? (contribution.captureRuntime ? runtimeDefinition : definition)), controller = new AbortController();
  let script = await app.contentScripts[0].mount({ pluginId: 'turn-results', generation: 1, signal: controller.signal });
  assert.equal(app.composerCustomizations.length, 0); assert.equal(app.threadPanelActions.length, 0);
  const originalBridge = app.threadHeaderActions[0];
  const Bridge = contribution.wrapBanner ? contribution.wrapBanner(originalBridge.component) : originalBridge.component;
  const headerProps = { threadId: 'thread', projectId: 'project', isCompactViewport: false };
  const banner = { ...originalBridge, component: props => createPortal(h(Bridge, props), document.querySelector('[data-fixture-header]')) };
  const renderBanner = () => renderSlot(banner, headerProps, { sdk,
    openFilePreview(options) { fileOpenCalls.push(options); if (contribution.focusOnFileOpen) { const preview = document.createElement('button'); document.body.append(preview); preview.focus(); } return fileOpenAccepted; },
    openUrl(url) { navigation.push(url); return true; }, realtimeConnectionState: 'connected' });
  let rendered = null; if (mount) act(() => { rendered = renderBanner(); }); const slots = [];
  return { dom, sdk, app, controller, captured, navigation, nativeCalls, register, renderer: View, slot: () => rendered,
    fileOpenCalls, fileOpenAccepted(value) { fileOpenAccepted = value; },
    runtime: () => runtimeProbe.at(-1), element: () => h(banner.component, { ...headerProps }),
    mediaCounts: () => ({ calls: mediaCalls, fetches: mediaFetches }),
    rerender: () => act(async () => { rendered.lifecycle.rerender(h(banner.component, headerProps)); await tick(); }),
    thread: value => act(async () => { headerProps.threadId = value; rendered.lifecycle.rerender(h(banner.component, { ...headerProps })); await tick(); }),
    stats: () => ({ listCalls, rpc, live, peak, setups, cleanups, full, fullPeak, subscriptions, subscriptionPeak }),
    rows: () => rows, setRows(value) { rows = value; }, enabled(value) { enabled = value; },
    notify: () => act(async () => { await rendered.behavior.emitRealtime('results-changed', { threadId: 'thread' }); await tick(); }),
    membership: () => act(async () => { await rendered.behavior.emitRealtime('plugins-changed', {}); await tick(); }),
    async reconnect() { await rendered.behavior.setRealtimeConnectionState('reconnecting'); await rendered.behavior.setRealtimeConnectionState('connected'); await settle(); },
    async hidden(value) { Object.defineProperty(document, 'hidden', { configurable: true, value }); await act(async () => document.dispatchEvent(new dom.window.Event('visibilitychange'))); },
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
      if (globalThis.__turnResultsRuntimeFixture === runtimeProbe) delete globalThis.__turnResultsRuntimeFixture;
      console.log('CUSTOM_HOST_COUNTERS', JSON.stringify(counters));
      assert.equal(live, 0); assert.equal(setups, cleanups); assert.equal(subscriptions, 0); assert.ok(subscriptionPeak <= 132);
    },
  };
}

test('actual app readiness/realm/revision/retry fences, four resources and quiet idle', async () => {
  const f = await fixture();
  try {
    await until(() => f.stats().live === 4 && document.querySelectorAll('[data-result-key]').length === 6);
    assert.equal(f.stats().rpc, 0); assert.equal(f.stats().peak, 4);
    const first = f.captured.at(-1); assert.equal(first.identity.provider, 'different-artifact-provider'); assert.equal(first.owner.pluginId, owner);
    assert.ok(first.size.maxWidth > 0 && first.size.maxWidth <= 400); assert.ok(first.size.maxHeight > 0 && first.size.maxHeight <= 216);
    const native = f.nativeCalls.length, lists = f.stats().listCalls; await settle(200);
    assert.equal(f.nativeCalls.length, native); assert.equal(f.stats().listCalls, lists);
    f.enabled(false); await f.membership(); await until(() => f.stats().live === 0);
    const navigations = f.navigation.length; first.navigate.openUrl('https://fixture.invalid/stale'); first.requestFull(); first.refresh();
    assert.equal(f.navigation.length, navigations); assert.equal(document.querySelector('dialog'), null);
    f.enabled(true); await f.notify(); await until(() => f.stats().live === 4);
    const old = f.captured.at(-1); await act(async () => { f.register(); old.navigate.openUrl('https://fixture.invalid/stale'); await tick(); });
    assert.equal(f.navigation.length, navigations); await until(() => f.stats().live === 4);
    const changed = structuredClone(f.rows()); for (const row of changed) { row.resolution.revision.sequence = 2; row.resolution.presentation.data.label = 'Updated referent'; }
    f.setRows(changed); await f.notify(); await until(() => document.querySelector('[data-supplier]')?.textContent === 'Updated referent');
    assert.equal(f.stats().live, 4); assert.equal(f.stats().peak, 4); assert.equal(f.stats().rpc, 0);
    await f.hidden(true); await until(() => f.stats().live === 0); await settle(100);
    const count = f.stats().listCalls; await settle(100); assert.equal(f.stats().listCalls, count);
    await f.hidden(false); await until(() => f.stats().live === 4);
  } finally { await f.dispose(); }
});

test('outside-list native chrome preserves loaded image Open while unrelated fresh history is held', async () => {
  const f = await fixture(2, true, { owner: 'turn-result-images', fileRoute: true, loadedImage: true, nativeItems: true }); let release = () => {};
  try {
    await until(() => document.querySelector('[data-result-key="row-0"] img'));
    const image = document.querySelector('[data-result-key="row-0"] img'), url = image.src;
    const card = image.closest('[data-result-key]'), shell = card.closest('[data-turn-results-gallery]');
    const original = f.sdk.threads.timeline; let started = 0;
    f.sdk.threads.timeline = async input => { started++; await new Promise(resolve => { release = resolve; }); return original(input); };
    await act(async () => { document.querySelector('[data-timeline-row-id="opaque-1"] > button').firstChild.data = 'Other turn changed'; await tick(170); });
    await until(() => started === 1);
    const chrome = document.querySelector('[data-native-chrome]');
    await act(async () => { chrome.firstChild.replaceWith(document.createElement('div')); await tick(10); });
    await act(async () => image.closest('button').click());
    assert.equal(f.fileOpenCalls.length, 1, 'unrelated outside-list chrome cannot revoke a healthy loaded image Open');
    assert.equal(card.querySelector('[data-turn-result-open-status]'), null);
    assert.equal(card.querySelector('img'), image); assert.equal(image.src, url); assert.equal(card.closest('[data-turn-results-gallery]'), shell);
    f.sdk.threads.timeline = original; await act(async () => { release(); await tick(); });
    await until(() => document.querySelector('[data-result-key="row-1"] img'));
    assert.equal(started, 1); assert.equal(card.querySelector('img'), image); assert.equal(image.src, url);
    assert.deepEqual(f.mediaCounts(), { calls: 2, fetches: 2 }, 'proof/chrome does not reload verified image bytes');
  } finally { release(); await f.dispose(); }
});

test('one dated-image gesture checks fresh proof then opens once without losing its loaded Blob', async () => {
  const f = await fixture(1, true, { owner: 'turn-result-images', fileRoute: true, loadedImage: true, nativeItems: true });
  const original = f.sdk.threads.timeline; let release = () => {};
  try {
    await until(() => document.querySelector('[data-result-key="row-0"] img'));
    const image = document.querySelector('[data-result-key="row-0"] img'), url = image.src;
    const card = image.closest('[data-result-key]'), shell = card.closest('[data-turn-results-gallery]');
    const dated = structuredClone(f.rows()); dated[0].currentAvailability = { state: 'unknown', asOf: 1, expiresAt: null }; f.setRows(dated);
    let held = 0;
    f.sdk.threads.timeline = async input => { held++; await new Promise(resolve => { release = resolve; });
      const page = await original(input); return { ...page, timelinePage: { historySnapshot: 'fresh-after-gesture', olderCursor: null } }; };
    await f.notify(); await until(() => held === 1);
    await act(async () => image.closest('button').click());
    assert.match(card.querySelector('[data-turn-result-open-status]')?.textContent ?? '', /Checking/);
    assert.equal(f.fileOpenCalls.length, 0); assert.equal(held, 1, 'intent waits in the existing per-thread lane');
    f.sdk.threads.timeline = original; await act(async () => { release(); await tick(); });
    await until(() => f.fileOpenCalls.length === 1);
    assert.equal(card.querySelector('[data-turn-result-open-status]'), null);
    assert.equal(card.querySelector('img'), image); assert.equal(image.src, url); assert.equal(card.closest('[data-turn-results-gallery]'), shell);
    assert.match(card.textContent, /checked earlier/); assert.deepEqual(f.mediaCounts(), { calls: 1, fetches: 1 });
    await settle(50); assert.equal(f.fileOpenCalls.length, 1);
  } finally { f.sdk.threads.timeline = original; release(); await f.dispose(); }
});

test('direct Open checks current full facts before React commit, without a validation read or clock freshness requirement', async t => {
  for (const kind of ['clock-only', 'source-expired', 'saved-unavailable', 'retracted', 'route', 'proof', 'missing']) await t.test(kind, async () => {
    const f = await fixture(1, true, { owner: 'turn-result-images', fileRoute: true, loadedImage: true, nativeItems: true, captureRuntime: true });
    let lease;
    try {
      await until(() => document.querySelector('[data-result-key="row-0"] img'));
      const image = document.querySelector('[data-result-key="row-0"] img'), nativeReads = f.nativeCalls.length;
      lease = f.runtime().retain({ threadId: 'thread', turnId: 'turn-0', rowId: 'opaque-0', sourceSeqStart: 1,
        sourceSeqEnd: 5, turnSeqStart: 1, turnSeqEnd: 5, historySnapshot: 'public-snapshot' }, false);
      await act(async () => {
        const rows = structuredClone(lease.store.state.rows);
        rows[0].freshness = 'disconnected'; rows[0].currentAvailability = { state: 'unknown', asOf: 2, expiresAt: null };
        if (kind === 'source-expired') rows[0].sourceExpired = { epoch: 'fixture', sequence: 2 };
        if (kind === 'saved-unavailable') rows[0].resolution.availability.state = 'unavailable';
        if (kind === 'retracted') rows[0].retracted = { revision: { epoch: 'fixture', sequence: 2 }, supersedesEvidenceDigest: 'b'.repeat(64), reason: 'source-correction' };
        if (kind === 'route') rows[0].resolution.route.target.path = '/different/saved.png';
        if (kind === 'proof') rows[0].resolution.provenance.artifactLocation.sha256 = 'c'.repeat(64);
        lease.store.setState(previous => ({ ...previous, rows: kind === 'missing' ? [] : rows }));
        image.closest('button').click(); // source publication and handler precede React commit
        assert.equal(f.fileOpenCalls.length, kind === 'clock-only' ? 1 : 0);
        assert.equal(f.nativeCalls.length, nativeReads, 'direct/decline stays synchronous with no implicit history request');
      });
      await settle(30); assert.equal(f.fileOpenCalls.length, kind === 'clock-only' ? 1 : 0);
    } finally { lease?.dispose(); await f.dispose(); }
  });
});

test('a later direct native refusal owns its status after cancelling older Checking', async () => {
  const h = await heldImageIntent({ holdValidation: true });
  try {
    await act(async () => { h.gates.shift()(); await tick(); }); await until(() => h.gates.length === 1);
    h.f.fileOpenAccepted(false);
    await act(async () => h.image.closest('button').click());
    assert.equal(h.f.fileOpenCalls.length, 1);
    await settle(25); assert.match(h.card.querySelector('[data-turn-result-open-status]')?.textContent ?? '', /not accepted/);
    await h.release(); await settle(25); assert.match(h.card.querySelector('[data-turn-result-open-status]')?.textContent ?? '', /not accepted/);
  } finally { await h.close(); }
});

async function heldImageIntent(options = {}) {
  const f = await fixture(1, true, { owner: 'turn-result-images', fileRoute: true, loadedImage: true, nativeItems: true, ...options });
  await until(() => document.querySelector('[data-result-key="row-0"] img'));
  const image = document.querySelector('[data-result-key="row-0"] img'), card = image.closest('[data-result-key]');
  const original = f.sdk.threads.timeline, gates = [], calls = []; let free = false;
  f.sdk.threads.timeline = async input => {
    calls.push(input);
    if (!free && (calls.length === 1 || options.holdValidation && calls.length === 2)) await new Promise(resolve => gates.push(resolve));
    return original(input);
  };
  await f.notify(); await until(() => gates.length === 1);
  let trackedLease, restoreTracking = () => {}, activeWatch = 0;
  const listeners = new Set();
  if (options.trackWatch) {
    trackedLease = f.runtime().retain({ threadId: 'thread', turnId: 'turn-0', rowId: 'opaque-0', sourceSeqStart: 1,
      sourceSeqEnd: 5, turnSeqStart: 1, turnSeqEnd: 5, historySnapshot: 'public-snapshot' }, false);
    const store = trackedLease.store, subscribe = store.subscribe;
    store.subscribe = function(listener) { activeWatch++; const sub = subscribe.call(this, listener); let live = true;
      return { unsubscribe() { if (live) { live = false; activeWatch--; sub.unsubscribe(); } } }; };
    const add = document.addEventListener, remove = document.removeEventListener;
    const types = new Set(['pointerdown', 'keydown', 'focusin', 'visibilitychange']);
    document.addEventListener = function(type, listener, ...rest) { if (types.has(type)) listeners.add(listener); return add.call(this, type, listener, ...rest); };
    document.removeEventListener = function(type, listener, ...rest) { if (types.has(type)) listeners.delete(listener); return remove.call(this, type, listener, ...rest); };
    restoreTracking = () => { store.subscribe = subscribe; document.addEventListener = add; document.removeEventListener = remove; trackedLease.dispose(); };
  }
  await act(async () => {
    if (options.keyboard) image.closest('button').dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    image.closest('button').dispatchEvent(new f.dom.window.MouseEvent('click', { bubbles: true, detail: options.keyboard ? 0 : 1 }));
  });
  assert.match(card.querySelector('[data-turn-result-open-status]')?.textContent ?? '', /Checking/);
  return { f, image, card, calls, gates, original,
    pendingResources: () => ({ subscriptions: activeWatch, listeners: listeners.size }),
    async release() { free = true; await act(async () => { for (const resolve of gates.splice(0)) resolve(); await tick(); }); },
    async close() { free = true; for (const resolve of gates.splice(0)) resolve(); f.sdk.threads.timeline = original; restoreTracking(); await f.dispose(); } };
}

test('Checking accepts dated clocks, one ambiguous activity restart, keyboard gesture and SDK focus only after cleanup', async () => {
  const h = await heldImageIntent({ captureRuntime: true, holdValidation: true, keyboard: true, focusOnFileOpen: true, trackWatch: true });
  const { f } = h; let lease;
  try {
    await act(async () => { h.gates.shift()(); await tick(); }); await until(() => h.gates.length === 1);
    const rt = f.runtime(); lease = rt.retain({ threadId: 'thread', turnId: 'turn-0', rowId: 'opaque-0',
      sourceSeqStart: 1, sourceSeqEnd: 5, turnSeqStart: 1, turnSeqEnd: 5, historySnapshot: 'public-snapshot' }, false);
    assert.deepEqual(h.pendingResources(), { subscriptions: 1, listeners: 3 });
    await act(async () => lease.store.setState(previous => ({ ...previous, rows: previous.rows.map(row => ({ ...row,
      freshness: 'disconnected', currentAvailability: { state: 'unknown', asOf: 100, expiresAt: null } })) })));
    await f.notify(); await f.notify(); // same thread-only active/idle/correction carrier: ambiguous, not hard cancel
    assert.equal(f.fileOpenCalls.length, 0);
    await h.release(); await until(() => f.fileOpenCalls.length === 1);
    assert.equal(h.card.querySelector('[data-turn-result-open-status]'), null);
    assert.ok(h.calls.length <= 5, 'one coalesced restart, no unbounded latest loop');
    await settle(100); assert.equal(f.fileOpenCalls.length, 1); assert.deepEqual(h.pendingResources(), { subscriptions: 0, listeners: 0 });
  } finally { lease?.dispose(); await h.close(); }
});

test('Checking uses genuine fresh latest/opaque older chain for the captured complete target', async () => {
  const h = await heldImageIntent(); const { f } = h; const issued = [];
  try {
    f.sdk.threads.timeline = async input => {
      issued.push(input); const page = await h.original(input);
      return input.beforeAnchorId ? { ...page, timelinePage: { historySnapshot: 'genuine-new-B', olderCursor: null } }
        : { ...page, rows: [{ id: 'newer-public-row', threadId: 'thread', turnId: 'newer-turn', kind: 'turn', status: 'completed', sourceSeqStart: 10, sourceSeqEnd: 15 }],
          timelinePage: { historySnapshot: 'genuine-new-B', olderCursor: { anchorId: 'opaque-issued-B', anchorSeq: 10 } } };
    };
    await h.release(); await until(() => f.fileOpenCalls.length === 1);
    assert.equal(issued[0].beforeAnchorId, undefined); assert.equal(issued[1].beforeAnchorId, 'opaque-issued-B');
    assert.equal(issued[1].beforeAnchorSeq, '10'); assert.equal(f.fileOpenCalls.length, 1);
  } finally { await h.close(); }
});

test('Checking rejects actual target/source/physical/user changes and fences late ignored reads', async t => {
  for (const kind of ['revision', 'identity', 'proof', 'sha', 'route', 'saved-unavailable', 'explicit-unavailable', 'expired', 'retracted', 'source-ABA', 'pending-boundary', 'boundary-change', 'row-replacement', 'row-remove-readd', 'hidden', 'unload', 'later-gesture']) await t.test(kind, async () => {
    const h = await heldImageIntent({ captureRuntime: kind === 'source-ABA' }); const { f } = h; let lease;
    try {
      if (['revision', 'identity', 'proof', 'sha', 'route', 'saved-unavailable', 'explicit-unavailable', 'expired', 'retracted'].includes(kind)) {
        const rows = structuredClone(f.rows());
        if (kind === 'revision') rows[0].resolution.revision.sequence++;
        if (kind === 'identity') { rows[0].identity.artifact.id = 'changed-artifact'; rows[0].resolution.identity = rows[0].identity; }
        if (kind === 'proof') { rows[0].identity.evidence.selectedDigest = 'c'.repeat(64); rows[0].resolution.proof.selectedDigest = 'c'.repeat(64); }
        if (kind === 'sha') rows[0].resolution.provenance.artifactLocation.sha256 = 'c'.repeat(64);
        if (kind === 'route') rows[0].resolution.route.target.path = '/different/result.png';
        if (kind === 'saved-unavailable') { rows[0].resolution.availability.state = 'unavailable'; rows[0].currentAvailability = { state: 'unknown', asOf: 1, expiresAt: null }; }
        if (kind === 'explicit-unavailable') rows[0].currentAvailability = { state: 'unavailable', asOf: 2, expiresAt: null, reason: 'target-unavailable' };
        if (kind === 'expired') rows[0].sourceExpired = { epoch: 'fixture', sequence: 2 };
        if (kind === 'retracted') rows[0].retracted = { revision: { epoch: 'fixture', sequence: 2 }, supersedesEvidenceDigest: 'b'.repeat(64), reason: 'source-correction' };
        f.setRows(rows);
      }
      if (kind === 'source-ABA') {
        lease = f.runtime().retain({ threadId: 'thread', turnId: 'turn-0', rowId: 'opaque-0', sourceSeqStart: 1,
          sourceSeqEnd: 5, turnSeqStart: 1, turnSeqEnd: 5, historySnapshot: 'public-snapshot' }, false);
        const before = lease.store.state;
        await act(async () => { lease.store.setState({ ...before, rows: before.rows.map(row => ({ ...row, resolution: { ...row.resolution,
          revision: { ...row.resolution.revision, sequence: 2 } } })) }); lease.store.setState(before); });
      }
      if (kind === 'pending-boundary' || kind === 'boundary-change') f.sdk.threads.timeline = async input => {
        const page = await h.original(input); return { ...page, rows: page.rows.map(row => kind === 'pending-boundary'
          ? { ...row, status: 'pending' } : { ...row, sourceSeqEnd: 6 }) };
      };
      if (kind === 'row-replacement') document.querySelector('[data-timeline-row-id="opaque-0"]').replaceWith(document.createElement('div'));
      if (kind === 'row-remove-readd') { const row = document.querySelector('[data-timeline-row-id="opaque-0"]'), parent = row.parentElement; row.remove(); parent.append(row); }
      if (kind === 'hidden') await f.hidden(true);
      if (kind === 'unload') await act(async () => f.controller.abort());
      if (kind === 'later-gesture') document.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await h.release(); await settle(220); assert.equal(f.fileOpenCalls.length, 0);
      const calls = h.calls.length; await settle(80); assert.equal(h.calls.length, calls, 'no late replay/idle validation retry');
    } finally { lease?.dispose(); await h.close(); }
  });
});

test('Checking stops after four genuine older pages when its captured historical boundary remains unplaced', async () => {
  const h = await heldImageIntent(); let pages = 0;
  try {
    h.f.sdk.threads.timeline = async () => {
      pages++; const seq = 1000 - pages * 10;
      return { rows: [{ id: `public-deep-${pages}`, threadId: 'thread', turnId: `public-turn-${pages}`, kind: 'turn', status: 'completed', sourceSeqStart: seq, sourceSeqEnd: seq + 5 }],
        timelinePage: { historySnapshot: 'genuine-deep', olderCursor: { anchorId: `opaque-issued-${pages}`, anchorSeq: seq } } };
    };
    await h.release(); await until(() => /complete current turn boundary/.test(h.card.textContent));
    assert.equal(pages, 4); assert.equal(h.f.fileOpenCalls.length, 0); await settle(100); assert.equal(pages, 4);
  } finally { await h.close(); }
});

test('saved unavailable masked by dated unknown blocks both direct and Checking; superseding Open has one winner', async () => {
  const f = await fixture(1, true, { owner: 'turn-result-images', fileRoute: true, loadedImage: true, nativeItems: true, savedUnavailable: true });
  try {
    await until(() => document.querySelector('img')); const button = document.querySelector('img').closest('button');
    const reads = f.nativeCalls.length; await act(async () => button.click());
    assert.equal(f.fileOpenCalls.length, 0); assert.equal(f.nativeCalls.length, reads);
    assert.match(button.closest('.tr-card').textContent, /unavailable/);
    await f.notify(); await act(async () => button.click()); assert.equal(f.fileOpenCalls.length, 0);
  } finally { await f.dispose(); }
  const h = await heldImageIntent();
  try { await act(async () => h.image.closest('button').click()); await h.release(); await until(() => h.f.fileOpenCalls.length === 1); await settle(80); assert.equal(h.f.fileOpenCalls.length, 1); }
  finally { await h.close(); }
});

test('Checking capacity preserves accepted queued debt; five-second deadline has no implicit retry', async t => {
  await t.test('actual runtime queue128', async () => {
    const f = await fixture(1, true, { owner: 'turn-result-images', fileRoute: true, loadedImage: true, nativeItems: true, captureRuntime: true });
    const controller = new AbortController(); let release = () => {};
    try {
      await until(() => document.querySelector('img') && f.runtime().stats().running === 0);
      const rt = f.runtime(), reads = Array.from({ length: 128 }, () => rt.readScope('thread', controller.signal,
        () => new Promise(resolve => { release = resolve; })).catch(() => null));
      await until(() => rt.stats().historyReads === 128);
      await f.notify(); await act(async () => document.querySelector('img').closest('button').click());
      await until(() => /capacity/.test(document.querySelector('[data-turn-result-open-status]')?.textContent ?? ''));
      assert.equal(f.fileOpenCalls.length, 0); assert.equal(rt.stats().historyReads, 128);
      controller.abort(); release(); await Promise.all(reads); await until(() => rt.stats().historyReads === 0);
    } finally { controller.abort(); release(); await f.dispose(); }
  });
  await t.test('deadline includes lane wait', async () => {
    const h = await heldImageIntent({ holdValidation: true });
    try { await settle(5100); assert.equal(h.f.fileOpenCalls.length, 0); assert.match(h.card.textContent, /deadline/);
      await h.release(); await settle(100); assert.equal(h.f.fileOpenCalls.length, 0); }
    finally { await h.close(); }
  });
});

test('cancelled Checking stays declined until a later explicit Open; native refusal remains visible', async () => {
  const f = await fixture(1, true, { fileRoute: true }); let release = () => {};
  try {
    await until(() => f.stats().live === 1);
    const card = document.querySelector('[data-result-key="row-0"]');
    const open = [...card.querySelectorAll('.tr-caption button')].find(button => button.textContent === 'Open');
    const original = f.sdk.threads.timeline;
    f.sdk.threads.timeline = async input => { await new Promise(resolve => { release = resolve; });
      const page = await original(input); return { ...page, timelinePage: { historySnapshot: 'genuinely-fresh-public-snapshot', olderCursor: null } }; };
    await act(async () => { document.querySelector('[data-timeline-row-id="opaque-0"] > button').firstChild.data = 'Native row changed'; await tick(10); });
    await act(async () => open.click());
    assert.equal(f.fileOpenCalls.length, 0, 'suspended authority cannot reach the public native port');
    assert.match(card.querySelector('[data-turn-result-open-status]')?.textContent ?? '', /Checking/);
    await act(async () => document.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    await until(() => f.nativeCalls.length >= 1 && f.stats().live === 0);
    await settle(160); f.sdk.threads.timeline = original;
    await act(async () => { release(); await tick(); }); await until(() => f.stats().live === 1);
    assert.equal(f.fileOpenCalls.length, 0, 'fresh proof never replays a prior user gesture');
    assert.ok(card.querySelector('[data-turn-result-open-status]'), 'revalidation alone does not clear the declined action');
    await act(async () => open.click());
    assert.equal(f.fileOpenCalls.length, 1); assert.equal(card.querySelector('[data-turn-result-open-status]'), null);
    f.fileOpenAccepted(false); await act(async () => open.click());
    assert.equal(f.fileOpenCalls.length, 2); assert.match(card.querySelector('[data-turn-result-open-status]').textContent, /not accepted/);
    f.fileOpenAccepted(true); assert.ok(card.querySelector('[data-turn-result-open-status]'));
    await act(async () => open.click()); assert.equal(f.fileOpenCalls.length, 3); assert.equal(card.querySelector('[data-turn-result-open-status]'), null);
  } finally { release(); await f.dispose(); }
});

test('contributor requestFull retires its custom trigger and Escape focuses the same-card stable consumer Expand', async () => {
  const f = await fixture(1, true, { customExpand: true });
  try {
    await until(() => document.querySelector('[data-contributor-expand]'));
    const custom = document.querySelector('[data-contributor-expand]');
    const card = custom.closest('[data-result-key]'), consumer = card.querySelector('.tr-caption button');
    await act(async () => { custom.focus(); custom.click(); });
    await until(() => f.stats().full === 1);
    assert.equal(custom.isConnected, false, 'the old custom trigger is retired for full mode');
    assert.equal(consumer.isConnected, true); assert.equal(consumer.closest('[data-result-key]'), card);
    await act(async () => document.querySelector('dialog').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    await until(() => !document.querySelector('dialog'));
    console.log('CONTRIBUTOR_FOCUS_RETURN', JSON.stringify({ customConnected: custom.isConnected, consumerConnected: consumer.isConnected,
      sameCard: consumer.closest('[data-result-key]') === card, consumerFocused: document.activeElement === consumer }));
    assert.ok(document.activeElement === consumer, 'Escape returns focus to the exact stable consumer Expand on the same source card');
    assert.equal(f.stats().fullPeak, 1); assert.ok(f.stats().peak <= 4); assert.equal(f.stats().rpc, 0);
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
    const sentinel = document.createElement('span'); sentinel.dataset.turnResultsSentinel = ''; document.querySelector('[data-thread-window]').append(sentinel);
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
    const sentinel = document.createElement('span'); sentinel.dataset.turnResultsSentinel = ''; document.querySelector('[data-thread-window]').append(sentinel);
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
    const sentinel = document.createElement('span'); sentinel.dataset.turnResultsSentinel = ''; document.querySelector('[data-thread-window]').append(sentinel);
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


function streamUnrelatedRow(f, token) {
  const row = f.dom.window.document.querySelector('[data-timeline-row-id="opaque-1"]');
  row.querySelector(':scope > button').firstChild.data = `Unrelated native token ${token}`;
}

test('witnessed foreign native wrapper windowing preserves healthy host and ordinary full intent', async () => {
  // Native v7 late-ring shape and public workspace turn-location metadata.
  // Thread is fixture-owned; the opaque native ID and its public turn are not parsed.
  const publicRow = { id: 'thr_ck4kx5mx8m:user-seed:5505', threadId: 'thread', turnId: 'daceb54fe5-t5',
    kind: 'conversation', role: 'user', messageSeq: 5505, sourceSeqStart: 5505, sourceSeqEnd: 5505 };
  const f = await fixture(1, true, { structuralRows: [publicRow] });
  try {
    await until(() => f.stats().live === 1);
    const target = document.querySelector('[data-timeline-row-id="opaque-0"] [data-supplier]');
    const shell = target.closest('[data-turn-results-gallery]'), parent = document.querySelector('[data-timeline-items]');
    const foreign = [...parent.children].find(node => node.dataset.timelineRowId === publicRow.id);
    const beforeReads = f.nativeCalls.length, lists = f.stats().listCalls;
    const original = f.sdk.threads.timeline; let release;
    f.sdk.threads.timeline = async input => { await new Promise(resolve => { release = resolve; }); return original(input); };
    await act(async () => { foreign.remove(); await tick(10); });
    assert.equal(document.querySelector('[data-timeline-row-id="opaque-0"] [data-supplier]'), target,
      'foreign T5 removal must not revoke the healthy T1 host while fresh proof is pending');
    await until(() => release);
    await act(async () => { parent.append(foreign); await tick(10); });
    assert.equal(target.closest('[data-turn-results-gallery]'), shell);
    await act(async () => { target.closest('article').querySelector('.tr-caption button').click(); await tick(); });
    await until(() => f.stats().full === 1);
    assert.equal(document.querySelector('[data-supplier][data-mode="full"]').dataset.supplier, 'artifact-0');
    f.sdk.threads.timeline = original; await act(async () => { release(); await tick(); });
    await until(() => f.nativeCalls.length > beforeReads);
    assert.equal(f.stats().listCalls, lists, 'native structural proof preserves ready-owner membership');
    assert.equal(f.stats().rpc, 0); assert.ok(f.stats().peak <= 4);
  } finally { await f.dispose(); }
});
function delayDescriptions(f, delay) {
  const original = f.sdk.plugins.callRpc, calls = [];
  f.sdk.plugins.callRpc = async args => {
    if (args.method !== METHODS.describe) return original(args);
    const call = { aborted: false, completed: false }; calls.push(call);
    await new Promise((resolve, reject) => {
      const aborted = () => { clearTimeout(timer); call.aborted = true; args.signal.removeEventListener('abort', aborted); reject(args.signal.reason); };
      const timer = setTimeout(() => { args.signal.removeEventListener('abort', aborted); resolve(); }, delay);
      if (args.signal.aborted) aborted(); else args.signal.addEventListener('abort', aborted, { once: true });
    });
    const value = await original(args); call.completed = true; return value;
  };
  return calls;
}

test('native fast stream preserves unchanged custom target and bounds first fresh read without idle polling', async () => {
  const f = await fixture(2);
  try {
    await until(() => f.stats().live === 2);
    const target = document.querySelector('[data-timeline-row-id="opaque-0"] [data-supplier]');
    const shell = target.closest('[data-turn-results-gallery]'), lists = f.stats().listCalls, native = f.nativeCalls.length;
    const setups = f.stats().setups;
    let unchangedReads = 0; const original = f.sdk.plugins.callRpc;
    f.sdk.plugins.callRpc = args => { if (args.method === GALLERY_METHODS.read && args.input.turnId === 'turn-0') unchangedReads++; return original(args); };
    for (let i = 0; i < 8; i++) {
      await act(async () => { streamUnrelatedRow(f, i); await tick(60); });
      assert.equal(document.querySelector('[data-timeline-row-id="opaque-0"] [data-supplier]'), target);
      assert.equal(target.closest('[data-turn-results-gallery]'), shell);
      if (i >= 3) assert.ok(f.nativeCalls.length > native, 'first150ms refresh cannot be postponed until stream ends');
    }
    assert.equal(f.stats().listCalls, lists, 'native history hints do not erase genuine ready membership');
    assert.equal(unchangedReads, 0, 'unrelated history proof cannot restart unchanged turn supplier/debt cursors');
    await until(() => f.stats().live === 2);
    assert.ok(f.stats().setups >= setups); assert.equal(f.stats().rpc, 0);
    const quietCalls = f.nativeCalls.length, quietLists = f.stats().listCalls;
    await settle(220); assert.equal(f.nativeCalls.length, quietCalls); assert.equal(f.stats().listCalls, quietLists);
  } finally { await f.dispose(); }
});

test('native changes cannot abort delayed participant pass while actual pane still demands it', async () => {
  const f = await fixture(2);
  try {
    await until(() => f.stats().live === 2);
    const calls = delayDescriptions(f, 350);
    // Genuine source invalidation starts a new pass; native proof suspension
    // during that pass must not masquerade as pane disappearance.
    await f.notify(); await until(() => calls.length === 1);
    for (let i = 0; i < 7; i++) { await act(async () => { streamUnrelatedRow(f, i); await tick(70); }); }
    assert.equal(calls.length, 1); assert.equal(calls[0].aborted, false); assert.equal(calls[0].completed, true);
    await until(() => document.querySelector('[data-timeline-row-id="opaque-0"] [data-supplier]'));
    const lists = f.stats().listCalls; await settle(200); assert.equal(f.stats().listCalls, lists);
    f.enabled(false); await f.notify(); await until(() => f.stats().live === 0);
    assert.equal(calls.at(-1).completed, true, 'disabled listing revokes readiness without owner describe');
    f.enabled(true); await f.reconnect(); await until(() => f.stats().live === 2);
  } finally { await f.dispose(); }
});


test('same-thread split keeps its exact unchanged custom host while another pane streams native content', async () => {
  const f = await fixture(2); let rightSlot;
  try {
    await until(() => f.stats().live === 2);
    const right = document.createElement('section'); right.dataset.threadWindow = '';
    right.innerHTML = '<div data-timeline-row-list="top-level"><div data-timeline-row-id="opaque-0"><button>Right native row</button></div></div>';
    document.body.append(right);
    const Sentinel = f.app.threadHeaderActions[0].component;
    const frame = document.createElement('section'); frame.dataset.splitPaneId = 'right';
    const group = document.createElement('span'); group.setAttribute('role', 'group');
    frame.append(group, right); document.body.append(frame);
    let rightReads = 0; const rightNavigation = [];
    const sdk = { ...f.sdk, threads: { ...f.sdk.threads, timeline(input) { rightReads++; return f.sdk.threads.timeline(input); } } };
    await act(async () => { rightSlot = renderSlot({ component: () => createPortal(h(Sentinel, { threadId: 'thread', projectId: 'project', isCompactViewport: false }), group) }, {}, {
      sdk, composer: { scope: { kind: 'thread', threadId: 'thread' } }, realtimeConnectionState: 'connected',
      openUrl(url) { rightNavigation.push(url); return true; },
    }); });
    await until(() => right.querySelector('[data-supplier]') && f.stats().live === 3);
    const host = right.querySelector('[data-supplier]'), shell = host.closest('[data-turn-results-gallery]'), reads = rightReads;
    for (let i = 0; i < 7; i++) {
      await act(async () => { streamUnrelatedRow(f, i); await tick(60); });
      assert.equal(right.querySelector('[data-supplier]'), host);
    }
    assert.equal(rightReads, reads); assert.equal(host.closest('[data-turn-results-gallery]'), shell);
    const before = f.navigation.length; await act(async () => host.click()); assert.equal(rightNavigation.length, 1); assert.equal(f.navigation.length, before, 'the right native surface uses its own public navigation context');
    assert.ok(f.stats().peak <= 4);
  } finally { if (rightSlot) await act(async () => rightSlot.unmount()); await f.dispose(); }
});

test('exact native row mutation revokes custom callbacks before fresh proof; unload fences delayed discovery', async () => {
  const f = await fixture(1);
  try {
    await until(() => f.stats().live === 1);
    const old = f.captured.at(-1), before = f.navigation.length;
    const native = document.querySelector('[data-timeline-row-id="opaque-0"] > button');
    await act(async () => { native.firstChild.data = 'This target changed'; await tick(10); });
    old.navigate.openUrl('https://fixture.invalid/stale-target'); old.requestFull();
    assert.equal(f.navigation.length, before); assert.equal(document.querySelector('dialog'), null);
    await until(() => f.stats().live === 1);
    const calls = delayDescriptions(f, 350);
    await f.notify(); await until(() => calls.length === 1);
    await act(async () => f.controller.abort());
    await until(() => f.stats().live === 0);
    assert.equal(calls[0].aborted, true);
    const lists = f.stats().listCalls; await settle(400);
    assert.equal(f.stats().live, 0); assert.equal(f.stats().listCalls, lists);
  } finally { await f.dispose(); }
});

test('earlier public row of same proven turn invalidates its terminal custom host; unknown scope stays broad', async () => {
  const f = await fixture(2);
  try {
    await until(() => f.stats().live === 2);
    const original = f.sdk.threads.timeline;
    f.sdk.threads.timeline = async input => {
      const page = await original(input);
      return { ...page, rows: [{ id: 'public-earlier-sibling', threadId: 'thread', turnId: 'turn-0', kind: 'conversation', role: 'assistant', status: 'completed', sourceSeqStart: 1, sourceSeqEnd: 2 },
        { ...page.rows[0], sourceSeqStart: 3 }, page.rows[1]], timelinePage: { historySnapshot: 'public-multirow-turn', olderCursor: null } };
    };
    const sibling = document.createElement('div'); sibling.dataset.timelineRowId = 'public-earlier-sibling'; sibling.innerHTML = '<button>Earlier native row in same turn</button>';
    document.querySelector('[data-timeline-row-list="top-level"]').prepend(sibling);
    await until(() => f.stats().live === 2 && f.nativeCalls.length >= 2);
    await settle(180); // Let this structural hint commit its new public scope.
    const old = f.captured.findLast(props => props.identity.id === 'artifact-0'), other = document.querySelector('[data-timeline-row-id="opaque-1"] [data-supplier]');
    const before = f.navigation.length;
    await act(async () => { sibling.querySelector('button').firstChild.data = 'Earlier same-turn row changed'; await tick(10); });
    old.navigate.openUrl('https://fixture.invalid/stale-sibling'); assert.equal(f.navigation.length, before);
    assert.equal(document.querySelector('[data-timeline-row-id="opaque-0"] [data-supplier]'), null);
    assert.equal(document.querySelector('[data-timeline-row-id="opaque-1"] [data-supplier]'), other);
    await until(() => f.stats().live === 2);
    const unknown = document.createElement('aside'); unknown.textContent = 'Native structural change';
    await act(async () => { document.querySelector('[data-thread-window]').append(unknown); await tick(10); });
    assert.equal(f.stats().live, 0, 'unknown pane structure conservatively invalidates every docked boundary');
    await until(() => f.stats().live === 2);
  } finally { await f.dispose(); }
});

function navigationProbe() {
  const probe = { rendered: 0, committed: null, calls: [], originalSdk: null, sdkOverride: null };
  globalThis.__turnResultsNavigationFixture = probe; return probe;
}
test('fresh public navigation objects/callbacks preserve scope, host and discovery; actions use latest committed callbacks', async () => {
  const probe = navigationProbe(), f = await fixture(1, true, { definition: navigationDefinition });
  try {
    await until(() => f.stats().live === 1);
    const host = document.querySelector('[data-supplier]'), captured = f.captured.at(-1);
    const initial = { native: f.nativeCalls.length, lists: f.stats().listCalls, setups: f.stats().setups, cleanups: f.stats().cleanups };
    for (let i = 0; i < 13; i++) {
      await f.rerender(); assert.equal(document.querySelector('[data-supplier]'), host);
    }
    assert.ok(probe.rendered >= 14); assert.equal(probe.committed, probe.rendered);
    assert.deepEqual({ native: f.nativeCalls.length, lists: f.stats().listCalls, setups: f.stats().setups, cleanups: f.stats().cleanups }, initial);
    const before = f.navigation.length;
    captured.navigate.openUrl('https://fixture.invalid/latest-committed');
    assert.equal(f.navigation.length, before + 1); assert.equal(probe.calls.at(-1).version, probe.committed);
    await act(async () => [...host.closest('.tr-card').querySelectorAll('.tr-caption button')].find(button => button.textContent === 'Open').click());
    assert.equal(probe.calls.at(-1).version, probe.committed);
    await f.reconnect(); await until(() => f.stats().live === 1 && f.nativeCalls.length > initial.native);
    const recovered = f.nativeCalls.length, recoveredLists = f.stats().listCalls;
    await f.rerender(); await settle(180);
    assert.equal(f.nativeCalls.length, recovered); assert.equal(f.stats().listCalls, recoveredLists);
  } finally { await f.dispose(); delete globalThis.__turnResultsNavigationFixture; }
});

test('speculative navigation render cannot publish callbacks before real React commit', async () => {
  const probe = navigationProbe(); let blocked = false, release;
  const gate = new Promise(resolve => { release = resolve; });
  function Gate() { if (blocked) throw gate; return null; }
  let Wrapper;
  const f = await fixture(1, true, { definition: navigationDefinition, wrapBanner(Sentinel) {
    Wrapper = function Wrapper(props) { return h(Suspense, { fallback: h('span', { 'data-test-fallback': '' }, 'Waiting') }, h(Sentinel, props), h(Gate)); };
    return Wrapper;
  } });
  try {
    await until(() => f.stats().live === 1);
    const host = document.querySelector('[data-supplier]'), captured = f.captured.at(-1), committed = probe.committed;
    const native = f.nativeCalls.length, lists = f.stats().listCalls;
    blocked = true;
    await act(async () => { startTransition(() => f.slot().lifecycle.rerender(f.element())); await tick(15); });
    assert.ok(probe.rendered > committed); assert.equal(probe.committed, committed);
    assert.equal(document.querySelector('[data-supplier]'), host);
    const before = f.navigation.length; captured.navigate.openUrl('https://fixture.invalid/while-speculative');
    assert.equal(f.navigation.length, before + 1); assert.equal(probe.calls.at(-1).version, committed, 'only previous committed API may act');
    blocked = false; await act(async () => { release(); await tick(20); });
    await until(() => probe.committed !== null && probe.committed > committed);
    console.log('NAVIGATION_COMMIT_FENCE', JSON.stringify({ previousCommitted: committed, rendered: probe.rendered, nextCommitted: probe.committed }));
    assert.equal(document.querySelector('[data-supplier]'), host);
    captured.navigate.openUrl('https://fixture.invalid/after-commit'); assert.equal(probe.calls.at(-1).version, probe.committed);
    assert.equal(f.nativeCalls.length, native); assert.equal(f.stats().listCalls, lists);
    await act(async () => f.controller.abort());
    const calls = probe.calls.length; captured.navigate.openUrl('https://fixture.invalid/after-retirement'); assert.equal(probe.calls.length, calls);
  } finally { blocked = false; release(); await f.dispose(); delete globalThis.__turnResultsNavigationFixture; }
});

test('real SDK/thread scope replacement fences old navigation and A-to-B-to-A cannot revive stale callbacks', async () => {
  const probe = navigationProbe(), f = await fixture(1, true, { definition: navigationDefinition });
  try {
    await until(() => f.stats().live === 1);
    const old = f.captured.at(-1), originalReads = f.nativeCalls.length;
    probe.sdkOverride = Object.create(probe.originalSdk); await f.rerender();
    await until(() => f.stats().live === 1 && f.captured.at(-1) !== old && f.nativeCalls.length > originalReads);
    const calls = probe.calls.length; old.navigate.openUrl('https://fixture.invalid/old-sdk'); assert.equal(probe.calls.length, calls);
    const beforeScope = f.captured.at(-1);
    await f.thread('other-thread'); await until(() => f.stats().live === 0);
    beforeScope.navigate.openUrl('https://fixture.invalid/old-scope'); assert.equal(probe.calls.length, calls);
    await f.thread('thread'); await until(() => f.stats().live === 1);
    beforeScope.navigate.openUrl('https://fixture.invalid/reused-scope'); assert.equal(probe.calls.length, calls);
    f.captured.at(-1).navigate.openUrl('https://fixture.invalid/current-scope'); assert.equal(probe.calls.length, calls + 1);
    assert.equal(probe.calls.at(-1).version, probe.committed);
  } finally { await f.dispose(); delete globalThis.__turnResultsNavigationFixture; }
});

test('timeline-only registration has no composer/panel/overlay and hides only its own header wrapper', async () => {
  const f = await fixture(1);
  try {
    await until(() => f.stats().live === 1);
    assert.equal(f.app.composerCustomizations.length, 0); assert.equal(f.app.threadPanelActions.length, 0); assert.equal(f.app.appOverlays.length, 0);
    const marker = document.querySelector('[data-turn-results-bridge]'); assert.equal(marker.hidden, true);
    const style = document.createElement('style'); style.textContent = readFileSync(new URL('../app.css', import.meta.url), 'utf8').split('\n').find(line => line.includes(':has(> span[role="group"] > [data-turn-results-bridge])'));
    document.head.append(style);
    const group = marker.parentElement, pluginRoot = group.parentElement;
    assert.equal(pluginRoot.hasAttribute('data-bb-plugin-root'), true); assert.equal(pluginRoot.dataset.bbPlugin, 'turn-results');
    assert.equal(window.getComputedStyle(pluginRoot).display, 'none');
    const foreign = document.createElement('div'); foreign.dataset.bbPluginRoot = ''; foreign.dataset.bbPlugin = 'other-plugin';
    foreign.innerHTML = '<span role="group"><span data-turn-results-bridge></span></span>'; pluginRoot.parentElement.append(foreign);
    assert.notEqual(window.getComputedStyle(foreign).display, 'none', 'other native/plugin groups remain unchanged');
    assert.equal(document.querySelector('[data-turn-results-sentinel]').hidden, true);
    assert.equal(document.querySelector('[data-turn-results-notice]'), null, 'settled healthy views have no status strip');
  } finally { await f.dispose(); }
});

test('matching successful unchanged dialog observation clears its error and a held older refresh cannot overwrite new facts', async () => {
  const f = await fixture(1, true, { captureRuntime: true }); let release = () => {}, original;
  try {
    await until(() => f.stats().live === 1);
    await act(async () => document.querySelector('.tr-caption button').click()); await until(() => f.stats().full === 1);
    const runtime = f.runtime(); original = runtime.refreshDialogRow;
    runtime.refreshDialogRow = async () => { throw Error('fixture manual refresh failure'); };
    const refresh = () => [...document.querySelectorAll('dialog button')].find(button => button.textContent === 'Refresh saved result');
    await act(async () => refresh().click()); await until(() => document.querySelector('dialog').textContent.includes('could not be refreshed'));
    await f.notify(); await until(() => !document.querySelector('dialog').textContent.includes('could not be refreshed') && f.stats().full === 1);
    const old = structuredClone(f.rows()[0]);
    runtime.refreshDialogRow = async () => new Promise(resolve => { release = () => resolve(old); });
    await act(async () => refresh().click());
    const changed = structuredClone(f.rows()); changed[0].resolution.revision.sequence = 2; changed[0].resolution.presentation.data.label = 'New authoritative observation';
    f.setRows(changed); await f.notify(); await until(() => document.querySelector('dialog [data-supplier]')?.textContent === 'New authoritative observation');
    await act(async () => { release(); await tick(); }); await settle(30);
    assert.equal(document.querySelector('dialog [data-supplier]').textContent, 'New authoritative observation');
    assert.equal(document.querySelector('dialog').textContent.includes('could not be refreshed'), false);
  } finally { release(); if (original) f.runtime().refreshDialogRow = original; await f.dispose(); }
});

test('closing a dialog releases modal interaction and exact opener focus while root cleanup credit remains held', async () => {
  const f = await fixture(1, true, { captureRuntime: true }); let release = () => {};
  try {
    await until(() => f.stats().live === 1);
    const runtime = f.runtime(), original = runtime.presentationRoot;
    runtime.presentationRoot = (...args) => {
      const scope = original(...args);
      return { ...scope, beginDisposal() { const finish = scope.beginDisposal(); return () => { release = finish; }; } };
    };
    const opener = document.querySelector('.tr-caption button'); await act(async () => { opener.focus(); opener.click(); });
    await until(() => f.stats().full === 1);
    const dialog = document.querySelector('dialog');
    await act(async () => [...dialog.querySelectorAll('button')].find(button => button.textContent === 'Close expanded result').click());
    await until(() => dialog.hidden && f.stats().full === 0);
    assert.equal(dialog.open, false); assert.equal(document.activeElement, opener);
    assert.equal(runtime.canvases.counts().retiring, 1); assert.ok(dialog.isConnected, 'DOM/accounting waits for real acknowledgment even though modal is closed');
    runtime.presentationRoot = original;
    await act(async () => { release(); await tick(); }); await until(() => !dialog.isConnected);
    assert.equal(runtime.canvases.counts().retiring, 0);
  } finally { release(); await f.dispose(); }
});

test('later inline page Checking validates the exact issued retained cursor and opens once after fresh public proof', async () => {
  const f = await fixture(1, true, { owner: 'turn-result-images', fileRoute: true, loadedImage: true }); let release = () => {};
  try {
    await until(() => document.querySelector('[data-result-key="row-0"] img'));
    const nativePage = await f.sdk.threads.timeline({ threadId: 'thread' });
    const rows = Array.from({ length: 17 }, (_, i) => { const row = structuredClone(f.rows()[0]); row.key = `paged-${i}`; row.firstObservedOrder = i;
      row.identity.ref.member = `image:${i}`; row.identity.artifact.id = `image-${i}`; row.resolution.identity = row.identity; return row; });
    f.setRows(rows); f.sdk.threads.timeline = async () => nativePage;
    await f.notify(); await until(() => document.querySelector('[data-result-key="paged-0"] img'));
    const more = () => [...document.querySelectorAll('.tr-more')].find(button => button.textContent === 'Show more results');
    await until(() => more() && !more().disabled);
    await act(async () => more().click());
    if (!document.querySelector('[data-result-key="paged-8"]')) await act(async () => more().click());
    await until(() => document.querySelector('[data-result-key="paged-8"] img'));
    const image = document.querySelector('[data-result-key="paged-8"] img'), blob = image.src;
    const reads = [], originalRpc = f.sdk.plugins.callRpc;
    f.sdk.plugins.callRpc = async args => { if (args.method === GALLERY_METHODS.read) reads.push(args.input); return originalRpc(args); };
    let held = 0;
    f.sdk.threads.timeline = async () => { held++; await new Promise(resolve => { release = resolve; }); return nativePage; };
    await f.notify(); await until(() => held === 1);
    await act(async () => image.closest('button').click());
    assert.equal(f.fileOpenCalls.length, 0); assert.match(image.closest('.tr-card').textContent, /Checking/);
    f.sdk.threads.timeline = async () => nativePage;
    await act(async () => { release(); await tick(); }); await until(() => f.fileOpenCalls.length === 1);
    assert.ok(reads.some(read => read.after?.key === 'paged-7'), 'action final retained read uses the SAME issued display cursor');
    assert.equal(document.querySelector('[data-result-key="paged-8"] img'), image); assert.equal(image.src, blob);
    await settle(40); assert.equal(f.fileOpenCalls.length, 1);
  } finally { release(); await f.dispose(); }
});

test('observed header/window remove-readd cannot revive old navigation before fresh public scope proof', async () => {
  const f = await fixture(1); let release = () => {}, original;
  try {
    await until(() => f.stats().live === 1);
    const old = f.captured.at(-1), frame = document.querySelector('[data-split-pane-id]');
    original = f.sdk.threads.timeline; let reads = 0;
    f.sdk.threads.timeline = async input => { reads++; await new Promise(resolve => { release = resolve; }); return original(input); };
    await act(async () => { frame.remove(); document.body.append(frame); await tick(); });
    await until(() => reads === 1);
    const before = f.navigation.length; old.navigate.openUrl('https://fixture.invalid/old-reparented-scope'); assert.equal(f.navigation.length, before);
    f.sdk.threads.timeline = original;
    await act(async () => { release(); await tick(); }); await until(() => f.stats().live === 1);
    const current = f.captured.at(-1); assert.notEqual(current, old);
    current.navigate.openUrl('https://fixture.invalid/fresh-reparented-scope'); assert.equal(f.navigation.length, before + 1);
  } finally { release(); if (original) f.sdk.threads.timeline = original; await f.dispose(); }
});

test('header bridge follows remapped/replaced physical witnesses and permanently retires observed successor-window ABA', async t => {
  for (const mode of ['split remapping', 'window replacement']) await t.test(mode, async () => {
    const f = await fixture(1), releases = [], callbacks = []; const original = f.sdk.threads.timeline;
    try {
      await until(() => f.stats().live === 1);
      const first = f.captured.at(-1), a = document.querySelector('[data-split-pane-id="left"]'); callbacks.push(first);
      const header = a.querySelector('header'); let frame = a, pane;
      if (mode === 'split remapping') {
        frame = document.createElement('section'); frame.dataset.splitPaneId = 'right';
        frame.innerHTML = '<section data-thread-window><div data-timeline-row-list="top-level"><div data-timeline-row-id="opaque-0"><button>Native fixture row</button></div></div></section>';
        await act(async () => { document.body.append(frame); frame.prepend(header); await tick(); });
        pane = frame.querySelector('[data-thread-window]');
      } else {
        pane = document.createElement('section'); pane.dataset.threadWindow = '';
        pane.innerHTML = '<div data-timeline-row-list="top-level"><div data-timeline-row-id="opaque-0"><button>Native replacement fixture row</button></div></div>';
        await act(async () => { a.querySelector('[data-thread-window]').replaceWith(pane); await tick(); });
      }
      await until(() => pane.querySelector('[data-supplier]') && f.stats().live === 1 && f.captured.at(-1) !== first);
      const current = f.captured.at(-1); callbacks.push(current);
      current.navigate.openUrl('https://fixture.invalid/current-successor-window');
      assert.equal(f.navigation.length, 1, 'fresh successor mapping is usable');
      first.navigate.openUrl('https://fixture.invalid/retired-initial-window');
      assert.equal(f.navigation.length, 1, 'remapping never revives the initial callback');
      const quietReads = f.nativeCalls.length, quietSetups = f.stats().setups;
      await act(async () => {
        const decoration = document.createElement('span'); header.append(decoration); decoration.textContent = 'Native header decoration';
        if (mode === 'split remapping') { const oldDecoration = document.createElement('span'); a.append(oldDecoration); oldDecoration.textContent = 'Unrelated old scope'; }
        await tick();
      });
      assert.equal(f.nativeCalls.length, quietReads, 'unrelated old-scope/header decoration causes no fresh history read');
      assert.equal(f.stats().setups, quietSetups); assert.equal(f.captured.at(-1), current);
      current.navigate.openUrl('https://fixture.invalid/unchanged-successor-window');
      assert.equal(f.navigation.length, 2, 'unrelated churn preserves the current public callback');
      const before = f.navigation.length;
      f.sdk.threads.timeline = async input => { await new Promise(resolve => releases.push(resolve)); return original(input); };
      await act(async () => { pane.remove(); frame.append(pane); await tick(); });
      current.navigate.openUrl('https://fixture.invalid/stale-after-successor-window-ABA');
      assert.equal(f.navigation.length, before, 'observed successor-window removal/readd revokes the old callback before fresh proof');
      await until(() => releases.length === 1);
      assert.equal(releases.length, 1, 'one bounded fresh public read waits for the new token');
      f.sdk.threads.timeline = original;
      await act(async () => { for (const release of releases.splice(0)) release(); await tick(); });
      await until(() => pane.querySelector('[data-supplier]') && f.stats().live === 1 && f.captured.at(-1) !== current);
      const fresh = f.captured.at(-1); callbacks.push(fresh);
      current.navigate.openUrl('https://fixture.invalid/still-retired-after-fresh-proof');
      first.navigate.openUrl('https://fixture.invalid/initial-still-retired-after-fresh-proof');
      assert.equal(f.navigation.length, before, 'fresh proof cannot revive either retired token');
      fresh.navigate.openUrl('https://fixture.invalid/fresh-successor-window');
      assert.equal(f.navigation.length, before + 1, 'fresh public proof admits the new callback');
    } finally {
      f.sdk.threads.timeline = original;
      await act(async () => { for (const release of releases.splice(0)) release(); await tick(); });
      await f.dispose();
      const before = f.navigation.length;
      for (const callback of callbacks) callback.navigate.openUrl('https://fixture.invalid/retired-after-unmount');
      assert.equal(f.navigation.length, before, 'cleanup permanently revokes every captured bridge token');
    }
  });
});

test('detached header scope retains one known-parent recovery trigger without navigation authority, then follows its current parent', async () => {
  const f = await fixture(1), releases = [], callbacks = []; const original = f.sdk.threads.timeline;
  try {
    await until(() => f.stats().live === 1);
    const old = f.captured.at(-1), frame = document.querySelector('[data-split-pane-id="left"]'); callbacks.push(old);
    await act(async () => { frame.remove(); await tick(); });
    await until(() => f.stats().live === 0);
    const detachedReads = f.nativeCalls.length;
    old.navigate.openUrl('https://fixture.invalid/while-detached'); assert.equal(f.navigation.length, 0);
    await act(async () => { const unrelated = document.createElement('section'); unrelated.dataset.threadWindow = ''; document.body.append(unrelated); await tick(); });
    assert.equal(f.nativeCalls.length, detachedReads, 'unrelated known-parent child changes cannot invent a mapping or start reads');
    assert.equal(f.stats().live, 0);
    f.sdk.threads.timeline = async input => { await new Promise(resolve => releases.push(resolve)); return original(input); };
    await act(async () => { document.body.append(frame); await tick(); });
    await until(() => releases.length === 1);
    assert.equal(releases.length, 1, 'separately delivered known-parent reattachment starts one bounded fresh proof');
    assert.equal(f.nativeCalls.length, detachedReads); assert.equal(f.stats().live, 0, 'recovery observation alone does not admit a custom host');
    old.navigate.openUrl('https://fixture.invalid/held-proof-after-reattachment'); assert.equal(f.navigation.length, 0);
    f.sdk.threads.timeline = original;
    await act(async () => { for (const release of releases.splice(0)) release(); await tick(); });
    await until(() => f.stats().live === 1 && f.captured.at(-1) !== old);
    assert.equal(f.nativeCalls.length, detachedReads + 1);
    const fresh = f.captured.at(-1); callbacks.push(fresh);
    old.navigate.openUrl('https://fixture.invalid/retired-after-fresh-proof'); assert.equal(f.navigation.length, 0);
    fresh.navigate.openUrl('https://fixture.invalid/fresh-after-known-parent-recovery'); assert.equal(f.navigation.length, 1);
    const nextParent = document.createElement('section');
    await act(async () => { document.body.append(nextParent); nextParent.append(frame); await tick(); });
    await until(() => f.stats().live === 1 && f.captured.at(-1) !== fresh);
    const remapped = f.captured.at(-1); callbacks.push(remapped);
    fresh.navigate.openUrl('https://fixture.invalid/old-after-parent-rebind'); assert.equal(f.navigation.length, 1);
    remapped.navigate.openUrl('https://fixture.invalid/current-parent-proved'); assert.equal(f.navigation.length, 2);
    await act(async () => { frame.remove(); await tick(); });
    await until(() => f.stats().live === 0);
    const movedReads = f.nativeCalls.length;
    remapped.navigate.openUrl('https://fixture.invalid/detached-from-new-parent'); assert.equal(f.navigation.length, 2);
    await act(async () => { nextParent.append(frame); await tick(); });
    await until(() => f.stats().live === 1 && f.captured.at(-1) !== remapped);
    assert.equal(f.nativeCalls.length, movedReads + 1, 'later recovery follows the newly proved actual parent');
    const recovered = f.captured.at(-1); callbacks.push(recovered);
    remapped.navigate.openUrl('https://fixture.invalid/old-after-new-parent-recovery'); assert.equal(f.navigation.length, 2);
    recovered.navigate.openUrl('https://fixture.invalid/new-parent-recovered'); assert.equal(f.navigation.length, 3);
  } finally {
    f.sdk.threads.timeline = original;
    await act(async () => { for (const release of releases.splice(0)) release(); await tick(); });
    await f.dispose();
    const before = f.navigation.length;
    for (const callback of callbacks) callback.navigate.openUrl('https://fixture.invalid/retired-recovery-after-unmount');
    assert.equal(f.navigation.length, before, 'cleanup revokes every recovered token');
  }
});
