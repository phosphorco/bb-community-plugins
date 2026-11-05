import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import {
  registerTurnResultsParticipant, createResultsSupplierClient, createResultsConsumerClient,
  discoverResultsParticipants, createResultsDiscoveryOwner, classifyResultsError,
  ResultsCallError, navigateResult,
} from '../src/bb.js';
import { METHODS, PROTOCOL, UnknownResultSchema, buildResolveOutput, resolveOutcomeBudget } from '../src/index.js';
import { adaptCompletedEvent } from '../src/events.js';
import { identity } from './fixtures.mjs';

const descriptor = { kind: 'example/image-created', namespace: 'example', neutralLabel: 'Image',
  confirmedLabel: 'Image created', specificity: 'typed', memberVersion: 'image/1', equivalenceNamespaces: [] };
const capabilities = () => ({ revision: 'source-1', supplier: { kinds: [descriptor], recognize: true, resolve: true, enumerate: true }, consumer: { invalidate: true } });
const noCandidates = () => ({ candidates: [], page: { state: 'complete', nextCursor: null } });
const feedInput = () => ({ version: 1, threadId: 'thr_example', range: null, cursor: null, limit: 8 });
const feedPage = () => ({ state: 'page', epoch: 'images-1', phase: 'changes', throughRevision: 0,
  rows: [], nextCursor: 'c1', settled: true, coverage: { retainedFrom: null, unplaced: 0, complete: true } });
const invalidateInput = () => ({ version: 1, supplierPluginId: 'images', threadId: 'thr_example', revision: { epoch: 'images-1', sequence: 1 }, affected: 'thread' });
const resolveInput = () => ({ version: 1, threadId: 'thr_example', items: [identity()], maxOutcomeBytes: resolveOutcomeBudget(1) });
async function recognizeInput() {
  const adapted = await adaptCompletedEvent({ id: 'evt_1', threadId: 'thr_example', seq: 1,
    scope: { kind: 'turn', turnId: 'turn_1' }, createdAt: 100, type: 'item/completed',
    data: { item: { type: 'imageGeneration', id: 'item_1', status: 'completed', path: '/tmp/image.png', error: null, transparentBackground: false } } });
  assert.equal(adapted.state, 'admitted');
  return { version: 1, context: { consumer: { pluginId: 'gallery', surface: 'turn' }, threadId: 'thr_example', range: { fromSeq: 1, throughSeq: 1 } },
    events: [adapted.event], page: { cursor: null, limit: 8 } };
}
function participant(overrides = {}) {
  return { pluginId: 'images', capabilities: capabilities(), recognize: noCandidates,
    resolve: request => buildResolveOutput(request, request.items.map(() => ({ state: 'unavailable', reason: 'not-verified' }))),
    enumerate: feedPage, invalidate: () => ({ state: 'dirty' }), ...overrides };
}
function host() {
  const registrations = new Map(), requests = [], dispose = [];
  let listing = [];
  const api = pluginId => ({
    rpc: { register(contract, handlers, options) {
      assert.equal(options.experimental_discoverable, true);
      assert.equal(registrations.has(pluginId), false);
      registrations.set(pluginId, { contract, handlers });
    } },
    onDispose(fn) { dispose.push(fn); },
  });
  const sdk = { plugins: {
    async callRpc(args) {
      requests.push(args);
      assert.equal(args.outputSchema, UnknownResultSchema);
      const target = registrations.get(args.pluginId);
      if (!target) throw { status: 404, body: { error: `unknown plugin "${args.pluginId}"` } };
      const contract = target.contract[args.method], handler = target.handlers[args.method];
      if (!contract || !handler) throw { status: 404, body: { error: { code: 'unknown_method' } } };
      const validated = await contract.input['~standard'].validate(args.input);
      if (validated.issues) throw { status: 400, body: { error: { code: 'invalid_input' } } };
      const raw = await handler(validated.value, { experimental_caller: { kind: 'plugin', pluginId: 'untrusted-advertised-owner' } });
      const output = await contract.output['~standard'].validate(raw);
      if (output.issues) throw { status: 500, body: { error: { code: 'invalid_output' } } };
      return args.outputSchema.parse(output.value);
    },
    async list() { return { plugins: listing }; },
  } };
  return { sdk, api, registrations, requests, dispose, listing(value) { listing = value; } };
}
const isKind = kind => error => error instanceof ResultsCallError && error.kind === kind;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

test('actual rpc.register contract aggregates all roles and traverses clients with explicit listed owner', async () => {
  const h = host();
  registerTurnResultsParticipant(h.api('images'), participant());
  const supplier = createResultsSupplierClient(h.sdk, 'images', { descriptors: [descriptor] });
  assert.equal((await supplier.describe()).state, 'ready');
  assert.equal(h.requests[0].input, null);
  assert.deepEqual(await supplier.recognize(await recognizeInput()), noCandidates());
  assert.equal((await supplier.resolve(resolveInput())).resolutions[0].state, 'unavailable');
  assert.equal((await supplier.enumerate(feedInput())).state, 'page');
  assert.deepEqual(await createResultsConsumerClient(h.sdk, 'images').invalidate(invalidateInput()), { state: 'dirty' });
  assert.equal(h.requests.length, 5);
  assert.ok(h.requests.every(request => request.pluginId === 'images'));
  assert.deepEqual(Object.keys(h.registrations.get('images').contract).sort(), Object.values(METHODS).sort());
});

test('StandardSchema includes actual jsonSchema methods and admits raw unknown inputs before parsing', async () => {
  const h = host(); let invocations = 0;
  registerTurnResultsParticipant(h.api('images'), participant({ invalidate() { invocations++; return { state: 'dirty' }; } }));
  for (const [method, contract] of Object.entries(h.registrations.get('images').contract)) {
    assert.equal(contract.input['~standard'].version, 1);
    assert.equal(typeof contract.input['~standard'].jsonSchema.input({ target: 'draft-2020-12' }), 'object');
    assert.equal(typeof contract.output['~standard'].jsonSchema.output({ target: 'draft-2020-12' }), 'object');
    assert.ok(contract.input['~standard'].validate({ ...invalidateInput(), unknown: 'x'.repeat(262144) }).issues, method);
  }
  await assert.rejects(createResultsConsumerClient(h.sdk, 'images').invalidate({ ...invalidateInput(), extra: true }), isKind('incompatible'));
  assert.equal(invocations, 0);
});

test('describe tolerates ignored arbitrary bounded input including absent input, but never oversized JSON', async () => {
  const h = host(); registerTurnResultsParticipant(h.api('images'), participant());
  const target = h.registrations.get('images');
  for (const input of [null, undefined, { oldClient: true }, ['ignored'], 42]) {
    assert.equal(target.contract[METHODS.describe].input['~standard'].validate(input).issues, undefined);
    assert.equal((await target.handlers[METHODS.describe](input, {})).protocol, PROTOCOL);
  }
  assert.equal((await target.handlers[METHODS.describe]({ extra: 'x'.repeat(262144) }, {})).code, 'incompatible');
});

test('capability-handler parity rejects both missing and unadvertised stages before registration', () => {
  const h = host();
  for (const override of [{ resolve: undefined }, { recognize: undefined }, { enumerate: undefined }, { invalidate: undefined },
    { capabilities: { revision: 'x', consumer: { invalidate: true } } },
    { capabilities: { ...capabilities(), extra: true } }]) {
    assert.throws(() => registerTurnResultsParticipant(h.api('images'), participant(override)), isKind('incompatible'));
  }
  assert.equal(h.registrations.size, 0);
});

test('registration snapshots caller capabilities/handlers; consumer-only role is valid', async () => {
  const h = host();
  const original = participant(); registerTurnResultsParticipant(h.api('images'), original);
  original.capabilities.revision = 'mutated'; original.recognize = () => { throw new Error('mutated handler'); };
  const client = createResultsSupplierClient(h.sdk, 'images');
  assert.equal((await client.describe()).capabilities.revision, 'source-1');
  assert.deepEqual(await client.recognize(await recognizeInput()), noCandidates());
  registerTurnResultsParticipant(h.api('gallery'), { pluginId: 'gallery', capabilities: { revision: 'gallery-1', consumer: { invalidate: true } }, invalidate: () => ({ state: 'dirty' }) });
  assert.equal((await createResultsSupplierClient(h.sdk, 'gallery').describe()).capabilities.supplier, undefined);
  await assert.rejects(createResultsSupplierClient(h.sdk, 'gallery').enumerate(feedInput()), isKind('unknown-method'));
});

test('invalidation source attribution is independent from target consumer and caller ACL', async () => {
  const h = host(); const received = [];
  registerTurnResultsParticipant(h.api('gallery'), { pluginId: 'gallery', capabilities: { revision: '1', consumer: { invalidate: true } },
    invalidate(input, signal, context) { received.push({ input, context }); return { state: 'dirty' }; } });
  const client = createResultsConsumerClient(h.sdk, 'gallery');
  await client.invalidate(invalidateInput());
  assert.equal(received[0].input.supplierPluginId, 'images');
  assert.equal(received[0].context.targetPluginId, 'gallery');
  assert.equal(h.requests[0].pluginId, 'gallery');
  const wrong = invalidateInput(); wrong.affected = [{ source: { ...identity().ref.source, threadId: 'foreign' }, member: 'a', kind: descriptor.kind }];
  await assert.rejects(client.invalidate(wrong), isKind('incompatible'));
  assert.equal(received.length, 1);
});

test('raw additive output size is admitted before stripping; small extensions survive wire and normalize', async () => {
  const h = host(); registerTurnResultsParticipant(h.api('images'), participant({ recognize: () => ({ ...noCandidates(), future: 'valid' }) }));
  const input = await recognizeInput();
  const raw = await h.registrations.get('images').handlers[METHODS.recognize](input, {});
  assert.equal(raw.future, 'valid');
  const client = createResultsSupplierClient(h.sdk, 'images');
  const normalized = await client.recognize(input);
  // Root policy may preserve additive envelope metadata; unknown identity fields
  // are normalized by root. Size must be checked before either behavior.
  assert.equal(normalized.candidates.length, 0);
  const original = h.sdk.plugins.callRpc;
  h.sdk.plugins.callRpc = async args => ({ ...await original(args), future: 'x'.repeat(65536) });
  await assert.rejects(client.recognize(input), isKind('incompatible'));
});

test('source output correlation rejects oversized output and foreign recognize/feed/resolve identities', async () => {
  const h = host();
  registerTurnResultsParticipant(h.api('images'), participant({ recognize: () => ({ ...noCandidates(), future: 'x'.repeat(65536) }) }));
  await assert.rejects(createResultsSupplierClient(h.sdk, 'images').recognize(await recognizeInput()), isKind('incompatible'));
  const h2 = host();
  registerTurnResultsParticipant(h2.api('images'), participant({ resolve: async request => {
    const output = await buildResolveOutput(request, [{ state: 'unavailable', reason: 'missing' }]);
    output.resolutions[0].identityDigest = '0'.repeat(64); return output;
  }, enumerate: () => ({ ...feedPage(), rows: [{ kind: 'source-expired', ref: { ...identity().ref,
    source: { ...identity().ref.source, threadId: 'foreign' } }, revision: { epoch: 'images-1', sequence: 1 } }], throughRevision: 1 }) }));
  const client = createResultsSupplierClient(h2.sdk, 'images');
  await assert.rejects(client.resolve(resolveInput()), isKind('incompatible'));
  await assert.rejects(client.enumerate(feedInput()), isKind('incompatible'));
});

test('client Resolve enforces raw individual compact budgets before additive stripping', async () => {
  const request = { ...resolveInput(), items: Array.from({ length: 32 }, (_, i) => identity(i + 1)), maxOutcomeBytes: resolveOutcomeBudget(32) };
  const valid = await buildResolveOutput(request, request.items.map(() => ({ state: 'unavailable', reason: 'missing' })));
  const raw = structuredClone(valid);
  raw.resolutions[0].future = 'x'.repeat(600);
  const sdk = { plugins: { async callRpc() { return raw; } } };
  await assert.rejects(createResultsSupplierClient(sdk, 'images').resolve(request), isKind('incompatible'));
});

test('recognize verifies selected digest before source handler or RPC; strict input rejects additions', async () => {
  const h = host(); let invoked = 0;
  registerTurnResultsParticipant(h.api('images'), participant({ recognize: () => { invoked++; return noCandidates(); } }));
  const bad = await recognizeInput(); bad.events[0].selectedDigest = '0'.repeat(64);
  await assert.rejects(createResultsSupplierClient(h.sdk, 'images').recognize(bad), isKind('incompatible'));
  assert.equal(h.requests.length, 0);
  assert.equal((await h.registrations.get('images').handlers[METHODS.recognize](bad, {})).code, 'incompatible');
  assert.equal(invoked, 0);
});

test('transport classification preserves actual error classes through recognize, never substring guesses', async () => {
  const cases = [
    [{ status: 404, body: { error: { code: 'unknown_method' } } }, 'unknown-method'],
    [{ status: 404, body: { error: 'unknown plugin "images"' } }, 'unknown-plugin'],
    [{ status: 404, body: 'unknown plugin "images"' }, 'unknown-plugin'],
    [{ status: 503, body: { error: 'plugin "images" is not running (status: disabled)' } }, 'disabled'],
    [{ status: 503, body: { error: 'plugin "images" is not running (status: error — dependency missing)' } }, 'not-running'],
    [{ status: 403, body: { error: 'caller token rejected' } }, 'unauthorized'],
    [{ status: 400, body: { error: { code: 'invalid_input' } } }, 'incompatible'],
    [{ status: 500, body: { error: { code: 'invalid_output' } } }, 'incompatible'],
    [{ status: 500, body: { error: { code: 'handler_error' } } }, 'source-error'],
    [{ status: 404, body: { error: 'example quotes unknown plugin "images" in text' } }, 'transport-error'],
    [{ status: 503, body: 'prefix plugin "images" is not running (status: disabled)' }, 'transport-error'],
    [new DOMException('abort', 'AbortError'), 'aborted'],
  ];
  const input = await recognizeInput();
  for (const [error, kind] of cases) {
    assert.equal(classifyResultsError(error), kind);
    const sdk = { plugins: { async callRpc() { throw error; } } };
    await assert.rejects(createResultsSupplierClient(sdk, 'images').recognize(input), isKind(kind));
  }
});

test('client method deadline fences abort-ignoring calls, no retry and no late success', async () => {
  const gate = deferred(); let calls = 0, signal;
  const sdk = { plugins: { callRpc(args) { calls++; signal = args.signal; return gate.promise; } } };
  const pending = createResultsSupplierClient(sdk, 'images', { budgets: { describeMs: 10 } }).describe();
  await assert.rejects(pending, isKind('timeout'));
  assert.equal(signal.aborted, true); assert.equal(calls, 1);
  let decoded = false;
  gate.resolve(new Proxy({ protocol: PROTOCOL, versions: [1], capabilities: capabilities() }, {
    ownKeys(value) { decoded = true; return Reflect.ownKeys(value); },
  }));
  await pause(0); assert.equal(calls, 1); assert.equal(decoded, false);
});

test('caller abort, preabort and generation current fence local results', async () => {
  const h = host(); registerTurnResultsParticipant(h.api('images'), participant());
  await assert.rejects(createResultsSupplierClient(h.sdk, 'images').describe(AbortSignal.abort()), isKind('aborted'));
  assert.equal(h.requests.length, 0);
  const gate = deferred(), controller = new AbortController();
  const sdk = { plugins: { callRpc() { return gate.promise; } } };
  const rejected = assert.rejects(createResultsSupplierClient(sdk, 'images').describe(controller.signal), isKind('aborted'));
  controller.abort(); await rejected;
  let current = true;
  const stale = createResultsSupplierClient(sdk, 'images', { current: () => current }).describe();
  const check = assert.rejects(stale, isKind('stale'));
  await pause(0); current = false; gate.resolve({ protocol: PROTOCOL, versions: [1], capabilities: capabilities() });
  await check;
});

test('overall performance deadline clamps method budgets without starting expired work', async () => {
  let calls = 0;
  const sdk = { plugins: { async callRpc() { calls++; return new Promise(() => {}); } } };
  await assert.rejects(createResultsSupplierClient(sdk, 'images', { overallDeadline: performance.now() - 1 }).describe(),
    error => isKind('timeout')(error) && error.reason === 'overall-deadline');
  assert.equal(calls, 0);
  await assert.rejects(createResultsSupplierClient(sdk, 'images', { budgets: { describeMs: 10000 }, overallDeadline: performance.now() + 10 }).describe(),
    error => isKind('timeout')(error) && error.reason === 'overall-deadline');
  assert.equal(calls, 1);
});

test('source has independent resolve/feed deadlines and lifetime disposal aborts ignored handlers', async () => {
  const h = host(); const signals = [];
  const registered = registerTurnResultsParticipant(h.api('images'), participant({
    resolve(input, signal) { signals.push(signal); return new Promise(() => {}); },
    enumerate(input, signal) { signals.push(signal); return new Promise(() => {}); },
  }), { budgets: { resolveMs: 10, feedMs: 10 } });
  const client = createResultsSupplierClient(h.sdk, 'images');
  await assert.rejects(client.resolve(resolveInput()), isKind('timeout'));
  await assert.rejects(client.enumerate(feedInput()), isKind('timeout'));
  assert.ok(signals.every(signal => signal.aborted));
  const gate = deferred(); let bounded;
  const h2 = host();
  const lease = registerTurnResultsParticipant(h2.api('images'), participant({ enumerate(input, signal) { bounded = signal; return gate.promise; } }));
  const pending = createResultsSupplierClient(h2.sdk, 'images').enumerate(feedInput());
  const checked = assert.rejects(pending, isKind('aborted'));
  await pause(0); lease.dispose(); await checked; assert.equal(bounded.aborted, true);
  gate.resolve(feedPage()); await pause(0);
  await assert.rejects(createResultsSupplierClient(h2.sdk, 'images').describe(), isKind('aborted'));
  registered.dispose();
});

test('source exceptions remain source errors rather than transport/schema failures', async () => {
  const h = host(); registerTurnResultsParticipant(h.api('images'), participant({ enumerate() { throw new Error('source unavailable'); } }));
  await assert.rejects(createResultsSupplierClient(h.sdk, 'images').enumerate(feedInput()), isKind('source-error'));
});

test('source and client requested budgets can only lower published per-call caps', async () => {
  const h = host(); registerTurnResultsParticipant(h.api('images'), participant(),
    { budgets: { recognizeMs: 100000, resolveMs: 100000, feedMs: 100000 } });
  const delays = [], original = globalThis.setTimeout;
  globalThis.setTimeout = (callback, ms, ...args) => { delays.push(ms); return original(callback, ms, ...args); };
  try {
    const handlers = h.registrations.get('images').handlers;
    await handlers[METHODS.recognize](await recognizeInput(), {});
    await handlers[METHODS.resolve](resolveInput(), {});
    await handlers[METHODS.enumerate](feedInput(), {});
    assert.equal(delays.length, 3);
    for (const [index, cap] of [500, 1300, 1300].entries()) assert.ok(delays[index] <= cap && delays[index] > cap - 100);
    delays.length = 0;
    const sdk = { plugins: { async callRpc() { return { protocol: PROTOCOL, versions: [1], capabilities: capabilities() }; } } };
    await createResultsSupplierClient(sdk, 'images', { budgets: { describeMs: 100000 } }).describe();
    assert.ok(delays[0] <= 500 && delays[0] > 400);
  } finally { globalThis.setTimeout = original; }
});

test('discovery lists once, retains stable owner order, limits lanes and resumes supplier33', async () => {
  const h = host(); const listed = [];
  for (let i = 1; i <= 35; i++) { const id = `supplier-${String(i).padStart(2, '0')}`;
    listed.push({ id, enabled: true, status: i === 2 ? 'degraded' : 'running' });
    registerTurnResultsParticipant(h.api(id), participant({ pluginId: id }));
  }
  h.listing(listed.reverse());
  const list = h.sdk.plugins.list, rpc = h.sdk.plugins.callRpc;
  let lists = 0, active = 0, maxActive = 0;
  h.sdk.plugins.list = async input => { lists++; return list(input); };
  h.sdk.plugins.callRpc = async args => { active++; maxActive = Math.max(maxActive, active); await pause(args.pluginId.endsWith('1') ? 2 : 0);
    try { return await rpc(args); } finally { active--; } };
  const owner = createResultsDiscoveryOwner();
  const first = await discoverResultsParticipants({ sdk: h.sdk, owner });
  assert.equal(lists, 1); assert.ok(maxActive <= 4);
  assert.equal(first.state, 'continued'); assert.equal(first.remaining, 3);
  assert.equal(first.rows.filter(row => row.state === 'ready').length, 32);
  assert.deepEqual(first.cursor, { afterPluginId: 'supplier-32' });
  assert.equal(first.rows[0].pluginId, 'supplier-01');
  const second = await discoverResultsParticipants({ sdk: h.sdk, owner, cursor: first.cursor });
  assert.equal(lists, 2); assert.equal(second.state, 'complete');
  assert.deepEqual(second.rows.filter(row => row.state === 'ready').map(row => row.pluginId), ['supplier-33', 'supplier-34', 'supplier-35']);
});

test('discovery preserves empty/failed/disabled targets and explicit metadata capacity', async () => {
  const h = host(); const owner = createResultsDiscoveryOwner();
  assert.equal((await discoverResultsParticipants({ sdk: h.sdk, owner })).state, 'complete');
  h.listing([{ id: 'disabled', enabled: false, status: 'disabled' }, { id: 'starting', enabled: true, status: 'starting' },
    { id: 'missing', enabled: true, status: 'running' }]);
  const result = await discoverResultsParticipants({ sdk: h.sdk, owner });
  assert.deepEqual(result.rows.map(row => row.state), ['disabled', 'unknown-plugin', 'not-running']);
  assert.equal(h.requests.length, 1);
  h.listing(Array.from({ length: 257 }, (_, i) => ({ id: `disabled-${i}`, enabled: false, status: 'disabled' })));
  const cap = await discoverResultsParticipants({ sdk: h.sdk, owner });
  assert.equal(cap.rows.length, 256); assert.deepEqual(cap.capacity, { omitted: 1, complete: false });
  h.sdk.plugins.list = async () => { throw new Error('offline'); };
  const failed = await discoverResultsParticipants({ sdk: h.sdk, owner });
  assert.equal(failed.state, 'failed'); assert.equal(failed.error, 'transport-error');
});

test('discovery bounded slice returns debt rather than timing out every unvisited source', async () => {
  let lists = 0, calls = 0;
  const sdk = { plugins: {
    async list() { lists++; return { plugins: Array.from({ length: 10 }, (_, i) => ({ id: `supplier-${i}`, enabled: true, status: 'running' })) }; },
    callRpc() { calls++; return new Promise(() => {}); },
  } };
  const result = await discoverResultsParticipants({ sdk, owner: createResultsDiscoveryOwner(), budgets: { discoveryMs: 15 } });
  assert.equal(lists, 1); assert.equal(calls, 4); assert.equal(result.state, 'continued');
  assert.equal(result.remaining, 10); assert.deepEqual(result.cursor, { afterPluginId: null });
  assert.ok(result.rows.every(row => row.state === 'queued'));
});

test('discovery owner abort fences list/describe that ignore signals; no stale published result', async () => {
  const owner = createResultsDiscoveryOwner(); const gate = deferred();
  const sdk = { plugins: { list() { return gate.promise; }, async callRpc() { throw new Error('must not call'); } } };
  const first = discoverResultsParticipants({ sdk, owner });
  const checked = assert.rejects(first, isKind('aborted'));
  owner.dispose(); await checked;
  gate.resolve({ plugins: [] }); await pause(0);
});

test('malformed/duplicate discovery metadata is incompatible and invalid cursor does not acquire ownership', async () => {
  for (const plugins of [null, [null], [{ id: 'duplicate', enabled: true, status: 'running' },
    { id: 'duplicate', enabled: true, status: 'running' }], [{ id: 'x', enabled: true, status: 's'.repeat(100) }]]) {
    const sdk = { plugins: { async list() { return { plugins }; }, async callRpc() { throw new Error('not reached'); } } };
    const result = await discoverResultsParticipants({ sdk, owner: createResultsDiscoveryOwner() });
    assert.equal(result.state, 'failed'); assert.equal(result.error, 'incompatible');
  }
  let acquired = false;
  await assert.rejects(discoverResultsParticipants({ sdk: host().sdk, cursor: { afterPluginId: '../bad' },
    owner: { begin() { acquired = true; throw new Error('not reached'); }, dispose() {} } }), isKind('incompatible'));
  assert.equal(acquired, false);
});

test('discovery routes by listed owner even when describe advertises foreign identities', async () => {
  const requests = [];
  const sdk = { plugins: { async list() { return { plugins: [{ id: 'actual-owner', enabled: true, status: 'running' }] }; },
    async callRpc(args) { requests.push(args.pluginId); return { protocol: PROTOCOL, versions: [1], capabilities: { ...capabilities(), pluginId: 'forged-owner' } }; } } };
  const result = await discoverResultsParticipants({ sdk, owner: createResultsDiscoveryOwner() });
  assert.deepEqual(requests, ['actual-owner']); assert.equal(result.rows[0].pluginId, 'actual-owner');
});

test('safe navigation uses exact host targets and reports source metadata without inventing native event seek', () => {
  const calls = []; const port = { experimental_openFilePreview(input) { calls.push(input); return true; },
    openUrl(url) { calls.push(url); return true; }, toThread(threadId) { calls.push(threadId); }, showSource(source) { calls.push(source); } };
  const file = { kind: 'file', target: { kind: 'host', hostId: 'host-explicit', path: '/tmp/image.png' } };
  assert.equal(navigateResult(port, file).state, 'handled'); assert.deepEqual(calls[0], { target: file.target, location: null });
  assert.equal(navigateResult(port, { kind: 'url', href: 'https://example.com/a' }).state, 'handled');
  assert.deepEqual(navigateResult(port, { kind: 'thread', threadId: 'thr_reference' }), { state: 'handled' });
  assert.equal(calls.at(-1), 'thr_reference');
  const source = { kind: 'source', threadId: 'thr_example', eventId: 'evt_1', seq: 1 };
  assert.equal(navigateResult(port, source).source.eventId, 'evt_1');
  for (const raw of [{ kind: 'url', href: 'javascript:alert(1)' }, { kind: 'url', href: 'https://user:token@example.com' },
    { ...file, target: { ...file.target, path: 'relative/file' } },
    { ...file, target: { ...file.target, path: '/tmp/../secret' } },
    { kind: 'file', target: { kind: 'thread-storage', threadId: 'thr_example', path: '../secret' } }]) {
    assert.equal(navigateResult(port, raw).state, 'invalid');
  }
  assert.equal(navigateResult(port, { kind: 'unavailable', reason: 'missing-file' }).state, 'unavailable');
});

test('actual installed SDK structurally supplies all ports, with no emitted SDK imports', () => {
  const filename = fileURLToPath(new URL('../src/__bb_sdk_compat__.ts', import.meta.url));
  const content = `import type { BbPluginApi, BbNavigate } from '@get-bb/plugin-sdk';
import type { RegistrationPort, RpcPort, PluginListPort, ResultNavigationPort } from './bb.js';
declare const bb:BbPluginApi; declare const nav:BbNavigate;
const registration:RegistrationPort=bb; const rpc:RpcPort=bb.sdk.plugins;
const list:PluginListPort=bb.sdk.plugins; const navigation:ResultNavigationPort=nav;
void [registration,rpc,list,navigation];`;
  const options = { noEmit: true, strict: true, exactOptionalPropertyTypes: true,
    target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.Preserve, moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ['lib.es2023.d.ts', 'lib.dom.d.ts'], types: [], skipLibCheck: false };
  const compilerHost = ts.createCompilerHost(options), originalRead = compilerHost.readFile, originalExists = compilerHost.fileExists;
  compilerHost.readFile = name => name === filename ? content : originalRead(name);
  compilerHost.fileExists = name => name === filename || originalExists(name);
  const program = ts.createProgram([filename], options, compilerHost);
  const selected = program.getSourceFile(filename);
  assert.ok(selected);
  // Selected compatibility unit diagnostics, not a whole-dependency audit.
  const diagnostics = [...program.getSyntacticDiagnostics(selected), ...program.getSemanticDiagnostics(selected)];
  assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: name => name, getCurrentDirectory: () => process.cwd(), getNewLine: () => '\n' }));
  const source = readFileSync(new URL('../src/bb.ts', import.meta.url), 'utf8');
  const syntax = ts.createSourceFile('bb.ts', source, ts.ScriptTarget.ES2023, true);
  const imports = syntax.statements.filter(ts.isImportDeclaration).map(node => node.moduleSpecifier.text);
  assert.equal(imports.some(name => name.startsWith('@get-bb/plugin-sdk')), false, `${imports.join(',')} ${source.slice(0,180)}`);
  const anyNodes = [];
  const visit = node => { if (node.kind === ts.SyntaxKind.AnyKeyword) anyNodes.push(node); ts.forEachChild(node, visit); };
  visit(syntax);
  assert.equal(anyNodes.length, 0);
});
