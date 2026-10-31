import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { canonicalJson, canonicalByteLength, claimKey } from '@phosphorco/bb-turn-results';
import type { Resolution, ResultIdentity } from '@phosphorco/bb-turn-results';
import { createGalleryIndex, GALLERY_INDEX_LIMITS, GalleryIndexError } from '../gallery/index.ts';
import type { GalleryPage, GalleryIndexOptions, IndexCommit, StageValue } from '../gallery/index.ts';

// Compile against the actual public SDK handle; no copied storage facade.
const acceptsPublicDatabase: (db: ReturnType<BbPluginApi['storage']['database']>) => ReturnType<typeof createGalleryIndex> = createGalleryIndex;
void acceptsPublicDatabase;

if (process.versions.bun) {
  test('gallery persistence through real Node SQLite addon (Bun wrapper)', { timeout: 120_000 }, () => {
    const result = spawnSync('node', ['--experimental-strip-types', '--test', fileURLToPath(import.meta.url)], { encoding: 'utf8', timeout: 120_000 });
    process.stdout.write(result.stdout); process.stderr.write(result.stderr);
    assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  });
} else {
  const owner = 'image-source';
  const connected = { revision: 'descriptor-1', connection: 'connected' as const, freshUntil: 1000 };
  const stage = (cursor = 'next', debt: StageValue['debt'] = null): StageValue => ({ stage: 'feed', cursor, status: 'ready', debt });
  function fixture(t: { after(fn: () => void): void }, options: GalleryIndexOptions = {}) {
    const directory = mkdtempSync(join(tmpdir(), 'gallery-index-')), file = join(directory, 'gallery.sqlite');
    const handles: Database.Database[] = [];
    const open = () => { const db = new Database(file); handles.push(db); return db; };
    const db = open(); db.pragma('journal_mode = WAL');
    const index = createGalleryIndex(db, options);
    t.after(() => { for (const handle of handles) if (handle.open) handle.close(); rmSync(directory, { recursive: true, force: true }); });
    return { db, index, file, open };
  }
  function identity(seq = 1, threadId = 'thread-a', turnId = `turn-${seq}`): ResultIdentity {
    return { version: 1, ref: { source: { threadId, turnId, eventId: `event-${seq}`, seq, itemId: `item-${seq}`, eventType: 'item/completed' }, member: 'image:0', kind: 'image-source/generated-image' },
      artifact: { provider: 'image-source', id: `image-${seq}`, kind: 'image' }, specificity: 'typed',
      evidence: { basis: 'native-completion', sites: [], targetUrls: [], selectedDigest: 'a'.repeat(64) }, lookup: { path: `/images/${seq}.png` } };
  }
  function result(seq = 1, threadId = 'thread-a', turnId?: string): Resolution {
    const i = identity(seq, threadId, turnId);
    return { identity: i, proof: { kind: 'native-image', source: i.ref.source, selectedDigest: i.evidence.selectedDigest },
      revision: { epoch: 'source-epoch', sequence: 1 }, knowledge: 'confirmed',
      outcomeEvidence: { kind: 'observation', id: `image-${seq}`, digest: 'b'.repeat(64), recordedAt: 100 },
      availability: { state: 'available', asOf: 100, expiresAt: 500 },
      route: { kind: 'file', target: { kind: 'host', hostId: 'source-host', path: `/images/${seq}.png` } },
      provenance: { originHost: { state: 'unknown', reason: 'not-recorded' }, artifactLocation: { state: 'verified', target: { kind: 'host', hostId: 'source-host', path: `/images/${seq}.png` }, observedAt: 100, basis: 'explicit-host-read' } },
      fallback: { kind: 'image', title: 'Generated image', alt: 'A scene' }, spans: { width: 2, height: 2 } };
  }
  function page(values = [result()], more: Partial<GalleryPage> = {}): GalleryPage {
    return { owner, threadId: values[0]?.identity.ref.source.threadId ?? 'thread-a', changes: values.map(value => ({ kind: 'upsert', value })), supplier: connected, ...more };
  }
  function ok(value: IndexCommit) {
    assert.ok(value.state === 'committed' || value.state === 'unchanged', JSON.stringify(value));
    if (value.state !== 'committed' && value.state !== 'unchanged') throw new Error('Expected commit.');
    assert.ok(value.mutations <= 40); assert.ok(value.changedBytes <= 1048576);
    return value;
  }
  function read(index: ReturnType<typeof createGalleryIndex>, now = 200) { return index.readThread('thread-a', { now }).rows; }
  function sqlSnapshot(db: Database.Database) { return canonicalJson({ records: db.prepare('SELECT * FROM gallery_records ORDER BY kind,record_key').all(), meta: db.prepare('SELECT * FROM gallery_meta').all() }, 1048576); }

  test('actual SQLite configuration, finite physical bound and public handle lifecycle', t => {
    const { db, index, file } = fixture(t);
    const version = (db.prepare('select sqlite_version() AS v').get() as { v: string }).v;
    t.diagnostic(`Node ${process.versions.node}; native better-sqlite3; SQLite ${version}; initial main ${statSync(file).size} bytes`);
    assert.match(version, /^3\./); assert.equal(db.pragma('journal_mode', { simple: true }), 'delete');
    assert.equal(db.pragma('page_size', { simple: true }), 4096); assert.equal(db.pragma('busy_timeout', { simple: true }), 100);
    assert.equal(db.pragma('temp_store', { simple: true }), 2);
    assert.equal(Number(db.pragma('max_page_count', { simple: true })) * 4096, GALLERY_INDEX_LIMITS.maxPhysicalBytes);
    assert.equal(index.stats().logicalBytes, 1024); assert.equal(index.stats().metadataBytes, 1024);
    assert.ok(index.stats().journalReserveBytes > GALLERY_INDEX_LIMITS.maxPhysicalBytes);
    assert.equal(existsSync(`${file}-wal`), false); assert.equal(db.open, true);
    assert.deepEqual(index.coverage('not-indexed'), { state: 'unindexed', intervals: [] });
  });

  test('feed-only bootstrap keeps full immutable identity/proof, lookup and original turn across reopen', t => {
    const { db, index, open } = fixture(t), r = result(80, 'thread-a', 'original-turn');
    r.identity = { ...r.identity, ref: { ...r.identity.ref, member: 'message-group:receipt-1', kind: 'rosetta-slack/message-sent' },
      artifact: { provider: 'rosetta-slack.delivery', id: 'group-1', kind: 'message' },
      evidence: { ...r.identity.evidence, basis: 'typed-receipt' },
      equivalence: { namespace: 'rosetta-slack.operation', operationId: 'group-1', member: 'message-group' }, lookup: { operationGroupId: 'group-1', originReceiptId: 'receipt-1' } };
    r.proof = { kind: 'initial-operation', source: r.identity.ref.source, receiptId: 'receipt-1', receiptDigest: 'c'.repeat(64), operationId: 'group-1', binderVersion: 'slack-binder/1', tool: { pluginId: 'rosetta-slack', name: 'send_slack_message' } };
    r.outcomeEvidence = { kind: 'external-success', id: 'group-1:done', digest: 'd'.repeat(64), recordedAt: 200 };
    r.route = { kind: 'url', href: 'https://example.slack.com/archives/C123/p123000001' };
    ok(index.applyPage(page([r], { owner: 'rosetta-slack', stage: { id: 'feed', expectedVersion: null, value: stage('after-H') } })));
    const before = index.readTurn('thread-a', 'original-turn', { now: 200 });
    assert.equal(before.rows.length, 1); assert.deepEqual(before.rows[0]!.resolution, r);
    const stored = db.prepare("SELECT payload_json FROM gallery_records WHERE kind='claim'").get() as { payload_json: string };
    assert.equal((stored.payload_json.match(/"identity"/gu) ?? []).length, 1);
    assert.equal((stored.payload_json.match(/"source"/gu) ?? []).length, 1);
    db.close(); const reopened = createGalleryIndex(open());
    assert.deepEqual(reopened.readTurn('thread-a', 'original-turn', { now: 200 }), before);
    assert.equal(reopened.readStage('thread-a', 'rosetta-slack', 'feed')!.value.cursor, 'after-H');
    // Recognition after a feed bootstrap merges once, retaining complete identity.
    ok(reopened.applyPage({ owner: 'rosetta-slack', threadId: 'thread-a', changes: [{ kind: 'candidate', identity: r.identity }] }));
    assert.equal(read(reopened).length, 1);
    const changed = structuredClone(r); changed.identity.lookup = { operationGroupId: 'different' };
    assert.equal(reopened.applyPage(page([changed], { owner: 'rosetta-slack' })).state, 'conflict');
    const copy = read(reopened)[0]!; copy.identity.artifact.id = 'edited';
    assert.equal(read(reopened)[0]!.identity.artifact.id, 'group-1');
  });

  test('recognition, unresolved identity and caller CAS stage debt commit together', t => {
    const { index, open, db } = fixture(t), identities = [identity(1), identity(2), identity(3)];
    const debt = { groups: [[claimKey(owner, identities[0]!.ref)], [claimKey(owner, identities[1]!.ref), claimKey(owner, identities[2]!.ref)]], reason: 'budget-deferred' };
    ok(index.applyPage({ owner, threadId: 'thread-a', changes: identities.map(i => ({ kind: 'candidate', identity: i })), stage: { id: 'recognize', expectedVersion: null, value: { ...stage('recognition-next', debt), stage: 'resolve' } } }));
    assert.equal(read(index).filter(r => r.unresolved && r.resolution === null).length, 3);
    const before = sqlSnapshot(db);
    assert.equal(index.applyPage(page([result()], { stage: { id: 'recognize', expectedVersion: null, value: stage('must-not-advance') } })).state, 'conflict');
    assert.equal(sqlSnapshot(db), before);
    // Healthy outcomes applied; deferred identities remain in canonical rows and
    // bounded persisted caller debt after loss of the response/reopen.
    ok(index.applyPage(page([result()], { stage: { id: 'recognize', expectedVersion: 1, value: { stage: 'resolve', cursor: null, status: 'ready', debt: { groups: debt.groups.slice(1) } } } })));
    db.close(); const reopened = createGalleryIndex(open());
    assert.equal(read(reopened).filter(r => r.unresolved).length, 2);
    assert.deepEqual(reopened.readStage('thread-a', owner, 'recognize')!.value.debt, { groups: debt.groups.slice(1) });
    assert.equal(reopened.listStages('thread-a').rows[0]!.record.version, 2);
  });

  test('full 4096-byte identity remains resolvable and immutable after reopen without a source reader', t => {
    const { index, db, open } = fixture(t), r = result();
    const base = canonicalByteLength(r.identity), prefix = 'https://example.test/';
    r.identity.evidence.targetUrls = [prefix + 'x'.repeat(4096 - base - prefix.length - 2)];
    assert.equal(canonicalByteLength(r.identity), 4096);
    ok(index.applyPage({ owner, threadId: 'thread-a', changes: [{ kind: 'candidate', identity: r.identity }], supplier: connected }));
    db.close(); const reopened = createGalleryIndex(open());
    assert.deepEqual(read(reopened)[0]!.identity, r.identity);
    ok(reopened.applyPage(page([r]))); assert.deepEqual(read(reopened)[0]!.resolution, r);
  });

  test('stale/conflicting snapshots, identity conflicts and terminal corrections use reviewed root rules', t => {
    const { index, db } = fixture(t), original = result(); ok(index.applyPage(page([original])));
    const before = sqlSnapshot(db), changed = structuredClone(original);
    changed.fallback.title = 'Different same revision';
    assert.equal(index.applyPage(page([changed])).state, 'conflict'); assert.equal(sqlSnapshot(db), before);
    changed.revision.sequence = 0;
    ok(index.applyPage(page([changed]))); assert.equal(sqlSnapshot(db), before);
    changed.revision.sequence = 2; changed.knowledge = 'failed';
    changed.outcomeEvidence = { kind: 'definite-failure', id: 'corrected', digest: 'c'.repeat(64), recordedAt: 300 };
    assert.equal(index.applyPage(page([changed])).state, 'conflict');
    changed.correction = { supersedesEvidenceDigest: original.outcomeEvidence!.digest, reason: 'Original assertion incorrect' };
    ok(index.applyPage(page([changed])));
    assert.deepEqual(read(index)[0]!.corrections, [original.outcomeEvidence]);
    const conflict = structuredClone(changed); conflict.revision = { epoch: 'source-reset', sequence: 0 };
    conflict.knowledge = 'pending'; conflict.outcomeEvidence = null; delete conflict.correction;
    assert.equal(index.applyPage(page([conflict])).state, 'revalidate');
    assert.equal(read(index)[0]!.resolution!.knowledge, 'failed');
    conflict.knowledge = changed.knowledge; conflict.outcomeEvidence = changed.outcomeEvidence;
    ok(index.applyPage(page([conflict]))); assert.equal(read(index)[0]!.resolution!.revision.epoch, 'source-reset');
  });

  test('unknown -> pending regression rejected, expiry/disconnection never erases outcome facts', t => {
    const { index } = fixture(t), r = result(); r.knowledge = 'unknown'; r.outcomeEvidence = null;
    ok(index.applyPage(page([r])));
    const retry = structuredClone(r); retry.knowledge = 'pending'; retry.revision.sequence = 2;
    assert.equal(index.applyPage(page([retry])).state, 'conflict');
    const done = result(); done.revision.sequence = 3; ok(index.applyPage(page([done])));
    assert.equal(read(index, 200)[0]!.freshness, 'fresh'); assert.equal(read(index, 500)[0]!.currentAvailability!.state, 'unknown');
    assert.equal(read(index, 500)[0]!.resolution!.availability.state, 'available');
    ok(index.applyPage(page([], { supplier: { ...connected, connection: 'disconnected' } })));
    assert.equal(read(index)[0]!.freshness, 'disconnected'); assert.equal(read(index)[0]!.resolution!.knowledge, 'confirmed');
    ok(index.applyPage(page([], { supplier: { ...connected, revision: 'descriptor-2' } })));
    assert.equal(read(index)[0]!.freshness, 'stale');
    // Successful same-resource authoritative read clears staleness even unchanged.
    ok(index.applyPage(page([done], { supplier: { ...connected, revision: 'descriptor-2' } })));
    assert.equal(read(index)[0]!.freshness, 'fresh');
    ok(index.applyPage({ owner, threadId: 'thread-a', changes: [{ kind: 'source-expired', ref: done.identity.ref, revision: { epoch: 'source-epoch', sequence: 4 } }] }));
    assert.equal(read(index)[0]!.currentAvailability!.state, 'unknown'); assert.equal(read(index)[0]!.resolution!.knowledge, 'confirmed');
    assert.deepEqual(read(index)[0]!.resolution!.outcomeEvidence, done.outcomeEvidence);
    ok(index.applyPage(page([done]))); assert.ok(read(index)[0]!.sourceExpired);
    const fresh = structuredClone(done); fresh.revision.sequence = 5; ok(index.applyPage(page([fresh])));
    assert.equal(read(index)[0]!.sourceExpired, null);
  });

  test('owner-bound retraction, unknown expiry coverage and no fabricated tile', t => {
    const { index } = fixture(t), r = result(); ok(index.applyPage(page([r])));
    ok(index.applyPage({ owner: 'other-owner', threadId: 'thread-a', changes: [{ kind: 'source-expired', ref: r.identity.ref, revision: { epoch: 'other', sequence: 2 } }] }));
    assert.equal(read(index).length, 1); assert.equal(read(index)[0]!.sourceExpired, null);
    assert.equal(index.coverage('thread-a').intervals[0]!.state, 'unplaced');
    const retraction = { kind: 'retract' as const, ref: r.identity.ref, revision: { epoch: 'source-epoch', sequence: 2 }, supersedesEvidenceDigest: 'c'.repeat(64), reason: 'Retracted' };
    assert.equal(index.applyPage({ owner, threadId: 'thread-a', changes: [retraction] }).state, 'conflict');
    retraction.supersedesEvidenceDigest = r.outcomeEvidence!.digest;
    ok(index.applyPage({ owner, threadId: 'thread-a', changes: [retraction] }));
    assert.ok(read(index)[0]!.retracted); assert.deepEqual(read(index)[0]!.resolution!.outcomeEvidence, r.outcomeEvidence);
    ok(index.applyPage({ owner, threadId: 'thread-a', changes: [retraction] }));
    const later = structuredClone(r); later.revision.sequence = 3;
    assert.equal(index.applyPage(page([later])).state, 'conflict');
    later.correction = { supersedesEvidenceDigest: r.outcomeEvidence!.digest, reason: 'Retraction corrected' };
    ok(index.applyPage(page([later]))); assert.equal(read(index)[0]!.retracted, null);
  });

  test('source epoch reset marks sibling rows stale, same outcome can revalidate, retired epoch replay parks', t => {
    const { index, db, open } = fixture(t), first = result(1), sibling = result(2);
    ok(index.applyPage(page([first, sibling])));
    const next = structuredClone(first); next.revision = { epoch: 'new-journal', sequence: 0 };
    ok(index.applyPage(page([next])));
    assert.equal(read(index)[0]!.freshness, 'fresh'); assert.equal(read(index)[1]!.freshness, 'stale');
    assert.equal(read(index)[1]!.resolution!.knowledge, 'confirmed');
    db.close(); const reopened = createGalleryIndex(open());
    assert.equal(read(reopened)[1]!.freshness, 'stale');
    assert.equal(reopened.applyPage(page([first])).state, 'revalidate');
    const revalidated = structuredClone(sibling); revalidated.revision = { epoch: 'new-journal', sequence: 1 };
    ok(reopened.applyPage(page([revalidated]))); assert.equal(read(reopened)[1]!.freshness, 'fresh');
    ok(reopened.applyPage(page([], { supplier: { ...connected, epoch: 'next-reset' } })));
    assert.equal(read(reopened).filter(v => v.freshness === 'stale').length, 2);
  });

  test('completed stage CAS retirement and whole-thread index eviction reclaim metadata without ABA', t => {
    const { index } = fixture(t, { maxThreads: 1, maxStagesPerThread: 1 });
    const first = ok(index.applyPage(page([], { stage: { id: 'unit', expectedVersion: null, value: stage() } })));
    assert.equal(index.retireStage('thread-a', owner, 'unit', first.stageVersion!).state, 'conflict');
    const completed = ok(index.applyPage(page([], { stage: { id: 'unit', expectedVersion: first.stageVersion, value: { ...stage(), status: 'complete' } } })));
    assert.equal(index.retireStage('thread-a', owner, 'unit', first.stageVersion!).state, 'conflict');
    ok(index.retireStage('thread-a', owner, 'unit', completed.stageVersion!)); assert.equal(index.stats().stages, 0);
    const recreated = ok(index.applyPage(page([], { stage: { id: 'unit', expectedVersion: null, value: stage('new-generation') } })));
    assert.ok(recreated.stageVersion! > completed.stageVersion!);
    assert.equal(index.applyPage(page([], { stage: { id: 'unit', expectedVersion: first.stageVersion, value: stage('stale-response') } })).state, 'conflict');
    ok(index.applyPage(page([result()])));
    ok(index.evictThread('thread-a', 1)); assert.equal(index.coverage('thread-a').state, 'partial'); assert.equal(read(index).length, 0);
    assert.equal(index.applyPage(page()).state, 'conflict');
    for (let n = 0; n < 8 && index.stats().threads; n++) ok(index.evictThread('thread-a', 1));
    assert.equal(index.coverage('thread-a').state, 'unindexed'); assert.equal(index.stats().metadataBytes, 1024);
    ok(index.applyPage(page([result(1, 'thread-b')])));
  });

  test('explicit oversized skip coverage and next cursor are atomic; correction history finite', t => {
    const { index, db } = fixture(t);
    ok(index.applyPage(page([], { stage: { id: 'feed', expectedVersion: null, value: stage('before-gap') } })));
    const before = sqlSnapshot(db);
    assert.equal(index.applyPage(page([], { stage: { id: 'feed', expectedVersion: 0, value: stage('after-gap') }, coverage: [{ fromSeq: 9, throughSeq: 9, owner, state: 'oversized', reason: 'record-byte-cap' }] })).state, 'conflict');
    assert.equal(sqlSnapshot(db), before);
    ok(index.applyPage(page([], { stage: { id: 'feed', expectedVersion: 1, value: stage('after-gap') }, coverage: [{ fromSeq: 9, throughSeq: 9, owner, state: 'oversized', reason: 'record-byte-cap' }] })));
    assert.equal(index.readStage('thread-a', owner, 'feed')!.value.cursor, 'after-gap'); assert.equal(index.coverage('thread-a').intervals[0]!.state, 'oversized');
    let r = result(); ok(index.applyPage(page([r])));
    let successful = 0;
    for (let n = 0; n < 40; n++) {
      const next = structuredClone(r); next.revision.sequence++; next.outcomeEvidence!.id = `corrected-${n}`;
      next.outcomeEvidence!.digest = (n + 10).toString(16).padStart(64, '0');
      next.correction = { supersedesEvidenceDigest: r.outcomeEvidence!.digest, reason: 'Correction' };
      const outcome = index.applyPage(page([next]));
      if (outcome.state === 'capacity') break;
      ok(outcome); r = next; successful++;
    }
    assert.ok(successful > 0 && successful <= 32); assert.equal(read(index)[0]!.corrections.length, successful);
    assert.deepEqual(read(index)[0]!.resolution!.outcomeEvidence, r.outcomeEvidence);
  });

  test('page maximum eight, all metadata counted, oversized rows and transcripts never acknowledged', t => {
    const { index, db } = fixture(t), values = Array.from({ length: 8 }, (_, n) => result(n + 1));
    const applied = ok(index.applyPage(page(values, { stage: { id: 'feed', expectedVersion: null, value: stage() }, coverage: [{ fromSeq: 1, throughSeq: 8, state: 'indexed', owner }] })));
    assert.equal(applied.mutations, 12); assert.equal(index.stats().observations, 8);
    const before = sqlSnapshot(db);
    const rejected = index.applyPage(page(Array.from({ length: 64 }, (_, n) => result(n + 100))));
    assert.equal(rejected.state, 'conflict'); assert.equal(sqlSnapshot(db), before);
    const oversized = result(9); oversized.fallback = { kind: 'card', title: 'X', fields: Array.from({ length: 8 }, () => ({ label: 'x'.repeat(64), value: 'v'.repeat(512) })) };
    oversized.presentation = { schema: 'image-source/rich-card@1', data: { detail: 'p'.repeat(3500) } };
    assert.equal(index.applyPage(page([oversized], { stage: { id: 'feed', expectedVersion: 1, value: stage('must-not-skip') } })).state, 'capacity');
    assert.equal(index.readStage('thread-a', owner, 'feed')!.value.cursor, 'next');
    assert.equal(index.applyPage(page([], { stage: { id: 'danger', expectedVersion: null, value: stage('x', { transcript: 'Do not store me' }) } })).state, 'conflict');
    assert.equal(sqlSnapshot(db), before);
    const ephemeral = result(10); ephemeral.fallback = { kind: 'image', title: 'Image', alt: 'A', media: { href: 'https://lease.example/token', expiresAt: 999 } };
    ok(index.applyPage(page([ephemeral])));
    assert.ok(!sqlSnapshot(db).includes('lease.example'));
  });

  test('capacity refuses entire page and cursor, explicit bounded eviction then admission', t => {
    const { index, db, open } = fixture(t, { maxObservations: 8, maxObservationsPerThread: 8 });
    ok(index.applyPage(page(Array.from({ length: 8 }, (_, n) => result(n + 1)), { stage: { id: 'feed', expectedVersion: null, value: stage('page-1') } })));
    const before = sqlSnapshot(db);
    assert.equal(index.applyPage(page([result(9)], { stage: { id: 'feed', expectedVersion: 1, value: stage('page-2') } })).state, 'capacity');
    assert.equal(sqlSnapshot(db), before);
    // Reads never change eviction order.
    read(index); index.readTurn('thread-a', 'turn-1', { now: 200 });
    assert.equal(sqlSnapshot(db), before);
    const evicted = ok(index.evict({ threadId: 'thread-a', limit: 1 })); assert.equal(evicted.mutations, 3);
    assert.equal(index.readStage('thread-a', owner, 'feed')!.value.cursor, 'page-1');
    assert.equal(read(index)[0]!.identity.ref.source.seq, 2);
    assert.equal(index.coverage('thread-a').intervals[0]!.state, 'evicted');
    ok(index.applyPage(page([result(9)], { stage: { id: 'feed', expectedVersion: 1, value: stage('page-2') } })));
    db.close(); const reopened = createGalleryIndex(open(), { maxObservations: 8 });
    assert.equal(reopened.stats().observations, 8); assert.equal(reopened.stats().evicted, 1);
    assert.equal(reopened.applyPage(page([result(1)])).state, 'capacity');
    ok(reopened.evict({ limit: 1 })); ok(reopened.applyPage(page([result(1)], { allowReindex: true })));
    assert.equal(reopened.stats().observations, 8);
  });

  test('finite logical, metadata, thread, supplier and debt capacity with zero-result/revision churn', t => {
    const { index } = fixture(t, { maxThreads: 2, maxStages: 2, maxStagesPerThread: 1, maxSuppliers: 2, maxSuppliersPerThread: 1, maxMetadataBytes: 8192 });
    ok(index.applyPage(page([], { stage: { id: 'feed', expectedVersion: null, value: stage() } })));
    assert.equal(index.applyPage(page([], { stage: { id: 'second', expectedVersion: null, value: stage() } })).state, 'capacity');
    assert.equal(index.applyPage(page([], { owner: 'another-owner' })).state, 'capacity');
    for (let n = 2; n < 300; n++) ok(index.applyPage(page([], { supplier: { ...connected, revision: `revision-${n}` }, coverage: [{ fromSeq: n, throughSeq: n, state: 'indexed' }] })));
    assert.equal(index.stats().suppliers, 1); assert.equal(index.stats().stages, 1); assert.ok(index.stats().metadataBytes < 8192);
    assert.deepEqual(index.coverage('thread-a').intervals, [{ fromSeq: 2, throughSeq: 299, state: 'indexed' }]);
    ok(index.applyPage(page([], { threadId: 'thread-b' })));
    assert.equal(index.applyPage(page([], { threadId: 'thread-c' })).state, 'capacity');
    const small = fixture(t, { maxLogicalBytes: 1500 });
    assert.equal(small.index.applyPage(page()).state, 'capacity'); assert.equal(small.index.stats().observations, 0);
  });

  test('coverage coalesces only adjacent equal intervals and pressure widens to unknown', t => {
    const { index } = fixture(t);
    ok(index.applyPage(page([], { coverage: [{ fromSeq: 1, throughSeq: 3, state: 'indexed' }, { fromSeq: 5, throughSeq: 6, state: 'indexed' }, { fromSeq: 7, throughSeq: 9, state: 'unsupported', owner }] })));
    assert.equal(index.coverage('thread-a').intervals.filter(v => v.state === 'indexed').length, 2);
    for (let n = 10; n < 280; n += 2) ok(index.applyPage(page([], { coverage: [{ fromSeq: n, throughSeq: n, state: 'indexed' }] })));
    const intervals = index.coverage('thread-a').intervals;
    assert.ok(intervals.length <= 128); assert.ok(intervals.some(v => v.state === 'unindexed' && v.reason === 'coverage-capacity'));
    assert.ok(!intervals.some(v => v.state === 'indexed' && v.fromSeq <= 4 && v.throughSeq >= 4));
  });

  test('bounded thread/turn keyset queries preserve equal-seq members and use covering scope indexes', t => {
    const { index, db } = fixture(t);
    for (let start = 1; start <= 72; start += 8) ok(index.applyPage(page(Array.from({ length: 8 }, (_, n) => result(start + n, 'thread-a', 'one-turn')))));
    const members = [result(1, 'thread-a', 'one-turn'), result(1, 'thread-a', 'one-turn')];
    members.forEach((r, n) => { r.identity.ref.member = `image:${n + 1}`; r.identity.artifact.id = `same-event-part-${n + 1}`; });
    ok(index.applyPage(page(members)));
    const one = index.readTurn('thread-a', 'one-turn', { now: 200, limit: 1 });
    const two = index.readTurn('thread-a', 'one-turn', { now: 200, limit: 1, after: one.next! });
    assert.equal(one.rows[0]!.identity.ref.source.seq, two.rows[0]!.identity.ref.source.seq);
    assert.notEqual(one.rows[0]!.key, two.rows[0]!.key);
    const a = index.readTurn('thread-a', 'one-turn', { now: 200, limit: 64 });
    assert.equal(a.rows.length, 64); assert.ok(a.next);
    const b = index.readTurn('thread-a', 'one-turn', { now: 200, after: a.next!, limit: 64 });
    assert.equal(b.rows.length, 10); assert.equal(b.next, null);
    assert.equal(new Set([...a.rows, ...b.rows].map(v => v.key)).size, 74);
    assert.equal(index.readTurn('thread-a', 'other-turn', { now: 200 }).rows.length, 0);
    const query = db.prepare("EXPLAIN QUERY PLAN SELECT * FROM gallery_records WHERE kind='claim' AND thread_id=? AND turn_id=? AND (seq,record_key)>(?,?) ORDER BY seq,record_key LIMIT ?").all('thread-a', 'one-turn', 1, '', 65) as { detail: string }[];
    assert.ok(query.some(v => v.detail.includes('gallery_turn_read'))); assert.ok(query.every(v => !v.detail.includes('TEMP B-TREE')));
    const threadQuery = db.prepare("EXPLAIN QUERY PLAN SELECT * FROM gallery_records WHERE kind='claim' AND thread_id=? AND (seq,record_key)>(?,?) ORDER BY seq,record_key LIMIT ?").all('thread-a', 1, '', 65) as { detail: string }[];
    assert.ok(threadQuery.some(v => v.detail.includes('gallery_thread_read')));
    t.diagnostic(query.map(v => v.detail).join('; '));
  });

  test('every planned mutation before/after fault rolls back claims, metadata and cursor; reopened retry once', t => {
    // Max page: supplier + stage + 8 canonical claims + thread + global counters.
    // Two fault points for each of the 12 SQL row mutations, actual SQLite triggers.
    for (let failAt = 1; failAt <= 24; failAt++) {
      const { db, index, open } = fixture(t); const before = sqlSnapshot(db);
      let checkpoint = 0;
      db.function('gallery_fault', () => { checkpoint++; if (checkpoint === failAt) throw new Error(`Injected checkpoint ${failAt}`); return 0; });
      for (const table of ['gallery_records', 'gallery_meta']) for (const event of ['INSERT', 'UPDATE', 'DELETE']) for (const when of ['BEFORE', 'AFTER']) db.exec(`CREATE TRIGGER fault_${table}_${event}_${when} ${when} ${event} ON ${table} BEGIN SELECT gallery_fault(); END`);
      const p = page(Array.from({ length: 8 }, (_, n) => result(n + 1)), { stage: { id: 'feed', expectedVersion: null, value: stage('next-page') }, coverage: [{ fromSeq: 1, throughSeq: 8, state: 'indexed' }] });
      assert.throws(() => index.applyPage(p), /Injected checkpoint/u);
      assert.equal(sqlSnapshot(db), before, `rollback checkpoint ${failAt}`);
      const triggers = db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all() as { name: string }[];
      for (const row of triggers) db.exec(`DROP TRIGGER ${row.name}`);
      db.close(); const reopened = createGalleryIndex(open());
      assert.equal(reopened.readStage('thread-a', owner, 'feed'), null);
      ok(reopened.applyPage(p)); assert.equal(reopened.stats().observations, 8);
      // Committed response loss: replayed old CAS cannot advance cursor twice.
      const after = reopened.stats(); assert.equal(reopened.applyPage(p).state, 'conflict'); assert.deepEqual(reopened.stats(), after);
    }
  });

  test('SQLITE_FULL and held writer lock leave cursor and charge counters unchanged', t => {
    const { index, db, open, file } = fixture(t, { maxPhysicalBytes: 64 * 1024 });
    let capacity = false;
    for (let n = 1; n < 100; n++) {
      const r = result(n); r.sourceState = { description: 'x'.repeat(900) };
      const before = sqlSnapshot(db), applied = index.applyPage(page([r]));
      if (applied.state === 'capacity') { capacity = true; assert.equal(sqlSnapshot(db), before); break; }
      ok(applied);
    }
    assert.ok(capacity); assert.ok(statSync(file).size <= 64 * 1024); assert.ok(index.stats().physicalBytes <= 64 * 1024);
    const other = open(); other.exec('BEGIN IMMEDIATE');
    const before = sqlSnapshot(db);
    assert.equal(index.applyPage(page([], { stage: { id: 'locked', expectedVersion: null, value: stage('blocked') } })).state, 'capacity');
    other.exec('ROLLBACK'); assert.equal(sqlSnapshot(db), before);
    assert.equal(index.readStage('thread-a', owner, 'locked'), null);
  });

  test('deletion is bounded and hides all retained rows/debt until cleanup completes', t => {
    const { index, db } = fixture(t);
    for (let n = 1; n <= 16; n += 8) ok(index.applyPage(page(Array.from({ length: 8 }, (_, i) => result(n + i)), { stage: { id: `feed-${n}`, expectedVersion: null, value: stage() } })));
    const first = ok(index.deleteThread('thread-a', 2)); assert.ok(first.mutations <= 4);
    assert.equal(index.coverage('thread-a').state, 'deleted'); assert.equal(read(index).length, 0);
    assert.equal(index.listStages('thread-a').rows.length, 0); assert.equal(index.readStage('thread-a', owner, 'feed-1'), null);
    assert.equal(index.applyPage(page()).state, 'conflict');
    for (let n = 0; n < 16 && index.coverage('thread-a').state === 'deleted'; n++) ok(index.deleteThread('thread-a', 2));
    assert.equal(index.stats().observations, 0); assert.equal(index.stats().stages, 0); assert.equal(index.stats().suppliers, 0); assert.equal(index.stats().threads, 0);
    assert.equal((db.prepare('SELECT count(*) AS n FROM gallery_records').get() as { n: number }).n, 0);
    assert.equal(index.coverage('thread-a').state, 'unindexed');
  });

  test('unknown future/partial schema and corruption never reset retained data', t => {
    const { db, index, open } = fixture(t); ok(index.applyPage(page()));
    db.prepare('UPDATE gallery_meta SET schema_version=2').run(); const before = sqlSnapshot(db);
    assert.throws(() => createGalleryIndex(open()), (e: unknown) => e instanceof GalleryIndexError && e.code === 'schema');
    assert.equal(sqlSnapshot(db), before);
    db.prepare('UPDATE gallery_meta SET schema_version=1').run();
    db.prepare("UPDATE gallery_records SET payload_json='{}' WHERE kind='claim'").run();
    assert.throws(() => read(index), (e: unknown) => e instanceof GalleryIndexError && e.code === 'corrupt');
    const broken = fixture(t); broken.db.exec('DROP TABLE gallery_records');
    assert.throws(() => createGalleryIndex(broken.open()), (e: unknown) => e instanceof GalleryIndexError && e.code === 'corrupt');
  });

  test('failed schema initialization rolls back and rejects undercharged baseline limits', t => {
    const { open } = fixture(t);
    // Use an independent fresh file, not a materialized host database.
    const directory = mkdtempSync(join(tmpdir(), 'gallery-init-')), file = join(directory, 'tiny.sqlite');
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const db = new Database(file);
    try {
      assert.throws(() => createGalleryIndex(db, { maxPhysicalBytes: 8192 }), (e: unknown) => e instanceof GalleryIndexError && e.code === 'physical-capacity');
      assert.equal((db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table'").get() as { n: number }).n, 0);
      const index = createGalleryIndex(db); assert.equal(index.stats().observations, 0);
      assert.throws(() => createGalleryIndex(open(), { maxMetadataBytes: 1023 }), RangeError);
    } finally { db.close(); }
  });

  test('finite physical file/journal proof under churn and no access-order writes', t => {
    const { db, index, file } = fixture(t, { maxObservations: 32, maxObservationsPerThread: 32, maxPhysicalBytes: 512 * 1024 });
    let largestJournal = 0, largestMain = 0;
    db.function('measure_gallery_files', () => {
      largestMain = Math.max(largestMain, statSync(file).size);
      if (existsSync(`${file}-journal`)) largestJournal = Math.max(largestJournal, statSync(`${file}-journal`).size);
      return 0;
    });
    db.exec('CREATE TRIGGER measure_after_write AFTER UPDATE ON gallery_meta BEGIN SELECT measure_gallery_files(); END');
    for (let n = 1; n <= 256; n += 8) {
      if (index.stats().observations === 32) ok(index.evict({ limit: 8 }));
      ok(index.applyPage(page(Array.from({ length: 8 }, (_, i) => result(n + i)))));
    }
    const before = sqlSnapshot(db); for (let n = 0; n < 10; n++) read(index); assert.equal(sqlSnapshot(db), before);
    assert.ok(largestJournal > 0); assert.ok(largestMain <= 512 * 1024); assert.ok(largestJournal <= index.stats().journalReserveBytes);
    assert.equal(existsSync(`${file}-journal`), false); assert.equal(existsSync(`${file}-wal`), false);
    const charges = db.prepare("SELECT sum(charge) AS total,sum(CASE WHEN kind<>'claim' THEN charge ELSE 0 END) AS metadata FROM gallery_records").get() as { total: number; metadata: number };
    assert.equal(index.stats().logicalBytes, charges.total + 1024); assert.equal(index.stats().metadataBytes, charges.metadata + 1024);
    t.diagnostic(`256 observations / 224 evictions: main peak ${largestMain}; DELETE journal peak ${largestJournal}; current charged ${index.stats().logicalBytes}; physical ${index.stats().physicalBytes}`);
  });
}
