import { expect, test } from 'bun:test';
import { createNativeIdentityConnection } from '../bb-client-connection-runtime.ts';
import { createIdentityClient } from '../client-runtime.ts';
import { createIdentityView } from '../client-view-runtime.ts';
import { bindIdentityState } from '../client-state-binding-runtime.ts';
import { createIdentityState } from '../state-controller-runtime.ts';
import { createStateTransport } from '../state-transport-runtime.ts';
import { identityRpcMethods, identityRoutes, identityStateRoutes } from '../rpc-routes-runtime.ts';

const ok = value => ({ ok: true, value });
const error = (code, message = code) => ({ ok: false, error: { code, message, retry: 'never' } });
const deferred = () => { let resolve; const promise = new Promise(next => { resolve = next; }); return { promise, resolve }; };
const settle = async () => { for (let index = 0; index < 40; index++) await Promise.resolve(); };
const person = subject => ({ kind: 'person', key: `issuer:${subject}`, issuer: 'issuer', subject });
const session = (subject, stamp) => ({
  status: 'ready', instanceId: 'native-instance', mode: 'multi-user', stamp,
  actor: { identity: person(subject), presentation: { displayName: subject, handle: null, avatarUrl: null }, evidence: 'provider-verified' },
  capabilities: { requestIdentity: 'host-resolved', acceptance: 'transactional-check', forwarding: 'host-bound',
    directory: { search: false, lookup: false }, participants: false, externalSend: 'structured', toolProvenance: 'causal', operationLookup: true },
});

/** Native RPC test seam: logical client routes must traverse the shared dotted method map. */
function nativeFixture(initial = session('a', 'a1')) {
  let current = initial;
  let heldBootstrap = null;
  const bootstrapQueue = [];
  let record = null;
  let nextLoadFailure = null;
  const calls = { bootstrap: 0, load: 0, save: [] };
  const rpc = {
    async call(method, input) {
      if (method === identityRpcMethods[identityRoutes.bootstrap]) {
        calls.bootstrap++;
        if (heldBootstrap) { const gate = heldBootstrap; heldBootstrap = null; gate.entered.resolve(); await gate.release.promise; }
        return ok(bootstrapQueue.shift() ?? current);
      }
      if (method === identityRpcMethods[identityStateRoutes.load]) {
        calls.load++;
        if (nextLoadFailure) { const failure = nextLoadFailure; nextLoadFailure = null; throw failure; }
        const empty = { status: 'empty', address: input.address, version: { epoch: 'native-empty', sequence: 0 } };
        return ok(record ?? empty);
      }
      if (method === identityRpcMethods[identityStateRoutes.save]) {
        calls.save.push(structuredClone(input));
        const previous = record?.status === 'present' ? record.envelope.version : { epoch: 'native-empty', sequence: 0 };
        const envelope = { address: input.address, version: { epoch: 'native-empty', sequence: previous.sequence + 1 }, schemaVersion: input.schemaVersion,
          value: input.value, lastEditedBy: current.actor };
        const outcome = { status: 'saved', envelope, operationId: input.operationId };
        record = { status: 'present', envelope };
        return ok(outcome);
      }
      if (method === identityRpcMethods[identityStateRoutes.reconcile]) return ok({ status: 'absent-final', retry: 'same-operation-only' });
      throw new Error(`unexpected native method ${method}`);
    },
  };
  return {
    rpc, calls,
    setSession(next) { current = next; },
    queueBootstrap(...responses) { bootstrapQueue.push(...responses); },
    failNextLoad(message = 'state load unavailable') { nextLoadFailure = new Error(message); },
    holdNextBootstrap() { const gate = { entered: deferred(), release: deferred() }; heldBootstrap = gate; return gate; },
  };
}

const textCodec = { decode: value => typeof value === 'string' ? ok(value) : error('invalid-input'), encode: value => value };
const resource = { pluginId: 'feature', definition: { collection: 'preferences', schemaVersion: 1, codec: textCodec, initialValue: () => '', equal: (left, right) => left === right } };
const drafts = { async write(draft) { return ok({ revision: 1, draft: structuredClone(draft) }); }, async find() { return ok([]); }, async remove() { return ok(undefined); } };

async function clientStateFixture(source) {
  const native = createNativeIdentityConnection({ rpc: source.rpc, realtimeState: 'connected' });
  const client = createIdentityClient({ connection: native.connection });
  expect((await client.start()).ok).toBe(true);
  const view = createIdentityView({ client });
  const binding = bindIdentityState({ client, view, target: 'actor', editPolicy: 'actor-only', resource, recordId: 'appearance', drafts,
    onConflict: () => ({ kind: 'needs-review', reason: 'fixture' }), onUnpersistedDraft() {}, initializeEmpty: false });
  await settle();
  return { native, client, view, binding, close() { binding.dispose(); view.dispose(); client.dispose(); native.dispose(); } };
}

test('unchanged native bootstrap preserves the owner and dispatches exactly one state save', async () => {
  const source = nativeFixture(); const fixture = await clientStateFixture(source);
  try {
    const owner = fixture.binding.currentOwnerSession();
    expect(fixture.binding.getSnapshot().status).toBe('ready');
    expect(fixture.binding.edit('dark').ok).toBe(true);
    expect((await fixture.binding.flush()).ok).toBe(true);
    expect(fixture.binding.currentOwnerSession()).toBe(owner);
    expect(source.calls.save).toHaveLength(1);
    expect(source.calls.save[0].address.owner).toBe('issuer:a');
    // start performs native revalidate + transport bootstrap; the save performs exactly one direct revalidate.
    expect(source.calls.bootstrap).toBe(3);
  } finally { fixture.close(); }
});

test('native session invalidation suspends A synchronously and reloads B before state saving', async () => {
  const source = nativeFixture(); const fixture = await clientStateFixture(source);
  try {
    const oldOwner = fixture.binding.currentOwnerSession();
    const gate = source.holdNextBootstrap();
    source.setSession(session('b', 'b1'));
    fixture.native.acceptRealtime({ kind: 'session' });
    await gate.entered.promise;
    // The shared native event reaches IdentityClient before its held bootstrap
    // can restore authority: no A controller is left able to enqueue a write.
    expect(fixture.client.currentSession().ok).toBe(false);
    expect(fixture.binding.currentOwnerSession()).toBeNull();
    expect(fixture.binding.edit('belongs-to-a').ok).toBe(false);
    expect(source.calls.save).toHaveLength(0);
    gate.release.resolve();
    await settle();
    expect(fixture.binding.currentOwnerSession()).not.toBe(oldOwner);
    expect(fixture.binding.getSnapshot()).toMatchObject({ status: 'ready', address: { owner: 'issuer:b' } });
    expect(fixture.binding.edit('belongs-to-b').ok).toBe(true);
    expect((await fixture.binding.flush()).ok).toBe(true);
    expect(source.calls.save).toHaveLength(1);
    expect(source.calls.save[0].address.owner).toBe('issuer:b');
  } finally { fixture.close(); }
});

test('a bootstrap A-to-B race retains B authority for the first unchanged save', async () => {
  const source = nativeFixture();
  // Native revalidation sees A; the client transport bootstrap immediately
  // follows with B without any realtime event between the two calls.
  source.queueBootstrap(session('a', 'a1'), session('b', 'b1'));
  source.setSession(session('b', 'b1'));
  const fixture = await clientStateFixture(source);
  try {
    const owner = fixture.binding.currentOwnerSession();
    expect(fixture.binding.getSnapshot()).toMatchObject({ status: 'ready', address: { owner: 'issuer:b' } });
    expect(fixture.binding.edit('belongs-to-b').ok).toBe(true);
    expect((await fixture.binding.flush()).ok).toBe(true);
    expect(fixture.binding.currentOwnerSession()).toBe(owner);
    expect(source.calls.save).toHaveLength(1);
    expect(source.calls.save[0].address.owner).toBe('issuer:b');
  } finally { fixture.close(); }
});

test('explicit state recovery while the native socket stays connected reloads and retains dirty intent', async () => {
  const source = nativeFixture();
  const native = createNativeIdentityConnection({ rpc: source.rpc, realtimeState: 'connected' });
  const client = createIdentityClient({ connection: native.connection });
  const state = createIdentityState({
    address: { instanceId: 'native-instance', pluginId: 'feature', collection: 'preferences', recordId: 'recovery', owner: 'issuer:a' },
    expected: { actor: 'issuer:a', session: 'a1' }, ownerSession: 'owner-recovery', definition: resource.definition,
    transport: createStateTransport({ connection: client.connection, resource }), drafts, initializeEmpty: false,
    onConflict: () => ({ kind: 'needs-review', reason: 'fixture' }), currentSession: () => client.currentSession(),
  });
  try {
    expect((await client.start()).ok).toBe(true);
    expect((await state.start()).ok).toBe(true);
    expect(state.edit('retain-local-intent').ok).toBe(true);
    source.failNextLoad();
    expect((await state.reconnect()).ok).toBe(false);
    expect(source.calls.load).toBe(2);
    expect(state.getSnapshot()).toMatchObject({ status: 'blocked', reason: 'storage-error', draft: { desired: 'retain-local-intent' } });
    // No setRealtimeState hop: this is the explicit controller recovery path.
    expect((await state.reconnect()).ok).toBe(true);
    expect(source.calls.load).toBe(3);
    expect(native.connection.getHealth().state.status).toBe('healthy');
    expect(state.getSnapshot()).toMatchObject({ status: 'ready', desired: 'retain-local-intent', dirty: true });
    expect(source.calls.save).toHaveLength(0);
  } finally { state.dispose(); client.dispose(); native.dispose(); }
});
