import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adaptCompletedEvent } from '../src/events.ts';
import { identity, resolution } from './fixtures.mjs';
import { correlateRecognizeOutput, correlateFeedOutput, validateRecognizeInput, negotiateVersion, encodeRecognitionCursor, decodeRecognitionCursor, recognitionWindowDigest } from '../src/index.ts';
const descriptor = { kind: 'example/link-observed', namespace: 'example', neutralLabel: 'Link', confirmedLabel: 'Link observed', specificity: 'generic', memberVersion: 'link/1', equivalenceNamespaces: [] };
const capabilities = { revision: 'source-1', supplier: { kinds: [descriptor], recognize: true, resolve: true, enumerate: false } };
async function example() {
  const native = { id: 'evt_1', threadId: 'thr_example', seq: 1, createdAt: 100, scope: { kind: 'turn', turnId: 'turn_1' }, type: 'item/completed', data: { item: { id: 'item_1', type: 'toolCall', status: 'completed', tool: 'example_tool', server: 'example', result: 'See https://example.com/a' } } };
  const adapted = await adaptCompletedEvent(native); assert.equal(adapted.state, 'admitted');
  const event = adapted.event;
  const input = { version: 1, context: { consumer: { pluginId: 'gallery', surface: 'turn' }, threadId: 'thr_example', range: { fromSeq: 1, throughSeq: 1 } }, events: [event], page: { cursor: null, limit: 8 } };
  const candidate = { identity: identity() };
  candidate.identity.ref.kind = descriptor.kind; candidate.identity.specificity = 'generic'; candidate.identity.evidence = { basis: 'text-link', selectedDigest: event.selectedDigest, sites: [{ eventId: 'evt_1', field: 'tool.result', start: 4, end: 25 }], targetUrls: ['https://example.com/a'] };
  return { event, input, candidate, output: { candidates: [candidate], page: { state: 'complete', nextCursor: null } } };
}
test('version negotiation parses capabilities only for shared version and isolates malformed suppliers', () => {
  for (const versions of [[1], [1, 2]]) assert.equal(negotiateVersion({ protocol: 'bb-turn-results', versions, capabilities }).state, 'ready');
  for (const versions of [[2], []]) assert.deepEqual(negotiateVersion({ protocol: 'bb-turn-results', versions, capabilities: { future: true } }), { state: 'incompatible', reason: 'version' });
  assert.deepEqual(negotiateVersion({ protocol: 'wrong', versions: [1], capabilities }), { state: 'incompatible', reason: 'envelope' });
  assert.deepEqual(negotiateVersion({ protocol: 'bb-turn-results', versions: [1], capabilities: {} }), { state: 'incompatible', reason: 'capabilities' });
});
test('recognition validates actual selected digest, exact source, site, URL, descriptor and count', async () => {
  const { input, output } = await example();
  await correlateRecognizeOutput(input, output, [descriptor]);
  const invalidRequest = structuredClone(input); invalidRequest.events[0].selectedDigest = '0'.repeat(64);
  await assert.rejects(() => validateRecognizeInput(invalidRequest), /digest/);
  for (const mutate of [x => x.candidates[0].identity.ref.source.turnId = 'foreign', x => x.candidates[0].identity.evidence.sites[0].end = 100, x => x.candidates[0].identity.evidence.sites[0].start = 0, x => x.candidates[0].identity.evidence.targetUrls[0] = 'https://other.example/a', x => x.candidates[0].identity.specificity = 'typed', x => x.candidates.push(x.candidates[0])]) {
    const bad = structuredClone(output); mutate(bad); await assert.rejects(() => correlateRecognizeOutput(input, bad, [descriptor]));
  }
  const wrongBasis = structuredClone(output); wrongBasis.candidates[0].identity.evidence.basis = 'native-completion';
  await assert.rejects(() => correlateRecognizeOutput(input, wrongBasis));
});
test('recognition page continuation cannot repeat a cursor or silently discard all candidates', async () => {
  const { input, output } = await example(); input.page.cursor = 'c1';
  output.page = { state: 'continued', nextCursor: 'c2' }; await correlateRecognizeOutput(input, output);
  output.page.nextCursor = 'c1'; await assert.rejects(() => correlateRecognizeOutput(input, output));
  output.page.nextCursor = 'c2'; output.candidates = []; await assert.rejects(() => correlateRecognizeOutput(input, output));
  output.page = { state: 'truncated', nextCursor: null, reason: 'finite source bound' }; await correlateRecognizeOutput(input, output);
});
test('recognition cursor binds revision and complete selected window, without clock or random state', async () => {
  const { input } = await example(); const digest = await recognitionWindowDigest(input);
  const cursor = encodeRecognitionCursor({ version: 1, revision: 'source-1', inputDigest: digest, afterOrdinal: 64 });
  assert.equal(decodeRecognitionCursor(cursor, { revision: 'source-1', inputDigest: digest }).afterOrdinal, 64);
  assert.throws(() => decodeRecognitionCursor(cursor, { revision: 'source-2', inputDigest: digest }));
  input.context.consumer.surface = 'other'; assert.notEqual(await recognitionWindowDigest(input), digest);
});
test('feed-only origins require thread/range, advertised kind and source epoch; snapshot overlap may be newer than H', async () => {
  const input = { version: 1, threadId: 'thr_example', range: { fromSeq: 1, throughSeq: 10 }, cursor: null, limit: 8 };
  const value = resolution(); value.revision.sequence = 11;
  const output = { state: 'page', epoch: 'images-1', phase: 'snapshot', throughRevision: 10, rows: [{ kind: 'upsert', value }], nextCursor: 'c1', settled: false, coverage: { retainedFrom: 1, unplaced: 0, complete: true } };
  await correlateFeedOutput(input, output);
  for (const mutate of [x => x.rows[0].value.identity.ref.source.threadId = 'other', x => x.rows[0].value.identity.ref.source.seq = 11, x => x.rows[0].value.revision.epoch = 'other', x => x.phase = 'changes']) {
    const bad = structuredClone(output); mutate(bad);
    // Proof/source mismatch is independently rejected before range admission.
    await assert.rejects(() => correlateFeedOutput(input, bad));
  }
  await assert.rejects(() => correlateFeedOutput(input, output, [descriptor]));
});
test('empty feed can advance a scoped journal scan; caught-up empty cursor is valid, new reset reason normalizes', async () => {
  const input = { version: 1, threadId: 'thr_example', range: null, cursor: 'c1', limit: 8 };
  const page = { state: 'page', epoch: 'images-1', phase: 'changes', throughRevision: 20, rows: [], nextCursor: 'c2', settled: false, coverage: { retainedFrom: 1, unplaced: 0, complete: true } };
  await correlateFeedOutput(input, page);
  page.nextCursor = 'c1'; await assert.rejects(() => correlateFeedOutput(input, page));
  page.settled = true; await correlateFeedOutput(input, page);
  assert.equal((await correlateFeedOutput(input, { state: 'reset', epoch: 'new', reason: 'future-retention-policy', restartCursor: null, retainedFrom: null })).reason, 'source-error');
});
