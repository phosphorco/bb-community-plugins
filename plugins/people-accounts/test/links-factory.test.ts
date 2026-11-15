import { boundFixture, until } from './native-fixture';
import { test, expect } from 'bun:test';
import type { Json } from '@phosphorco/bb-identity/model';
import { idCodec } from '@phosphorco/bb-identity/model';
import { createIdentityClient, createIdentityConnection, createIdentityView, bindIdentityState } from '@phosphorco/bb-identity/client';
import { createPeopleAccountsV2Client } from '@phosphorco/bb-people-accounts/v2/bb';
import { runPeopleAccountsV2Conformance } from '@phosphorco/bb-people-accounts/v2/testing';
import { type LinksRecord, pluginIdV2Schema } from '@phosphorco/bb-people-accounts/v2';
import { multiUserHost } from './host-fixture';
import { linksResource } from '../links-model';
import factory from '../server';
import { createPeopleHost } from './host-fixture';

const links: LinksRecord = { links: [{ id: 'shared', identity: { pluginId: pluginIdV2Schema.parse('source'), subject: 'workspace/shared' } }] };

test('generic database startup failure is unavailable rather than empty and leaves legacy v1 usable', async () => {
  const host = createPeopleHost({ pluginId: 'people-accounts' });
  host.bb.storage.database = () => { throw new Error('Controlled read-only filesystem'); };
  try {
    await factory(host.bb);
    expect(await host.harness.behavior.callRpc('peopleAccountsV1Roster', { version: 1 })).toMatchObject({ version: 1 });
    const description = await host.harness.behavior.callRpc('peopleAccountsDescribe', null); expect(description).toMatchObject({ capabilities: { links: true } });
    expect(await host.harness.behavior.callRpc('peopleAccountsV2LinksGet', { version: 2, personKeys: ['known-person'] })).toMatchObject({ ok: true, value: { results: [{ status: 'unavailable' }] } });
  } finally { await host.harness.lifecycle.dispose(); }
});

test('actual factory, native collaborator state/controller and v2 reads share one transactional link store', async () => {
  const f = await boundFixture(); try {
    await until(() => f.binding.getSnapshot().status === 'ready');
    const directory = await f.client.directory.search({ query: '', kinds: ['person'], history: 'current', limit: 50 });
    expect(directory.ok).toBe(true); if (!directory.ok) return;
    expect(directory.value.items).toHaveLength(2); expect(new Set(directory.value.items.map(p => p.identity.key)).size).toBe(2);
    const bob = directory.value.items.find(p => p.identity.key === f.host.people.get('bob')!.identity.key)!;
    expect((await f.view.select({ kind: 'person', key: bob.identity.key })).ok).toBe(true);
    await until(() => { const s = f.binding.getSnapshot(); return s.status === 'ready' && s.address.owner === bob.identity.key; });
    expect(f.binding.edit(links).ok).toBe(true); expect((await f.binding.flush()).ok).toBe(true);
    const read = await f.v2.links({ personKeys: [bob.identity.key] }); expect(read.results[0]).toMatchObject({ status: 'found', links: links.links });
    expect((await f.v2.describe())).toEqual({ status: 'ready', capabilities: { identities: false, links: true } });
    const saved = f.binding.getSnapshot(); expect(saved.status).toBe('ready'); if (saved.status === 'ready' && saved.acknowledged.status === 'present') expect(saved.acknowledged.envelope.lastEditedBy?.identity.key).toBe(f.host.people.get('alice')!.identity.key);
    expect((await f.view.reset()).ok).toBe(true); await until(() => { const s = f.binding.getSnapshot(); return s.status === 'ready' && s.address.owner !== bob.identity.key; });
    expect(f.binding.edit(links).ok).toBe(true); await f.binding.flush();
    const reverse = await f.v2.find({ identity: links.links[0]!.identity, limit: 50 }); expect(reverse.status).toBe('page'); if (reverse.status === 'page') expect(reverse.links).toHaveLength(2);
    await runPeopleAccountsV2Conformance({ sdk: f.sdk, pluginId: 'people-accounts', personKeys: [bob.identity.key, f.host.people.get('alice')!.identity.key], reverse: links.links[0]!.identity });
    expect(f.host.harness.inspection.registrations.settingsDescriptors.roster.default).toBe('[]');
    expect(await f.host.harness.behavior.callRpc('peopleAccountsStatus', null)).toMatchObject({ entries: [] });
  } finally { await f.close(); }
});

test('lost save response reconciles the exact operation and an old recovery action cannot target a new actor', async () => {
  const f = await boundFixture(); try {
    await until(() => f.binding.getSnapshot().status === 'ready');
    const original = f.connection.request.bind(f.connection); let lost = false;
    f.connection.request = async (method, input: Json, options) => { const result = await original(method, input, options); if (!lost && method.endsWith('/state/save')) { lost = true; throw new Error('Controlled post-commit loss'); } return result; };
    f.binding.edit(links); await f.binding.flush();
    const captured = f.binding.currentOwnerSession(); if (!captured) throw new Error('Missing owner');
    await f.binding.reconnect(captured); await until(() => f.binding.getSnapshot().status === 'ready');
    const rows = f.host.bb.storage.database().prepare('SELECT COUNT(*) AS count FROM people_links_receipts').get() as { count: number }; expect(rows.count).toBe(1);
    const alice = f.host.people.get('alice')!.identity.key;
    f.host.adapter.setActor(f.host.people.get('bob')!);
    await f.client.refresh();
    await until(() => { const s = f.binding.getSnapshot(); return s.status === 'ready' && s.address.owner !== alice; });
    expect((await f.binding.reconnect(captured)).ok).toBe(false);
    expect((await f.v2.links({ personKeys: [alice, f.host.people.get('bob')!.identity.key] })).results.map(r => r.status)).toEqual(['found', 'missing']);
  } finally { await f.close(); }
});

test('an accepted save with a held response remains on its original person after an actor switch', async () => {
  const f = await boundFixture(); let release = () => {}; try {
    await until(() => f.binding.getSnapshot().status === 'ready');
    const original = f.connection.request.bind(f.connection); let accepted = false; let saves = 0;
    f.connection.request = async (method, input, options) => {
      const output = await original(method, input, options);
      if (method.endsWith('/state/save')) { saves++; accepted = true; await new Promise<void>(r => { release = r; }); }
      return output;
    };
    f.binding.edit(links); const pending = f.binding.flush(); await until(() => accepted);
    f.host.adapter.setActor(f.host.people.get('bob')!); await f.client.refresh();
    await until(() => { const s = f.binding.getSnapshot(); return s.status === 'ready' && s.address.owner === f.host.people.get('bob')!.identity.key; });
    release(); await pending; await new Promise(r => setTimeout(r, 5));
    const read = await f.v2.links({ personKeys: [f.host.people.get('alice')!.identity.key, f.host.people.get('bob')!.identity.key] });
    expect(read.results.map(r => r.status)).toEqual(['found', 'missing']); expect(saves).toBe(1);
    const current = f.binding.getSnapshot(); expect(current.status).toBe('ready'); if (current.status === 'ready') expect(current.desired.links).toEqual([]);
  } finally { release(); await f.close(); }
});

test('late native load cannot replace a newer viewed person and disposed binding rejects edits', async () => {
  const f = await boundFixture(); let release = () => {}; try {
    await until(() => f.binding.getSnapshot().status === 'ready');
    const directory = await f.client.directory.search({ query: '', kinds: ['person'], history: 'current', limit: 50 }); if (!directory.ok) throw new Error(directory.error.message);
    const alice = f.host.people.get('alice')!.identity.key, bob = f.host.people.get('bob')!.identity.key;
    const original = f.connection.request.bind(f.connection); let entered = false;
    f.connection.request = async (method, input, options) => {
      const output = await original(method, input, options);
      if (method.endsWith('/state/load') && (input as { address?: { owner: string } }).address?.owner === bob) { entered = true; await new Promise<void>(r => { release = r; }); }
      return output;
    };
    await f.view.select({ kind: 'person', key: bob }); await until(() => entered);
    await f.view.reset(); await until(() => { const s = f.binding.getSnapshot(); return s.status === 'ready' && s.address.owner === alice; });
    release(); await new Promise(r => setTimeout(r, 10)); const latest = f.binding.getSnapshot(); expect(latest.status).toBe('ready'); if (latest.status === 'ready') expect(latest.address.owner).toBe(alice);
    f.binding.dispose(); expect(f.binding.edit(links).ok).toBe(false);
  } finally { release(); await f.close(); }
});

test('native conflict review retains the local edit and rebase updates the same index through CAS', async () => {
  const f = await boundFixture(); try {
    await until(() => f.binding.getSnapshot().status === 'ready');
    const base = f.binding.getSnapshot(); if (base.status !== 'ready' || base.acknowledged.status !== 'empty') throw new Error('Expected empty fixture');
    f.binding.edit(links);
    const changed = { links: [{ ...links.links[0]!, identity: { ...links.links[0]!.identity, subject: 'remote' } }] };
    const raw = await f.host.harness.behavior.callRpc('bb-identity.v1.state.save', {
      kind: 'replace', address: base.address, expectedVersion: base.acknowledged.version,
      expected: (() => { const session = f.client.getSnapshot(); if (session.status !== 'ready') throw new Error('Missing current session'); return { actor: session.actor.identity.key, session: session.stamp }; })(),
      ownerSession: 'other-owner', localGeneration: 1, operationId: 'other-write', schemaVersion: 1, value: changed,
    }); expect(raw).toMatchObject({ ok: true, value: { status: 'saved' } });
    await until(() => f.binding.getSnapshot().status === 'blocked');
    const snapshot = f.binding.getSnapshot(); if (snapshot.status !== 'blocked' || !snapshot.conflict) throw new Error('Expected conflict');
    expect(snapshot.conflict.local).toEqual(links); const owner = f.binding.currentOwnerSession(); if (!owner) throw new Error('Missing owner');
    expect((await f.binding.resolveConflict(owner, snapshot.conflict.token, { kind: 'rebase', value: snapshot.conflict.local })).ok).toBe(true);
    await f.binding.flush();
    const reverse = await f.v2.find({ identity: links.links[0]!.identity, limit: 50 }); expect(reverse).toMatchObject({ status: 'page', links: [{ personKey: base.address.owner }] });
    expect(await f.v2.find({ identity: changed.links[0]!.identity, limit: 50 })).toMatchObject({ links: [] });
  } finally { await f.close(); }
});
