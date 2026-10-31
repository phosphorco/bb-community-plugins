import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { useSdk } from '@get-bb/plugin-sdk/app';
import { galleryAnchors, createGalleryAnchorReader } from '../gallery/anchors.ts';
import type { GalleryTimelinePage } from '../gallery/anchors.ts';

// Public timeline shape, opaque IDs unrelated to sequences. Native DOM only
// contributes these exact IDs; tests never derive a before cursor from an ID.
type Timeline = Awaited<ReturnType<ReturnType<typeof useSdk>['threads']['timeline']>>;
type PublicRow = Timeline['rows'][number];
function rows(count: number) {
  return Array.from({ length: count }, (_, i) => ({ id: `opaque-${String.fromCharCode(65 + i % 26)}-${(i * 71 + 17) % 10007}`,
    threadId: 'thread', turnId: `turn-${i}`, kind: 'conversation' as const, role: 'assistant' as const,
    sourceSeqStart: i * 4 + 1, sourceSeqEnd: i * 4 + 3,
  } satisfies Pick<PublicRow, 'id' | 'threadId' | 'turnId' | 'kind' | 'sourceSeqStart' | 'sourceSeqEnd'> & { role: string }));
}
function pages(all: GalleryTimelinePage['rows'] = rows(900)) {
  const calls: { beforeAnchorId?: string; beforeAnchorSeq?: string }[] = [];
  let display = 'compact', snapshot = 'native-snapshot', issued = 0;
  type Chain = { all: GalleryTimelinePage['rows']; display: string; snapshot: string; end: number; seq: number };
  const cursors = new Map<string, Chain>();
  const port = { async timeline(input: { beforeAnchorId?: string; beforeAnchorSeq?: string }): Promise<GalleryTimelinePage> {
    calls.push(input);
    const chain = input.beforeAnchorId ? cursors.get(input.beforeAnchorId) : {
      all: structuredClone(all), display, snapshot, end: all.length, seq: 0,
    };
    assert.ok(chain, 'only an actually issued opaque cursor can continue');
    if (input.beforeAnchorId) assert.equal(input.beforeAnchorSeq, String(chain.seq));
    const selected = chain.all.slice(Math.max(0, chain.end - 100), chain.end);
    let olderCursor = null;
    if (chain.end > 100) {
      const anchorId = `issued-opaque-${++issued}`, anchorSeq = selected[0]!.sourceSeqStart;
      cursors.set(anchorId, { ...chain, end: chain.end - 100, seq: anchorSeq });
      olderCursor = { anchorId, anchorSeq };
    }
    return { rows: structuredClone(selected), completedTurnDisplay: chain.display,
      timelinePage: { historySnapshot: chain.snapshot, olderCursor } };
  } };
  return { all, calls, port, display(value: string) { display = value; }, snapshot(value: string) { snapshot = value; },
    replace(value: GalleryTimelinePage['rows']) { all = value; } };
}
const signal = () => new AbortController().signal;
test('visible historical turn before newest64 remains eligible by public identity, not recency', async () => {
  const f = pages(rows(100));
  assert.equal(galleryAnchors(f.all, 'thread', 'native-snapshot', true).length, 100);
  const reader = createGalleryAnchorReader(f.port, 'thread');
  const result = await reader.read([f.all[5]!.id], signal());
  assert.equal(result.anchors[0]!.turnId, 'turn-5'); assert.equal(result.anchors[0]!.rowId, f.all[5]!.id);
  assert.equal(result.continued, false); assert.equal(f.calls.length, 1);
});
test('explicit four-page continuation reaches old visible turn without restarting latest or scanning idle', async () => {
  const f = pages(), reader = createGalleryAnchorReader(f.port, 'thread'), target = f.all[20]!.id;
  const first = await reader.read([target], signal()); assert.equal(first.continued, true); assert.equal(first.pages, 4); assert.equal(first.anchors.length, 0);
  const next = await reader.read([target], signal()); assert.equal(next.continued, true); assert.equal(f.calls.length, 8);
  const last = await reader.read([target], signal()); assert.equal(last.anchors[0]!.rowId, target); assert.equal(f.calls.length, 9);
  assert.equal(f.calls.filter(call => !call.beforeAnchorId).length, 1);
  const cached = await reader.read([target], signal()); assert.equal(cached.pages, 0); assert.equal(f.calls.length, 9);
});
test('partial first turn is deferred until preceding public page witnesses its start; multi-summary places once', async () => {
  const all = [
    { id: 'prior', threadId: 'thread', turnId: 'prior', kind: 'conversation', role: 'assistant', sourceSeqStart: 1, sourceSeqEnd: 3 },
    { id: 'summary-a', threadId: 'thread', turnId: 'whole', kind: 'turn', status: 'completed', sourceSeqStart: 4, sourceSeqEnd: 9 },
    { id: 'summary-b', threadId: 'thread', turnId: 'whole', kind: 'turn', status: 'completed', sourceSeqStart: 10, sourceSeqEnd: 15 },
    { id: 'exact-final', threadId: 'thread', turnId: 'whole', kind: 'conversation', role: 'assistant', sourceSeqStart: 16, sourceSeqEnd: 18 },
  ];
  let call = 0;
  const reader = createGalleryAnchorReader({ async timeline() { call++; return { rows: call === 1 ? all.slice(2) : all.slice(0, 2), timelinePage: {
    historySnapshot: 's', olderCursor: call === 1 ? { anchorId: 'summary-b', anchorSeq: 10 } : null } }; } }, 'thread');
  const result = await reader.read(['exact-final'], signal());
  assert.equal(call, 2); assert.equal(result.anchors.length, 1);
  assert.deepEqual([result.anchors[0]!.turnSeqStart, result.anchors[0]!.turnSeqEnd], [4, 18]);
});
test('issued older cursor pins snapshot/display; cross-chain response rejects and explicit invalidation acquires latest', async () => {
  for (const change of ['snapshot', 'display'] as const) {
    const f = pages(), reader = createGalleryAnchorReader(f.port, 'thread'), target = f.all[20]!.id;
    await reader.read([target], signal()); f[change]('changed');
    const older = await reader.read([target], signal());
    assert.equal(older.continued, true, 'issued old cursor stays on its original chain');
    reader.invalidate();
    const result = await reader.read([f.all[899]!.id], signal());
    assert.equal(result.anchors[0]!.rowId, f.all[899]!.id);
    assert.equal(f.calls.at(-1)!.beforeAnchorId, undefined);
    let calls = 0;
    const corrupt = createGalleryAnchorReader({ async timeline() { calls++; return {
      rows: [f.all[899]!], completedTurnDisplay: calls === 1 ? 'compact' : change === 'display' ? 'changed' : 'compact',
      timelinePage: { historySnapshot: calls === 1 || change === 'display' ? 'original' : 'wrong-chain',
        olderCursor: { anchorId: `issued-${calls}`, anchorSeq: 4000 - calls } },
    }; } }, 'thread');
    await assert.rejects(corrupt.read([target], signal()), /Timeline changed/);
  }
});
test('nonprogressing cursor, foreign/duplicate pages, canceled ignored read and target capacity fail closed', async () => {
  const f = pages(rows(200));
  const invalid = createGalleryAnchorReader({ async timeline() { return { rows: f.all.slice(100), timelinePage: { historySnapshot: 's', olderCursor: { anchorId: 'same', anchorSeq: 1 } } }; } }, 'thread');
  await assert.rejects(invalid.read([f.all[0]!.id], signal()), /cursor did not progress/);
  for (const wrong of [[{ ...f.all[0]!, threadId: 'foreign' }], [f.all[0]!, f.all[0]!]]) {
    const reader = createGalleryAnchorReader({ async timeline() { return { rows: wrong, timelinePage: { historySnapshot: 's', olderCursor: null } }; } }, 'thread');
    await assert.rejects(reader.read([f.all[0]!.id], signal()), /capacity/);
  }
  let release!: (value: GalleryTimelinePage) => void;
  const reader = createGalleryAnchorReader({ timeline: () => new Promise(resolve => { release = resolve; }) }, 'thread');
  const controller = new AbortController(), pending = reader.read([f.all[0]!.id], controller.signal); controller.abort();
  release({ rows: f.all, timelinePage: { historySnapshot: 's', olderCursor: null } }); await assert.rejects(pending);
  await assert.rejects(reader.read(Array.from({ length: 21 }, (_, i) => `opaque-${i}`), signal()), /Invalid gallery history demand/);
});

test('recorded native public image-turn IDs/ranges join directly; no ID syntax carries authority', async () => {
  // Retained public-turn-target.json, observed 2026-10-29T19:42:15Z, source
  // /api/v1/threads/thr_im2hj668sh/timeline?includeNestedRows=false&segmentLimit=100.
  const threadId = 'thr_im2hj668sh', turnId = 'daa509e06e-t247';
  const actual = [
    { id: 'thr_im2hj668sh:user-seed:408', threadId, turnId, kind: 'conversation', role: 'user', sourceSeqStart: 408, sourceSeqEnd: 408 },
    { id: 'thr_im2hj668sh:daa509e06e-t247:turn:0', threadId, turnId, kind: 'turn', status: 'completed', sourceSeqStart: 412, sourceSeqEnd: 433 },
    { id: 'thr_im2hj668sh:assistant:kind:assistant|turn:daa509e06e-t247|parent:root|item:daa509e06e-i5048', threadId, turnId, kind: 'conversation', role: 'assistant', sourceSeqStart: 438, sourceSeqEnd: 455 },
  ];
  const reader = createGalleryAnchorReader({ async timeline() { return { rows: actual,
    completedTurnDisplay: 'collapse', timelinePage: { historySnapshot: 'recorded-public-snapshot', olderCursor: null } }; } }, threadId);
  const result = await reader.read(actual.map(row => row.id), signal());
  assert.equal(result.anchors.length, 1); assert.equal(result.anchors[0]!.rowId, actual[2]!.id);
  assert.deepEqual([result.anchors[0]!.turnSeqStart, result.anchors[0]!.turnSeqEnd], [408, 455]);
  assert.deepEqual(result.unplaced, [], 'user/work rows are witnessed nonterminal rows, not missing history debt');
});

test('history-lane capacity preserves genuine cursor and all previously matched anchors for retry', async () => {
  const f = pages(rows(900)); let capacity = false;
  const reader = createGalleryAnchorReader({ async timeline(input) { return capacity ? { state: 'capacity' } : f.port.timeline(input); } }, 'thread');
  const targets = [f.all[899]!.id, f.all[20]!.id];
  const initial = await reader.read(targets, signal()); assert.equal(initial.anchors.length, 1);
  capacity = true; const paused = await reader.read(targets, signal());
  assert.equal(paused.capacity, true); assert.equal(paused.continued, true); assert.equal(paused.pages, 0);
  assert.deepEqual(paused.anchors, initial.anchors); assert.equal(f.calls.length, 4);
  capacity = false; await reader.read(targets, signal()); const complete = await reader.read(targets, signal());
  assert.equal(complete.anchors.length, 2); assert.equal(f.calls.length, 9);
  assert.equal(f.calls.filter(call => !call.beforeAnchorId).length, 1, 'capacity never acknowledges or resets public cursor');
});

test('historical negative knowledge is revoked through fresh latest plus pinned chain; over400 rows need explicit continuation', async () => {
  const all = rows(900).map((row, index) => ({ ...row, status: index === 20 ? 'pending' : 'completed' }));
  const f = pages(all), reader = createGalleryAnchorReader(f.port, 'thread'), target = all[20]!.id;
  await reader.read([target], signal()); await reader.read([target], signal()); const old = await reader.read([target], signal());
  assert.deepEqual(old.anchors, []); assert.deepEqual(old.checked, [target]); assert.equal(f.calls.length, 9);
  f.replace(all.map(row => ({ ...row, status: 'completed' }))); f.snapshot('fresh-B');
  const pinned = await f.port.timeline(f.calls.at(-1)!);
  assert.equal(pinned.timelinePage.historySnapshot, 'native-snapshot'); assert.equal(pinned.rows[20]!.status, 'pending');
  const mark = f.calls.length; reader.invalidate();
  const fresh = await reader.read([target], signal());
  assert.deepEqual(fresh.anchors, []); assert.deepEqual(fresh.checked, []); assert.equal(fresh.continued, true);
  assert.equal(fresh.pages, 4); assert.equal(f.calls.length, mark + 4); assert.equal(f.calls[mark]!.beforeAnchorId, undefined);
  assert.equal((await reader.read([target], signal())).continued, true);
  const complete = await reader.read([target], signal());
  assert.equal(complete.anchors[0]!.historySnapshot, 'fresh-B'); assert.equal(complete.anchors[0]!.rowId, target);
  assert.equal(f.calls.length, mark + 9); assert.equal(f.calls.filter(call => !call.beforeAnchorId).length, 2);
  assert.equal((await reader.read([target], signal())).pages, 0);
});
test('invalidation discards unresolved old cursor and fences ignored late prior generation', async () => {
  const f = pages(), reader = createGalleryAnchorReader(f.port, 'thread'), target = f.all[20]!.id;
  await reader.read([target], signal()); reader.invalidate(); await reader.read([target], signal());
  await reader.read([target], signal());
  const complete = await reader.read([target], signal()); assert.equal(complete.anchors[0]!.rowId, target);
  assert.equal(f.calls.length, 13); assert.equal(f.calls.filter(call => !call.beforeAnchorId).length, 2);
  let release!: (page: GalleryTimelinePage) => void, first = true;
  const row = { id: 'stable-id', threadId: 'thread', turnId: 'turn', kind: 'turn', status: 'completed', sourceSeqStart: 1, sourceSeqEnd: 15 };
  const fence = createGalleryAnchorReader({ async timeline() {
    if (first) { first = false; return new Promise(resolve => { release = resolve; }); }
    return { rows: [row], timelinePage: { historySnapshot: 'fresh', olderCursor: null } };
  } }, 'thread');
  const old = fence.read(['stable-id'], signal()); fence.invalidate();
  assert.equal((await fence.read(['stable-id'], signal())).anchors[0]!.turnSeqEnd, 15);
  release({ rows: [{ ...row, status: 'pending', sourceSeqEnd: 10 }], timelinePage: { historySnapshot: 'old', olderCursor: null } });
  await assert.rejects(old, /retired/);
  assert.equal((await fence.read(['stable-id'], signal())).anchors[0]!.turnSeqEnd, 15);
});
