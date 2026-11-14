import assert from 'node:assert/strict';
import test from 'node:test';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { createIdentityWireFake } from '@phosphorco/bb-identity/testing';
import { identityKeyCodec } from '@phosphorco/bb-identity/model';
import * as v2 from '../dist/v2.js';
import { createPeopleAccountsV2Client, createPeopleAccountsDiscovery, registerPeopleAccountsV2 } from '../dist/v2-bb.js';
import { runPeopleAccountsV2Conformance } from '../dist/v2-testing.js';
import { createPeopleAccountsClient, registerPeopleAccountsSupplier } from '../dist/bb.js';
import { createFixtureSupplierPort, healthFixture, rosterEntryFixture } from '../dist/testing.js';

const person = value => { const p = identityKeyCodec.decode(value); assert.equal(p.ok, true); return p.value; };
const a = person('person:a'); const b = person('person:b');
const identity = (pluginId = 'source-one', subject = 'workspace/user-1') => ({ pluginId, subject });
const publicIdentity = (subject, pluginId = 'source-one') => ({ identity: identity(pluginId, subject), presentation: { displayName: 'Same Name', handle: null } });
const edge = (id = 'link-a', locator = identity()) => ({ id, identity: locator });
const version = { epoch: 'fixture-epoch', sequence: 1 };
function fixture(ports, pluginId = 'source-one') {
  const host = createFakePluginHost({ pluginId });
  const registration = registerPeopleAccountsV2(host.bb, ports);
  const calls = [];
  const sdk = { plugins: {
    list: async () => ({ plugins: [{ id: pluginId, status: 'running' }] }),
    callRpc: async request => { calls.push(request); assert.equal(request.pluginId, pluginId); return host.harness.callRpc(request.method, request.input); },
  } };
  return { host, registration, sdk, calls, client: createPeopleAccountsV2Client(sdk, pluginId) };
}
const supplier = {
  async list(i) { return { version: 2, status: 'page', query: i.query, revision: 'catalog-1', items: [publicIdentity('workspace/user-1')], nextCursor: null, coverage: 'complete' }; },
  async get(i) { return { version: 2, results: i.subjects.map(subject => ({ subject, status: 'found', value: publicIdentity(subject) })) }; },
};
const linksReader = {
  async links(i) { return { version: 2, results: i.personKeys.map(personKey => ({ personKey, status: 'found', version, links: [edge()] })) }; },
  async find(i) { return { version: 2, status: 'page', identity: i.identity, revision: 'index-1', links: [{ personKey: a, id: 'link-a' }, { personKey: b, id: 'link-b' }], nextCursor: null, coverage: 'complete' }; },
};

test('v2 shares the public key codec and stores only non-transitive associations', () => {
  for (const input of ['person:opaque%2fA', 'local:instance-1', 'é'.repeat(250), '', null, 'bad\nkey', 'x'.repeat(513)]) {
    assert.equal(v2.personKeyV2Schema.safeParse(input).success, identityKeyCodec.decode(input).ok);
  }
  assert.equal(v2.personKeyV2Schema.parse('person:opaque%2fA'), 'person:opaque%2fA');
  assert.equal(v2.linksRecordSchema.parse({ links: [edge()] }).links[0].identity.subject, 'workspace/user-1');
  assert.throws(() => v2.linksRecordSchema.parse({ links: [edge(), edge('other')] }), /Duplicate/);
  assert.throws(() => v2.linksRecordSchema.parse({ links: [edge(), edge('link-a', identity('other'))] }), /Duplicate/);
  for (const added of [{ token: 'synthetic' }, { allowEmail: true }, { verified: true }, { mayActAs: true }, { primary: true }]) {
    assert.throws(() => v2.linksRecordSchema.parse({ links: [{ ...edge(), ...added }] }));
    assert.throws(() => v2.externalLocatorSchema.parse({ ...identity(), ...added }));
  }
  assert.equal(v2.locatorKey(identity('p', 'a/b')), v2.locatorKey({ subject: 'a/b', pluginId: 'p' }));
  assert.notEqual(v2.locatorKey(identity('p', 'a/b')), v2.locatorKey(identity('q', 'a/b')));
  assert.deepEqual(v2.createLinksResource('people-accounts').definition.initialValue(), { links: [] });
  assert.throws(() => v2.linksRecordSchema.parse({ links: Array.from({ length: 128 }, (_, n) => edge(`link-${n}`, identity('p', `${n}-${'x'.repeat(2000)}`))) }), /byte limit/);
});

test('negotiation decodes capabilities only under v2 and leaves old imports available', () => {
  const env = versions => ({ protocol: 'bb-people-accounts', versions, capabilities: { identities: true, links: false, future: 1 } });
  for (const versions of [[2], [1, 2]]) assert.deepEqual(v2.negotiatePeopleAccounts(env(versions)), { status: 'ready', capabilities: { identities: true, links: false } });
  assert.deepEqual(v2.negotiatePeopleAccounts({ ...env([1]), capabilities: 'not a v2 shape' }), { status: 'incompatible', reason: 'version' });
  for (const value of [env([]), env([0]), env([2.2]), { ...env([2]), capabilities: {} }, { ...env([2]), protocol: 'other' }]) assert.equal(v2.negotiatePeopleAccounts(value).status, 'incompatible');
});

test('actual SDK registration + production client + emitted conformance kit preserve ordering and shared bots', async () => {
  const f = fixture({ identities: supplier, links: linksReader });
  assert.equal((await f.client.describe()).status, 'ready');
  assert.deepEqual((await f.client.get({ subjects: ['second', 'first', 'second'] })).results.map(r => r.subject), ['second', 'first', 'second']);
  const forward = await f.client.links({ personKeys: [a, b, a] });
  assert.deepEqual(forward.results.map(r => r.personKey), [a, b, a]);
  assert.deepEqual(forward.results[0].links[0].identity, forward.results[1].links[0].identity);
  const reverse = await f.client.find({ identity: identity(), limit: 50 });
  assert.deepEqual(reverse.links.map(l => l.personKey), [a, b], 'shared external account never becomes one person');
  const result = await runPeopleAccountsV2Conformance({ sdk: f.sdk, pluginId: 'source-one', subjects: ['workspace/user-1'], personKeys: [a, b], reverse: identity() });
  assert.deepEqual(result.checks, ['negotiation', 'public-identities', 'ordered-keyed-lookup', 'forward-links', 'reverse-links']);
  for (const method of ['peopleAccountsV2Credential', 'peopleAccountsV2Save']) await assert.rejects(f.host.harness.callRpc(method, {}));
  await assert.rejects(f.host.harness.callRpc(v2.METHODS_V2.get, { version: 2, subjects: ['x'], allowEmail: true }));
});

test('client and registrar reject wrong-owner namespaces, unrequested identities, bad pagination and raw size before stripping', async () => {
  const cases = [
    { list: async i => ({ ...(await supplier.list(i)), items: [publicIdentity('x', 'other')] }) },
    { get: async i => ({ version: 2, results: [{ subject: i.subjects[0], status: 'found', value: publicIdentity('different') }] }) },
    { list: async i => ({ ...(await supplier.list(i)), items: [], nextCursor: 'again' }) },
    { list: async i => ({ ...(await supplier.list(i)), items: [publicIdentity('x'), publicIdentity('x')] }) },
    { list: async i => ({ ...(await supplier.list(i)), hidden: 'x'.repeat(v2.LIMITS_V2.responseBytes) }) },
  ];
  for (const override of cases) {
    const f = fixture({ identities: { ...supplier, ...override } });
    await assert.rejects(override.get ? f.client.get({ subjects: ['x'] }) : f.client.list({ query: '', limit: 50 }), /incompatible|limit-exceeded/);
  }
  const f = fixture({ identities: supplier });
  const forged = createPeopleAccountsV2Client({ plugins: { callRpc: async () => ({ ok: true, value: { version: 2, results: [{ subject: 'not-requested', status: 'missing' }] } }) } }, 'source-one');
  await assert.rejects(forged.get({ subjects: ['requested'] }), /incompatible/);
  const large = createPeopleAccountsV2Client({ plugins: { callRpc: async () => ({ protocol: 'bb-people-accounts', versions: [2], capabilities: {}, hidden: 'x'.repeat(v2.LIMITS_V2.responseBytes) }) } }, 'source-one');
  await assert.rejects(large.describe(), /limit-exceeded/);
  const before = f.calls.length;
  await assert.rejects(f.client.get({ subjects: [], token: 'synthetic' }));
  await assert.rejects(f.client.list({ query: '', limit: 50, cursor: 'c' }));
  assert.equal(f.calls.length, before, 'invalid input cannot reach transport');
});

test('found/missing/unavailable, partial results and cursor conflicts remain distinct', async () => {
  const f = fixture({ identities: {
    ...supplier,
    get: async i => ({ version: 2, results: i.subjects.map((subject, n) => n === 0 ? { subject, status: 'missing' } : { subject, status: 'unavailable' }) }),
    list: async i => i.cursor ? { version: 2, status: 'conflict', query: i.query } : { ...(await supplier.list(i)), coverage: 'partial', nextCursor: 'next' },
  } });
  assert.deepEqual((await f.client.get({ subjects: ['gone', 'offline'] })).results.map(r => r.status), ['missing', 'unavailable']);
  const page = await f.client.list({ query: '', limit: 50 });
  assert.equal(page.coverage, 'partial'); assert.equal(page.nextCursor, 'next');
  assert.equal((await f.client.list({ query: '', limit: 50, cursor: 'next', revision: page.revision })).status, 'conflict');
  const changed = fixture({ identities: supplier });
  await assert.rejects(changed.client.list({ query: '', limit: 50, revision: 'old' }), /incompatible/);
  const wrong = fixture({ links: { ...linksReader, links: async () => ({ version: 2, results: [{ personKey: b, status: 'missing' }] }) } });
  await assert.rejects(wrong.client.links({ personKeys: [a] }), /incompatible/);
});

test('additive outputs are projected; role registration performs no eager supplier I/O', async () => {
  let reads = 0;
  const f = fixture({ identities: {
    list: async i => { reads++; return { ...(await supplier.list(i)), future: true }; },
    get: async i => ({ ...(await supplier.get(i)), secret: 'synthetic-token' }),
  } });
  assert.equal(reads, 0);
  assert.equal((await f.client.describe()).capabilities.links, false);
  assert.equal(reads, 0);
  const result = await f.host.harness.callRpc(v2.METHODS_V2.get, { version: 2, subjects: ['x'] });
  assert.equal(JSON.stringify(result).includes('synthetic-token'), false);
});

test('registration advertises its captured roles despite later caller mutation', async () => {
  const ports = { identities: supplier };
  const f = fixture(ports);
  ports.identities = undefined;
  assert.deepEqual((await f.client.describe()).capabilities, { identities: true, links: false });
  assert.equal((await f.client.get({ subjects: ['x'] })).results[0].status, 'found');
});

test('noncooperating SDK deadlines, caller abort and registration disposal settle without retry', async () => {
  let calls = 0;
  const client = createPeopleAccountsV2Client({ plugins: { callRpc: async () => { calls++; return new Promise(() => {}); } } }, 'source-one', { callMs: 10 });
  await assert.rejects(client.describe(), /timeout/); assert.equal(calls, 1);
  const controller = new AbortController();
  const pending = client.describe(controller.signal); controller.abort();
  await assert.rejects(pending, /cancelled/);
  const f = fixture({ identities: { ...supplier, get: async (_i, signal) => new Promise(resolve => signal.addEventListener('abort', () => resolve({ version: 2, results: [] }))) } });
  const read = f.client.get({ subjects: ['x'] });
  await new Promise(resolve => setTimeout(resolve, 0)); f.registration.dispose();
  await assert.rejects(read, /unavailable|cancelled/);
  await assert.rejects(f.client.describe(), /unavailable/);
});

test('listed discovery is isolated, deterministic, finite and generation-owned', async () => {
  const calls = [];
  const owner = createPeopleAccountsDiscovery();
  const sdk = { plugins: {
    list: async () => ({ plugins: ['good', 'bad', 'legacy', 'slow', 'disabled'].map(id => ({ id, status: id === 'disabled' ? 'disabled' : 'running' })) }),
    callRpc: async ({ pluginId }) => {
      calls.push(pluginId);
      if (pluginId === 'slow') return new Promise(() => {});
      if (pluginId === 'legacy') throw { status: 404, body: { error: { code: 'unknown_method' } } };
      return pluginId === 'bad' ? {} : { protocol: 'bb-people-accounts', versions: [2], capabilities: { identities: true, links: false } };
    },
  } };
  const pass = await owner.start(sdk, { describeMs: 10, sliceMs: 20, previouslyReady: ['good'] });
  const result = await pass.next();
  assert.equal(result.hasMore, false);
  assert.deepEqual(result.rows.map(r => [r.pluginId, r.status]), [['good', 'ready'], ['bad', 'incompatible'], ['legacy', 'absent'], ['slow', 'unavailable']]);
  assert.equal(calls.includes('disabled'), false);
  const stale = await owner.start(sdk, { describeMs: 10, sliceMs: 20 });
  const newer = await owner.start({ plugins: { ...sdk.plugins, list: async () => ({ plugins: [] }) } });
  await assert.rejects(stale.next(), /cancelled/); assert.deepEqual((await newer.next()).rows, []);
  owner.dispose(); await assert.rejects(newer.next(), /cancelled/);
});

test('ready admission does not truncate discovery of later suppliers', async () => {
  const owner = createPeopleAccountsDiscovery(); let listings = 0; let probes = 0;
  const pass = await owner.start({ plugins: {
    list: async () => { listings++; return { plugins: Array.from({ length: 35 }, (_, n) => ({ id: `supplier-${String(n).padStart(2, '0')}`, status: 'running' })) }; },
    callRpc: async () => { probes++; return { protocol: 'bb-people-accounts', versions: [2], capabilities: { identities: true, links: false } }; },
  } });
  const result = await pass.next();
  assert.equal(listings, 1); assert.equal(probes, 35); assert.equal(result.omittedCount, 3); assert.equal(result.rows.filter(r => r.admitted).length, 32);
  owner.dispose();
});

test('continuation drains one listed inventory; retiring an in-flight generation publishes nothing late', async () => {
  const owner = createPeopleAccountsDiscovery(); let listings = 0; let release;
  const sdk = { plugins: {
    list: async () => { listings++; return { plugins: Array.from({ length: 100 }, (_, n) => ({ id: `p-${n}`, status: 'running' })) }; },
    callRpc: async () => new Promise(() => {}),
  } };
  const pass = await owner.start(sdk, { describeMs: 1, sliceMs: 2 });
  const first = await pass.next(); assert.equal(first.hasMore, true); assert.equal(listings, 1);
  assert.ok(first.rows.some(r => r.status === 'pending'));
  const second = await pass.next(); assert.equal(listings, 1);
  assert.ok(second.rows.filter(r => r.status !== 'pending').length > first.rows.filter(r => r.status !== 'pending').length);
  let notifications = 0;
  const old = await owner.start({ plugins: {
    list: async () => ({ plugins: [{ id: 'source-one', status: 'running' }] }),
    callRpc: async () => new Promise(resolve => { release = resolve; }),
  } }, { onRow() { notifications++; } });
  const pending = old.next(); const rejected = assert.rejects(pending, /cancelled/);
  await new Promise(resolve => setTimeout(resolve, 0));
  const replacement = await owner.start({ plugins: { ...sdk.plugins, list: async () => ({ plugins: [] }) } });
  const before = notifications; release({ protocol: 'bb-people-accounts', versions: [2], capabilities: { identities: true, links: false } });
  await rejected; assert.equal(notifications, before); assert.deepEqual((await replacement.next()).rows, []);
  owner.dispose(); await assert.rejects(owner.start(sdk), /disposed/);
});

test('reverse lookup rejects drift/foreign locators, never hides a second person, and broken adopter conformance fails', async () => {
  const f = fixture({ links: linksReader });
  await assert.rejects(f.client.find({ identity: identity(), limit: 1 }), /incompatible/);
  await assert.rejects(f.client.find({ identity: identity(), limit: 50, revision: 'old' }), /incompatible/);
  const bad = fixture({ links: { ...linksReader, find: async i => ({ ...(await linksReader.find(i)), identity: identity('other') }) } });
  await assert.rejects(bad.client.find({ identity: identity(), limit: 50 }), /incompatible/);
  const losing = fixture({ links: { ...linksReader, find: async i => ({ ...(await linksReader.find(i)), links: [] }) } });
  await assert.rejects(runPeopleAccountsV2Conformance({ sdk: losing.sdk, pluginId: 'source-one', personKeys: [a, b], reverse: identity() }), /lost an association/);
});

test('v1 methods and credential custody stay independent on the same real SDK host', async () => {
  const f = fixture({ identities: supplier }, 'people-accounts');
  const row = { ...rosterEntryFixture(), credential: healthFixture() };
  const port = createFixtureSupplierPort([row], { [row.botLogin]: 'synthetic-fixture-token' });
  registerPeopleAccountsSupplier(f.host.bb, port);
  const old = createPeopleAccountsClient(f.sdk, 'people-accounts');
  const summary = await old.resolve({ inputs: ['ada', 'unknown'] });
  assert.equal(summary.attribution.primary.person.personKey, row.personKey);
  assert.deepEqual((await old.credential(row.botLogin)).token, 'synthetic-fixture-token');
  const count = port.calls.credential.length;
  await f.client.describe();
  assert.equal(port.calls.credential.length, count, 'v2 discovery never reads legacy credentials');
  assert.equal(f.calls.filter(c => c.method === 'peopleAccountsDescribe').length, 1);
  assert.ok(f.calls.slice(0, 2).every(c => c.method.startsWith('peopleAccountsV1')));
});

test('link codec composes with actual public identity state binding and reconciles response loss', async () => {
  const host = createFakePluginHost({ pluginId: 'people-accounts' });
  const resource = v2.createLinksResource('people-accounts');
  const wire = createIdentityWireFake({ host, resource, mode: 'multi-user', policy: { kind: 'collaborators' }, readPolicy: { kind: 'collaborators' } });
  try {
    wire.addPerson({ subject: 'b', name: 'Same Name' });
    const session = await wire.rpc['bb-identity.v1.bootstrap']({}); assert.equal(session.ok, true);
    const expected = { actor: session.value.actor.identity.key, session: session.value.stamp };
    const address = { instanceId: session.value.instanceId, pluginId: 'people-accounts', collection: resource.definition.collection, recordId: 'links', owner: expected.actor };
    const loaded = await wire.rpc['bb-identity.v1.state.load']({ address, expected }); assert.equal(loaded.ok, true, JSON.stringify(loaded));
    const mutation = { kind: 'replace', address, expectedVersion: loaded.value.version, expected, ownerSession: 'owner-session', localGeneration: 1, operationId: 'link-write-1', schemaVersion: 1, value: { links: [edge()] } };
    wire.loseNextSaveResponse();
    await assert.rejects(wire.rpc['bb-identity.v1.state.save'](mutation));
    const receipt = await wire.rpc['bb-identity.v1.state.reconcile']({ address, expected, operationId: mutation.operationId });
    assert.equal(receipt.ok, true); assert.equal(receipt.value.status, 'final');
    assert.equal(receipt.value.outcome.envelope.address.owner, address.owner);
    assert.deepEqual(receipt.value.outcome.envelope.value, mutation.value);
    const invalid = await wire.rpc['bb-identity.v1.state.save']({ ...mutation, operationId: 'bad', value: { links: [{ ...edge(), allowEmail: true }] } });
    assert.equal(invalid.ok, false); assert.equal(invalid.error.code, 'invalid-input');
    assert.deepEqual(wire.committed(address).value, mutation.value);
  } finally { wire.dispose(); }
});
