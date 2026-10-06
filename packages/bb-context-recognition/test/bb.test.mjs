import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSupplierClient, registerRecognitionSupplier, classifyRecognitionError,
  RecognitionCallError, UnsupportedStageError, createRecognitionDiscoveryOwner,
  enumerateRecognitionSuppliers, linkifyAll, resolveAll,
} from '../dist/bb.js';
import { LIMITS, METHODS, UnknownResultSchema, identityKey } from '../dist/index.js';

const claim = (provider = 'example') => ({ provider, kinds: ['issue'], specificity: 'typed' });
const capabilities = (providers = ['example']) => ({ revision: 'test/1', linkify: { providers: providers.map(claim) }, resolve: { providers: providers.map(claim) } });
const input = { version: 1, text: '#1 #2', format: 'plain', excluded: [], context: { consumer: { pluginId: 'consumer' }, links: [] } };
const context = { consumer: { pluginId: 'consumer' } };
const candidate = (provider = 'example', start = 0, id = '1') => ({ span: { start, end: start + 2 }, match: input.text.slice(start, start + 2), source: { provider, id }, confidence: 'high', provenance: { basis: 'explicit', explanation: 'Literal mention.' } });
const envelope = (providers) => ({ protocol: 'bb-context-recognition', versions: [1], capabilities: capabilities(providers) });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const turn = () => new Promise(r => setTimeout(r, 0));
function sdk(callRpc, list = async () => ({ plugins: [] })) { return { plugins: { callRpc, list } }; }
function contributor(pluginId, linkify, providers = ['example']) {
  return { client: { pluginId, linkify, resolve: async req => ({ resolutions: req.sources.map(source => ({ source, state: 'ready', label: source.id, reasons: [] })) }) }, capabilities: capabilities(providers) };
}

test('native errors require literal status and body combinations', () => {
  const cases = [
    [{ status: 404, body: { error: { code: 'unknown_method' } } }, 'absent'],
    [{ status: 404, code: 'unknown_method', body: 'not_found' }, 'host-incompatible'],
    [{ status: 404, body: 'Unknown plugin missing' }, 'vanished'],
    [{ status: 404, body: { error: 'Unknown plugin missing' } }, 'host-incompatible'],
    [{ status: 503, body: 'Plugin p not running (status: disabled)' }, 'unavailable'],
    [{ status: 503, body: { error: 'not running (status: disabled)' } }, 'transient'],
    [{ status: 400, body: { error: { code: 'invalid_input' } } }, 'incompatible'],
    [{ status: 500, body: { error: { code: 'invalid_output' } } }, 'incompatible'],
    [{ status: 503, body: { error: { code: 'invalid_output' } } }, 'transient'],
    [{ status: 500, body: { error: { code: 'handler_error' } } }, 'error'],
    [{ status: 500 }, 'error'], [{ status: 500, body: '' }, 'error'], [{ status: 500, body: 'unstructured' }, 'error'], [{ status: 502 }, 'transient'], [{ status: 401 }, 'unauthorized'], [{ status: 403 }, 'unauthorized'],
    [{ name: 'AbortError' }, 'cancelled'], [{ name: 'ZodError' }, 'incompatible'], [new TypeError('fetch failed'), 'transient'],
  ];
  for (const [error, kind] of cases) assert.equal(classifyRecognitionError(error), kind);
});

test('client binds target, uses identity output schema, one call, and caps before output decoding', async () => {
  const calls = [];
  const owner = sdk(async args => { calls.push(args); return { candidates: [], extra: 'é'.repeat(LIMITS.responseBytes) }; });
  await assert.rejects(createSupplierClient(owner, 'target').linkify(input), error => error instanceof RecognitionCallError && error.kind === 'incompatible' && error.reason === 'result-size');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].pluginId, 'target');
  assert.equal(calls[0].method, METHODS.linkify);
  assert.equal(calls[0].outputSchema, UnknownResultSchema);
  assert.ok(calls[0].signal instanceof AbortSignal);
  await assert.rejects(createSupplierClient(owner, 'target').linkify({ ...input, surprise: true }));
  assert.equal(calls.length, 1);
  await assert.rejects(createSupplierClient(sdk(async () => ({ candidates: [], nonJson: undefined })), 'target').linkify(input), error => error.reason === 'nonjson');
});

test('client rejects response correlation faults and accepts unknown fields/reason normalization', async () => {
  const request = { version: 1, context, sources: [{ provider: 'example', id: '1' }], detail: 'label' };
  for (const resolutions of [
    [{ source: { provider: 'example', id: 'other' }, state: 'ready', reasons: [] }],
    [0, 1].map(() => ({ source: request.sources[0], state: 'ready', reasons: [] })),
    [{ source: request.sources[0], state: 'ready', card: { title: 'Unexpected card' }, reasons: [] }],
  ]) await assert.rejects(createSupplierClient(sdk(async () => ({ resolutions })), 'target').resolve(request), error => error.kind === 'incompatible');
  const output = await createSupplierClient(sdk(async () => ({ resolutions: [{ source: request.sources[0], state: 'unavailable', future: true, reasons: [{ code: 'future-code', summary: 'Future reason.' }] }] })), 'target').resolve(request);
  assert.equal(output.resolutions[0].reasons[0].code, 'source-error');
});

test('local client cancellation fences a noncooperating SDK and avoids retry', async () => {
  const pending = deferred();
  let calls = 0;
  let remoteSignal;
  const controller = new AbortController();
  const client = createSupplierClient(sdk(args => { calls++; remoteSignal = args.signal; return pending.promise; }), 'target');
  const result = client.describe(controller.signal);
  await turn();
  controller.abort();
  await assert.rejects(result, error => error.kind === 'cancelled');
  assert.equal(remoteSignal.aborted, true);
  pending.resolve(envelope());
  await turn();
  assert.equal(calls, 1);
});

test('registration installs all methods, strict inputs, inert discovery and raw preserved outputs', async () => {
  let registered;
  const bb = { rpc: { register(contract, handlers, options) { registered = { contract, handlers, options }; } } };
  let invocationSignal;
  registerRecognitionSupplier(bb, { revision: 'test/1', linkify: { providers: [claim()], handler: (req, signal) => { invocationSignal = signal; return { candidates: [candidate()], future: 'retained' }; } } });
  assert.deepEqual(Object.keys(registered.contract).sort(), Object.values(METHODS).sort());
  assert.equal(registered.options.experimental_discoverable, true);
  assert.equal(!!registered.contract[METHODS.linkify].input['~standard'].validate({ ...input, extra: true }).issues, true);
  assert.equal(registered.handlers[METHODS.describe]({ garbage: true }).capabilities.resolve, undefined);
  const raw = await registered.handlers[METHODS.linkify](input);
  assert.equal(raw.future, 'retained');
  assert.equal(registered.contract[METHODS.linkify].output['~standard'].validate(raw).value.future, 'retained');
  assert.ok(invocationSignal instanceof AbortSignal);
  await assert.rejects(registered.handlers[METHODS.resolve]({ version: 1, context, sources: [{ provider: 'example', id: '1' }], detail: 'label' }), UnsupportedStageError);
});

test('enumeration lists once, sorts/caps targets, excludes consumer, preserves independent failures', async () => {
  let lists = 0;
  const targets = [];
  const rows = [];
  const owner = sdk(async ({ pluginId }) => {
    targets.push(pluginId);
    if (pluginId === 'p02') throw { status: 404, body: { error: { code: 'unknown_method' } } };
    if (pluginId === 'p03') return { protocol: 'bb-context-recognition', versions: [2], capabilities: null };
    return envelope([pluginId]);
  }, async () => { lists++; return { plugins: [...Array.from({ length: 35 }, (_, i) => ({ id: `p${String(i).padStart(2, '0')}`, status: 'running' })).reverse(), { id: 'consumer', status: 'running' }, { id: 'disabled', status: 'disabled' }] }; });
  const pass = await enumerateRecognitionSuppliers({ sdk: owner, owner: createRecognitionDiscoveryOwner(), exclude: 'consumer', onRow: row => rows.push(row) });
  assert.equal(lists, 1);
  assert.equal(targets.length, LIMITS.plugins);
  assert.deepEqual(targets, [...targets].sort());
  assert.equal(pass.omittedCount, 5);
  assert.equal(pass.rows.find(r => r.pluginId === 'p02').state, 'absent');
  assert.equal(pass.rows.find(r => r.pluginId === 'p03').state, 'incompatible');
  assert.equal(pass.rows.find(r => r.pluginId === 'p00').state, 'ready');
  assert.equal(rows.length, LIMITS.plugins * 2);
});

test('generation owner aborts stale pass and distinct consumers never cancel each other', async () => {
  const pending = deferred();
  let describes = 0;
  const ownerSdk = sdk(() => ++describes === 1 ? pending.promise : Promise.resolve(envelope()), async () => ({ plugins: [{ id: 'target', status: 'running' }] }));
  const owner = createRecognitionDiscoveryOwner();
  const rows = [];
  const oldSignal = new AbortController();
  const first = enumerateRecognitionSuppliers({ sdk: ownerSdk, owner, exclude: 'consumer', signal: oldSignal.signal, onRow: r => rows.push(r) });
  await turn();
  const second = enumerateRecognitionSuppliers({ sdk: ownerSdk, owner, exclude: 'consumer', onRow: r => rows.push(r) });
  oldSignal.abort();
  const [stale, fresh] = await Promise.all([first, second]);
  assert.deepEqual(stale.rows, []);
  assert.equal(fresh.rows[0].state, 'ready');
  pending.resolve(envelope());
  await turn();
  assert.equal(rows.filter(r => r.generation === stale.generation && r.state !== 'pending').length, 0);
  const independent = await Promise.all([0, 1].map(() => enumerateRecognitionSuppliers({ sdk: ownerSdk, owner: createRecognitionDiscoveryOwner(), exclude: 'consumer' })));
  assert.ok(independent.every(r => r.rows[0].state === 'ready'));
});

test('contested provider disables only that route and reserved builtin remains sole resolver', async () => {
  const builtin = { pluginId: 'consumer', revision: '1', resolve: { providers: [claim('bb.thread')], handler: async req => ({ resolutions: req.sources.map(source => ({ source, state: 'ready', reasons: [] })) }) } };
  const pass = await enumerateRecognitionSuppliers({
    sdk: sdk(async args => envelope(args.pluginId === 'a' ? ['example', 'unique', 'bb.thread'] : ['example']), async () => ({ plugins: ['a', 'b'].map(id => ({ id, status: 'running' })) })),
    owner: createRecognitionDiscoveryOwner(), exclude: 'consumer', builtins: [builtin],
  });
  assert.deepEqual(pass.routes.get('example'), { state: 'contested', pluginIds: ['a', 'b'] });
  assert.equal(pass.routes.get('unique').pluginId, 'a');
  assert.equal(pass.routes.get('bb.thread').origin, 'builtin');
  assert.equal(pass.rows.every(r => r.state === 'contested'), true);
  assert.deepEqual(pass.rows[0].contestedProviders, [{ provider: 'example', pluginIds: ['a', 'b'] }]);
  assert.ok(pass.rows[0].capabilities.resolve.providers.some(p => p.provider === 'unique'));
});

test('linkify isolates timeout/schema/span faults, drops reserved contributed candidates and keeps peers', async () => {
  let slowSignal;
  const late = deferred();
  const good = contributor('good', async () => ({ candidates: [candidate()] }));
  const slow = contributor('slow', async (_, signal) => { slowSignal = signal; return late.promise; });
  const malformed = contributor('bad-span', async () => ({ candidates: [{ ...candidate('example', 1), match: '#1' }] }));
  const duplicate = contributor('duplicate', async () => ({ candidates: [candidate(), candidate()] }));
  const reserved = contributor('reserved', async () => ({ candidates: [candidate('bb.thread')] }), ['bb.thread']);
  const builtins = [{ pluginId: 'consumer', revision: '1', linkify: { providers: [claim('bb.thread')], handler: () => ({ candidates: [] }) } }];
  const result = await linkifyAll({ clients: [good, slow, malformed, duplicate, reserved], builtins, input, budgets: { linkifyMs: 20 } });
  assert.deepEqual(result.results.map(c => c.pluginId), ['good']);
  assert.equal(result.outcomes.find(r => r.pluginId === 'slow').state, 'transient');
  assert.equal(result.outcomes.find(r => r.pluginId === 'duplicate').state, 'incompatible');
  assert.equal(result.outcomes.find(r => r.pluginId === 'bad-span').state, 'incompatible');
  assert.equal(slowSignal.aborted, true);
  late.resolve({ candidates: [candidate()] });
  await turn();
  assert.deepEqual(result.results.map(c => c.pluginId), ['good']);
  const excluded = await linkifyAll({ clients: [good], input: { ...input, excluded: [{ start: 0, end: 2 }] } });
  assert.equal(excluded.outcomes[0].state, 'incompatible');
});

test('stage deadlines are explicit and chained stages share a spent overall deadline', async () => {
  const overallDeadline = performance.now() + 20;
  const result = await linkifyAll({ clients: [contributor('slow', () => new Promise(() => {}))], input, budgets: { overallDeadline } });
  assert.equal(result.outcomes[0].state, 'transient');
  // Spend the explicit shared deadline rather than assuming timer precision.
  while (performance.now() < overallDeadline) await turn();
  let calls = 0;
  const route = { state: 'ready', pluginId: 'target', origin: 'contributed', client: { resolve: async () => { calls++; return { resolutions: [] }; } } };
  const resolved = await resolveAll({ routes: new Map([['example', route]]), sources: [{ provider: 'example', id: '1' }], detail: 'label', context, budgets: { overallDeadline } });
  assert.equal(calls, 0);
  assert.equal(resolved.outcomes[0].state, 'transient');
});

test('resolve groups by owner, deduplicates identity ignoring kind, batches, and isolates invalid batch', async () => {
  const sizes = [];
  const route = { state: 'ready', pluginId: 'target', origin: 'contributed', client: { resolve: async req => {
    sizes.push(req.sources.length);
    if (req.sources.some(s => s.id === '32')) return { resolutions: [{ source: { provider: 'example', id: 'unrequested' }, state: 'ready', reasons: [] }] };
    return { resolutions: req.sources.map(source => ({ source, state: 'ready', reasons: [] })) };
  } } };
  const sources = Array.from({ length: 35 }, (_, i) => ({ provider: 'example', id: String(i) }));
  sources.push({ ...sources[0], kind: 'issue' }, { provider: 'contested', id: 'x' }, { provider: 'unknown', id: 'x' });
  const result = await resolveAll({ routes: new Map([['example', route], ['contested', { state: 'contested', pluginIds: ['a', 'b'] }]]), sources, detail: 'card', context });
  assert.deepEqual(sizes, [32, 3]);
  assert.equal(result.results.length, 32);
  assert.equal(new Set(result.results.map(r => identityKey(r.source))).size, 32);
  assert.deepEqual(result.outcomes.map(r => r.state), ['ready', 'incompatible']);
});

test('stage concurrency can only be lowered and output is stable in input order', async () => {
  let active = 0, peak = 0;
  const clients = Array.from({ length: 8 }, (_, i) => contributor(`p${i}`, async () => {
    active++; peak = Math.max(peak, active);
    await new Promise(r => setTimeout(r, 5));
    active--; return { candidates: [candidate()] };
  }));
  const result = await linkifyAll({ clients, input, budgets: { concurrency: 2 } });
  assert.equal(peak, 2);
  assert.deepEqual(result.results.map(r => r.pluginId), clients.map(c => c.client.pluginId));
  peak = 0;
  await linkifyAll({ clients, input, budgets: { concurrency: 999 } });
  assert.equal(peak, LIMITS.concurrency);
});

test('builtin resolvers from the same consumer retain their distinct handlers', async () => {
  const routes = new Map(['bb.file', 'bb.thread'].map(provider => [provider, {
    state: 'ready', origin: 'builtin', pluginId: 'consumer',
    handler: async req => ({ resolutions: req.sources.map(source => ({ source, state: 'ready', label: provider, reasons: [] })) }),
  }]));
  const result = await resolveAll({ routes, sources: [{ provider: 'bb.file', id: 'x' }, { provider: 'bb.thread', id: 'y' }], context, detail: 'label' });
  assert.deepEqual(result.results.map(r => r.label), ['bb.file', 'bb.thread']);
});

test('partial resolve preserves valid results and explicitly reports transient omissions', async () => {
  const sources = [{ provider: 'example', id: '1' }, { provider: 'example', id: '2' }];
  const route = { state: 'ready', pluginId: 'target', origin: 'contributed', client: { resolve: async req => ({ resolutions: [{ source: req.sources[0], state: 'ready', reasons: [] }] }) } };
  const result = await resolveAll({ routes: new Map([['example', route]]), sources, context, detail: 'label' });
  assert.equal(result.results.length, 1);
  assert.deepEqual(result.outcomes[0].omittedSources, [sources[1]]);
  await assert.rejects(resolveAll({ routes: new Map(), sources: [{ provider: 'example', id: '1', unknown: true }], context, detail: 'label' }));
});

test('unsorted linkify outputs fail in direct clients and builtins', async () => {
  const output = { candidates: [candidate('example', 3, '2'), candidate()] };
  await assert.rejects(createSupplierClient(sdk(async () => output), 'target').linkify(input), error => error.kind === 'incompatible');
  const result = await linkifyAll({ input, builtins: [{ pluginId: 'consumer', revision: '1', linkify: { providers: [claim()], handler: () => output } }] });
  assert.deepEqual(result.results, []);
  assert.equal(result.outcomes[0].state, 'incompatible');
});

test('discovery bounds a noncooperating list and describe without discarding peers', async () => {
  let listSignal;
  await assert.rejects(enumerateRecognitionSuppliers({ sdk: sdk(async () => envelope(), ({ signal }) => { listSignal = signal; return new Promise(() => {}); }), owner: createRecognitionDiscoveryOwner(), exclude: 'consumer', budgets: { discoveryMs: 15 } }), error => error.kind === 'transient');
  assert.equal(listSignal.aborted, true);
  let describeSignal;
  const result = await enumerateRecognitionSuppliers({
    sdk: sdk(args => { if (args.pluginId === 'slow') { describeSignal = args.signal; return new Promise(() => {}); } return Promise.resolve(envelope()); }, async () => ({ plugins: ['slow', 'good'].map(id => ({ id, status: 'running' })) })),
    owner: createRecognitionDiscoveryOwner(), exclude: 'consumer', budgets: { describeMs: 15 },
  });
  assert.equal(result.rows.find(r => r.pluginId === 'slow').state, 'transient');
  assert.equal(result.rows.find(r => r.pluginId === 'good').state, 'ready');
  assert.equal(describeSignal.aborted, true);
});

test('registration deadlines abort noncooperating handler signals locally', async () => {
  let handlers;
  let handlerSignal;
  registerRecognitionSupplier({ rpc: { register(_contract, supplied) { handlers = supplied; } } }, { revision: '1', linkify: { providers: [claim()], handler: async (_input, signal) => { handlerSignal = signal; return new Promise(() => {}); } } });
  await assert.rejects(handlers[METHODS.linkify](input), error => error.kind === 'transient');
  assert.equal(handlerSignal.aborted, true);
});
