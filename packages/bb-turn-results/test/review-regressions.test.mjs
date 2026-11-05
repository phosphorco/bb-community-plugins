import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { resolution, identity } from './fixtures.mjs';
// Same adversarial cases run against both authored modules and emitted entries.
const entry = name => process.env.BB_RESULTS_TEST_EMITTED === '1' ? `../dist/${name}.js` : `../src/${name}.ts`;
const { createRegisteredHandlerRpc } = await import(entry('testing'));
const { registerTurnResultsParticipant, createResultsSupplierClient, ResultsCallError } = await import(entry('bb'));
const { checkResolutionTransition, buildResolveOutput, correlateResolveOutput, correlateRecognizeOutput, correlateFeedOutput, resolveOutcomeBudget, METHODS, canonicalByteLength, SOURCE_FAULT_BYTES } = await import(entry('index'));
const { adaptCompletedEvent } = await import(entry('events'));

const request = item => ({ version: 1, threadId: 'thr_example', items: [item], maxOutcomeBytes: resolveOutcomeBudget(1) });
const isKind = kind => error => error instanceof ResultsCallError && error.kind === kind;
function operation() {
  const row = resolution(); row.identity.evidence.basis = 'typed-receipt';
  row.proof = { kind: 'initial-operation', source: row.identity.ref.source, receiptId: 'receipt', receiptDigest: 'c'.repeat(64), operationId: 'operation', binderVersion: 'binder/1', tool: { pluginId: 'example', name: 'send' } };
  row.outcomeEvidence.kind = 'external-success'; return row;
}
test('complete terminal evidence is immutable across revisions/epochs unless explicitly corrected', () => {
  for (const field of ['recordedAt', 'id', 'digest']) {
    const previous = operation(), next = structuredClone(previous); next.revision.sequence++;
    next.outcomeEvidence[field] = field === 'recordedAt' ? 101 : field === 'digest' ? 'd'.repeat(64) : 'new-evidence';
    assert.throws(() => checkResolutionTransition(previous, next));
    next.revision.epoch = 'restored'; assert.equal(checkResolutionTransition(previous, next), 'revalidate');
    next.correction = { supersedesEvidenceDigest: previous.outcomeEvidence.digest, reason: 'source evidence corrected' };
    assert.equal(checkResolutionTransition(previous, next), 'apply');
  }
});
test('all initial-operation proof bindings remain fixed; correction cannot rename the operation', () => {
  for (const mutate of [p => p.receiptId = 'another', p => p.receiptDigest = 'd'.repeat(64), p => p.operationId = 'another', p => p.binderVersion = 'binder/2', p => p.tool.pluginId = 'another', p => p.tool.name = 'another']) {
    const previous = operation(), next = structuredClone(previous); next.revision.sequence++; mutate(next.proof);
    assert.throws(() => checkResolutionTransition(previous, next));
    next.correction = { supersedesEvidenceDigest: previous.outcomeEvidence.digest, reason: 'not authority to rename' };
    assert.throws(() => checkResolutionTransition(previous, next));
    next.revision.epoch = 'restored'; assert.equal(checkResolutionTransition(previous, next), 'revalidate');
  }
});
test('native assertion facts and known image digests remain fixed; optional digest enrichment and availability recover', () => {
  const previous = resolution(), enriched = structuredClone(previous); enriched.revision.sequence++; enriched.proof.artifactDigest = 'c'.repeat(64);
  enriched.availability = { state: 'available', asOf: 200, expiresAt: null };
  assert.equal(checkResolutionTransition(previous, enriched), 'apply');
  for (const digest of [undefined, 'd'.repeat(64)]) {
    const next = structuredClone(enriched); next.revision.sequence++;
    if (digest === undefined) delete next.proof.artifactDigest; else next.proof.artifactDigest = digest;
    assert.throws(() => checkResolutionTransition(enriched, next));
    next.revision.epoch = 'restored'; assert.equal(checkResolutionTransition(enriched, next), 'revalidate');
  }
  for (const proof of [
    { kind: 'native-command', source: previous.identity.ref.source, selectedDigest: 'a'.repeat(64), exitCode: 0, assertion: 'address-observed' },
    { kind: 'native-tool-observation', source: previous.identity.ref.source, selectedDigest: 'a'.repeat(64), tool: { server: 'example', name: 'read' }, assertion: 'artifact-reported' },
  ]) {
    const a = resolution(); a.proof = proof; a.identity.evidence.basis = proof.kind === 'native-command' ? 'command-output' : 'typed-receipt';
    const b = structuredClone(a); b.revision.sequence++;
    if (b.proof.kind === 'native-command') b.proof.exitCode = 1; else b.proof.tool.name = 'write';
    assert.throws(() => checkResolutionTransition(a, b));
    b.revision.epoch = 'restored'; assert.equal(checkResolutionTransition(a, b), 'revalidate');
  }
});
test('recognized generic observations cannot acquire external-operation proof via Resolve or feed', async () => {
  const native = { id: 'evt_1', threadId: 'thr_example', seq: 1, createdAt: 100, scope: { kind: 'turn', turnId: 'turn_1' }, type: 'item/completed', data: { item: { id: 'item_1', type: 'toolCall', status: 'completed', server: 'example', tool: 'read', result: 'https://example.com/a' } } };
  const adapted = await adaptCompletedEvent(native); assert.equal(adapted.state, 'admitted');
  const row = resolution(); row.identity.specificity = 'generic'; row.identity.ref.kind = 'example/link-observed';
  row.identity.evidence = { basis: 'text-link', selectedDigest: adapted.event.selectedDigest, sites: [{ eventId: 'evt_1', field: 'tool.result', start: 0, end: 21 }], targetUrls: ['https://example.com/a'] };
  const input = { version: 1, context: { consumer: { pluginId: 'gallery', surface: 'turn' }, threadId: 'thr_example', range: { fromSeq: 1, throughSeq: 1 } }, events: [adapted.event], page: { cursor: null, limit: 8 } };
  await correlateRecognizeOutput(input, { candidates: [{ identity: row.identity }], page: { state: 'complete', nextCursor: null } });
  row.proof = { kind: 'native-tool-observation', source: row.identity.ref.source, selectedDigest: adapted.event.selectedDigest, tool: { server: 'example', name: 'read' }, assertion: 'link-observed' };
  const valid = await buildResolveOutput(request(row.identity), [{ state: 'resolved', value: row }]);
  await correlateResolveOutput(request(row.identity), valid);
  const promoted = structuredClone(row); promoted.proof = operation().proof; promoted.outcomeEvidence.kind = 'external-success';
  await assert.rejects(() => buildResolveOutput(request(row.identity), [{ state: 'resolved', value: promoted }]));
  const raw = structuredClone(valid); raw.resolutions[0].value = promoted;
  await assert.rejects(() => correlateResolveOutput(request(row.identity), raw));
  await assert.rejects(() => correlateFeedOutput({ version: 1, threadId: 'thr_example', range: null, cursor: null, limit: 8 }, { state: 'page', epoch: row.revision.epoch, phase: 'snapshot', throughRevision: 1, rows: [{ kind: 'upsert', value: promoted }], nextCursor: 'c1', settled: true, coverage: { retainedFrom: 1, unplaced: 0, complete: true } }));
  const command = structuredClone(row); command.identity.evidence.sites[0].field = 'command.output'; command.proof = { kind: 'native-command', source: row.identity.ref.source, selectedDigest: adapted.event.selectedDigest, exitCode: 1, assertion: 'address-observed' };
  await buildResolveOutput(request(command.identity), [{ state: 'resolved', value: command }]);
  await buildResolveOutput(request(operation().identity), [{ state: 'resolved', value: operation() }]);
});

const descriptor = { kind: 'example/image-created', namespace: 'example', neutralLabel: 'Image', confirmedLabel: 'Image generated', specificity: 'typed', memberVersion: '1', equivalenceNamespaces: [] };
function participant(resolve) { return { pluginId: 'registered-source', capabilities: { revision: '1', supplier: { kinds: [descriptor], recognize: false, resolve: true, enumerate: false } }, resolve }; }
test('actual registered SDK boundary carries bounded timeout/contract/source/disposal faults without class preservation', async () => {
  for (const [name, handler, kind] of [
    ['timeout', () => new Promise(() => {}), 'timeout'],
    ['malformed', () => ({ resolutions: [] }), 'incompatible'],
    ['builder wrong count', input => buildResolveOutput(input, []), 'incompatible'],
    ['builder changed identity', input => { const row = resolution(); row.identity.artifact.id = 'changed'; return buildResolveOutput(input, [{ state: 'resolved', value: row }]); }, 'incompatible'],
    ['builder invalid proof', input => { const row = resolution(); row.proof.selectedDigest = 'f'.repeat(64); return buildResolveOutput(input, [{ state: 'resolved', value: row }]); }, 'incompatible'],
    ['builder envelope', input => buildResolveOutput(input, [{ state: 'resolved', value: resolution() }], { padding: 'x'.repeat(1024) }), 'incompatible'],
    ['builder JSON admission', input => buildResolveOutput(input, [{ state: 'resolved', value: { ...resolution(), future: undefined } }]), 'incompatible'],
    ['changed identity', async input => { const output = await buildResolveOutput(input, [{ state: 'resolved', value: resolution() }]); output.resolutions[0].value.identity.artifact.id = 'changed'; return output; }, 'incompatible'],
    ['exception', () => { throw new Error('private secret never crosses the boundary'); }, 'source-error'],
  ]) {
    const host = createFakePluginHost({ pluginId: 'registered-source' });
    const registration = registerTurnResultsParticipant(host.bb, participant(handler), { budgets: { resolveMs: kind === 'timeout' ? 10 : 1000 } });
    try {
      const raw = await host.harness.behavior.callRpc(METHODS.resolve, request(identity()));
      assert.deepEqual(raw, { protocol: 'bb-turn-results-fault', version: 1, method: METHODS.resolve, code: kind }, name);
      assert.ok(canonicalByteLength(raw) <= SOURCE_FAULT_BYTES);
      const client = createResultsSupplierClient({ plugins: createRegisteredHandlerRpc(host, 'registered-source') }, 'registered-source');
      await assert.rejects(client.resolve(request(identity())), isKind(kind), name);
    } finally { registration.dispose(); await host.harness.lifecycle.dispose(); }
  }
  const host = createFakePluginHost({ pluginId: 'registered-source' }); let invoked = 0, signal;
  const registration = registerTurnResultsParticipant(host.bb, participant((_, bounded) => { invoked++; signal = bounded; return new Promise(() => {}); }));
  try {
    const rpc = createRegisteredHandlerRpc(host, 'registered-source');
    await assert.rejects(rpc.callRpc({ pluginId: 'registered-source', method: METHODS.resolve, input: { ...request(identity()), future: true }, outputSchema: { parse: x => x } }), e => e.status === 400 && e.body.error.code === 'invalid_input');
    assert.equal(invoked, 0);
    const client = createResultsSupplierClient({ plugins: rpc }, 'registered-source');
    const pending = client.resolve(request(identity())); const rejected = assert.rejects(pending, isKind('aborted'));
    await new Promise(done => setTimeout(done, 0)); registration.dispose(); await rejected; assert.equal(signal.aborted, true);
    await assert.rejects(client.describe(), isKind('aborted'));
  } finally { registration.dispose(); await host.harness.lifecycle.dispose(); }
});
test('unwrapped native handler errors retain production source-error policy; malformed faults fail closed', async () => {
  const host = createFakePluginHost({ pluginId: 'registered-source' });
  const schema = { '~standard': { version: 1, vendor: 'test', validate: value => ({ value }) } };
  host.bb.rpc.register({ [METHODS.describe]: { input: schema, output: schema } }, { [METHODS.describe]: () => { throw new Error('untyped error'); } });
  try { await assert.rejects(createResultsSupplierClient({ plugins: createRegisteredHandlerRpc(host, 'registered-source') }, 'registered-source').describe(), isKind('source-error')); }
  finally { await host.harness.lifecycle.dispose(); }
  for (const fault of [
    { protocol: 'bb-turn-results-fault', version: 2, method: METHODS.resolve, code: 'timeout' },
    { protocol: 'bb-turn-results-fault', version: 1, method: METHODS.describe, code: 'timeout' },
    { protocol: 'bb-turn-results-fault', version: 1, method: METHODS.resolve, code: 'future' },
    { protocol: 'bb-turn-results-fault', version: 1, method: METHODS.resolve, code: 'timeout', extra: 'x'.repeat(512) },
  ]) {
    await assert.rejects(createResultsSupplierClient({ plugins: { callRpc: async () => fault } }, 'registered-source').resolve(request(identity())), isKind('incompatible'));
  }
});
