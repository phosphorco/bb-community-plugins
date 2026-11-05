/** Independent synthetic SDK source fixtures; no producer/live proof. Exercises emitted public adapter. */
import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { createNativeSourceAdapter, NATIVE_SOURCE_LIMITS } from '@phosphorco/bb-identity/native';
import { externalPersonSnapshotCodec } from '@phosphorco/bb-identity/model';
import { defineNativeSourceConformance } from '@phosphorco/bb-identity/native/testing';
const adapter = createNativeSourceAdapter();
const actor = name => ({ identity: { kind: 'person', key: `person:${name}`, issuer: 'fixture', subject: name }, presentation: { displayName: name, handle: null, avatarUrl: null }, evidence: 'provider-verified' });
const machine = { identity: { kind: 'machine', key: 'machine:fixture', hostId: 'host', instanceId: 'instance' }, presentation: { displayName: 'fixture machine', handle: null, avatarUrl: null }, evidence: 'machine' };
const author = actor('author'), editor = actor('editor'), mentioned = actor('mentioned');
const mention = { identity: mentioned.identity, presentation: mentioned.presentation, source: { pluginId: 'fixture', generation: 'g1' } };
const text = value => ({ type: 'text', text: value, mentions: [] });
const row = (seq, type, data, turnId = null) => ({ id: `event-${seq}`, seq, createdAt: seq, threadId: 'thread', scope: turnId ? { kind: 'turn', turnId } : { kind: 'thread' }, type, data });
const request = (seq, id, groups, actors = groups.map(() => author), initiator = 'user') => row(seq, 'client/turn/requested', { direction: 'outbound', requestId: id, source: 'tell', initiator, senderThreadId: null, input: groups.flat(), inputGroups: groups, p6rAuthors: actors, p6rEditors: groups.map(() => editor), p6rMentionedTargets: [mention], target: { kind: 'new-turn' }, request: { method: 'turn/start', params: {} }, execution: { model: 'fixture', reasoningLevel: 'low', permissionMode: 'readonly', serviceTier: 'fixture', source: 'client/turn/requested' } });
const accept = (seq, id, turnId = 'turn') => row(seq, 'turn/input/accepted', { clientRequestId: id, providerThreadId: 'provider' }, turnId);
const delta = (seq, itemId, value, turnId = 'turn') => row(seq, 'item/agentMessage/delta', { itemId, delta: value }, turnId);
const completed = (seq, itemId, value, phase) => row(seq, 'item/completed', { item: { type: 'agentMessage', id: itemId, text: value, phase } }, 'turn');
const terminal = (seq = 9, status = 'completed', turnId = 'turn') => row(seq, 'turn/completed', { providerThreadId: 'provider', status }, turnId);
const assistantRow = (id, start, end, value, turnId = 'turn') => ({ id, kind: 'conversation', role: 'assistant', threadId: 'thread', turnId, createdAt: end, startedAt: start, sourceSeqStart: start, sourceSeqEnd: end, messageSeq: end, text: value, attachments: null, turnRequest: null });
const timeline = (rows, maxSeq = 9) => ({ maxSeq, rows, contextSize: null, modelFallback: null, pendingTodos: null, providerCommands: null, sessionOptions: null, timelinePage: { historySnapshot: 'snapshot', olderCursor: null, olderRowsSourceSeqEnd: null, returnedSegmentCount: rows.length } });
const source = { kind: 'assistant-terminal', threadId: 'thread', terminalEventId: 'event-9', scope: { turnId: 'turn' } };
const value = result => { assert.equal(result.ok, true, JSON.stringify(result)); return result.value; };
const r1 = request(1, 'creq_one', [[text('question A')], [text('question B')]], [author, machine]);
const r2 = request(3, 'creq_two', [[text('steer')]], [actor('other')]);
const events = [r1, accept(2, 'creq_one'), r2, accept(4, 'creq_two'), completed(5, 'comment', 'Commentary.', 'commentary'), delta(6, 'final', 'Retained '), delta(7, 'final', 'partial.'), terminal()];
const projection = timeline([assistantRow('comment-row', 5, 5, 'Commentary.'), assistantRow('delta-row', 6, 7, 'Retained partial.')]);

test('opaque timeline snapshot tokens are not entity identifiers; source and resource fences remain',()=>{
 const baseline=value(adapter.resolve({source,events,timeline:projection}));
 for(const length of [256,257,320,1024]){
  const page=structuredClone(projection);page.timelinePage.historySnapshot='x'.repeat(length);
  const actual=value(adapter.resolve({source,events,timeline:page}));
  assert.deepEqual(actual,baseline);
 }
 for(const marker of ['', '   ']){
  const page=structuredClone(projection);page.timelinePage.historySnapshot=marker;
  const actual=value(adapter.resolve({source,events,timeline:page}));
  assert.equal(actual.coverage.source.status,'unknown');assert.deepEqual(actual.text,[]);assert.ok(actual.coverage.source.reasons.includes('projection-does-not-cover-terminal'));
 }
 const stale=structuredClone(projection);stale.maxSeq=8;stale.timelinePage.historySnapshot='x'.repeat(320);
 assert.ok(value(adapter.resolve({source,events,timeline:stale})).coverage.source.reasons.includes('projection-does-not-cover-terminal'));
 const oversized=structuredClone(projection);oversized.timelinePage.historySnapshot='x'.repeat(NATIVE_SOURCE_LIMITS.bytes+1);
 assert.equal(adapter.resolve({source,events,timeline:oversized}).ok,false);
});

defineNativeSourceConformance({ test, resolve: adapter.resolve, cases: [
  { name: 'author editor mentions separate; all groups retained; machine is not a person', snapshot: { source: { kind: 'request-group', threadId: 'thread', eventId: 'event-1', requestId: 'creq_one', groupIndex: 1 }, events }, verify(result) {
    const e = value(result); assert.deepEqual(e.author, machine); assert.deepEqual(e.latestEditor, editor); assert.deepEqual(e.mentionedTargets, [mention]); assert.equal(e.origin, 'user'); assert.equal(e.text[0].text, 'question B'); assert.equal(e.inputs[0].groupCount, 2); assert.equal(e.initiatingPerson.status, 'unknown'); assert.equal(e.carriedPerson.status, 'unknown'); assert.equal(e.agentId, null); assert.equal('reference' in e, false); assert.deepEqual(e.history, []);
  } },
  ...['completed', 'failed', 'interrupted'].map(status => ({ name: `${status} terminal retains commentary and unfinished delta projection`, snapshot: { source, events: [...events.slice(0, -1), terminal(9, status)], timeline: projection }, verify(result) {
    const e = value(result); assert.equal(e.origin, 'assistant'); assert.equal(e.author, null); assert.equal(e.latestEditor, null); assert.deepEqual(e.mentionedTargets, []); assert.equal(e.terminal.status, status); assert.deepEqual(e.text.map(t => t.text), ['Commentary.', 'Retained partial.']); assert.deepEqual(e.text.map(t => t.itemId), ['comment', 'final']); assert.deepEqual(e.text[1].eventIds, ['event-6', 'event-7']); assert.equal(e.text[0].phase, 'commentary'); assert.equal(e.text[1].phase, null); assert.deepEqual(e.inputs.map(i => [i.requestId, i.turnId, i.groupCount]), [['creq_one', 'turn', 2], ['creq_two', 'turn', 1]]); assert.equal(e.coverage.source.status, 'known'); assert.equal(e.coverage.execution.status, 'partial'); assert.equal(e.coverage.personalLineage.status, 'unknown'); assert.equal(e.initiatingPerson.status, 'unknown'); assert.equal('attemptId' in e.source, false);
  } })),
  { name: 'final answer is retained with exact phase and scoped item selection', snapshot: { source: { ...source, kind: 'assistant-item', itemId: 'answer' }, events: [completed(8, 'answer', 'Final answer.', 'final_answer'), terminal()], timeline: timeline([assistantRow('answer-row', 8, 8, 'Final answer.')]) }, verify(result) { const e = value(result); assert.equal(e.text[0].phase, 'final_answer'); assert.equal(e.text[0].itemId, 'answer'); assert.equal(e.inputs.length, 0); } },
  { name: 'missing projection never substitutes completed output', snapshot: { source, events }, verify(result) { const e = value(result); assert.deepEqual(e.text, []); assert.ok(e.coverage.source.reasons.includes('public-timeline-required')); } },
  { name: 'mixed source ranges never invent item joins', snapshot: { source, events, timeline: timeline([assistantRow('mixed', 5, 7, 'unproven')]) }, verify(result) { const e = value(result); assert.equal(e.text.length, 0); assert.ok(e.coverage.source.reasons.includes('projection-source-join-unresolved')); } },
  { name: 'cross-terminal and other-turn text cannot enter frozen source', snapshot: { source, events: [...events, delta(10, 'later', 'later')], timeline: timeline([assistantRow('cross', 6, 10, 'future'), assistantRow('other', 5, 5, 'wrong turn', 'other')], 10) }, verify(result) { const e = value(result); assert.equal(e.text.length, 0); assert.ok(e.coverage.source.reasons.includes('projection-row-crosses-terminal')); } },
  { name: 'agent dispatch does not manufacture personal delegation or agent id', snapshot: { source: { kind: 'event', threadId: 'thread', eventId: 'event-1' }, events: [request(1, 'creq_agent', [[text('agent input')]], [machine], 'agent')] }, verify(result) { const e = value(result); assert.equal(e.origin, 'agent'); assert.deepEqual(e.author, machine); assert.equal(e.delegation.status, 'unknown'); assert.equal(e.agentId, null); } },
  { name: 'incomplete page and missing authors disclose independent coverage', snapshot: { source, events, timeline: { ...projection, timelinePage: { ...projection.timelinePage, olderCursor: { anchorId: 'older', anchorSeq: 1 } } } }, verify(result) { const e = value(result); assert.equal(e.text.length, 2); assert.equal(e.coverage.source.status, 'partial'); assert.equal(e.coverage.attribution.status, 'unknown'); } },
  { name: 'terminal must match exact public scope turn', snapshot: { source: { ...source, scope: { turnId: 'different' } }, events, timeline: projection }, verify(result) { assert.equal(result.ok, false); assert.equal(result.error.code, 'invalid-input'); } },
  { name: 'group lookup cannot borrow missing parallel attribution', snapshot: { source: { kind: 'request-group', threadId: 'thread', eventId: 'event-1', requestId: 'creq_one', groupIndex: 1 }, events: [{ ...r1, data: { ...r1.data, p6rAuthors: [author] } }] }, verify(result) { const e = value(result); assert.equal(e.author, null); assert.equal(e.coverage.attribution.status, 'unknown'); } },
] });

test('snapshot bounds, duplicates, invalid identifiers and malformed actors fail explicitly', () => {
  for (const input of [
    { source: { ...source, terminalEventId: '' }, events },
    { source: { ...source, attemptId: 'invented' }, events },
    { source, events: [...events, events[0]] },
    { source, events: [{ ...events[0], threadId: 'other' }] },
    { source, events: Array.from({ length: NATIVE_SOURCE_LIMITS.events + 1 }, () => terminal()) },
    { source, events, timeline: timeline([assistantRow('huge', 5, 5, 'x'.repeat(NATIVE_SOURCE_LIMITS.bytes))]) },
    { source: { kind: 'event', threadId: 'thread', eventId: 'event-1' }, events: [{ ...r1, data: { ...r1.data, p6rAuthors: [{ identity: {} }, null] } }] },
  ]) assert.equal(adapter.resolve(input).ok, false);
});
test('no text inferred from tool-only/empty/transient output or missing terminal', () => {
  const transient = row(5, 'item/started', { item: { type: 'agentMessage', id: 'transient', text: '' } }, 'turn');
  for (const [subset, rows] of [[events.slice(0, -1), projection.rows], [[transient, terminal()], []], [[completed(5, 'empty', '', 'final_answer'), terminal()], [assistantRow('empty-row', 5, 5, '')]]]) {
    const e = value(adapter.resolve({ source, events: subset, timeline: timeline(rows) }));
    assert.deepEqual(e.text, []); assert.notEqual(e.coverage.source.status, 'known');
  }
});
test('missing/multiple request joins, accepted later input, and multi-group event are explicit', () => {
  const e = value(adapter.resolve({ source, events: [...events, request(10, 'creq_later', [[text('later')]]), accept(11, 'creq_later')], timeline: projection }));
  assert.equal(e.inputs.length, 2);
  const missing = value(adapter.resolve({ source, events: events.filter(e => e.type !== 'client/turn/requested'), timeline: projection }));
  assert.equal(missing.inputs.length, 0); assert.ok(missing.coverage.execution.reasons.includes('unresolved-accepted-request'));
  const multi = value(adapter.resolve({ source: { kind: 'event', threadId: 'thread', eventId: 'event-1' }, events }));
  assert.equal(multi.text.length, 0); assert.ok(multi.coverage.source.reasons.includes('request-group-required'));
});
test('result snapshots do not retain mutable source object aliases', () => {
  const input = structuredClone({ source: { kind: 'request-group', threadId: 'thread', eventId: 'event-1', requestId: 'creq_one', groupIndex: 0 }, events });
  const e = value(adapter.resolve(input)); input.events[0].data.p6rAuthors[0].presentation.displayName = 'changed';
  assert.equal(e.author.presentation.displayName, 'author');
});
test('optional enrichment retains actual unsupported, pending, partial and failed read outcomes', async () => {
  for (const result of [{ ok: true, value: { status: 'unavailable', reason: 'unsupported' } }, { ok: true, value: { status: 'pending' } }, { ok: true, value: { status: 'partial', items: [], missing: ['missing'], nextCursor: null, traversal: 'complete' } }, { ok: false, error: { code: 'unavailable', message: 'outage', retry: 'after-reconnect' } }]) {
    const calls = []; const reader = createNativeSourceAdapter({ history: { async contributions(q) { calls.push(q); return result; }, async attempts() { throw new Error('no genuine contribution'); } } });
    const initial = value(reader.resolve({ source, events, timeline: projection }));
    const e = value(await reader.enrich(initial));
    assert.equal(e.history.length, 2); assert.deepEqual(e.history.map(r => r.result), [result, result]); assert.deepEqual(e.coverage, initial.coverage); assert.equal(e.author, null); assert.deepEqual(calls.map(c => c.eventId), ['event-1', 'event-3']);
  }
});
test('genuine contribution attempts remain separate from assistant authorship; reads bounded', async () => {
  const reference = { threadId: 'thread', contributionId: 'contribution-genuine' };
  const contribution = { reference, author: { kind: 'agent', agentId: 'genuine-agent' }, latestEditor: null, acceptedAt: '2026-10-26T00:00:00Z', mentionedPeople: [] };
  const provenance = { status: 'partial', correlation: { threadId: 'thread', turnId: 'turn', attemptId: 'genuine-attempt', toolCallId: null }, inputGroups: [{ sources: [{ kind: 'contribution', reference }] }], contributions: [contribution], missing: [], reason: 'generated-input-missing' };
  const calls = []; const reader = createNativeSourceAdapter({ history: { async contributions(q) { calls.push(q); return { ok: true, value: { status: 'known', items: Array.from({ length: 50 }, (_, i) => ({ ...contribution, reference: { ...reference, contributionId: `genuine-${i}` } })), nextCursor: 'continued', traversal: 'continued', missing: [] } }; }, async attempts(q) { calls.push(q); return { ok: true, value: { status: 'partial', items: [provenance], nextCursor: null, traversal: 'complete', missing: ['generated'] } }; } } });
  const e = value(await reader.enrich(value(reader.resolve({ source, events, timeline: projection }))));
  assert.equal(calls.length, NATIVE_SOURCE_LIMITS.historyReads); assert.equal(e.history[1].result.value.items[0].correlation.attemptId, 'genuine-attempt'); assert.equal(e.author, null); assert.equal(e.agentId, null); assert.equal(e.carriedPerson.status, 'unknown'); assert.equal('attemptId' in e.source, false);
});
test('conformance kit refuses empty case lists', () => {
  assert.throws(() => defineNativeSourceConformance({ test, resolve: adapter.resolve, cases: [] }), /requires explicit semantic cases/);
});

test('enrichment cancellation stops subsequent reads and absent history stays absent', async () => {
  const base = value(adapter.resolve({ source, events, timeline: projection }));
  assert.equal((await adapter.enrich(base)).value, base);
  const controller = new AbortController();
  let calls = 0;
  const reader = createNativeSourceAdapter({ history: { async contributions() { calls++; controller.abort(); return { ok: true, value: { status: 'known', items: [{ reference: { threadId: 'thread', contributionId: 'genuine' } }], missing: [], nextCursor: null, traversal: 'complete' } }; }, async attempts() { throw new Error('must not run after cancellation'); } } });
  const result = await reader.enrich(base, { signal: controller.signal });
  assert.equal(result.ok, false); assert.equal(result.error.code, 'cancelled'); assert.equal(calls, 1);
});

test('native causal links and source event IDs retain order with descending event pages', () => {
  const e = value(adapter.resolve({ source, events: [...events].reverse(), timeline: projection }));
  assert.deepEqual(e.inputs.map(i => i.requestId), ['creq_one', 'creq_two']);
  assert.deepEqual(e.text[1].eventIds, ['event-6', 'event-7']);
});
test('empty/deferred rows and projection delta/update omissions stay partial beside admitted text', () => {
  const empty = completed(8, 'maybe-deferred', '', 'final_answer');
  const snap = { source, events: [...events.slice(0, -1), empty, terminal()], timeline: timeline([...projection.rows, assistantRow('deferred', 8, 8, '')]) };
  const e = value(adapter.resolve(snap));
  assert.equal(e.text.length, 2); assert.equal(e.coverage.source.status, 'partial'); assert.ok(e.coverage.source.reasons.includes('projection-source-join-unresolved')); // Empty completed payload cannot prove a text-bearing endpoint.
  const partial = value(adapter.resolve({ source, events, timeline: { ...projection, delta: { upsertRows: [] }, timelinePage: { ...projection.timelinePage, olderRowUpdates: [projection.rows[0]] } } }));
  assert.ok(partial.coverage.source.reasons.includes('projection-delta-requires-materialized-rows')); assert.ok(partial.coverage.source.reasons.includes('projection-row-updates-unapplied'));
});

test('missing/unsupported source events never borrow unrelated request links or claim known attribution', () => {
  for (const candidate of [{ kind: 'event', threadId: 'thread', eventId: 'missing' }, { kind: 'event', threadId: 'thread', eventId: 'event-5' }, { ...source, terminalEventId: 'missing' }]) {
    const e = value(adapter.resolve({ source: candidate, events, timeline: projection }));
    assert.deepEqual(e.inputs, []); assert.deepEqual(e.text, []); assert.equal(e.origin, 'unknown'); assert.equal(e.coverage.attribution.status, 'unknown'); assert.equal(e.coverage.execution.status, 'unknown');
  }
});

// Recorded assertions are validated by the public shared model, not branded here.
const assertedPerson = name => value(externalPersonSnapshotCodec.decode({ ...actor(name), evidence: 'integration-asserted' }));
const assertedAuthor = assertedPerson('asserted-author'), assertedEditor = assertedPerson('asserted-editor');
const groupSource = groupIndex => ({ kind: 'request-group', threadId: 'thread', eventId: 'event-1', requestId: 'creq_asserted', groupIndex });
const assertedRequest = (authors, editors, groups = [[text('first')]]) => ({ ...request(1, 'creq_asserted', groups, authors), data: { ...request(1, 'creq_asserted', groups, authors).data, p6rAuthors: authors, p6rEditors: editors } });
const assertUnknownLineage = e => {
  assert.equal(e.initiatingPerson.status, 'unknown'); assert.equal(e.carriedPerson.status, 'unknown');
  assert.equal(e.delegation.status, 'unknown'); assert.equal(e.agentId, null); assert.equal(e.coverage.personalLineage.status, 'unknown');
};
test('recorded asserted author and editor independently retain exact model evidence and identity', () => {
  for (const [authors, editors, expectedAuthor, expectedEditor] of [
    [[assertedAuthor], undefined, assertedAuthor, null],
    [undefined, [assertedEditor], null, assertedEditor],
    [[assertedAuthor], [assertedEditor], assertedAuthor, assertedEditor],
  ]) {
    const e = value(adapter.resolve({ source: groupSource(0), events: [assertedRequest(authors, editors)] }));
    assert.deepEqual(e.author, expectedAuthor); assert.deepEqual(e.latestEditor, expectedEditor);
    if (e.author) assert.equal(e.author.evidence, 'integration-asserted');
    if (e.latestEditor) assert.equal(e.latestEditor.evidence, 'integration-asserted');
    assert.equal(e.origin, 'user'); assert.deepEqual(e.history, []); assertUnknownLineage(e);
  }
});
test('different indexed recorded people never leak between author/editor groups or missing arrays', () => {
  const otherAuthor = assertedPerson('second-author'), otherEditor = assertedPerson('second-editor');
  const groups = [[text('one')], [text('two')]];
  const r = assertedRequest([assertedAuthor, otherAuthor], [assertedEditor, otherEditor], groups);
  for (const [index, a, ed] of [[0, assertedAuthor, assertedEditor], [1, otherAuthor, otherEditor]]) {
    const e = value(adapter.resolve({ source: groupSource(index), events: [r] }));
    assert.deepEqual(e.author, a); assert.deepEqual(e.latestEditor, ed); assert.equal(e.text[0].text, groups[index][0].text);
  }
  for (const [authors, editors] of [[undefined, undefined], [[assertedAuthor], [assertedEditor]], [[null, assertedAuthor], [assertedEditor, null]]]) {
    const e = value(adapter.resolve({ source: groupSource(0), events: [assertedRequest(authors, editors, groups)] }));
    assert.equal(e.author, null);
    if (editors?.length === 2) assert.deepEqual(e.latestEditor, assertedEditor); else assert.equal(e.latestEditor, null);
    assertUnknownLineage(e);
  }
});
test('malformed assertions cannot become recorded people or masquerade as machine/default-user identities', () => {
  const malformed = [
    { ...assertedAuthor, identity: { ...assertedAuthor.identity, key: '' } },
    { ...assertedAuthor, identity: { ...assertedAuthor.identity, issuer: '' } },
    { ...assertedAuthor, identity: { ...assertedAuthor.identity, subject: '' } },
    { ...assertedAuthor, identity: { kind: 'default-user', key: 'default-user:fixture', instanceId: 'instance' } },
    { ...machine, evidence: 'integration-asserted' },
    { ...assertedAuthor, identity: { ...assertedAuthor.identity, kind: 'machine' } },
    { ...assertedAuthor, presentation: { displayName: 'label only' } },
    { ...assertedAuthor, extra: 'not part of shared external person' },
    { ...assertedAuthor, evidence: 'asserted' },
  ];
  for (const actor of malformed) {
    assert.equal(externalPersonSnapshotCodec.decode(actor).ok, false);
    for (const [authors, editors] of [[[actor], [assertedEditor]], [[assertedAuthor], [actor]]]) {
      const r = adapter.resolve({ source: groupSource(0), events: [assertedRequest(authors, editors)] });
      assert.equal(r.ok, false); assert.equal(r.error.code, 'invalid-input');
    }
  }
});
test('assistant cause links to asserted input never become output people or personal lineage', async () => {
  const r = assertedRequest([assertedAuthor], [assertedEditor]);
  const snap = { source, events: [r, accept(2, 'creq_asserted'), delta(6, 'answer', 'Retained answer'), terminal()], timeline: timeline([assistantRow('answer-row', 6, 6, 'Retained answer')]) };
  const e = value(adapter.resolve(snap));
  assert.equal(e.origin, 'assistant'); assert.equal(e.author, null); assert.equal(e.latestEditor, null); assert.deepEqual(e.mentionedTargets, []);
  assert.equal(e.inputs[0].requestEventId, 'event-1'); assert.equal(e.text[0].text, 'Retained answer'); assertUnknownLineage(e);
  const actual = { ok: true, value: { status: 'pending' } };
  const reader = createNativeSourceAdapter({ history: { async contributions() { return actual; }, async attempts() { throw new Error('no genuine contribution'); } } });
  const enriched = value(await reader.enrich(e));
  assert.deepEqual(enriched.history[0].result, actual); assert.equal(enriched.author, null); assert.equal(enriched.latestEditor, null); assertUnknownLineage(enriched);
});
