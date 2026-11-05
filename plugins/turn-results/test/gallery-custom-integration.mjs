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
import { createGalleryRuntime, GALLERY_RUNTIME_LIMITS as queueLimits } from '../gallery/runtime.ts';
import { mountGalleryPane } from '../gallery/pane.ts';
const navigationVariantUrl = new URL('../app.tsx?public-navigation-reference-fixture', import.meta.url).href;
const runtimeVariantUrl = new URL('../app.tsx?public-runtime-constructor-fixture', import.meta.url).href;
const startupVariantUrl = new URL('../app.tsx?startup-proof-public-fixture', import.meta.url).href;
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
    source = source.replace('targets.current = ids;', 'globalThis.__foregroundRouteBefore?.markers.push({kind: "actual-foreground-demand-publication", ids: [...ids], at: performance.now() - globalThis.__foregroundRouteBefore.started}); targets.current = ids;');
    if (url === navigationVariantUrl) source = source.replace('useBbNavigate,', 'useBbNavigate as originalUseBbNavigate,')
      .replace('useSdk,', 'useSdk as originalUseSdk,') + navigationHookFixture;
    if (url === runtimeVariantUrl) source = source.replace('module.createGalleryRuntime(sdk, work)', 'observeRuntimeFactory(module.createGalleryRuntime, sdk, work)')
      + '\nfunction observeRuntimeFactory(factory, ...args) { const owner = factory(...args); globalThis.__turnResultsRuntimeFixture?.push(owner); return owner; }';
    if (url === startupVariantUrl || url === new URL('../app.tsx?startup-continuation-public-fixture', import.meta.url).href) source = source.replaceAll("'./gallery/view.tsx'", url === startupVariantUrl ? "'./gallery/view.tsx?startup-heavy-evaluation'" : "'./gallery/view.tsx?startup-continuation-heavy-evaluation'");
    if (url === new URL('../gallery/view.tsx?startup-heavy-evaluation', import.meta.url).href || url === new URL('../gallery/view.tsx?startup-continuation-heavy-evaluation', import.meta.url).href) source = 'globalThis.__startupHeavyEvaluation.entered = true; await globalThis.__startupHeavyEvaluation.gate; globalThis.__startupHeavyEvaluation.evaluated = true;\n' + source;
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
  const dom = new JSDOM(`<body><section data-split-pane-id="left"><header><div data-thread-header-workflow-actions><div data-bb-plugin-root data-bb-plugin="turn-results" class="contents"><span role="group" data-fixture-header></span></div></div></header><section data-thread-window>${contribution.nativeItems ? '<div data-native-chrome><div></div></div>' : ''}<div data-timeline-row-list="top-level">${structuralRows.length || contribution.nativeItems ? `<div data-timeline-items class="relative w-full">${nativeMarkup}</div>` : nativeMarkup}</div></section></section></body>`, { pretendToBeVisual: true, ...(contribution.url ? { url: contribution.url } : {}) });
  const arrivingPane = contribution.deferNative ? dom.window.document.querySelector('[data-thread-window]') : null;
  arrivingPane?.remove();
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
  const imageObservers = new Set(), nativeObservers = new Set(), positions = { ...contribution.positions };
  class Observer { constructor(callback, options) { this.callback = callback; this.options = options; this.targets = new Set(); nativeObservers.add(this); } observe(target) {
    this.targets.add(target);
    if (contribution.loadedImage && target.classList.contains('tr-canvas')) {
      imageObservers.add(this);
      if (!contribution.manualImageVisibility) this.callback([{ target, isIntersecting: true }]);
    }
  } unobserve(target) { this.targets.delete(target); } disconnect() { this.targets.clear(); imageObservers.delete(this); nativeObservers.delete(this); } }
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
    MutationObserver: dom.window.MutationObserver, ResizeObserver: Observer, IntersectionObserver: Observer, IS_REACT_ACT_ENVIRONMENT: true });
  const box = { top: 0, bottom: 600, left: 0, right: 800, width: 800, height: 600, x: 0, y: 0, toJSON() {} };
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
    const top = positions[this.getAttribute('data-timeline-row-id')] ?? 0;
    return this.hasAttribute('data-thread-window') ? box : { ...box, top, y: top, width: contribution.width ?? 400, right: contribution.width ?? 400, height: 216, bottom: top + 216 };
  };
  let rows = Array.from({ length: count }, (_, i) => record(i)), enabled = true, listCalls = 0, rpc = 0, live = 0, peak = 0, setups = 0, cleanups = 0, full = 0, fullPeak = 0;
  if (contribution.sameTurnClaims) rows = Array.from({ length: contribution.sameTurnClaims }, (_, i) => {
    const row = structuredClone(rows[0]); row.key = `claim-${i}`; row.identity.ref.member = `fixture-member-${i}`;
    row.identity.artifact.id = `artifact-${i}`; row.resolution.identity = row.identity;
    row.resolution.presentation.data.label = `Referent ${i}`; return row;
  });
  if (contribution.turnClaims) rows = rows.flatMap((row, turn) => Array.from({ length: contribution.turnClaims[turn] ?? 1 }, (_, i) => {
    if ((contribution.turnClaims[turn] ?? 1) === 1) return row;
    const value = structuredClone(row); value.key = `turn-${turn}-claim-${i}`;
    value.identity.ref.member = `fixture-member-${i}`; value.identity.artifact.id = `artifact-${turn}-${i}`;
    value.resolution.identity = value.identity; return value;
  }));
  if (contribution.fileRoute) rows = rows.map((row, i) => ({ ...row, resolution: { ...row.resolution,
    route: { kind: 'file', target: { kind: 'host', hostId: 'recorded-host', path: contribution.distinctImageTargets ? `/saved/result-${i}.png` : '/saved/result.png' } } } }));
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
  if (contribution.mixedWarm) { const index = contribution.warmImageLast ? 0 : 1; const custom = record(index); custom.owner = registeredOwner; rows[index] = custom; }
  const fileOpenCalls = []; let fileOpenAccepted = true;
  const captured = [], navigation = [], registrations = [], nativeCalls = [], handlers = new Map();
  const bb = { rpc: { register(_contract, value) { for (const [method, handler] of Object.entries(value)) handlers.set(method, handler); } } };
  registerTurnResultsParticipant(bb, { pluginId: registeredOwner, capabilities: { revision: 'supplier-r1', supplier: {
    recognize: false, resolve: true, enumerate: false, kinds: [{ kind, namespace, neutralLabel: 'Result', confirmedLabel: 'Created', specificity: 'typed', memberVersion: 'v1', equivalenceNamespaces: [] }] } },
    resolve(input) { return buildResolveOutput(input, input.items.map(() => ({ state: 'unavailable', reason: 'not used' }))); } });
  const sdk = { threads: { async timeline(input) {
    nativeCalls.push(input);
    if (contribution.sameTurnClaims) return { rows: [...structuralRows, contribution.terminalRow ?? { id: 'opaque-0', threadId: 'thread', turnId: 'turn-0',
      kind: 'turn', status: 'completed', sourceSeqStart: 1, sourceSeqEnd: 5 }], completedTurnDisplay: 'collapse',
      timelinePage: { historySnapshot: 'public-snapshot-A', olderCursor: null } };
    if (contribution.turnClaims) return { rows: [...new Map(rows.map(row => [row.identity.ref.source.turnId, row])).values()].map((row, i) => ({
      id: `opaque-${i}`, threadId: 'thread', turnId: row.identity.ref.source.turnId, kind: 'turn', status: 'completed', sourceSeqStart: i * 10 + 1, sourceSeqEnd: i * 10 + 5,
    })), completedTurnDisplay: 'collapse', timelinePage: { historySnapshot: 'public-snapshot', olderCursor: null } };
    return { rows: rows.map((row, i) => ({ id: `opaque-${i}`, threadId: 'thread', turnId: row.identity.ref.source.turnId,
      kind: 'turn', status: 'completed', sourceSeqStart: i * 10 + 1, sourceSeqEnd: i * 10 + 5 })).concat(structuralRows), completedTurnDisplay: 'collapse', timelinePage: { historySnapshot: 'public-snapshot', olderCursor: null } };
  }, events: { async list() { throw Error('No native event read is allowed in this fixture'); } } }, plugins: {
    // The SDK test proxy invents callable missing methods. Model an older
    // host's actual unsupported route, rather than an unconfigured transport.
    async experimental_discoverRpc() { throw { status: 404, body: { error: 'Not Found' } }; },
    async list() { listCalls++; return { plugins: [{ id: registeredOwner, enabled, status: enabled ? 'running' : 'disabled' }] }; },
    async callRpc(args) {
      let value;
      if (contribution.loadedImage && args.method === 'turnResultImagesV1Media') {
        mediaCalls++; const now = Date.now(), target = rows.find(row => row.identity.ref.source.eventId === args.input.identity.ref.source.eventId).resolution.route.target;
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
        else if (args.method === GALLERY_METHODS.prepare) value = { resolve: null, invalidation: null, feed: null, native: null };
        else if (args.method === GALLERY_METHODS.stage) value = null;
        else if (args.method === GALLERY_METHODS.known) value = [];
        else value = { state: 'committed' };
      } else if (handlers.has(args.method)) value = await handlers.get(args.method)(args.input, { experimental_caller: { kind: 'client' } });
      else { rpc++; throw Error('Presentation owner RPC is forbidden'); }
      return args.outputSchema.parse(value);
    },
  } };
  const coreSubscriptions = new Set();
  if (contribution.deferNative || contribution.preloadNearby) sdk.subscribe = input => {
    coreSubscriptions.add(input);
    if (input.event === 'realtime:connection') queueMicrotask(() => {
      if (coreSubscriptions.has(input)) input.callback({ state: 'connected', reconnected: false, reconnectDelayMs: null });
    });
    return () => coreSubscriptions.delete(input);
  };
  function View(props) {
    captured.push(props);
    useEffect(() => { live++; setups++; peak = Math.max(peak, live); if (props.mode === 'full') { full++; fullPeak = Math.max(fullPeak, full); }
      return () => { live--; cleanups++; if (props.mode === 'full') full--; }; }, []);
    if (contribution.customExpand && props.mode === 'docked' && props.requestFull) return h('button', {
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
  if (!contribution.deferPresentation) register();
  contribution.configureSdk?.(sdk);
  const runtimeProbe = [];
  if (contribution.observeRuntime) {
    const push = runtimeProbe.push;
    runtimeProbe.push = function (...owners) { for (const owner of owners) contribution.observeRuntime(owner); return push.apply(this, owners); };
  }
  if (contribution.captureRuntime) globalThis.__turnResultsRuntimeFixture = runtimeProbe;
  const app = await loadPluginApp(await (contribution.definition ?? (contribution.captureRuntime ? runtimeDefinition : definition))), controller = new AbortController();
  let script = await app.contentScripts[0].mount({ pluginId: 'turn-results', generation: 1, signal: controller.signal });
  assert.equal(app.composerCustomizations.length, 0); assert.equal(app.threadPanelActions.length, 0);
  const originalBridge = app.threadHeaderActions[0];
  const Bridge = contribution.wrapBanner ? contribution.wrapBanner(originalBridge.component) : originalBridge.component;
  const headerProps = { threadId: 'thread', projectId: 'project', isCompactViewport: false };
  const banner = { ...originalBridge, component: props => createPortal(h(Bridge, props), document.querySelector('[data-fixture-header]')) };
  const renderBanner = () => renderSlot(banner, headerProps, { sdk,
    openFilePreview(options) { fileOpenCalls.push(options); if (contribution.focusOnFileOpen) { const preview = document.createElement('button'); document.body.append(preview); preview.focus(); } return fileOpenAccepted; },
    openUrl(url) { navigation.push(url); return true; }, realtimeConnectionState: 'connected' });
  contribution.beforeHeader?.();
  let rendered = null; if (mount) act(() => { rendered = renderBanner(); });
  // Factory capture now waits for the real deferred implementation. This is
  // observation only: no runtime or readiness is fabricated for old fixtures.
  if (mount && contribution.captureRuntime) await until(() => runtimeProbe.length > 0);
  const slots = [];
  return { dom, sdk, app, controller, captured, navigation, nativeCalls, register, renderer: View, slot: () => rendered,
    arrive: () => act(async () => { if (arrivingPane && !arrivingPane.isConnected) document.querySelector('[data-split-pane-id]').append(arrivingPane); await tick(); }),
    coreSubscriptions: () => [...coreSubscriptions],
    coreChanged: (event, channel = 'thread:changed') => act(async () => { for (const subscription of [...coreSubscriptions]) if (subscription.event === channel) subscription.callback(event); await tick(); }),
    rowPosition: (id, top) => act(async () => {
      positions[id] = top;
      for (const observer of [...nativeObservers]) {
        const entries = [...observer.targets].filter(target => target.hasAttribute('data-timeline-row-id')).map(target => {
          const rect = target.getBoundingClientRect(), margin = observer.options?.rootMargin ? 600 : 0;
          return { target, isIntersecting: rect.top < 600 + margin && rect.bottom > -margin };
        });
        if (entries.length) observer.callback(entries);
      }
      await tick();
    }),
    fileOpenCalls, fileOpenAccepted(value) { fileOpenAccepted = value; },
    runtime: () => runtimeProbe.at(-1), element: () => h(banner.component, { ...headerProps }),
    mediaCounts: () => ({ calls: mediaCalls, fetches: mediaFetches }),
    imagesVisible: (value, key) => act(async () => { for (const observer of imageObservers) {
      const entries = [...observer.targets].filter(target => !key || target.closest('[data-result-key]')?.dataset.resultKey === key)
        .map(target => ({ target, isIntersecting: value }));
      if (entries.length) observer.callback(entries);
    } await tick(); }),
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
      assert.equal(coreSubscriptions.size, 0);
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
    const navigations = f.navigation.length; first.navigate.openUrl('https://fixture.invalid/stale'); assert.equal(first.requestFull, undefined); first.refresh();
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
    assert.equal(card.textContent.includes('checked earlier'), false); assert.deepEqual(f.mediaCounts(), { calls: 1, fetches: 1 });
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

test('Checking stops after eight genuine issued pages when its captured historical boundary remains unplaced', async () => {
  const h = await heldImageIntent(); let pages = 0; const inputs = [];
  try {
    h.f.sdk.threads.timeline = async input => {
      inputs.push(input); assert.equal(input.deferContent, 'true');
      if (pages) { assert.equal(input.beforeAnchorId, `opaque-issued-${pages}`); assert.equal(input.beforeAnchorSeq, String(1000 - pages * 10)); }
      else assert.equal(input.beforeAnchorId, undefined);
      pages++; const seq = 1000 - pages * 10;
      return { rows: [{ id: `public-deep-${pages}`, threadId: 'thread', turnId: `public-turn-${pages}`, kind: 'turn', status: 'completed', sourceSeqStart: seq, sourceSeqEnd: seq + 5 }],
        timelinePage: { historySnapshot: 'genuine-deep', olderCursor: { anchorId: `opaque-issued-${pages}`, anchorSeq: seq } } };
    };
    await h.release(); await until(() => /Results read capacity reached/.test(h.card.textContent));
    assert.equal(pages, 8); assert.equal(inputs.length, 8); assert.equal(h.f.fileOpenCalls.length, 0); await settle(100); assert.equal(pages, 8);
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
  const f = await fixture(1, true, { fileRoute: true }); let release = () => {}, historyHeld = false;
  try {
    await until(() => f.stats().live === 1);
    const card = document.querySelector('[data-result-key="row-0"]');
    const open = card.querySelector('.tr-open-icon'), frame = card.querySelector('[data-supplier]');
    const original = f.sdk.threads.timeline;
    f.sdk.threads.timeline = async input => { historyHeld = true; await new Promise(resolve => { release = resolve; });
      const page = await original(input); return { ...page, timelinePage: { historySnapshot: 'genuinely-fresh-public-snapshot', olderCursor: null } }; };
    await act(async () => { document.querySelector('[data-timeline-row-id="opaque-0"] > button').firstChild.data = 'Native row changed'; await tick(10); });
    await act(async () => open.click());
    assert.equal(f.fileOpenCalls.length, 0, 'suspended authority cannot reach the public native port');
    assert.match(card.querySelector('[data-turn-result-open-status]')?.textContent ?? '', /Checking/);
    await act(async () => document.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    await until(() => historyHeld && f.stats().live === 1);
    assert.equal(card.querySelector('[data-supplier]'), frame, 'Checking cancellation does not replace the already-admitted frame');
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

test('gallery exposes one stable consumer Expand; optional contributor requestFull stays absent and Escape restores exact focus', async () => {
  const f = await fixture(1, true, { customExpand: true });
  try {
    await until(() => f.stats().live === 1 && document.querySelector('[data-supplier]'));
    assert.equal(document.querySelector('[data-contributor-expand]'), null);
    assert.equal(f.captured.at(-1).requestFull, undefined);
    const card = document.querySelector('[data-result-key="row-0"]'), consumer = card.querySelector('.tr-expand-icon');
    assert.equal(document.querySelectorAll('.tr-expand-icon').length, 1);
    assert.equal(consumer.textContent, ''); assert.equal(consumer.title, 'Expand Saved result 0');
    const style = document.createElement('style'); style.textContent = readFileSync(new URL('../app.css', import.meta.url), 'utf8'); document.head.append(style);
    assert.equal(window.getComputedStyle(consumer).width, '32px'); assert.equal(window.getComputedStyle(consumer).height, '32px'); style.remove();
    await act(async () => { consumer.focus(); consumer.click(); }); await until(() => f.stats().full === 1);
    assert.equal(consumer.isConnected, true); assert.equal(consumer.closest('[data-result-key]'), card);
    await act(async () => document.querySelector('dialog').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    await until(() => !document.querySelector('dialog'));
    assert.equal(document.activeElement, consumer); assert.equal(f.stats().fullPeak, 1); assert.ok(f.stats().peak <= 4); assert.equal(f.stats().rpc, 0);
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
    assert.ok(dialog.querySelector('.tr-caption')); assert.ok(dialog.querySelector('.tr-fallback [aria-label^="Open "]'));
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
    assert.equal(f.stats().peak, 4); assert.equal(runtime.canvases.counts().stalled, 1);
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
    assert.equal(document.querySelector('.tr-result-title').textContent, 'Saved result 0');
    assert.equal(document.querySelector('.tr-caption > span').textContent, 'Result recorded', 'unknown live descriptor retains a truthful generic event caption without readiness authority');
    assert.ok(document.querySelector('.tr-fallback [aria-label^="Open Saved result 0 — https://fixture.invalid/0"]'));
    f.enabled(true); await act(async () => { f.register(async () => f.renderer, ['requires-io']); }); await f.notify();
    await settle(100); assert.equal(f.stats().live, 0); assert.equal(f.stats().rpc, 0);
    await act(async () => { f.register(); }); await until(() => f.stats().live === 1);
  } finally { release(f.renderer); await f.dispose(); }
});

test('lazy failure keeps compact fallback; explicit full/retry recovers unchanged source without background reads', async () => {
  const f = await fixture(1); let loads = 0, rejected = true;
  try {
    await until(() => f.stats().live === 1);
    await act(async () => { f.register(async () => { loads++; if (rejected) throw Error('intentional pure fixture load failure'); return f.renderer; }); });
    await until(() => loads === 1 && f.stats().live === 0);
    assert.equal(document.querySelector('.tr-custom-status'), null, 'automatic dock fallback has no ambient readiness/error strip');
    assert.ok(document.querySelector('.tr-caption > span').textContent); assert.ok(document.querySelector('.tr-caption button'));
    const lists = f.stats().listCalls; await settle(120); assert.equal(loads, 1); assert.equal(f.stats().listCalls, lists);
    rejected = false; await act(async () => document.querySelector('.tr-caption button').click());
    await until(() => f.stats().full === 1 || document.querySelector('dialog .tr-custom-status button'));
    const retry = document.querySelector('dialog .tr-custom-status button');
    if (retry) await act(async () => retry.click());
    await until(() => f.stats().full === 1 && !document.querySelector('.tr-custom-status'));
    assert.equal(loads, 2); assert.equal(f.stats().rpc, 0); assert.equal(f.stats().peak, 1); assert.equal(f.stats().listCalls, lists);
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
    do { const read = await runtime.readScope('thread', controller.signal, signal => runtime.discoverReady(signal)); assert.equal(read.state, 'ready'); continued = read.value.continued; passes++; assert.ok(passes <= 33); } while (continued);
    assert.equal(passes, 33); assert.equal(runtime.readyOwners.state.size, 33); assert.equal(runtime.isReadyOwner('supplier-32'), true);
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
    const timeline = f.sdk.threads.timeline; let completedToken = null;
    f.sdk.threads.timeline = async input => {
      const token = document.querySelector('[data-timeline-row-id="opaque-1"] > button').textContent;
      const page = await timeline(input); completedToken = token; return page;
    };
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
    // Mounted frames intentionally survive pending proof. Wait for the actual
    // coalesced public read after the final hint before measuring idle silence.
    await until(() => completedToken === 'Unrelated native token 7');
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
    old.navigate.openUrl('https://fixture.invalid/stale-target'); assert.equal(old.requestFull, undefined);
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

test('earlier same-turn and unknown history revoke actions while preserving an admitted physical frame', async () => {
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
    assert.ok(document.querySelector('[data-timeline-row-id="opaque-0"] [data-supplier]'), 'history suspension retains the already-admitted immutable view');
    assert.equal(document.querySelector('[data-timeline-row-id="opaque-1"] [data-supplier]'), other);
    await until(() => f.stats().live === 2);
    const unknown = document.createElement('aside'); unknown.textContent = 'Native structural change';
    await act(async () => { document.querySelector('[data-thread-window]').append(unknown); await tick(10); });
    assert.equal(f.stats().live, 2, 'unknown history still revokes actions while unchanged physical immutable views remain painted');
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
    await act(async () => host.closest('.tr-card').querySelector('.tr-open-icon').click());
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

test('later collected row Checking validates its actual issued cursor and opens once after fresh public proof', async () => {
  const f = await fixture(1, true, { owner: 'turn-result-images', fileRoute: true, loadedImage: true }); let release = () => {};
  try {
    await until(() => document.querySelector('[data-result-key="row-0"] img'));
    const nativePage = await f.sdk.threads.timeline({ threadId: 'thread' });
    const rows = Array.from({ length: 17 }, (_, i) => { const row = structuredClone(f.rows()[0]); row.key = `paged-${i}`; row.firstObservedOrder = i;
      row.identity.ref.member = `image:${i}`; row.identity.artifact.id = `image-${i}`; row.resolution.identity = row.identity; return row; });
    f.setRows(rows); f.sdk.threads.timeline = async () => nativePage;
    await f.notify(); await until(() => document.querySelector('[data-result-key="paged-0"] img'));
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

test('routine-only retained facts leave no shelf, footer, loading/error chrome, controls or reserved gap', async () => {
  const f = await fixture(1, true, { captureRuntime: true });
  try {
    await until(() => f.stats().live === 1); const nativePage = await f.sdk.threads.timeline({ threadId: 'thread' });
    const rows = Array.from({ length: 16 }, (_, i) => { const row = structuredClone(f.rows()[0]); row.key = `routine-${i}`; row.identity.ref.member = `native:${i}`;
      row.identity.ref.kind = i % 2 ? 'workspace/address-observed' : 'workspace/command-completed'; row.resolution.identity = row.identity;
      delete row.resolution.presentation; row.resolution.route = i % 2 ? { kind: 'unavailable', reason: 'unbound-address' } : { kind: 'source', threadId: 'thread', eventId: 'event-0', seq: 3 };
      row.resolution.fallback = { kind: 'card', title: i % 2 ? 'Address observed' : 'Command succeeded', description: 'Routine diagnostic', fields: [{ label: 'Exit code', value: '0' }] }; return row; });
    f.setRows(rows); f.sdk.threads.timeline = async () => nativePage; await f.notify();
    await until(() => f.stats().live === 0 && f.runtime().stats().running === 0 && !document.querySelector('.tr-gallery'));
    assert.equal(f.rows().length, 16, 'selection retains every source fact');
    const shell = document.querySelector('[data-turn-results-gallery]'); assert.equal(shell.style.minHeight, '');
    assert.equal(document.querySelector('[data-turn-results-notice]'), null); assert.equal(shell.textContent, '');
    const original = f.sdk.plugins.callRpc;
    f.sdk.plugins.callRpc = async args => { if (args.method === GALLERY_METHODS.read) throw Error('hidden routine read unavailable'); return original(args); };
    await f.notify(); await until(() => f.runtime().stats().running === 0); await settle(40);
    assert.equal(shell.textContent, ''); assert.equal(shell.style.minHeight, '');
    assert.equal(shell.querySelector('button, [role="status"]'), null);
  } finally { await f.dispose(); }
});

test('later collected-row Open declines source revision/route changes and wrong-turn replacement without retargeting', async t => {
  for (const change of ['revision-route', 'wrong-turn']) await t.test(change, async () => {
    const f = await fixture(1, true, { owner: 'turn-result-images', fileRoute: true, loadedImage: true }); let release = () => {};
    try {
      await until(() => document.querySelector('[data-result-key="row-0"] img'));
      const nativePage = await f.sdk.threads.timeline({ threadId: 'thread' });
      const rows = Array.from({ length: 17 }, (_, i) => { const row = structuredClone(f.rows()[0]); row.key = `guarded-${i}`;
        row.identity.ref.member = `image:${i}`; row.identity.artifact.id = `image-${i}`; row.resolution.identity = row.identity; return row; });
      f.setRows(rows); f.sdk.threads.timeline = async () => nativePage; await f.notify();
      await until(() => document.querySelector('[data-result-key="guarded-8"] img'));
      let held = 0; f.sdk.threads.timeline = async () => { held++; await new Promise(resolve => { release = resolve; }); return nativePage; };
      await f.notify(); await until(() => held === 1);
      await act(async () => document.querySelector('[data-result-key="guarded-8"] .tr-image-action').click());
      assert.equal(f.fileOpenCalls.length, 0);
      const changed = structuredClone(rows);
      if (change === 'revision-route') { changed[8].resolution.revision.sequence++; changed[8].resolution.route.target.path = '/changed/file.png'; }
      else changed[8].identity.ref.source.turnId = 'other-turn';
      f.setRows(changed); f.sdk.threads.timeline = async () => nativePage;
      await act(async () => { release(); await tick(); }); await settle(120);
      assert.equal(f.fileOpenCalls.length, 0, 'fresh action proof never reuses a changed target or another turn');
      assert.equal(document.body.textContent.includes('Checking this saved result'), false);
    } finally { release(); await f.dispose(); }
  });
});


test('five data-only reply cards keep distinct primary text, exact click/Enter targets and zero custom leases across focus', async () => {
  const f = await fixture(5, true, { kind: 'github/reply-posted' });
  try {
    await until(() => f.stats().live === 4);
    const rows = structuredClone(f.rows()).map((row, i) => {
      delete row.resolution.presentation; row.resolution.revision.sequence = 2;
      row.identity.ref.kind = 'github/reply-posted'; row.resolution.identity = row.identity;
      row.resolution.fallback = { kind: 'card', title: `Distinct posted reply ${i}`, description: 'a/b#12' };
      row.resolution.route = { kind: 'url', href: `https://github.com/a/b/pull/12#discussion_r${100 + i}` }; return row;
    });
    f.setRows(rows); await f.notify(); await until(() => f.stats().live === 0 && document.querySelectorAll('.tr-result-title').length === 5);
    const cards = [...document.querySelectorAll('[data-result-key]')], text = cards.map(card => card.textContent);
    assert.equal(cards.length, 5); assert.equal(document.querySelectorAll('.tr-result-symbol, .tr-expand-icon').length, 0);
    for (const [i, card] of cards.entries()) {
      assert.equal(card.querySelector('.tr-result-title').textContent, `Distinct posted reply ${i}`);
      assert.equal(card.querySelector('.tr-excerpt').textContent, 'a/b#12');
      const button = card.querySelector('.tr-data-action');
      assert.equal(button.getAttribute('aria-label'), `Open Distinct posted reply ${i} — https://github.com/a/b/pull/12#discussion_r${100+i}`);
      await act(async () => { button.focus(); button.dispatchEvent(new f.dom.window.MouseEvent('mouseover', { bubbles: true }));
        if (i % 2) button.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        button.dispatchEvent(new f.dom.window.MouseEvent('click', { bubbles: true, detail: i % 2 ? 0 : 1 })); });
      assert.equal(f.navigation.at(-1), rows[i].resolution.route.href);
    }
    assert.equal(f.navigation.length, 5); assert.equal(f.stats().live, 0); assert.deepEqual(cards.map(card => card.textContent), text);
    assert.equal(f.stats().rpc, 0, 'plain occurrence cards never acquire a custom RPC/lease');
  } finally { await f.dispose(); }
});


// Exact five source-owned v2 titles from final ordinary native migration,
// live-rows-after-final-native.json SHA f47411d27d3a533bb849f18f0c5b114f839075d545242c7aa1a7817cdc2f67ea.
test('actual five long reply excerpts honor bounded two-column width; narrow and short cards stay compact', async () => {
  const titles = ["Published five correction commits through ae5e7fdc936adb25e519a39654dd7b0f43450090, preserving the author's history thro", "Fixed in 3669d8a25764d2ab22ece7241d4ca2f7c83b098e. Shipping Query now acquires explicitly granted Past and Landing for e", "Fixed in a6172e5e2b35bfe32ce2ee8be65eadf20551833e. Ordinary authenticated renewal establishes the canonical deployment p", "Fixed in fd2c3adc7ac7a956b2c52fa9626480d299015aee. The finite navigation lease now keys concrete Tasks under the logical", "Fixed in ccddc3c6b00f512e5646531ecf19de187fc4dcb6. Prepared interpretations no longer receive incompatible raw confirmed"];
  const visibleTitles = ["Published five correction commits through ae5e7fdc…, preserving the author's history…", "Fixed in 3669d8a2… Shipping Query now acquires explicitly granted Past and Landing for…", "Fixed in a6172e5e… Ordinary authenticated renewal establishes the canonical deployment…", "Fixed in fd2c3adc… The finite navigation lease now keys concrete Tasks under the…", "Fixed in ccddc3c6… Prepared interpretations no longer receive incompatible raw…"];
  const destinations = ["https://github.com/phosphorco/monorepo/pull/1891#issuecomment-6545603502", "https://github.com/phosphorco/monorepo/pull/1891#discussion_r4432291225", "https://github.com/phosphorco/monorepo/pull/1891#discussion_r4432291018", "https://github.com/phosphorco/monorepo/pull/1891#discussion_r4432290744", "https://github.com/phosphorco/monorepo/pull/1891#discussion_r4432290444"];
  for (const width of [400, 150]) {
    const f = await fixture(5, true, { kind: 'github/reply-posted', width, captureRuntime: true });
    try {
      const rows = structuredClone(f.rows()).map((row, i) => {
        delete row.resolution.presentation; row.resolution.revision.sequence = 2;
        row.resolution.fallback = { kind: 'card', title: titles[i], description: 'phosphorco/monorepo#1891' };
        row.resolution.spans = { width: 2, height: 1 }; row.resolution.route = { kind: 'url', href: destinations[i] }; return row;
      });
      const savedFacts = JSON.stringify(rows);
      f.setRows(rows); await f.notify(); await until(() => f.stats().live === 0 && document.querySelectorAll('.tr-result-title').length === 5);
      const cards = () => [...document.querySelectorAll('[data-result-key]')];
      const placement = card => ({ column: card.parentElement.style.gridColumn, row: card.parentElement.style.gridRow });
      const placements = cards().map(placement);
      console.log('ACTUAL_REPLY_WIDTH', JSON.stringify({ width, placements, titles: cards().map(card => card.querySelector('.tr-result-title').textContent) }));
      for (const [i, card] of cards().entries()) {
        assert.equal(card.querySelector('.tr-result-title').textContent, visibleTitles[i]);
        assert.equal(card.querySelector('.tr-data-action').getAttribute('aria-label'), `Open ${titles[i]} — ${destinations[i]}`);
        assert.ok(placement(card).column.endsWith(` / span ${width === 400 ? 2 : 1}`), 'long actual source card may use its supplied width, clamped to the pane');
        assert.ok(placement(card).row.endsWith(' / span 1'));
      }
      assert.equal(JSON.stringify(f.rows()), savedFacts, 'abbreviation never edits source facts, revisions or full titles');
      const originalCards = cards();
      const compact = structuredClone(rows);
      compact[0].resolution.fallback.title = 'Short saved artifact';
      compact[1].resolution.fallback.title = '😀'.repeat(40) + 'x'.repeat(40);
      compact[2].resolution.fallback.title = '😀'.repeat(40) + 'x'.repeat(41); compact[2].resolution.spans = { width: 4, height: 4 };
      compact[3].resolution.fallback.title = 'Long unprefixed saved artifact description: '.repeat(2).trim();
      compact[3].resolution.spans = { width: 1, height: 4 };
      compact[4].resolution.fallback.title = 'x'.repeat(80);
      for (const row of compact) row.resolution.revision.sequence++;
      f.setRows(compact); await f.notify(); await until(() => [...document.querySelectorAll('.tr-result-title')].every((title, i) => title.textContent === compact[i].resolution.fallback.title)
        && f.runtime().stats().running === 0 && f.runtime().stats().queued === 0);
      assert.deepEqual(cards(), originalCards, 'revision geometry keeps the keyed physical cards');
      for (const [i, card] of cards().entries()) {
        assert.ok(placement(card).column.endsWith(` / span ${width === 400 && i === 2 ? 2 : 1}`), 'short/codepoint80 and supplied width1 stay compact; long width4 is capped at2');
        assert.ok(placement(card).row.endsWith(' / span 1'), 'plain card never inherits tall custom geometry');
      }
      assert.equal(f.navigation.length, 0); assert.equal(f.stats().rpc, 0); assert.equal(f.stats().live, 0);
    } finally { await f.dispose(); }
  }
});


test('standalone full commits shorten only card visual text while custom/link and complete factual names survive', async () => {
  const sha = '0123456789abcdef0123456789abcdef01234567';
  const titles = [
    `Fixed in ${sha}. Distinct substantive reply`,
    `Note: Fixed in ${sha}. Preserve this authored text`,
    `Fixed in ${sha}.`,
    `Fixed in ${sha}. Custom fallback remains complete`,
    `Fixed in ${sha}. Link fallback remains complete`,
  ];
  const expected = [`Fixed in 01234567… Distinct substantive reply`, `Note: Fixed in 01234567…. Preserve this authored text`, 'Fixed in 01234567….', ...titles.slice(3)];
  const f = await fixture(5, true, { kind: 'github/reply-posted', captureRuntime: true });
  try {
    f.enabled(false); await f.membership();
    const rows = structuredClone(f.rows()).map((row, i) => {
      delete row.resolution.presentation; row.resolution.revision.sequence = 2;
      row.resolution.fallback = { kind: i === 4 ? 'link' : 'card', title: titles[i], description: 'a/b#12' };
      if (i === 3) row.resolution.presentation = { schema, data: { label: 'Custom referent' } };
      return row;
    });
    const saved = JSON.stringify(rows); f.setRows(rows); await f.notify();
    await until(() => [...document.querySelectorAll('.tr-result-title')].every((node, i) => node.textContent === expected[i])
      && document.querySelectorAll('.tr-result-title').length === 5 && f.runtime().stats().running === 0 && f.runtime().stats().queued === 0);
    for (const [i, card] of [...document.querySelectorAll('[data-result-key]')].entries()) {
      assert.equal(card.querySelector('.tr-result-title').textContent, expected[i]);
      assert.equal(card.querySelector('.tr-data-action').getAttribute('aria-label'), `Open ${titles[i]} — ${rows[i].resolution.route.href}`);
    }
    assert.equal(JSON.stringify(f.rows()), saved); assert.equal(f.navigation.length, 0); assert.equal(f.stats().rpc, 0);
  } finally { await f.dispose(); }
});

test('5978 queued primary fallback focus stays visible when its custom host is admitted', async () => {
  const f = await fixture(6);
  try {
    await until(() => f.stats().live === 4);
    const card = document.querySelector('[data-result-key="row-5"]');
    const primary = card.querySelector('.tr-fallback .tr-data-action');
    assert.equal(card.querySelector('[data-supplier]'), null);
    await act(async () => primary.focus());
    await until(() => card.querySelector('[data-supplier="artifact-5"]'));
    const fallback = primary.closest('.tr-fallback');
    const result = { stillConnected: primary.isConnected, activePrimary: document.activeElement === primary,
      visibility: fallback.style.visibility, ariaHidden: fallback.getAttribute('aria-hidden'),
      customMounted: Boolean(card.querySelector('[data-supplier]')), peak: f.stats().peak, navigation: f.navigation.length };
    console.log('PROBE queued-primary-focus', JSON.stringify(result));
    assert.ok(f.stats().peak <= 4); assert.equal(f.navigation.length, 0);
    assert.notEqual(result.visibility, 'hidden', 'the focused primary fallback must not disappear beneath a newly admitted custom renderer');
    assert.equal(card.querySelector('.tr-hosted').hasAttribute('inert'), true);
    assert.equal(card.querySelector('.tr-hosted').getAttribute('aria-hidden'), 'true');
    const stable = card.querySelector('.tr-expand-icon');
    await act(async () => stable.focus()); await until(() => fallback.style.visibility === 'hidden');
    assert.equal(card.querySelector('.tr-hosted').hasAttribute('inert'), false);
    const old = f.captured.findLast(props => props.identity.id === 'artifact-5'), before = f.navigation.length;
    await f.hidden(true); await until(() => f.stats().live === 0);
    old.navigate.openUrl('https://fixture.invalid/retired-focused-host'); assert.equal(f.navigation.length, before);
    await f.hidden(false); await until(() => f.stats().live === 4);
    assert.ok(f.stats().peak <= 4); assert.equal(f.stats().rpc, 0);
  } finally { await f.dispose(); }
});

test('5978 contested suspended choice matches ordinary one-intent verification rather than silent no-op', async () => {
  const f = await fixture(3, true, { captureRuntime: true });
  let release = () => {}; const original = f.sdk.threads.timeline;
  try {
    const nativePage = await original({ threadId: 'thread' });
    f.sdk.threads.timeline = async () => nativePage;
    const base = structuredClone(f.rows()[0]); delete base.resolution.presentation;
    base.identity.equivalence = { namespace: 'example.operation', operationId: 'same-operation', member: 'same-result' };
    base.resolution.identity = base.identity; base.resolution.route = { kind: 'url', href: 'https://fixture.invalid/choice-a' };
    const other = structuredClone(base); other.key = 'other-choice'; other.owner = 'other-fixture'; other.resolution.route.href = 'https://fixture.invalid/choice-b';
    const ordinary = structuredClone(f.rows()[2]); delete ordinary.resolution.presentation; ordinary.resolution.route = { kind: 'url', href: 'https://fixture.invalid/ordinary' };
    f.setRows([base, other, ordinary]); await f.notify();
    await until(() => [...document.querySelectorAll('.tr-card')].some(card => card.textContent.includes('Multiple result sources')) && document.querySelector('[data-result-key="row-2"] .tr-data-action')?.getAttribute('aria-label')?.includes('https://fixture.invalid/ordinary') && f.runtime().stats().running === 0 && f.runtime().stats().queued === 0);
    const contested = [...document.querySelectorAll('.tr-card')].find(card => card.textContent.includes('Multiple result sources'));
    const choice = [...contested.querySelectorAll('button')].find(button => button.textContent === owner);
    const direct = document.querySelector('[data-result-key="row-2"] .tr-data-action');
    let heldCalls = 0;
    f.sdk.threads.timeline = async () => { if (++heldCalls === 1) await new Promise(resolve => { release = resolve; }); return nativePage; };
    await f.notify(); await until(() => heldCalls === 1);
    const before = heldCalls;
    await act(async () => choice.click()); await settle(20);
    const refused = { navigation: f.navigation.length, extraReads: heldCalls - before,
      status: contested.querySelector('[role="status"]')?.textContent ?? null, connected: choice.isConnected };
    console.log('PROBE contested-before-ordinary', JSON.stringify(refused));
    await act(async () => direct.click());
    assert.match(direct.closest('.tr-card').querySelector('[role="status"]')?.textContent ?? '', /Checking/);
    await act(async () => { release(); await tick(); }); await until(() => f.navigation.length === 1);
    console.log('PROBE contested-currentfalse', JSON.stringify({ contested: refused, ordinary: { navigation: f.navigation, extraReads: heldCalls - before } }));
    assert.deepEqual(f.navigation, ['https://fixture.invalid/ordinary']);
    assert.ok(refused.extraReads > 0 || refused.status, 'suspended source choice must start guarded checking or provide outcome feedback');
  } finally { release(); f.sdk.threads.timeline = original; await settle(); await f.dispose(); }
});


test('bounded visible prose/hash formatting preserves full factual names and only one data-card action', async () => {
  const sha = '0123456789abcdef0123456789abcdef01234567';
  const titles = ['Short note', 'x'.repeat(95), 'x'.repeat(96), 'x'.repeat(130),
    '😀'.repeat(40) + 'x'.repeat(80), 'a '.repeat(70).trim(), `é${sha}z`, `Commit ${sha} saved`];
  const expected = ['Short note', 'x'.repeat(95), 'x'.repeat(95) + '…', 'x'.repeat(95) + '…',
    '😀'.repeat(40) + 'x'.repeat(55) + '…', null, `é${sha}z`, 'Commit 01234567… saved'];
  const f = await fixture(titles.length, true, { captureRuntime: true });
  try {
    const rows = structuredClone(f.rows()).map((row, i) => { delete row.resolution.presentation; row.resolution.revision.sequence++;
      row.resolution.fallback = { kind: 'card', title: titles[i], description: 'Saved artifact' }; return row; });
    const saved = JSON.stringify(rows); f.setRows(rows); await f.notify();
    await until(() => f.stats().live === 0 && document.querySelectorAll('.tr-result-title').length === titles.length);
    const cards = [...document.querySelectorAll('[data-result-key]')];
    for (const [i, card] of cards.entries()) {
      const visual = card.querySelector('.tr-result-title').textContent;
      if (expected[i] !== null) assert.equal(visual, expected[i]);
      else { assert.ok(visual.endsWith('…')); assert.ok(visual.slice(0,-1).split(' ').every(word => word === 'a')); }
      assert.ok(Array.from(visual).length <= 96);
      assert.equal(card.querySelectorAll('button').length, 1, 'data-only result has one guarded primary target');
      assert.equal(card.querySelector('button').getAttribute('aria-label'), `Open ${titles[i]} — ${rows[i].resolution.route.href}`);
    }
    assert.equal(JSON.stringify(f.rows()), saved); assert.equal(f.stats().rpc, 0);
  } finally { await f.dispose(); }
});

async function sourceChoices(file = false) {
  const f = await fixture(3, true, { captureRuntime: true }); const original = f.sdk.threads.timeline;
  const page = await original({ threadId: 'thread' }); f.sdk.threads.timeline = async () => page;
  const base = structuredClone(f.rows()[0]); delete base.resolution.presentation;
  base.identity.equivalence = { namespace: 'example.operation', operationId: 'shared', member: 'same' }; base.resolution.identity = base.identity;
  base.resolution.route = file ? { kind: 'file', target: { kind: 'host', hostId: 'recorded-host', path: '/saved/choice-a' } } : { kind: 'url', href: 'https://fixture.invalid/choice-a' };
  const other = structuredClone(base); other.key = 'other-choice'; other.owner = 'other-fixture';
  if (file) other.resolution.route.target.path = '/saved/choice-b'; else other.resolution.route.href = 'https://fixture.invalid/choice-b';
  const ordinary = structuredClone(f.rows()[2]); delete ordinary.resolution.presentation;
  f.setRows([base, other, ordinary]); await f.notify();
  await until(() => document.querySelectorAll('.tr-card').length === 2 && [...document.querySelectorAll('.tr-card')].some(card => card.textContent.includes('Multiple result sources'))
    && f.runtime().stats().running === 0 && f.runtime().stats().queued === 0);
  const buttons = [...document.querySelectorAll('.tr-card button')];
  let release = () => {}, reads = 0;
  return { f, choice: buttons.find(b => b.textContent === owner), other: buttons.find(b => b.textContent === 'other-fixture'),
    async suspend() { f.sdk.threads.timeline = async () => { if (++reads === 1) await new Promise(r => { release = r; }); return page; }; await f.notify(); await until(() => reads === 1); },
    async release() { await act(async () => { release(); await tick(); }); },
    async close() { release(); f.sdk.threads.timeline = original; await settle(); await f.dispose(); } };
}

for (const boundary of ['recovered', 'facts', 'removed', 'superseded', 'direct-refusal']) test(`source choice shares ordinary Open authority and feedback for ${boundary}`, async () => {
  const h = await sourceChoices(boundary === 'direct-refusal'); let lease;
  try {
    assert.ok(h.choice.getAttribute('aria-label').startsWith(`${owner}: Open `));
    if (boundary === 'direct-refusal') {
      h.f.fileOpenAccepted(false); const before = h.f.nativeCalls.length;
      await act(async () => h.choice.click()); assert.equal(h.f.fileOpenCalls.length, 1); assert.equal(h.f.nativeCalls.length, before);
      assert.match(h.choice.closest('article').querySelector('[role="status"]').textContent, /not accepted/); return;
    }
    await h.suspend(); await act(async () => h.choice.click());
    assert.match(h.choice.closest('article').querySelector('[role="status"]').textContent, /Checking/);
    if (boundary === 'facts') {
      lease = h.f.runtime().retain({ threadId: 'thread', turnId: 'turn-0', rowId: 'opaque-0', sourceSeqStart: 1, sourceSeqEnd: 5, turnSeqStart: 1, turnSeqEnd: 5, historySnapshot: 'public-snapshot' }, false);
      await act(async () => lease.store.setState(previous => ({ ...previous, rows: previous.rows.map(row => row.key === 'row-0'
        ? { ...row, sourceExpired: { epoch: 'fixture', sequence: 2 } } : row) })));
    } else if (boundary === 'removed') await act(async () => document.querySelector('[data-timeline-row-id="opaque-0"]').remove());
    else if (boundary === 'superseded') await act(async () => h.other.click());
    await h.release(); await settle(80);
    assert.deepEqual(h.f.navigation, boundary === 'superseded' ? ['https://fixture.invalid/choice-b'] : boundary === 'recovered' ? ['https://fixture.invalid/choice-a'] : []);
  } finally { lease?.dispose(); await h.close(); }
});

test('generic descriptor labels react for retained cards without row or readiness authority changes', async()=>{
 const f=await fixture(1,false), runtime=createGalleryRuntime(f.sdk), controller=new AbortController();const shell=document.createElement('div');document.body.append(shell);const root=createRoot(shell);const row={...f.rows()[0],resolution:{...f.rows()[0].resolution,presentation:undefined}};let atReady=[];const unsub=runtime.readyOwners.subscribe(()=>atReady.push(runtime.caption(row)));
 try{
  await act(async()=>root.render(h(ResultCard,{row,runtime,sdk:f.sdk,navigate:{openUrl(){return true},toThread(){}},current:()=>true,lifetime:controller.signal})));
  const before=shell.querySelector('.tr-caption > span').textContent;await act(async()=>{await runtime.readScope('thread',controller.signal,signal=>runtime.discoverReady(signal));await tick()});await settle(30);
  const result={before,atReady,captionNow:runtime.caption(row),captionDOM:shell.querySelector('.tr-caption > span').textContent,counts:f.stats()};console.log('CAPTION_DESCRIPTOR_BEFORE',JSON.stringify(result));assert.equal(result.captionNow,'Created');assert.equal(result.captionDOM,'Created','retained noncustom card receives admitted label without another row read');
  const calls=f.stats().listCalls, original=f.sdk.plugins.callRpc;
  f.sdk.plugins.callRpc=async args=>{const output=await original(args);if(args.method===METHODS.describe){const value=structuredClone(output);value.capabilities.supplier.kinds[0].confirmedLabel='Delivered artifact';return args.outputSchema.parse(value)}return output};
  runtime.invalidateReadiness();assert.equal(runtime.isReadyOwner(owner),false);
  await act(async()=>{await runtime.readScope('thread',controller.signal,signal=>runtime.discoverReady(signal));await tick()});
  assert.equal(shell.querySelector('.tr-caption > span').textContent,'Delivered artifact');
  assert.equal(runtime.caption({...row,owner:'unrelated'}),'Result recorded');
  const idle=f.stats();await settle(40);assert.deepEqual(f.stats(),idle);assert.equal(f.stats().listCalls,calls+1);assert.equal(f.stats().rpc,0);

 }finally{unsub.unsubscribe();await act(async()=>root.unmount());controller.abort();runtime.dispose();await f.dispose()}
});


test('admitted event labels survive an incomplete rediscovery slice without granting readiness', async () => {
 const f=await fixture(1,false), runtime=createGalleryRuntime(f.sdk), controller=new AbortController(), row=f.rows()[0];
 const originalList=f.sdk.plugins.list, originalRpc=f.sdk.plugins.callRpc;let prefixCalls=0;
 try {
  await runtime.readScope('thread',controller.signal,signal=>runtime.discoverReady(signal));
  assert.equal(runtime.caption(row),'Created');assert.equal(runtime.isReadyOwner(owner),true);
  const prefixes=Array.from({length:32},(_,i)=>({id:`aaa-prefix-${String(i).padStart(2,'0')}`,enabled:true,status:'running'}));
  f.sdk.plugins.list=async()=>({plugins:[...prefixes,...(await originalList()).plugins]});
  f.sdk.plugins.callRpc=async args=>{if(args.method===METHODS.describe&&args.pluginId.startsWith('aaa-prefix-')){prefixCalls++;return args.outputSchema.parse({protocol:'bb-turn-results',versions:[]})}return originalRpc(args)};
  runtime.invalidateReadiness();assert.equal(runtime.isReadyOwner(owner),false);
  const first=await runtime.readScope('thread',controller.signal,signal=>runtime.discoverReady(signal));
  assert.equal(first.state,'ready');assert.equal(first.value.continued,true);assert.equal(prefixCalls,1);
  assert.equal(runtime.isReadyOwner(owner),false,'retained display metadata cannot restore current presentation readiness');
  assert.equal(runtime.caption(row),'Created','a partial pass must not erase an already admitted descriptor label for a still-listed owner');
  let second; for(let i=0;i<32;i++) second=await runtime.readScope('thread',controller.signal,signal=>runtime.discoverReady(signal));
  assert.equal(prefixCalls,32); assert.equal(second.value.continued,false);assert.equal(runtime.caption(row),'Created');assert.equal(runtime.isReadyOwner(owner),true);
  const quiet=f.stats();await settle(25);assert.deepEqual(f.stats(),quiet);
  f.sdk.plugins.list=async()=>({plugins:[]});runtime.invalidateReadiness();await runtime.readScope('thread',controller.signal,signal=>runtime.discoverReady(signal));
  assert.equal(runtime.caption(row),'Result recorded','no descriptor identity is invented after the owner disappears from discovery');
 } finally {controller.abort();runtime.dispose();await f.dispose()}
});

test('inactive public lazy host diagnostic stays visually hidden behind the usable fallback', async () => {
  const f = await fixture(1); let loads = 0;
  try {
    await until(() => f.stats().live === 1);
    const card = document.querySelector('[data-result-key="row-0"]');
    const opener = card.querySelector('.tr-expand-icon');
    await act(async () => { f.register(async () => { loads++; throw Error('intentional unavailable presentation chunk'); }); });
    await until(() => loads === 1 && card.querySelector('[data-bb-presentation-failed]') && f.stats().live === 0);
    const marker = card.querySelector('[data-bb-presentation-failed]');
    const hosted = marker.closest('.tr-hosted'), fallback = card.querySelector('.tr-fallback');
    const visibility = element => f.dom.window.getComputedStyle(element).visibility;
    console.log('FALLBACK_DIAGNOSTIC_VISIBILITY', JSON.stringify({ marker: marker.textContent,
      markerVisibility: visibility(marker), hostedVisibility: visibility(hosted), fallbackVisibility: visibility(fallback),
      inert: hosted.hasAttribute('inert'), ariaHidden: hosted.getAttribute('aria-hidden'), loads }));
    assert.equal(visibility(marker), 'hidden', 'an inactive public error marker must not paint over the visible fallback');
    assert.equal(visibility(hosted), 'hidden'); assert.equal(visibility(fallback), 'visible');
    assert.equal(hosted.hasAttribute('inert'), true); assert.equal(hosted.getAttribute('aria-hidden'), 'true');
    const primary = fallback.querySelector('.tr-data-action');
    await act(async () => { primary.focus(); primary.click(); });
    assert.equal(document.activeElement, primary); assert.deepEqual(f.navigation, ['https://fixture.invalid/0']);
    const reads = f.nativeCalls.length, lists = f.stats().listCalls;
    await settle(50); assert.equal(loads, 1); assert.equal(f.nativeCalls.length, reads); assert.equal(f.stats().listCalls, lists);
    await act(async () => { f.register(); }); await until(() => f.stats().live === 1);
    assert.equal(document.activeElement, primary, 'ready replacement must not conceal its focused fallback');
    assert.equal(visibility(fallback), 'visible'); assert.equal(visibility(hosted), 'hidden');
    assert.equal(card.querySelector('.tr-expand-icon'), opener);
    await act(async () => opener.focus()); await until(() => visibility(fallback) === 'hidden');
    assert.equal(visibility(card.querySelector('.tr-hosted')), 'visible'); assert.equal(document.activeElement, opener);
    assert.equal(card.querySelector('[data-bb-presentation-failed]'), null); assert.equal(f.stats().rpc, 0); assert.equal(f.stats().peak, 1);
  } finally { await f.dispose(); }
});


test('one transient public Describe failure autonomously recovers the same three cards after a yielded bounded retry', async () => {
  const f = await fixture(1, true, { sameTurnClaims: 3 });
  const rpc = f.sdk.plugins.callRpc;
  let attempts = 0, release = () => {}, injected = 0;
  const cards = () => [...document.querySelectorAll('[data-result-key]')];
  const shown = element => element && f.dom.window.getComputedStyle(element).visibility === 'visible';
  const rich = () => cards().filter(card => shown(card.querySelector('.tr-hosted')) && !card.querySelector('.tr-hosted').hasAttribute('inert'));
  try {
    await until(() => rich().length === 3 && f.stats().live === 3);
    const original = cards(), shell = document.querySelector('[data-turn-results-gallery]');
    const native = document.querySelector('[data-timeline-row-id="opaque-0"]');
    const openers = original.map(card => card.querySelector('.tr-expand-icon'));
    const facts = JSON.stringify(f.rows());
    f.sdk.plugins.callRpc = async args => {
      if (args.pluginId === owner && args.method === METHODS.describe) {
        attempts++;
        if (attempts === 1) {
          injected++;
          throw Object.assign(new Error('one transient registered Describe handler failure'), {
            status: 500, body: { error: { code: 'handler_error' } },
          });
        }
        if (attempts === 2) await new Promise(resolve => { release = resolve; });
      }
      return rpc(args);
    };
    await f.reconnect();
    await until(() => attempts === 2 && f.stats().live === 0 && rich().length === 0);
    assert.equal(injected, 1); assert.equal(f.stats().listCalls, 3);
    assert.ok(cards().every(card => shown(card.querySelector('.tr-fallback'))));
    const beforeRelease = f.nativeCalls.length;
    await act(async () => { release(); await tick(); });
    await until(() => rich().length === 3 && f.stats().live === 3);
    assert.equal(attempts, 2, 'one initial failure and one shared automatic retry, not one retry per card');
    assert.equal(document.querySelector('[data-turn-results-gallery]'), shell);
    assert.equal(document.querySelector('[data-timeline-row-id="opaque-0"]'), native);
    assert.equal(JSON.stringify(f.rows()), facts);
    for (const [i, card] of cards().entries()) { assert.equal(card, original[i]); assert.equal(card.querySelector('.tr-expand-icon'), openers[i]); }
    assert.equal(f.nativeCalls.length, beforeRelease, 'descriptor completion needs no new native hint or read');
    await settle(50);
    const idle = f.stats(), reads = f.nativeCalls.length;
    await settle(100); assert.deepEqual(f.stats(), idle); assert.equal(f.nativeCalls.length, reads);
    assert.ok(f.stats().peak <= 4); assert.equal(f.stats().rpc, 0);
    console.log('TRANSIENT_AUTOMATIC_RECOVERY', JSON.stringify({ rich: rich().length, attempts, injected,
      sameCards: 3, sameShell: true, sameConsumerExpand: 3, factsUnchanged: true, stats: f.stats(), nativeRecoveryClaim: false }));
  } finally { release(); f.sdk.plugins.callRpc = rpc; await f.dispose(); }
});


test('consumer Expand names distinguish two full source titles and restore the exact second opener', async () => {
  const f = await fixture(2);
  try {
    await until(() => f.stats().live === 2);
    const buttons = [...document.querySelectorAll('.tr-expand-icon')];
    assert.deepEqual(buttons.map(button => button.getAttribute('aria-label')), ['Expand Saved result 0', 'Expand Saved result 1']);
    assert.deepEqual(buttons.map(button => button.title), ['Expand Saved result 0', 'Expand Saved result 1']);
    const second = buttons[1]; await act(async () => { second.focus(); second.click(); });
    await until(() => f.stats().full === 1);
    assert.equal(document.querySelector('dialog [data-supplier]').textContent, 'Referent 1');
    await act(async () => document.querySelector('dialog').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    await until(() => !document.querySelector('dialog')); assert.equal(document.activeElement, second);
    assert.equal(second, document.querySelector('[data-result-key="row-1"] .tr-expand-icon'));
    assert.ok(f.stats().peak <= 4); assert.equal(f.stats().rpc, 0);
  } finally { await f.dispose(); }
});

test('cold three retained claims survive delayed public registration with useful focusable card-aligned fallback', async () => {
  const f = await fixture(1, true, { sameTurnClaims: 3, deferPresentation: true });
  try {
    await until(() => document.querySelectorAll('[data-result-key]').length === 3);
    const cards = [...document.querySelectorAll('[data-result-key]')], shell = document.querySelector('[data-turn-results-gallery]');
    const fallback = cards[0].querySelector('.tr-fallback .tr-data-action');
    const text = fallback.textContent, opener = cards[0].querySelector('.tr-expand-icon');
    const style = document.createElement('style'); style.textContent = readFileSync(new URL('../app.css', import.meta.url), 'utf8'); document.head.append(style);
    assert.equal(window.getComputedStyle(fallback).backgroundColor, 'rgba(0, 0, 0, 0)');
    assert.match(text, /Saved result/); assert.match(fallback.getAttribute('aria-label'), /https:\/\/fixture.invalid\/0/);
    await act(async () => fallback.focus()); const reads = f.nativeCalls.length, lists = f.stats().listCalls;
    await act(async () => f.register()); await until(() => f.stats().live === 3);
    assert.equal(document.activeElement, fallback); assert.equal(window.getComputedStyle(cards[0].querySelector('.tr-fallback')).visibility, 'visible');
    assert.equal(fallback.textContent, text); assert.equal(document.querySelector('[data-turn-results-gallery]'), shell);
    for (const [i, card] of [...document.querySelectorAll('[data-result-key]')].entries()) assert.equal(card, cards[i]);
    await act(async () => opener.focus()); await until(() => window.getComputedStyle(cards[0].querySelector('.tr-hosted')).visibility === 'visible');
    assert.equal(f.nativeCalls.length, reads); assert.equal(f.stats().listCalls, lists); assert.equal(f.stats().peak, 3); style.remove();
  } finally { await f.dispose(); }
});

test('five custom claims share at most four canvases while queued fallback remains useful and guarded', async () => {
  const f = await fixture(5, true, { deferPresentation: true });
  try {
    await until(() => document.querySelectorAll('[data-result-key]').length === 5);
    const last = document.querySelector('[data-result-key="row-4"]'), fallback = last.querySelector('.tr-fallback .tr-data-action');
    assert.match(fallback.textContent, /Saved result 4/); await act(async () => fallback.focus());
    await act(async () => f.register()); await until(() => f.stats().live === 4);
    assert.equal(document.activeElement, fallback); assert.equal(window.getComputedStyle(last.querySelector('.tr-fallback')).visibility, 'visible');
    await act(async () => fallback.click()); assert.deepEqual(f.navigation, ['https://fixture.invalid/4']);
    const old = f.captured.at(-1); await f.hidden(true); await until(() => f.stats().live === 0);
    old.navigate.openUrl('https://fixture.invalid/stale'); assert.equal(f.navigation.length, 1);
    assert.ok(f.stats().peak <= 4); assert.equal(f.stats().rpc, 0);
  } finally { await f.dispose(); }
});

test('scroll-same-turn sibling windowing retains visual presentation while action proof revalidates', async()=>{
 const result={state:'running',phases:[],history:[],publicRpc:[],cleanup:null};
 const f=await fixture(1,true,{sameTurnClaims:3,nativeItems:true,terminalRow:{id:'opaque-0',threadId:'thread',turnId:'turn-0',kind:'conversation',role:'assistant',status:'completed',sourceSeqStart:3,sourceSeqEnd:5},structuralRows:[{id:'public-earlier-command',threadId:'thread',turnId:'turn-0',kind:'turn',status:'completed',sourceSeqStart:1,sourceSeqEnd:2}]});
 const visible=node=>!!node&&f.dom.window.getComputedStyle(node).visibility!=='hidden';
 const cards=()=>[...document.querySelectorAll('[data-result-key]')];
 const rich=()=>cards().filter(card=>visible(card.querySelector('.tr-hosted'))&&card.querySelector('[data-supplier]')&&!card.querySelector('.tr-hosted').hasAttribute('inert'));
 const snapshot=label=>{const v={label,rich:rich().length,fallback:cards().filter(card=>visible(card.querySelector('.tr-fallback'))).length,cards:cards().map(card=>({key:card.dataset.resultKey,hostInert:card.querySelector('.tr-hosted')?.hasAttribute('inert'),hostVisibility:card.querySelector('.tr-hosted')?.style.visibility,opener:!!card.querySelector('.tr-expand-icon')})),stats:f.stats()};result.phases.push(v);console.log('SCROLL_PHASE',JSON.stringify(v));return v;};
 let release, released=false, releases=0;
 const gate=new Promise(done=>{release=()=>{if(!released){released=true;releases++;done();}};});
 const history=f.sdk.threads.timeline,rpc=f.sdk.plugins.callRpc;
 let pending;
 try{
  await until(()=>cards().length===3&&rich().length===3&&f.stats().live===3);await settle(30);
  const row=document.querySelector('[data-timeline-row-id="opaque-0"]'),shell=row.querySelector('[data-turn-results-gallery]'),pane=row.closest('[data-thread-window]');
  const command=document.querySelector('[data-timeline-row-id="public-earlier-command"]');
  assert.equal(command.parentElement.getAttribute('data-timeline-items'),'');
  const originalCards=cards(),openers=originalCards.map(card=>card.querySelector('.tr-expand-icon')),frames=originalCards.map(card=>card.querySelector('[data-supplier]'));
  const prior=[...f.captured],facts=JSON.stringify(f.rows()),lists=f.stats().listCalls,initialNative=f.nativeCalls.length;
  assert.equal(document.activeElement.closest?.('.tr-fallback'),null);snapshot('initial-rich');
  f.sdk.plugins.callRpc=async args=>{const out=await rpc(args);result.publicRpc.push({plugin:args.pluginId,method:args.method,state:out?.state??null});return out;};
  f.sdk.threads.timeline=async input=>{
   const call={threadId:input.threadId,beforeAnchorId:input.beforeAnchorId??null,completed:false,aborted:false};result.history.push(call);
   let abort;
   try{await Promise.race([gate,new Promise((_,reject)=>{abort=()=>reject(input.signal.reason??Error('aborted'));input.signal.addEventListener('abort',abort,{once:true});if(input.signal.aborted)abort();})]);input.signal.throwIfAborted();
    const output=await history(input);call.completed=true;call.rows=structuredClone(output.rows);return output;
   }catch(error){call.aborted=input.signal.aborted;throw error;}finally{input.signal.removeEventListener('abort',abort);}
  };
  // Exact native structural shape: one known nonterminal same-turn row is
  // detached from the top-level items wrapper; final row and shell stay put.
  await act(async()=>{command.remove();await tick();});
  await until(()=>result.history.length===1);await settle();
  pending=snapshot('fresh-history-held');assert.deepEqual(cards().map(card=>card.querySelector('[data-supplier]')),frames,'existing presenter DOM stays mounted');assert.equal(f.stats().setups,3);assert.equal(f.stats().cleanups,0);
  assert.equal(row,document.querySelector('[data-timeline-row-id="opaque-0"]'));assert.equal(shell,row.querySelector('[data-turn-results-gallery]'));assert.equal(pane,row.closest('[data-thread-window]'));
  assert.ok(row.isConnected&&shell.isConnected);assert.deepEqual(cards(),originalCards);assert.equal(command.isConnected,false);
  const before=f.navigation.length;for(const props of prior)props.navigate.openUrl('https://fixture.invalid/old-before-revalidation');
  await act(async()=>{openers[0].click();await tick();});
  assert.equal(f.navigation.length,before,'captured public actions cannot navigate while native proof is suspended');assert.equal(document.querySelector('dialog'),null,'consumer Expand cannot act on suspended proof');
  result.pendingActionsRefused=true;assert.equal(JSON.stringify(f.rows()),facts);assert.equal(f.stats().listCalls,lists);
  await act(async()=>{release();await tick();});await until(()=>rich().length===3&&f.stats().live===3);
  const recovered=snapshot('unchanged-proof-recovered');assert.deepEqual(cards().map(card=>card.querySelector('[data-supplier]')),frames);assert.equal(f.stats().setups,3);assert.equal(f.stats().cleanups,0);
  assert.equal(result.history.length,1);assert.equal(result.history[0].completed,true);assert.equal(result.history[0].aborted,false);assert.equal(releases,1);
  assert.equal(f.nativeCalls.length,initialNative+1);assert.deepEqual(cards(),originalCards);assert.equal(shell,row.querySelector('[data-turn-results-gallery]'));
  cards().forEach((card,i)=>assert.equal(card.querySelector('.tr-expand-icon'),openers[i]));
  assert.equal(JSON.stringify(f.rows()),facts);assert.equal(f.stats().listCalls,lists);assert.equal(result.publicRpc.filter(c=>c.method===METHODS.describe).length,0);assert.ok(f.stats().peak<=4);
  const quiet={history:result.history.length,rpc:result.publicRpc.length};await settle(40);assert.deepEqual({history:result.history.length,rpc:result.publicRpc.length},quiet);
  result.sameNative=true;result.sameShell=true;result.sameCards=3;result.sameOpeners=3;result.sourceFactsUnchanged=true;result.state='causal-result-captured';
 }catch(error){result.error={message:error.message,stack:error.stack};throw error;}
 finally{release();f.sdk.threads.timeline=history;f.sdk.plugins.callRpc=rpc;await f.dispose();result.cleanup=f.stats();}
 assert.equal(pending.rich,3,'same visible immutable rich contents must remain painted during same-turn nonterminal windowing; action authority is suspended separately');
 result.state='passed';
});

test('retained frame loses continuity for published source expiry before props commit and for actual source disable', async t => {
  for (const change of ['expiry', 'disable']) await t.test(change, async () => {
    const f = await fixture(1, true, { captureRuntime: true, nativeItems: true, sameTurnClaims: 1,
      terminalRow: { id: 'opaque-0', threadId: 'thread', turnId: 'turn-0', kind: 'conversation', role: 'assistant', status: 'completed', sourceSeqStart: 3, sourceSeqEnd: 5 },
      structuralRows: [{ id: 'public-command', threadId: 'thread', turnId: 'turn-0', kind: 'turn', status: 'completed', sourceSeqStart: 1, sourceSeqEnd: 2 }] });
    const history = f.sdk.threads.timeline; let release = () => {}, calls = 0, lease;
    try {
      await until(() => f.stats().live === 1);
      const old = f.captured.at(-1), card = document.querySelector('[data-result-key]'), frame = card.querySelector('[data-supplier]');
      const gate = new Promise(resolve => { release = resolve; });
      f.sdk.threads.timeline = async input => { calls++; await gate; input.signal.throwIfAborted(); return history(input); };
      await act(async () => { document.querySelector('[data-timeline-row-id="public-command"]').remove(); await tick(); });
      await until(() => calls === 1); assert.equal(card.querySelector('[data-supplier]'), frame);
      if (change === 'expiry') {
        lease = f.runtime().retain({ threadId: 'thread', turnId: 'turn-0', rowId: 'opaque-0', sourceSeqStart: 3, sourceSeqEnd: 5,
          turnSeqStart: 1, turnSeqEnd: 5, historySnapshot: 'public-snapshot-A' }, false);
        await act(async () => {
          lease.store.setState(previous => ({ ...previous, rows: previous.rows.map(row => ({ ...row, sourceExpired: { epoch: 'fixture', sequence: 2 } })) }));
          old.navigate.openUrl('https://fixture.invalid/expired-before-commit'); assert.equal(f.navigation.length, 0);
        });
      } else { f.enabled(false); await f.membership(); }
      await until(() => f.stats().live === 0);
      old.navigate.openUrl('https://fixture.invalid/retired-frame'); assert.equal(f.navigation.length, 0);
      assert.equal(card.querySelector('.tr-hosted').style.visibility, 'hidden'); assert.ok(card.querySelector('.tr-fallback'));
      assert.ok(f.stats().peak <= 4); assert.equal(f.stats().rpc, 0);
    } finally { release(); f.sdk.threads.timeline = history; lease?.dispose(); await f.dispose(); }
  });
});


test('optional presenter expansion hint keeps one visible guarded Open and updates without unrelated registry work', async () => {
  const f = await fixture(1, true, { deferPresentation: true });
  const controller = new AbortController(); let dispose = () => {};
  const register = (hint, generation) => {
    dispose(); dispose = registerPresentation({ pluginId: owner, generation, signal: controller.signal }, {
      schema, methods: [], decode: value => value, load: async () => f.renderer,
      ...(hint === undefined ? {} : { supportsExpansion: hint }),
    });
  };
  try {
    await until(() => document.querySelector('[data-result-key="row-0"]'));
    const card = document.querySelector('[data-result-key="row-0"]');
    assert.ok(card.querySelector('.tr-expand-icon'), 'unavailable legacy metadata retains existing affordance');
    await act(async () => register(false, 100)); await until(() => f.stats().live === 1);
    assert.equal(Boolean(card.querySelector('.tr-expand-icon')), false, 'no separate full view for bounded-excerpt-only presenter');
    const open = card.querySelector('.tr-open-primary');
    assert.ok(open); assert.equal(open.textContent, 'Open'); assert.equal(open.tagName, 'BUTTON');
    assert.match(open.getAttribute('aria-label'), /Saved result 0.*https:\/\/fixture.invalid\/0/);
    const style = document.createElement('style'); style.textContent = readFileSync(new URL('../app.css', import.meta.url), 'utf8'); document.head.append(style);
    assert.equal(window.getComputedStyle(open).opacity, '1', 'ordinary action is visible without hover/focus');
    await act(async () => { open.focus(); open.click(); });
    assert.deepEqual(f.navigation, ['https://fixture.invalid/0']); assert.equal(document.activeElement, open);
    assert.equal(document.querySelector('dialog'), null); assert.equal(f.captured.at(-1).requestFull, undefined);
    const calls = f.nativeCalls.length, rpc = f.stats().rpc;
    const unrelated = new AbortController();
    await act(async () => { const d = registerPresentation({ pluginId: 'unrelated-owner', generation: 1, signal: unrelated.signal }, { schema: 'unrelated-owner/card@1', methods: [], decode: value => value, load: async () => f.renderer, supportsExpansion: false }); d(); });
    assert.equal(card.querySelector('.tr-open-primary'), open); assert.equal(document.activeElement, open);
    await settle(60); assert.equal(f.nativeCalls.length, calls); assert.equal(f.stats().rpc, rpc);
    await act(async () => register(true, 101)); await until(() => card.querySelector('.tr-expand-icon') && f.stats().live === 1);
    const expand = card.querySelector('.tr-expand-icon');
    // The synchronous registration event may precede React's next commit.
    await act(async () => { register(false, 102); expand.click(); });
    await until(() => f.stats().live === 1); assert.equal(document.querySelector('dialog'), null);
    assert.equal(card.querySelector('.tr-expand-icon'), null);
    await act(async () => register(undefined, 103)); await until(() => card.querySelector('.tr-expand-icon') && f.stats().live === 1);
    assert.ok(card.querySelector('.tr-open-icon')); assert.equal(card.querySelector('.tr-open-primary'), null);
    assert.ok(f.stats().peak <= 4); assert.equal(f.stats().rpc, 0); style.remove();
  } finally { dispose(); controller.abort(); await f.dispose(); }
});

test('priority Open verification yields ordinary collection without changing5s or lane limits', async () => {
 const result={classification:'running',limits:queueLimits,history:[],rpc:[],phases:[],cleanup:null};
 const save=()=>{};
 const f=await fixture(2,true,{captureRuntime:true,deferPresentation:true,nativeItems:true});
 const runtime=f.runtime(),originalRpc=f.sdk.plugins.callRpc,originalHistory=f.sdk.threads.timeline;
 let arm=false,heldCall=null,release=()=>{},released=false,live=0,peak=0;
 const gate=new Promise(done=>{release=()=>{if(!released){released=true;result.releasedAt=performance.now();done();}};});
 let facts,card,shell,native,initialCalls,clickAt,blocked;
 const phase=label=>{const v={label,at:performance.now(),status:card?.querySelector('[data-turn-result-open-status]')?.textContent??null,navigation:[...f.navigation],runtime:runtime.stats(),canvases:runtime.canvases.counts()};result.phases.push(v);return v;};
 try {
  await until(()=>document.querySelectorAll('[data-result-key]').length===2&&runtime.stats().running===0&&runtime.stats().queued===0);
  await settle(30);
  native=document.querySelector('[data-timeline-row-id="opaque-0"]');card=native.querySelector('[data-result-key="row-0"]');shell=native.querySelector('[data-turn-results-gallery]');
  assert.ok(card&&shell&&card.isConnected);facts=JSON.stringify(f.rows());initialCalls=f.nativeCalls.length;
  f.sdk.plugins.callRpc=async args=>{
   const call={method:args.method,turnId:args.input?.turnId??null,threadId:args.input?.threadId??null,startedAt:performance.now(),finished:false,aborted:false};result.rpc.push(call);live++;peak=Math.max(peak,live);
   const hold=arm&&args.method===GALLERY_METHODS.read&&args.input.turnId==='turn-1';
   if(hold){arm=false;heldCall=call;call.held=true;call.signal=args.signal?undefined:'missing';}
   let abort;
   try{
    if(hold)await Promise.race([gate,new Promise((_,reject)=>{abort=()=>reject(args.signal.reason??Error('aborted'));args.signal.addEventListener('abort',abort,{once:true});if(args.signal.aborted)abort();})]);
    args.signal?.throwIfAborted();const value=await originalRpc(args);call.finished=true;return value;
   }catch(error){call.aborted=!!args.signal?.aborted;call.error=String(error?.message??error);throw error;}
   finally{if(abort)args.signal.removeEventListener('abort',abort);call.endedAt=performance.now();live--;}
  };
  f.sdk.threads.timeline=async input=>{const call={startedAt:performance.now(),threadId:input.threadId,beforeAnchorId:input.beforeAnchorId??null,finished:false};result.history.push(call);live++;peak=Math.max(peak,live);try{const value=await originalHistory(input);call.finished=true;call.snapshot=value.timelinePage.historySnapshot;call.rows=value.rows.map(row=>({id:row.id,turnId:row.turnId,start:row.sourceSeqStart,end:row.sourceSeqEnd}));return value;}finally{call.endedAt=performance.now();live--;}};
  phase('initial-visible-confirmed');arm=true;
  // Genuine native change in OTHER turn -> unchanged public boundary -> ordinary
  // retained read of that other turn. No private invalidation or demand call.
  await act(async()=>{document.querySelector('[data-timeline-row-id="opaque-1"] > button').firstChild.data='Other turn native update';await tick();});
  await until(()=>heldCall!==null);
  assert.equal(heldCall.aborted,false);assert.equal(runtime.stats().running,1);
  phase('other-turn-ordinary-read-held');
  // The target itself now needs genuine fresh history; its physical final row,
  // card, route and immutable source facts remain identical.
  await act(async()=>{native.querySelector(':scope > button').firstChild.data='Target native proof changed';await tick();});
  await settle(175);
  const button=card.querySelector('button.tr-data-action');assert.ok(button&&button.isConnected);
  clickAt=performance.now();result.clickAt=clickAt;
  await act(async()=>{button.dispatchEvent(new f.dom.window.MouseEvent('click',{bubbles:true,detail:1}));await tick();});
  assert.ok(f.navigation.length===1||/Checking/.test(card.querySelector('[data-turn-result-open-status]')?.textContent??''));
  phase('one-explicit-open-checking');
  await until(()=>f.navigation.length===1);
  blocked=phase('priority-verified-before-original-gate-release');result.blocked=blocked;
  result.historyDispatchedDuringAction=result.history.filter(call=>call.startedAt>=clickAt).length;
  result.retainedReadsDispatchedDuringAction=result.rpc.filter(call=>call.startedAt>=clickAt&&call.method===GALLERY_METHODS.read&&call.turnId==='turn-0').length;
  result.ordinaryHeldMs=blocked.at-heldCall.startedAt;
  assert.equal(blocked.status,null);assert.ok(blocked.at-clickAt<5000);
  assert.deepEqual(f.navigation,['https://fixture.invalid/0']);assert.ok(result.historyDispatchedDuringAction>=1);assert.ok(result.retainedReadsDispatchedDuringAction>=1);
  assert.equal(heldCall.aborted,true,'ordinary public read acknowledges cancellation before the action owns its lane');
  assert.ok(result.ordinaryHeldMs<queueLimits.sliceMs,'capture must occur before the ordinary slice deadline');
  assert.equal(card,native.querySelector('[data-result-key="row-0"]'));assert.equal(shell,native.querySelector('[data-turn-results-gallery]'));assert.equal(JSON.stringify(f.rows()),facts);
  await act(async()=>{release();await tick();});
  await until(()=>runtime.stats().running===0&&runtime.stats().queued===0);
  assert.equal(f.navigation.length,1,'lane resumption never replays an already consumed action');
  // Later positive control in this SAME case: ordinary native demand obtains
  // fresh unchanged public history; a new explicit Open uses that authority.
  const historyBefore=result.history.length;
  await act(async()=>{native.querySelector(':scope > button').firstChild.data='Later ordinary target verification';await tick();});
  await until(()=>result.history.length>historyBefore&&runtime.stats().running===0&&runtime.stats().queued===0);
  assert.equal(card,native.querySelector('[data-result-key="row-0"]'));assert.equal(JSON.stringify(f.rows()),facts);
  await act(async()=>{card.querySelector('button.tr-data-action').click();await tick();});
  assert.deepEqual(f.navigation,['https://fixture.invalid/0','https://fixture.invalid/0']);assert.equal(card.querySelector('[data-turn-result-open-status]'),null);
  phase('same-target-fresh-authority-opens');assert.equal(peak,1);assert.ok(f.stats().peak<=4);assert.equal(f.stats().rpc,0);
  result.peakPublicReads=peak;result.samePhysicalTarget=true;result.factsUnchanged=true;result.initialNativeCalls=initialCalls;
  const idle={history:result.history.length,rpc:result.rpc.length};await settle(50);assert.deepEqual({history:result.history.length,rpc:result.rpc.length},idle);
  result.classification='priority-action-verified-and-ordinary-resumed-not-native-proof';result.firstOpenMs=blocked.at-clickAt;assert.ok(result.rpc.filter(call=>call.method===GALLERY_METHODS.read&&call.turnId==='turn-1').length>=2);save();
 }catch(error){result.error={message:error.message,stack:error.stack};save();throw error;}
 finally{
  release();f.sdk.plugins.callRpc=originalRpc;f.sdk.threads.timeline=originalHistory;
  await f.dispose();await runtime.whenDrained();result.cleanup={runtime:runtime.stats(),canvases:runtime.canvases.counts(),publicReadsLive:live,fixture:f.stats()};save();
  assert.equal(live,0);assert.equal(result.cleanup.runtime.running,0);assert.equal(result.cleanup.runtime.queued,0);assert.equal(result.cleanup.runtime.historyReads,0);assert.equal(result.cleanup.runtime.leases,0);assert.equal(result.cleanup.canvases.occupied,0);
 }
});

test('cold proved turns publish indexed previews before unrelated optional supplier work', async () => {
  let release, held = false, released = false, live = 0, peak = 0, steps = 0, commits = 0;
  const reads = [], gate = new Promise(done => { release = () => { released = true; done(); }; });
  const f = await fixture(2, true, { captureRuntime: true, nativeItems: true, deferPresentation: true,
    configureSdk(sdk) {
      const original = sdk.plugins.callRpc;
      sdk.plugins.callRpc = async args => {
        live++; peak = Math.max(peak, live);
        try {
          if (args.method === GALLERY_METHODS.read) reads.push(args.input.turnId);
          if (args.method === GALLERY_METHODS.prepare) steps++;
          if (!held && args.method === GALLERY_METHODS.prepare) { held = true; await gate; }
          if (args.method === GALLERY_METHODS.apply) commits++;
          args.signal?.throwIfAborted(); return await original(args);
        } finally { live--; }
      };
    } });
  const runtime = f.runtime();
  try {
    await until(() => held);
    await settle();
    const target = document.querySelector('[data-timeline-row-id="opaque-1"] [data-result-key="row-1"] .tr-data-action');
    console.log('COLD_RETAINED_BEFORE_OPTIONAL_RELEASE', JSON.stringify({ reads, targetUseful: !!target, released, peak, stats: runtime.stats() }));
    assert.ok(reads.includes('turn-0'), 'earlier retained read completed');
    assert.equal(released, false);
    assert.ok(target?.isConnected && target.textContent.includes(f.rows()[1].resolution.fallback.title), 'indexed target useful preview must precede unrelated supplier release');
    assert.equal(peak, 1, 'same-thread actual public occupancy never overlaps');
    await act(async () => { release(); await tick(); });
    await until(() => runtime.stats().running === 0 && runtime.stats().queued === 0);
    assert.ok(steps > 1 && commits > 0, 'ordinary supplier stage/commit progress resumes after the retained-first turn');
    assert.equal(target, document.querySelector('[data-result-key="row-1"] .tr-data-action'));
    const idle = reads.length; await settle(); assert.equal(reads.length, idle);
  } finally {
    release(); await f.dispose(); await runtime.whenDrained();
    assert.equal(live, 0); assert.equal(runtime.stats().running, 0); assert.equal(runtime.stats().queued, 0);
    assert.equal(runtime.stats().leases, 0); assert.equal(runtime.canvases.counts().occupied, 0);
  }
});


test('validated positive prefix is visible but cannot Open, capture or acquire a custom lease before complete membership', async () => {
  const result = { phases: [], calls: [], cleanup: null, nativeClaim: false };
  const save = () => {};
  let release, released = false, held = false, live = 0, peak = 0, issued = null;
  const gate = new Promise(done => { release = () => { released = true; done(); }; });
  const f = await fixture(1, true, { captureRuntime: true, nativeItems: true, sameTurnClaims: 10,
    configureSdk(sdk) {
      const rpc = sdk.plugins.callRpc;
      sdk.plugins.callRpc = async args => {
        if (args.method !== GALLERY_METHODS.read) return rpc(args);
        const call = { turn: args.input.turnId, after: args.input.after ?? null, start: performance.now() }; result.calls.push(call);
        live++; peak = Math.max(peak, live);
        try {
          if (args.input.after) {
            assert.deepEqual(args.input.after, issued, 'continuation must be exactly the public issued cursor');
            if (!held) { held = true; await gate; }
          }
          args.signal?.throwIfAborted(); const value = await rpc(args);
          call.keys = value.page.rows.map(row => row.key); call.next = value.page.next; call.finished = performance.now();
          if (!args.input.after) issued = structuredClone(value.page.next);
          return value;
        } finally { live--; }
      };
    } });
  const runtime = f.runtime(), facts = JSON.stringify(f.rows());
  try {
    await until(() => held);
    await settle();
    const native = document.querySelector('[data-timeline-row-id="opaque-0"]');
    const shell = native.querySelector('[data-turn-results-gallery]');
    const prefix = shell.querySelector('[data-result-key="claim-0"]');
    const pending = { phase: 'issued-next-page-held', nativeConnected: native.isConnected, shellConnected: shell.isConnected,
      nativePublic: f.nativeCalls.map(call => ({ threadId: call.threadId, beforeAnchorId: call.beforeAnchorId ?? null })),
      prefixVisible: !!prefix && f.dom.window.getComputedStyle(prefix).visibility !== 'hidden',
      cards: shell.querySelectorAll('[data-result-key]').length, customLive: f.stats().live,
      ownerReady: runtime.isReadyOwner(owner), canOpen: prefix?.querySelector('.tr-data-action')?.disabled === false,
      occupancy: runtime.canvases.counts(), stats: runtime.stats(), peak, released };
    result.phases.push(pending); save();
    assert.ok(native.isConnected && shell.isConnected); assert.equal(f.nativeCalls.length, 1);
    assert.equal(result.calls[0].keys.length, 8); assert.ok(issued); assert.equal(result.calls.length, 2);
    assert.equal(pending.customLive, 0); assert.equal(pending.occupancy.occupied, 0);
    assert.equal(pending.ownerReady, true, 'early descriptor readiness does not authorize partial membership actions or custom leases');
    assert.equal(pending.canOpen, false); assert.equal(f.navigation.length, 0);
    assert.equal(prefix.querySelector('.tr-data-action').disabled, true);
    assert.ok([...prefix.querySelectorAll('button')].every(button => button.disabled));
    await act(async () => { for (const button of prefix.querySelectorAll('button')) button.dispatchEvent(new f.dom.window.MouseEvent('click', { bubbles: true })); await tick(); });
    assert.equal(f.navigation.length, 0); assert.equal(result.calls.length, 2);
    assert.equal(prefix.querySelector('[data-turn-result-open-status]'), null);
    assert.equal(runtime.canvases.counts().requests, 0);
    assert.equal(peak, 1); assert.equal(released, false);
    // Complete the same chain before the final RED assertion, preserving a
    // usable completion/control and exact cleanup even when prefix is absent.
    await act(async () => { release(); await tick(); });
    await until(() => shell.querySelectorAll('[data-result-key]').length === 10 && f.stats().live === 4 && runtime.stats().running === 0 && runtime.stats().queued === 0);
    assert.equal(native.querySelector('[data-turn-results-gallery]'), shell);
    assert.equal(JSON.stringify(f.rows()), facts); assert.equal(result.calls[1].keys.length, 2); assert.equal(result.calls[1].next, null);
    assert.equal(f.stats().peak, 4); assert.equal(f.stats().rpc, 0);
    const opener = shell.querySelector('[data-result-key="claim-0"] .tr-open-icon');
    assert.ok(opener?.isConnected); await act(async () => { opener.click(); await tick(); });
    assert.deepEqual(f.navigation, ['https://fixture.invalid/0']);
    result.phases.push({ phase: 'complete-same-chain', cards: shell.querySelectorAll('[data-result-key]').length,
      live: f.stats().live, actions: [...f.navigation], factsUnchanged: true, samePhysicalShell: true, occupancy: runtime.canvases.counts() });
    save();
    assert.equal(pending.prefixVisible, true, 'validated useful first-page prefix must display before issued next-page release');
  } catch (error) { result.error = { message: error.message, stack: error.stack }; save(); throw error; }
  finally {
    release(); await f.dispose(); await runtime.whenDrained();
    result.cleanup = { live, peak, runtime: runtime.stats(), canvases: runtime.canvases.counts(), fixture: f.stats() }; save();
    assert.equal(live, 0); assert.equal(runtime.stats().running, 0); assert.equal(runtime.stats().queued, 0); assert.equal(runtime.stats().leases, 0); assert.equal(runtime.canvases.counts().occupied, 0);
  }
});

test('image Media shares passive native lanes and owns dispatched response after local retirement', async () => {
  const { untilAborted } = await import('../gallery/lifetime.ts');
  let releaseRead, releaseOther, releaseMedia, arm = false, readHeld = false, firstMediaHeld = false;
  let raw = 0, mediaRaw = 0, other = 0, combinedPeak = 0, mediaPeak = 0;
  const mediaCalls = [], sourceCalls = [];
  const count = () => { combinedPeak = Math.max(combinedPeak, raw + mediaRaw + other); mediaPeak = Math.max(mediaPeak, mediaRaw); };
  const readGate = new Promise(done => { releaseRead = done; }), otherGate = new Promise(done => { releaseOther = done; });
  const mediaGate = new Promise(done => { releaseMedia = done; });
  const f = await fixture(2, true, { captureRuntime: true, nativeItems: true, loadedImage: true, fileRoute: true,
    owner: 'turn-result-images', manualImageVisibility: true, distinctImageTargets: true,
    configureSdk(sdk) {
      const rpc = sdk.plugins.callRpc, timeline = sdk.threads.timeline;
      sdk.threads.timeline = async input => { raw++; count(); try { return await timeline(input); } finally { raw--; } };
      sdk.plugins.callRpc = args => {
        if (args.method === 'turnResultImagesV1Media') {
          const call = { event: args.input.identity.ref.source.eventId, signal: args.signal, finished: false };
          mediaCalls.push(call);
          // Model the actual transport boundary: abort can reject the client
          // fetch while the source handler's independent operation still runs.
          const source = (async () => {
            mediaRaw++; count();
            try {
              if (!firstMediaHeld) { firstMediaHeld = true; await mediaGate; }
              const value = await rpc(args); call.finished = true; return value;
            } finally { mediaRaw--; }
          })();
          sourceCalls.push(source);
          return args.signal ? untilAborted(source, args.signal) : source;
        }
        return (async () => {
          raw++; count();
          try {
            if (arm && args.method === GALLERY_METHODS.read && args.input.turnId === 'turn-0') {
              arm = false; readHeld = true; await readGate; // deliberately ignores local abort
            }
            return await rpc(args);
          } finally { raw--; }
        })();
      };
    } });
  const runtime = f.runtime(), control = new AbortController(); let otherRead;
  try {
    await until(() => document.querySelectorAll('[data-result-key]').length === 2 && runtime.stats().running === 0 && runtime.stats().queued === 0);
    assert.deepEqual(f.mediaCounts(), { calls: 0, fetches: 0 });
    const facts = JSON.stringify(f.rows()); arm = true;
    await act(async () => { document.querySelector('[data-timeline-row-id="opaque-0"] > button').firstChild.data = 'Ordinary current image turn demand'; await tick(); });
    await until(() => readHeld);
    otherRead = runtime.readScope('other-thread', control.signal, async () => { other++; count(); try { await otherGate; return 'other-complete'; } finally { other--; } });
    void otherRead.catch(() => {}); // Teardown cancellation must not mask the causal assertion.
    await until(() => other === 1);
    await f.imagesVisible(true); await settle(20);
    console.log('MEDIA_LANE_BEFORE_RETAINED_RELEASE', JSON.stringify({ dispatched: mediaCalls.map(call => call.event), combinedPeak, mediaPeak,
      raw, mediaRaw, other, runtime: runtime.stats(), image: f.mediaCounts() }));
    assert.equal(mediaCalls.length, 0, 'same-thread Media must queue behind the actual retained raw read');
    assert.equal(combinedPeak, 2);
    await act(async () => { releaseRead(); releaseOther(); await tick(); });
    assert.equal((await otherRead).state, 'ready');
    await until(() => firstMediaHeld);
    assert.equal(mediaCalls.length, 1); assert.equal(mediaRaw, 1); assert.equal(mediaCalls[0].signal, undefined,
      'dispatched source response remains owned instead of aborting its client transport on caller retirement');
    const healthy = await runtime.readScope('other-thread', control.signal, async () => { other++; count(); try { return 'healthy'; } finally { other--; } });
    assert.equal(healthy.state, 'ready');
    await f.imagesVisible(false, 'row-0'); await settle();
    assert.equal(mediaRaw, 1); assert.equal(mediaCalls[0].finished, false);
    assert.equal(mediaCalls.length, 1, 'second same-thread image remains undispatched');
    assert.equal(runtime.stats().running, 1, 'caller retirement does not free dispatched response occupancy');
    assert.equal(f.mediaCounts().fetches, 0);
    const duringRetirement = await runtime.readScope('other-thread', control.signal, async () => 'still-progressing');
    assert.equal(duringRetirement.state, 'ready', 'other-thread progress stays live while second image is queued');
    await act(async () => { releaseMedia(); await tick(); });
    await until(() => document.querySelector('[data-result-key="row-1"] img[src^="blob:"]') && mediaRaw === 0 && runtime.stats().running === 0);
    assert.equal(f.mediaCounts().fetches, 1, 'only still-visible second image downloads; retired response cannot start GET/hash/Blob');
    assert.equal(document.querySelector('[data-result-key="row-0"] img'), null);
    await f.imagesVisible(true, 'row-0');
    await until(() => document.querySelectorAll('.tr-image-action img[src^="blob:"]').length === 2 && runtime.stats().running === 0 && runtime.stats().queued === 0);
    const blobs = [...document.querySelectorAll('.tr-image-action img')].map(image => image.src);
    assert.equal(new Set(mediaCalls.map(call => call.event)).size, 2, 'two distinct immutable source identities complete');
    assert.equal(f.mediaCounts().fetches, 2); assert.equal(combinedPeak, 2); assert.equal(mediaPeak, 1);
    assert.equal(JSON.stringify(f.rows()), facts);
    const warm = { ...f.mediaCounts() }; await f.notify();
    await until(() => runtime.stats().running === 0 && runtime.stats().queued === 0); await settle();
    assert.deepEqual(f.mediaCounts(), warm); assert.deepEqual([...document.querySelectorAll('.tr-image-action img')].map(image => image.src), blobs);
    await act(async () => { for (const button of document.querySelectorAll('.tr-image-action')) button.click(); await tick(); });
    assert.deepEqual(f.fileOpenCalls.map(value => value.target), [0, 1].map(i => ({ kind: 'host', hostId: 'recorded-host', path: `/saved/result-${i}.png` })));
    console.log('MEDIA_LANE_AFTER', JSON.stringify({ mediaIdentities: mediaCalls.map(call => call.event), combinedPeak, mediaPeak,
      blobs: blobs.length, warmSameBlob: true, image: f.mediaCounts(), exactFileOpen: f.fileOpenCalls }));
  } finally {
    releaseRead(); releaseOther(); releaseMedia(); control.abort();
    await f.dispose(); await Promise.allSettled(sourceCalls); await otherRead?.catch(() => {}); await runtime.whenDrained();
    assert.equal(raw, 0); assert.equal(mediaRaw, 0); assert.equal(other, 0);
    assert.equal(runtime.stats().running, 0); assert.equal(runtime.stats().queued, 0); assert.equal(runtime.stats().historyReads, 0);
    assert.equal(runtime.media.stats().running, 0); assert.equal(runtime.canvases.counts().occupied, 0);
  }
});

test('page-boundary FIFO admits proved next turn before a later issued page and defers optional source work', async () => {
  let release, releaseOptional, held = false, optionalHeld = false, released = false, issued = null, live = 0, peak = 0;
  const calls = [], gate = new Promise(done => { release = () => { released = true; done(); }; });
  const optionalGate = new Promise(done => { releaseOptional = done; });
  const f = await fixture(2, true, { captureRuntime: true, nativeItems: true, deferPresentation: true, turnClaims: [17, 1],
    configureSdk(sdk) {
      const rpc = sdk.plugins.callRpc;
      sdk.plugins.callRpc = async args => {
        live++; peak = Math.max(peak, live);
        try {
          if (args.method === GALLERY_METHODS.read) {
            const call = { turn: args.input.turnId, after: args.input.after ?? null, start: performance.now() }; calls.push(call);
            if (args.input.turnId === 'turn-0' && args.input.after) {
              assert.deepEqual(args.input.after, issued, 'continuation uses only the preceding actually-issued cursor');
              if (!held && args.input.after.key === 'turn-0-claim-15') { held = true; await gate; }
            }
            const value = await rpc(args); call.keys = value.page.rows.map(row => row.key); call.next = value.page.next;
            if (args.input.turnId === 'turn-0') issued = structuredClone(value.page.next);
            return value;
          }
          if (!optionalHeld && args.method === GALLERY_METHODS.prepare) { optionalHeld = true; await optionalGate; }
          return await rpc(args);
        } finally { live--; }
      };
    } });
  const runtime = f.runtime(), facts = JSON.stringify(f.rows());
  try {
    await until(() => held); await settle();
    const first = document.querySelector('[data-timeline-row-id="opaque-0"] [data-turn-results-gallery]');
    const target = document.querySelector('[data-timeline-row-id="opaque-1"] [data-result-key="row-1"]');
    console.log('PAGE_FIFO_PENDING', JSON.stringify({ calls, firstCards: first.querySelectorAll('[data-result-key]').length,
      targetUseful: !!target, held, released, peak, stats: runtime.stats() }));
    assert.equal(issued.key, 'turn-0-claim-15'); assert.equal(released, false);
    assert.ok(target?.isConnected, 'proved next-turn useful preview must precede earlier later-page release');
    assert.ok(calls.findIndex(call => call.turn === 'turn-1') < calls.findIndex(call => call.turn === 'turn-0' && call.after));
    assert.equal(first.querySelectorAll('[data-result-key]').length, 16);
    assert.equal(optionalHeld, false, 'short completed turn cannot start optional work ahead of an incomplete retained continuation');
    assert.ok([...first.querySelectorAll('button')].every(button => button.disabled), 'unfinished first collection cannot Open/Expand/capture');
    assert.equal(runtime.canvases.counts().occupied, 0);
    await act(async () => { target.querySelector('.tr-open-icon').click(); await tick(); });
    assert.deepEqual(f.navigation, ['https://fixture.invalid/1'], 'independently complete target has exact current action');
    await act(async () => { release(); await tick(); });
    await until(() => first.querySelectorAll('[data-result-key]').length === 17 && optionalHeld);
    assert.equal(document.querySelector('[data-timeline-row-id="opaque-0"] [data-turn-results-gallery]'), first);
    assert.deepEqual([...first.querySelectorAll('[data-result-key]')].map(card => card.dataset.resultKey).sort(), f.rows().filter(row => row.identity.ref.source.turnId === 'turn-0').map(row => row.key).sort());
    await act(async () => { first.querySelector('.tr-open-icon').click(); await tick(); });
    assert.deepEqual(f.navigation, ['https://fixture.invalid/1', 'https://fixture.invalid/0']);
    await act(async () => { releaseOptional(); await tick(); });
    await until(() => runtime.stats().running === 0 && runtime.stats().queued === 0);
    assert.equal(JSON.stringify(f.rows()), facts); assert.equal(peak, 1);
    const idle = calls.length; await settle(); assert.equal(calls.length, idle);
  } finally {
    release(); releaseOptional(); await f.dispose(); await runtime.whenDrained();
    assert.equal(live, 0); assert.equal(runtime.stats().running, 0); assert.equal(runtime.stats().queued, 0);
    assert.equal(runtime.stats().leases, 0); assert.equal(runtime.canvases.counts().occupied, 0);
  }
});

test('visible native demand negotiates generic readiness before held older proof without early collection authority', async () => {
  let release, held = false, released = false, live = 0, peak = 0;
  const calls = [], cursor = { anchorId: 'actually-issued-older-page', anchorSeq: 20 };
  const gate = new Promise(done => { release = () => { released = true; done(); }; });
  const f = await fixture(1, true, { captureRuntime: true, nativeItems: true,
    configureSdk(sdk) {
      const history = sdk.threads.timeline, list = sdk.plugins.list, rpc = sdk.plugins.callRpc;
      const track = async (name, call) => {
        calls.push(name); live++; peak = Math.max(peak, live);
        try { return await call(); } finally { live--; }
      };
      sdk.threads.timeline = input => track(input.beforeAnchorId ? 'history:older' : 'history:latest', async () => {
        if (!input.beforeAnchorId) return { rows: [{ id: 'newer-public-row', threadId: 'thread', turnId: 'newer-turn',
          kind: 'turn', status: 'completed', sourceSeqStart: 20, sourceSeqEnd: 25 }], completedTurnDisplay: 'collapse',
          timelinePage: { historySnapshot: 'public-snapshot', olderCursor: cursor } };
        assert.equal(input.beforeAnchorId, cursor.anchorId); assert.equal(input.beforeAnchorSeq, String(cursor.anchorSeq));
        held = true; await gate; input.signal.throwIfAborted(); return history(input);
      });
      sdk.plugins.experimental_discoverRpc = () => track('advertised', async () => [{ pluginId: owner, method: METHODS.describe }]);
      sdk.plugins.list = input => track('listed', () => list(input));
      sdk.plugins.callRpc = args => track(args.method, () => rpc(args));
    } });
  const runtime = f.runtime(), facts = JSON.stringify(f.rows());
  try {
    await until(() => held); await settle(30);
    console.log('EARLY_READINESS_BEFORE_BOUNDARY', JSON.stringify({ calls, ready: runtime.isReadyOwner(owner), released, stats: runtime.stats(), peak }));
    assert.equal(released, false);
    assert.equal(runtime.isReadyOwner(owner), true, 'real listed/Describe negotiation must finish before the held older boundary');
    assert.equal(calls[0], 'history:latest', 'first genuine native history read has FIFO precedence');
    assert.equal(calls.filter(call => call === METHODS.describe).length, 1);
    assert.ok(calls.indexOf(METHODS.describe) < calls.indexOf('history:older'));
    assert.equal(document.querySelectorAll('[data-turn-results-gallery]').length, 0, 'readiness cannot manufacture native placement');
    assert.equal(document.querySelectorAll('[data-result-key]').length, 0);
    assert.equal(runtime.canvases.counts().occupied, 0); assert.equal(f.stats().live, 0);
    for (const method of [GALLERY_METHODS.read, GALLERY_METHODS.stage, GALLERY_METHODS.prepare, GALLERY_METHODS.apply, METHODS.enumerate])
      assert.equal(calls.includes(method), false, 'no early retained/source work before full native proof');
    await act(async () => { release(); await tick(); });
    await until(() => f.stats().live === 1 && runtime.stats().running === 0 && runtime.stats().queued === 0);
    const card = document.querySelector('[data-result-key="row-0"]');
    assert.ok(card.querySelector('[data-supplier]')); assert.ok(calls.includes(GALLERY_METHODS.prepare));
    await act(async () => { card.querySelector('.tr-open-icon').click(); await tick(); });
    assert.deepEqual(f.navigation, ['https://fixture.invalid/0']); assert.equal(JSON.stringify(f.rows()), facts);
    assert.equal(calls.filter(call => call === METHODS.describe).length, 1, 'ordinary source phase reuses its genuine ready descriptor');
    assert.equal(peak, 1); const idle = calls.length; await settle(40); assert.equal(calls.length, idle);
  } finally {
    release(); await f.dispose(); await runtime.whenDrained();
    assert.equal(live, 0); assert.equal(runtime.stats().running, 0); assert.equal(runtime.stats().queued, 0);
    assert.equal(runtime.stats().leases, 0); assert.equal(runtime.canvases.counts().occupied, 0);
  }
});

test('current-generation header jump warms fresh nearby retained and verified media before physical arrival, without a speculative canvas', async () => {
  const f = await fixture(2, true, { captureRuntime: true, deferNative: true, nativeItems: true,
    url: 'https://bb.invalid/projects/project/threads/thread#msg=3', loadedImage: true, mixedWarm: true, owner: 'turn-result-images', fileRoute: true });
  try {
    // This starts at the actual executable/header lifecycle, not before plugin
    // JavaScript exists. It is source proof, never a native startup benchmark.
    await settle(80);
    console.log('NAVIGATION_PRELOAD_BEFORE_ARRIVAL', JSON.stringify({ nativeReads: f.nativeCalls.length, media: f.mediaCounts(),
      roots: document.querySelectorAll('[data-turn-results-gallery]').length, canvases: f.stats().live }));
    assert.ok(f.nativeCalls.length > 0, 'the current-thread header jump must begin genuine history before native source attachment');
    await until(() => f.mediaCounts().fetches === 1 && f.runtime().stats().running === 0 && f.runtime().stats().queued === 0);
    assert.equal(document.querySelectorAll('[data-turn-results-gallery]').length, 0);
    assert.equal(f.stats().live, 0); assert.equal(f.runtime().canvases.counts().occupied, 0);
    const before = { history: f.nativeCalls.length, media: f.mediaCounts() }, facts = JSON.stringify(f.rows());
    await f.arrive();
    await until(() => document.querySelector('[data-result-key="row-0"] img[src^="blob:"]') && f.stats().live === 1);
    assert.equal(f.nativeCalls.length, before.history, 'arrival adopts only its still-owned fresh semantic-generation chain');
    assert.deepEqual(f.mediaCounts(), before.media, 'same existing verified Blob is reused without another Media/GET');
    await act(async () => document.querySelector('[data-result-key="row-0"] .tr-image-action').click());
    await act(async () => document.querySelector('[data-result-key="row-1"] .tr-open-icon').click());
    assert.equal(f.fileOpenCalls.length, 1); assert.deepEqual(f.navigation, ['https://fixture.invalid/1']);
    assert.equal(JSON.stringify(f.rows()), facts); assert.ok(f.stats().peak <= 4);
    await until(() => f.runtime().stats().running === 0 && f.runtime().stats().queued === 0);
    const idle = { history: f.nativeCalls.length, media: f.mediaCounts() }; await settle(40);
    assert.deepEqual({ history: f.nativeCalls.length, media: f.mediaCounts() }, idle);
  } finally { await f.dispose(); }
});

test('existing pane warms only the actual next one-viewport image before intersection and promotes its queued Media without duplication', async () => {
  let rawRelease, rawHeld = false, mediaStarted = false, mediaRelease;
  const rawGate = new Promise(done => { rawRelease = done; }), mediaGate = new Promise(done => { mediaRelease = done; });
  const calls = [];
  const f = await fixture(2, true, { captureRuntime: true, preloadNearby: true, nativeItems: true,
    url: 'https://bb.invalid/projects/project/threads/thread#msg=3', positions: { 'opaque-0': 20, 'opaque-1': 1600 },
    loadedImage: true, mixedWarm: true, warmImageLast: true, owner: 'turn-result-images', fileRoute: true,
    configureSdk(sdk) {
      const rpc = sdk.plugins.callRpc;
      sdk.plugins.callRpc = async args => {
        calls.push(args.method);
        if (args.method === 'turnResultImagesV1Media') { mediaStarted = true; await mediaGate; }
        return rpc(args);
      };
    } });
  const runtime = f.runtime();
  let foreground, speculative;
  try {
    await until(() => f.stats().live === 1 && runtime.stats().running === 0 && runtime.stats().queued === 0);
    assert.equal(f.mediaCounts().calls, 0, 'sequence-nearest but beyond one viewport is not warmed');
    assert.equal(document.querySelector('[data-result-key="row-1"]'), null);
    // Genuine other retained raw work holds this thread's physical lane. It
    // ignores abort, so foreground promotion cannot pretend it was cancelled.
    const blocker = new AbortController();
    const held = runtime.readScope('thread', blocker.signal, async () => { rawHeld = true; await rawGate; });
    await until(() => rawHeld);
    await f.rowPosition('opaque-1', 800);
    // Let actual nearby history finish, then hold the later warm Media rather
    // than manufacturing a private cache or bypassing the native proof.
    rawRelease(); await held;
    await until(() => mediaStarted);
    assert.equal(f.mediaCounts().fetches, 0); assert.equal(document.querySelector('[data-result-key="row-1"]'), null);
    await f.rowPosition('opaque-1', 100);
    await settle(25);
    assert.equal(calls.filter(method => method === 'turnResultImagesV1Media').length, 1, 'a dispatched promoted Media is never aborted/reissued');
    assert.equal(runtime.stats().running, 1);
    await act(async () => { mediaRelease(); await tick(); });
    await until(() => document.querySelector('[data-result-key="row-1"] img[src^="blob:"]') && runtime.stats().running === 0 && runtime.stats().queued === 0);
    assert.deepEqual(f.mediaCounts(), { calls: 1, fetches: 1 });
    await act(async () => document.querySelector('[data-result-key="row-1"] .tr-image-action').click());
    assert.equal(f.fileOpenCalls.length, 1); assert.ok(f.stats().peak <= 4);
    const count = calls.length; await settle(40); assert.equal(calls.length, count);
  } finally { rawRelease(); mediaRelease(); await f.dispose(); await runtime.whenDrained(); assert.equal(runtime.stats().running, 0); }
});


test('existing-pane replacement retires preload placement and requires new foreground proof while reusing only verified bytes', async () => {
  const f = await fixture(2, true, { captureRuntime: true, preloadNearby: true, nativeItems: true,
    url: 'https://bb.invalid/projects/project/threads/thread#msg=3', positions: { 'opaque-0': 20, 'opaque-1': 800 },
    loadedImage: true, mixedWarm: true, warmImageLast: true, owner: 'turn-result-images', fileRoute: true });
  let release = () => {};
  try {
    await until(() => f.mediaCounts().fetches === 1 && f.runtime().stats().running === 0 && f.runtime().stats().queued === 0);
    const before = f.nativeCalls.length, facts = JSON.stringify(f.rows()), original = f.sdk.threads.timeline;
    let fresh = 0; const gate = new Promise(done => { release = done; });
    f.sdk.threads.timeline = async input => { fresh++; await gate; return original(input); };
    await act(async () => {
      const old = document.querySelector('[data-timeline-row-id="opaque-1"]');
      old.replaceWith(old.cloneNode(true)); await tick();
    });
    await f.rowPosition('opaque-1', 100); await until(() => fresh > 0);
    assert.equal(document.querySelector('[data-result-key="row-1"]'), null, 'cached bytes never fabricate replacement-row authority');
    await act(async () => { release(); await tick(); });
    await until(() => document.querySelector('[data-result-key="row-1"] img[src^="blob:"]') && f.runtime().stats().running === 0 && f.runtime().stats().queued === 0);
    assert.ok(f.nativeCalls.length > before, 'replacement requires genuine foreground public history');
    assert.deepEqual(f.mediaCounts(), { calls: 1, fetches: 1 }, 'only verified passive bytes survive retirement');
    await act(async () => document.querySelector('[data-result-key="row-1"] .tr-image-action').click());
    assert.equal(f.fileOpenCalls.length, 1); assert.equal(JSON.stringify(f.rows()), facts);
  } finally { release(); await f.dispose(); }
});

test('retired header callbacks cannot stop a new committed transport generation or publish an ignored old history result', async () => {
  let release, first = true, started = false;
  const gate = new Promise(done => { release = done; });
  const f = await fixture(1, true, { captureRuntime: true, deferNative: true, nativeItems: true,
    url: 'https://bb.invalid/projects/project/threads/thread#msg=3', loadedImage: true, owner: 'turn-result-images', fileRoute: true,
    configureSdk(sdk) { const timeline = sdk.threads.timeline; sdk.threads.timeline = async input => {
      if (first) { first = false; started = true; await gate; } return timeline(input);
    }; } });
  try {
    await until(() => started); const oldCallbacks = f.coreSubscriptions();
    await f.reconnect();
    await act(async () => { for (const sub of oldCallbacks) sub.callback(sub.event === 'realtime:connection'
      ? { state: 'disconnected', reconnected: false } : { reason: 'history-rewrite' }); await tick(); });
    assert.equal(f.runtime().stats().running, 1, 'ignored old history still owns actual lane credit');
    assert.equal(f.mediaCounts().calls, 0); assert.equal(f.stats().live, 0);
    await act(async () => { release(); await tick(); });
    await until(() => f.mediaCounts().fetches === 1 && f.runtime().stats().running === 0 && f.runtime().stats().queued === 0);
    assert.equal(f.runtime().canvases.counts().occupied, 0);
    const reads = f.nativeCalls.length; await f.arrive();
    await until(() => document.querySelector('[data-result-key="row-0"] img[src^="blob:"]'));
    assert.equal(f.nativeCalls.length, reads, 'only the continuously live NEW chain adopts its exact first physical arrival');
    assert.deepEqual(f.mediaCounts(), { calls: 1, fetches: 1 });
    await act(async () => document.querySelector('.tr-image-action').click()); assert.equal(f.fileOpenCalls.length, 1);
  } finally { release(); await f.dispose(); }
});


test('semantic retirement and hide refuse late warm Media; wrong project never schedules and fresh current demand recovers', async () => {
  let release, started = false, first = true;
  const gate = new Promise(done => { release = done; });
  const f = await fixture(1, true, { captureRuntime: true, deferNative: true, nativeItems: true,
    url: 'https://bb.invalid/projects/project/threads/thread#msg=3', loadedImage: true, owner: 'turn-result-images', fileRoute: true,
    configureSdk(sdk) { const rpc = sdk.plugins.callRpc; sdk.plugins.callRpc = async args => {
      if (args.method === 'turnResultImagesV1Media' && first) { first = false; started = true; await gate; }
      return rpc(args);
    }; } });
  try {
    await until(() => started);
    await f.coreChanged({ reason: 'events-appended', timelineSequence: 1 });
    await f.hidden(true); assert.equal(f.runtime().stats().running, 1, 'retired raw Media response remains owned');
    await act(async () => { release(); await tick(); });
    await until(() => f.runtime().stats().running === 0 && f.runtime().stats().queued === 0);
    assert.equal(f.mediaCounts().fetches, 0); assert.equal(f.runtime().canvases.counts().occupied, 0);
    await act(async () => { window.history.pushState(null, '', '/projects/foreign/threads/thread#msg=3'); window.dispatchEvent(new f.dom.window.PopStateEvent('popstate')); });
    await f.hidden(false); const reads = f.nativeCalls.length; await settle(30); assert.equal(f.nativeCalls.length, reads);
    await act(async () => { window.history.pushState(null, '', '/projects/project/threads/thread#msg=3'); window.dispatchEvent(new f.dom.window.PopStateEvent('popstate')); });
    await until(() => f.mediaCounts().fetches === 1 && f.runtime().stats().running === 0 && f.runtime().stats().queued === 0);
    await f.arrive(); await until(() => document.querySelector('[data-result-key="row-0"] img[src^="blob:"]'));
    await act(async () => document.querySelector('.tr-image-action').click()); assert.equal(f.fileOpenCalls.length, 1);
    assert.equal(f.mediaCounts().calls, 2, 'retired serving response is not a reusable lease; fresh verification is required');
    const idle = f.nativeCalls.length; await settle(30); assert.equal(f.nativeCalls.length, idle);
  } finally { release(); await f.dispose(); }
});


test('queued-cohort: two ordinary consumers after one actual semantic reset share one fresh latest dispatch', async () => {
  const result = { trace: [], dispatches: [], factsUnchanged: false, exactOpen: false, idle: false, cleanup: null };
  const mark = (kind, extra = {}) => result.trace.push({ order: result.trace.length + 1, kind, ...extra });
  let armed = false, holdRetained = false, blockStarted = false, releaseBlock, runtime, f, work;
  const blockGate = new Promise(resolve => { releaseBlock = resolve; });
  const gates = [];
  const wire = input => Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'signal')
    .map(([key,value]) => [key, key === 'beforeAnchorId' ? { sha256: createHash('sha256').update(String(value)).digest('hex') } : value]));
  try {
    f = await fixture(2, true, { captureRuntime: true, preloadNearby: true, nativeItems: true,
      url: 'https://bb.invalid/projects/project/threads/thread#msg=3', positions: { 'opaque-0': 20, 'opaque-1': 1600 },
      configureSdk(sdk) {
        const timeline = sdk.threads.timeline, rpc = sdk.plugins.callRpc;
        sdk.threads.timeline = async input => {
          if (!armed) return timeline(input);
          const call = { input: wire(input), rawSignalAborted: input.signal.aborted, settled: false };
          result.dispatches.push(call); mark('actual-sdk-timeline-dispatch', { index: result.dispatches.length, input: call.input });
          await new Promise(resolve => gates.push(resolve)); // controlled abort-ignoring public transport
          call.rawSignalAborted = input.signal.aborted;
          const response = await timeline(input); call.settled = true; mark('actual-sdk-timeline-settlement', { index: result.dispatches.indexOf(call) + 1 });
          return response;
        };
        sdk.plugins.callRpc = async args => {
          if (holdRetained && args.method === GALLERY_METHODS.read) {
            holdRetained = false; blockStarted = true; mark('ordinary-retained-raw-start'); await blockGate;
          }
          return rpc(args);
        };
      } });
    runtime = f.runtime();
    await until(() => f.stats().live === 1 && runtime.stats().running === 0 && runtime.stats().queued === 0);
    const facts = JSON.stringify(f.rows()), originalScope = runtime.readScope;
    runtime.readScope = function (...args) {
      if (armed) {
        const source = Function.prototype.toString.call(args[2]);
        mark('ordinary-scope-request', { threadId: args[0], priority: args[3] === true,
          speculative: args[4] === true, sourceSha256: createHash('sha256').update(source).digest('hex'),
          sourceKind: source.includes('historyPass') ? 'Sentinel-current-history' : source.includes('sdk.threads.timeline') ? 'Header-preload-history' : 'other' });
      }
      return originalScope.apply(this, args);
    };
    const originalTimelineScope = runtime.readTimeline;
    runtime.readTimeline = function (...args) {
      if (armed) mark('ordinary-timeline-request', { threadId: args[0].threadId, input: wire(args[0]), speculative: args[2].speculative === true });
      return originalTimelineScope.apply(this, args);
    };
    const controller = new AbortController(); holdRetained = true;
    work = runtime.readScope('thread', controller.signal, signal => runtime.backend.read('thread', 'turn-0', signal));
    await until(() => blockStarted);
    armed = true;
    mark('public-sdk-semantic-reset-delivered');
    await f.coreChanged({ id: 'thread', reason: 'events-appended', timelineSequence: 1 });
    await until(() => runtime.stats().historyReads >= 2);
    mark('sentinel-fresh-request-queued', { stats: runtime.stats() });
    assert.equal(result.dispatches.length, 0, 'lane is held before fresh SDK dispatch');
    await f.rowPosition('opaque-1', 800);
    await until(() => runtime.stats().historyReads >= 3);
    mark('real-offscreen-nearby-request-queued', { stats: runtime.stats() });
    assert.equal(result.dispatches.length, 0, 'both reader resets and queued requests precede raw dispatch');
    releaseBlock(); await work;
    await until(() => result.dispatches.length === 1);
    mark('first-held-fresh-response', { stats: runtime.stats() });
    assert.equal(runtime.stats().running, 1); assert.equal(f.navigation.length, 0);
    gates.shift()();
    await until(() => result.dispatches.length > 1 || runtime.stats().historyReads === 0);
    mark('first-settled-or-duplicate-dispatched', { stats: runtime.stats(), count: result.dispatches.length });
    // Retire the real proximity hint while the actual foreground row remains.
    // Under the original code the duplicate has now dispatched; a shared AFTER
    // would already have delivered the same first response to both readers.
    await f.rowPosition('opaque-1', 1600);
    mark('proximity-retired-foreground-row-preserved', { rowConnected: document.querySelector('[data-timeline-row-id="opaque-0"]').isConnected });
    if (gates.length) {
      await settle(20); mark('retired-duplicate-still-owns-raw', { stats: runtime.stats() });
      assert.equal(runtime.stats().running, 1, 'ignored raw response holds the actual lane until settlement');
      for (const release of gates.splice(0)) release();
    }
    await until(() => f.stats().live === 1 && runtime.stats().running === 0 && runtime.stats().queued === 0);
    const card = document.querySelector('[data-result-key="row-0"]');
    assert.ok(card.querySelector('[data-supplier]'), 'genuine fresh foreground proof resumes rich useful content');
    await act(async () => card.querySelector('.tr-open-icon').click());
    assert.deepEqual(f.navigation, ['https://fixture.invalid/0']); result.exactOpen = true;
    assert.equal(JSON.stringify(f.rows()), facts); result.factsUnchanged = true;
    const count = result.dispatches.length; await settle(35); assert.equal(result.dispatches.length, count); result.idle = true;
    result.qualifiedLatestCount = result.dispatches.filter(call => !call.input.beforeAnchorId).length;
    assert.ok(result.qualifiedLatestCount >= 1);
    assert.ok(result.dispatches.every(call => JSON.stringify(call.input) === JSON.stringify(result.dispatches[0].input)), 'actual SDK inputs must be identical');
    assert.ok(f.stats().peak <= 4);
  } finally {
    releaseBlock(); for (const release of gates.splice(0)) release();
    if (work) await work.catch(() => {});
    if (f) await f.dispose();
    if (runtime) { await runtime.whenDrained(); result.cleanup = runtime.stats(); assert.equal(result.cleanup.running, 0); assert.equal(result.cleanup.queued, 0); assert.equal(result.cleanup.leases, 0); }
    console.log('QUEUED_COHORT_RESULT', JSON.stringify(result));
  }
  assert.equal(result.qualifiedLatestCount, 1, 'qualified continuously-live ordinary pending cohort must dispatch once');
});


test('reverse public reset callbacks and a later source hint cannot orphan fresh foreground history behind an ignored old read', async () => {
  let armed = false, held = false, release; const gate = new Promise(done => { release = done; });
  const f = await fixture(1, true, { captureRuntime: true, preloadNearby: true, nativeItems: true,
    url: 'https://bb.invalid/projects/project/threads/thread#msg=3', configureSdk(sdk) {
      const timeline = sdk.threads.timeline; sdk.threads.timeline = async input => {
        if (armed && !held) { held = true; await gate; } return timeline(input);
      };
    } });
  try {
    await until(() => f.stats().live === 1 && f.runtime().stats().running === 0 && f.runtime().stats().queued === 0);
    const facts = JSON.stringify(f.rows()), before = f.nativeCalls.length; armed = true;
    await act(async () => { for (const subscription of f.coreSubscriptions().reverse()) if (subscription.event === 'thread:changed')
      subscription.callback({ id: 'thread', reason: 'history-rewrite', timelineSequence: 1 }); await tick(); });
    await until(() => held); assert.equal(f.runtime().stats().running, 1);
    await f.notify(); // Header and Sentinel both revoke before the replacement pass.
    await act(async () => { release(); await tick(); });
    await until(() => f.stats().live === 1 && f.runtime().stats().running === 0 && f.runtime().stats().queued === 0);
    assert.ok(f.nativeCalls.length > before + 1, 'new source demand obtains its own actual fresh latest, not the ignored old response');
    await act(async () => document.querySelector('.tr-open-icon').click()); assert.deepEqual(f.navigation, ['https://fixture.invalid/0']);
    assert.equal(JSON.stringify(f.rows()), facts);
  } finally { release(); await f.dispose(); }
});


test('transient advertised metadata yields to proved foreground work without nonparticipant fanout, then genuinely recovers rich and Open', async () => {
  const calls = []; let metadata = 0, entered = false, release, live = 0, peak = 0;
  const gate = new Promise(done => { release = done; });
  const f = await fixture(1, true, { captureRuntime: true, nativeItems: true, configureSdk(sdk) {
    const list = sdk.plugins.list, rpc = sdk.plugins.callRpc;
    const track = async (name, read) => { calls.push(name); live++; peak = Math.max(peak, live); try { return await read(); } finally { live--; } };
    sdk.plugins.experimental_discoverRpc = input => track('metadata', async () => {
      assert.equal(input.method, METHODS.describe);
      if (++metadata === 1) { entered = true; await gate; throw Object.assign(Error('temporary metadata failure'), { status: 500 }); }
      return [{ pluginId: owner, method: METHODS.describe }];
    });
    sdk.plugins.list = input => track('list', async () => ({ plugins: [
      ...Array.from({ length: 8 }, (_, i) => ({ id: `aaa-nonparticipant-${i}`, enabled: true, status: 'running' })), ...(await list(input)).plugins] }));
    sdk.plugins.callRpc = args => track(`${args.pluginId}:${args.method}`, async () => {
      if (args.pluginId.startsWith('aaa-nonparticipant-')) throw Object.assign(Error('not a participant'), { status: 404, body: { error: { code: 'unknown_method' } } });
      return rpc(args);
    });
  } });
  const runtime = f.runtime(), facts = JSON.stringify(f.rows()), controller = new AbortController();
  try {
    await until(() => entered);
    assert.equal(runtime.isReadyOwner(owner), false);
    const foreground = runtime.readScope('thread', controller.signal, async signal => {
      calls.push('foreground:retained');
      return runtime.backend.read('thread', 'turn-0', signal);
    });
    await settle(10); assert.equal(calls.includes('foreground:retained'), false, 'pending actual metadata response owns its thread lane');
    await act(async () => { release(); await tick(); });
    await foreground;
    await until(() => f.stats().live === 1 && runtime.stats().running === 0 && runtime.stats().queued === 0);
    const card = document.querySelector('[data-result-key="row-0"]');
    assert.ok(card?.querySelector('[data-supplier]'), 'fresh metadata plus real Describe recovers rich content');
    await act(async () => { card.querySelector('.tr-open-icon').click(); await tick(); });
    assert.deepEqual(f.navigation, ['https://fixture.invalid/0']); assert.equal(JSON.stringify(f.rows()), facts);
    const nonparticipants = calls.filter(name => name.startsWith('aaa-nonparticipant-'));
    console.log('TRANSIENT_METADATA_FOREGROUND', JSON.stringify({ metadata, nonparticipantCalls: nonparticipants.length,
      foregroundIndex: calls.indexOf('foreground:retained'), retryIndex: calls.lastIndexOf('metadata'),
      descriptions: calls.filter(name => name.endsWith(`:${METHODS.describe}`)).length, peak, stats: runtime.stats() }));
    assert.equal(nonparticipants.length, 0, 'transient metadata failure must not fan out to known nonparticipants');
    assert.equal(metadata, 2); assert.equal(calls.filter(name => name.endsWith(`:${METHODS.describe}`)).length, 1);
    assert.ok(calls.indexOf('foreground:retained') < calls.lastIndexOf('metadata'), 'queued foreground retained work precedes yielded metadata retry');
    assert.equal(peak, 1); const idle = calls.length; await settle(40); assert.equal(calls.length, idle);
  } finally {
    release(); controller.abort(); await f.dispose(); await runtime.whenDrained();
    assert.equal(live, 0); assert.equal(runtime.stats().running, 0); assert.equal(runtime.stats().queued, 0);
    assert.equal(runtime.stats().leases, 0); assert.equal(runtime.canvases.counts().occupied, 0);
  }
});


test('bound Media response survives same-root card replacement only after genuine fresh proof and issued row adoption', async () => {
  const { createFakePluginHost } = await import('@get-bb/plugin-sdk/testing');
  const { createRegisteredHandlerRpc } = await import('@phosphorco/bb-turn-results/testing');
  const { createResultsSupplierClient } = await import('@phosphorco/bb-turn-results/bb');
  const { adaptCompletedEvent } = await import('@phosphorco/bb-turn-results/events');
  const { resolveOutcomeBudget, canonicalJson } = await import('@phosphorco/bb-turn-results');
  const { imageCandidate } = await import('../../turn-result-images/recognition.ts');
  const imagePlugin = (await import('../../turn-result-images/server.ts')).default;
  const galleryPlugin = (await import('../server.ts')).default;
  const result = { trace: [], media: [], history: [], imageOwners: [], setup: {}, current: {}, cleanup: null };
  const start = performance.now();
  const mark = (kind, fields = {}) => result.trace.push({ order: result.trace.length + 1, ms: performance.now() - start, kind, ...fields });
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=', 'base64');
  const sha = createHash('sha256').update(bytes).digest('hex');
  const native = { id: 'native-image', threadId: 'thread', seq: 3, scope: { kind: 'turn', turnId: 'turn-0' }, type: 'item/completed', createdAt: 1,
    data: { item: { id: 'image', type: 'imageGeneration', status: 'completed', error: null, path: '/saved/image.png', transparentBackground: false, result: bytes.toString('base64') } } };
  const selected = await adaptCompletedEvent(native); assert.equal(selected.state, 'admitted');
  const identity = imageCandidate(selected.event).identity;
  let fileReads = 0, nativeReads = 0, leases = 0, gets = 0, fetchedDigest = null, fileOpens = 0;
  let liveMedia = 0, peakMedia = 0, releaseMedia, releaseHistory, fresh = false, holdHistory = true;
  const mediaGate = new Promise(resolve => { releaseMedia = resolve; });
  const historyGate = new Promise(resolve => { releaseHistory = resolve; });
  const imageHost = createFakePluginHost({ pluginId: 'turn-result-images', sdk: {
    threads: { events: { async list() { nativeReads++; return [native]; } }, async get() { return { environmentId: 'environment' }; } },
    environments: { async get() { return { hostId: 'fixed-host' }; } },
    files: { async read() { fileReads++; return { path: '/saved/image.png', content: bytes.toString('base64'), contentEncoding: 'base64', sha256: sha, sizeBytes: bytes.length, mimeType: 'image/png' }; },
      async createPreview() { leases++; return { baseUrl: `/api/v1/file-previews/owned-${leases}`, expiresAtMs: Date.now() + 120000 }; } },
  } });
  const galleryHost = createFakePluginHost({ pluginId: 'turn-results' });
  imagePlugin(imageHost.bb); galleryPlugin(galleryHost.bb);
  const imageRpc = createRegisteredHandlerRpc(imageHost, 'turn-result-images'), galleryRpc = createRegisteredHandlerRpc(galleryHost, 'turn-results');
  // Setup uses real public source admission once, never a trusted caller body.
  const primed = await imageHost.harness.behavior.callRpc('turnResultImagesV1Media', { version: 1, identity });
  assert.equal(primed.state, 'ready');
  const client = createResultsSupplierClient({ plugins: imageRpc }, 'turn-result-images');
  const resolved = await client.resolve({ version: 1, threadId: 'thread', items: [identity], maxOutcomeBytes: resolveOutcomeBudget(1) });
  assert.equal(resolved.resolutions[0].state, 'resolved');
  const resolution = resolved.resolutions[0].value;
  assert.equal(resolution.provenance.artifactLocation.state, 'verified');
  const committed = await galleryHost.harness.behavior.callRpc(GALLERY_METHODS.apply, { owner: 'turn-result-images', threadId: 'thread', changes: [{ kind: 'upsert', value: resolution }] });
  assert.equal(committed.state, 'committed');
  const initial = await galleryHost.harness.behavior.callRpc(GALLERY_METHODS.read, { threadId: 'thread', turnId: 'turn-0' });
  assert.equal(initial.page.rows.length, 1);
  const row = initial.page.rows[0], rowKey = row.key;
  const cardIn = root => [...root.querySelectorAll('[data-result-key]')].find(card => card.dataset.resultKey === rowKey);
  result.setup = { registeredSource: true, registeredGallery: true, primingMedia: 1, nativeReads, fileReads, leases, revision: resolution.revision,
    identitySha256: createHash('sha256').update(canonicalJson(identity)).digest('hex'), sha256: sha };
  const subscriptions = new Set();
  let f, rootSignal, shell, sourceNode, initialCard, replacementCard, runtime, rawCalls = [], frozenFacts;
  let failure;
  try {
    f = await fixture(1, true, { owner: 'turn-result-images', kind: identity.ref.kind, captureRuntime: true,
      nativeItems: true, loadedImage: true, fileRoute: true, manualImageVisibility: true,
      observeRuntime(owner) {
        const image = owner.image;
        owner.image = function (...args) {
          result.imageOwners.push({ row: args[0], shown: args[1], speculative: args[2], signal: args[3] });
          return image.apply(this, args);
        };
      },
      configureSdk(sdk) {
        sdk.subscribe = input => { subscriptions.add(input); if (input.event === 'realtime:connection') queueMicrotask(() => {
          if (subscriptions.has(input)) input.callback({ state: 'connected', reconnected: false, reconnectDelayMs: null });
        }); return () => subscriptions.delete(input); };
        sdk.plugins.experimental_discoverRpc = async () => [{ pluginId: 'turn-result-images', method: METHODS.describe }];
        sdk.plugins.list = async () => ({ plugins: [{ id: 'turn-result-images', enabled: true, status: 'running' }] });
        sdk.threads.events.list = async () => [native];
        sdk.threads.timeline = async input => {
          const call = { started: performance.now() - start, fresh, signal: input.signal, settled: false };
          result.history.push(call); mark('public-history-start', { fresh, index: result.history.length });
          if (fresh && holdHistory) await historyGate;
          const value = { rows: [{ id: 'opaque-0', threadId: 'thread', turnId: 'turn-0', kind: 'turn', status: 'completed', sourceSeqStart: 1, sourceSeqEnd: 5 }],
            completedTurnDisplay: 'collapse', timelinePage: { historySnapshot: fresh ? 'genuine-new-current-proof' : 'initial-current-proof', olderCursor: null } };
          call.settled = true; call.ended = performance.now() - start; mark('public-history-settle', { fresh: call.fresh, aborted: input.signal.aborted }); return value;
        };
        sdk.plugins.callRpc = args => {
          const call = (async () => {
            mark('plugin-dispatch', { owner: args.pluginId, method: args.method });
            if (args.pluginId === 'turn-result-images') {
              if (args.method !== 'turnResultImagesV1Media') return imageRpc.callRpc(args);
              const item = { started: performance.now() - start, inputSha256: createHash('sha256').update(canonicalJson(args.input)).digest('hex'), suppliedSignal: !!args.signal, state: null, settled: false };
              result.media.push(item); liveMedia++; peakMedia = Math.max(peakMedia, liveMedia);
              try { const value = await imageRpc.callRpc(args); item.state = value.state; item.leaseFingerprint = value.state === 'ready' ? value.lease.targetFingerprint : null;
                mark('registered-media-ready-held', { index: result.media.length, state: value.state });
                if (result.media.length === 1) await mediaGate;
                item.settled = true; item.ended = performance.now() - start; mark('public-media-settle', { index: result.media.indexOf(item) + 1 }); return value;
              } finally { liveMedia--; }
            }
            if (args.pluginId !== 'turn-results') throw Error('Unexpected supplier');
            return galleryRpc.callRpc(args);
          })();
          rawCalls.push(call); return call;
        };
      } });
    runtime = f.runtime();
    globalThis.fetch = async () => { assert.ok(result.history.some(call => call.fresh && call.settled), 'replacement cannot GET before fresh native proof'); gets++; mark('preview-GET', { currentRoot: !rootSignal?.aborted, historyFresh: result.history.some(call => call.fresh && call.settled) });
      fetchedDigest = createHash('sha256').update(bytes).digest('hex'); return new Response(bytes, { headers: { 'content-type': 'image/png' } }); };
    await until(() => cardIn(document) && runtime.stats().running === 0 && runtime.stats().queued === 0);
    sourceNode = document.querySelector('[data-timeline-row-id="opaque-0"]'); shell = sourceNode.querySelector('[data-turn-results-gallery]');
    initialCard = cardIn(shell);
    rootSignal = result.imageOwners.find(call => call.row.key === rowKey && !call.speculative)?.signal;
    assert.ok(rootSignal instanceof AbortSignal); assert.equal(rootSignal.aborted, false);
    frozenFacts = canonicalJson((await galleryHost.harness.behavior.callRpc(GALLERY_METHODS.read, { threadId: 'thread', turnId: 'turn-0' })).page.rows[0].resolution);
    await f.imagesVisible(true); await until(() => result.media.length === 1 && result.media[0].state === 'ready');
    assert.equal(gets, 0); assert.equal(runtime.stats().running, 1); assert.equal(result.media[0].suppliedSignal, false);
    mark('initial-raw-owned');
    await f.rowPosition('opaque-0', 1700);
    await until(() => !cardIn(shell));
    assert.equal(initialCard.isConnected, false); assert.equal(shell.isConnected, true); assert.equal(shell.parentElement, sourceNode); assert.equal(rootSignal.aborted, false);
    mark('viewport-card-retired-same-live-root');
    fresh = true;
    await act(async () => {
      const event = { type: 'changed', entity: 'thread', id: 'thread', changes: ['events-appended'], metadata: { timelineSequence: 5 } };
      let count = 0;
      for (const subscription of [...subscriptions]) if (subscription.event === 'thread:changed') { count++; subscription.callback(event); }
      assert.ok(count > 0); mark('ordinary-sdk-native-semantic-reset', { subscribers: count }); await tick();
    });
    assert.equal(rootSignal.aborted, false, 'a native-proof reset must actually preserve this root lifetime to be eligible');
    await f.rowPosition('opaque-0', 20);
    await until(() => cardIn(shell));
    replacementCard = cardIn(shell);
    assert.notEqual(replacementCard, initialCard); assert.equal(shell, sourceNode.querySelector('[data-turn-results-gallery]'));
    assert.equal(rootSignal.aborted, false);
    const ownerSignals = result.imageOwners.filter(call => call.row.key === rowKey && !call.speculative).map(call => call.signal);
    assert.ok(ownerSignals.every(signal => signal === rootSignal), 'actual replacement retained the SAME root signal; no manufactured continuity');
    await f.imagesVisible(true);
    await settle(20);
    assert.equal(result.media.length, 1, 'ignored first response retains actual same-thread occupancy');
    assert.equal(result.history.filter(call => call.fresh).length, 0, 'fresh native history cannot overlap owned same-thread Media');
    mark('replacement-waits-for-actual-raw');
    await act(async () => { releaseMedia(); await tick(); });
    await until(() => result.history.some(call => call.fresh));
    assert.equal(gets, 0, 'retired owner must not start GET from the ready response');
    mark('fresh-current-proof-held-after-first-response', { media: result.media.length });
    holdHistory = false;
    await act(async () => { releaseHistory(); await tick(); });
    await until(() => shell.querySelector('img[src^="blob:"]') && runtime.stats().running === 0 && runtime.stats().queued === 0);
    const node = shell.querySelector('img'), blobUrl = node.src;
    assert.equal(gets, 1); assert.equal(fetchedDigest, sha); assert.equal(rootSignal.aborted, false); assert.equal(shell.parentElement, sourceNode);
    assert.ok(result.history.some(call => call.fresh && call.settled));
    const finalRow = (await galleryHost.harness.behavior.callRpc(GALLERY_METHODS.read, { threadId: 'thread', turnId: 'turn-0' })).page.rows[0];
    assert.equal(canonicalJson(finalRow.resolution), frozenFacts); assert.equal(canonicalJson(finalRow.identity), canonicalJson(identity));
    await act(async () => shell.querySelector('.tr-image-action').click());
    assert.deepEqual(f.fileOpenCalls.map(call => call.target), [{ kind: 'host', hostId: 'fixed-host', path: '/saved/image.png' }]); fileOpens = f.fileOpenCalls.length;
    await f.rowPosition('opaque-0', 1700); await until(() => !shell.querySelector('[data-result-key]'));
    await f.rowPosition('opaque-0', 20); await until(() => shell.querySelector('[data-result-key]')); await f.imagesVisible(true);
    await until(() => shell.querySelector('img'));
    assert.equal(shell.querySelector('img').src, blobUrl); assert.equal(gets, 1);
    const idle = JSON.stringify({ media: result.media.length, gets, history: result.history.length }); await settle(80);
    assert.equal(JSON.stringify({ media: result.media.length, gets, history: result.history.length }), idle);
    result.current = { mediaCalls: result.media.length, gets, fileOpens, peakMedia, exactBytes: fetchedDigest === sha, sameRootSignal: true,
      sameSourceShell: true, distinctCards: replacementCard !== initialCard, freshHistory: result.history.filter(call => call.fresh).length,
      sameMediaInput: new Set(result.media.map(call => call.inputSha256)).size === 1, warmSameBlob: true, idle: true,
      elapsedFromFirstMediaMs: performance.now() - start - result.media[0].started };
    console.log('BOUND_MEDIA_RETIREMENT_RESULT', JSON.stringify(result.current));
    assert.ok(result.current.elapsedFromFirstMediaMs < 7000, 'adoption spends the original request budget');
    assert.equal(result.media.length, 1, 'same exact bound response must survive eligible card-only retirement and fresh adoption without a second Media');
  } catch (error) { failure = { name: error.name, message: error.message, stack: error.stack }; throw error; }
  finally {
    releaseMedia(); holdHistory = false; releaseHistory();
    if (f) await f.dispose();
    await Promise.allSettled(rawCalls); if (runtime) await runtime.whenDrained();
    await imageHost.harness.lifecycle.dispose(); await galleryHost.harness.lifecycle.dispose();
    result.cleanup = { liveMedia, subscriptions: subscriptions.size, runtime: runtime?.stats(), media: runtime?.media.stats(), canvases: runtime?.canvases.counts() };
    assert.equal(liveMedia, 0); assert.equal(subscriptions.size, 0);
    if (runtime) { assert.equal(runtime.stats().running, 0); assert.equal(runtime.stats().queued, 0); assert.equal(runtime.stats().historyReads, 0); assert.equal(runtime.media.stats().running, 0); assert.equal(runtime.canvases.counts().occupied, 0); }
  }
});

test('startup: committed public header proves native history before real heavy implementation evaluates', async () => {
  let releaseHeavy;
  const gate = new Promise(resolve => { releaseHeavy = resolve; });
  const probe = globalThis.__startupHeavyEvaluation = { gate, entered: false, evaluated: false };
  let f, pendingFixture, closed = false;
  const native = [], rpcCalls = [], sequence = [];
  let preRelease;
  try {
    const modulePromise = import(new URL('../app.tsx?startup-proof-public-fixture', import.meta.url).href);
    pendingFixture = fixture(1, true, { definition: modulePromise, nativeItems: true, preloadNearby: true,
      url: 'https://fixture.invalid/projects/project/threads/thread',
      configureSdk(sdk) {
        const timeline = sdk.threads.timeline;
        sdk.threads.timeline = async input => { sequence.push('native-dispatch'); native.push({ input: { ...input, signal: undefined }, signal: input.signal }); return timeline(input); };
        const callRpc = sdk.plugins.callRpc;
        sdk.plugins.callRpc = args => { rpcCalls.push(args.method); return callRpc(args); };
      },
    });
    await until(() => probe.entered);
    await settle(80);
    preRelease = { header: !!document.querySelector('[data-turn-results-bridge]'), native: native.length,
      sourceOrRetained: rpcCalls.length, cards: document.querySelectorAll('.tr-card').length, heavyEvaluated: probe.evaluated };
    sequence.push('heavy-release'); releaseHeavy();
    f = await pendingFixture;
    await until(() => document.querySelector('[data-result-key="row-0"] [data-supplier]'));
    const rowBefore = JSON.stringify(f.rows()), card = document.querySelector('[data-result-key="row-0"]');
    const open = card.querySelector('button[title="Open result"]'); assert.ok(open && !open.disabled);
    await act(async () => { open.focus(); open.click(); });
    await until(() => f.navigation.length === 1);
    assert.deepEqual(f.navigation, ['https://fixture.invalid/0']);
    assert.equal(JSON.stringify(f.rows()), rowBefore);
    assert.ok(native.every(call => call.input.includeNestedRows === 'false' && call.input.segmentLimit === '100' && call.input.deferContent === 'true'));
    assert.equal(preRelease.sourceOrRetained, 0, 'no retained/source execution before heavy implementation');
    assert.equal(preRelease.cards, 0, 'no custom/placement/action before implementation and proof');
    await f.dispose(); closed = true;
    console.log('STARTUP_MODULE_RESULT', JSON.stringify({ preRelease, nativeTotal: native.length, navigation: 1, factsExact: true, cleanup: true, sequence }));
    assert.ok(preRelease.header, 'actual public header must commit without waiting for heavy implementation module');
    assert.ok(preRelease.native >= 1, 'genuine charged native-history request must dispatch while real heavy implementation remains held');
    assert.equal(preRelease.heavyEvaluated, false);
  } finally {
    releaseHeavy();
    if (!f && pendingFixture) f = await pendingFixture;
    if (f && !closed) await f.dispose();
    delete globalThis.__startupHeavyEvaluation;
  }
});

test('startup: real issued older cursor finishes before heavy evaluation, with no replay on attachment', async () => {
  let releaseHeavy;
  const probe = globalThis.__startupHeavyEvaluation = { gate: new Promise(resolve => { releaseHeavy = resolve; }), entered: false, evaluated: false };
  const issued = { anchorId: 'opaque issued cursor / not parsed', anchorSeq: 100 }, calls = [];
  let f, pendingFixture, closed = false, beforeCalls;
  try {
    pendingFixture = fixture(1, true, { definition: import(new URL('../app.tsx?startup-continuation-public-fixture', import.meta.url).href),
      nativeItems: true, preloadNearby: true, url: 'https://fixture.invalid/projects/project/threads/thread',
      configureSdk(sdk) {
        const timeline = sdk.threads.timeline;
        sdk.threads.timeline = async input => {
          const page = await timeline(input); calls.push({ older: !!input.beforeAnchorId, anchorId: input.beforeAnchorId, anchorSeq: input.beforeAnchorSeq });
          if (!input.beforeAnchorId) return { ...page, rows: [{ id: 'genuine newer boundary', threadId: 'thread', turnId: 'newer', kind: 'turn', status: 'completed', sourceSeqStart: 100, sourceSeqEnd: 105 }], timelinePage: { historySnapshot: 'public-snapshot', olderCursor: issued } };
          assert.equal(input.beforeAnchorId, issued.anchorId); assert.equal(input.beforeAnchorSeq, String(issued.anchorSeq));
          return { ...page, rows: [{ id: 'earlier public user', threadId: 'thread', turnId: null, kind: 'conversation', role: 'user', sourceSeqStart: 0, sourceSeqEnd: 0 }, ...page.rows], timelinePage: { historySnapshot: 'public-snapshot', olderCursor: null } };
        };
      },
    });
    await until(() => probe.entered);
    await until(() => calls.some(call => call.older)); await settle(40);
    beforeCalls = calls.length;
    assert.equal(beforeCalls, 3, 'ordinary no-hash startup keeps the delivered three physical history calls');
    assert.equal(probe.evaluated, false);
    assert.equal(document.querySelectorAll('.tr-card').length, 0);
    releaseHeavy(); f = await pendingFixture;
    await until(() => document.querySelector('[data-result-key="row-0"] [data-supplier]'));
    await act(async () => document.querySelector('[data-result-key="row-0"] button[title="Open result"]').click());
    await until(() => f.navigation.length === 1);
    assert.deepEqual(f.navigation, ['https://fixture.invalid/0']);
    assert.equal(calls.length, beforeCalls, 'attachment consumes the same completed live chain, not a redundant latest/older replay');
    await f.dispose(); closed = true;
    console.log('STARTUP_CONTINUATION_RESULT', JSON.stringify({ beforeCalls, totalCalls: calls.length, exactIssuedOlder: true, rich: true, exactOpen: true, cleanup: true }));
  } finally {
    releaseHeavy(); if (!f && pendingFixture) f = await pendingFixture;
    if (f && !closed) await f.dispose(); delete globalThis.__startupHeavyEvaluation;
  }
});

test('foreground-route: already visible exact target uses one native proof and no optional duplicate work', async () => {
 const {createFakePluginHost}=await import('@get-bb/plugin-sdk/testing');
 const {createRegisteredHandlerRpc}=await import('@phosphorco/bb-turn-results/testing');
 const {createResultsSupplierClient}=await import('@phosphorco/bb-turn-results/bb');
 const {adaptCompletedEvent}=await import('@phosphorco/bb-turn-results/events');
 const {resolveOutcomeBudget,canonicalJson}=await import('@phosphorco/bb-turn-results');
 const {imageCandidate}=await import('../../turn-result-images/recognition.ts');
 const imagePlugin=(await import('../../turn-result-images/server.ts')).default;
 const galleryPlugin=(await import('../server.ts')).default;
 const result={status:'running',setup:[],calls:[],markers:[],owners:[],positive:null,cleanup:null,dbWrites:'not exposed by existing public fixture; committed Apply results are not claimed as SQL writes'};
 const start=performance.now();result.started=start;const audit=(phase,kind,data={})=>{const entry={order:result.calls.length+1,phase,kind,at:performance.now()-start,...data};result.calls.push(entry);return entry;};
 const wire=input=>Object.fromEntries(Object.entries(input).filter(([k])=>k!=='signal').map(([k,v])=>[k,k==='beforeAnchorId'?{sha256:createHash('sha256').update(String(v)).digest('hex')}:v]));
 const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=','base64'),sha=createHash('sha256').update(bytes).digest('hex');
 const native={id:'native-image',threadId:'thread',seq:3,scope:{kind:'turn',turnId:'turn-0'},type:'item/completed',createdAt:1,data:{item:{id:'image',type:'imageGeneration',status:'completed',error:null,path:'/saved/image.png',transparentBackground:false,result:bytes.toString('base64')}}};
 const selected=await adaptCompletedEvent(native);assert.equal(selected.state,'admitted');const identity=imageCandidate(selected.event).identity;
 let phase='setup',leases=0,f,raw=[],runtime,gets=0,subscriptions=new Set();
 const tracked=async(kind,fn,data={})=>{const item=audit(phase,kind,data);try{const value=await fn();item.end=performance.now()-start;item.state=value?.state??null;return value;}catch(error){item.end=performance.now()-start;item.failure=error?.code??error?.name;throw error;}};
 const imageHost=createFakePluginHost({pluginId:'turn-result-images',sdk:{threads:{events:{list:input=>tracked('Images.native',async()=>[native],{limit:input.limit})},get:input=>tracked('Images.thread',async()=>({environmentId:'env'}))},environments:{get:input=>tracked('Images.environment',async()=>({hostId:'fixed-host'}))},files:{read:input=>tracked('Images.file',async()=>({path:'/saved/image.png',content:bytes.toString('base64'),contentEncoding:'base64',sha256:sha,sizeBytes:bytes.length,mimeType:'image/png'})),createPreview:input=>tracked('Images.preview',async()=>({baseUrl:`/api/v1/file-previews/fixture-${++leases}`,expiresAtMs:Date.now()+120000}))}}});
 const galleryHost=createFakePluginHost({pluginId:'turn-results'});imagePlugin(imageHost.bb);galleryPlugin(galleryHost.bb);
 const imageRpc=createRegisteredHandlerRpc(imageHost,'turn-result-images'),galleryRpc=createRegisteredHandlerRpc(galleryHost,'turn-results');
 const rpc=(port,args)=>tracked('RPC',()=>port.callRpc(args),{owner:args.pluginId,method:args.method,inputSha256:createHash('sha256').update(canonicalJson(args.input)).digest('hex'),cursorPresent:args.input?.cursor!=null,afterPresent:args.input?.after!=null});
 try{
 const initial=await tracked('setup.Media',()=>imageHost.harness.behavior.callRpc('turnResultImagesV1Media',{version:1,identity}));assert.equal(initial.state,'ready');
 const client=createResultsSupplierClient({plugins:{callRpc:args=>rpc(imageRpc,args)}},'turn-result-images');const resolved=await client.resolve({version:1,threadId:'thread',items:[identity],maxOutcomeBytes:resolveOutcomeBudget(1)});assert.equal(resolved.resolutions[0].state,'resolved');
 const custom=recordFixture();
 await tracked('setup.Apply',()=>galleryHost.harness.behavior.callRpc(GALLERY_METHODS.apply,{owner:'turn-result-images',threadId:'thread',changes:[{kind:'upsert',value:resolved.resolutions[0].value}]}));
 await tracked('setup.Apply',()=>galleryHost.harness.behavior.callRpc(GALLERY_METHODS.apply,{owner:'custom-fixture',threadId:'thread',changes:[{kind:'upsert',value:custom.resolution}]}));
 const saved=await tracked('setup.Read',()=>galleryHost.harness.behavior.callRpc(GALLERY_METHODS.read,{threadId:'thread',turnId:'turn-0'}));assert.equal(saved.page.rows.length,2);
 const originalFacts=canonicalJson(saved.page.rows.map(row=>({identity:row.identity,resolution:row.resolution})));result.setup={primeMedia:1,claims:2,sha};phase='pass';
 const cursor={anchorId:'issued older / opaque',anchorSeq:100};let older=0;
 globalThis.__foregroundRouteBefore=result;
 f=await fixture(1,true,{captureRuntime:true,nativeItems:true,preloadNearby:true,loadedImage:true,fileRoute:true,
  url:'https://fixture.invalid/projects/project/threads/thread#msg=3',positions:{'opaque-0':20},
  beforeHeader(){const row=document.querySelector('[data-timeline-row-id="opaque-0"]');assert.ok(row?.isConnected);const rect=row.getBoundingClientRect();assert.ok(rect.top>=0&&rect.bottom<=600);result.markers.push({kind:'exact-target-physically-visible-before-header',at:performance.now()-start});},
  observeRuntime(owner){runtime=owner;const retain=owner.retain,image=owner.image;owner.retain=function(...args){result.owners.push({kind:'retain',rowId:args[0].rowId,speculative:args[3]===true,at:performance.now()-start});return retain.apply(this,args);};owner.image=function(...args){result.owners.push({kind:'image',speculative:args[2]===true,shown:args[1],at:performance.now()-start});return image.apply(this,args);};},
  configureSdk(sdk){
   globalThis.fetch=async(url,options)=>tracked('GET',async()=>{gets++;return new Response(bytes,{headers:{'content-type':'image/png'}});});
   const customRpc=sdk.plugins.callRpc;
   sdk.subscribe=input=>{result.markers.push({kind:'subscribe',event:input.event,at:performance.now()-start});subscriptions.add(input);if(input.event==='realtime:connection')queueMicrotask(()=>{if(subscriptions.has(input)){result.markers.push({kind:'committed-core-connected-callback',at:performance.now()-start});input.callback({state:'connected',reconnected:false,reconnectDelayMs:null});}});return()=>subscriptions.delete(input);};
   sdk.threads.timeline=input=>tracked('Gallery.timeline',async()=>{if(!input.beforeAnchorId)return {rows:[{id:'newer-boundary',threadId:'thread',turnId:'newer',kind:'turn',status:'completed',sourceSeqStart:100,sourceSeqEnd:105}],completedTurnDisplay:'collapse',timelinePage:{historySnapshot:'fresh-public',olderCursor:cursor}};assert.equal(input.beforeAnchorId,cursor.anchorId);assert.equal(input.beforeAnchorSeq,String(cursor.anchorSeq));older++;return {rows:[{id:'user-boundary',threadId:'thread',turnId:null,kind:'conversation',role:'user',sourceSeqStart:0,sourceSeqEnd:0},{id:'opaque-0',threadId:'thread',turnId:'turn-0',kind:'turn',status:'completed',sourceSeqStart:1,sourceSeqEnd:5}],completedTurnDisplay:'collapse',timelinePage:{historySnapshot:'fresh-public',olderCursor:null}};},{wire:wire(input)});
   sdk.threads.events.list=input=>tracked('Gallery.events',async()=>[native],{limit:input.limit});
   sdk.plugins.experimental_discoverRpc=input=>tracked('metadata',async()=>[{pluginId:'turn-result-images',method:METHODS.describe},{pluginId:'custom-fixture',method:METHODS.describe}]);
   sdk.plugins.list=input=>tracked('plugins.list',async()=>({plugins:[{id:'turn-result-images',enabled:true,status:'running'},{id:'custom-fixture',enabled:true,status:'running'}]}));
   sdk.plugins.callRpc=args=>{const port=args.pluginId==='turn-results'?galleryRpc:args.pluginId==='turn-result-images'?imageRpc:{callRpc:customRpc};const call=rpc(port,args);raw.push(call);return call;};
  }});
 globalThis.fetch=async(url,options)=>tracked('GET',async()=>{gets++;return new Response(bytes,{headers:{'content-type':'image/png'}});});
 // Automatic visible ImageCanvas may have acquired before fixture returns;
 // install the same response implementation before header via fixture seam.
 await until(()=>document.querySelector('img[src^="blob:"]')&&document.querySelector('[data-supplier]')&&runtime.stats().running===0&&runtime.stats().queued===0);
 assert.ok(older>0);assert.ok(gets>=1);
 const img=document.querySelector('img');assert.ok(img.isConnected);const imageRow=saved.page.rows.find(row=>row.owner==='turn-result-images'),customRow=saved.page.rows.find(row=>row.owner==='custom-fixture');
 const imageCard=[...document.querySelectorAll('[data-result-key]')].find(card=>card.dataset.resultKey===imageRow.key),customCard=[...document.querySelectorAll('[data-result-key]')].find(card=>card.dataset.resultKey===customRow.key);
 await act(async()=>imageCard.querySelector('.tr-image-action').click());await act(async()=>customCard.querySelector('.tr-open-icon').click());assert.deepEqual(f.navigation,['https://fixture.invalid/0']);assert.equal(f.fileOpenCalls.length,1);assert.deepEqual(f.fileOpenCalls[0].target,{kind:'host',hostId:'fixed-host',path:'/saved/image.png'});
 phase='validation';const final=await tracked('validation.Read',()=>galleryHost.harness.behavior.callRpc(GALLERY_METHODS.read,{threadId:'thread',turnId:'turn-0'}));assert.equal(canonicalJson(final.page.rows.map(row=>({identity:row.identity,resolution:row.resolution}))),originalFacts);
 const count=result.calls.length;await settle(80);assert.equal(result.calls.length,count);result.positive={rich:true,blob:true,exactSha:sha,exactImageFileOpen:1,exactURL:f.navigation[0],factsExact:true,idle:true};
 const pass=result.calls.filter(c=>c.phase==='pass');result.counts=Object.fromEntries([...new Set(pass.map(c=>c.kind==='RPC'?c.owner+'/'+c.method:c.kind))].map(k=>[k,pass.filter(c=>(c.kind==='RPC'?c.owner+'/'+c.method:c.kind)===k).length]));
 result.observedOptional=result.owners.filter(c=>c.speculative).length;
 result.status='positive-complete';
 }catch(error){result.status='failed';result.failure={name:error.name,message:error.message};throw error;}
 finally{if(f)await f.dispose();await Promise.allSettled(raw);if(runtime)await runtime.whenDrained();await imageHost.harness.lifecycle.dispose();await galleryHost.harness.lifecycle.dispose();delete globalThis.__foregroundRouteBefore;
 result.cleanup={subscriptions:subscriptions.size,runtime:runtime?.stats(),media:runtime?.media.stats(),canvases:runtime?.canvases.counts()};
 console.log('FOREGROUND_ROUTE_AFTER',JSON.stringify(result));assert.equal(subscriptions.size,0);if(runtime){assert.equal(runtime.stats().running,0);assert.equal(runtime.media.stats().running,0);}
 }
 // An unnecessary work assertion is evaluated ONLY after all capabilities and
 // cleanup; raw counts may instead substantiate no change needed.
 assert.equal(result.counts['Gallery.timeline'],2,'one genuine latest+its issued older suffice; no second older walk');
 assert.equal(result.counts['turn-result-images/turnResultImagesV1Media'],1); assert.equal(result.counts.GET,1);
 assert.equal(result.observedOptional,0,'already foreground exact target should not need optional retain/media work');
 function recordFixture(){return record(0);}
});

test('initial route arbitration releases one live mismatching/limited/failed intent but never a retired physical witness', async t => {
 for(const mode of ['offscreen-goal','limited-first-proof','failed-first-proof','revoked-physical-witness']) await t.test(mode,async()=>{
  let calls=0,release,rawStarted=false;const rawGate=new Promise(done=>{release=done;});const optional=[];
  const f=await fixture(2,true,{captureRuntime:true,nativeItems:true,preloadNearby:true,url:'https://fixture.invalid/projects/project/threads/thread#msg=13',positions:{'opaque-0':20,'opaque-1':2000},
   observeRuntime(owner){const retain=owner.retain;owner.retain=function(...args){if(args[3])optional.push(args[0].rowId);return retain.apply(this,args);};},
   configureSdk(sdk){const timeline=sdk.threads.timeline;sdk.threads.timeline=async input=>{
    calls++;if(calls===1){
     if(mode==='failed-first-proof')throw Error('ordinary source read failed');
     if(mode==='limited-first-proof')return {rows:[{id:'overbound'.repeat(150),threadId:'thread',turnId:'turn-0',kind:'turn',status:'completed',sourceSeqStart:1,sourceSeqEnd:5}],completedTurnDisplay:'collapse',timelinePage:{historySnapshot:'first-capacity',olderCursor:null}};
     if(mode==='revoked-physical-witness'){rawStarted=true;await rawGate;}
    }
    return timeline(input);
   };}
  });
  try{
   if(mode==='revoked-physical-witness'){
    await until(()=>rawStarted);const native=document.querySelector('[data-timeline-row-id="opaque-0"]'),parent=native.parentElement;
    await act(async()=>{native.remove();parent.append(native);await tick();});release();
    await until(()=>document.querySelector('[data-result-key="row-0"] [data-supplier]')&&f.runtime().stats().running===0&&f.runtime().stats().queued===0);
    assert.deepEqual(optional,[],'an observed ABA drops the parked intent; a later fresh result cannot resurrect it');
   }else{
    await until(()=>optional.includes('opaque-1')&&f.runtime().stats().running===0&&f.runtime().stats().queued===0);
    assert.equal(optional.filter(id=>id==='opaque-1').length,1,'only the original live optional intent is released');
    assert.equal(document.querySelector('[data-result-key="row-1"]'),null,'offscreen warming grants no custom or placement authority');
    if(mode!=='offscreen-goal'){await f.notify();}
    await until(()=>document.querySelector('[data-result-key="row-0"] [data-supplier]'));
   }
   await act(async()=>document.querySelector('[data-result-key="row-0"] .tr-open-icon').click());assert.deepEqual(f.navigation,['https://fixture.invalid/0']);
   const count=calls;await settle(50);assert.equal(calls,count,'no idle retry or implicit route rearm');
   console.log('INITIAL_ROUTE_NEGATIVE',JSON.stringify({mode,calls,optional,exactOpen:true}));
  }finally{release();await f.dispose();}
 });
});

test('empty initial physical demand and later explicit hash/popstate keep ordinary route warming', async () => {
 const optional=[];const f=await fixture(2,true,{captureRuntime:true,nativeItems:true,preloadNearby:true,
  url:'https://fixture.invalid/projects/project/threads/thread#msg=3',positions:{'opaque-0':2000,'opaque-1':4000},
  observeRuntime(owner){const retain=owner.retain;owner.retain=function(...args){if(args[3])optional.push(args[0].rowId);return retain.apply(this,args);};}});
 try{
  await until(()=>optional.includes('opaque-0')&&f.runtime().stats().running===0&&f.runtime().stats().queued===0);
  assert.equal(document.querySelectorAll('[data-result-key]').length,0,'empty foreground demand does not manufacture placement');
  await f.rowPosition('opaque-0',20);
  await until(()=>document.querySelector('[data-result-key="row-0"] [data-supplier]'));
  const afterEmpty=optional.length;
  await act(async()=>{window.location.hash='#msg=13';await tick();});
  await until(()=>optional.slice(afterEmpty).includes('opaque-1')&&f.runtime().stats().running===0&&f.runtime().stats().queued===0);
  assert.equal(document.querySelector('[data-result-key="row-1"]'),null);
  const afterHash=optional.length;
  await act(async()=>{window.history.pushState(null,'','/projects/project/threads/thread#msg=3');window.dispatchEvent(new f.dom.window.PopStateEvent('popstate'));await tick();});
  await until(()=>optional.slice(afterHash).includes('opaque-0')&&f.runtime().stats().running===0&&f.runtime().stats().queued===0);
  await act(async()=>document.querySelector('[data-result-key="row-0"] .tr-open-icon').click());assert.deepEqual(f.navigation,['https://fixture.invalid/0']);
  const calls=f.nativeCalls.length;await settle(50);assert.equal(f.nativeCalls.length,calls);
 }finally{await f.dispose();}
});
