import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGalleryMedia } from '../gallery/media.ts';

const data = new Uint8Array([137, 80, 78, 71]);
const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))].map(v => v.toString(16).padStart(2, '0')).join('');
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 10));
async function settled(store: { state: { state: string } }, expected?: string) {
  for (let i = 0; i < 100 && (expected ? store.state.state !== expected : ['idle', 'loading'].includes(store.state.state)); i++) await tick();
}
const lease = { url: '/api/v1/file-previews/test/image.png', expiresAtMs: Date.now() + 120000, targetFingerprint: 'fixed', leaseGeneration: 'one' };
function harness() {
  let acquires = 0, fetches = 0, creates = 0; const revoked: string[] = [];
  const owner = createGalleryMedia({
    async fetch() { fetches++; return new Response(data, { headers: { 'content-type': 'image/png' } }); },
    createUrl() { return `blob:${++creates}`; }, revokeUrl(url) { revoked.push(url); },
  });
  const request = { key: 'image', fingerprint: 'fixed', sha256: digest, async acquire() { acquires++; return lease; } };
  return { owner, request, revoked, counts: () => ({ acquires, fetches, creates }) };
}
test('loaded image survives all row retain/dispose cycles and does not reacquire lease', async () => {
  const h = harness(), first = h.owner.retain(h.request);
  await settled(first.store); assert.equal(first.store.state.state, 'ready');
  const url = first.store.state.url; first.dispose();
  for (let i = 0; i < 20; i++) { const remount = h.owner.retain(h.request); assert.equal(remount.store.state.url, url); remount.dispose(); }
  await tick(); assert.deepEqual(h.counts(), { acquires: 1, fetches: 1, creates: 1 });
  assert.deepEqual(h.revoked, []); h.owner.dispose(); h.owner.dispose(); assert.deepEqual(h.revoked, ['blob:1']);
});
test('same result shares bytes across panes; immutable binding cannot be replaced', async () => {
  const h = harness(), a = h.owner.retain(h.request), b = h.owner.retain(h.request);
  assert.equal(a.store, b.store); await settled(a.store); a.dispose(); assert.equal(b.store.state.state, 'ready');
  assert.throws(() => h.owner.retain({ ...h.request, fingerprint: 'other' }), /binding/);
  b.dispose(); h.owner.dispose();
});
test('abort-ignoring lease cannot advance to fetch or keep a scheduler token', async () => {
  let release!: (value: typeof lease) => void, fetches = 0;
  const owner = createGalleryMedia({ async fetch() { fetches++; return new Response(data); }, createUrl: () => 'blob:no', revokeUrl() {} });
  const a = owner.retain({ key: 'held', fingerprint: 'fixed', sha256: digest, acquire: () => new Promise(resolve => { release = resolve; }) });
  await tick(); a.dispose(); await tick(); assert.equal(owner.stats().running, 0);
  release(lease); await tick(); assert.equal(fetches, 0); owner.dispose();
});
test('changed serving bytes fail closed then explicit retry clears same failure', async () => {
  let correct = false;
  const owner = createGalleryMedia({ async fetch() { return new Response(correct ? data : new Uint8Array([0]), { headers: { 'content-type': 'image/png' } }); }, createUrl: () => 'blob:verified', revokeUrl() {} });
  const a = owner.retain({ key: 'image', fingerprint: 'fixed', sha256: digest, async acquire() { return lease; } });
  await settled(a.store); assert.equal(a.store.state.state, 'error'); assert.equal(a.store.state.url, null);
  correct = true; a.retry(); await settled(a.store, 'ready'); assert.equal(a.store.state.state, 'ready'); assert.equal(a.store.state.error, null);
  a.dispose(); owner.dispose();
});
test('hidden owner admits no requests and resumes once; streamed oversized image stops', async () => {
  const h = harness(); h.owner.visible(false); const a = h.owner.retain(h.request); await tick(); assert.equal(h.counts().acquires, 0);
  h.owner.visible(true); await settled(a.store); assert.equal(a.store.state.state, 'ready'); a.dispose(); h.owner.dispose();
  let cancelled = false;
  const owner = createGalleryMedia({ async fetch() { return new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(8388609)); }, cancel() { cancelled = true; } }), { headers: { 'content-type': 'image/png' } }); }, createUrl: () => { throw Error('must not publish'); }, revokeUrl() {} });
  const b = owner.retain(h.request); await settled(b.store); assert.equal(b.store.state.state, 'error'); assert.equal(cancelled, true); assert.equal(owner.stats().bytes, 0); b.dispose(); owner.dispose();
});
test('rejected status/MIME/length cancels body and retires the transport signal', async () => {
  for (const [status, mime, length] of [[500, 'image/png', '4'], [200, 'text/html', '4'], [200, 'image/png', '8388609']] as const) {
    let cancels = 0, signal: AbortSignal | null = null;
    const owner = createGalleryMedia({ async fetch(_url, requestSignal) { signal = requestSignal;
      return new Response(new ReadableStream({ cancel() { cancels++; } }), { status, headers: { 'content-type': mime, 'content-length': length } });
    }, createUrl: () => { throw Error('must not publish'); }, revokeUrl() {} });
    const resource = owner.retain({ key: 'image', fingerprint: 'fixed', sha256: digest, async acquire() { return lease; } });
    await settled(resource.store); await tick(); assert.equal(resource.store.state.state, 'error'); assert.equal(cancels, 1);
    assert.equal((signal as AbortSignal | null)?.aborted, true); assert.equal(owner.stats().running, 0);
    resource.dispose(); owner.dispose(); assert.equal(cancels, 1);
  }
});
test('late abort-ignoring fetch response is cancelled after retirement without decoding', async () => {
  let release!: (response: Response) => void, cancels = 0, fetches = 0;
  const owner = createGalleryMedia({ fetch() { fetches++; return new Promise(resolve => { release = resolve; }); },
    createUrl: () => { throw Error('must not publish'); }, revokeUrl() {} });
  const resource = owner.retain({ key: 'image', fingerprint: 'fixed', sha256: digest, async acquire() { return lease; } });
  await tick(); assert.equal(fetches, 1); resource.dispose(); await tick(); assert.equal(owner.stats().running, 0);
  release(new Response(new ReadableStream({ cancel() { cancels++; } }), { headers: { 'content-type': 'image/png' } }));
  await tick(); assert.equal(cancels, 1); assert.equal(resource.store.state.url, null); owner.dispose(); assert.equal(cancels, 1);
});
