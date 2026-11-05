import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseAnchor } from '../probe/anchor.ts';
import type { ProbeRow } from '../probe/anchor.ts';
const row = (id: string, start: number, end: number, extra: Partial<ProbeRow> = {}): ProbeRow => ({
  id, threadId: 'thread', turnId: 'turn', sourceSeqStart: start, sourceSeqEnd: end, kind: 'turn', status: 'completed', ...extra,
});
test('one anchor after final response across multiple summaries, independent of ID syntax', () => {
  const rows = [row('summary.A', 10, 15), row('summary.B', 16, 20),
    row('opaque final id', 21, 21, { kind: 'conversation', role: 'assistant' }), row('next', 22, 22, { turnId: 'next' })];
  assert.equal(chooseAnchor(rows, 'thread', 'turn', 14, 'snapshot').rowId, 'opaque final id');
});
test('no final response uses exact last public completed turn row', () => {
  assert.equal(chooseAnchor([row('a', 10, 15), row('b', 16, 20)], 'thread', 'turn', 14, 's').rowId, 'b');
});
test('foreign thread, duplicate IDs and interleaved turn are rejected', () => {
  for (const rows of [[row('a', 10, 15, { threadId: 'other' })], [row('a', 10, 15), row('a', 16, 20)],
    [row('a', 10, 15), row('other', 16, 17, { turnId: 'other' }), row('b', 18, 20)]]) {
    assert.throws(() => chooseAnchor(rows, 'thread', 'turn', 14, 's'));
  }
});
test('view-transformed work IDs, missing event range, user anchor and malformed bounds are rejected', () => {
  for (const rows of [[row('work', 10, 15, { kind: 'work' })], [row('a', 15, 20)],
    [row('a', 10, 20, { kind: 'conversation', role: 'user' })], [row('a', 20, 10)]]) {
    assert.throws(() => chooseAnchor(rows, 'thread', 'turn', 14, 's'));
  }
});
