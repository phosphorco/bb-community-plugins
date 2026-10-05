import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createBbIdentityServerBinding } from '../bb-binding-runtime.ts';
import { identityStateRoutes, identityStateRpcMethods } from '../rpc-routes-runtime.ts';
import { createAdapterHarness } from '../testing-runtime.ts';
import { createProofStateStorage } from './support/state-storage.mjs';

const ok = (value) => ({ ok: true, value });
const error = (code, message = code) => ({ ok: false, error: { code, message, retry: 'never' } });
const schema = { '~standard': { version: 1, vendor: 'portable-binding-acceptance', validate: (value) => ({ value }) } };
const textCodec = { decode: (value) => typeof value === 'string' ? ok(value) : error('invalid-input'), encode: (value) => value };
const resource = { pluginId: 'feature', definition: { collection: 'preferences', schemaVersion: 1, codec: textCodec, initialValue: () => '', equal: (left, right) => left === right } };

/** This is an installed-SDK-shaped plugin registry; the feature sees only its returned binding. */
function installedSdkHost(extension) {
  const native = new Map();
  const hooks = [];
  const published = [];
  return {
    native, hooks, published,
    bb: {
      pluginId: 'feature', experimental_p6rIdentity: extension,
      rpc: { register(contract, handlers) { for (const method of Object.keys(contract)) native.set(method, handlers[method]); } },
      realtime: { publish(channel, payload) { published.push({ channel, payload }); } },
      onDispose(listener) { hooks.push(listener); },
      sdk: {
        // Installed 0.4.15 semantics: conservative success acknowledgement, no invented delivery fields.
        threads: { async send() { return { ok: true }; } },
        plugins: { async callRpc() { return { ok: true }; } },
      },
    },
  };
}

/** Injected core host setup only. Consumers below never assemble an adapter or raw protocol. */
function enhancedCoreHost({ instanceId, outage = false, producerRendering = 'supported' }) {
  const harness = createAdapterHarness({ mode: 'multi-user', instanceId, pluginId: 'feature', inputCodec: textCodec });
  let current = harness.request();
  let producerRenderingCalls = 0;
  const protocol = {
    version: 1,
    instanceId,
    ...(producerRendering === 'supported'
      ? { experimental_useProducerMessageRendering() { producerRenderingCalls++; } }
      : producerRendering === 'invalid'
        ? { experimental_useProducerMessageRendering: true }
        : {}),
    bindInvocation({ handler }) {
      let retired = false;
      return {
        registration: { generation: 'core-generation', status: 'active', dispose() { retired = true; } },
        handler: async (input) => {
          if (retired) throw new Error('retired core binding');
          const controller = new AbortController();
          return handler({ request: current, scope: {
            signal: controller.signal,
            validate: () => controller.signal.aborted ? { ok: false, code: 'invalidated' } : { ok: true },
            release() { controller.abort(); },
          } }, input);
        },
      };
    },
    async session(request) {
      if (outage) return { status: 'unavailable', instanceId, error: { code: 'unavailable', message: 'core outage', retry: 'after-reconnect' } };
      return harness.upstream.session(request);
    },
    async selfProfile(request) { return outage ? error('unavailable', 'core outage') : harness.upstream.selfProfile(request); },
    async openRequest(request) {
      if (outage) return error('unavailable', 'core outage');
      const opened = await harness.upstream.openScope(request);
      if (!opened.ok) return opened;
      const controller = new AbortController();
      return ok({ ...opened.value, scope: {
        signal: controller.signal,
        validate: () => controller.signal.aborted ? { ok: false, code: 'invalidated' } : { ok: true },
        release() { controller.abort(); },
      } });
    },
    async accept() { return error('unsupported'); },
    async lookup() { return ok({ status: 'unknown', reason: 'unsupported' }); },
    async provenance() { return ok({ status: 'unknown', correlation: null, reason: 'fixture' }); },
    async historyContributions() { return ok({ status: 'unavailable', reason: 'unsupported' }); },
    async historyAttempts() { return ok({ status: 'unavailable', reason: 'unsupported' }); },
    directorySources() { return []; },
    async participants() { return error('unsupported'); },
    async forwardRpc(_scope, _destination, input) { return input; },
    async registerProvider() { return error('unsupported'); },
    subscribe() { return () => {}; },
  };
  return { protocol, producerRenderingCalls() { return producerRenderingCalls; }, request() { current = harness.request(); return current; } };
}

/** Consumer code receives the normalized portable binding only. */
function registerConsumer(binding, storage) {
  const registered = binding.rpc.register({ 'feature.session': { input: schema, output: schema } }, {
    'feature.session': {
      origin: 'interactive-user',
      async handle(_input, invocation) {
        const session = await binding.server.session(invocation);
        const person = await invocation.person();
        return session.status === 'ready'
          ? { status: session.status, instanceId: session.instanceId, actor: session.actor.identity.key, stamp: session.stamp, person: person.ok }
          : { status: session.status, instanceId: session.instanceId, code: session.error.code, person: person.ok };
      },
    },
  });
  assert.equal(registered.ok, true);
  const state = binding.state.register({ resource, storage, policy: { kind: 'self-only' } });
  assert.equal(state.ok, true);
  return { dispose() { if (state.ok) state.value.dispose(); } };
}

test('two capability-absent consumers retain the same singleton identity through the portable binding', async () => {
  const left = installedSdkHost(undefined);
  const right = installedSdkHost(undefined);
  const leftBinding = createBbIdentityServerBinding({ bb: left.bb, stateNamespace: 'portable-singleton' });
  const rightBinding = createBbIdentityServerBinding({ bb: right.bb, stateNamespace: 'portable-singleton' });
  assert.equal(leftBinding.ok, true); assert.equal(rightBinding.ok, true);
  if (!leftBinding.ok || !rightBinding.ok) return;
  const leftDb = new Database(':memory:'); const rightDb = new Database(':memory:');
  try {
    registerConsumer(leftBinding.value, createProofStateStorage({ db: leftDb, emptyEpoch: 'portable-empty' }));
    registerConsumer(rightBinding.value, createProofStateStorage({ db: rightDb, emptyEpoch: 'portable-empty' }));
    const leftSession = await left.native.get('feature.session')({});
    const rightSession = await right.native.get('feature.session')({});
    assert.deepEqual(leftSession, rightSession);
    assert.deepEqual(leftSession, { status: 'ready', instanceId: 'portable-singleton', actor: 'local:portable-singleton', stamp: 'singleton:portable-singleton', person: true });
    leftBinding.value.dispose();
    await assert.rejects(left.native.get('feature.session')({}), /retired/);
    assert.deepEqual(await right.native.get('feature.session')({}), rightSession);
  } finally { leftBinding.value.dispose(); rightBinding.value.dispose(); leftDb.close(); rightDb.close(); }
});

test('enhanced persisted namespace dispatches state commit and durable receipt recovery through one consumer binding', async () => {
  const core = enhancedCoreHost({ instanceId: 'persisted-portable' });
  const host = installedSdkHost(core.protocol);
  const binding = createBbIdentityServerBinding({ bb: host.bb, stateNamespace: 'must-not-win' });
  assert.equal(binding.ok, true); if (!binding.ok) return;
  const directory = await mkdtemp(join(tmpdir(), 'bb-portable-binding-'));
  const path = join(directory, 'state.db');
  let db = new Database(path);
  let reopenedBinding = null;
  try {
    registerConsumer(binding.value, createProofStateStorage({ db, emptyEpoch: 'portable-empty' }));
    const session = await host.native.get('feature.session')({});
    assert.deepEqual(session, { status: 'ready', instanceId: 'persisted-portable', actor: 'local:persisted-portable', stamp: 'fixture-session', person: true });
    const expected = { actor: session.actor, session: session.stamp };
    const address = { instanceId: session.instanceId, pluginId: 'feature', collection: 'preferences', recordId: 'appearance', owner: session.actor };
    const mutation = { kind: 'replace', address, expected, expectedVersion: { epoch: 'portable-empty', sequence: 0 }, ownerSession: 'owner-session', localGeneration: 1, operationId: 'portable-operation', schemaVersion: 1, value: 'dark' };
    const saved = await host.native.get(identityStateRpcMethods[identityStateRoutes.save])(mutation);
    assert.deepEqual(saved, { ok: true, value: { status: 'saved', envelope: {
      address, version: { epoch: 'portable-empty', sequence: 1 }, schemaVersion: 1, value: 'dark',
      lastEditedBy: { identity: { kind: 'default-user', key: session.actor, instanceId: session.instanceId }, presentation: { displayName: 'Fixture user', handle: null, avatarUrl: null }, evidence: 'local-user' },
    }, operationId: 'portable-operation' } });
    const recovered = await host.native.get(identityStateRpcMethods[identityStateRoutes.reconcile])({ address, expected, operationId: 'portable-operation' });
    assert.deepEqual(recovered, { ok: true, value: { status: 'final', outcome: saved.value } });
    assert.equal(host.published.length, 1);

    // New database handle and new binding prove durable recovery rather than adapter reconstruction.
    binding.value.dispose(); db.close(); db = null;
    const reopenedCore = enhancedCoreHost({ instanceId: 'persisted-portable' });
    const reopenedHost = installedSdkHost(reopenedCore.protocol);
    reopenedBinding = createBbIdentityServerBinding({ bb: reopenedHost.bb, stateNamespace: 'must-not-win' });
    assert.equal(reopenedBinding.ok, true); if (!reopenedBinding.ok) return;
    db = new Database(path);
    const durableStorage = createProofStateStorage({ db, emptyEpoch: 'ignored-after-open' });
    let secondWrites = 0;
    registerConsumer(reopenedBinding.value, {
      ...durableStorage,
      async commit(input) { secondWrites++; return durableStorage.commit(input); },
    });
    const replay = await reopenedHost.native.get(identityStateRpcMethods[identityStateRoutes.reconcile])({ address, expected, operationId: 'portable-operation' });
    assert.deepEqual(replay, { ok: true, value: { status: 'final', outcome: saved.value } });
    assert.equal(secondWrites, 0);
  } finally {
    binding.value.dispose();
    if (reopenedBinding?.ok) reopenedBinding.value.dispose();
    db?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('enhanced producer binding enables the plugin-scoped SDK rendering policy once', () => {
  const core = enhancedCoreHost({ instanceId: 'producer-portable' });
  const host = installedSdkHost(core.protocol);
  const binding = createBbIdentityServerBinding({ bb: host.bb, externalMessageRendering: 'producer' });
  assert.equal(binding.ok, true);
  assert.equal(core.producerRenderingCalls(), 1);
  if (binding.ok) binding.value.dispose();
});

test('enhanced producer binding rejects missing or invalid rendering capability before registration', () => {
  for (const producerRendering of ['missing', 'invalid']) {
    const core = enhancedCoreHost({ instanceId: `producer-${producerRendering}`, producerRendering });
    const host = installedSdkHost(core.protocol);
    const binding = createBbIdentityServerBinding({ bb: host.bb, externalMessageRendering: 'producer' });
    assert.deepEqual(binding, { ok: false, error: { code: 'incompatible', message: 'Enhanced identity host does not support producer-owned external message rendering.', retry: 'never' } });
    assert.equal(core.producerRenderingCalls(), 0);
    assert.equal(host.native.size, 0);
  }
});

test('malformed and unavailable enhanced hosts never select the singleton fallback', async () => {
  const malformed = installedSdkHost({ version: 1 });
  const malformedBinding = createBbIdentityServerBinding({ bb: malformed.bb, stateNamespace: 'fallback-forbidden' });
  assert.equal(malformedBinding.ok, false);
  if (!malformedBinding.ok) assert.equal(malformedBinding.error.code, 'incompatible');
  assert.equal(malformed.native.size, 0);

  const outageCore = enhancedCoreHost({ instanceId: 'persisted-outage', outage: true });
  const outage = installedSdkHost(outageCore.protocol);
  const outageBinding = createBbIdentityServerBinding({ bb: outage.bb, stateNamespace: 'fallback-forbidden' });
  assert.equal(outageBinding.ok, true); if (!outageBinding.ok) return;
  const db = new Database(':memory:');
  try {
    const storage = createProofStateStorage({ db, emptyEpoch: 'portable-empty' });
    registerConsumer(outageBinding.value, storage);
    const observed = await outage.native.get('feature.session')({});
    assert.deepEqual(observed, { status: 'unavailable', instanceId: 'persisted-outage', code: 'unavailable', person: false });
    const expected = { actor: 'local:persisted-outage', session: 'fixture-session' };
    const address = { instanceId: 'persisted-outage', pluginId: 'feature', collection: 'preferences', recordId: 'appearance', owner: expected.actor };
    const failedWrite = await outage.native.get(identityStateRpcMethods[identityStateRoutes.save])({
      kind: 'replace', address, expected, expectedVersion: { epoch: 'portable-empty', sequence: 0 },
      ownerSession: 'owner-session', localGeneration: 1, operationId: 'outage-operation', schemaVersion: 1, value: 'dark',
    });
    assert.equal(failedWrite.ok, false);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM p6r_proof_state_records').get().count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM p6r_proof_state_receipts').get().count, 0);
  } finally { outageBinding.value.dispose(); db.close(); }
});
