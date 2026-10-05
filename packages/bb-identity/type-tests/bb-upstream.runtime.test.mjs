import assert from 'node:assert/strict';
import test from 'node:test';
import { createHostAdapter, serverSessionCodec } from '../host-runtime.ts';
import { createIdentityServer } from '../server-runtime.ts';
import { createBbUpstreamDriver, renderExternalPrompt } from '../bb-upstream-runtime.ts';
import { profileCodec, provenanceCodec } from '../model-runtime.ts';

const scheduler = { now: () => 0, schedule: () => () => {} };
function deferred() {
  let resolve;
  const promise = new Promise((next) => { resolve = next; });
  return { promise, resolve };
}
function newSend(operationId = 'op-1', mode = 'start') {
  return { operationId, threadId: 'thread-1', mode, input: [{ type: 'text', text: 'before', mentions: [] }] };
}
function fakeBb() {
  const calls = { sends: [], rpc: [], hooks: [] };
  let send = async () => ({ ok: true });
  let rpc = async () => ({ accepted: true });
  return {
    calls,
    setSend(next) { send = next; },
    setRpc(next) { rpc = next; },
    bb: {
      pluginId: 'thread-progress',
      sdk: {
        threads: { send: (input) => { calls.sends.push(input); return send(input); } },
        plugins: { callRpc: async (input) => { calls.rpc.push(input); return rpc(input); } },
      },
      onDispose(hook) { calls.hooks.push(hook); },
    },
  };
}
const expected = { actor: 'local:local', session: 'singleton:local' };

test('only issued contexts open scopes, and background scopes carry machine attribution', async () => {
  const fixture = fakeBb(); const created = createBbUpstreamDriver({ bb: fixture.bb, scheduler });
  assert.equal(created.ok, true); if (!created.ok) return;
  const { driver } = created.value;
  const forged = { origin: 'interactive-user', signal: new AbortController().signal };
  assert.equal((await driver.openScope(forged)).ok, false);
  const background = created.value.issue('background'); const external = created.value.issue('external');
  const backgroundSession = await driver.session(background);
  assert.equal(backgroundSession.status, 'ready'); if (backgroundSession.status !== 'ready') return;
  assert.equal(backgroundSession.actor.identity.kind, 'machine');
  assert.equal(backgroundSession.actor.evidence, 'machine');
  assert.equal(backgroundSession.actor.identity.key, 'p6r-machine:v1:local:server');
  const backgroundProfile = await driver.selfProfile(background);
  assert.equal(backgroundProfile.ok, true); if (!backgroundProfile.ok) return;
  assert.equal(backgroundProfile.value.identity.kind, 'machine');
  assert.equal(backgroundProfile.value.identity.key, 'p6r-machine:v1:local:server');
  const backgroundOpen = await driver.openScope(background); const externalOpen = await driver.openScope(external);
  assert.equal(backgroundOpen.ok, true); if (!backgroundOpen.ok) return;
  assert.equal(backgroundOpen.value.validate({ actor: 'p6r-machine:v1:local:server', session: expected.session }).ok, true);
  assert.equal(externalOpen.ok, false); assert.equal(externalOpen.error.code, 'unauthenticated');
  const invocation = created.value.issue('interactive-user');
  const exposed = await driver.session(invocation);
  assert.equal(exposed.status, 'ready'); if (exposed.status !== 'ready') return;
  assert.equal(Object.isFrozen(exposed.actor.identity), true);
  assert.equal(Reflect.set(exposed.actor.identity, 'key', 'foreign'), false);
  const first = await driver.openScope(invocation); assert.equal(first.ok, true); if (!first.ok) return;
  assert.equal(first.value.validate(expected).ok, true);
  assert.equal(first.value.validate({ actor: 'foreign', session: expected.session }).ok, false);
  const second = await driver.openScope(invocation); assert.equal(second.ok, true); if (!second.ok) return;
  // Independent child scopes: releasing one PersonRequest cannot revoke another.
  first.value.release(); assert.equal(first.value.signal.aborted, true); assert.equal(second.value.signal.aborted, false);
  assert.equal(second.value.validate(expected).ok, true);
  created.value.release(invocation); assert.equal(second.value.signal.aborted, true);
});

test('machine identity codecs preserve explicit machine evidence and reject relabeling', () => {
  const machine = { kind: 'machine', key: 'machine:fixture', instanceId: 'fixture', hostId: null };
  const presentation = { displayName: 'BB machine', handle: null, avatarUrl: null };
  const profile = profileCodec.decode({ identity: machine, presentation, revision: 'revision-1', status: 'current' });
  assert.equal(profile.ok, true);
  const session = {
    status: 'ready', instanceId: 'fixture', mode: 'multi-user',
    actor: { identity: machine, presentation, evidence: 'machine' },
    stamp: 'session-1',
    capabilities: {
      requestIdentity: 'host-resolved', acceptance: 'transactional-check', forwarding: 'host-bound',
      directory: { search: false, lookup: false }, participants: false, externalSend: 'structured',
      toolProvenance: 'causal', operationLookup: true,
    },
  };
  assert.equal(serverSessionCodec.decode(session).ok, true);
  assert.equal(serverSessionCodec.decode({ ...session, actor: { ...session.actor, evidence: 'provider-verified' } }).ok, false);
  const reference = { threadId: 'thread-1', contributionId: 'contribution-1' };
  const contribution = {
    reference, author: { kind: 'machine', actor: { identity: machine, presentation, evidence: 'machine' } },
    latestEditor: { identity: machine, presentation, evidence: 'machine' }, acceptedAt: '2026-09-09T00:00:00.000Z', mentionedPeople: [],
  };
  assert.equal(provenanceCodec.decode({
    status: 'known',
    correlation: { threadId: 'thread-1', turnId: 'turn-1', attemptId: 'attempt-1', toolCallId: null },
    inputGroups: [{ sources: [{ kind: 'contribution', reference }] }],
    contributions: [contribution],
  }).ok, true);
});

test('snapshots valid text before send, accepts legacy response, preserves newer nested queue IDs, and keeps ambiguity', async () => {
  const fixture = fakeBb(); const created = createBbUpstreamDriver({ bb: fixture.bb, scheduler }).value;
  const waiting = deferred(); fixture.setSend(() => waiting.promise);
  const input = newSend(); const pending = created.driver.submit(input); input.input[0].text = 'mutated';
  assert.equal(fixture.calls.sends[0].input[0].text, 'before');
  waiting.resolve({ ok: true });
  const legacy = await pending;
  assert.equal(legacy.status, 'submitted'); assert.deepEqual(legacy.receipt.native, { deliveryId: null, queuedMessageId: null, turnId: null });
  fixture.setSend(async () => ({ ok: true, delivery: 'queued', queuedMessage: { id: 'queue-1' } }));
  const queued = await created.driver.submit(newSend('op-2'));
  assert.equal(queued.status, 'submitted'); assert.equal(queued.receipt.native.queuedMessageId, 'queue-1');
  fixture.setSend(async () => ({ ok: true, delivery: 'queued', queuedMessage: {} }));
  const unrecognized = await created.driver.submit(newSend('op-3'));
  assert.equal(unrecognized.status, 'indeterminate');
  fixture.setSend(async () => { throw Error('response lost'); });
  const uncertain = await created.driver.submit(newSend('op-4'));
  assert.equal(uncertain.status, 'indeterminate'); assert.equal(uncertain.operationId, 'op-4');
  const invalid = await created.driver.submit({ ...newSend('op-5'), input: [{ type: 'text', text: 3 }] });
  assert.equal(invalid.status, 'rejected'); assert.equal(fixture.calls.sends.length, 4);
});

test('passes auto through to the installed SDK without coercing its active-or-idle semantics', async () => {
  const fixture = fakeBb(); const created = createBbUpstreamDriver({ bb: fixture.bb, scheduler }).value;
  const outcome = await created.driver.submit(newSend('op-auto', 'auto'));
  assert.equal(outcome.status, 'submitted');
  assert.equal(fixture.calls.sends.length, 1);
  assert.equal(fixture.calls.sends[0].mode, 'auto');
});

test('external labeling only normalizes and registers provenance; host rendering is explicit', async () => {
  const fixture = fakeBb(); const created = createBbUpstreamDriver({ bb: fixture.bb, scheduler }).value;
  const author = { subject: 'webhook-7', presentation: { displayName: 'Webhook<source>', handle: null, avatarUrl: null } };
  const raw = newSend().input;
  const labelled = created.driver.labelExternal(author, raw);
  assert.deepEqual(labelled, raw);
  assert.equal(labelled[0].visibility, undefined);
  const outcome = await created.driver.submit({ ...newSend('op-6'), input: labelled });
  assert.equal(outcome.status, 'submitted'); assert.equal(outcome.receipt.provenance, 'source-labelled');
  const rendered = renderExternalPrompt('thread-progress', author, raw);
  const text = rendered.filter((part) => part.type === 'text').map((part) => part.text).join('');
  assert.match(text, /\[sender=thread-progress:Webhook%3Csource%3E\]/);
  assert.doesNotMatch(text, /webhook-7/u);
  assert.doesNotMatch(text, /<thread-progress:/u);
});

test('PersonRequest.callPlugin uses the SDK output boundary and rejects malformed output through its supplied codec', async () => {
  const fixture = fakeBb(); const created = createBbUpstreamDriver({ bb: fixture.bb, scheduler }).value;
  const host = createHostAdapter({ upstream: created.driver, extension: { status: 'absent' } });
  const server = createIdentityServer({ host }); const invocation = created.issue('interactive-user');
  const opened = await server.personRequest(invocation); assert.equal(opened.ok, true); if (!opened.ok) return;
  const output = {
    decode(value) { return value && value.accepted === true ? { ok: true, value: 'accepted' } : { ok: false, error: { code: 'incompatible', message: 'Invalid plugin output.', retry: 'never' } }; },
    encode(value) { return value; },
  };
  const first = await opened.value.callPlugin({ pluginId: 'notifications', method: 'publish.message', payload: { nested: { value: 'before' } }, output });
  assert.deepEqual(first, { ok: true, value: 'accepted' }); assert.equal(fixture.calls.rpc[0].outputSchema.safeParse(undefined).success, true);
  fixture.setRpc(async () => ({ malformed: true }));
  const second = await opened.value.callPlugin({ pluginId: 'notifications', method: 'publish.message', payload: {}, output });
  assert.equal(second.ok, false); assert.equal(second.error.code, 'incompatible');
  opened.value.dispose(); server.dispose(); host.dispose();
});

test('disposed driver rejects new submit without calling SDK, but does not retract an already-dispatched completion', async () => {
  const fixture = fakeBb(); const created = createBbUpstreamDriver({ bb: fixture.bb, scheduler }).value;
  const waiting = deferred(); fixture.setSend(() => waiting.promise);
  const pending = created.driver.submit(newSend('op-7')); assert.equal(fixture.calls.sends.length, 1);
  fixture.calls.hooks[0]();
  const after = await created.driver.submit(newSend('op-8'));
  assert.equal(after.status, 'rejected'); assert.equal(after.error.code, 'disposed'); assert.equal(fixture.calls.sends.length, 1);
  waiting.resolve({ ok: true, delivery: 'sent' });
  assert.equal((await pending).status, 'submitted');
});
