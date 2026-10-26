import assert from 'node:assert/strict';
import { createIdentityEditingState, EDITING_PROTOCOL } from '../editing-runtime.js';
import { createManualClock, deferred } from '../testing-runtime.js';
export const ok = value => ({ ok: true, value });
export const fail = () => ({ ok: false, error: { code: 'unavailable', message: 'offline', retry: 'after-reconnect' } });
export const codec = { encode: value => value, decode: value => typeof value === 'string' ? ok(value) : fail() };
export const address = { instanceId: 'instance-1', pluginId: 'plugin-1', collection: 'editor', recordId: 'map1', owner: 'person:a' };
export const expected = { actor: 'person:a', session: 'session:a/opaque%2F' };
export const read = (value, sequence = 1) => ({ status: 'present', envelope: { address, version: { epoch: 'map-incarnation', sequence }, schemaVersion: 1, value, lastEditedBy: null } });
export const receipt = (request, value = request.mutation.value, sequence = 2) => ({ protocol: EDITING_PROTOCOL, request, outcome: { status: 'saved', envelope: read(value, sequence).envelope, operationId: request.mutation.operationId } });
export const rejected = request => ({ protocol: EDITING_PROTOCOL, request, outcome: { status: 'rejected', operationId: request.mutation.operationId, diagnostics: [{ code: 'invalid-source', message: 'Correct this source.', path: ['source', 0] }] } });
export const settle = () => new Promise(resolve => setImmediate(resolve));
export function fixture(options = {}) {
  const clock = createManualClock(); const saves = []; const lookups = []; const writes = []; const loads = []; let notify;
  let session = { status: 'ready', instanceId: 'instance-1', actor: { identity: { kind: 'person', key: 'person:a' } }, stamp: options.sessionStamp ?? expected.session };
  let remote = read('base'); let lookup = { status: 'pending' }; let writeFails = false;
  const drafts = options.noDrafts ? undefined : { find: async () => ok(options.candidates ?? []), write: async (draft, revision) => {
    writes.push(draft); if (writeFails) return fail(); return ok({ draft, revision: (revision ?? 0) + 1 });
  }, remove: async () => ok(undefined) };
  const transport = { protocol: EDITING_PROTOCOL,
    load: async () => { loads.push(remote); return options.load ? options.load() : ok(remote); },
    save: request => { const response = deferred(); saves.push({ request, response }); return response.promise; },
    reconcile: async request => { lookups.push(request); return options.lookup ? options.lookup(request) : ok(lookup); },
    subscribe: (_scope, listener) => { notify = listener; return () => { notify = undefined; }; },
  };
  const state = createIdentityEditingState({ draftAddress: address, target: 'shared-map-1', targetCodec: codec, expected: { ...expected, session: options.sessionStamp ?? expected.session },
    ownerSession: options.ownerSession ?? 'owner-a', definition: { collection: 'editor', schemaVersion: 1, codec,
      initialValue: () => '', equal: (a,b) => a === b }, transport, ...(drafts ? { drafts } : {}), scheduler: clock,
    onConflict: () => ({ kind: 'needs-review', reason: 'review' }), initializeEmpty: false, currentSession: () => ok(session) });
  return { state, saves, lookups, writes, loads, clock, setLookup: value => { lookup = value; }, setRemote: value => { remote = value; },
    failWrites: value => { writeFails = value; }, setSession: value => { session = value; },
    notify: sequence => notify?.({ address, version: { epoch: 'map-incarnation', sequence }, operationId: null }) };
}
export async function submit(f, text = 'A') { assert.equal(f.state.edit(text).ok, true); const flushing = f.state.flush(); await settle(); assert.equal(f.saves.length, 1); return { flushing, request: f.saves[0].request }; }
