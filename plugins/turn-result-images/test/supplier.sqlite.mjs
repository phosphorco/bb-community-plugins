import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { createResultsSupplierClient } from '@phosphorco/bb-turn-results/bb';
import { createRegisteredHandlerRpc, runSupplierConformance } from '@phosphorco/bb-turn-results/testing';
import { adaptCompletedEvent } from '@phosphorco/bb-turn-results/events';
import { resolveOutcomeBudget, canonicalByteLength } from '@phosphorco/bb-turn-results';
import { createImageObservationStore } from '../store.ts';
import { registerImageResults, IMAGE_PLUGIN_ID } from '../supplier.ts';
import { imageCandidate, imageIdentity } from '../recognition.ts';
import { ImagePortError } from '../verification.ts';
import { createImageVerificationPorts } from '../sdk-ports.ts';
import { verifyImage } from '../verification.ts';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=';
const bytes = Buffer.from(PNG, 'base64'), digest = createHash('sha256').update(bytes).digest('hex');
const ownedDirectories = new Set();
function database() {
  const directory = mkdtempSync(join(tmpdir(), 'bb-image-source-sqlite-'));
  ownedDirectories.add(directory); return new Database(join(directory, 'data.db'));
}
after(() => { for (const directory of ownedDirectories) rmSync(directory, { recursive: true, force: true }); });
const request = identity => ({ version: 1, threadId: 'thr_fixture', items: [identity], maxOutcomeBytes: resolveOutcomeBudget(1) });
async function fixture() {
  let now = 1000;
  const reads = [], native = { id: 'evt_1', threadId: 'thr_fixture', seq: 1, scope: { kind: 'turn', turnId: 'turn_1' },
    type: 'item/completed', createdAt: 100, data: { item: { id: 'item_1', type: 'imageGeneration', status: 'completed', error: null, path: '/saved/image.png', transparentBackground: false, result: PNG } } };
  const selected = await adaptCompletedEvent(native); assert.equal(selected.state, 'admitted');
  const identity = imageCandidate(selected.event).identity;
  const verification = {
    native: { async read() { reads.push('native'); return native; } },
    currentHost: { async lookup() { reads.push('host'); return { hostId: 'host-original-location', observedAt: now }; } },
    files: { async read(input) { reads.push({ hostId: input.hostId, path: input.path }); return { path: input.path, content: PNG, contentEncoding: 'base64', sha256: digest, sizeBytes: bytes.length, mimeType: 'image/png', observedAt: now }; } },
  };
  return { native, selected: selected.event, identity, verification, reads, now: () => now, setNow: value => { now = value; } };
}
function registered(f, store) {
  const host = createFakePluginHost({ pluginId: IMAGE_PLUGIN_ID });
  const registration = registerImageResults(host.bb, { store, verification: f.verification, now: f.now });
  const client = createResultsSupplierClient({ plugins: createRegisteredHandlerRpc(host, IMAGE_PLUGIN_ID) }, IMAGE_PLUGIN_ID);
  return { host, registration, client, async dispose() { registration.dispose(); await host.harness.lifecycle.dispose(); } };
}
test('actual production factory conformance uses registered handlers and actual SQLite, no source I/O in recognition', async () => {
  const f = await fixture(), db = database();
  try {
    const store = createImageObservationStore(db);
    const report = await runSupplierConformance({ pluginId: IMAGE_PLUGIN_ID, source: { entry: 'turn-result-images/supplier.ts#registerImageResults', revision: 'development-source' },
      sourcePorts: { store, verification: f.verification, now: f.now }, participantFactory: registerImageResults,
      observeSourceAccess: () => f.reads.length,
      recognizeCases: [{ name: 'completed-native-image', input: { version: 1, context: { consumer: { pluginId: 'gallery', surface: 'turn' }, threadId: 'thr_fixture', range: { fromSeq: 1, throughSeq: 1 } }, events: [f.selected], page: { cursor: null, limit: 8 } }, verify: output => assert.deepEqual(output.candidates[0].identity, f.identity) }],
      resolveCases: [{ name: 'synthetic-byte-verified-current-location', input: request(f.identity), verify(output) {
        const value = output.resolutions[0].value; assert.equal(value.knowledge, 'confirmed'); assert.equal(value.outcomeEvidence.kind, 'observation');
        assert.equal(value.outcomeEvidence.recordedAt, 100); assert.equal(value.proof.artifactDigest, digest);
        assert.equal(value.provenance.originHost.state, 'unknown'); assert.equal(value.route.target.hostId, 'host-original-location');
      } }],
    });
    assert.equal(report.passed, true, JSON.stringify(report)); assert.equal(store.stats().rows, 1);
  } finally { db.close(); }
});
test('pruning plus actual database reopen resolves original identity through fixed binding and original timestamps', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bb-image-source-composition-')), path = join(dir, 'data.db');
  let db, owner;
  try {
    const f = await fixture(); db = new Database(path); let store = createImageObservationStore(db); owner = registered(f, store);
    const initial = (await owner.client.resolve(request(f.identity))).resolutions[0].value;
    await owner.dispose(); owner = null; db.close();
    f.native.data.item.result = ''; f.native.data.item.truncation = { result: { originalLength: 123456, retainedHeadLength: 0, retainedTailLength: 0, truncatedAt: 2000 } };
    const pruned = await adaptCompletedEvent(f.native); assert.notEqual(pruned.event.selectedDigest, f.identity.evidence.selectedDigest);
    f.setNow(50000); f.reads.length = 0;
    f.verification.native.read = async () => { throw new Error('cached binding must not reread pruned provider output'); };
    f.verification.currentHost.lookup = async () => { throw new Error('cached binding must not relocate to current environment'); };
    db = new Database(path); store = createImageObservationStore(db); owner = registered(f, store);
    const reopened = (await owner.client.resolve(request(f.identity))).resolutions[0].value;
    assert.deepEqual(reopened.identity, initial.identity); assert.deepEqual(reopened.proof, initial.proof);
    assert.deepEqual(reopened.outcomeEvidence, initial.outcomeEvidence); assert.equal(reopened.revision.epoch, initial.revision.epoch);
    assert.ok(reopened.revision.sequence > initial.revision.sequence); assert.equal(reopened.availability.asOf, 50000);
    assert.deepEqual(f.reads, [{ hostId: 'host-original-location', path: '/saved/image.png' }]);
    assert.equal(store.read(f.identity.ref.source).materialization.verifiedAt, 1000);
  } finally { if (owner) await owner.dispose(); if (db?.open) db.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('unmaterialized historical generation survives pruning and later file recovery does not rewrite evidence', async () => {
  for (const prune of [false, true]) {
    const f = await fixture(), db = database(); let owner;
    try {
      const files = f.verification.files.read; f.verification.files.read = async () => { throw new ImagePortError('missing'); };
      const store = createImageObservationStore(db); owner = registered(f, store);
      const initial = (await owner.client.resolve(request(f.identity))).resolutions[0].value;
      assert.equal(initial.knowledge, 'confirmed'); assert.equal(initial.availability.state, 'unavailable'); assert.equal(initial.route.kind, 'source');
      assert.equal(store.read(f.identity.ref.source).materialization, null);
      f.setNow(50000); f.verification.files.read = files;
      if (prune) { f.native.data.item.result = ''; f.native.data.item.truncation = { result: { originalLength: 123456, retainedHeadLength: 0, retainedTailLength: 0, truncatedAt: 2000 } }; }
      const later = (await owner.client.resolve(request(f.identity))).resolutions[0].value;
      assert.deepEqual(later.identity, initial.identity); assert.deepEqual(later.outcomeEvidence, initial.outcomeEvidence);
      assert.equal(later.availability.state, prune ? 'unavailable' : 'available');
      assert.equal(later.route.kind, prune ? 'source' : 'file');
      const serialized = JSON.stringify(store.read(f.identity.ref.source)); assert.equal(serialized.includes(PNG), false);
      assert.equal(serialized.includes('contentEncoding'), false); assert.equal(serialized.includes('prompt'), false);
    } finally { if (owner) await owner.dispose(); db.close(); }
  }
});
test('source disposal fences ignored file read before durable commit; source request admission stays bounded', async () => {
  const f = await fixture(), db = database(); let owner;
  let release; const held = new Promise(done => { release = done; });
  try {
    const store = createImageObservationStore(db), normal = f.verification.files.read; let calls = 0;
    f.verification.files.read = async input => { calls++; await held; return normal(input); };
    owner = registered(f, store);
    const one = owner.client.resolve(request(f.identity)), two = owner.client.resolve(request(f.identity));
    const checked = Promise.all([assert.rejects(one, e => e.kind === 'aborted'), assert.rejects(two, e => e.kind === 'aborted')]);
    while (calls < 2) await new Promise(done => setTimeout(done, 0));
    await assert.rejects(owner.client.resolve(request(f.identity)), e => e.kind === 'source-error');
    assert.equal(calls, 2); owner.registration.dispose(); await checked;
    release(); await new Promise(done => setTimeout(done, 0)); assert.equal(store.stats().rows, 0);
  } finally { release?.(); if (owner) await owner.dispose(); db.close(); }
});
test('public SDK binding selects exact event and fences a changed environment hop after abort', async () => {
  const f = await fixture(), calls = [], abort = new AbortController();
  const sdk = {
    threads: { events: { async list(args) { calls.push(args); return [f.native]; } }, async get() { abort.abort(); return { environmentId: 'env-current' }; } },
    environments: { async get() { throw new Error('environment lookup after abort'); } },
    files: { async read(args) { assert.equal(args.hostId, 'host-original-location'); assert.equal(args.path, '/saved/image.png'); return { path: args.path, content: PNG, contentEncoding: 'base64', sha256: digest, sizeBytes: bytes.length, mimeType: 'image/png' }; } },
  };
  const ports = createImageVerificationPorts(sdk, f.now), signal = new AbortController().signal;
  assert.equal(await ports.native.read(f.identity.ref.source, { signal, limit: 1, maxResultChars: 100 }), f.native);
  assert.equal(calls[0].limit, '1'); assert.equal(calls[0].afterSeq, '0'); assert.deepEqual(calls[0].types, ['item/completed']);
  const foreign = { ...f.identity.ref.source, eventId: 'foreign' }; assert.equal(await ports.native.read(foreign, { signal, limit: 1, maxResultChars: 100 }), null);
  await assert.rejects(ports.currentHost.lookup('thr_fixture', { signal: abort.signal }), e => e.name === 'AbortError');
  assert.equal((await ports.files.read({ hostId: 'host-original-location', path: '/saved/image.png', signal, maxBytes: bytes.length })).observedAt, 1000);
});
test('legal heavily escaped identity exceeding storage key cap gets named capacity before native I/O', async () => {
  const f = await fixture(), db = database(); let owner;
  try {
    const source = { ...f.identity.ref.source, threadId: '"'.repeat(256), eventId: '"'.repeat(256) };
    const identity = imageIdentity(source, 'a'.repeat(64), '/saved/a.png'), store = createImageObservationStore(db);
    owner = registered(f, store);
    const output = await owner.client.resolve({ ...request(identity), threadId: source.threadId });
    assert.equal(output.resolutions[0].state, 'unavailable'); assert.equal(output.resolutions[0].reason, 'source-key-capacity');
    assert.deepEqual(f.reads, []); assert.equal(store.stats().rows, 0);
  } finally { if (owner) await owner.dispose(); db.close(); }
});
test('same8192 materialization cap holds fresh/store/cache across expiry, pruning and actual reopen', async () => {
  // Reviewer H1 witness: nested components <=100, legal source/key, full row
  // below24576 yet materialization8276. Also exact8192/8193 boundaries.
  for (const [characters, hostId, expectedBytes] of [[1458, 'host-one', 8192], [1458, 'host-onex', 8193], [1500, 'host-one', 8276]]) {
    const f = await fixture(); let db = database(), owner;
    try {
      const path = '/saved/' + 'x'.repeat(characters).match(/.{1,100}/g).join('/') + '.png';
      f.native.id = '"'.repeat(256); f.native.threadId = 't'.repeat(256); f.native.scope.turnId = 'u'.repeat(256); f.native.data.item.id = 'i'.repeat(256); f.native.data.item.path = path;
      const selected = await adaptCompletedEvent(f.native); assert.equal(selected.state, 'admitted'); f.identity = imageCandidate(selected.event).identity;
      f.verification.currentHost.lookup = async () => ({ hostId, observedAt: f.now() });
      const input = { ...request(f.identity), threadId: f.identity.ref.source.threadId };
      let store = createImageObservationStore(db); owner = registered(f, store);
      const first = (await owner.client.resolve(input)).resolutions[0].value;
      assert.equal(first.knowledge, 'confirmed');
      if (expectedBytes === 8192) {
        assert.equal(first.availability.state, 'available');
        assert.equal(canonicalByteLength(store.read(f.identity.ref.source).materialization), expectedBytes);
      } else {
        assert.equal(first.availability.reason, 'materialization-byte-cap'); assert.equal(first.route.kind, 'source');
        const retained = store.read(f.identity.ref.source); assert.equal(retained.materialization, null);
        // Independent direct-store admission: the aggregate row fits but the
        // nested binding cannot be acknowledged by a later cache reader.
        const proposed = structuredClone(retained);
        proposed.materialization = { schema: 1, identity: proposed.history.identity, proof: proposed.history.proof,
          providerSha256: digest, path, target: { kind: 'host', hostId, path }, nativeCreatedAt: 100, width: 1, height: 1, sizeBytes: bytes.length, verifiedAt: 1000 };
        proposed.resolution.route = { kind: 'file', target: proposed.materialization.target };
        proposed.resolution.provenance.artifactLocation = { state: 'verified', target: proposed.materialization.target, observedAt: 1000, basis: 'explicit-host-read', sha256: digest };
        proposed.resolution.availability = { state: 'available', asOf: 1000, expiresAt: 31000 };
        proposed.resolution.sourceState = { artifact: 'verified', reason: 'verified', display: 'supported' };
        proposed.resolution.layout = { preferred: 'compact', aspectRatio: 1 };
        assert.equal(canonicalByteLength(proposed.materialization), expectedBytes); assert.ok(canonicalByteLength(proposed) <= 24576);
        const before = store.stats(); assert.deepEqual(store.commit(proposed), { state: 'capacity', reason: 'materialization-byte-cap' });
        assert.deepEqual(store.stats(), before); assert.equal(store.read(f.identity.ref.source).materialization, null);
      }
      await owner.dispose(); owner = null; const file = db.name; db.close();
      f.setNow(50000);
      if (expectedBytes === 8192) {
        f.native.data.item.result = ''; f.native.data.item.truncation = { result: { originalLength: 10000, retainedHeadLength: 0, retainedTailLength: 0, truncatedAt: 2000 } };
        f.verification.native.read = async () => { throw new Error('valid retained8192 binding must not reread native bytes'); };
        f.verification.currentHost.lookup = async () => { throw new Error('valid retained8192 binding must not relocate'); };
      }
      db = new Database(file); store = createImageObservationStore(db); owner = registered(f, store);
      const after = (await owner.client.resolve(input)).resolutions[0].value;
      assert.deepEqual(after.identity, first.identity); assert.deepEqual(after.outcomeEvidence, first.outcomeEvidence);
      assert.equal(after.availability.state, expectedBytes === 8192 ? 'available' : 'unavailable');
      if (expectedBytes !== 8192) assert.equal(after.availability.reason, 'materialization-byte-cap');
      assert.notEqual(after.availability.reason, 'invalid-materialization');
    } finally { if (owner) await owner.dispose(); if (db.open) db.close(); }
  }
});
