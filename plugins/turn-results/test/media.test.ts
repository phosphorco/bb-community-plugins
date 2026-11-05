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

test('two speculative images share the existing pool; foreground visibility promotes their dynamic acquisition policy', async () => {
  const h = harness(); const policies: (() => boolean)[] = [];
  const request = { ...h.request, async acquire(_signal: AbortSignal, policy?: () => boolean) { policies.push(policy!); return lease; } };
  const warm = h.owner.retain(request, true, true), second = h.owner.retain({ ...request, key: 'second' }, true, true);
  try {
    assert.throws(() => h.owner.retain({ ...request, key: 'third' }, true, true), /Nearby media capacity/);
    await settled(warm.store); assert.equal(policies.length, 2); assert.equal(policies[0]!(), true);
    warm.promote(); assert.equal(policies[0]!(), false); assert.equal(policies[1]!(), true);
    warm.promote(); assert.equal(policies.length, 2, 'promotion neither reacquires nor duplicates an entry');
    const visible = h.owner.retain(request, true);
    try { assert.equal(warm.store, visible.store); assert.equal(warm.store.state.state, 'ready'); }
    finally { visible.dispose(); }
    assert.ok(h.owner.stats().bytes <= 33554432); assert.ok(h.owner.stats().running <= 2);
  } finally { warm.dispose(); second.dispose(); h.owner.dispose(); }
});


test('settled speculative-only failure leaves one genuine foreground attempt and verified warm reuse', async () => {
  const h = harness(); let attempts = 0;
  const request = { ...h.request, async acquire() { if (++attempts === 1) throw Error('optional source timeout'); return lease; } };
  const warm = h.owner.retain(request, true, true);
  let foreground: ReturnType<typeof h.owner.retain> | null = null;
  try {
    await settled(warm.store, 'error'); await tick(); assert.equal(attempts, 1); assert.equal(h.owner.stats().running, 0);
    await tick(); assert.equal(attempts, 1, 'optional failure stays parked while idle');
    foreground = h.owner.retain(request, false);
    await tick(); assert.equal(attempts, 1, 'nonvisible retention does not spend actual foreground eligibility');
    foreground.visible(true); await settled(foreground.store, 'ready');
    assert.equal(foreground.store.state.state, 'ready', 'first real foreground demand must get one fresh verification attempt');
    assert.equal(attempts, 2); assert.equal(foreground.store.state.error, null); assert.equal(h.counts().fetches, 1);
    const url = foreground.store.state.url; foreground.dispose(); foreground = null; warm.dispose();
    const remount = h.owner.retain(request);
    try { assert.equal(remount.store.state.url, url); await tick(); assert.equal(attempts, 2); }
    finally { remount.dispose(); }
  } finally { foreground?.dispose(); warm.dispose(); h.owner.dispose(); }
});

test('foreground failure consumes speculative eligibility once; toggles and remounts do not retry', async () => {
  const h = harness(); let attempts = 0;
  const request = { ...h.request, async acquire() { attempts++; throw Error('still unavailable'); } };
  const warm = h.owner.retain(request, true, true);
  try {
    await settled(warm.store, 'error'); await tick(); assert.equal(attempts, 1);
    warm.promote(); await tick(); assert.equal(attempts, 2); assert.equal(warm.store.state.state, 'error');
    warm.promote(); warm.visible(false); warm.visible(true); await tick(); assert.equal(attempts, 2);
    warm.dispose();
    for (let i = 0; i < 3; i++) { const visible = h.owner.retain(request); await tick(); assert.equal(attempts, 2); visible.dispose(); }
    assert.equal(h.counts().fetches, 0); assert.equal(h.owner.stats().running, 0);
  } finally { warm.dispose(); h.owner.dispose(); }
});

test('running speculative response promoted to foreground stays owned and its eventual failure has no automatic retry', async () => {
  const h = harness(); let attempts = 0, reject!: (error: Error) => void, signal!: AbortSignal;
  const request = { ...h.request, acquire(value: AbortSignal) { attempts++; signal = value; return new Promise<typeof lease>((_resolve, fail) => { reject = fail; }); } };
  const warm = h.owner.retain(request, true, true);
  try {
    await tick(); warm.promote(); await tick();
    assert.equal(attempts, 1); assert.equal(signal.aborted, false); assert.equal(h.owner.stats().running, 1);
    reject(Error('foreground source failure')); await settled(warm.store, 'error'); await tick();
    assert.equal(attempts, 1); warm.visible(false); warm.visible(true); await tick(); assert.equal(attempts, 1);
    const another = h.owner.retain(request); await tick(); assert.equal(attempts, 1); another.dispose();
    assert.equal(h.owner.stats().running, 0); assert.equal(h.counts().fetches, 0);
  } finally { warm.dispose(); h.owner.dispose(); }
});

test('unknown media binding cannot fetch when normal committed correlation disagrees with the response', async () => {
  const { imageMediaRequest } = await import('../gallery/media.ts');
  const source = { threadId: 'thread', turnId: 'turn', eventId: 'event', seq: 1, itemId: 'image', eventType: 'item/completed' as const };
  const identity = { version: 1 as const, ref: { source, member: 'image:0', kind: 'bb-native-images/image-generated' },
    artifact: { provider: 'bb-native-images', id: 'event', kind: 'image' }, specificity: 'typed' as const,
    evidence: { basis: 'native-completion' as const, selectedDigest: 'a'.repeat(64), sites: [], targetUrls: [] }, lookup: null };
  const target = { kind: 'host' as const, hostId: 'host', path: '/image.png' };
  const pending = { key: 'image', owner: 'turn-result-images', identity, resolution: null, unresolved: true, firstObservedOrder: 1,
    corrections: [], sourceExpired: null, retracted: null, freshness: 'unverified' as const, currentAvailability: null };
  const value = { ...pending, unresolved: false, resolution: { identity, proof: { kind: 'native-image' as const, source, selectedDigest: 'a'.repeat(64) },
    revision: { epoch: 'e', sequence: 1 }, knowledge: 'confirmed' as const,
    outcomeEvidence: { kind: 'observation' as const, id: 'event', digest: 'a'.repeat(64), recordedAt: 1 },
    availability: { state: 'available' as const, asOf: 1, expiresAt: null },
    route: { kind: 'file' as const, target }, provenance: { originHost: { state: 'unknown' as const, reason: 'not-recorded' as const },
      artifactLocation: { state: 'verified' as const, target, observedAt: 1, basis: 'explicit-host-read' as const, sha256: digest } },
    fallback: { kind: 'image' as const, title: 'Generated image', alt: 'Image' }, spans: { width: 2 as const, height: 2 as const } } };
  let publishes = 0, fetches = 0;
  const request = await imageMediaRequest(pending, async (_signal, read) => ({ state: 'ready', value: await read(new AbortController().signal) }),
    { async callRpc(input) { return input.outputSchema.parse({ version: 1, state: 'ready', image: { mimeType: 'image/png', sha256: digest, width: 1, height: 1, sizeBytes: data.length },
      lease: { targetFingerprint: 'f'.repeat(64), leaseGeneration: 'one', baseUrl: '/api/v1/file-previews/test', url: '/api/v1/file-previews/test/image.png', resolvedAt: Date.now(), expiresAtMs: Date.now() + 60000 } }); } },
    async () => ({ row: value, publish() { publishes++; } }));
  assert.ok(request);
  const owner = createGalleryMedia({ async fetch() { fetches++; return new Response(data); }, createUrl() { throw Error('no Blob'); }, revokeUrl() {} });
  const handle = owner.retain(request);
  try {
    await settled(handle.store, 'error'); assert.equal(handle.store.state.state, 'error');
    assert.equal(request.fingerprint, null); assert.equal(request.sha256, null); assert.equal(publishes, 0); assert.equal(fetches, 0);
  } finally { handle.dispose(); owner.dispose(); }
});


async function correlatedImageFixture() {
  const { imageMediaRequest } = await import('../gallery/media.ts');
  const { sha256Canonical } = await import('@phosphorco/bb-turn-results');
  const source = { threadId: 'thread', turnId: 'turn', eventId: 'event', seq: 1, itemId: 'image', eventType: 'item/completed' as const };
  const identity = { version: 1 as const, ref: { source, member: 'image:0', kind: 'bb-native-images/image-generated' },
    artifact: { provider: 'bb-native-images', id: 'event', kind: 'image' }, specificity: 'typed' as const,
    evidence: { basis: 'native-completion' as const, selectedDigest: 'a'.repeat(64), sites: [], targetUrls: [] }, lookup: null };
  const target = { kind: 'host' as const, hostId: 'host', path: '/image.png' };
  const candidate = { key: 'image', owner: 'turn-result-images', identity, resolution: null, unresolved: true, firstObservedOrder: 1,
    corrections: [], sourceExpired: null, retracted: null, freshness: 'unverified' as const, currentAvailability: null };
  const row = { ...candidate, unresolved: false, currentAvailability: { state: 'available' as const, asOf: 1, expiresAt: null },
    resolution: { identity, proof: { kind: 'native-image' as const, source, selectedDigest: 'a'.repeat(64) }, revision: { epoch: 'e', sequence: 1 },
      knowledge: 'confirmed' as const, outcomeEvidence: { kind: 'observation' as const, id: 'event', digest: 'a'.repeat(64), recordedAt: 1 },
      availability: { state: 'available' as const, asOf: 1, expiresAt: null }, route: { kind: 'file' as const, target },
      provenance: { originHost: { state: 'unknown' as const, reason: 'not-recorded' as const },
        artifactLocation: { state: 'verified' as const, target, observedAt: 1, basis: 'explicit-host-read' as const, sha256: digest } },
      fallback: { kind: 'image' as const, title: 'Generated image', alt: 'Image' }, spans: { width: 2 as const, height: 2 as const } } };
  const fingerprint = await sha256Canonical({ target, sha256: digest });
  let mediaCalls = 0;
  const plugins = { async callRpc(input: Parameters<Parameters<typeof imageMediaRequest>[2]['callRpc']>[0]) {
    mediaCalls++;
    return input.outputSchema!.parse({ version: 1, state: 'ready', image: { mimeType: 'image/png', sha256: digest, width: 1, height: 1, sizeBytes: data.length },
      lease: { targetFingerprint: fingerprint, leaseGeneration: 'one', baseUrl: '/api/v1/file-previews/test', url: lease.url,
        resolvedAt: Date.now(), expiresAtMs: Date.now() + 60000 } });
  } } as Parameters<typeof imageMediaRequest>[2];
  const scope: Parameters<typeof imageMediaRequest>[1] = async (signal, read) => ({ state: 'ready', value: await read(signal) });
  return { imageMediaRequest, candidate, row, plugins, scope, fingerprint, calls: () => mediaCalls };
}

test('final publication failure preserves binding but explicit candidate reentry uses current correlation', async () => {
  const f = await correlatedImageFixture(); let oldCorrelation = 0, currentCorrelation = 0, gets = 0;
  const firstRequest = (await f.imageMediaRequest(f.candidate, f.scope, f.plugins, async () => {
    oldCorrelation++; return { row: f.row, publish() { throw Error('publication failed'); } };
  }))!;
  const owner = createGalleryMedia({ async fetch() { gets++; return new Response(data, { headers: { 'content-type': 'image/png' } }); },
    createUrl: () => 'blob:verified', revokeUrl() {} });
  const first = owner.retain(firstRequest); let next: ReturnType<typeof owner.retain> | undefined;
  try {
    await settled(first.store, 'error'); await tick(); assert.equal(firstRequest.fingerprint, f.fingerprint);
    assert.equal(gets, 0); assert.equal(owner.stats().running, 0); first.dispose();
    const currentRequest = (await f.imageMediaRequest(f.candidate, f.scope, f.plugins, async () => {
      currentCorrelation++; return { row: f.row, publish() {} };
    }))!;
    assert.equal(currentRequest.fingerprint, null);
    next = owner.retain(currentRequest); assert.equal(currentRequest.fingerprint, f.fingerprint);
    assert.equal(currentRequest.sha256, digest); await tick(); assert.equal(f.calls(), 1, 'reentry does not retry');
    next.retry(); await settled(next.store, 'ready');
    assert.equal(next.store.state.state, 'ready'); assert.equal(oldCorrelation, 1); assert.equal(currentCorrelation, 1);
    assert.equal(f.calls(), 2); assert.equal(gets, 1); assert.equal(firstRequest.fingerprint, f.fingerprint);
  } finally { first.dispose(); next?.dispose(); owner.dispose(); }
});

test('post-publication hash failure renews a reentered or already-retained resolved handle only on explicit settled retry', async t => {
  for (const mode of ['reentry', 'retained'] as const) await t.test(mode, async () => {
    const f = await correlatedImageFixture(); let oldCorrelation = 0, currentScope = 0, gets = 0, correct = false, creates = 0;
    let oldCurrent = true;
    const currentRequest = (await f.imageMediaRequest(f.row, async (signal, read, optional) => {
      currentScope++; return f.scope(signal, read, optional);
    }, f.plugins))!;
    const owner = createGalleryMedia({ async fetch() { gets++; return new Response(correct ? data : new Uint8Array([0]), { headers: { 'content-type': 'image/png' } }); },
      createUrl: () => `blob:verified-${++creates}`, revokeUrl() {} });
    let next: ReturnType<typeof owner.retain> | undefined;
    const firstRequest = (await f.imageMediaRequest(f.candidate, f.scope, f.plugins, async () => {
      oldCorrelation++; if (!oldCurrent) throw Error('old correlation retired');
      return { row: f.row, publish() {
        oldCurrent = false;
        if (mode === 'retained') {
          next = owner.retain(currentRequest);
          next.retry(); // Publication rerenders while the original response is owned.
          assert.equal(owner.stats().running, 1); assert.equal(currentScope, 0);
        }
      } };
    }))!;
    const first = owner.retain(firstRequest);
    try {
      await settled(first.store, 'error'); await tick();
      assert.match(first.store.state.error!, /no longer matches/); assert.equal(first.store.state.url, null);
      assert.equal(f.calls(), 1); assert.equal(gets, 1); assert.equal(creates, 0); first.dispose();
      if (!next) next = owner.retain(currentRequest);
      assert.throws(() => owner.retain({ ...currentRequest, fingerprint: 'changed' }), /Immutable media binding/);
      assert.throws(() => owner.retain({ ...currentRequest, sha256: 'f'.repeat(64) }), /Immutable media binding/);
      next.visible(false); next.visible(true); await tick();
      assert.equal(f.calls(), 1, 'retention/visibility cannot retry a foreground failure');
      correct = true; next.retry(); await settled(next.store, 'ready'); await tick();
      assert.equal(next.store.state.state, 'ready'); assert.equal(currentScope, 1); assert.equal(oldCorrelation, 1);
      assert.equal(f.calls(), 2); assert.equal(gets, 2); assert.equal(creates, 1); assert.equal(owner.stats().running, 0);
      const url = next.store.state.url; next.dispose(); next = undefined;
      const warm = owner.retain(currentRequest);
      try { assert.equal(warm.store.state.url, url); await tick(); assert.equal(f.calls(), 2); assert.equal(gets, 2); }
      finally { warm.dispose(); }
    } finally { first.dispose(); next?.dispose(); owner.dispose(); }
  });
});

function boundResponseHarness() {
  const root = new AbortController(), client = {}, state = { generation: 1, proof: true };
  let resolve!: (value: typeof lease) => void;
  const response = new Promise<typeof lease>(done => { resolve = done; });
  const calls = { media: 0, gets: 0, correlations: 0, blobs: 0 };
  const owner = createGalleryMedia({
    async fetch() { calls.gets++; return new Response(data, { headers: { 'content-type': 'image/png' } }); },
    createUrl() { return `blob:bound-${++calls.blobs}`; }, revokeUrl() {},
  });
  function request() {
    const generation = state.generation;
    const value: Parameters<typeof owner.retain>[0] = { key: 'bound', claim: 'same-exact-identity', fingerprint: 'fixed', sha256: digest,
      async acquire() { value.dispatched = true; calls.media++; return response; },
      adoption: { root: root.signal, client, generation, binding: 'same-target-sha-proof-corrections',
        live: () => !root.signal.aborted && state.generation === generation,
        current: () => !root.signal.aborted && state.generation === generation && state.proof,
        async correlate(signal) { signal.throwIfAborted(); assert.equal(state.proof, true); calls.correlations++; },
      },
    };
    return value;
  }
  return { root, state, owner, calls, request, resolve: () => resolve(lease) };
}

test('dispatched bound response remains data through card retirement and needs a current same-scope adopter', async () => {
  const h = boundResponseHarness(), first = h.owner.retain(h.request()); let next: ReturnType<typeof h.owner.retain> | undefined;
  try {
    await tick(); assert.equal(h.calls.media, 1); first.dispose();
    await tick(); assert.equal(h.owner.stats().running, 1, 'card disposal cannot abort/reissue an already-dispatched bound response');
    h.state.proof = false; h.resolve(); await tick();
    assert.equal(h.calls.gets, 0); assert.equal(h.owner.stats().running, 1);
    next = h.owner.retain(h.request()); await tick();
    assert.equal(h.calls.media, 1); assert.equal(h.calls.gets, 0, 'a retained replacement alone supplies no current proof');
    h.state.proof = true; next.revalidate(); await settled(next.store, 'ready');
    assert.deepEqual(h.calls, { media: 1, gets: 1, correlations: 1, blobs: 1 });
    const url = next.store.state.url; next.dispose(); next = h.owner.retain(h.request());
    assert.equal(next.store.state.url, url); await tick(); assert.equal(h.calls.media, 1); assert.equal(h.calls.gets, 1);
    assert.throws(() => h.owner.retain({ ...h.request(), fingerprint: 'different-target' }), /Immutable media binding/);
    assert.throws(() => h.owner.retain({ ...h.request(), sha256: 'f'.repeat(64) }), /Immutable media binding/);
  } finally { first.dispose(); next?.dispose(); h.resolve(); h.owner.dispose(); }
});

test('unadopted bound response spends only the original seven-second request and never GETs or retries while idle', { timeout: 10000 }, async () => {
  const { MEDIA_LIMITS } = await import('../gallery/media.ts');
  const h = boundResponseHarness(), first = h.owner.retain(h.request()); let next: ReturnType<typeof h.owner.retain> | undefined;
  try {
    await tick(); first.dispose(); h.resolve(); await tick();
    assert.equal(h.calls.media, 1); assert.equal(h.calls.gets, 0); assert.equal(h.owner.stats().running, 1);
    await new Promise(resolve => setTimeout(resolve, MEDIA_LIMITS.deadlineMs + 40));
    assert.equal(h.owner.stats().running, 0); assert.equal(first.store.state.state, 'error');
    assert.match(first.store.state.error!, /deadline/); assert.equal(h.calls.gets, 0);
    next = h.owner.retain(h.request()); await tick();
    assert.equal(h.calls.media, 1, 'visibility/reentry does not replay a foreground deadline failure');
    next.retry(); await settled(next.store, 'ready');
    assert.equal(h.calls.media, 2); assert.equal(h.calls.gets, 1); assert.equal(next.store.state.state, 'ready');
  } finally { first.dispose(); next?.dispose(); h.resolve(); h.owner.dispose(); }
});

test('hard root or source-generation retirement refuses late bound data and cannot refill a successor', async t => {
  for (const reason of ['root', 'source-generation'] as const) await t.test(reason, async () => {
    const h = boundResponseHarness(), first = h.owner.retain(h.request());
    try {
      await tick(); assert.equal(h.calls.media, 1);
      if (reason === 'root') h.root.abort('physical-root-retired');
      else { h.state.generation++; h.owner.revalidate(); }
      await tick(); h.resolve(); await tick();
      assert.equal(h.calls.gets, 0); assert.equal(first.store.state.url, null);
      assert.equal(h.owner.stats().running, 0); await tick(); assert.equal(h.calls.media, 1, 'no stale-scope automatic reacquire');
      if (reason === 'source-generation') {
        const current = h.owner.retain(h.request());
        try { await settled(current.store, 'ready'); assert.equal(h.calls.media, 2); assert.equal(h.calls.gets, 1); }
        finally { current.dispose(); }
      }
    } finally { first.dispose(); h.resolve(); h.owner.dispose(); }
  });
});

test('bound response demand callbacks have a finite live-owner budget and disposal restores admission', async () => {
  const h = boundResponseHarness(), handles: ReturnType<typeof h.owner.retain>[] = [];
  try {
    for (let i = 0; i < 128; i++) handles.push(h.owner.retain(h.request(), false));
    assert.throws(() => h.owner.retain(h.request(), false), /Media demand capacity/);
    handles.pop()!.dispose(); const replacement = h.owner.retain(h.request(), false); replacement.dispose();
    assert.equal(h.calls.media, 0); assert.equal(h.calls.gets, 0);
  } finally { for (const handle of handles) handle.dispose(); h.resolve(); h.owner.dispose(); }
});


test('media foreground pressure: settled unadopted data yields to a different visible image without releasing live raw credit', async () => {
  const { createGalleryRuntime } = await import('../gallery/runtime.ts');
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('', { pretendToBeVisual: true }), savedDocument = globalThis.document;
  globalThis.document = dom.window.document;
  const runtime = createGalleryRuntime({ plugins: { async list() { return { plugins: [] }; }, async callRpc() { throw Error('No source/backend work is part of this resource test'); } }, threads: { events: { async list() { return []; } } } });
  const root = new AbortController(), controls = new AbortController(), client = {};
  const calls: string[] = [], rawThreads = new Map<string, number>(), signals = new Map<string, AbortSignal>(), releases = new Map<string, () => void>();
  const events: { kind: string; key: string | undefined; raw: number; running: number; ms: number }[] = [];
  const started = performance.now(); let raw = 0, peak = 0, peakPerThread = 0, gets = 0, correlations = 0, proofA = false;
  const record = (kind: string, key?: string) => events.push({ kind, key, raw, running: runtime.stats().running, ms: performance.now() - started });
  const state = { proof: true };
  const request = (key: string, held = false): Parameters<ReturnType<typeof createGalleryMedia>['retain']>[0] => {
    const value: Parameters<ReturnType<typeof createGalleryMedia>['retain']>[0] = { key, claim: key, fingerprint: 'fixed', sha256: digest,
      async acquire(signal) {
        const result = await runtime.readScope(key, signal, async bounded => {
          bounded.throwIfAborted(); value.dispatched = true; signals.set(key, bounded); calls.push(key);
          raw++; peak = Math.max(peak, raw); rawThreads.set(key, (rawThreads.get(key) ?? 0) + 1); peakPerThread = Math.max(peakPerThread, rawThreads.get(key)!);
          record('raw-start', key);
          try { if (held) await new Promise<void>(resolve => releases.set(key, resolve)); return lease; }
          finally { raw--; rawThreads.set(key, rawThreads.get(key)! - 1); record('raw-settle', key); }
        }, false, false, false);
        signal.throwIfAborted(); if (result.state !== 'ready') throw Error('Unexpected real runtime capacity'); return result.value;
      },
      adoption: { root: root.signal, client, generation: 1, binding: key,
        live: () => !root.signal.aborted, current: () => !root.signal.aborted && state.proof,
        async correlate(signal) { signal.throwIfAborted(); assert.equal(state.proof, true); correlations++; },
      },
    }; return value;
  };
  const owner = createGalleryMedia({ async fetch() { gets++; record('GET'); return new Response(data, { headers: { 'content-type': 'image/png' } }); }, createUrl: () => 'blob:pressure', revokeUrl() {} });
  const a = owner.retain(request('thread-a', true)), b = owner.retain(request('thread-b', true));
  let third: ReturnType<typeof owner.retain> | undefined, same: Promise<unknown> | undefined, failure: string | null = null;
  try {
    await tick(); await tick(); assert.equal(raw, 2); assert.equal(owner.stats().running, 2); assert.equal(runtime.stats().running, 2);
    a.dispose(); b.dispose();
    third = owner.retain(request('thread-c'));
    same = runtime.readScope('thread-a', controls.signal, async () => { proofA = true; record('same-thread-control'); return 'current'; }, false, false, false);
    await tick();
    assert.equal(raw, 2); assert.equal(proofA, false); assert.equal(calls.includes('thread-c'), false);
    assert.equal(signals.get('thread-a')!.aborted, false); assert.equal(signals.get('thread-b')!.aborted, false);
    record('pressure-while-raw-pending');
    releases.get('thread-a')!(); releases.get('thread-b')!();
    await same; await tick();
    assert.equal(rawThreads.get('thread-a'), 0); assert.equal(rawThreads.get('thread-b'), 0); assert.equal(proofA, true);
    record('raw-settled-before-foreground');
    await settled(third.store, 'ready');
    console.log('BOUND_PRESSURE', JSON.stringify({ calls, gets, media: owner.stats(), native: runtime.stats(), peak, peakPerThread, elapsedMs: performance.now() - started }));
    assert.equal(third.store.state.state, 'ready', 'settled DATA holds with no visible adopters must yield to third foreground demand before their seven-second deadlines');
    assert.deepEqual(calls, ['thread-a', 'thread-b', 'thread-c']); assert.equal(gets, 1); assert.equal(correlations, 0);
    assert.equal(peak, 2); assert.equal(peakPerThread, 1); assert.equal(signals.get('thread-a')!.aborted, false);
    assert.ok(performance.now() - started < 2000, 'resource priority cannot spend the old seven-second DATA wait');
    const idle = JSON.stringify({ calls, gets }); await tick(); assert.equal(JSON.stringify({ calls, gets }), idle);
  } catch (error) { failure = String(error); throw error; }
  finally {
    for (const release of releases.values()) release(); controls.abort(); a.dispose(); b.dispose(); third?.dispose(); owner.dispose();
    await same?.catch(() => {}); await runtime.whenDrained(); runtime.dispose(); await tick();
    const cleanup = { raw, owner: owner.stats(), runtime: runtime.stats() };
    assert.equal(raw, 0); assert.equal(owner.stats().running, 0); assert.equal(runtime.stats().running, 0); assert.equal(runtime.stats().queued, 0); assert.equal(runtime.stats().historyReads, 0);
    globalThis.document = savedDocument; dom.window.close();
  }
});


test('foreground pressure preserves a visible same-scope proof waiter and its same-attempt promotion', async () => {
  const h = boundResponseHarness(); let proof = false, waiterSignal: AbortSignal | undefined;
  const request = (key: string) => { const value = h.request(); value.key = key; value.claim = key; value.adoption!.binding = key; return value; };
  const pending = request('visible-proof-waiter'), acquire = pending.acquire;
  pending.acquire = async (signal, optional) => { waiterSignal = signal; return acquire(signal, optional); };
  pending.adoption!.current = () => !h.root.signal.aborted && proof;
  const warm = h.owner.retain(pending, true, true), abandoned = h.owner.retain(request('abandoned'));
  let foreground: ReturnType<typeof h.owner.retain> | undefined;
  try {
    await tick(); assert.equal(h.calls.media, 2); abandoned.dispose();
    foreground = h.owner.retain(request('foreground')); h.resolve();
    await settled(foreground.store, 'ready');
    assert.equal(foreground.store.state.state, 'ready'); assert.equal(h.calls.media, 3); assert.equal(h.calls.gets, 1);
    assert.equal(warm.store.state.state, 'loading'); assert.equal(waiterSignal!.aborted, false);
    assert.equal(h.owner.stats().running, 1, 'visible proof waiter keeps its owned response even while current() is false');
    warm.promote(); assert.equal(waiterSignal!.aborted, false); assert.equal(h.calls.media, 3);
    proof = true; warm.revalidate(); await settled(warm.store, 'ready');
    assert.equal(warm.store.state.state, 'ready'); assert.equal(h.calls.media, 3, 'same-attempt promotion cannot reacquire');
    assert.equal(h.calls.gets, 2); assert.equal(h.calls.blobs, 2); assert.equal(abandoned.store.state.url, null);
    const url = foreground.store.state.url, same = h.owner.retain(request('foreground'));
    try { assert.equal(same.store.state.url, url); await tick(); assert.equal(h.calls.media, 3); assert.equal(h.calls.gets, 2); }
    finally { same.dispose(); }
  } finally { warm.dispose(); abandoned.dispose(); foreground?.dispose(); h.resolve(); h.owner.dispose(); }
});
