import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSupplierConformance, runConsumerConformance, createRegisteredHandlerRpc } from '../src/testing.ts';
import { z } from 'zod';
import { registerTurnResultsParticipant } from '../src/bb.ts';
import { buildResolveOutput, resolveOutcomeBudget } from '../src/index.ts';
import { identity, resolution } from './fixtures.mjs';
const descriptor = { kind: 'example/image-created', namespace: 'example', neutralLabel: 'Image', confirmedLabel: 'Image generated', specificity: 'typed', memberVersion: 'image/1', equivalenceNamespaces: [] };
const input = { version: 1, threadId: 'thr_example', items: [identity()], maxOutcomeBytes: resolveOutcomeBudget(1) };
test('registered transport needs only the actual behavior port, without SDK host implementation identity', async () => {
  const seen = [];
  const rpc = createRegisteredHandlerRpc({ harness: { behavior: { async callRpc(method, value) { seen.push([method, value]); return { answer: 42 }; } } } }, 'independent-source');
  assert.deepEqual(await rpc.callRpc({ pluginId: 'independent-source', method: 'query', input: null, outputSchema: z.object({ answer: z.number() }) }), { answer: 42 });
  assert.deepEqual(seen, [['query', null]]);
});
function options() {
  return { pluginId: 'kit-source', source: { entry: 'package-self-test-fixture', revision: '1' }, sourcePorts: { reads: 0 }, observeSourceAccess() { return this.sourcePorts.reads; },
    participantFactory(bb, ports) { return registerTurnResultsParticipant(bb, { pluginId: 'kit-source', capabilities: { revision: '1', supplier: { kinds: [descriptor], recognize: true, resolve: true, enumerate: false } }, recognize: () => ({ candidates: [], page: { state: 'complete', nextCursor: null } }), resolve: async request => { ports.reads++; return buildResolveOutput(request, request.items.map(() => ({ state: 'resolved', value: resolution() }))); } }); },
    recognizeCases: [{ name: 'empty', input: { version: 1, context: { consumer: { pluginId: 'gallery', surface: 'turn' }, threadId: 'thr_example', range: { fromSeq: 1, throughSeq: 1 } }, events: [], page: { cursor: null, limit: 8 } }, expected: { candidates: [], page: { state: 'complete', nextCursor: null } } }],
    resolveCases: [{ name: 'native-observation', input, verify: output => assert.equal(output.resolutions[0].value.outcomeEvidence.kind, 'observation') }],
  };
}
test('supplier kit invokes registered public fake-host handlers and semantic expectations; label remains source-only', async () => {
  const report = await runSupplierConformance(options());
  assert.equal(report.passed, true, JSON.stringify(report)); assert.equal(report.proof, 'registered-handler-source');
  assert.ok(report.checks.some(check => check.name === 'registered-recursive-input-rejection' && check.state === 'passed'));
});
test('missing source witnesses or access observer cannot receive a complete pass', async () => {
  const value = options(); delete value.observeSourceAccess; value.resolveCases = [];
  const report = await runSupplierConformance(value); assert.equal(report.passed, false);
  assert.ok(report.checks.some(check => check.required && check.state === 'skipped'));
});
test('source expectation and actual injected I/O during recognition fail conformance', async () => {
  const value = options(), original = value.participantFactory;
  value.participantFactory = (bb, ports) => original({ ...bb, rpc: { register(contract, handlers, opts) { const patched = { ...handlers, turnResultsV1Recognize: (request, context) => { ports.reads++; return handlers.turnResultsV1Recognize(request, context); } }; bb.rpc.register(contract, patched, opts); } } }, ports);
  const report = await runSupplierConformance(value); assert.equal(report.passed, false);
  assert.ok(report.checks.some(check => check.name === 'recognize:empty' && check.state === 'failed'));
});
test('factory disposal failure remains visible and fake host still disposes', async () => {
  const value = options(), original = value.participantFactory;
  value.participantFactory = (bb, ports) => { const registration = original(bb, ports); return () => { registration.dispose(); throw Error('disposal witness'); }; };
  const report = await runSupplierConformance(value); assert.equal(report.passed, false);
  assert.ok(report.checks.some(check => check.name === 'factory-disposal' && check.state === 'failed'));
  assert.ok(report.checks.some(check => check.name === 'fake-host-disposal' && check.state === 'passed'));
});
test('consumer kit checks actual admission response through owner-bound invalidation method', async () => {
  const report = await runConsumerConformance({ pluginId: 'kit-gallery', source: { entry: 'package-self-test-fixture', revision: '1' }, sourcePorts: {}, participantFactory(bb) { return registerTurnResultsParticipant(bb, { pluginId: 'kit-gallery', capabilities: { revision: '1', consumer: { invalidate: true } }, invalidate: input => ({ state: input.threadId === 'thr_example' ? 'dirty' : 'not-admitted' }) }); }, invalidateCases: [{ name: 'admitted', input: { version: 1, supplierPluginId: 'kit-source', threadId: 'thr_example', revision: { epoch: 'source-1', sequence: 1 }, affected: 'thread' }, expected: { state: 'dirty' } }] });
  assert.equal(report.passed, true, JSON.stringify(report));
});
