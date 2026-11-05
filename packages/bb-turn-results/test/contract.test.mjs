import { test } from 'node:test';
import assert from 'node:assert/strict';
import { identity, resolution } from './fixtures.mjs';
import { decodeInput, decodeOutput, ResolveInputSchema, ResolveOutputSchema, ResolutionSchema, ContentBlockSchema, InputSchemas, DescribeEnvelopeSchema, FeedOutputSchema, ResultIdentitySchema, SafeUrlSchema, claimKey, occurrenceGroupKey, suppressesGeneric, canonicalJson, canonicalByteLength, resolveOutcomeBudget, buildResolveOutput, correlateResolveOutput, identityDigest, checkResolutionTransition } from '../src/index.ts';
const request = items => ({ version: 1, threadId: 'thr_example', items, maxOutcomeBytes: resolveOutcomeBudget(items.length) });

test('recursive inputs reject unknown fields; additive output is byte-admitted then normalized for strict echoes', () => {
  const input = request([identity()]);
  for (const mutate of [x => x.extra = true, x => x.items[0].ref.source.extra = true, x => x.items[0].artifact.extra = true, x => x.items[0].evidence.extra = true]) {
    const bad = structuredClone(input); mutate(bad);
    assert.throws(() => decodeInput(ResolveInputSchema, bad));
  }
  const raw = { ...resolution(), future: { meaning: 'ignored-v1' } };
  raw.identity.evidence.future = 'ignored-v1'; raw.proof.source.future = 'ignored-v1';
  const decoded = decodeOutput(ResolutionSchema, raw);
  assert.equal(decoded.future, undefined);
  assert.doesNotThrow(() => decodeInput(ResolveInputSchema, request([decoded.identity])));
  raw.future.meaning = 'x'.repeat(65536);
  assert.throws(() => decodeOutput(ResolutionSchema, raw), error => error.code === 'over-budget');
});
test('closed meanings reject unknown types; identifiers and URLs enforce UTF8, Unicode and credential bounds', () => {
  assert.throws(() => ResolutionSchema.parse({ ...resolution(), proof: { ...resolution().proof, kind: 'future-proof' } }));
  assert.throws(() => ResultIdentitySchema.parse({ ...identity(), ref: { ...identity().ref, member: 'bad/member' } }));
  assert.throws(() => InputSchemas.source.parse({ ...identity().ref.source, turnId: 'é'.repeat(129) }));
  assert.throws(() => InputSchemas.source.parse({ ...identity().ref.source, turnId: '\ud800' }));
  for (const url of ['javascript:alert(1)', 'data:image/png;base64,xxx', 'https://user:pass@host/a', '//host/path', 'http://host/a\\b']) assert.equal(SafeUrlSchema.safeParse(url).success, false);
  assert.equal(SafeUrlSchema.safeParse('https://EXAMPLE.com:443/a?b=2&a=1#part').success, true);
});
test('compatible content accepts a referent and advisory layout without event/tool/outcome framing', () => {
  const value = ContentBlockSchema.parse({ identity: { provider: 'example', id: 'plan-7', kind: 'plan' }, fallback: { kind: 'card', title: 'Release plan' }, layout: { preferred: 'full-width' }, presentation: { schema: 'example/plan@1', data: { compact: true } } });
  assert.equal(value.layout.preferred, 'full-width');
  assert.equal(value.source, undefined); assert.equal(value.knowledge, undefined);
  assert.throws(() => ContentBlockSchema.parse({ ...value, presentation: { ...value.presentation, data: { bytes: 'x'.repeat(4096) } } }));
});
test('owner-bound keys keep two operations on same artifact separate; contested grouping never merges storage', () => {
  const a = identity(), b = identity(2); b.artifact = a.artifact;
  assert.notEqual(claimKey('images', a.ref), claimKey('images', b.ref));
  assert.notEqual(claimKey('images', a.ref), claimKey('other-images', a.ref));
  a.equivalence = { namespace: 'example.image', operationId: 'op1', member: 'image' };
  assert.equal(occurrenceGroupKey('images', a), occurrenceGroupKey('other-images', a));
  b.ref.source = a.ref.source; b.ref.kind = 'example/image-reviewed'; b.equivalence = a.equivalence;
  assert.notEqual(occurrenceGroupKey('images', a), occurrenceGroupKey('images', b));
});
test('typed/generic suppression requires exact event/site and canonical destination; no href deduplication', () => {
  const typed = identity(), generic = structuredClone(typed);
  generic.specificity = 'generic'; generic.evidence.basis = 'text-link';
  generic.evidence.sites = [{ eventId: 'evt_1', field: 'tool.result', start: 10, end: 30 }];
  generic.evidence.targetUrls = ['https://EXAMPLE.com:443/a'];
  typed.evidence.sites = [{ ...generic.evidence.sites[0], start: 0, end: 40 }]; typed.evidence.targetUrls = ['https://example.com/a'];
  assert.equal(suppressesGeneric(typed, generic), true);
  generic.ref.source.eventId = 'evt_2'; assert.equal(suppressesGeneric(typed, generic), false);
  generic.ref.source.eventId = 'evt_1'; generic.evidence.sites[0].field = 'command.output';
  assert.equal(suppressesGeneric(typed, generic), false);
});
test('proof, terminal evidence and source-route validation prevent observation-to-delivery promotion', () => {
  for (const mutate of [x => x.proof.source.turnId = 'foreign', x => x.proof.selectedDigest = 'c'.repeat(64), x => x.outcomeEvidence = null, x => x.outcomeEvidence.kind = 'external-success', x => x.route = { kind: 'source', threadId: 'other', eventId: 'evt_1', seq: 1 }]) {
    const bad = resolution(); mutate(bad); assert.throws(() => ResolutionSchema.parse(bad));
  }
});
test('late feed can bootstrap complete immutable Slack identity/proof without recognition', () => {
  const row = resolution(); row.proof = { kind: 'initial-operation', source: row.identity.ref.source, receiptId: 'receipt1', receiptDigest: 'c'.repeat(64), operationId: 'group1', binderVersion: 'slack-binder/1', tool: { pluginId: 'rosetta-slack', name: 'send_slack_message' } };
  row.identity.evidence.basis = 'typed-receipt';
  row.outcomeEvidence.kind = 'external-success'; row.identity.artifact = { provider: 'rosetta-slack.delivery', id: 'group1', kind: 'message' }; row.identity.lookup = { groupId: 'group1', receiptId: 'receipt1' };
  const feed = decodeOutput(FeedOutputSchema, { state: 'page', epoch: row.revision.epoch, phase: 'snapshot', throughRevision: 1, rows: [{ kind: 'upsert', value: row }], nextCursor: 'c1', settled: false, coverage: { retainedFrom: 1, unplaced: 0, complete: true } });
  assert.equal(canonicalJson(feed.rows[0].value.identity), canonicalJson(row.identity));
});
test('same-operation deliberate Slack recovery advances unknown to confirmed without correction', () => {
  const previous = resolution(); previous.proof = { kind: 'initial-operation', source: previous.identity.ref.source, receiptId: 'receipt1', receiptDigest: 'c'.repeat(64), operationId: 'group1', binderVersion: 'slack-binder/1', tool: { pluginId: 'rosetta-slack', name: 'send_slack_message' } };
  previous.identity.evidence.basis = 'typed-receipt';
  previous.knowledge = 'unknown'; previous.outcomeEvidence = null; previous.sourceState = { status: 'dead-letter' };
  const retry = structuredClone(previous); retry.revision.sequence++; retry.sourceState.status = 'retrying';
  assert.equal(checkResolutionTransition(previous, retry), 'apply');
  const delivered = structuredClone(retry); delivered.revision.sequence++; delivered.knowledge = 'confirmed'; delivered.outcomeEvidence = { kind: 'external-success', id: 'group1:done', digest: 'd'.repeat(64), recordedAt: 200 }; delivered.sourceState.status = 'done';
  assert.equal(checkResolutionTransition(retry, delivered), 'apply'); assert.equal(delivered.correction, undefined);
  const regression = structuredClone(delivered); regression.revision.sequence++; regression.knowledge = 'unknown'; regression.outcomeEvidence = null;
  assert.throws(() => checkResolutionTransition(delivered, regression));
  assert.equal(checkResolutionTransition(delivered, retry), 'stale');
});
test('epoch changes cannot erase retained terminal knowledge; explicit corrections identify prior evidence', () => {
  const a = resolution(), b = resolution(); b.revision = { epoch: 'restored-2', sequence: 0 }; b.knowledge = 'unknown'; b.outcomeEvidence = null;
  assert.equal(checkResolutionTransition(a, b), 'revalidate');
  b.correction = { supersedesEvidenceDigest: a.outcomeEvidence.digest, reason: 'original evidence was invalid' };
  assert.equal(checkResolutionTransition(a, b), 'apply');
  const conflict = resolution(); conflict.availability.state = 'unavailable';
  assert.throws(() => checkResolutionTransition(a, conflict), /Same revision/);
});
test('describe envelope admits unsupported and empty version arrays without decoding capabilities', () => {
  for (const versions of [[1], [1, 2], [2], []]) assert.deepEqual(DescribeEnvelopeSchema.parse({ protocol: 'bb-turn-results', versions, capabilities: { future: true } }).versions, versions);
  assert.throws(() => DescribeEnvelopeSchema.parse({ protocol: 'bb-turn-results', versions: [0], capabilities: {} }));
});
test('Resolve preserves exact indexed/digested outcomes for every protocol batch count', async () => {
  for (let n = 1; n <= 32; n++) {
    const input = request(Array.from({ length: n }, (_, i) => identity(i + 1)));
    const output = await buildResolveOutput(input, input.items.map((_, i) => i % 3 === 0 ? { state: 'resolved', value: resolution(i + 1) } : { state: i % 3 === 1 ? 'unavailable' : 'unrecognized', reason: 'not-retained' }));
    assert.ok(canonicalByteLength(output) <= 65536);
    const actual = await correlateResolveOutput(input, output);
    assert.equal(actual.resolutions.length, n);
    assert.deepEqual(actual.resolutions.map(x => x.requestIndex), Array.from({ length: n }, (_, i) => i));
  }
});
test('rich legal 4096-byte identities defer from eight items and resolve at smaller budgets', async () => {
  const items = Array.from({ length: 8 }, (_, i) => {
    const item = identity(i + 1); item.artifact.id += 'x'.repeat(1900); item.lookup = { padding: 'é'.repeat(300) }; item.evidence.targetUrls = ['https://example.com/' + 'p'.repeat(700)];
    const rest = 4096 - canonicalByteLength(item); item.evidence.targetUrls[0] += 'x'.repeat(rest);
    assert.equal(canonicalByteLength(item), 4096); assert.doesNotThrow(() => InputSchemas.identity.parse(item)); return item;
  });
  const proposals = items.map((item, i) => { const value = resolution(i + 1); value.identity = item; value.fallback = { kind: 'card', title: 'Rich result', fields: Array.from({ length: 8 }, () => ({ label: 'L'.repeat(64), value: 'v'.repeat(512) })) }; return { state: 'resolved', value }; });
  const output = await buildResolveOutput(request(items), proposals);
  assert.ok(output.resolutions.every(x => x.state === 'budget-deferred'));
  await correlateResolveOutput(request(items), output);
  const smaller = await buildResolveOutput(request(items.slice(0, 4)), proposals.slice(0, 4));
  assert.ok(smaller.resolutions.every(x => x.state === 'resolved'));
  assert.equal((canonicalJson(smaller).match(/"identity":/g) ?? []).length, 4);
});
test('singleton 64512/64513 boundaries include all additive bytes and return finite oversized state', async () => {
  const value = resolution(); value.extra = '';
  const correlation = { requestIndex: 0, identityDigest: await identityDigest(value.identity), state: 'resolved', value };
  value.extra = 'x'.repeat(64512 - canonicalByteLength(correlation));
  assert.equal(canonicalByteLength(correlation), 64512);
  const input = request([value.identity]);
  const fitting = await buildResolveOutput(input, [{ state: 'resolved', value }]);
  assert.equal(fitting.resolutions[0].state, 'resolved'); await correlateResolveOutput(input, fitting);
  value.extra += 'x';
  const oversized = await buildResolveOutput(input, [{ state: 'resolved', value }]);
  assert.equal(oversized.resolutions[0].state, 'oversized'); assert.equal(oversized.resolutions[0].neededBytes, 64513);
  await correlateResolveOutput(input, oversized);
});
test('client rejects duplicate/foreign/missing correlations, altered identities and hidden per-outcome/envelope excess', async () => {
  const input = request([identity(), identity(2)]);
  const good = await buildResolveOutput(input, [{ state: 'resolved', value: resolution() }, { state: 'unavailable', reason: 'not-found' }]);
  const cases = [x => x.resolutions.pop(), x => x.resolutions[1].requestIndex = 0, x => x.resolutions[0].identityDigest = '0'.repeat(64), x => x.resolutions[0].value.identity.artifact.id = 'wrong', x => x.resolutions[0].future = 'x'.repeat(input.maxOutcomeBytes), x => x.future = 'x'.repeat(1024)];
  for (const mutate of cases) { const bad = structuredClone(good); mutate(bad); await assert.rejects(() => correlateResolveOutput(input, bad)); }
  await assert.rejects(() => buildResolveOutput(input, [{ state: 'unavailable', reason: 'missing' }]));
  assert.throws(() => ResolveOutputSchema.parse({ resolutions: [{ requestIndex: 0, identityDigest: 'a'.repeat(64), state: 'future' }] }));
});
