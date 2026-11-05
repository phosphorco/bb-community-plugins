import assert from 'node:assert/strict';
import test from 'node:test';
import { createIdentityEditingState, bindIdentityEditingState, EDITING_PROTOCOL } from '../editing-runtime.js';
import { createIdentityView } from '../client-view-runtime.js';
import { createDraftRetirementOwner } from '../draft-retirement-runtime.js';
import { deferred } from '../testing-runtime.js';
import { ok, fail, codec, settle } from './editing-fixtures.mjs';
const session = (actor = 'a', stamp = `${actor}1`) => ({ status: 'ready', instanceId: 'host', mode: 'multi-user', stamp,
  actor: { identity: { kind: 'person', key: `person:${actor}`, issuer: 'issuer', subject: actor }, presentation: { displayName: actor, handle: null, avatarUrl: null }, evidence: 'provider-verified' }, capabilities: { directory: { search: false, lookup: false } } });
function fixture() {
  let current = session(); const listeners = new Set(); const checkpoints = []; const controllers = []; const requests = []; const losses = [];
  let writeGate = null; let lookupGate = null; let failWrite = false;
  const client = { getSnapshot: () => current, currentSession: () => ok(current), subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    connection: { getHealth: () => ({ state: { status: 'healthy' } }), subscribeHealth: () => () => {}, revalidate: async () => ok(undefined) } };
  const view = createIdentityView({ client }); const retirement = createDraftRetirementOwner();
  const drafts = { find: async () => { if (lookupGate) await lookupGate.promise; return ok(checkpoints); },
    write: async (draft, revision) => { if (writeGate) await writeGate.promise; if (failWrite) return fail();
      const result = { revision: (revision ?? 0) + 1, draft }; checkpoints.push(result); return ok(result); }, remove: async () => ok(undefined) };
  const createBinding = (target = 'map-1') => bindIdentityEditingState({ client, view, target, targetCodec: codec, resourceKey: 'source-editor-v1',
    onUnpersistedDraft: (draft, error) => losses.push({ draft, error }),
    create({ session, ownerSession }) {
      const address = { instanceId: session.instanceId, pluginId: 'plugin', collection: 'editor', recordId: target, owner: session.actor.identity.key };
      const read = () => ({ status: 'present', envelope: { address, version: { epoch: 'map-epoch', sequence: 1 }, schemaVersion: 1, value: 'base', lastEditedBy: null } });
      const state = createIdentityEditingState({ draftAddress: address, target, targetCodec: codec,
        expected: { actor: session.actor.identity.key, session: session.stamp }, ownerSession,
        definition: { collection: 'editor', schemaVersion: 1, codec, initialValue: () => '', equal: (a,b) => a === b }, drafts,
        transport: { protocol: EDITING_PROTOCOL, load: async () => ok(read()), subscribe: () => () => {}, reconcile: async request => { requests.push(request); if (lookupGate) return lookupGate.promise; return ok({ status: 'pending' }); },
          save: request => { const next = deferred(); requests.push({ request, next, read }); return next.promise; } },
        initializeEmpty: false, onConflict: () => ({ kind: 'needs-review', reason: 'review' }), currentSession: () => client.currentSession() });
      controllers.push(state); return state;
    },
  }, retirement);
  return { client, view, retirement, createBinding, controllers, requests, checkpoints, losses,
    setSession(next) { current = next; for (const listener of [...listeners]) listener(); },
    holdWrite() { writeGate = deferred(); return writeGate; }, failWrite() { failWrite = true; },
    holdLookup() { lookupGate = deferred(); return lookupGate; }, close() { view.dispose(); retirement.dispose(); } };
}
test('actual editing binding owns A1/B2/A3 and fences a late A1 receipt', async () => {
  const f = fixture(); const binding = f.createBinding(); await settle(); const owner1 = binding.currentOwnerSession(); binding.edit('A');
  const saving = binding.flush(); await settle(); const sent = f.requests[0]; binding.edit('B');
  f.setSession(session('b', 'b2')); await settle(); const owner2 = binding.currentOwnerSession(); assert.notEqual(owner2, owner1);
  f.setSession(session('a', 'a3')); await settle(); const owner3 = binding.currentOwnerSession(); assert.notEqual(owner3, owner1); assert.notEqual(owner3, owner2);
  sent.next.resolve(ok({ protocol: EDITING_PROTOCOL, request: sent.request, outcome: { status: 'saved', operationId: sent.request.mutation.operationId, envelope: { ...sent.read().envelope, value: 'A', version: { epoch: 'map-epoch', sequence: 2 } } } }));
  assert.equal((await saving).ok, false); assert.equal(binding.getSnapshot().desired, 'base'); assert.equal((await binding.checkpoint(owner1)).ok, false);
  const original = f.checkpoints.find(cp => cp.draft.draft.desired === 'B'); assert.equal(original.draft.target, 'map-1'); assert.equal(original.draft.draft.inFlight.ownerSession, owner1);
  binding.dispose(); f.close();
});
test('target replacement retires full draft and callback failure retains Target', async () => {
  const f = fixture(); const first = f.createBinding('map-1'); await settle(); first.edit('B'); f.failWrite(); first.dispose();
  const next = f.createBinding('map-2'); await settle(); assert.equal(next.getSnapshot().scope.target, 'map-2');
  assert.equal(f.losses.length, 1); assert.equal(f.losses[0].draft.target, 'map-1'); assert.equal(f.losses[0].draft.draft.desired, 'B'); next.dispose(); f.close();
});
test('replacement same actor/address/Target waits for old preservation, without new identity RPC', async () => {
  const f = fixture(); const first = f.createBinding(); await settle(); first.edit('B'); const held = f.holdWrite(); first.dispose();
  const next = f.createBinding(); await settle(); let finished = false;
  const candidates = next.recoveryCandidates(next.currentOwnerSession()).then(result => { finished = true; return result; });
  await settle(); assert.equal(finished, false); held.resolve(); const found = await candidates;
  assert.equal(found.ok, true); assert.equal(found.value.some(cp => cp.draft.draft.desired === 'B'), true); next.dispose(); f.close();
});
