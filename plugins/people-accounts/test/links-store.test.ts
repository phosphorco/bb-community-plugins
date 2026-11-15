import { test, expect } from 'bun:test';
import { openTestDatabase } from './sqlite-fixture';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineStateStorageConformance, personFixture } from '@phosphorco/bb-identity/testing';
import { idCodec, identityKeyCodec, type Result } from '@phosphorco/bb-identity/model';
import type { StateAddress, StateMutation } from '@phosphorco/bb-identity/state';
import type { LinksRecord } from '@phosphorco/bb-people-accounts/v2';
import { LinksStore, type LinksDatabase } from '../links-store';
import { linksResource } from '../links-model';

function unwrap<T>(r: Result<T>): T { if (!r.ok) throw new Error(r.error.message); return r.value; }
const instance = unwrap(idCodec('instance').decode('people-instance'));
const owner = (key: string) => unwrap(identityKeyCodec.decode(key));
const address = (key: string): StateAddress => ({ instanceId: instance, pluginId: linksResource.pluginId, collection: linksResource.definition.collection, recordId: 'links', owner: owner(key) });
const actor = personFixture({ subject: 'editor', name: 'Editor' });
const value = (subject: string): LinksRecord => ({ links: [{ id: 'link', identity: { pluginId: unwrap(idCodec('plugin').decode('source')), subject } }] });
function fixture(now: () => number = Date.now) {
  const dir = mkdtempSync(join(tmpdir(), 'people-links-')); const path = join(dir, 'state.db');
  let opened = openTestDatabase(path); let store = new LinksStore(opened.db as unknown as LinksDatabase, instance, now);
  return { get db() { return opened.db; }, get store() { return store; }, reopen() { opened.close(); opened = openTestDatabase(path); store = new LinksStore(opened.db as unknown as LinksDatabase, instance, now); return store; }, close() { opened.close(); rmSync(dir, { recursive: true, force: true }); } };
}
defineStateStorageConformance({ test, open: ({ now }) => { const f = fixture(now); return { storage: f.store, reopen: () => f.reopen(), insideCommit: () => f.db.inTransaction, close: () => f.close() }; }, address, values: [value('one'), value('two')], actor });
async function mutation(store: LinksStore, key: string, op: string, body: LinksRecord): Promise<StateMutation<LinksRecord>> {
  const a = address(key); const read = unwrap(await store.read(a)); if (read.status === 'migration-required') throw new Error('Fixture schema mismatch');
  return { kind: 'replace', address: a, expectedVersion: read.status === 'present' ? read.envelope.version : read.version, expected: { actor: actor.identity.key, session: unwrap(idCodec('server-session').decode('fixture-session')) }, ownerSession: unwrap(idCodec('owner-session').decode('owner')), localGeneration: 1, operationId: unwrap(idCodec('operation').decode(op)), schemaVersion: 1, value: body };
}
const commit = (store: LinksStore, m: StateMutation<LinksRecord>) => store.commit({ mutation: m, validateAtCommit: () => ({ ok: true, value: actor }) });
test('reverse index is paginated, context-bound and atomic with exact receipts across replay, relink, unlink and restart', async () => {
  const f = fixture(); try {
    const first = await mutation(f.store, 'opaque:a%2F', 'op-a', value('shared'));
    unwrap(await commit(f.store, first)); unwrap(await commit(f.store, await mutation(f.store, 'opaque:b', 'op-b', value('shared'))));
    const query = { version: 2 as const, identity: value('shared').links[0]!.identity, limit: 1 };
    const page = await f.store.reader.find(query, new AbortController().signal); expect(page.status).toBe('page'); if (page.status !== 'page') return;
    expect(page.links.map(link => ({ ...link, personKey: String(link.personKey) }))).toEqual([{ personKey: 'opaque:a%2F', id: 'link' }]); expect(page.nextCursor).not.toBeNull();
    const next = await f.store.reader.find({ ...query, revision: page.revision, cursor: page.nextCursor! }, new AbortController().signal); expect(next).toMatchObject({ links: [{ personKey: 'opaque:b' }], nextCursor: null });
    unwrap(await commit(f.store, first)); expect((await f.store.reader.find(query, new AbortController().signal))).toMatchObject({ revision: page.revision });
    expect(await f.store.reader.find({ ...query, identity: value('other').links[0]!.identity, revision: page.revision, cursor: page.nextCursor! }, new AbortController().signal)).toMatchObject({ status: 'conflict' });
    unwrap(await commit(f.store, await mutation(f.store, 'opaque:a%2F', 'relink', value('new'))));
    expect(await f.store.reader.find({ ...query, revision: page.revision, cursor: page.nextCursor! }, new AbortController().signal)).toMatchObject({ status: 'conflict' });
    f.reopen(); expect(await f.store.reader.find(query, new AbortController().signal)).toMatchObject({ links: [{ personKey: 'opaque:b' }] });
    unwrap(await commit(f.store, await mutation(f.store, 'opaque:b', 'unlink', { links: [] })));
    expect(await f.store.reader.find(query, new AbortController().signal)).toMatchObject({ links: [] });
    const original = unwrap(await f.store.reconcile({ address: first.address, operationId: first.operationId })); expect(original.status).toBe('final');
  } finally { f.close(); }
});
test('failed receipt insertion rolls back record, reverse index and revision; initialize never overwrites a winner', async () => {
  const f = fixture(); try {
    const m = await mutation(f.store, 'opaque:a', 'failed', value('shared'));
    const query = { version: 2 as const, identity: value('shared').links[0]!.identity, limit: 50 };
    const before = await f.store.reader.find(query, new AbortController().signal);
    f.db.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON people_links_receipts BEGIN SELECT RAISE(ABORT,'controlled failure'); END");
    expect((await commit(f.store, m)).ok).toBe(false); expect(unwrap(await f.store.read(m.address)).status).toBe('empty'); expect(await f.store.reader.find(query, new AbortController().signal)).toEqual(before);
    f.db.exec('DROP TRIGGER fail_receipt'); unwrap(await commit(f.store, m));
    expect(unwrap(await commit(f.store, { ...m, kind: 'initialize', operationId: unwrap(idCodec('operation').decode('import-candidate')), value: value('not-adopted') })).status).toBe('already-initialized');
    expect(await f.store.reader.find(query, new AbortController().signal)).toMatchObject({ links: [{ personKey: 'opaque:a' }] });
  } finally { f.close(); }
});
