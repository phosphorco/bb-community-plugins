import { expect, test } from 'bun:test';
import { createBbIdentityServerBinding } from '../bb-binding-runtime.ts';
import { identityRoutes, identityRpcMethods, identityStateRoutes, identityStateRpcMethods } from '../rpc-routes-runtime.ts';

const ok = value => ({ ok: true, value });
const error = (code, message = code) => ({ ok: false, error: { code, message, retry: 'never' } });
const schema = { '~standard': { version: 1, vendor: 'test', validate: value => ({ value }) } };
const text = { decode: value => typeof value === 'string' ? ok(value) : error('invalid-input'), encode: value => value };
const actor = { identity: { kind: 'person', key: 'person:actor', issuer: 'issuer', subject: 'actor' }, presentation: { displayName: 'Actor', handle: null, avatarUrl: null }, evidence: 'provider-verified' };
const collaborator = { issuer: 'issuer', subject: 'collaborator', presentation: { displayName: 'Collaborator', handle: null, avatarUrl: null }, status: 'current' };
const expected = { actor: actor.identity.key, session: 'session-r1' };

function fixture({ producerRendering = 'supported' } = {}) {
  const native = new Map(); const counters = { accept: 0, acceptedModes: [], acceptedInputs: [], directory: 0, lookup: 0, participants: 0, attempts: 0, register: 0, provenance: 0, producerRendering: 0 };
  let malformedAttempt = false;
  let lookupResult = null;
  let activeScope = null;
  const session = { status: 'ready', instanceId: 'binding-review', mode: 'multi-user', actor, stamp: expected.session, capabilities: {
    requestIdentity: 'host-resolved', acceptance: 'transactional-check', forwarding: 'host-bound', directory: { search: true, lookup: true },
    participants: true, externalSend: 'structured', toolProvenance: 'causal', operationLookup: true,
  } };
  const scope = () => { const controller = new AbortController(); activeScope = controller; return { signal: controller.signal, validate: () => controller.signal.aborted ? { ok: false, code: 'invalidated' } : { ok: true }, release: () => controller.abort() }; };
  const source = () => ({
    issuers: ['issuer'], generation: 'provider-r1',
    person(issuer, subject) { return issuer === 'issuer' && typeof subject === 'string' ? ok({ kind: 'person', key: `p6r-person:v1:${encodeURIComponent(issuer)}:${encodeURIComponent(subject)}`, issuer, subject }) : error('invalid-input'); },
    async directory() { counters.directory++; return ok({ records: [collaborator], nextCursor: null, revision: 'directory-r1' }); },
    async lookup(subjects) { counters.lookup++; if (lookupResult !== null) return ok(lookupResult); return ok({ revision: 'directory-r1', records: subjects.map(({ issuer, subject }) => ({ issuer, subject, record: subject === 'collaborator' ? collaborator : null })) }); },
  });
  const protocol = {
    version: 1, instanceId: 'binding-review',
    ...(producerRendering === 'supported'
      ? { experimental_useProducerMessageRendering() { counters.producerRendering++; } }
      : producerRendering === 'invalid'
        ? { experimental_useProducerMessageRendering: true }
        : producerRendering === 'throws'
          ? { experimental_useProducerMessageRendering() { counters.producerRendering++; throw Error('rendering hook failure'); } }
          : producerRendering === 'returns'
            ? { experimental_useProducerMessageRendering() { counters.producerRendering++; return Promise.resolve(); } }
            : {}),
    bindInvocation({ handler }) { let retired = false; return { registration: { generation: 'rpc-r1', status: 'active', dispose() { retired = true; } }, handler: input => { if (retired) throw Error('retired'); return handler({ request: {}, scope: scope() }, input); } }; },
    async session() { return session; }, async selfProfile() { return ok({ identity: actor.identity, presentation: actor.presentation, revision: 'self-r1', status: 'current' }); },
    async openRequest() { const requestScope = scope(); return ok({ signal: requestScope.signal, session, validate: input => input.actor === expected.actor && input.session === expected.session ? ok(undefined) : error('stale-context'), release: () => requestScope.release(), scope: requestScope }); },
    async accept(input) { counters.accept++; counters.acceptedModes.push(input.input.mode); counters.acceptedInputs.push(input); return { status: 'submitted', receipt: { evidence: 'host-accepted', operationId: input.input.operationId, acceptedAt: '2026-09-06T00:00:00.000Z', references: [], native: { deliveryId: null, queuedMessageId: null, turnId: null }, provenance: 'structured', deduplication: 'guaranteed', retainedUntil: '2026-09-07T00:00:00.000Z' } }; },
    async lookup() { return ok({ status: 'unknown', reason: 'unsupported' }); },
    async provenance() { counters.provenance++; return ok({ status: 'known', correlation: { threadId: 'thread-r1', turnId: 'turn-r1', attemptId: 'attempt-r1', toolCallId: null }, inputGroups: [], contributions: [] }); },
    async historyContributions() { return ok({ status: 'known', items: [], nextCursor: null, traversal: 'complete', missing: [] }); },
    async historyAttempts() { counters.attempts++; return ok({ status: 'known', items: [malformedAttempt ? { status: 'known', inputGroups: [], contributions: [] } : { status: 'known', correlation: { threadId: 'thread-r1', turnId: 'turn-r1', attemptId: 'attempt-r1', toolCallId: null }, inputGroups: [], contributions: [] }], nextCursor: null, traversal: 'complete', missing: [] }); },
    directorySources() { return [source()]; },
    async participants() { counters.participants++; return ok({ items: [{ identity: actor.identity, presentation: actor.presentation, roles: ['author'] }], nextCursor: null, revision: 'participants-r1', coverage: 'complete-history' }); },
    async forwardRpc(_scope, _destination, input) { return input; }, async registerProvider() { counters.register++; return error('unsupported'); }, subscribe() { return () => {}; },
  };
  const bb = { pluginId: 'feature', experimental_p6rIdentity: protocol, rpc: { register(contract, handlers) { for (const method of Object.keys(contract)) native.set(method, handlers[method]); } }, realtime: { publish() {} }, onDispose() {}, sdk: { threads: { async send() { return { ok: true }; } }, plugins: { async callRpc() { return {}; } } } };
  return { bb, counters, native, setLookupResult(value) { lookupResult = value; }, expireActiveScope() { activeScope?.abort(); }, setMalformedAttempt(value) { malformedAttempt = value; } };
}

test('public enhanced binding reaches normalized directory/participant callbacks and preserves collaborator read-only state', async () => {
  const f = fixture(); const created = createBbIdentityServerBinding({ bb: f.bb });
  expect(created.ok).toBe(true); if (!created.ok) return;
  const binding = created.value;
  const storage = { boundary: 'same-process-synchronous', receiptRetentionMs: 60_000,
    async read(address) { return ok({ status: 'empty', address, version: { epoch: 'empty', sequence: 0 } }); },
    async commit() { throw Error('foreign write reached storage'); }, async reconcile() { return ok({ status: 'unknown', reason: 'unavailable' }); },
  };
  try {
    const resource = { pluginId: 'feature', definition: { collection: 'preferences', schemaVersion: 1, codec: text, initialValue: () => '', equal: (left, right) => left === right } };
    expect(binding.state.register({ resource, storage, policy: { kind: 'self-only' }, readPolicy: { kind: 'collaborators' } }).ok).toBe(true);
    const direct = await f.native.get(identityRpcMethods[identityRoutes.profiles])({ keys: ['p6r-person:v1:issuer:collaborator'] });
    expect(direct).toMatchObject({ ok: true, value: [{ status: 'found', key: 'p6r-person:v1:issuer:collaborator' }] });
    const search = await f.native.get(identityRpcMethods[identityRoutes.search])({ query: 'collab', kinds: ['person'], history: 'current', limit: 10 });
    expect(search).toMatchObject({ ok: true, value: { items: [{ identity: { key: 'p6r-person:v1:issuer:collaborator' } }] } });
    const profiles = await f.native.get(identityRpcMethods[identityRoutes.profiles])({ keys: ['p6r-person:v1:issuer:collaborator'] });
    expect(profiles).toMatchObject({ ok: true, value: [{ status: 'found', key: 'p6r-person:v1:issuer:collaborator' }] });
    const participants = await f.native.get(identityRpcMethods[identityRoutes.participants])({ threadId: 'thread-r1', limit: 10 });
    expect(participants).toMatchObject({ ok: true, value: { items: [{ identity: { key: 'person:actor' } }] } });
    expect(f.counters).toMatchObject({ directory: 1, lookup: 2, participants: 1 });
    const address = { instanceId: 'binding-review', pluginId: 'feature', collection: 'preferences', recordId: 'theme', owner: 'p6r-person:v1:issuer:collaborator' };
    const read = await f.native.get(identityStateRpcMethods[identityStateRoutes.load])({ address, expected });
    expect(read).toMatchObject({ ok: true, value: { status: 'empty', address } });
    const write = await f.native.get(identityStateRpcMethods[identityStateRoutes.save])({ kind: 'replace', address, expected, expectedVersion: { epoch: 'empty', sequence: 0 }, ownerSession: 'owner-r1', localGeneration: 1, operationId: 'operation-r1', schemaVersion: 1, value: 'dark' });
    expect(write.ok).toBe(false);
  } finally { binding.dispose(); }
});

test('public history validates known evidence and disposal rejects new lifecycle work without raw calls', async () => {
  const f = fixture(); const created = createBbIdentityServerBinding({ bb: f.bb });
  expect(created.ok).toBe(true); if (!created.ok) return;
  const binding = created.value;
  const valid = await binding.server.history.attempts({ kind: 'operation', operationId: 'operation-r1', limit: 10 });
  expect(valid).toMatchObject({ ok: true, value: { status: 'known' } });
  f.setMalformedAttempt(true);
  const malformed = await binding.server.history.attempts({ kind: 'operation', operationId: 'operation-r1', limit: 10 });
  expect(malformed.ok).toBe(false);
  const provenance = await binding.toolProvenance({});
  expect(provenance).toMatchObject({ ok: true, value: { status: 'known' } });
  binding.dispose();
  const external = await binding.server.sendExternal({ subject: 'webhook-r1', presentation: { displayName: 'Webhook', handle: null, avatarUrl: null } }, { operationId: 'operation-r2', threadId: 'thread-r1', mode: 'start', input: ['hello'] });
  const registration = await binding.registerProvider({ issuers: ['issuer'], async resolve() { return { status: 'not-applicable' }; } });
  const disposedHistory = await binding.server.history.attempts({ kind: 'operation', operationId: 'operation-r1', limit: 10 });
  expect(external).toMatchObject({ status: 'rejected', error: { code: 'disposed' } });
  expect(registration).toMatchObject({ ok: false, error: { code: 'disposed' } });
  expect(disposedHistory).toMatchObject({ ok: false, error: { code: 'disposed' } });
  expect(f.counters).toMatchObject({ accept: 0, register: 0, attempts: 2 });
});

test('enhanced external send preserves auto for the host protocol', async () => {
  const f = fixture(); const created = createBbIdentityServerBinding({ bb: f.bb });
  expect(created.ok).toBe(true); if (!created.ok) return;
  const binding = created.value;
  try {
    const outcome = await binding.server.sendExternal(
      { subject: 'webhook-auto', presentation: { displayName: 'Webhook', handle: null, avatarUrl: null } },
      { operationId: 'operation-auto', threadId: 'thread-r1', mode: 'auto', input: ['hello'] },
    );
    expect(outcome).toMatchObject({ status: 'submitted' });
    expect(f.counters.acceptedModes).toEqual(['auto']);
    expect(f.counters.producerRendering).toBe(0);
  } finally { binding.dispose(); }
});

test('enhanced host and producer rendering each deliver one sender envelope', async () => {
  for (const rendering of ['host', 'producer']) {
    const f = fixture(); const created = createBbIdentityServerBinding({ bb: f.bb, externalMessageRendering: rendering });
    expect(created.ok).toBe(true); if (!created.ok) return;
    expect(f.counters.producerRendering).toBe(rendering === 'producer' ? 1 : 0);
    const binding = created.value;
    try {
      const input = rendering === 'host'
        ? [{ type: 'text', text: 'hello', mentions: [] }]
        : [
          { type: 'text', text: '[message posted via Agentation]\n[sender=producer]\n', mentions: [], visibility: 'agent-only' },
          { type: 'text', text: 'hello', mentions: [] },
          { type: 'text', text: '\n[/sender=producer]', mentions: [], visibility: 'agent-only' },
        ];
      const outcome = await binding.server.sendExternal(
        { subject: `webhook-${rendering}`, presentation: { displayName: 'Webhook', handle: 'webhook', avatarUrl: null } },
        { operationId: `operation-${rendering}`, threadId: 'thread-r1', mode: 'auto', input },
      );
      expect(outcome).toMatchObject({ status: 'submitted' });
      const acceptedInput = f.counters.acceptedInputs[0].input.input;
      const text = acceptedInput.filter((part) => part.type === 'text').map((part) => part.text).join('');
      expect((text.match(/\[sender=/g) ?? [])).toHaveLength(1);
      if (rendering === 'host') {
        expect(text).toContain('[sender=feature:webhook]');
      } else {
        expect(acceptedInput).toEqual(input);
      }
    } finally { binding.dispose(); }
  }
});

test('enhanced producer rendering requires the host capability and rejects broken hooks before registration', () => {
  for (const [producerRendering, calls] of [['missing', 0], ['invalid', 0], ['throws', 1], ['returns', 1]]) {
    const f = fixture({ producerRendering });
    const created = createBbIdentityServerBinding({ bb: f.bb, externalMessageRendering: 'producer' });
    expect(created).toMatchObject({ ok: false, error: { code: 'incompatible' } });
    expect(f.counters.producerRendering).toBe(calls);
    expect(f.counters.accept).toBe(0);
    expect(f.native.size).toBe(0);
  }
});

test('public commits revalidates the exact issued write target after an awaited read', async () => {
  const f = fixture(); const created = createBbIdentityServerBinding({ bb: f.bb });
  expect(created.ok).toBe(true); if (!created.ok) return;
  const binding = created.value;
  let reached; const ready = new Promise(resolve => { reached = resolve; });
  let resume; const read = new Promise(resolve => { resume = resolve; });
  const contract = { 'feature.commit-after-read': { input: schema, output: schema } };
  try {
    expect(binding.rpc.register(contract, { 'feature.commit-after-read': { origin: 'interactive-user', async handle(_input, invocation) {
      const opened = await invocation.person(); if (!opened.ok) return { ok: false, code: opened.error.code };
      try {
        const target = await opened.value.target({ intent: 'write', selection: { kind: 'self' }, policy: { kind: 'self-only' }, expected, expectedSubject: actor.identity.key });
        if (!target.ok) return { ok: false, code: target.error.code };
        const snapshot = target.value.snapshot(); reached(); await read;
        const committed = binding.server.commits.validate(target.value, {
          instanceId: binding.server.instanceId, pluginId: 'feature', collection: 'thread-sections', recordId: 'recovery',
          subject: snapshot.subject.key, expected: snapshot.expected, schemaVersion: 1,
        });
        return { ok: committed.ok, code: committed.ok ? null : committed.error.code };
      } finally { opened.value.dispose(); }
    } } }).ok).toBe(true);
    const pending = f.native.get('feature.commit-after-read')({});
    await ready; f.expireActiveScope(); resume();
    expect(await pending).toEqual({ ok: false, code: 'expired' });
  } finally { binding.dispose(); }
});

test('public profiles reject mismatched and malformed provider rows while preserving duplicate requested keys', async () => {
  const f = fixture(); const created = createBbIdentityServerBinding({ bb: f.bb });
  expect(created.ok).toBe(true); if (!created.ok) return;
  const binding = created.value;
  const lookup = keys => f.native.get(identityRpcMethods[identityRoutes.profiles])({ keys });
  const key = 'p6r-person:v1:issuer:collaborator';
  try {
    const duplicate = await lookup([key, key]);
    expect(duplicate).toMatchObject({ ok: true, value: [{ key, status: 'found' }, { key, status: 'found' }] });
    for (const malformed of [
      { revision: 'r1', records: null },
      { revision: 'r1', records: [null] },
      { revision: 'r1', records: [{ issuer: 'issuer', subject: 'collaborator', record: { ...collaborator, subject: 'different-person' } }] },
    ]) {
      f.setLookupResult(malformed);
      expect(await lookup([key])).toMatchObject({ ok: false, error: { code: 'incompatible' } });
    }
    f.setLookupResult({ revision: 'r1', records: [
      { issuer: 'issuer', subject: 'collaborator', record: null },
      { issuer: 'issuer', subject: 'collaborator', record: null },
    ] });
    expect(await lookup([key, 'p6r-person:v1:issuer:other'])).toMatchObject({ ok: false, error: { code: 'incompatible' } });
  } finally { binding.dispose(); }
});

test('background evidence reads use a registered finite invocation with host attribution', async () => {
  const f = fixture(); const binding = createBbIdentityServerBinding({ bb: f.bb }).value;
  let captured;
  const result = await binding.background(async invocation => {
    captured = invocation;
    expect(await invocation.person()).toMatchObject({ ok: true, value: { actor: { identity: { kind: 'person' } } } });
    return binding.endpoint.participants(invocation, { threadId: 'thread-r1', limit: 10 });
  });
  expect(result).toMatchObject({ ok: true, value: { coverage: 'complete-history' } });
  expect(f.counters.participants).toBe(1);
  expect(await binding.endpoint.participants(captured, { threadId: 'thread-r1', limit: 10 })).toMatchObject({ ok: false, error: { code: 'expired' } });
  binding.dispose();
});

for (const enhanced of [false]) test(`HTTP retains issued invocation through body and aborts on disposal (enhanced=${enhanced})`, async () => {
  const f = fixture(); if (!enhanced) delete f.bb.experimental_p6rIdentity;
  const routes = new Map(); f.bb.http = { route(_method, path, handler) { routes.set(path, handler); } };
  const binding = createBbIdentityServerBinding({ bb: f.bb }).value;
  let captured;
  expect(binding.http.route('POST', '/read', { origin: 'interactive-user', async handle(_context, invocation) {
    captured = invocation;
    expect((await invocation.person()).ok).toBe(true);
    return new Response('retained');
  } }).ok).toBe(true);
  const context = { req: { raw: new Request('http://localhost/read') } };
  const response = await routes.get('/read')(context);
  expect((await binding.server.selfProfile(captured)).ok).toBe(true);
  expect(await response.text()).toBe('retained');
  expect(await binding.server.selfProfile(captured)).toMatchObject({ ok: false, error: { code: 'expired' } });
  expect(binding.http.route('POST', '/unsafe', { origin: 'interactive-user', handle() { throw Error('unused'); } }, { auth: 'none' }).ok).toBe(false);
  expect(binding.http.route('POST', '/held', { origin: 'interactive-user', handle() { return new Response(new ReadableStream()); } }).ok).toBe(true);
  const held = await routes.get('/held')(context);
  const read = held.body.getReader().read();
  binding.dispose();
  await expect(read).rejects.toThrow('expired');
});

test('baseline HTTP client abort expires a held handler before it can open a person', async () => {
  const f = fixture(); delete f.bb.experimental_p6rIdentity;
  const routes = new Map(); f.bb.http = { route(_method, path, handler) { routes.set(path, handler); } };
  const binding = createBbIdentityServerBinding({ bb: f.bb }).value;
  let entered, resume; const ready = new Promise(resolve => { entered = resolve; }); const held = new Promise(resolve => { resume = resolve; });
  let admission;
  binding.http.route('POST', '/held', { origin: 'interactive-user', async handle(_context, invocation) {
    entered(); await held; admission = await invocation.person(); return new Response(null, { status: 204 });
  } });
  const abort = new AbortController();
  const pending = routes.get('/held')({ req: { raw: new Request('http://localhost/held', { signal: abort.signal }) } });
  await ready; abort.abort(); resume(); await pending;
  expect(admission).toMatchObject({ ok: false, error: { code: 'expired' } });
  binding.dispose();
});
