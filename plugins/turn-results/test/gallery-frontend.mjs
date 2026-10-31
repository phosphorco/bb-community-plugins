import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { installTestPluginRuntime, renderSlot } from '@get-bb/plugin-sdk/testing/app';
import { canonicalJson, sha256Canonical } from '@phosphorco/bb-turn-results';
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
const { ResultsPanel } = await import('../gallery/panel.tsx');
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

test('hidden/remount releases view leases, retains loaded blob, span geometry and source-only freshness warning', async () => {
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
    assert.match(overflow.container.textContent, /capacity reached/);
    assert.equal(rendered.container.querySelector('img'), loadedNode, 'capacity never drops an admitted visible image');
    assert.deepEqual(h.counts(), { mediaCalls: 1, fetches: 1 });
    overflow.unmount(); for (const lease of pressure) lease.dispose();
    assert.match(rendered.container.textContent, /Source details were checked earlier/);
    assert.match(rendered.container.querySelector('.tr-freshness').title, /separately from image loading and byte verification/);
    assert.equal(rendered.container.querySelector('.tr-image-action').title, 'Image bytes match the saved generation');
    await act(async () => rendered.rerender(React.createElement(TurnGallery, { ...h.props, visible: false })));
    assert.equal(h.runtime.stats().leases, 0); assert.equal(h.shell.style.minHeight, '420px');
    await act(async () => rendered.rerender(React.createElement(TurnGallery, { ...h.props, visible: true })));
    await until(() => !!rendered.container.querySelector('img'));
    assert.equal(rendered.container.querySelector('img').src, url); assert.equal(rendered.container.querySelector('.tr-grid').innerHTML, grid);
    assert.deepEqual(h.counts(), { mediaCalls: 1, fetches: 1 });
  } finally { rendered.unmount(); h.restore(); }
});

test('panel ignores old identity responses, retains good page during same-scope read failure, and pauses hidden', async () => {
  const h = setup(); let release, reads = 0, fail = false;
  h.runtime.backend.read = async (threadId) => {
    reads++; if (threadId === 'old') return new Promise(resolve => { release = resolve; });
    if (fail) throw Error('offline');
    return { ...h.page(), page: { rows: [{ ...h.row, key: 'new-result', resolution: { ...h.row.resolution,
      fallback: { kind: 'card', title: 'New scope result' }, route: { kind: 'unavailable', reason: 'test' } } }], next: null } };
  };
  const props = { threadId: 'old', params: null, runtime: h.runtime };
  const rendered = renderSlot({ component: ResultsPanel }, props);
  try {
    await until(() => !!release);
    await act(async () => rendered.rerender(React.createElement(ResultsPanel, { ...props, threadId: 'new' })));
    await until(() => rendered.container.textContent.includes('New scope result'));
    await act(async () => release(h.page()));
    assert.equal(rendered.container.textContent.includes('Retained scene'), false);
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    await act(async () => document.dispatchEvent(new h.dom.window.Event('visibilitychange')));
    const before = reads; await tick(); assert.equal(reads, before);
    fail = true; Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    await act(async () => document.dispatchEvent(new h.dom.window.Event('visibilitychange')));
    await until(() => rendered.container.textContent.includes('temporarily unavailable'));
    assert.ok(rendered.container.textContent.includes('New scope result'));
    fail = false; await act(async () => [...rendered.container.querySelectorAll('button')].find(button => button.textContent === 'Retry results').click());
    await until(() => !rendered.container.textContent.includes('temporarily unavailable'));
    assert.ok(rendered.container.textContent.includes('New scope result'));
  } finally { rendered.unmount(); h.restore(); }
});
