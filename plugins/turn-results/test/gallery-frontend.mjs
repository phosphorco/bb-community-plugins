import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { installTestPluginRuntime, renderSlot } from '@get-bb/plugin-sdk/testing/app';
import { canonicalJson, canonicalByteLength, sha256Canonical } from '@phosphorco/bb-turn-results';
import { createGalleryRuntime } from '../gallery/runtime.ts';
import { GALLERY_METHODS } from '../gallery/rpc.ts';
// In-memory test transform only. No plugin build, generated file, reload, or
// alternative runtime source. Components and SDK hooks are their real modules.
registerHooks({ load(url, context, next) {
  if (url.endsWith('.tsx')) return { format: 'module', shortCircuit: true,
    source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), { compilerOptions: {
      target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX,
    } }).outputText };
  return next(url, context);
} });
const { TurnGallery } = await import('../gallery/view.tsx');
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
async function until(condition) { for (let i = 0; i < 200; i++) { await act(async () => { await tick(); }); if (condition()) return; } assert.fail('React boundary did not settle.'); }
function setup() {
  const dom = new JSDOM('<main></main>', { pretendToBeVisual: true });
  const saved = Object.fromEntries(['window', 'document', 'Element', 'HTMLElement', 'MutationObserver', 'ResizeObserver', 'IntersectionObserver', 'IS_REACT_ACT_ENVIRONMENT', 'fetch'].map(key => [key, globalThis[key]]));
  const observers = [];
  class Observer {
    constructor(callback) { this.callback = callback; this.targets = new Set(); observers.push(this); }
    observe(target) { this.targets.add(target); } unobserve(target) { this.targets.delete(target); } disconnect() { this.targets.clear(); }
  }
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
    MutationObserver: dom.window.MutationObserver, ResizeObserver: Observer, IntersectionObserver: Observer, IS_REACT_ACT_ENVIRONMENT: true });
  installTestPluginRuntime();
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=', 'base64');
  const sha = Buffer.from(awaitableDigest(png)).toString('hex');
  let mediaCalls = 0, fetches = 0;
  globalThis.fetch = async () => { fetches++; return new Response(png, { headers: { 'content-type': 'image/png' } }); };
  const source = { threadId: 'thread', turnId: 'turn', eventId: 'event', seq: 3, itemId: 'image', eventType: 'item/completed' };
  const target = { kind: 'host', hostId: 'recorded-host', path: '/saved/image.png' };
  const identity = { version: 1, ref: { source, member: 'image:0', kind: 'images/generated' }, artifact: { provider: 'images', id: 'image', kind: 'image' },
    specificity: 'typed', evidence: { basis: 'native-completion', sites: [], targetUrls: [], selectedDigest: 'a'.repeat(64) }, lookup: null };
  const row = { key: 'same-image', owner: 'turn-result-images', identity, unresolved: false, firstObservedOrder: 1, corrections: [], sourceExpired: null, retracted: null,
    freshness: 'stale', currentAvailability: null,
    resolution: { identity, proof: { kind: 'native-image', source, selectedDigest: 'a'.repeat(64) }, revision: { epoch: 'e', sequence: 1 }, knowledge: 'confirmed',
      outcomeEvidence: { kind: 'observation', id: 'receipt', digest: 'b'.repeat(64), recordedAt: 1 }, availability: { state: 'available', asOf: 1, expiresAt: null },
      route: { kind: 'file', target }, provenance: { originHost: { state: 'unknown', reason: 'not-recorded' },
        artifactLocation: { state: 'verified', target, observedAt: 1, basis: 'explicit-host-read', sha256: sha } },
      fallback: { kind: 'image', title: 'Generated image', alt: 'Retained scene' }, spans: { width: 2, height: 2 } } };
  let rows = [row];
  const page = () => ({ page: { rows, next: null }, coverage: { state: 'partial', intervals: [] } });
  const sdk = { plugins: {
    async list() { return { plugins: [] }; },
    async callRpc(args) {
      if (args.method === GALLERY_METHODS.read) return args.outputSchema.parse(page());
      if (args.method === 'turnResultImagesV1Media') {
        mediaCalls++;
        const fingerprint = await sha256Canonical({ target, sha256: sha });
        return args.outputSchema.parse({ version: 1, state: 'ready', image: { mimeType: 'image/png', sha256: sha, width: 1, height: 1, sizeBytes: png.length },
          lease: { targetFingerprint: fingerprint, leaseGeneration: 'test', baseUrl: '/api/v1/file-previews/test', url: '/api/v1/file-previews/test/image.png', resolvedAt: Date.now(), expiresAtMs: Date.now() + 60000 } });
      }
      throw Error(`Unexpected test RPC ${args.method}`);
    },
  }, threads: { events: { async list() { return []; } } } };
  const runtime = createGalleryRuntime(sdk), controller = new AbortController();
  const anchor = { threadId: 'thread', turnId: 'turn', rowId: 'native-public-row', sourceSeqStart: 1, sourceSeqEnd: 10, turnSeqStart: 1, turnSeqEnd: 10, historySnapshot: 's' };
  const shell = document.createElement('div'); document.querySelector('main').append(shell);
  shell.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, bottom: 420, left: 0, right: 800, width: 800, height: 420, toJSON() {} });
  return { dom, runtime, sdk, controller, anchor, row, shell, observers, page, changeRows(value) { rows = value; }, counts: () => ({ mediaCalls, fetches }),
    props: { anchor, runtime, sdk, navigate: { experimental_openFilePreview() { return true; } }, current: () => !controller.signal.aborted, lifetime: controller.signal, shell },
    restore() { controller.abort(); runtime.dispose(); Object.assign(globalThis, saved); dom.window.close(); } };
}
import { createHash } from 'node:crypto';
function awaitableDigest(data) { return createHash('sha256').update(data).digest(); }

test('hidden/remount releases view leases and retains loaded blob/geometry without permanent metadata footer', async () => {
  const h = setup(); const registration = { component: TurnGallery };
  const rendered = renderSlot(registration, { ...h.props, visible: true });
  try {
    await until(() => !!rendered.container.querySelector('[data-result-key]'));
    await until(() => h.observers.some(observer => [...observer.targets].some(target => target.classList.contains('tr-canvas'))));
    for (const observer of h.observers) for (const target of observer.targets) if (target.classList.contains('tr-canvas')) {
      await act(async () => observer.callback([{ target, isIntersecting: true }]));
    }
    await until(() => !!rendered.container.querySelector('img'));
    const url = rendered.container.querySelector('img').src, grid = rendered.container.querySelector('.tr-grid').innerHTML;
    assert.equal(h.runtime.stats().leases, 1); assert.deepEqual(h.counts(), { mediaCalls: 1, fetches: 1 });
    const loadedNode = rendered.container.querySelector('img');
    await act(async () => rendered.rerender(React.createElement(TurnGallery, { ...h.props, visible: true, demanded: false })));
    assert.equal(rendered.container.querySelector('img'), loadedNode, 'boundary revalidation keeps last-good image DOM and Blob');
    assert.equal(h.runtime.stats().leases, 1);
    await act(async () => rendered.rerender(React.createElement(TurnGallery, { ...h.props, visible: true, demanded: true })));
    await until(() => h.runtime.stats().running === 0);
    assert.equal(rendered.container.querySelector('img'), loadedNode); assert.deepEqual(h.counts(), { mediaCalls: 1, fetches: 1 });
    const pressure = Array.from({ length: 127 }, (_, i) => h.runtime.retain({ ...h.anchor, threadId: `pressure-${i}` }, false));
    const overflowShell = document.createElement('div');
    const overflow = renderSlot(registration, { ...h.props, anchor: { ...h.anchor, turnId: 'overflow' }, shell: overflowShell, visible: true });
    assert.equal(overflow.container.querySelector('.tr-gallery'), null, 'capacity cannot invent an empty collection');
    assert.equal(rendered.container.querySelector('img'), loadedNode, 'capacity never drops an admitted visible image');
    assert.deepEqual(h.counts(), { mediaCalls: 1, fetches: 1 });
    overflow.unmount(); for (const lease of pressure) lease.dispose();
    assert.equal(rendered.container.querySelector('.tr-freshness'), null);
    assert.equal(rendered.container.querySelector('.tr-image-action').title, 'Image bytes match the saved generation');
    const openIcon = rendered.container.querySelector('.tr-open-icon');
    assert.equal(openIcon.textContent, ''); assert.match(openIcon.getAttribute('aria-label'), /^Open /);
    assert.equal(openIcon.querySelector('svg').getAttribute('aria-hidden'), 'true');
    const previewStyle = document.createElement('style'); previewStyle.textContent = readFileSync(new URL('../app.css', import.meta.url), 'utf8'); document.head.append(previewStyle);
    assert.equal(window.getComputedStyle(loadedNode).objectFit, 'cover', 'inline preview fills its tile without changing original image bytes');
    const fullImage = document.createElement('img'), fullAction = document.createElement('button'); fullAction.className = 'tr-image-action'; fullAction.append(fullImage); document.body.append(fullAction);
    assert.equal(window.getComputedStyle(fullImage).objectFit, 'contain', 'full/native presentation is outside the preview-only crop'); fullAction.remove(); previewStyle.remove();
    await act(async () => rendered.rerender(React.createElement(TurnGallery, { ...h.props, visible: false })));
    assert.equal(h.runtime.stats().leases, 0); assert.equal(h.shell.style.minHeight, '420px');
    await act(async () => rendered.rerender(React.createElement(TurnGallery, { ...h.props, visible: true })));
    await until(() => !!rendered.container.querySelector('img'));
    assert.equal(rendered.container.querySelector('img').src, url); assert.equal(rendered.container.querySelector('.tr-grid').innerHTML, grid);
    assert.deepEqual(h.counts(), { mediaCalls: 1, fetches: 1 });
  } finally { rendered.unmount(); h.restore(); }
});


function collectionRows(base, count) {
  return Array.from({ length: count }, (_, i) => { const row = structuredClone(base); row.key = `collected-${i}`; row.firstObservedOrder = i;
    row.identity.ref.member = `image:${i}`; row.identity.artifact.id = `artifact-${i}`; row.resolution.identity = row.identity; return row; });
}
test('an empty failed results read is visible and a successful empty read clears it without idle retries', async () => {
  const f = setup(); let failed = true, reads = 0;
  f.runtime.backend.read = async () => {
    reads++;
    if (failed) throw Error('History capacity: index-capacity');
    return { page: { rows: [], next: null }, coverage: { state: 'partial', intervals: [] } };
  };
  const rendered = renderSlot({ component: TurnGallery }, { ...f.props, visible: true });
  try {
    await until(() => f.runtime.stats().running === 0 && reads > 0);
    const status = rendered.container.querySelector('[role="status"]');
    assert.ok(status, 'a rejected results read must not silently look like a turn without results');
    const icon = status.querySelector('button'), details = status.querySelector('[role="tooltip"]');
    assert.equal(icon.getAttribute('aria-label'), 'Saved results could not be loaded.');
    assert.equal(icon.getAttribute('aria-describedby'), details.id);
    assert.match(details.textContent, /History capacity: index-capacity/);
    const style = document.createElement('style'); style.textContent = readFileSync(new URL('../app.css', import.meta.url), 'utf8');
    document.head.append(style);
    assert.equal(window.getComputedStyle(status).height, '0px', 'failure anchor adds no layout height');
    assert.equal(window.getComputedStyle(status.firstElementChild).position, 'absolute');
    assert.equal(window.getComputedStyle(status.firstElementChild).insetInlineEnd, '0');
    assert.equal(window.getComputedStyle(details).position, 'absolute', 'details cannot shift adjacent content');
    assert.equal(window.getComputedStyle(details).visibility, 'hidden');
    icon.focus(); assert.equal(document.activeElement, icon, 'error details have a keyboard-focusable trigger');
    style.remove();
    assert.equal(rendered.container.querySelector('.tr-card'), null, 'the notice cannot invent a result');
    const count = reads; await act(async () => { await tick(); await tick(); });
    assert.equal(reads, count, 'the notice starts no retry or background work');
    failed = false; await act(async () => f.runtime.invalidate());
    await until(() => reads > count && f.runtime.stats().running === 0);
    assert.equal(rendered.container.querySelector('[role="status"]'), null, 'successful empty content clears the same failure');
    assert.equal(rendered.container.querySelector('.tr-card'), null);
  } finally { rendered.unmount(); f.restore(); }
});
test('turn collection follows issued cursors internally, retains last-good media on failure, and clears successful empty geometry', async () => {
  const f = setup(), reads = []; let rows = collectionRows(f.row, 18), fail = false;
  f.runtime.backend.read = async (_thread, _turn, _signal, after) => {
    reads.push(after ?? null); if (after && fail) throw Error('collection offline');
    const start = after ? after.seq + 1 : 0, page = rows.slice(start, start + 8);
    return { page: { rows: page, next: start + 8 < rows.length ? { seq: start + 7, key: `issued-${start + 7}` } : null }, coverage: { state: 'partial', intervals: [] } };
  };
  const rendered = renderSlot({ component: TurnGallery }, { ...f.props, visible: true });
  try {
    await until(() => rendered.container.querySelectorAll('[data-result-key]').length === 18 && f.runtime.stats().running === 0);
    assert.deepEqual(reads, [null, { seq: 7, key: 'issued-7' }, { seq: 15, key: 'issued-15' }]);
    assert.equal([...rendered.container.querySelectorAll('button')].some(b => /Show more|Previous|First results/.test(b.textContent)), false);
    const prior = rendered.container.querySelector('[data-result-key="collected-0"]');
    fail = true; await act(async () => f.runtime.invalidate()); await until(() => f.runtime.stats().running === 0);
    assert.equal(rendered.container.querySelector('[data-result-key="collected-0"]'), prior, 'failed later page keeps the entire accepted turn');
    assert.equal(rendered.container.querySelectorAll('[data-result-key]').length, 18);
    const count = reads.length; await act(async () => { await tick(); await tick(); }); assert.equal(reads.length, count, 'no idle or timing retry');
    fail = false; rows = []; f.shell.style.minHeight = '420px'; await act(async () => f.runtime.invalidate());
    await until(() => !rendered.container.querySelector('.tr-gallery') && f.runtime.stats().running === 0);
    assert.equal(f.shell.style.minHeight, '');
  } finally { rendered.unmount(); f.restore(); }
});
test('turn collection64/8page cap charges issued bindings, isolates wrong-turn rows and remains shared by identical-turn panes', async () => {
  const f = setup(); let rows = collectionRows(f.row, 70), reads = [], wrong = false;
  f.runtime.backend.read = async (_thread, _turn, _signal, after) => {
    reads.push(after ?? null); const start = after ? after.seq + 1 : 0, page = structuredClone(rows.slice(start, start + 8));
    if (wrong && after) page[0].identity.ref.source.turnId = 'foreign-turn';
    return { page: { rows: page, next: start + 8 < rows.length ? { seq: start + 7, key: `issued-${start + 7}` } : null }, coverage: { state: 'partial', intervals: [] } };
  };
  const other = document.createElement('div'); document.querySelector('main').append(other);
  const left = renderSlot({ component: TurnGallery }, { ...f.props, visible: true }), right = renderSlot({ component: TurnGallery }, { ...f.props, shell: other, visible: true });
  const lease = f.runtime.retain(f.anchor, false);
  try {
    await until(() => left.container.querySelectorAll('[data-result-key]').length === 64 && f.runtime.stats().running === 0);
    assert.equal(right.container.querySelectorAll('[data-result-key]').length, 64); assert.equal(reads.length, 8);
    assert.equal(lease.store.state.limited, true); assert.equal(Object.keys(lease.store.state.bindings).length, 64);
    assert.deepEqual(lease.store.state.bindings['collected-8'].after, { seq: 7, key: 'issued-7' });
    assert.equal(f.runtime.stats().bytes, canonicalByteLength(lease.store.state, 262144)); assert.ok(f.runtime.stats().bytes <= 262144);
    assert.equal(f.runtime.stats().leases, 3); assert.ok(f.runtime.stats().running <= 2);
    const old = left.container.querySelector('[data-result-key="collected-8"]'); wrong = true; reads = [];
    await act(async () => f.runtime.invalidate()); await until(() => f.runtime.stats().running === 0);
    assert.match(lease.store.state.error, /collection changed/); assert.equal(left.container.querySelector('[data-result-key="collected-8"]'), old);
    assert.equal(left.container.querySelector('[data-result-key="foreign-turn"]'), null);
  } finally { lease.dispose(); left.unmount(); right.unmount(); f.restore(); }
});
test('unresolved geometry is not cached; plain data is compact and resolved custom revision hints replace prior geometry', async () => {
  const f = setup(), row = structuredClone(f.row); row.unresolved = true; row.resolution = null; f.changeRows([row]);
  const rendered = renderSlot({ component: TurnGallery }, { ...f.props, visible: true });
  const place = () => rendered.container.querySelector('[data-result-key]').parentElement;
  try {
    await until(() => rendered.container.querySelector('[data-result-key]'));
    assert.equal(place().style.gridRow, '1 / span 1');
    const plain = structuredClone(f.row); plain.resolution.fallback = { kind: 'card', title: 'Saved file', description: 'A short description', fields: [{ label: 'Hidden raw diagnostics', value: 'x'.repeat(80) }] }; plain.resolution.spans = { width: 2, height: 1 };
    f.changeRows([plain]); await act(async () => f.runtime.invalidate()); await until(() => rendered.container.textContent.includes('A short description'));
    assert.equal(place().style.gridColumn, '1 / span 1'); assert.equal(rendered.container.textContent.includes('Hidden raw diagnostics'), false);
    plain.resolution.presentation = { schema: 'fixture/card@1', data: {} }; plain.resolution.revision.sequence++;
    plain.resolution.spans = { width: 3, height: 2 }; f.changeRows([structuredClone(plain)]); await act(async () => f.runtime.invalidate());
    await until(() => place().style.gridRow === '1 / span 2'); assert.equal(place().style.gridColumn, '1 / span 3');
  } finally { rendered.unmount(); f.restore(); }
});

test('large valid retained artifacts stop at the charged byte cap with exact bindings and no idle retry', async () => {
  const f = setup(), rows = collectionRows(f.row, 64), reads = [];
  for (const row of rows) row.resolution.fallback = { kind: 'card', title: 'Saved report', fields: Array.from({ length: 8 }, (_, i) => ({ label: `field-${i}`, value: 'x'.repeat(512) })) };
  f.runtime.backend.read = async (_thread, _turn, _signal, after) => {
    reads.push(after ?? null); const start = after ? after.seq + 1 : 0;
    return { page: { rows: rows.slice(start, start + 8), next: start + 8 < rows.length ? { seq: start + 7, key: `issued-${start + 7}` } : null }, coverage: { state: 'partial', intervals: [] } };
  };
  const lease = f.runtime.retain(f.anchor);
  try {
    await until(() => lease.store.state.limited && !lease.store.state.busy && f.runtime.stats().running === 0 && f.runtime.stats().queued === 0);
    assert.equal(lease.store.state.loaded, false); assert.equal(lease.store.state.continued, true);
    assert.ok(lease.store.state.rows.length > 8 && lease.store.state.rows.length < 64);
    assert.equal(lease.store.state.limited, true); assert.ok(reads.length <= 8);
    assert.equal(Object.keys(lease.store.state.bindings).length, lease.store.state.rows.length);
    assert.equal(f.runtime.stats().bytes, canonicalByteLength(lease.store.state, 262144)); assert.ok(f.runtime.stats().bytes <= 262144);
    for (const row of lease.store.state.rows) {
      const cursor = lease.store.state.bindings[row.key].after;
      assert.ok(reads.some(issued => canonicalJson(issued) === canonicalJson(cursor)), 'each row retains an actually used issued cursor');
    }
    const count = reads.length; await act(async () => { await tick(); await tick(); }); assert.equal(reads.length, count);
  } finally { lease.dispose(); f.restore(); }
});

// Actual registered source + consumer SQLite. Synthetic carrier/file only;
// this proves public source/host composition, never native/pixel latency.
async function initialImageComposition(failPublication = false, retirePending = false) {
  const { createFakePluginHost } = await import('@get-bb/plugin-sdk/testing');
  const { createRegisteredHandlerRpc } = await import('@phosphorco/bb-turn-results/testing');
  const { adaptCompletedEvent } = await import('@phosphorco/bb-turn-results/events');
  const { imageCandidate } = await import('../../turn-result-images/recognition.ts');
  const { createImageObservationStore } = await import('../../turn-result-images/store.ts');
  const { default: imagePlugin } = await import('../../turn-result-images/server.ts');
  const { default: galleryPlugin } = await import('../server.ts');
  const h = setup(); h.runtime.dispose();
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=', 'base64');
  const sha = createHash('sha256').update(png).digest('hex');
  const native = { id: 'native-image', threadId: 'thread', seq: 3, scope: { kind: 'turn', turnId: 'turn' },
    type: 'item/completed', createdAt: 1, data: { item: { id: 'image', type: 'imageGeneration', status: 'completed',
      error: null, path: '/saved/image.png', transparentBackground: false, result: png.toString('base64') } } };
  const selected = await adaptCompletedEvent(native); assert.equal(selected.state, 'admitted');
  const identity = imageCandidate(selected.event).identity;
  let release; const held = new Promise(resolve => { release = resolve; });
  let nativeReads = 0, files = 0, previews = 0, gets = 0, mediaCalls = 0, resolveCalls = 0;
  const order = [], opens = [], blobs = [];
  const imageHost = createFakePluginHost({ pluginId: 'turn-result-images', sdk: {
    threads: { events: { async list() { nativeReads++; order.push('native'); await held; return [native]; } },
      async get() { return { environmentId: 'environment' }; } },
    environments: { async get() { return { hostId: 'fixed-host' }; } },
    files: { async read() { files++; order.push('file'); return { path: '/saved/image.png', content: png.toString('base64'),
      contentEncoding: 'base64', sha256: sha, sizeBytes: png.length, mimeType: 'image/png' }; },
      async createPreview() { previews++; order.push('lease'); return { baseUrl: '/api/v1/file-previews/first', expiresAtMs: Date.now() + 120000 }; } },
  } });
  const galleryHost = createFakePluginHost({ pluginId: 'turn-results' });
  imagePlugin(imageHost.bb); galleryPlugin(galleryHost.bb);
  const store = createImageObservationStore(imageHost.bb.storage.database());
  const imageRpc = createRegisteredHandlerRpc(imageHost, 'turn-result-images'), galleryRpc = createRegisteredHandlerRpc(galleryHost, 'turn-results');
  await galleryHost.harness.behavior.callRpc(GALLERY_METHODS.apply, { owner: 'turn-result-images', threadId: 'thread',
    changes: [{ kind: 'candidate', identity }] });
  if (failPublication) galleryHost.bb.storage.database().exec("CREATE TRIGGER reject_image_publication BEFORE INSERT ON gallery_records WHEN NEW.kind='claim' BEGIN SELECT RAISE(ABORT,'fixture rollback'); END;");
  let correlated = false;
  const sdk = { threads: { events: { async list() { return [native]; } } }, plugins: {
    async list() { return { plugins: [{ id: 'turn-result-images', enabled: true, status: 'running' }] }; },
    async callRpc(input) {
      if (input.pluginId === 'turn-result-images') {
        if (input.method === 'turnResultImagesV1Media') { mediaCalls++; order.push('Media'); }
        if (input.method === 'turnResultsV1Resolve') { resolveCalls++; order.push('Resolve'); }
        return imageRpc.callRpc(input);
      }
      const result = await galleryRpc.callRpc(input);
      if (input.method === GALLERY_METHODS.apply && input.input.changes.some(change => change.kind === 'upsert')) order.push('Apply');
      if (input.method === GALLERY_METHODS.read && result.page.rows.some(row => row.resolution?.provenance.artifactLocation.state === 'verified')) {
        correlated = true; order.push('Read-verified');
      }
      return result;
    },
  } };
  const runtime = createGalleryRuntime(sdk), originalCreate = URL.createObjectURL;
  URL.createObjectURL = blob => { blobs.push(blob); return originalCreate(blob); };
  globalThis.fetch = async () => { gets++; order.push('GET'); assert.equal(correlated, true, 'normal committed resolution must be read before GET');
    assert.ok(store.read(identity.ref.source)?.materialization); return new Response(png, { headers: { 'content-type': 'image/png' } }); };
  let props = { ...h.props, runtime, sdk, navigate: { experimental_openFilePreview(target) { opens.push(target); return true; } } };
  let rendered = renderSlot({ component: TurnGallery }, props), retired = false;
  try {
    await until(() => rendered.container.querySelector('[data-result-key]'));
    await until(() => h.observers.some(observer => [...observer.targets].some(target => target.classList.contains('tr-canvas'))));
    assert.match(rendered.container.textContent, /Image preview pending/);
    assert.doesNotMatch(rendered.container.textContent, /Generated image|Image generated|bytes match/);
    for (let i = 0; i < 12; i++) {
      await act(async () => { await tick(); for (const observer of h.observers) for (const target of observer.targets)
        if (target.classList.contains('tr-canvas')) observer.callback([{ target, isIntersecting: true }]); });
      if (mediaCalls) break;
    }
    assert.equal(gets, 0); assert.equal(blobs.length, 0); assert.equal(store.read(identity.ref.source), null);
    assert.equal(rendered.container.querySelector('button[aria-label^="Open"]'), null, 'unconfirmed candidate has no file Open');
    console.log('INITIAL_IMAGE_CANDIDATE', JSON.stringify({ mediaCalls, resolveCalls, nativeReads, gets, blobs: blobs.length }));
    assert.equal(mediaCalls, 1, 'a demanded unresolved exact candidate must start the existing Media admission');
    assert.equal(resolveCalls, 0, 'initial Media must not depend on a preliminary Resolve');
    assert.equal(rendered.container.querySelector('.tr-hosted'), null);
    if (retirePending) {
      rendered.unmount(); retired = true; runtime.dispose();
      assert.equal(runtime.stats().running, 1, 'retired caller still owns its dispatched public Media response');
      release(); await until(() => runtime.stats().running === 0);
      assert.equal(gets, 0); assert.equal(blobs.length, 0); assert.equal(resolveCalls, 0);
      assert.equal(mediaCalls, 1); assert.equal(nativeReads, 1);
      console.log('INITIAL_IMAGE_RETIRED', JSON.stringify({ mediaCalls, nativeReads, gets, blobs: blobs.length, running: runtime.stats().running }));
      return;
    }
    release();
    if (failPublication) {
      await until(() => rendered.container.querySelector('.tr-placeholder button'));
      assert.equal(gets, 0); assert.equal(blobs.length, 0);
      assert.ok(store.read(identity.ref.source)?.materialization, 'source commit survives failed consumer publication');
      assert.equal(rendered.container.querySelector('button[aria-label^="Open"]'), null);
      const candidate = await galleryHost.harness.behavior.callRpc(GALLERY_METHODS.read, { threadId: 'thread', turnId: 'turn' });
      assert.equal(candidate.page.rows[0].resolution, null); assert.equal(candidate.page.rows[0].unresolved, true);
      galleryHost.bb.storage.database().exec('DROP TRIGGER reject_image_publication');
      rendered.unmount(); props = { ...props, anchor: { ...h.anchor, historySnapshot: 'genuinely-new-public-proof' } };
      rendered = renderSlot({ component: TurnGallery }, props);
      await until(() => rendered.container.querySelector('.tr-placeholder button'));
      for (const observer of h.observers) for (const target of observer.targets) if (target.classList.contains('tr-canvas'))
        await act(async () => observer.callback([{ target, isIntersecting: true }]));
      await act(async () => { await tick(); await tick(); });
      assert.equal(mediaCalls, 1, 'retire/reentry does not auto retry a foreground failure');
      assert.equal(gets, 0);
      await act(async () => rendered.container.querySelector('.tr-placeholder button').click());
    }
    await until(() => rendered.container.querySelector('img'));
    const attempts = failPublication ? 2 : 1;
    assert.equal(mediaCalls, attempts); assert.equal(nativeReads, 1); assert.equal(files, attempts); assert.equal(previews, attempts);
    assert.equal(resolveCalls, attempts); assert.equal(gets, 1); assert.equal(blobs.length, 1);
    assert.equal(createHash('sha256').update(Buffer.from(await blobs[0].arrayBuffer())).digest('hex'), sha);
    assert.ok(order.indexOf('lease') < order.indexOf('Resolve')); assert.ok(order.indexOf('Apply') < order.indexOf('Read-verified'));
    assert.ok(order.indexOf('Read-verified') < order.indexOf('GET'));
    const node = rendered.container.querySelector('img'), url = node.src;
    await act(async () => rendered.rerender(React.createElement(TurnGallery, props)));
    assert.equal(rendered.container.querySelector('img'), node);
    await act(async () => rendered.container.querySelector('.tr-image-action').click());
    assert.equal(opens.length, 1);
    rendered.unmount(); rendered = renderSlot({ component: TurnGallery }, props);
    await until(() => h.observers.some(observer => [...observer.targets].some(target => target.classList.contains('tr-canvas'))));
    for (const observer of h.observers) for (const target of observer.targets) if (target.classList.contains('tr-canvas'))
      await act(async () => observer.callback([{ target, isIntersecting: true }]));
    await until(() => rendered.container.querySelector('img'));
    assert.equal(rendered.container.querySelector('img').src, url);
    assert.equal(mediaCalls, attempts); assert.equal(gets, 1); assert.equal(nativeReads, 1); assert.equal(files, attempts);
    const idle = JSON.stringify({ mediaCalls, resolveCalls, nativeReads, files, gets }); await act(async () => { await tick(); await tick(); });
    assert.equal(JSON.stringify({ mediaCalls, resolveCalls, nativeReads, files, gets }), idle);
    console.log('INITIAL_IMAGE_COMPLETE', JSON.stringify({ order, mediaCalls, resolveCalls, nativeReads, files, gets, opens: opens.length }));
  } finally {
    release(); if (!retired) rendered.unmount(); runtime.dispose(); await imageHost.harness.lifecycle.dispose(); await galleryHost.harness.lifecycle.dispose();
    await tick(); URL.createObjectURL = originalCreate; h.restore();
  }
}

test('unresolved exact Images candidate admits once through Media before correlated bytes and keeps its warm owner', () => initialImageComposition());
test('settled unbound publication error reenters with fresh correlation ownership only on explicit Retry', () => initialImageComposition(true));
test('retired initial candidate owns its pending Media response but cannot correlate or GET late', () => initialImageComposition(false, true));
