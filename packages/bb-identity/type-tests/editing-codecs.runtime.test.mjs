import assert from 'node:assert/strict';
import test from 'node:test';
import { editingCodecs, EDITING_PROTOCOL, EDITING_LIMITS } from '../editing-runtime.js';
import { stateCodecs } from '../state-runtime.js';
import { ok, fail, codec, address, expected, read, receipt, rejected } from './editing-fixtures.mjs';
const request = { protocol: EDITING_PROTOCOL, target: 'shared-map-1', mutation: { kind: 'replace', address, expectedVersion: { epoch: 'map-incarnation', sequence: 1 },
  expected, ownerSession: 'owner-a1', localGeneration: 1, operationId: 'op-a1', schemaVersion: 1, value: 'A' } };
const codecs = editingCodecs(codec, codec);
test('v1 codecs roundtrip exact saved/rejected receipt and retained B+pending A', () => {
  for (const result of [receipt(request), rejected(request)]) assert.deepEqual(codecs.receipt.decode(codecs.receipt.encode(result)), ok(result));
  const draft = { protocol: EDITING_PROTOCOL, target: request.target, rejection: null,
    draft: { formatVersion: 1, key: { address, actor: expected.actor, ownerSession: 'owner-a3' }, schemaVersion: 1,
      acknowledged: read('base'), desired: 'B', localGeneration: 2, inFlight: request.mutation } };
  assert.deepEqual(codecs.draft.decode(codecs.draft.encode(draft)), ok(draft));
  assert.equal(codecs.request.decode({ ...request, extra: true }).ok, false);
  assert.equal(codecs.request.decode({ ...request, protocol: 'bb-identity.editing/v2' }).ok, false);
  assert.equal(codecs.request.decode({ ...request, mutation: { ...request.mutation, address: { ...address, owner: 'shared:fake' } } }).ok, false);
});
test('legacy state protocol rejects new outcomes; malformed real rejections never become final', () => {
  assert.equal(stateCodecs(codec).save.decode({ status: 'rejected', operationId: request.mutation.operationId, diagnostics: [] }).ok, false);
  for (const diagnostics of [[], Array(EDITING_LIMITS.diagnostics + 1).fill({ code: 'x', message: 'x' }), [{ code: 'x', message: '' }], [{ code: 'x', message: 'x', path: [-1] }]]) {
    assert.equal(codecs.receipt.decode({ ...rejected(request), outcome: { ...rejected(request).outcome, diagnostics } }).ok, false);
  }
  assert.equal(codecs.receipt.decode({ ...rejected(request), outcome: { ...rejected(request).outcome, operationId: 'other' } }).ok, false);
});
test('typed value and target codecs are encoded once, not decoded as typed values', () => {
  const typed = { encode: input => input.text, decode: input => typeof input === 'string' ? ok({ text: input }) : fail() };
  const c = editingCodecs(typed, typed);
  const typedRequest = { ...request, target: { text: 'map-1' }, mutation: { ...request.mutation, value: { text: 'A' } } };
  assert.deepEqual(c.request.decode(c.request.encode(typedRequest)), ok(typedRequest));
});

test('encoders preserve protocol metadata for boundary rejection instead of rewriting it', () => {
  for (const foreign of [{ ...rejected(request), protocol: 'bb-identity.editing/v9' },
    rejected({ ...request, protocol: 'bb-identity.editing/v9' })]) {
    assert.equal(codecs.receipt.decode(foreign).ok, false);
    assert.equal(codecs.receipt.decode(codecs.receipt.encode(foreign)).ok, false);
    assert.equal(codecs.lookup.decode(codecs.lookup.encode({ status: 'final', outcome: foreign })).ok, false);
  }
  assert.equal(codecs.save.decode(codecs.save.encode({ protocol: 'bb-identity.editing/v9', status: 'indeterminate', operationId: request.mutation.operationId })).ok, false);
});
test('rejection checkpoint consistency checks schema, generation, and retirement without reauthoring A1', () => {
  const draft = { protocol: EDITING_PROTOCOL, target: request.target, rejection: rejected(request),
    draft: { formatVersion: 1, key: { address, actor: expected.actor, ownerSession: 'owner-a3' }, schemaVersion: 1,
      acknowledged: read('base'), desired: 'B', localGeneration: 2, inFlight: null } };
  assert.equal(codecs.draft.decode(codecs.draft.encode(draft)).ok, true);
  for (const change of [copy => { copy.protocol = 'bb-identity.editing/v9'; },
    copy => { copy.rejection.protocol = 'bb-identity.editing/v9'; },
    copy => { copy.rejection.request.protocol = 'bb-identity.editing/v9'; },
    copy => { copy.rejection.request.mutation.localGeneration = 99; },
    copy => { copy.rejection.request.mutation.schemaVersion = 9; },
    copy => { copy.draft.inFlight = request.mutation; }]) {
    const inconsistent = structuredClone(draft); change(inconsistent);
    assert.equal(codecs.draft.decode(inconsistent).ok, false); assert.equal(codecs.draft.decode(codecs.draft.encode(inconsistent)).ok, false);
  }
});

test('public scope codec loads real actor draft scope and explicit shared Target without a mutation', () => {
  const scope = { draftAddress: address, schemaVersion: 1, target: 'shared-map-1', expected };
  assert.deepEqual(codecs.scope.decode(codecs.scope.encode(scope)), ok(scope));
  assert.equal(codecs.scope.decode(scope).value.expected.session, expected.session);
  assert.deepEqual(Object.keys(codecs.scope.encode(scope)).sort(), ['draftAddress', 'expected', 'schemaVersion', 'target']);
  for (const change of [copy => { copy.draftAddress.owner = 'shared:fake-map-owner'; },
    copy => { copy.draftAddress.instanceId = ''; }, copy => { copy.draftAddress.pluginId = 'bad id'; },
    copy => { copy.draftAddress.collection = ''; }, copy => { copy.draftAddress.recordId = ''; },
    copy => { copy.draftAddress.owner = ''; copy.expected.actor = ''; },
    copy => { copy.expected.session = 'session with spaces'; },
    copy => { copy.schemaVersion = -1; }, copy => { copy.schemaVersion = 1.5; }, copy => { copy.schemaVersion = Number.MAX_SAFE_INTEGER + 1; },
    copy => { copy.schemaVersion = '1'; }, copy => { copy.target = null; },
    copy => { copy.operationId = 'fabricated'; }, copy => { copy.draftAddress.extra = true; }, copy => { copy.expected.extra = true; }]) {
    const malformed = structuredClone(scope); change(malformed); assert.equal(codecs.scope.decode(malformed).ok, false);
  }
  assert.equal(codecs.scope.decode({ ...scope, target: 'x'.repeat(EDITING_LIMITS.bytes) }).ok, false);
});
test('scope codec preserves typed Target wire conversion and exact opaque session bytes', () => {
  const typed = { encode: input => input.name, decode: input => typeof input === 'string' ? ok({ name: input }) : fail() };
  const c = editingCodecs(codec, typed);
  const scope = { draftAddress: address, schemaVersion: 0, target: { name: 'map%2F1' }, expected: { ...expected, session: 'person%3Auser%2Fsession/0001' } };
  assert.deepEqual(c.scope.decode(c.scope.encode(scope)), ok(scope));
  const wrongOwner = { ...scope, draftAddress: { ...address, owner: 'another:actor' } };
  assert.equal(c.scope.decode(c.scope.encode(wrongOwner)).ok, false);
});
