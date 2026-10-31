import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountProbePane } from '../probe/pane.ts';
import type { Anchor } from '../probe/anchor.ts';
const anchor: Anchor = { threadId: 'thread', turnId: 'turn', rowId: 'opaque', sourceSeqStart: 1, sourceSeqEnd: 3, historySnapshot: 's' };
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
test('pane isolation, exact top-level row, removal/reuse, stale disposer and owned mutation lifecycle', async () => {
  const dom = new JSDOM('<main></main>');
  const saved = { document: globalThis.document, Element: globalThis.Element, MutationObserver: globalThis.MutationObserver };
  Object.assign(globalThis, { document: dom.window.document, Element: dom.window.Element, MutationObserver: dom.window.MutationObserver });
  const main = document.querySelector('main')!;
  function makePane() {
    const pane = document.createElement('div');
    pane.dataset.threadWindow = '';
    pane.innerHTML = '<div data-timeline-row-list="top-level"><div data-timeline-row-id="opaque"><p>Native prose</p></div></div><div class="sentinel"></div>';
    main.append(pane);
    return pane;
  }
  const left = makePane(), right = makePane();
  const sent = (pane: HTMLElement) => pane.querySelector<HTMLElement>('.sentinel')!;
  let mounts = 0, disposals = 0;
  const checks: (() => boolean)[] = [];
  const mount = (host: HTMLElement, current: () => boolean) => {
    mounts++; checks.push(current);
    host.append(document.createElement('button'));
    return { dispose() { disposals++; } };
  };
  const first = mountProbePane(sent(left), anchor, mount, () => {});
  const second = mountProbePane(sent(right), anchor, mount, () => {});
  try {
    await flush();
    assert.equal(mounts, 2); // own child mutation did not remount
    assert.equal(left.querySelectorAll('[data-turn-results-probe]').length, 1);
    assert.equal(right.querySelectorAll('[data-turn-results-probe]').length, 1);
    left.querySelector<HTMLElement>('[data-timeline-row-id]')!.dataset.timelineRowId = 'other-thread-row';
    await flush();
    assert.equal(checks[0]!(), false);
    assert.equal(disposals, 1);
    assert.equal(left.querySelectorAll('[data-turn-results-probe]').length, 0);
    const native = left.querySelector<HTMLElement>('[data-timeline-row-id]')!;
    native.dataset.timelineRowId = 'opaque';
    await flush();
    assert.equal(mounts, 3);
    assert.equal(checks[0]!(), false); // old closure cannot become valid when same ID remounts
    const replacement = mountProbePane(sent(left), anchor, mount, () => {});
    first.dispose();
    await flush();
    assert.equal(left.querySelectorAll('[data-turn-results-probe]').length, 1);
    replacement.dispose();
    second.dispose();
    await flush();
    assert.equal(disposals, mounts);
    assert.equal(document.querySelectorAll('[data-turn-results-probe]').length, 0);
    assert.equal(left.querySelector('p')!.textContent, 'Native prose');
  } finally {
    first.dispose(); second.dispose();
    await flush();
    Object.assign(globalThis, saved);
    dom.window.close();
  }
});
