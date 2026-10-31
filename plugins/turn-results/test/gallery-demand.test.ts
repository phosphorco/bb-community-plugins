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

test('native hints retain bounded exact changed rows; unknown structure is broad and owned/nested panes stay isolated', async () => {
  const f = fixture(25), changes: { reason: string; rows: readonly string[] | null }[] = [];
  const stop = observeGalleryDemand(f.sentinel, (_ids, _capacity, reason, rows) => changes.push({ reason, rows }));
  try {
    await tick();
    f.rows[1]!.querySelector('button')!.firstChild!.textContent = 'Streaming native token';
    await tick(); assert.deepEqual(changes.at(-1), { reason: 'mutation', rows: ['opaque-row-1'] });
    for (let i = 0; i < 21; i++) f.rows[i]!.querySelector('button')!.firstChild!.textContent = `Token${i}`;
    await tick(); assert.deepEqual(changes.at(-1), { reason: 'mutation', rows: null }, 'overflow becomes conservative, never an unbounded row set');
    const owned = document.createElement('div'); owned.dataset.turnResultsGallery = ''; f.rows[0]!.append(owned);
    await tick(); const before = changes.length; owned.textContent = 'Owned host update'; await tick(); assert.equal(changes.length, before);
    const nested = document.createElement('section'); nested.dataset.threadWindow = ''; nested.innerHTML = '<div data-timeline-row-id="foreign"><button>Other pane</button></div>';
    f.pane.append(nested); await tick(); const nestedBefore = changes.length;
    nested.querySelector('button')!.textContent = 'Other pane streamed';
    nested.querySelector('div')!.dataset.timelineRowId = 'reused-foreign';
    await tick(); assert.equal(changes.length, nestedBefore);
    f.rows[1]!.remove(); await tick(); assert.deepEqual(changes.at(-1), { reason: 'mutation', rows: null });
  } finally { stop(); f.restore(); }
});

function structuralFixture(count = 4, scope?: { id: string; turnId: string | null }[], onlyFirst = false) {
  const f = fixture(count), list = f.pane.querySelector<HTMLElement>('[data-timeline-row-list]')!;
  const items = document.createElement('div'); items.dataset.timelineItems = ''; list.append(items);
  for (const row of f.rows) items.append(row);
  const publicRows = scope ?? f.rows.map((row, i) => ({ id: row.dataset.timelineRowId!, turnId: `turn-${i}` }));
  const anchors = f.rows.slice(0, onlyFirst ? 1 : count).map((row, i): GalleryAnchor => ({ threadId: 'thread', turnId: `turn-${i}`, rowId: row.dataset.timelineRowId!,
    sourceSeqStart: 1, sourceSeqEnd: 10, turnSeqStart: 1, turnSeqEnd: 10, historySnapshot: 'accepted-public-snapshot' }));
  const current = new Map<string, () => boolean>(), changes: (readonly string[] | null)[] = [];
  const handle = mountGalleryPane(f.sentinel, 'thread', anchors, (_host, anchor, check) => {
    current.set(anchor.turnId, check); return { dispose() {} };
  }, publicRows);
  const stop = observeGalleryDemand(f.sentinel, (_ids, _capacity, reason, rows) => {
    if (reason === 'mutation') { changes.push(rows); handle.invalidate(rows ?? undefined); }
  });
  return { ...f, items, list, publicRows, anchors, current, changes, handle,
    async close() { stop(); await handle.dispose(); f.restore(); } };
}

test('exact native item-wrapper windowing carries only witnessed public row IDs and keeps unrelated authority', async () => {
  const f = structuralFixture();
  try {
    await tick(); const healthy = f.current.get('turn-0')!;
    f.rows[1]!.remove();
    assert.equal(f.current.get('turn-1')!(), false, 'physical target removal fences its own callbacks synchronously');
    await tick(); assert.deepEqual(f.changes.at(-1), ['opaque-row-1']); assert.equal(healthy(), true);
    f.items.append(f.rows[1]!); await tick();
    assert.deepEqual(f.changes.at(-1), ['opaque-row-1']); assert.equal(healthy(), true);
    assert.equal(f.current.get('turn-1')!(), false, 'same ID reentry does not restore old target authority');
    f.handle.update(f.anchors, f.anchors.map(a => a.rowId), f.publicRows); await tick();
    assert.equal(f.current.get('turn-1')!(), true, 'only accepted fresh public proof restores the reentered row');
    const count = f.changes.length; await tick(); assert.equal(f.changes.length, count, 'quiet pane has no repeated mutation work');
  } finally { await f.close(); }
});

test('structural same-turn sibling uses published association and source correction replaces that association', async () => {
  const f = structuralFixture(3, undefined, true);
  try {
    await tick();
    const corrected = f.publicRows.map(row => row.id === 'opaque-row-1' ? { ...row, turnId: 'turn-0' } : row);
    f.handle.update(f.anchors, [], corrected);
    f.rows[1]!.remove(); await tick(); assert.deepEqual(f.changes.at(-1), ['opaque-row-1']);
    assert.equal(f.current.get('turn-0')!(), false, 'same-turn sibling removal suspends the terminal host');
    f.items.append(f.rows[1]!); await tick(); assert.equal(f.current.get('turn-0')!(), false);
    f.handle.update(f.anchors, f.anchors.map(a => a.rowId), corrected); await tick(); assert.equal(f.current.get('turn-0')!(), true);
  } finally { await f.close(); }
});

test('wrapper narrowing refuses replacement/reorder/reparent, identity/list changes, mixed structure and overflow', async t => {
  const cases: [string, (f: ReturnType<typeof structuralFixture>) => void][] = [
    ['same-parent reorder', f => f.items.prepend(f.rows[1]!)],
    ['same-ID replacement', f => f.rows[1]!.replaceWith(f.rows[1]!.cloneNode(true))],
    ['cross-list reparent', f => { const other = document.createElement('div'); other.dataset.timelineRowList = 'top-level'; f.pane.append(other); other.append(f.rows[1]!); }],
    ['cross-pane reparent', f => { const other = document.createElement('section'); other.dataset.threadWindow = ''; document.body.append(other); other.append(f.rows[1]!); }],
    ['identity reuse then removal', f => { f.rows[1]!.dataset.timelineRowId = 'reused'; f.rows[1]!.remove(); }],
    ['identity mutation retained', f => { f.rows[1]!.dataset.timelineRowId = 'reused'; }],
    ['list identity change', f => { f.list.dataset.timelineRowList = 'nested'; }],
    ['mixed row and unknown child', f => { f.rows[1]!.remove(); f.items.append(document.createElement('aside')); }],
    ['unknown public row', f => { const node = document.createElement('div'); node.dataset.timelineRowId = 'new-unmapped'; f.items.append(node); }],
    ['nested structure removal', f => { f.rows[1]!.insertAdjacentHTML('beforeend', '<div data-timeline-row-list="nested"><div data-timeline-row-id="nested-child"></div></div>'); f.rows[1]!.remove(); }],
    ['missing native item marker', f => { delete f.items.dataset.timelineItems; f.rows[1]!.remove(); }],
    ['row-set overflow', f => { for (const row of f.rows.slice(1, 22)) row.remove(); }],
  ];
  for (const [name, mutate] of cases) await t.test(name, async () => {
    const f = structuralFixture(name === 'row-set overflow' ? 25 : 4);
    try { await tick(); mutate(f); await tick(); assert.equal(f.changes.at(-1), null); assert.equal(f.current.get('turn-0')!(), false); }
    finally { await f.close(); }
  });
});

test('missing/null/ambiguous public association and duplicate native occupancy stay broad', async t => {
  for (const kind of ['missing', 'null', 'empty', 'ambiguous', 'duplicate-native'] as const) await t.test(kind, async () => {
    const scope = [{ id: 'opaque-row-0', turnId: 'turn-0' },
      ...(kind === 'missing' ? [] : [{ id: 'opaque-row-1', turnId: kind === 'null' ? null : kind === 'empty' ? '' : 'turn-1' }]),
      ...(kind === 'ambiguous' ? [{ id: 'opaque-row-1', turnId: 'turn-0' }] : [])];
    const f = structuralFixture(3, scope);
    try {
      await tick();
      if (kind === 'duplicate-native') { f.items.append(f.rows[1]!.cloneNode(true)); await tick(); f.handle.update(f.anchors, [], scope); }
      f.rows[1]!.remove(); await tick(); assert.equal(f.changes.at(-1), null); assert.equal(f.current.get('turn-0')!(), false);
    } finally { await f.close(); }
  });
});

test('inbound row from an independently observed foreign pane cannot impersonate a newly windowed public row', async t => {
  for (const disposed of [false, true]) await t.test(disposed ? 'source observer already disposed' : 'source still mounted', async () => {
  const f = structuralFixture(2, [{ id: 'opaque-row-0', turnId: 'turn-0' }, { id: 'opaque-row-1', turnId: 'turn-1' },
    { id: 'public-returning', turnId: 'turn-2' }]);
  const other = document.createElement('section'); other.dataset.threadWindow = '';
  other.innerHTML = '<div data-timeline-row-list="top-level"><div data-timeline-items><div data-timeline-row-id="public-returning"></div></div></div><span></span>';
  document.body.append(other);
  const stopOther = observeGalleryDemand(other.querySelector('span')!, () => {});
  try {
    await tick(); const row = other.querySelector('[data-timeline-row-id]')!;
    if (disposed) { stopOther(); other.remove(); }
    f.items.append(row); await tick();
    assert.equal(f.changes.at(-1), null); assert.equal(f.current.get('turn-0')!(), false);
  } finally { stopOther(); other.remove(); await f.close(); }
  });
});

test('new native node for an already published public row is admitted after same-pane observer teardown/remount', async () => {
  const f = fixture(2), list = f.pane.querySelector<HTMLElement>('[data-timeline-row-list]')!;
  const items = document.createElement('div'); items.dataset.timelineItems = ''; list.append(items);
  for (const row of f.rows) items.append(row);
  const anchor: GalleryAnchor = { threadId: 'thread', turnId: 'turn-0', rowId: 'opaque-row-0', sourceSeqStart: 1,
    sourceSeqEnd: 10, turnSeqStart: 1, turnSeqEnd: 10, historySnapshot: 'new-public-snapshot' };
  const handle = mountGalleryPane(f.sentinel, 'thread', [anchor], () => ({ dispose() {} }),
    [{ id: 'opaque-row-0', turnId: 'turn-0' }, { id: 'already-public', turnId: 'another-turn' }]);
  let stop = observeGalleryDemand(f.sentinel, () => {});
  try {
    await tick(); stop();
    const changes: (readonly string[] | null)[] = [];
    stop = observeGalleryDemand(f.sentinel, (_ids, _capacity, reason, ids) => { if (reason === 'mutation') changes.push(ids); });
    const node = document.createElement('div'); node.dataset.timelineRowId = 'already-public'; items.append(node); await tick();
    assert.deepEqual(changes.at(-1), ['already-public']);
  } finally { stop(); await handle.dispose(); f.restore(); }
});
