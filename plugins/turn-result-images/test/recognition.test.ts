import assert from 'node:assert/strict';
import { test } from 'node:test';
import { correlateRecognizeOutput, decodeRecognitionCursor, encodeRecognitionCursor, recognitionWindowDigest } from '@phosphorco/bb-turn-results';
import type { RecognizeInput } from '@phosphorco/bb-turn-results';
import { adaptCompletedEvent } from '@phosphorco/bb-turn-results/events';
import { recognizeImages, IMAGE_KIND_DESCRIPTOR, IMAGE_REVISION, IMAGE_KIND } from '../recognition.ts';

async function input(count = 3, limit = 2): Promise<RecognizeInput> {
  const events = [];
  for (let index = 1; index <= count; index++) {
    const adapted = await adaptCompletedEvent({ id: `evt_${index}`, seq: index, threadId: 'thr_images',
      scope: { kind: 'turn', turnId: `turn_${index}` }, type: 'item/completed', createdAt: 100 + index,
      data: { item: { type: 'imageGeneration', id: `item_${index}`, status: 'completed', path: `/images/${index}.png`, error: null, transparentBackground: false } } });
    assert.equal(adapted.state, 'admitted'); if (adapted.state === 'admitted') events.push(adapted.event);
  }
  return { version: 1, context: { consumer: { pluginId: 'independent-gallery', surface: 'turn' },
    threadId: 'thr_images', range: { fromSeq: 1, throughSeq: count } }, events, page: { limit, cursor: null } };
}

test('varied independent events produce source-owned native-image identities and new kind', async () => {
  const request = await input(); const result = await recognizeImages(request);
  assert.equal(IMAGE_KIND, 'bb-native-images/image-generated');
  assert.equal(IMAGE_KIND_DESCRIPTOR.namespace, 'bb-native-images');
  assert.deepEqual(IMAGE_KIND_DESCRIPTOR.equivalenceNamespaces, ['bb-native-images.operation']);
  assert.deepEqual(result.candidates.map(candidate => candidate.identity.ref.source.eventId), ['evt_1', 'evt_2']);
  for (const [index, candidate] of result.candidates.entries()) {
    const identity = candidate.identity, event = request.events[index]!;
    assert.deepEqual(identity.ref.source, event.source);
    assert.equal(identity.ref.member, 'image:0');
    assert.deepEqual(identity.artifact, { provider: 'bb-native-images', id: event.source.eventId, kind: 'image' });
    assert.equal(identity.lookup, null); assert.equal(identity.evidence.basis, 'native-completion');
    assert.deepEqual(identity.evidence.sites, [{ eventId: event.source.eventId, field: 'image.path', start: 0, end: event.item.type === 'imageGeneration' ? event.item.path!.length : 0 }]);
    assert.deepEqual(identity.evidence.targetUrls, []);
    assert.equal(identity.evidence.selectedDigest, event.selectedDigest);
    assert.deepEqual(identity.equivalence, { namespace: 'bb-native-images.operation', operationId: event.source.eventId, member: 'image' });
  }
  await correlateRecognizeOutput(request, result, [IMAGE_KIND_DESCRIPTOR]);
});

test('finite pages bind full selected window/revision and preserve original occurrence order', async () => {
  const request = await input(5, 1); const ids: string[] = []; const cursors = new Set<string>();
  for (let page = 0; page < 5; page++) {
    const output = await recognizeImages(request);
    assert.equal(output.candidates.length, 1); ids.push(output.candidates[0]!.identity.artifact.id);
    if (page < 4) {
      assert.equal(output.page.state, 'continued'); assert.ok(output.page.nextCursor);
      assert.equal(cursors.has(output.page.nextCursor), false); cursors.add(output.page.nextCursor);
      const decoded = decodeRecognitionCursor(output.page.nextCursor, { revision: IMAGE_REVISION, inputDigest: await recognitionWindowDigest(request) });
      assert.equal(decoded.afterOrdinal, page + 1); request.page.cursor = output.page.nextCursor;
    } else { assert.equal(output.page.state, 'complete'); assert.equal(output.page.nextCursor, null); }
  }
  assert.deepEqual(ids, ['evt_1', 'evt_2', 'evt_3', 'evt_4', 'evt_5']);
});

test('changed window/revision and impossible ordinal cannot reuse a cursor', async () => {
  const request = await input(); const first = await recognizeImages(request);
  const changed = structuredClone(request); changed.page.cursor = first.page.nextCursor;
  changed.context.consumer.surface = 'different'; await assert.rejects(recognizeImages(changed));
  const digest = await recognitionWindowDigest(request);
  request.page.cursor = encodeRecognitionCursor({ version: 1, revision: 'other', inputDigest: digest, afterOrdinal: 1 });
  await assert.rejects(recognizeImages(request));
  request.page.cursor = encodeRecognitionCursor({ version: 1, revision: IMAGE_REVISION, inputDigest: digest, afterOrdinal: 4 });
  await assert.rejects(recognizeImages(request));
});

test('pending/failed/error/missing-path native items and commands cannot become generated-image success', async () => {
  const events = [];
  for (const [index, item] of [
    { type: 'imageGeneration', status: 'pending', error: null, path: '/tmp/pending.png', transparentBackground: false },
    { type: 'imageGeneration', status: 'failed', error: 'failed', path: '/tmp/failed.png', transparentBackground: false },
    { type: 'imageGeneration', status: 'completed', error: 'still failed', path: '/tmp/error.png', transparentBackground: false },
    { type: 'imageGeneration', status: 'completed', error: null, path: null, transparentBackground: false },
    { type: 'commandExecution', status: 'completed', command: 'generate', cwd: '/repo', aggregatedOutput: '/tmp/not-native.png', exitCode: 0 },
  ].entries()) {
    const adapted = await adaptCompletedEvent({ id: `evt_${index + 1}`, seq: index + 1, threadId: 'thr_images',
      scope: { kind: 'turn', turnId: `turn_${index}` }, type: 'item/completed', createdAt: 100,
      data: { item: { ...item, id: `item_${index}` } } });
    assert.equal(adapted.state, 'admitted'); if (adapted.state === 'admitted') events.push(adapted.event);
  }
  const request = await input(5); request.events = events;
  assert.deepEqual(await recognizeImages(request), { candidates: [], page: { state: 'complete', nextCursor: null } });
});

test('original seq433 retains exact source/path metadata without image payload or hard-coded production oracle', async () => {
  const request = await input(1);
  const path = '/home/ubuntu/.codex-subscription-router/accounts/20260918-d77317/codex-home/generated_images/01a188c6-2eeb-7ad0-9097-92045e025287/exec-f0d62fd4-4f3d-4d9f-a921-1c37ec8a75c7.png';
  const adapted = await adaptCompletedEvent({ id: 'evt_iqzg5z3d27', seq: 433, threadId: 'thr_im2hj668sh',
    scope: { kind: 'turn', turnId: 'daa509e06e-t247' }, type: 'item/completed', createdAt: 1793297408982,
    data: { item: { id: 'daa509e06e-i5025', type: 'imageGeneration', status: 'completed', path, error: null, transparentBackground: false } } });
  assert.equal(adapted.state, 'admitted'); if (adapted.state !== 'admitted') return;
  request.events = [adapted.event]; request.context.threadId = 'thr_im2hj668sh'; request.context.range = { fromSeq: 433, throughSeq: 433 };
  const candidate = (await recognizeImages(request)).candidates[0]!;
  assert.equal(candidate.identity.artifact.id, 'evt_iqzg5z3d27');
  assert.equal(candidate.identity.evidence.sites[0]!.end, path.length);
  assert.equal(candidate.identity.ref.source.turnId, 'daa509e06e-t247');
});

test('no clock/random/fetch work; caller input/digest remains validated', async () => {
  const request = await input(1); const clock = Date.now, random = Math.random, fetch = globalThis.fetch;
  try {
    Date.now = Math.random = () => { throw new Error('not pure'); };
    globalThis.fetch = new Proxy(fetch, { apply() { throw new Error('unexpected I/O'); } });
    assert.equal((await recognizeImages(request)).candidates.length, 1);
  } finally { Date.now = clock; Math.random = random; globalThis.fetch = fetch; }
  request.events[0]!.selectedDigest = '0'.repeat(64);
  await assert.rejects(recognizeImages(request));
});

test('response-byte pagination preserves debt for large independent identifiers', async () => {
  const events = [];
  const threadId = 't'.repeat(256);
  for (let seq = 1; seq <= 32; seq++) {
    const adapted = await adaptCompletedEvent({ id: `${String(seq).padStart(2, '0')}${'e'.repeat(254)}`, seq, threadId,
      scope: { kind: 'turn', turnId: 'u'.repeat(256) }, createdAt: 100, type: 'item/completed',
      data: { item: { id: 'i'.repeat(256), type: 'imageGeneration', status: 'completed', path: '/saved/image.png', error: null, transparentBackground: false } } });
    assert.equal(adapted.state, 'admitted'); if (adapted.state === 'admitted') events.push(adapted.event);
  }
  const request: RecognizeInput = { version: 1, context: { consumer: { pluginId: 'gallery', surface: 'turn' }, threadId,
    range: { fromSeq: 1, throughSeq: 32 } }, events, page: { limit: 64, cursor: null } };
  const first = await recognizeImages(request);
  assert.equal(first.page.state, 'continued'); assert.ok(first.candidates.length > 0 && first.candidates.length < 32);
  request.page.cursor = first.page.nextCursor;
  const second = await recognizeImages(request);
  assert.equal(second.page.state, 'complete');
  const ids = [...first.candidates, ...second.candidates].map(value => value.identity.artifact.id);
  assert.equal(ids.length, 32); assert.equal(new Set(ids).size, 32);
});
