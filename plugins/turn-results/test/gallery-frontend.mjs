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

test('message paging follows genuine cursors, keeps usable data on failed next read, and permits successful empty geometry release', async () => {
  const f = setup(); const reads = []; let failNext = true;
  const rows = Array.from({ length: 18 }, (_, i) => ({ ...f.row, key: `paged-${i}`, firstObservedOrder: i }));
  f.runtime.backend.read = async (_thread, _turn, _signal, after) => {
    reads.push(after ?? null); if (after && failNext) throw Error('next page offline');
    const start = after ? after.seq + 1 : 0, page = rows.slice(start, start + 8);
    return { page: { rows: page, next: start + 8 < rows.length ? { seq: start + 7, key: `issued-${start + 7}` } : null }, coverage: { state: 'partial', intervals: [] } };
  };
  const rendered = renderSlot({ component: TurnGallery }, { ...f.props, visible: true });
  const button = text => [...rendered.container.querySelectorAll('button')].find(node => node.textContent === text);
  try {
    await until(() => rendered.container.querySelector('[data-result-key="paged-0"]') && !button('Show more results')?.disabled);
    await act(async () => button('Show more results').click()); // disclose remaining cards of this8-row page
    if (!reads.some(cursor => cursor?.key === 'issued-7')) await act(async () => button('Show more results').click());
    await until(() => rendered.container.textContent.includes('next page offline'));
    assert.ok(rendered.container.querySelector('[data-result-key="paged-0"]'), 'failed next page retains prior cards');
    failNext = false; await act(async () => button('Retry results page').click());
    await until(() => rendered.container.querySelector('[data-result-key="paged-8"]'));
    assert.equal(rendered.container.querySelector('[data-result-key="paged-0"]'), null);
    assert.ok(reads.some(cursor => cursor?.seq === 7 && cursor.key === 'issued-7'));
    assert.ok(rendered.container.querySelectorAll('[data-result-key]').length <= 8);
    await act(async () => button('Previous results').click());
    await until(() => rendered.container.querySelector('[data-result-key="paged-0"]'));
    await act(async () => { rows.length = 0; f.shell.style.minHeight = '420px'; f.runtime.invalidate(); });
    await until(() => !rendered.container.querySelector('[data-result-key]') && f.runtime.stats().running === 0);
    assert.equal(f.shell.style.minHeight, '', 'successful empty data clears old geometry reservation');
    assert.equal(rendered.container.querySelector('.tr-gallery'), null, 'successful no-result state leaves no blank collection shell');
    assert.ok(!rendered.container.querySelector('button[aria-label="Results"]'));
  } finally { rendered.unmount(); f.restore(); }
});

test('identical-turn views select independent inline pages within existing lease and shared-lane limits', async () => {
  const f = setup(); const rows = Array.from({ length: 17 }, (_, i) => ({ ...f.row, key: `split-${i}`, firstObservedOrder: i }));
  f.runtime.backend.read = async (_thread, _turn, _signal, after) => {
    const start = after ? after.seq + 1 : 0, page = rows.slice(start, start + 8);
    return { page: { rows: page, next: start + 8 < rows.length ? { seq: start + 7, key: `cursor-${start + 7}` } : null }, coverage: { state: 'partial', intervals: [] } };
  };
  const otherShell = document.createElement('div'); document.querySelector('main').append(otherShell);
  const left = renderSlot({ component: TurnGallery }, { ...f.props, visible: true });
  const right = renderSlot({ component: TurnGallery }, { ...f.props, shell: otherShell, visible: true });
  const more = () => [...left.container.querySelectorAll('button')].find(node => node.textContent === 'Show more results');
  try {
    await until(() => left.container.querySelector('[data-result-key="split-0"]') && right.container.querySelector('[data-result-key="split-0"]') && !more()?.disabled);
    const unchanged = right.container.querySelector('[data-result-key="split-0"]');
    await act(async () => more().click());
    if (!left.container.querySelector('[data-result-key="split-8"]')) await act(async () => more().click());
    await until(() => left.container.querySelector('[data-result-key="split-8"]'));
    assert.equal(right.container.querySelector('[data-result-key="split-0"]'), unchanged);
    assert.equal(right.container.querySelector('[data-result-key="split-8"]'), null);
    assert.equal(f.runtime.stats().leases, 2); assert.ok(f.runtime.stats().running <= 2);
    const cursor = { seq: 7, key: 'cursor-7' }, first = f.runtime.retain(f.anchor, false), second = f.runtime.retain(f.anchor, false, cursor);
    try {
      assert.equal(f.runtime.stats().bytes, canonicalByteLength(first.store.state) + canonicalByteLength(second.store.state) + canonicalByteLength(cursor) * 2 + 16,
        'cursor and key copy are charged alongside both bounded snapshots');
    } finally { first.dispose(); second.dispose(); }
  } finally { left.unmount(); right.unmount(); assert.equal(f.runtime.stats().leases, 0); f.restore(); }
});
