import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountGalleryPane } from '../gallery/pane.ts';
import { galleryAnchors } from '../gallery/anchors.ts';
import type { GalleryAnchor as Anchor } from '../gallery/anchors.ts';
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
test('production multi-turn pane joins exact rows, updates in place and aborts before deferred disposal', async () => {
  const dom = new JSDOM('<main></main>', { pretendToBeVisual: true });
  const saved = { document: globalThis.document, Element: globalThis.Element, MutationObserver: globalThis.MutationObserver, IntersectionObserver: globalThis.IntersectionObserver };
  Object.assign(globalThis, { document: dom.window.document, Element: dom.window.Element, MutationObserver: dom.window.MutationObserver, IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} } });
  const anchor = (turnId: string): Anchor => ({ threadId: 'thread', turnId, rowId: `public:${turnId}`, sourceSeqStart: 1, sourceSeqEnd: 5, turnSeqStart: 1, turnSeqEnd: 5, historySnapshot: 'snapshot' });
  const makePane = () => {
    const pane = document.createElement('div'); pane.dataset.threadWindow = '';
    pane.innerHTML = '<div data-timeline-row-list="top-level"><div data-timeline-row-id="public:a"></div><div data-timeline-row-id="public:b"></div></div><span></span>';
    document.querySelector('main')!.append(pane); return pane;
  };
  const left = makePane(), right = makePane(), log: string[] = [], current: (() => boolean)[] = [];
  const mount = (_host: HTMLElement, a: Anchor, check: () => boolean, signal: AbortSignal) => {
    current.push(check); log.push(`mount:${a.turnId}`); signal.addEventListener('abort', () => log.push(`abort:${a.turnId}`));
    return { update(next: Anchor) { log.push(`update:${next.turnId}`); }, dispose() { log.push(`dispose:${a.turnId}`); } };
  };
  const a = mountGalleryPane(left.querySelector('span')!, 'thread', [anchor('a'), anchor('b')], mount);
  const b = mountGalleryPane(right.querySelector('span')!, 'thread', [anchor('a')], mount);
  try {
    await tick(); assert.equal(document.querySelectorAll('[data-turn-results-gallery]').length, 3);
    a.update([{ ...anchor('a'), sourceSeqEnd: 6 }, anchor('b')]); await tick();
    assert.equal(log.filter(value => value.startsWith('mount:')).length, 3);
    a.invalidate(['public:a']); assert.equal(current[0]!(), false); assert.equal(current[2]!(), true, 'other split keeps its own proof authority');
    left.querySelector('[data-timeline-row-id="public:a"]')!.append(document.createTextNode('Native changed'));
    await tick(); assert.equal(current[0]!(), false, 'ordinary DOM reconciliation cannot restore invalidated proof');
    a.update([{ ...anchor('a'), sourceSeqEnd: 6 }, anchor('b')], ['public:a', 'public:b']);
    assert.equal(current[0]!(), true); assert.equal(current[2]!(), true);
    left.querySelector<HTMLElement>('[data-timeline-row-id="public:a"]')!.dataset.timelineRowId = 'other-thread-row';
    assert.equal(current[0]!(), false); await tick();
    assert.ok(log.indexOf('abort:a') < log.indexOf('dispose:a'));
    assert.equal(right.querySelectorAll('[data-turn-results-gallery]').length, 1);
    a.dispose(); b.dispose(); await tick(); assert.equal(document.querySelectorAll('[data-turn-results-gallery]').length, 0);
  } finally { a.dispose(); b.dispose(); await tick(); Object.assign(globalThis, saved); dom.window.close(); }
});
test('partial page defers its first turn; multi-summary turn has one terminal anchor', () => {
  const rows = [
    { id: 'first', threadId: 'thread', turnId: 'partial', kind: 'turn', sourceSeqStart: 1, sourceSeqEnd: 3 },
    { id: 'work-1', threadId: 'thread', turnId: 'full', kind: 'turn', sourceSeqStart: 4, sourceSeqEnd: 7 },
    { id: 'work-2', threadId: 'thread', turnId: 'full', kind: 'turn', sourceSeqStart: 8, sourceSeqEnd: 10 },
    { id: 'final', threadId: 'thread', turnId: 'full', kind: 'conversation', role: 'assistant', sourceSeqStart: 11, sourceSeqEnd: 12 },
  ];
  assert.deepEqual(galleryAnchors(rows, 'thread', 'snapshot', false).map(a => a.rowId), ['final']);
  assert.equal(galleryAnchors(rows, 'thread', 'snapshot', true).length, 2);
  assert.throws(() => galleryAnchors(rows, 'other', 'snapshot', true));
});

test('full-turn bounds preserve terminal placement and reject partial/interleaved/foreign-overlap scopes', () => {
  const row = (id: string, turnId: string, start: number, end: number) => ({ id, threadId: 'thread', turnId,
    kind: 'conversation', role: 'assistant', sourceSeqStart: start, sourceSeqEnd: end });
  const rows = [row('prev', 'prev', 1, 2), row('work1', 'full', 3, 7), row('work2', 'full', 8, 10), row('final', 'full', 11, 12), row('next', 'next', 13, 15)];
  const anchor = galleryAnchors(rows, 'thread', 's', false).find(a => a.turnId === 'full')!;
  assert.deepEqual([anchor.rowId, anchor.sourceSeqStart, anchor.sourceSeqEnd, anchor.turnSeqStart, anchor.turnSeqEnd], ['final', 11, 12, 3, 12]);
  assert.equal(galleryAnchors(rows.slice(1), 'thread', 's', false).some(a => a.turnId === 'full'), false);
  assert.equal(galleryAnchors([rows[0]!, rows[1]!, row('interleaved', 'next', 8, 9), rows[3]!], 'thread', 's', true).some(a => a.turnId === 'full'), false);
  assert.equal(galleryAnchors([rows[0]!, rows[1]!, rows[3]!, row('overlap', 'next', 12, 15)], 'thread', 's', true).some(a => a.turnId === 'full'), false);
  assert.equal(galleryAnchors([rows[0]!, rows[2]!, rows[1]!, rows[3]!], 'thread', 's', true).some(a => a.turnId === 'full'), false);
});
