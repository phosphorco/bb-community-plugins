// Self-tests for the ./testing conformance additions: the identity wire fake
// (production server binding on an SDK fake host, driven by the production
// native client connection and state transport) and the storage conformance suite.
import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { createIdentityWireFake, createManualClock, createStateStorageHarness, defineStateStorageConformance } from '../testing-runtime.ts';
import { createNativeIdentityConnection } from '../bb-client-connection-runtime.ts';
import { createStateTransport } from '../state-transport-runtime.ts';
import { createProofStateStorage } from './support/state-storage.mjs';

const ok = value => ({ ok: true, value });
const codec = { decode: value => typeof value === 'string' ? ok(value) : { ok: false, error: { code: 'invalid-input', message: 'string', retry: 'never' } }, encode: value => value };
const resource = { pluginId: 'wire-feature', definition: { collection: 'preferences', schemaVersion: 1, codec, initialValue: () => '', equal: (a, b) => a === b } };

function wire(mode, extra = {}) {
  const fake = createIdentityWireFake({ host: createFakePluginHost({ pluginId: 'wire-feature' }), mode, resource, ...extra });
  const events = [];
  fake.onRealtime((channel, payload) => events.push({ channel, payload }));
  const native = createNativeIdentityConnection({ rpc: { call: (method, input) => fake.rpc[method](input) }, realtimeState: 'connected' });
  fake.onRealtime((_channel, payload) => native.acceptRealtime(payload));
  const transport = createStateTransport({ connection: native.connection, resource });
  const bootstrap = async () => { const r = await fake.rpc['bb-identity.v1.bootstrap']({}); expect(r.ok).toBe(true); return r.value; };
  const session = async () => { const s = await bootstrap(); return { s, expected: { actor: s.actor.identity.key, session: s.stamp }, address: (owner = s.actor.identity.key, recordId = 'appearance') => ({ instanceId: s.instanceId, pluginId: 'wire-feature', collection: 'preferences', recordId, owner }) }; };
  let operations = 0;
  const mutation = (address, expected, expectedVersion, value) => ({ kind: 'replace', address, expected, expectedVersion, ownerSession: 'owner-session', localGeneration: 1, operationId: `operation-${++operations}`, schemaVersion: 1, value });
  return { fake, events, native, transport, bootstrap, session, mutation, dispose: () => { native.dispose(); fake.dispose(); } };
}

test('identity wire fake: single-user bootstrap and state round trip through the production client', async () => {
  const w = wire('single-user');
  try {
    const { s, expected, address } = await w.session();
    expect(s.mode).toBe('single-user');
    expect(w.fake.actor).toBeNull();
    const empty = await w.transport.load({ address: address(), expected });
    expect(empty.ok && empty.value.status).toBe('empty');
    const saved = await w.transport.save(w.mutation(address(), expected, empty.value.version, 'dark'));
    expect(saved.ok && saved.value.status).toBe('saved');
    expect(w.fake.committed(address()).value).toBe('dark');
    expect(w.events.some(e => e.channel === 'bb-identity/v1' && e.payload.kind === 'state' && e.payload.event.operationId === saved.value.operationId)).toBe(true);
    expect(w.fake.calls).toContain('bb-identity.v1.state.save');
    expect(w.fake.saveInputs).toHaveLength(1);
    expect(() => w.fake.switchActor('someone')).toThrow(/multi-user/);
  } finally { w.dispose(); }
});

test('identity wire fake: multi-user actor switch fences the old session and re-addresses state', async () => {
  const w = wire('multi-user', { actor: { subject: 'alice', name: 'Alice' } });
  try {
    const first = await w.session();
    expect(first.s.mode).toBe('multi-user');
    expect(first.expected.actor).toBe(w.fake.personKey('alice'));
    const empty = await w.transport.load({ address: first.address(), expected: first.expected });
    expect((await w.transport.save(w.mutation(first.address(), first.expected, empty.value.version, 'alice-dark'))).value.status).toBe('saved');
    w.fake.switchActor('bob');
    expect(w.events.some(e => e.payload.kind === 'session')).toBe(true);
    const raw = await w.fake.rpc['bb-identity.v1.state.load']({ address: first.address(), expected: first.expected });
    expect(raw.ok).toBe(false);
    expect(raw.error.code).toBe('stale-context');
    const second = await w.session();
    expect(second.expected.actor).toBe(w.fake.personKey('bob'));
    expect(second.expected.session).not.toBe(first.expected.session);
    const foreign = await w.fake.rpc['bb-identity.v1.state.load']({ address: first.address(), expected: second.expected });
    expect(foreign.ok).toBe(false);
    const own = await w.transport.load({ address: second.address(), expected: second.expected });
    expect(own.ok && own.value.status).toBe('empty');
    expect(w.fake.committed(first.address()).value).toBe('alice-dark');
  } finally { w.dispose(); }
});

test('identity wire fake: collaborator directory search and profile lookup', async () => {
  const w = wire('multi-user');
  try {
    w.fake.addPerson({ subject: 'collaborator', name: 'Collaborator' });
    await w.bootstrap();
    const search = await w.fake.rpc['bb-identity.v1.search']({ query: 'collab', kinds: ['person'], history: 'current', limit: 10 });
    expect(search.ok).toBe(true);
    expect(search.value.items.map(i => i.identity.key)).toEqual([w.fake.personKey('collaborator')]);
    const profiles = await w.fake.rpc['bb-identity.v1.profiles']({ keys: [w.fake.personKey('collaborator')] });
    expect(profiles.ok).toBe(true);
    expect(profiles.value[0].status).toBe('found');
    const single = wire('single-user');
    try { expect(() => single.fake.addPerson({ subject: 'x', name: 'X' })).toThrow(/multi-user/); } finally { single.dispose(); }
  } finally { w.dispose(); }
});

test('identity wire fake: load failures, held loads, lost save responses and external invalidation', async () => {
  const w = wire('single-user');
  try {
    const { expected, address } = await w.session();
    w.fake.failNextLoads(1);
    const failed = await w.transport.load({ address: address(), expected });
    expect(failed.ok).toBe(false);
    expect(failed.error.code).toBe('unavailable');
    expect(failed.error.retry).toBe('after-reconnect');
    const pause = w.fake.holdLoads();
    let settled = false;
    const held = w.transport.load({ address: address(), expected }).then(r => { settled = true; return r; });
    await pause.reached;
    expect(settled).toBe(false);
    pause.release();
    const empty = await held;
    expect(empty.ok && empty.value.status).toBe('empty');
    w.fake.loseNextSaveResponse();
    const lostMutation = w.mutation(address(), expected, empty.value.version, 'dark');
    const lost = await w.transport.save(lostMutation);
    expect(lost.ok).toBe(false);
    expect(w.fake.committed(address()).value).toBe('dark');
    const reconciled = await w.transport.reconcile({ address: address(), expected, operationId: lostMutation.operationId });
    expect(reconciled.ok && reconciled.value.status).toBe('final');
    const before = w.fake.committed(address());
    const changed = w.fake.invalidateExternally(address(), 'light');
    expect(changed.version.sequence).toBe(before.version.sequence + 1);
    expect(w.events.at(-1).payload).toEqual({ kind: 'state', event: { address: address(), version: changed.version, operationId: null } });
    const reread = await w.transport.load({ address: address(), expected });
    expect(reread.value.envelope.value).toBe('light');
  } finally { w.dispose(); }
});

// defineStateStorageConformance: collect the checks so each runs as a named test here.
function collect(options) {
  const checks = [];
  const registrar = (name, fn) => checks.push({ name, fn });
  registrar.skip = (name, fn) => checks.push({ name, fn, skipped: true });
  defineStateStorageConformance({ test: registrar, ...options });
  return checks;
}
const actor = { identity: { kind: 'person', key: 'fixture:owner', issuer: 'fixture', subject: 'owner' }, presentation: { displayName: 'Owner', handle: null, avatarUrl: null }, evidence: 'provider-verified' };
const address = recordId => ({ instanceId: 'conformance-instance', pluginId: 'conformance-feature', collection: 'preferences', recordId, owner: actor.identity.key });

for (const check of collect({
  open: ({ now }) => ({ storage: createStateStorageHarness({ clock: { now } }).storage }),
  address, values: ['dark', 'light'], actor, prefix: 'state storage conformance (in-memory harness): ',
  skip: { restart: 'the in-memory harness has no durable store' },
})) (check.skipped ? test.skip : test)(check.name, check.fn);

const directory = mkdtempSync(join(tmpdir(), 'bb-identity-storage-conformance-'));
test.afterAll?.(() => rmSync(directory, { recursive: true, force: true }));
let files = 0;
for (const check of collect({
  open: ({ now }) => {
    const path = join(directory, `state-${++files}.db`);
    const open = () => { const db = new Database(path); return { db, storage: createProofStateStorage({ db, emptyEpoch: 'conformance-epoch', now, receiptRetentionMs: 10 }) }; };
    let current = open();
    return {
      storage: current.storage,
      insideCommit: () => current.db.inTransaction,
      reopen() { current.db.close(); current = open(); return current.storage; },
      close() { current.db.close(); },
    };
  },
  address, values: [{ theme: 'dark' }, { theme: 'light' }], actor, prefix: 'state storage conformance (SQLite reference): ',
})) test(check.name, check.fn);

test('negative state storage conformance: storage that re-validates replays fails operation-ids', async () => {
  const checks = collect({
    open: ({ now }) => {
      const inner = createStateStorageHarness({ clock: { now } }).storage;
      let n = 0;
      return { storage: { ...inner, boundary: inner.boundary, receiptRetentionMs: inner.receiptRetentionMs, commit: input => inner.commit({ ...input, mutation: { ...input.mutation, operationId: `${input.mutation.operationId}-${++n}` } }) } };
    },
    address, values: ['dark', 'light'], actor, skip: { restart: 'not under test' },
  });
  await expect(checks.find(c => c.name.includes('operation ids are immutable')).fn()).rejects.toThrow(/\[state storage operation-ids\] validateAtCommit ran for a mutation that must not commit/);
});

test('state storage conformance: a missing reopen is an explicit failure unless skipped with a reason', async () => {
  const checks = collect({ open: ({ now }) => ({ storage: createStateStorageHarness({ clock: createManualClock() }).storage, now }), address, values: ['a', 'b'], actor });
  await expect(checks.find(c => c.name.includes('restart')).fn()).rejects.toThrow(/supply reopen, or pass skip\.restart/);
});
