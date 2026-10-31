import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { canonicalJson } from '@phosphorco/bb-turn-results';
import { imageIdentity } from '../recognition.ts';
import { createImageObservationStore, ImageStoreError, IMAGE_STORE_LIMITS } from '../store.ts';
import type { ImageStoreEntry, ImageStoreOptions } from '../store.ts';

// Compile-time compatibility with the actual installed public storage handle.
const acceptsPublicDatabase: (db: ReturnType<BbPluginApi['storage']['database']>) => ReturnType<typeof createImageObservationStore> = createImageObservationStore;
void acceptsPublicDatabase;

if (process.versions.bun) {
  test('real installed SQLite persistence suite through Node (Bun addon unsupported)', { timeout: 60_000 }, () => {
    const result = spawnSync('node', ['--experimental-strip-types', '--test', fileURLToPath(import.meta.url)], { encoding: 'utf8', timeout: 60_000 });
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  });
} else {
  function fixture(t: { after(fn: () => void): void }, options: ImageStoreOptions = {}) {
    const directory = mkdtempSync(join(tmpdir(), 'image-store-'));
    const file = join(directory, 'observations.sqlite');
    const handles: Database.Database[] = [];
    function open() { const db = new Database(file); handles.push(db); return db; }
    const db = open();
    // Match the public host's initial defaults before our owned DB config.
    db.pragma('journal_mode = WAL'); db.pragma('busy_timeout = 5000');
    const store = createImageObservationStore(db, { epochFactory: () => 'test-epoch', ...options });
    t.after(() => { for (const handle of handles) if (handle.open) handle.close(); rmSync(directory, { recursive: true, force: true }); });
    return { db, store, open, file };
  }
  function entry(seq = 1, threadId = 'thread-a'): ImageStoreEntry {
    const source = { threadId, turnId: `turn-${seq}`, eventId: `event-${seq}`, seq, itemId: `image-${seq}`, eventType: 'item/completed' as const };
    const path = `/saved/image-${seq}.png`;
    const identity = imageIdentity(source, 'a'.repeat(64), path);
    const proof = { kind: 'native-image' as const, source, selectedDigest: identity.evidence.selectedDigest };
    return { history: { identity, proof, path, nativeCreatedAt: 100, providerSha256: null }, materialization: null,
      resolution: { identity, proof, revision: { epoch: 'ignored-proposal', sequence: 0 }, knowledge: 'confirmed',
        outcomeEvidence: { kind: 'observation', id: source.eventId, digest: identity.evidence.selectedDigest, recordedAt: 100 },
        availability: { state: 'unavailable', asOf: 200, expiresAt: null, reason: 'unverified' },
        route: { kind: 'source', threadId, eventId: source.eventId, seq },
        provenance: { originHost: { state: 'unknown', reason: 'not-recorded' }, artifactLocation: { state: 'unknown', reason: 'not-verified' } },
        fallback: { kind: 'image', title: 'Generated image', alt: 'A scene' }, spans: { width: 2, height: 2 } } };
  }
  function bound(original: ImageStoreEntry, hostId = 'host-one'): ImageStoreEntry {
    const e = structuredClone(original), digest = 'b'.repeat(64);
    e.history.providerSha256 = digest;
    e.history.proof.artifactDigest = digest;
    e.resolution.proof = structuredClone(e.history.proof);
    e.materialization = { schema: 1, identity: e.history.identity, proof: e.history.proof, providerSha256: digest,
      path: e.history.path, target: { kind: 'host', hostId, path: e.history.path }, nativeCreatedAt: 100,
      width: 64, height: 64, sizeBytes: 99, verifiedAt: 250 };
    e.resolution.availability = { state: 'available', asOf: 250, expiresAt: 300 };
    e.resolution.route = { kind: 'file', target: e.materialization.target };
    e.resolution.provenance.artifactLocation = { state: 'verified', target: e.materialization.target, observedAt: 250, basis: 'explicit-host-read', sha256: digest };
    return e;
  }
  function committed(store: ReturnType<typeof createImageObservationStore>, e: ImageStoreEntry) {
    const result = store.commit(e);
    assert.equal(result.state, 'committed', JSON.stringify(result));
    if (result.state !== 'committed') throw new Error('Expected commit.');
    return result.entry;
  }
  test('actual SQLite version, configured main pages/journal/busy timeout and host lifecycle', t => {
    const { db, store } = fixture(t);
    const sqliteVersion = (db.prepare('select sqlite_version() AS v').get() as { v: string }).v;
    assert.match(sqliteVersion, /^3\./);
    t.diagnostic(`Node ${process.versions.node}; SQLite ${sqliteVersion}; better-sqlite3 actual native addon`);
    assert.equal(db.pragma('journal_mode', { simple: true }), 'delete');
    assert.equal(db.pragma('busy_timeout', { simple: true }), 100);
    assert.equal(Number(db.pragma('max_page_count', { simple: true })) * Number(db.pragma('page_size', { simple: true })), 64 * 1024 * 1024);
    assert.equal(store.stats().rows, 0); assert.equal(db.open, true);
    assert.equal(store.read(entry().history.identity.ref.source), null);
  });
  test('reopen preserves sparse original history, epoch/head, full identity/time and clone isolation', t => {
    const { db, store, open } = fixture(t);
    const first = committed(store, entry());
    assert.deepEqual(first.resolution.revision, { epoch: 'test-epoch', sequence: 1 });
    db.close();
    const reopened = createImageObservationStore(open(), { epochFactory() { throw new Error('Must not create epoch again.'); } });
    assert.deepEqual(reopened.read(first.history.identity.ref.source), first);
    const copy = reopened.read(first.history.identity.ref.source)!;
    copy.history.path = '/edited';
    assert.equal(reopened.read(first.history.identity.ref.source)!.history.path, first.history.path);
    assert.equal(reopened.stats().head, 1); assert.equal(reopened.stats().epoch, 'test-epoch');
  });
  test('caller revision normalized; same semantics is unchanged with no access-order writes', t => {
    const { db, store } = fixture(t), e = committed(store, entry());
    const before = store.stats();
    e.resolution.revision = { epoch: 'some-other-source', sequence: 900 };
    assert.equal(store.commit(e).state, 'unchanged');
    store.read(e.history.identity.ref.source);
    assert.deepEqual(store.stats(), before);
    assert.equal((db.prepare('SELECT updated_sequence AS n FROM image_observation_records').get() as { n: number }).n, 1);
  });
  test('first admission requires actual completed native generation evidence and PNG header bounds', t => {
    const { store } = fixture(t);
    const proposals = [entry(), entry(), entry(), entry(), bound(entry())];
    proposals[0]!.resolution.knowledge = 'failed';
    proposals[1]!.resolution.outcomeEvidence!.kind = 'external-success';
    proposals[2]!.resolution.outcomeEvidence!.id = 'unrelated-event';
    proposals[3]!.resolution.outcomeEvidence!.digest = 'c'.repeat(64);
    proposals[4]!.materialization!.width = 0x80000000;
    for (const proposal of proposals) assert.equal(store.commit(proposal).state, 'conflict');
    assert.equal(store.stats().rows, 0); assert.equal(store.stats().head, 0);
    committed(store, entry());
  });
  test('same operation recovers availability, immutable materialization survives reopen and expiry', t => {
    const { store, db, open } = fixture(t);
    committed(store, entry());
    const verified = committed(store, bound(entry()));
    assert.equal(verified.resolution.revision.sequence, 2);
    db.close();
    const next = createImageObservationStore(open());
    const expired = next.read(verified.history.identity.ref.source)!;
    expired.resolution.availability = { state: 'unavailable', asOf: 400, expiresAt: null, reason: 'offline' };
    const saved = committed(next, expired);
    assert.deepEqual(saved.materialization, verified.materialization);
    assert.deepEqual(saved.resolution.outcomeEvidence, verified.resolution.outcomeEvidence);
    assert.equal(saved.history.nativeCreatedAt, 100);
    assert.equal(saved.resolution.revision.sequence, 3);
  });
  test('full source/identity/proof/time conflict cannot advance head or replace history', t => {
    const { store } = fixture(t), original = committed(store, entry());
    for (const change of [
      (e: ImageStoreEntry) => { e.history.identity.ref.source.turnId = 'foreign-turn'; },
      (e: ImageStoreEntry) => { e.history.identity.evidence.selectedDigest = 'c'.repeat(64); },
      (e: ImageStoreEntry) => { e.history.proof.selectedDigest = 'd'.repeat(64); },
      (e: ImageStoreEntry) => { e.history.nativeCreatedAt++; },
      (e: ImageStoreEntry) => { e.resolution.outcomeEvidence!.recordedAt++; },
      (e: ImageStoreEntry) => { e.resolution.outcomeEvidence!.digest = 'd'.repeat(64); },
      (e: ImageStoreEntry) => {
        const identity = imageIdentity(e.history.identity.ref.source, 'c'.repeat(64), e.history.path);
        e.history.identity = identity; e.resolution.identity = identity;
        e.history.proof.selectedDigest = identity.evidence.selectedDigest; e.resolution.proof = structuredClone(e.history.proof);
        e.resolution.outcomeEvidence!.digest = identity.evidence.selectedDigest;
      },
      (e: ImageStoreEntry) => { e.history.nativeCreatedAt++; e.resolution.outcomeEvidence!.recordedAt++; },
    ]) {
      const incoming = structuredClone(original); change(incoming);
      assert.equal(store.commit(incoming).state, 'conflict');
      assert.deepEqual(store.read(original.history.identity.ref.source), original);
      assert.equal(store.stats().head, 1);
    }
    const other = { ...original.history.identity.ref.source, seq: 999 };
    assert.throws(() => store.read(other), (e: unknown) => e instanceof ImageStoreError && e.code === 'invalid-entry');
  });
  test('two actual connections first binding race: loser, relocation/removal/digest change all conflict', t => {
    const { store, open } = fixture(t), second = createImageObservationStore(open());
    committed(store, entry());
    const winner = committed(store, bound(entry(), 'host-winner'));
    for (const proposal of [bound(entry(), 'host-loser'), entry(), (() => {
      const e = structuredClone(winner); e.materialization!.verifiedAt++; return e;
    })(), (() => { const e = structuredClone(winner); e.materialization!.target.path = '/elsewhere.png'; return e; })(), (() => {
      const e = structuredClone(winner), digest = 'c'.repeat(64);
      e.history.providerSha256 = digest; e.history.proof.artifactDigest = digest;
      e.resolution.proof = structuredClone(e.history.proof);
      e.materialization!.proof = structuredClone(e.history.proof); e.materialization!.providerSha256 = digest;
      if (e.resolution.provenance.artifactLocation.state === 'verified') e.resolution.provenance.artifactLocation.sha256 = digest;
      return e;
    })()]) {
      assert.equal(second.commit(proposal).state, 'conflict');
      assert.deepEqual(second.read(winner.history.identity.ref.source), winner);
    }
    assert.equal(second.stats().head, 2);
  });
  test('deterministic per-thread and global oldest-commit eviction; read does not refresh order', t => {
    const { store } = fixture(t, { maxRows: 3, maxRowsPerThread: 2 });
    committed(store, entry(1)); committed(store, entry(2));
    store.read(entry(1).history.identity.ref.source);
    committed(store, entry(3));
    assert.equal(store.read(entry(1).history.identity.ref.source), null);
    committed(store, entry(4, 'thread-b')); committed(store, entry(5, 'thread-c'));
    assert.equal(store.read(entry(2).history.identity.ref.source), null);
    assert.equal(store.stats().rows, 3); assert.equal(store.stats().evicted, 2); assert.equal(store.stats().head, 5);
  });
  test('changed record becomes newest; unchanged snapshot keeps its order', t => {
    const { store } = fixture(t, { maxRows: 2 });
    const first = committed(store, entry(1)); committed(store, entry(2));
    first.resolution.availability.asOf++;
    committed(store, first);
    assert.equal(store.commit(entry(2)).state, 'unchanged');
    committed(store, entry(3));
    assert.ok(store.read(entry(1).history.identity.ref.source));
    assert.equal(store.read(entry(2).history.identity.ref.source), null);
  });
  test('logical byte accounting and eviction, oversized row and named key admission', t => {
    const one = entry(1);
    const { store, db } = fixture(t, { maxLogicalBytes: 4000 });
    committed(store, one); committed(store, entry(2));
    const stats = store.stats();
    assert.ok(stats.logicalBytes <= 4000); assert.ok(stats.evicted >= 1);
    assert.equal(stats.logicalBytes, (db.prepare('SELECT sum(payload_bytes) AS n FROM image_observation_records').get() as { n: number }).n);
    const huge = entry(3); (huge as unknown as { extra: string }).extra = 'x'.repeat(24_576);
    assert.deepEqual(store.commit(huge), { state: 'capacity', reason: 'row-byte-cap' });
    const long = entry(4, 't'.repeat(256));
    long.history.identity.ref.source.eventId = 'e'.repeat(256);
    // Invalid identity is explicit, never silently acknowledged or truncated.
    assert.equal(store.commit(long).state, 'conflict');
    assert.equal(store.stats().head, 2);
  });
  test('maximal valid source names retained exactly; identifier overflow is explicit', t => {
    const { store } = fixture(t);
    const e = entry(1, 't'.repeat(256));
    const source = { ...e.history.identity.ref.source, eventId: 'e'.repeat(256) };
    e.history.identity = imageIdentity(source, 'a'.repeat(64), e.history.path);
    e.history.proof.source = source; e.resolution.identity = e.history.identity;
    e.resolution.proof = e.history.proof; e.resolution.outcomeEvidence!.id = source.eventId;
    e.resolution.route = { kind: 'source', threadId: source.threadId, eventId: source.eventId, seq: source.seq };
    const saved = committed(store, e);
    assert.deepEqual(store.read(source), saved);
    const oversized = structuredClone(e); oversized.history.identity.ref.source.eventId = 'e'.repeat(257);
    assert.equal(store.commit(oversized).state, 'conflict'); assert.equal(store.stats().head, 1);
  });
  test('32 eviction limit rolls back all early evictions and metadata', t => {
    const { store, open } = fixture(t);
    for (let i = 1; i <= 35; i++) committed(store, entry(i, `thread-${i}`));
    const before = store.stats();
    const constrained = createImageObservationStore(open(), { maxRows: 1 });
    assert.deepEqual(constrained.commit(entry(36, 'thread-36')), { state: 'capacity', reason: 'eviction-write-cap' });
    assert.deepEqual(store.stats(), before);
    for (let i = 1; i <= 35; i++) assert.ok(store.read(entry(i, `thread-${i}`).history.identity.ref.source));
    assert.equal(store.read(entry(36, 'thread-36').history.identity.ref.source), null);
  });
  test('transaction failure after eviction rolls back record, head, evicted and logical counters', t => {
    const { store, db } = fixture(t, { maxRows: 1 });
    const first = committed(store, entry(1)), before = store.stats();
    db.exec("CREATE TRIGGER forced_failure BEFORE UPDATE ON image_observation_meta BEGIN SELECT RAISE(ABORT,'test fault'); END;");
    assert.throws(() => store.commit(entry(2)), (e: unknown) => e instanceof ImageStoreError && e.code === 'database');
    assert.deepEqual(store.stats(), before); assert.deepEqual(store.read(first.history.identity.ref.source), first);
    assert.equal(store.read(entry(2).history.identity.ref.source), null);
  });
  test('real SQLITE_FULL enforces physical pages with atomic rollback', t => {
    const { store, db } = fixture(t, { maxPhysicalBytes: 48 * 1024 });
    let count = 0, capacity = false;
    for (let i = 1; i <= 50; i++) {
      const before = store.stats(), result = store.commit(entry(i));
      if (result.state === 'capacity') {
        assert.equal(result.reason, 'physical-page-cap');
        assert.deepEqual(store.stats(), before); capacity = true; break;
      }
      assert.equal(result.state, 'committed'); count++;
    }
    assert.ok(capacity); assert.ok(count > 0);
    assert.ok(store.stats().physicalBytes <= 48 * 1024);
    assert.equal((db.prepare('SELECT count(*) AS n FROM image_observation_records').get() as { n: number }).n, count);
  });
  test('busy lock returns bounded explicit capacity without retry', t => {
    const { store, open } = fixture(t, { busyTimeoutMs: 5 }), locker = open();
    locker.exec('BEGIN IMMEDIATE');
    try {
      assert.deepEqual(store.commit(entry()), { state: 'capacity', reason: 'database-busy' });
      assert.equal(store.stats().head, 0);
    } finally { locker.exec('ROLLBACK'); }
  });
  test('corrupt rows explicit on read AND eviction; no silent discard', t => {
    const { store, db } = fixture(t, { maxRows: 1 });
    committed(store, entry());
    for (const payload of ['{bad', ' '.repeat(24_577), canonicalJson({ prompt: 'not a history' })]) {
      db.prepare('UPDATE image_observation_records SET payload_json=?').run(payload);
      assert.throws(() => store.read(entry().history.identity.ref.source), (e: unknown) => e instanceof ImageStoreError && e.code === 'corrupt');
      assert.throws(() => store.commit(entry(2)), (e: unknown) => e instanceof ImageStoreError && e.code === 'corrupt');
      assert.equal(store.stats().head, 1); assert.equal(store.stats().evicted, 0);
    }
  });
  test('future schema and corrupt metadata explicit, no migration or deletion', t => {
    const { db, open, store } = fixture(t);
    committed(store, entry());
    db.exec('UPDATE image_observation_meta SET schema_version=2');
    assert.throws(() => createImageObservationStore(open()), (e: unknown) => e instanceof ImageStoreError && e.code === 'schema');
    db.exec('UPDATE image_observation_meta SET schema_version=1,head=-1');
    assert.throws(() => store.stats(), (e: unknown) => e instanceof ImageStoreError && e.code === 'corrupt');
    assert.equal((db.prepare('SELECT count(*) AS n FROM image_observation_records').get() as { n: number }).n, 1);
  });
  test('strict bounded plain JSON rejects getters/bytes/unknown fields before access', t => {
    const { store } = fixture(t);
    const value = entry(); let accessed = false;
    Object.defineProperty(value, 'prompt', { enumerable: true, get() { accessed = true; throw new Error('must not access'); } });
    assert.equal(store.commit(value).state, 'conflict'); assert.equal(accessed, false);
    const other = entry(); (other.history as unknown as { base64: string }).base64 = 'AAAA';
    assert.equal(store.commit(other).state, 'conflict');
    const nested = entry(); nested.resolution.sourceState = { prompt: 'must not persist' };
    assert.equal(store.commit(nested).state, 'conflict');
    const encoded = entry(); encoded.resolution.sourceState = { retained: 'data:image/png;base64,AAAA' };
    assert.equal(store.commit(encoded).state, 'conflict');
    assert.equal(store.stats().rows, 0);
  });
  test('exact 32 evictions succeed atomically; default per-thread128 is enforced', t => {
    const { store, open } = fixture(t);
    for (let i = 1; i <= 33; i++) committed(store, entry(i, `thread-${i}`));
    const lower = createImageObservationStore(open(), { maxRows: 2 });
    committed(lower, entry(34, 'thread-34'));
    assert.equal(lower.stats().evicted, 32); assert.equal(lower.stats().rows, 2); assert.equal(lower.stats().head, 34);
    const other = fixture(t);
    for (let i = 1; i <= 129; i++) committed(other.store, entry(i));
    assert.equal(other.store.stats().rows, 128); assert.equal(other.store.stats().evicted, 1);
    assert.equal(other.store.read(entry(1).history.identity.ref.source), null);
  });
  test('options are lower-only; counter exhaustion explicit; too-small logical cap rolls back', t => {
    const { db, open } = fixture(t);
    assert.throws(() => createImageObservationStore(open(), { maxRows: IMAGE_STORE_LIMITS.maxRows + 1 }), RangeError);
    const tiny = createImageObservationStore(open(), { maxLogicalBytes: 1 });
    assert.equal(tiny.commit(entry()).state, 'capacity'); assert.equal(tiny.stats().head, 0);
    db.prepare('UPDATE image_observation_meta SET head=?').run(Number.MAX_SAFE_INTEGER);
    assert.deepEqual(tiny.commit(entry()), { state: 'capacity', reason: 'revision-head-exhausted' });
    assert.equal(tiny.stats().rows, 0);
  });
}
