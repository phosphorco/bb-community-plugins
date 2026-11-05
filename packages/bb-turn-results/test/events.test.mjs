import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  adaptCompletedEvent, buildEventWindow, EventEnvelopeSchema, selectedEvidence,
  selectedEvidenceDigest, EVENT_TEXT_BYTES, EVENT_BYTES, EVENT_WINDOW_BYTES,
} from '../src/events.js';
import { canonicalJson, canonicalByteLength } from '../src/bounds.js';

// Sanitized stored-row fixtures follow public ThreadEventRow + normalized item
// schemas. Identity fields are fixture values except the retained seq433 oracle.
const row = (item, seq = 1, extra = {}) => ({
  id: `evt_${seq}`, threadId: 'thr_fixture', seq, createdAt: 1793297408982,
  scope: { kind: 'turn', turnId: 'turn_fixture' }, type: 'item/completed',
  data: { providerThreadId: 'provider_fixture', item: { id: `item_${seq}`, status: 'completed', ...item } }, ...extra,
});
const image = () => ({ type: 'imageGeneration', path: '/tmp/generated.png',
  error: null, transparentBackground: false });
const command = output => ({ type: 'commandExecution', status: 'completed', command: 'npm test', cwd: '/repo',
  aggregatedOutput: output, exitCode: 0, approvalStatus: null });
const tool = result => ({ type: 'toolCall', server: 'bb', tool: 'AskUserQuestion', result });
const windowOptions = { threadId: 'thr_fixture', afterSeq: 0 };
async function admitted(input, options) {
  const result = await adaptCompletedEvent(input, options);
  assert.equal(result.state, 'admitted', JSON.stringify(result));
  return result;
}

test('canonical native command completed keeps its selected digest; unknown statuses remain unsupported', async () => {
  const selected = await admitted(row(command('tests pass')));
  assert.equal(selected.event.item.status, 'completed');
  assert.equal(selected.event.selectedDigest, await selectedEvidenceDigest(selected.event));
  assert.equal((await adaptCompletedEvent(row({ ...command('ok'), status: 'succeeded' }))).state, 'unsupported');
  assert.equal((await adaptCompletedEvent(row({ ...image(), status: 'succeeded' }))).state, 'unsupported');
  assert.equal((await adaptCompletedEvent(row({ ...tool('ok'), status: 'succeeded' }))).state, 'unsupported');
});

test('original seq433: never touches image result, prompt, base64 or extra getters', async () => {
  const item = { ...image(), id: 'daa509e06e-i5025', status: 'completed',
    path: '/home/ubuntu/.codex-subscription-router/accounts/20260918-d77317/codex-home/generated_images/01a188c6-2eeb-7ad0-9097-92045e025287/exec-f0d62fd4-4f3d-4d9f-a921-1c37ec8a75c7.png',
    parentToolCallId: 'native_parent', hostId: 'unreviewed-host-extension',
    truncation: { result: { originalLength: 2140312, retainedHeadLength: 2048, retainedTailLength: 2048, truncatedAt: 1793297409000 } },
  };
  for (const name of ['result', 'prompt', 'base64', 'arguments', 'presentation']) {
    Object.defineProperty(item, name, { enumerable: true, get() { throw new Error(`Must never read ${name}`); } });
  }
  const raw = row({}, 433, { id: 'evt_iqzg5z3d27', threadId: 'thr_im2hj668sh',
    scope: { kind: 'turn', turnId: 'daa509e06e-t247' }, data: { item } });
  const { event, bytes } = await admitted(raw);
  assert.deepEqual(event.source, { threadId: 'thr_im2hj668sh', turnId: 'daa509e06e-t247',
    eventId: 'evt_iqzg5z3d27', seq: 433, itemId: 'daa509e06e-i5025', eventType: 'item/completed' });
  assert.equal(event.item.path, item.path);
  assert.equal(event.context.parentToolCallId, 'native_parent');
  assert.equal(event.context.hostId, null);
  assert.deepEqual(event.omitted, ['result', 'prompt']);
  assert.equal(event.text.result.nativeTruncation.originalLength, 2140312);
  assert.equal(event.text.result.originalBytes, null);
  assert.ok(bytes < 2000);
});

test('2MB image result has no effect on selected bytes or digest', async () => {
  const small = await admitted(row({ ...image(), result: 'short', prompt: 'unused' }));
  const big = await admitted(row({ ...image(), result: 'A'.repeat(2140312), prompt: 'secret prompt' }));
  assert.deepEqual(big, small);
  assert.equal('result' in big.event.item, false);
  assert.equal('prompt' in big.event.item, false);
});

test('digest is SHA256 over the full canonical selected evidence, excluding only digest', async () => {
  const { event } = await admitted(row(command('tests pass')));
  const bytes = new TextEncoder().encode(canonicalJson(selectedEvidence(event)));
  const expected = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), n => n.toString(16).padStart(2, '0')).join('');
  assert.equal(event.selectedDigest, expected);
  assert.equal(await selectedEvidenceDigest(event), expected);
  const changed = structuredClone(event);
  changed.source.eventId = 'evt_other';
  assert.notEqual(await selectedEvidenceDigest(changed), expected);
  assert.equal('selectedDigest' in selectedEvidence(event), false);
});

test('real normalized failed command keeps failure, exit code, cwd, output and nested parent', async () => {
  // Mirrors delta-assembler.test.ts paired-close and parentRef fixtures.
  const { event } = await admitted(row({ ...command('tests failed'), status: 'failed', exitCode: 1,
    parentToolCallId: 'as-test-i-parent' }));
  assert.equal(event.item.type, 'commandExecution');
  assert.equal(event.item.command, 'npm test');
  assert.equal(event.item.cwd, '/repo');
  assert.equal(event.item.status, 'failed');
  assert.equal(event.item.exitCode, 1);
  assert.equal(event.item.output, 'tests failed');
  assert.equal(event.context.parentToolCallId, 'as-test-i-parent');
});

test('named nested tool remains separate from outer exec print; arguments are never selected', async () => {
  const native = row({ ...tool('{"answers":{"Tabs or spaces?":"spaces"}}'), parentToolCallId: 'outer-exec' });
  Object.defineProperty(native.data.item, 'arguments', { enumerable: true, get() { throw new Error('arguments read'); } });
  const { event } = await admitted(native);
  assert.equal(event.item.type, 'toolCall');
  assert.equal(event.item.server, 'bb');
  assert.equal(event.item.name, 'AskUserQuestion');
  assert.equal(event.context.parentToolCallId, 'outer-exec');
  assert.equal(event.text.result.format, 'text');
  assert.deepEqual(event.omitted, ['arguments']);
  assert.equal('tool' in event.item, false);
});

test('preserves pending/interrupted/failed native outcomes without asserting success', async () => {
  for (const status of ['pending', 'interrupted', 'failed']) {
    const { event } = await admitted(row({ ...image(), status, error: 'generation failed' }));
    assert.equal(event.item.status, status);
    assert.equal(event.item.error, 'generation failed');
  }
});

test('native and adapter truncation are independently preserved; combined selected text <=16KiB', async () => {
  const native = { originalLength: 100000, retainedHeadLength: 2048, retainedTailLength: 2048, truncatedAt: 100 };
  const { event } = await admitted(row({ ...command('😀'.repeat(100000)),
    command: 'x'.repeat(10000), error: 'e'.repeat(1000), truncation: { aggregatedOutput: native } }));
  const texts = Object.entries(event.item).filter(([key, value]) =>
    !['id', 'type', 'status'].includes(key) && typeof value === 'string').map(([, value]) => value);
  const bytes = texts.reduce((sum, value) => sum + new TextEncoder().encode(value).length, 0);
  assert.ok(bytes <= EVENT_TEXT_BYTES);
  assert.equal(event.text.output.originalLength, 200000);
  assert.equal(event.text.output.originalBytes, null);
  assert.equal(event.text.output.adapterTruncated, true);
  assert.deepEqual(event.text.output.nativeTruncation, native);
  assert.ok(!/[\uD800-\uDBFF]$/u.test(event.item.output));
  assert.equal(event.text.command.adapterTruncated, false);
});

test('UTF8 text truncation and JSON escaping are measured separately', async () => {
  const { event, bytes } = await admitted(row(tool('界'.repeat(10000))));
  assert.ok(event.text.result.retainedBytes <= EVENT_TEXT_BYTES);
  assert.equal(event.text.result.originalBytes, 30000);
  assert.equal(event.text.result.originalLength, 10000);
  assert.equal(event.text.result.adapterTruncated, true);
  assert.equal(bytes, canonicalByteLength(event));
  const escaped = await adaptCompletedEvent(row(tool('\u0000'.repeat(16000))));
  assert.equal(escaped.state, 'oversized');
});

test('structured tool JSON is canonical, whole and distinguished from text', async () => {
  const { event } = await admitted(row(tool({ z: [1, true], a: 'kept' })));
  assert.equal(event.item.result, '{"a":"kept","z":[1,true]}');
  assert.equal(event.text.result.format, 'json');
  assert.equal(event.text.result.adapterTruncated, false);
  assert.deepEqual(JSON.parse(event.item.result), { a: 'kept', z: [1, true] });
});

test('oversized structured JSON is omitted whole, never a partial receipt', async () => {
  const { event } = await admitted(row(tool({ receipt: 'x'.repeat(20000) })));
  assert.equal(event.item.result, null);
  assert.equal(event.text.result.format, 'omitted');
  assert.equal(event.text.result.omissionReason, 'structured-over-budget');
  assert.equal(event.text.result.originalLength, null);
  assert.equal(event.text.result.originalBytes, null);
  assert.equal(event.text.result.adapterTruncated, false);
});

test('malformed structured result does not invoke getters/toJSON and is explicitly omitted', async () => {
  let touched = false;
  const value = { get receipt() { touched = true; throw new Error('getter'); } };
  const { event } = await admitted(row(tool(value)));
  assert.equal(touched, false);
  assert.equal(event.text.result.omissionReason, 'invalid-structured-result');
  const withToJSON = { toJSON() { touched = true; return { receipt: 'invented' }; } };
  assert.equal((await admitted(row(tool(withToJSON)))).event.text.result.omissionReason, 'invalid-structured-result');
  assert.equal(touched, false);
  const cyclic = {}; cyclic.self = cyclic;
  assert.equal((await admitted(row(tool(cyclic)))).event.text.result.omissionReason, 'invalid-structured-result');
});

test('absent, empty and JSON null tool output are distinct', async () => {
  const absent = (await admitted(row(tool(undefined)))).event;
  const empty = (await admitted(row(tool('')))).event;
  const jsonNull = (await admitted(row(tool(null)))).event;
  assert.equal(absent.item.result, null); assert.equal(absent.text.result.format, 'absent');
  assert.equal(empty.item.result, ''); assert.equal(empty.text.result.format, 'text');
  assert.equal(jsonNull.item.result, 'null'); assert.equal(jsonNull.text.result.format, 'json');
});

test('missing scope is unscoped even if raw data supplies a tempting turn hint', async () => {
  const raw = row(image(), 1, { scope: undefined });
  raw.data.turnId = 'tempting-turn';
  assert.equal((await adaptCompletedEvent(raw)).state, 'unscoped');
});

test('unknown variants/delegation/status and provider dynamicToolCall are explicit unsupported', async () => {
  for (const item of [{ type: 'delegation', childRef: 'child', background: true, label: 'task' },
    { type: 'dynamicToolCall', tool: 'AskUserQuestion' }, { type: 'futureVariant' }, { ...tool('ok'), status: 'future' }]) {
    assert.equal((await adaptCompletedEvent(row(item))).state, 'unsupported');
  }
});

test('malformed metadata yields diagnostic and exact paths are never truncated', async () => {
  for (const item of [{ ...image(), path: '/x'.repeat(3000) }, { ...command('ok'), cwd: '/x'.repeat(3000) }]) {
    assert.equal((await adaptCompletedEvent(row(item))).state, 'oversized');
  }
  assert.equal((await adaptCompletedEvent(row({ ...command('ok'), exitCode: NaN }))).state, 'unsupported');
  assert.equal((await adaptCompletedEvent(row({ ...tool('ok'), truncation: { result: { originalLength: 1 } } }))).state, 'unsupported');
  assert.equal((await adaptCompletedEvent(row({ ...image(), path: '/tmp/\nfile' }))).state, 'unsupported');
  assert.equal((await adaptCompletedEvent(row(image(), 1, { id: 'evt_\u0085' }))).state, 'unsupported');
});

test('strict recursive recognize input rejects additive fields; status/source identity are closed', async () => {
  const { event } = await admitted(row(image()));
  for (const change of [e => { e.extra = true; }, e => { e.context.extra = true; },
    e => { e.source.extra = true; }, e => { e.item.extra = true; },
    e => { e.text.path.extra = true; }, e => { e.item.status = 'future'; },
    e => { e.source.itemId = 'foreign-item'; }]) {
    const changed = structuredClone(event); change(changed);
    assert.equal(EventEnvelopeSchema.safeParse(changed).success, false);
  }
});

test('event size exact boundary includes fixed digest and all escaped fields', async () => {
  const raw = row(command('hello'));
  const { bytes } = await admitted(raw);
  await admitted(raw, { maxEventBytes: bytes });
  const rejected = await adaptCompletedEvent(raw, { maxEventBytes: bytes - 1 });
  assert.equal(rejected.state, 'oversized');
  assert.equal(rejected.seq, 1);
  assert.equal(rejected.eventId, 'evt_1');
});

test('aggregate byte overflow leaves suffix debt; continuation reconstructs all original refs', async () => {
  const inputs = [row(command('x'.repeat(1000)), 1), row(tool('y'.repeat(1000)), 2), row(image(), 3)];
  const firstOnly = await buildEventWindow(inputs, { ...windowOptions, maxEvents: 1 });
  const first = await buildEventWindow(inputs, { ...windowOptions, maxBytes: firstOnly.bytes });
  assert.equal(first.state, 'continued'); assert.equal(first.reason, 'byte-limit');
  assert.equal(first.afterSeq, 1); assert.equal(first.nextInputIndex, 1);
  assert.deepEqual(first.events.map(e => e.source.eventId), ['evt_1']);
  const second = await buildEventWindow(inputs.slice(first.nextInputIndex), { ...windowOptions, afterSeq: first.afterSeq });
  assert.deepEqual(second.events.map(e => e.source.seq), [2, 3]);
  assert.equal(second.state, 'complete'); assert.equal(second.afterSeq, 3);
});

test('single event oversized for event cap yields charged gap then advances', async () => {
  const result = await buildEventWindow([row(command('x'.repeat(3000)), 1), row(image(), 2)],
    { ...windowOptions, maxEventBytes: 2000 });
  assert.equal(result.diagnostics.length, 1); assert.equal(result.diagnostics[0].state, 'oversized');
  assert.deepEqual(result.events.map(e => e.source.seq), [2]);
  assert.equal(result.afterSeq, 2);
});

test('single event impossible for empty window becomes explicit diagnostic rather than infinite debt', async () => {
  const result = await buildEventWindow([row(command('x'.repeat(4000)))], { ...windowOptions, maxBytes: 1000 });
  assert.equal(result.state, 'complete'); assert.equal(result.afterSeq, 1);
  assert.equal(result.diagnostics[0].reason, 'selected-event-over-window-budget');
  assert.ok(result.bytes <= 1000);
});

test('unscoped, foreign, duplicate or unreliable sequence stops before consuming any suffix', async () => {
  for (const middle of [row(image(), 2, { scope: undefined }), row(image(), 2, { threadId: 'thr_other' }),
    row(image(), 1), row(image(), NaN), row(image(), 2, { id: undefined })]) {
    const result = await buildEventWindow([row(image(), 1), middle, row(image(), 3)], windowOptions);
    assert.equal(result.state, 'continued'); assert.equal(result.afterSeq, 1); assert.equal(result.nextInputIndex, 1);
    assert.deepEqual(result.events.map(e => e.source.seq), [1]);
  }
});

test('unsupported reliable native event is diagnostic gap, not successful output', async () => {
  const result = await buildEventWindow([row({ type: 'future' }, 1), row(image(), 2)], windowOptions);
  assert.equal(result.state, 'complete'); assert.equal(result.afterSeq, 2);
  assert.deepEqual(result.diagnostics.map(e => e.state), ['unsupported']);
  assert.deepEqual(result.events.map(e => e.source.seq), [2]);
});

test('count bound includes diagnostics and never reads unconsumed items', async () => {
  const suffix = { get seq() { throw new Error('unconsumed suffix read'); } };
  const result = await buildEventWindow([row({ type: 'future' }), suffix], { ...windowOptions, maxEvents: 1 });
  assert.equal(result.state, 'continued'); assert.equal(result.reason, 'event-limit');
  assert.equal(result.nextInputIndex, 1); assert.equal(result.afterSeq, 1);
});

test('window physical canonical response is below its conservative charged bound', async () => {
  const result = await buildEventWindow([row(image(), 1), row(tool('ok'), 2)], windowOptions);
  assert.ok(canonicalByteLength(result, EVENT_WINDOW_BYTES) <= result.bytes);
  assert.equal((await buildEventWindow([], windowOptions)).state, 'complete');
});

test('published maximums cannot be increased by options', async () => {
  await assert.rejects(adaptCompletedEvent(row(image()), { maxEventBytes: EVENT_BYTES + 1 }), RangeError);
  for (const override of [{ maxEvents: 33 }, { maxBytes: EVENT_WINDOW_BYTES + 1 }, { maxEventBytes: EVENT_BYTES + 1 },
    { maxEvents: 0 }, { maxBytes: 1 }, { afterSeq: -1 }, { threadId: '' }]) {
    await assert.rejects(buildEventWindow([], { ...windowOptions, ...override }), RangeError);
  }
});
