import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { createResultsSupplierClient } from '@phosphorco/bb-turn-results/bb';
import { createRegisteredHandlerRpc } from '@phosphorco/bb-turn-results/testing';
import { adaptCompletedEvent } from '@phosphorco/bb-turn-results/events';
import { canonicalJson, resolveOutcomeBudget, sha256Canonical } from '@phosphorco/bb-turn-results';
import imageResultsPlugin from '../server.ts';
import { imageCandidate } from '../recognition.ts';
import { createImageObservationStore } from '../store.ts';
import { IMAGE_MEDIA_METHOD, IMAGE_MEDIA_TTL_MS, IMAGE_MEDIA_DEADLINE_MS } from '../media-contract.ts';

// Real PNG syntax/hash, synthetic source. These tests perform no live SDK I/O.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function fixture({ path = '/saved/image #1.png', bytes = Buffer.from(PNG, 'base64') } = {}) {
  const digest = hash(bytes), calls = [], native = { id: 'evt_1', threadId: 'thr_fixture', seq: 1,
    scope: { kind: 'turn', turnId: 'turn_1' }, type: 'item/completed', createdAt: 100,
    data: { item: { id: 'item_1', type: 'imageGeneration', status: 'completed', error: null,
      path, transparentBackground: false, result: bytes.toString('base64') } } };
  const selected = await adaptCompletedEvent(native); assert.equal(selected.state, 'admitted');
  const identity = imageCandidate(selected.event).identity;
  let generation = 0;
  const state = {
    file: { path, content: bytes.toString('base64'), contentEncoding: 'base64', sha256: digest, sizeBytes: bytes.length, mimeType: 'image/png' },
    async read() { return state.file; },
    async preview() { return { baseUrl: `/api/v1/file-previews/fixture-${++generation}`, expiresAtMs: Date.now() + IMAGE_MEDIA_TTL_MS }; },
  };
  const sdk = {
    threads: { events: { async list(args) { calls.push(['native', args]); return [native]; } },
      async get(args) { calls.push(['thread', args]); return { environmentId: 'env_current' }; } },
    environments: { async get(args) { calls.push(['environment', args]); return { hostId: 'host-bound' }; } },
    files: {
      async read(args) { calls.push(['file', args]); return state.read(args); },
      async createPreview(args) { calls.push(['preview', args]); return state.preview(args); },
    },
  };
  let host = createFakePluginHost({ pluginId: 'turn-result-images', sdk });
  imageResultsPlugin(host.bb);
  const store = () => createImageObservationStore(host.bb.storage.database());
  const client = () => createResultsSupplierClient({ plugins: createRegisteredHandlerRpc(host, 'turn-result-images') }, 'turn-result-images');
  return { state, calls, native, identity, digest, store, get host() { return host; },
    async bind() { return (await client().resolve({ version: 1, threadId: identity.ref.source.threadId,
      items: [identity], maxOutcomeBytes: resolveOutcomeBudget(1) })).resolutions[0].value; },
    media(input = { version: 1, identity }) { return host.harness.behavior.callRpc(IMAGE_MEDIA_METHOD, input); },
    async reload() { host = await host.harness.lifecycle.reload(imageResultsPlugin); },
    async dispose() { await host.harness.lifecycle.dispose(); },
  };
}

test('actual server factory registers strict media RPC; unknown/unverified identities never cause source reads', async () => {
  const f = await fixture();
  try {
    assert.ok(f.host.harness.inspection.registrations.rpcMethods.includes(IMAGE_MEDIA_METHOD));
    assert.deepEqual(f.calls, []);
    assert.deepEqual(await f.media(), { version: 1, state: 'unavailable', reason: 'verified-binding-missing' });
    for (const input of [null, {}, { version: 2, identity: f.identity },
      { version: 1, identity: f.identity, hostId: 'host-foreign' },
      { version: 1, identity: { ...f.identity, unknown: true } },
      { version: 1, identity: f.identity, padding: 'x'.repeat(8192) }]) {
      await assert.rejects(f.media(input), error => error.code === 'invalid_input');
    }
    assert.deepEqual(f.calls, []); assert.equal(f.store().stats().rows, 0);
    await f.bind(); f.calls.length = 0;
    const foreign = structuredClone(f.identity); foreign.evidence.selectedDigest = '0'.repeat(64);
    assert.equal((await f.media({ version: 1, identity: foreign })).reason, 'source-binding-conflict');
    assert.deepEqual(f.calls, []);
  } finally { await f.dispose(); }
});

test('real server + public SDK adapters rehash fixed target before exact-host two-minute lease; no durable URL or bytes', async () => {
  const f = await fixture();
  try {
    await f.bind(); f.calls.length = 0;
    const before = canonicalJson(f.store().read(f.identity.ref.source)), stats = f.store().stats();
    const output = await f.media(); assert.equal(output.state, 'ready');
    assert.deepEqual(f.calls.map(([kind]) => kind), ['file', 'preview']);
    assert.equal(f.calls[0][1].hostId, 'host-bound'); assert.equal(f.calls[0][1].path, '/saved/image #1.png');
    const preview = f.calls[1][1];
    assert.equal(preview.hostId, 'host-bound'); assert.equal(preview.rootPath, '/saved'); assert.equal(preview.ttlMs, 120000);
    assert.ok(preview.signal instanceof AbortSignal);
    assert.equal(output.lease.url, `${output.lease.baseUrl}/image%20%231.png`);
    assert.equal(output.lease.targetFingerprint, await sha256Canonical({ target: { kind: 'host', hostId: 'host-bound', path: '/saved/image #1.png' }, sha256: f.digest }));
    assert.deepEqual(output.image, { mimeType: 'image/png', width: 1, height: 1, sizeBytes: 68, sha256: f.digest });
    assert.ok(output.lease.expiresAtMs > output.lease.resolvedAt);
    assert.ok(output.lease.expiresAtMs - output.lease.resolvedAt <= 120000);
    assert.equal(canonicalJson(f.store().read(f.identity.ref.source)), before); assert.deepEqual(f.store().stats(), stats);
    assert.equal(JSON.stringify(output).includes(PNG), false);
    const again = await f.media(); assert.equal(again.state, 'ready');
    assert.equal(again.lease.targetFingerprint, output.lease.targetFingerprint);
    assert.notEqual(again.lease.leaseGeneration, output.lease.leaseGeneration); assert.notEqual(again.lease.url, output.lease.url);
    assert.equal(canonicalJson(f.store().read(f.identity.ref.source)), before);
  } finally { await f.dispose(); }
});

test('actual SDK host reload/reopen plus pruned native output retain identity and original fixed host; media creates no persistence revision', async () => {
  const f = await fixture();
  try {
    await f.bind(); const before = canonicalJson(f.store().read(f.identity.ref.source));
    f.native.data.item.result = '';
    f.native.data.item.truncation = { result: { originalLength: PNG.length, retainedHeadLength: 0, retainedTailLength: 0, truncatedAt: Date.now() } };
    await f.reload(); f.calls.length = 0;
    const output = await f.media(); assert.equal(output.state, 'ready');
    assert.deepEqual(f.calls.map(([kind]) => kind), ['file', 'preview']);
    assert.equal(f.calls[0][1].hostId, 'host-bound');
    assert.equal(canonicalJson(f.store().read(f.identity.ref.source)), before);
  } finally { await f.dispose(); }
});

test('changed bytes, incorrect metadata and offline file cannot create media lease; confirmed generation remains retained', async () => {
  const f = await fixture();
  try {
    await f.bind(); const before = canonicalJson(f.store().read(f.identity.ref.source)), normal = f.state.file;
    const changed = Buffer.from(PNG, 'base64'); changed[45] ^= 1;
    for (const patch of [
      { content: changed.toString('base64') }, { path: '/another/image.png' }, { sha256: 'f'.repeat(64) },
      { mimeType: 'text/html' }, { contentEncoding: 'utf8' }, { sizeBytes: 8388609 },
    ]) {
      f.state.file = { ...normal, ...patch }; f.calls.length = 0;
      assert.equal((await f.media()).state, 'unavailable'); assert.deepEqual(f.calls.map(([kind]) => kind), ['file']);
      assert.equal(canonicalJson(f.store().read(f.identity.ref.source)), before);
    }
    f.state.read = async () => { throw new Error('host offline'); }; f.calls.length = 0;
    assert.equal((await f.media()).state, 'unavailable'); assert.deepEqual(f.calls.map(([kind]) => kind), ['file']);
    assert.equal(f.store().read(f.identity.ref.source).resolution.knowledge, 'confirmed');
    // A subsequent demand can recover; the source performs no retry itself.
    f.state.read = async () => normal;
    assert.equal((await f.media()).state, 'ready');
  } finally { await f.dispose(); }
});

test('invalid native lease URL, TTL, expiry or output size never escape registered handler as ready', async () => {
  const f = await fixture();
  try {
    await f.bind();
    for (const lease of [
      { baseUrl: 'https://wrong.example/bytes', expiresAtMs: Date.now() + 120000 },
      { baseUrl: '//wrong.example/bytes', expiresAtMs: Date.now() + 120000 },
      { baseUrl: '/api/v1/file-previews/id?token=1', expiresAtMs: Date.now() + 120000 },
      { baseUrl: '/api/v1/file-previews/id/../../secret', expiresAtMs: Date.now() + 120000 },
      { baseUrl: '/api/v1/file-previews/id', expiresAtMs: 0 },
      { baseUrl: '/api/v1/file-previews/id', expiresAtMs: Number.MAX_SAFE_INTEGER },
      { baseUrl: '/api/v1/file-previews/id', expiresAtMs: NaN },
      { baseUrl: 'x'.repeat(16384), expiresAtMs: Date.now() + 120000 },
    ]) {
      f.state.preview = async () => lease;
      assert.deepEqual(await f.media(), { version: 1, state: 'unavailable', reason: 'invalid-preview-lease' });
    }
  } finally { await f.dispose(); }
});

test('stored over-policy PNG dimensions cannot create a preview even with a matching file digest', async () => {
  const bytes = Buffer.from(PNG, 'base64'); bytes.writeUInt32BE(32769, 16);
  let crc = 0xffffffff;
  for (let i = 12; i < 29; i++) { crc ^= bytes[i]; for (let bit = 0; bit < 8; bit++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0); }
  bytes.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 29);
  const f = await fixture({ bytes });
  try {
    await f.bind(); f.calls.length = 0;
    assert.deepEqual(await f.media(), { version: 1, state: 'unavailable', reason: 'dimensions-over-policy' });
    assert.deepEqual(f.calls.map(([kind]) => kind), ['file']);
  } finally { await f.dispose(); }
});

test('POSIX root, Windows drive and UNC paths select exact native parent and encoded basename', async () => {
  for (const [path, root, basename] of [
    ['/root.png', '/', 'root.png'], ['C:\\saved\\image #1.png', 'C:\\saved', 'image%20%231.png'],
    ['\\\\server\\share\\saved\\image.png', '\\\\server\\share\\saved', 'image.png'],
  ]) {
    const f = await fixture({ path });
    try {
      await f.bind(); f.calls.length = 0;
      const output = await f.media(); assert.equal(output.state, 'ready');
      assert.equal(f.calls[1][1].rootPath, root); assert.equal(output.lease.url, `${output.lease.baseUrl}/${basename}`);
    } finally { await f.dispose(); }
  }
});

test('a hung verification read times out under source deadline; ignored completion cannot start a lease or write', async () => {
  const f = await fixture(), held = deferred(), entered = deferred();
  try {
    await f.bind(); f.calls.length = 0; const before = canonicalJson(f.store().read(f.identity.ref.source));
    let signal;
    f.state.read = async args => { signal = args.signal; entered.resolve(); await held.promise; return f.state.file; };
    const pending = f.media(); await entered.promise;
    const started = performance.now(), output = await pending;
    assert.equal(output.reason, 'source-timeout'); assert.ok(performance.now() - started < IMAGE_MEDIA_DEADLINE_MS + 500);
    assert.equal(signal.aborted, true); held.resolve(); await delay(10);
    assert.deepEqual(f.calls.map(([kind]) => kind), ['file']);
    assert.equal(canonicalJson(f.store().read(f.identity.ref.source)), before);
  } finally { held.resolve(); await f.dispose(); }
});

test('verification and lease share one source deadline, with late created lease discarded and no automatic retry', async () => {
  const f = await fixture(), held = deferred(), entered = deferred();
  try {
    await f.bind(); f.calls.length = 0;
    f.state.read = async () => { await delay(900); return f.state.file; };
    let signal;
    f.state.preview = async args => { signal = args.signal; entered.resolve(); await held.promise;
      return { baseUrl: '/api/v1/file-previews/late', expiresAtMs: Date.now() + 120000 }; };
    const start = performance.now(), pending = f.media(); await entered.promise;
    assert.equal((await pending).reason, 'source-timeout');
    assert.ok(performance.now() - start < IMAGE_MEDIA_DEADLINE_MS + 500);
    assert.equal(signal.aborted, true); held.resolve(); await delay(10);
    assert.deepEqual(f.calls.map(([kind]) => kind), ['file', 'preview']);
  } finally { held.resolve(); await f.dispose(); }
});

test('media and ordinary resolve share two source slots; no extra file or lease request on capacity', async () => {
  const f = await fixture(), held = deferred(), entered = deferred();
  try {
    await f.bind(); f.calls.length = 0; let count = 0;
    f.state.read = async () => { if (++count === 2) entered.resolve(); await held.promise; return f.state.file; };
    const media = f.media();
    // A second identity starts a genuine uncached production resolve.
    const native = structuredClone(f.native); native.id = 'evt_2'; native.seq = 2;
    native.data.item.id = 'item_2';
    const selected = await adaptCompletedEvent(native), identity = imageCandidate(selected.event).identity;
    f.host.harness.sdk.stub('threads.events.list', async () => [native]);
    const client = createResultsSupplierClient({ plugins: createRegisteredHandlerRpc(f.host, 'turn-result-images') }, 'turn-result-images');
    const resolving = client.resolve({ version: 1, threadId: identity.ref.source.threadId, items: [identity], maxOutcomeBytes: resolveOutcomeBudget(1) });
    await entered.promise;
    assert.equal((await f.media()).reason, 'source-capacity'); assert.equal(count, 2);
    held.resolve(); assert.equal((await media).state, 'ready'); assert.equal((await resolving).resolutions[0].state, 'resolved');
    assert.equal(f.calls.filter(([kind]) => kind === 'preview').length, 1);
  } finally { held.resolve(); await f.dispose(); }
});

test('real host disposal aborts ignored in-flight lease and fences its late response', async () => {
  const f = await fixture(), held = deferred(), entered = deferred();
  try {
    await f.bind(); let signal;
    f.state.preview = async args => { signal = args.signal; entered.resolve(); await held.promise;
      return { baseUrl: '/api/v1/file-previews/late', expiresAtMs: Date.now() + 120000 }; };
    const pending = f.media(); await entered.promise; await f.dispose();
    assert.deepEqual(await pending, { version: 1, state: 'unavailable', reason: 'source-disposed' });
    assert.equal(signal.aborted, true); held.resolve(); await delay(10);
    assert.equal(f.calls.filter(([kind]) => kind === 'preview').length, 1);
  } finally { held.resolve(); await f.dispose(); }
});
