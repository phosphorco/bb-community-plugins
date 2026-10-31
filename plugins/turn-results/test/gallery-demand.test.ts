import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { observeGalleryDemand, mountGalleryPane } from '../gallery/pane.ts';
import type { GalleryAnchor } from '../gallery/anchors.ts';
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function fixture(count: number) {
  const dom = new JSDOM('<main data-thread-window><div data-timeline-row-list="top-level"></div><span></span></main>', { pretendToBeVisual: true });
  const saved = { window: globalThis.window, document: globalThis.document, Element: globalThis.Element,
    MutationObserver: globalThis.MutationObserver, IntersectionObserver: globalThis.IntersectionObserver };
  const observers: { targets: Set<Element>; callback: (entries: { target: Element; isIntersecting: boolean }[]) => void }[] = [];
  class Observer {
    state: typeof observers[number];
    constructor(callback: typeof observers[number]['callback']) { this.state = { callback, targets: new Set() }; observers.push(this.state); }
    observe(target: Element) { this.state.targets.add(target); }
    unobserve(target: Element) { this.state.targets.delete(target); }
    disconnect() { this.state.targets.clear(); }
  }
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, Element: dom.window.Element,
    MutationObserver: dom.window.MutationObserver, IntersectionObserver: Observer });
  const rect = (top: number, height: number) => ({ top, bottom: top + height, left: 0, right: 800, width: 800, height, x: 0, y: top, toJSON() {} });
  const pane = document.querySelector<HTMLElement>('main')!;
  pane.getBoundingClientRect = () => rect(0, 600);
  const rows = Array.from({ length: count }, (_, i) => {
    const row = document.createElement('div'); row.dataset.timelineRowId = `opaque-row-${i}`;
    row.innerHTML = '<button>Native action</button>'; row.getBoundingClientRect = () => rect(i < 25 ? 10 : 900, 80);
    pane.querySelector('[data-timeline-row-list]')!.append(row); return row;
  });
  const sentinel = pane.querySelector('span')!;
  return { dom, pane, rows, sentinel, observers,
    restore() { Object.assign(globalThis, saved); dom.window.close(); } };
}
test('actual top-level visible/focused demand is20; nested and neighboring panes never borrow IDs; hidden is quiet', async () => {
  const f = fixture(70), changes: { ids: string[]; capacity: boolean }[] = [];
  f.rows[0]!.insertAdjacentHTML('beforeend', '<div data-timeline-row-list="detail"><div data-timeline-row-id="nested"></div></div>');
  const stop = observeGalleryDemand(f.sentinel, (ids, capacity) => changes.push({ ids, capacity }));
  try {
    await tick(); assert.equal(changes.at(-1)!.ids.length, 20); assert.equal(changes.at(-1)!.capacity, true);
    f.rows[69]!.querySelector('button')!.focus(); await tick();
    assert.equal(changes.at(-1)!.ids[0], 'opaque-row-69'); assert.equal(changes.at(-1)!.ids.includes('nested'), false);
    const count = changes.length; await tick(); assert.equal(changes.length, count);
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new f.dom.window.Event('visibilitychange'));
    f.observers[0]!.callback([{ target: f.rows[1]!, isIntersecting: false }]); await tick(); assert.equal(changes.length, count);
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new f.dom.window.Event('visibilitychange')); await tick(); assert.equal(changes.length, count + 1);
  } finally { stop(); assert.ok(f.observers.every(observer => observer.targets.size === 0)); f.restore(); }
});
test('64 roots retain focused/visible last-good roots; eviction leaves measured inert shell and retires reused identity', async () => {
  const f = fixture(70), checks = new Map<string, () => boolean>(), mounts: string[] = [], disposed: string[] = [];
  const anchor = (i: number): GalleryAnchor => ({ threadId: 'thread', turnId: `turn-${i}`, rowId: `opaque-row-${i}`,
    sourceSeqStart: 1, sourceSeqEnd: 10, turnSeqStart: 1, turnSeqEnd: 10, historySnapshot: 's' });
  const handle = mountGalleryPane(f.sentinel, 'thread', Array.from({ length: 64 }, (_, i) => anchor(i)), (host, a, current) => {
    mounts.push(a.turnId); checks.set(a.turnId, current); host.getBoundingClientRect = () => ({ ...host.parentElement!.getBoundingClientRect(), height: 240 });
    return { dispose() { disposed.push(a.turnId); } };
  });
  try {
    await tick(); assert.equal(mounts.length, 64);
    f.rows[63]!.querySelector('button')!.focus(); handle.update([anchor(69)]); await tick();
    assert.equal(checks.get('turn-63')!(), true); assert.equal(checks.get('turn-0')!(), true);
    assert.ok(disposed.includes('turn-25')); assert.equal(mounts.length, 65);
    const shell = f.rows[25]!.querySelector<HTMLElement>('[data-turn-results-gallery]')!;
    assert.equal(shell.style.minHeight, '240px'); assert.equal(checks.get('turn-25')!(), false);
    assert.equal(f.pane.scrollTop, 0, 'plugin never writes native reader position');
    f.rows[69]!.dataset.timelineRowId = 'foreign-reused-row'; assert.equal(checks.get('turn-69')!(), false);
    await tick(); assert.ok(disposed.includes('turn-69'));
    handle.dispose(); await tick(); assert.equal(f.pane.querySelectorAll('[data-turn-results-gallery]').length, 0);
  } finally { handle.dispose(); await tick(); f.restore(); }
});
