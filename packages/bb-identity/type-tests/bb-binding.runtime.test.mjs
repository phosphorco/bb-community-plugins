import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createBbIdentityServerBinding } from '../bb-binding-runtime.ts';
import { identityStateRoutes, identityStateRpcMethods } from '../rpc-routes-runtime.ts';
import { createAdapterHarness } from '../testing-runtime.ts';

const ok = value => ({ ok: true, value });
const error = (code, message = code) => ({ ok: false, error: { code, message, retry: 'never' } });
const schema = { '~standard': { version: 1, vendor: 'test', validate: value => ({ value }) } };
const textCodec = { decode: value => typeof value === 'string' ? ok(value) : error('invalid-input'), encode: value => value };
const deferred = () => { let resolve; const promise = new Promise(next => { resolve = next; }); return { promise, resolve }; };

function fakeBb(extension) {
  const native = new Map(); const hooks = []; const published = []; const sent = [];
  return {
    native, hooks, published, sent,
    bb: {
      pluginId: 'feature', experimental_p6rIdentity: extension,
      rpc: { register(contract, handlers) { for (const method of Object.keys(contract)) native.set(method, handlers[method]); } },
      realtime: { publish(channel, payload) { published.push({ channel, payload }); } },
      onDispose(listener) { hooks.push(listener); },
      sdk: {
        threads: { async send(input) { sent.push(input); return { ok: true }; } },
        plugins: { async callRpc() { return { accepted: true }; } },
      },
    },
  };
}

function stateFixture() {
  const db = new Database(':memory:'); db.exec('CREATE TABLE state (record TEXT PRIMARY KEY, value TEXT NOT NULL)');
  return {
    boundary: 'same-process-synchronous', receiptRetentionMs: 60_000,
    async read(address) {
      const row = db.query('SELECT value FROM state WHERE record=?').get(address.recordId);
      return ok(row ? { status: 'present', envelope: JSON.parse(row.value) } : { status: 'empty', address, version: { epoch: 'empty', sequence: 0 } });
    },
    async commit({ mutation, validateAtCommit }) {
      return db.transaction(() => {
        const live = validateAtCommit(); if (!live.ok) return live;
        const envelope = { address: mutation.address, version: { epoch: 'empty', sequence: 1 }, schemaVersion: mutation.schemaVersion, value: mutation.value, lastEditedBy: live.value };
        db.query('INSERT OR REPLACE INTO state VALUES (?,?)').run(mutation.address.recordId, JSON.stringify(envelope));
        return ok({ status: 'saved', envelope, operationId: mutation.operationId });
      }).immediate();
    },
    async reconcile() { return ok({ status: 'unknown', reason: 'unavailable' }); },
    close() { db.close(); },
  };
}

test('one absent-host consumer registers RPC, endpoint/state routes, and an actual SQLite state resource', async () => {
  const fixture = fakeBb(undefined); const created = createBbIdentityServerBinding({ bb: fixture.bb, stateNamespace: 'binding-local' });
  expect(created.ok).toBe(true); if (!created.ok) return;
  const binding = created.value; let signal;
  const feature = { 'feature.echo': { input: schema, output: schema } };
  let captured;
  expect(binding.rpc.register(feature, { 'feature.echo': { origin: 'interactive-user', async handle(_input, invocation) {
    captured = invocation; signal = invocation.signal; const profile = await binding.server.selfProfile(invocation); const person = await invocation.person(); return { profile: profile.ok, person: person.ok, key: person.ok ? person.value.actor.identity.key : null };
  } } }).ok).toBe(true);
  expect((await fixture.native.get('feature.echo')({}))).toMatchObject({ profile: true, person: true });
  expect(signal.aborted).toBe(true);
  expect((await binding.server.selfProfile(captured)).ok).toBe(false);
  expect(fixture.native.has(identityStateRpcMethods[identityStateRoutes.load])).toBe(true);
  expect(fixture.native.has(identityStateRpcMethods[identityStateRoutes.save])).toBe(true);
  const storage = stateFixture();
  try {
    const resource = { pluginId: 'feature', definition: { collection: 'preferences', schemaVersion: 1, codec: textCodec, initialValue: () => '', equal: (a, b) => a === b } };
    expect(binding.state.register({ resource, storage, policy: { kind: 'self-only' } }).ok).toBe(true);
    const expected = { actor: 'local:binding-local', session: 'singleton:binding-local' };
    const address = { instanceId: 'binding-local', pluginId: 'feature', owner: expected.actor, collection: 'preferences', recordId: 'appearance' };
    const mutation = { kind: 'replace', address, expected, expectedVersion: { epoch: 'empty', sequence: 0 }, ownerSession: 'owner', localGeneration: 1, operationId: 'appearance-op', schemaVersion: 1, value: 'dark' };
    const saved = await fixture.native.get(identityStateRpcMethods[identityStateRoutes.save])(mutation);
    expect(saved).toMatchObject({ ok: true, value: { status: 'saved', envelope: { value: 'dark' } } });
    expect(fixture.published).toHaveLength(1);
  } finally { storage.close(); binding.dispose(); }
});

test('host-owned external rendering wraps exactly once on the absent portable path', async () => {
  const fixture = fakeBb(undefined); const created = createBbIdentityServerBinding({ bb: fixture.bb });
  expect(created.ok).toBe(true); if (!created.ok) return;
  const binding = created.value;
  try {
    const outcome = await binding.server.sendExternal(
      { subject: 'webhook-host', presentation: { displayName: 'Webhook', handle: 'webhook', avatarUrl: null } },
      { operationId: 'operation-host', threadId: 'thread-host', mode: 'start', input: [{ type: 'text', text: 'hello', mentions: [] }] },
    );
    expect(outcome).toMatchObject({ status: 'submitted', receipt: { provenance: 'source-labelled' } });
    const rendered = fixture.sent[0].input.filter((part) => part.type === 'text').map((part) => part.text).join('');
    expect(rendered).toContain('hello');
    expect((rendered.match(/\[sender=/g) ?? [])).toHaveLength(1);
    expect(rendered).toContain('[sender=feature:webhook]');
    expect(rendered).not.toContain('External source [');
    expect(rendered).not.toContain('webhook-host');
  } finally { binding.dispose(); }
});

test('producer-owned external rendering is preserved on the absent portable path', async () => {
  const fixture = fakeBb(undefined); const created = createBbIdentityServerBinding({ bb: fixture.bb, externalMessageRendering: 'producer' });
  expect(created.ok).toBe(true); if (!created.ok) return;
  const binding = created.value;
  try {
    const producerInput = [
      { type: 'text', text: '[message posted via Agentation]\n[sender=producer]\n', mentions: [], visibility: 'agent-only' },
      { type: 'text', text: 'hello', mentions: [] },
      { type: 'text', text: '\n[/sender=producer]', mentions: [], visibility: 'agent-only' },
    ];
    const outcome = await binding.server.sendExternal(
      { subject: 'webhook-producer', presentation: { displayName: 'Producer', handle: null, avatarUrl: null } },
      { operationId: 'operation-producer', threadId: 'thread-producer', mode: 'start', input: producerInput },
    );
    expect(outcome).toMatchObject({ status: 'submitted', receipt: { provenance: 'source-labelled' } });
    expect(fixture.sent[0].input).toEqual(producerInput);
    expect(fixture.sent[0].input.filter((part) => part.type === 'text').map((part) => part.text).join('')).not.toContain('External source [');
  } finally { binding.dispose(); }
});

test('public registration rejects extra descriptors and a failed native batch leaves no callable fallback', async () => {
  const fixture = fakeBb(undefined); const created = createBbIdentityServerBinding({ bb: fixture.bb });
  expect(created.ok).toBe(true); if (!created.ok) return;
  const contract = { 'feature.once': { input: schema, output: schema } };
  expect(created.value.rpc.register(contract, {
    'feature.once': { origin: 'interactive-user', handle: async () => ({ ok: true }) },
    extra: { origin: 'interactive-user', handle: async () => ({ ok: true }) },
  }).ok).toBe(false);
  const retained = new Map();
  fixture.bb.rpc.register = (registered, handlers) => { for (const key of Object.keys(registered)) retained.set(key, handlers[key]); throw Error('late native failure'); };
  expect(created.value.rpc.register(contract, { 'feature.once': { origin: 'interactive-user', handle: async () => ({ ok: true }) } }).ok).toBe(false);
  await expect(retained.get('feature.once')({})).rejects.toThrow('retired');
  created.value.dispose();
});

test('background disposal aborts admitted work and rejects reentrant new work without calling it', async () => {
  const fixture = fakeBb(undefined); const created = createBbIdentityServerBinding({ bb: fixture.bb });
  expect(created.ok).toBe(true); if (!created.ok) return;
  const binding = created.value; const gate = deferred(); let signal; let rejected; let calls = 0;
  const admitted = binding.background(async invocation => {
    signal = invocation.signal;
    signal.addEventListener('abort', () => {
      expect(() => { rejected = binding.background(async () => { calls++; }); }).not.toThrow();
    }, { once: true });
    await gate.promise;
    return 'admitted-result';
  });
  expect(signal.aborted).toBe(false); binding.dispose();
  expect(signal.aborted).toBe(true);
  await expect(rejected).rejects.toThrow('Identity binding is disposed.');
  await expect(binding.background(async () => { calls++; })).rejects.toThrow('Identity binding is disposed.');
  expect(calls).toBe(0); gate.resolve();
  await expect(admitted).resolves.toBe('admitted-result');
  binding.dispose();
});

test('malformed or incompatible discovery does not fall back to the base singleton', () => {
  const fixture = fakeBb({ version: 2, instanceId: 'persisted' });
  const created = createBbIdentityServerBinding({ bb: fixture.bb });
  expect(created.ok).toBe(false); if (!created.ok) expect(created.error.code).toBe('incompatible');
  expect(fixture.native.size).toBe(0);
});

test('enhanced bound handlers settle their exact scope and an expired request cannot open a late person', async () => {
  const harness = createAdapterHarness({ mode: 'multi-user', instanceId: 'persisted-binding', pluginId: 'feature', inputCodec: textCodec });
  let current = harness.request(); let released = 0; let registrations = 0; let activeScope;
  const protocol = {
    version: 1, instanceId: 'persisted-binding',
    bindInvocation({ handler }) {
      let retired = false;
      return { registration: { generation: `generation-${++registrations}`, status: 'active', dispose() { retired = true; } }, handler: input => {
        if (retired) throw Error('retired');
        const controller = new AbortController(); activeScope = controller;
        return handler({ request: current, scope: { signal: controller.signal, validate: () => controller.signal.aborted ? { ok: false, code: 'invalidated' } : { ok: true }, release() { released++; controller.abort(); } } }, input);
      } };
    },
    session: harness.upstream.session, selfProfile: harness.upstream.selfProfile,
    async openRequest(request) {
      const opened = await harness.upstream.openScope(request); if (!opened.ok) return opened;
      const controller = new AbortController();
      return ok({ ...opened.value, scope: { signal: controller.signal, validate: () => controller.signal.aborted ? { ok: false, code: 'invalidated' } : { ok: true }, release() { controller.abort(); } } });
    },
    async accept() { return error('unsupported'); }, async lookup() { return ok({ status: 'unknown', reason: 'unsupported' }); }, async provenance() { return ok({ status: 'unknown', correlation: null, reason: 'test' }); },
    async historyContributions() { return ok({ status: 'unavailable', reason: 'unsupported' }); }, async historyAttempts() { return ok({ status: 'unavailable', reason: 'unsupported' }); },
    directorySources() { return []; }, async participants() { return error('unsupported'); }, async forwardRpc(_scope, _destination, input) { return input; }, async registerProvider() { return error('unsupported'); }, subscribe() { return () => {}; },
  };
  const fixture = fakeBb(protocol); const created = createBbIdentityServerBinding({ bb: fixture.bb });
  expect(created.ok).toBe(true); if (!created.ok) return;
  const gate = deferred();
  try {
    const feature = { 'feature.expire': { input: schema, output: schema } };
    expect(created.value.rpc.register(feature, { 'feature.expire': { origin: 'interactive-user', async handle(_input, invocation) {
      await gate.promise; const person = await invocation.person(); return { person: person.ok, code: person.ok ? null : person.error.code };
    } } }).ok).toBe(true);
    current = harness.request(); const pending = fixture.native.get('feature.expire')({});
    await Promise.resolve(); activeScope.abort(); gate.resolve();
    await expect(pending).resolves.toEqual({ person: false, code: 'expired' });
    expect(released).toBeGreaterThan(0); created.value.dispose();
    expect(() => fixture.native.get('feature.expire')({})).toThrow('retired');
  } finally { created.value.dispose(); }
});
