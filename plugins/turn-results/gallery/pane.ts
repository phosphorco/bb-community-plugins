import type { GalleryAnchor } from './anchors.ts';

export interface GalleryRoot {
  dispose(): void | Promise<void>; beginDisposal?(): () => void; whenDrained?(): Promise<void>;
  update?(anchor: GalleryAnchor): void; visible?(visible: boolean): void; suspend?(suspended: boolean): void;
}
const owners = new WeakMap<HTMLElement, { dispose(): Promise<void>; wake(): void }>();
const handoffs = new WeakMap<HTMLElement, { drained: boolean; promise: Promise<void> }>();
export const GALLERY_PANE_LIMITS = Object.freeze({ rows: 1000, targets: 20, roots: 64 });
const ownedSurface = '[data-turn-results-gallery], [data-turn-results-sentinel], [data-turn-results-dialog], [data-turn-results-panel]';
function nativeRows(pane: Element) {
  return [...pane.querySelectorAll<HTMLElement>('[data-timeline-row-id]')].filter(row =>
    row.closest('[data-thread-window]') === pane && row.closest('[data-timeline-row-list]')?.getAttribute('data-timeline-row-list') === 'top-level');
}
function intersects(row: HTMLElement, pane: Element) {
  const box = row.getBoundingClientRect(), scope = pane.getBoundingClientRect();
  return box.height > 0 && box.width > 0 && box.bottom > Math.max(0, scope.top)
    && box.top < Math.min(window.innerHeight, scope.bottom) && box.right > 0 && box.left < window.innerWidth;
}
/** One observer per pane for actual native visibility/focus, never a guessed
 * recent-turn list. Only changed bounded demand notifies the page reader. */
export function observeGalleryDemand(sentinel: HTMLElement, changed: (ids: string[], capacity: boolean, reason: 'demand' | 'mutation' | 'visibility') => void) {
  const pane = sentinel.closest('[data-thread-window]');
  if (!pane) return () => {};
  let active = true, queued = false, prior = '', rows: HTMLElement[] = [];
  let reason: 'demand' | 'mutation' | 'visibility' = 'demand';
  const visible = new Set<Element>();
  function publish() {
    queued = false; if (!active || document.hidden) return;
    const focused = document.activeElement?.closest<HTMLElement>('[data-timeline-row-id]');
    const admitted = rows.filter(row => visible.has(row) || row === focused);
    if (focused && admitted.includes(focused)) { admitted.splice(admitted.indexOf(focused), 1); admitted.unshift(focused); }
    const ids = [...new Set(admitted.map(row => row.dataset.timelineRowId!))].slice(0, GALLERY_PANE_LIMITS.targets);
    const capacity = admitted.length > GALLERY_PANE_LIMITS.targets || rows.length > GALLERY_PANE_LIMITS.rows;
    const key = JSON.stringify([ids, capacity]); if (key === prior && reason === 'demand') return;
    prior = key; const cause = reason; reason = 'demand'; changed(ids, capacity, cause);
  }
  function schedule() { if (!queued && active && !document.hidden) { queued = true; queueMicrotask(publish); } }
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) if (entry.isIntersecting) visible.add(entry.target); else visible.delete(entry.target);
    schedule();
  });
  function scan() {
    if (!active || document.hidden) return;
    const next = nativeRows(pane!);
    const retained = new Set(next);
    for (const row of rows) if (!retained.has(row)) { observer.unobserve(row); visible.delete(row); }
    const old = new Set(rows); rows = next;
    for (const row of rows.slice(0, GALLERY_PANE_LIMITS.rows)) if (!old.has(row)) {
      if (intersects(row, pane!)) visible.add(row); observer.observe(row);
    }
    schedule();
  }
  const mutations = new MutationObserver(records => {
    const native = records.some(record => {
      const target = record.target instanceof Element ? record.target : record.target.parentElement;
      if (!target?.isConnected || target.closest(ownedSurface)) return false;
      if (record.type === 'childList' && [...record.addedNodes, ...record.removedNodes].every(node =>
        node instanceof Element && node.matches(ownedSurface))) return false;
      // Native content is a hint, never parsed as status or turn authority.
      const row = target?.closest<HTMLElement>('[data-timeline-row-id]');
      return record.type === 'attributes' || !row || visible.has(row) || row.contains(document.activeElement);
    });
    if (!native) return;
    reason = 'mutation'; scan();
  });
  const visibility = () => { if (!document.hidden) { reason = 'visibility'; prior = ''; scan(); } };
  mutations.observe(pane, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['data-timeline-row-id', 'data-timeline-row-list'] });
  pane.addEventListener('focusin', schedule); pane.addEventListener('focusout', schedule);
  document.addEventListener('visibilitychange', visibility); scan();
  return () => { active = false; observer.disconnect(); mutations.disconnect(); pane.removeEventListener('focusin', schedule);
    pane.removeEventListener('focusout', schedule); document.removeEventListener('visibilitychange', visibility); };
}
/** Native owns scrolling/windowing/pins. A finite set of roots is backed by
 * measured, inert owned shells on still-mounted rows. No native styles/hooks.
 * Exact row reuse aborts input authority synchronously before deferred unmount. */
export function mountGalleryPane(sentinel: HTMLElement, threadId: string,
  initialAnchors: readonly GalleryAnchor[], mount: (host: HTMLElement, anchor: GalleryAnchor, current: () => boolean, lifetime: AbortSignal) => GalleryRoot) {
  let anchors = initialAnchors;
  const pane = sentinel.closest<HTMLElement>('[data-thread-window]');
  const valid = (next: readonly GalleryAnchor[]) => next.length <= 64 && next.every(a => a.threadId === threadId)
    && new Set(next.map(a => a.turnId)).size === next.length && new Set(next.map(a => a.rowId)).size === next.length;
  if (!pane || !valid(anchors)) throw Error('Invalid gallery pane scope.');
  owners.get(pane)?.dispose();
  // Disposal records one shared barrier per native pane. Empty successors
  // neither chain promises nor add a continuation on each denied remount.
  const handoff = handoffs.get(pane) ?? null, predecessor = handoff?.promise;
  let predecessorReady = handoff === null || handoff.drained;
  let active = true, queued = false, capacity = false;
  let disposal: Promise<void> | null = null;
  const retiring = new Set<Promise<void>>();
  const invalid = new WeakSet<GalleryAnchor>();
  const roots = new Map<string, { anchor: GalleryAnchor; row: HTMLElement; host: HTMLElement; controller: AbortController; root: GalleryRoot; validity: { current: boolean } }>();
  const shells = new Map<string, { row: HTMLElement; host: HTMLElement; ready: boolean }>();
  const own = () => active && owners.get(pane) === handle && sentinel.isConnected && sentinel.closest('[data-thread-window]') === pane;
  function retire(key: string, keepShell = false) {
    const old = roots.get(key); if (!old) return;
    const finish = old.root.beginDisposal?.();
    roots.delete(key); observer.unobserve(old.row); old.controller.abort();
    const height = old.host.getBoundingClientRect().height;
    if (keepShell && height > 0) old.host.style.minHeight = `${height}px`;
    if (keepShell) shells.set(key, { row: old.row, host: old.host, ready: false });
    let done!: () => void;
    const drained = new Promise<void>(resolve => { done = resolve; }); retiring.add(drained);
    queueMicrotask(async () => {
      try { await old.root.dispose(); finish?.(); await old.root.whenDrained?.(); }
      catch { return; } // A failed actual disposal must not free credit or drain.
      if (!keepShell || !active) old.host.remove();
      else { const shell = shells.get(key); if (shell?.host === old.host) shell.ready = true; }
      retiring.delete(drained); done();
      if (active && !queued) { queued = true; queueMicrotask(reconcile); }
    });
  }
  function reconcile() {
    queued = false;
    if (!own()) { handle.dispose(); return; }
    if (!predecessorReady) { capacity = true; return; }
    if (document.hidden) { for (const old of roots.values()) old.root.visible?.(false); return; }
    const rows = nativeRows(pane!);
    if (rows.length > GALLERY_PANE_LIMITS.rows) { capacity = true; return; }
    capacity = false;
    const grouped = new Map<string, HTMLElement[]>();
    for (const row of rows) { const id = row.dataset.timelineRowId!; const group = grouped.get(id) ?? []; group.push(row); grouped.set(id, group); }
    const reassigned = new Map(anchors.map(anchor => [anchor.rowId, anchor.turnId]));
    for (const [key, old] of roots) {
      if ((reassigned.has(old.anchor.rowId) && reassigned.get(old.anchor.rowId) !== key) || grouped.get(old.anchor.rowId)?.[0] !== old.row || grouped.get(old.anchor.rowId)?.length !== 1 || old.host.parentElement !== old.row) { invalid.add(old.anchor); retire(key); }
      else old.root.visible?.(!document.hidden && (old.row.contains(document.activeElement) || intersects(old.row, pane!)));
    }
    for (const [key, shell] of shells) if (!rows.includes(shell.row) || !shell.row.contains(shell.host) || shell.row.dataset.timelineRowId !== shell.host.dataset.sourceRow) { shell.host.remove(); shells.delete(key); }
    for (const anchor of anchors) {
      if (invalid.has(anchor)) continue;
      const candidates = grouped.get(anchor.rowId), next = candidates?.length === 1 ? candidates[0]! : null;
      const prior = roots.get(anchor.turnId);
      if (prior && prior.row === next) continue;
      retire(anchor.turnId);
      if (!next) continue;
      if (roots.size + retiring.size >= GALLERY_PANE_LIMITS.roots) {
        const victim = [...roots].find(([, old]) => !old.row.contains(document.activeElement) && !intersects(old.row, pane!));
        if (victim) retire(victim[0], true);
        capacity = true; continue;
      }
      const shell = shells.get(anchor.turnId);
      // A nested React root must finish deferred unmount before its container
      // can be reused by a new root, including same-task native remounts.
      if (shell && !shell.ready) { capacity = true; continue; } // Exact disposal completion schedules the next reconciliation.
      const host = shell?.row === next ? shell.host : document.createElement('div');
      shells.delete(anchor.turnId); if (shell && shell.host !== host) shell.host.remove();
      const controller = new AbortController();
      host.dataset.turnResultsGallery = ''; host.dataset.sourceThread = threadId;
      host.dataset.sourceTurn = anchor.turnId; host.dataset.sourceRow = anchor.rowId;
      if (host.parentElement !== next) next.append(host);
      const validity = { current: true };
      const current = () => own() && validity.current && !controller.signal.aborted && host.isConnected && host.parentElement === next
        && next.dataset.timelineRowId === anchor.rowId && next.closest('[data-thread-window]') === pane;
      let root: GalleryRoot;
      try { root = mount(host, anchor, current, controller.signal); }
      catch { controller.abort(); host.remove(); capacity = true; continue; }
      roots.set(anchor.turnId, { anchor, row: next, host, controller, root, validity });
      root.visible?.(!document.hidden && (next.contains(document.activeElement) || intersects(next, pane!)));
      observer.observe(next);
    }
  }
  const observer = new IntersectionObserver(() => reconcile());
  const mutations = new MutationObserver(records => {
    if (queued || !active || document.hidden || !records.some(record => {
      const target = record.target instanceof Element ? record.target : record.target.parentElement;
      return target?.isConnected && !target.closest(ownedSurface) && !(record.type === 'childList' && [...record.addedNodes, ...record.removedNodes].every(node => node instanceof Element && node.matches(ownedSurface)));
    })) return;
    queued = true; queueMicrotask(reconcile);
  });
  const handle = { get capacity() { return capacity; }, get pendingRoots() { return roots.size + retiring.size > 0; },
    wake() { predecessorReady = handoff === null || handoff.drained; if (active) reconcile(); }, invalidate(ids?: readonly string[]) {
    const affected = ids ? new Set(ids) : null;
    for (const anchor of anchors) if (!affected || affected.has(anchor.rowId)) invalid.add(anchor);
    for (const old of roots.values()) if (!affected || affected.has(old.anchor.rowId)) {
      old.validity.current = false; old.root.suspend?.(true);
    }
  }, update(next: readonly GalleryAnchor[], checked: readonly string[] = []) {
    if (!active) return; if (!valid(next)) throw Error('Invalid updated pane scope.');
    const confirmed = new Set(next.map(anchor => anchor.rowId)), verified = new Set(checked);
    for (const [key, old] of roots) if (verified.has(old.anchor.rowId) && !confirmed.has(old.anchor.rowId)) retire(key, true);
    for (const anchor of next) {
      invalid.delete(anchor);
      const prior = roots.get(anchor.turnId);
      if (prior?.anchor.rowId === anchor.rowId) {
        prior.root.update?.(anchor); prior.anchor = anchor; prior.validity.current = true; prior.root.suspend?.(false);
      }
    }
    anchors = next; reconcile();
  }, dispose() {
    if (disposal) return disposal;
    active = false; mutations.disconnect(); observer.disconnect();
    pane!.removeEventListener('focusin', reconcile); pane!.removeEventListener('focusout', reconcile);
    document.removeEventListener('visibilitychange', reconcile);
    if (owners.get(pane!) === handle) owners.delete(pane!);
    for (const key of [...roots.keys()]) retire(key);
    for (const shell of shells.values()) shell.host.remove(); shells.clear();
    disposal = retiring.size ? Promise.all([...retiring, ...(predecessor ? [predecessor] : [])]).then(() => {})
      : predecessor ?? Promise.resolve();
    if (retiring.size) {
      const barrier = { drained: false, promise: disposal }; handoffs.set(pane!, barrier);
      void disposal.then(() => { barrier.drained = true; owners.get(pane!)?.wake(); });
    }
    return disposal;
  } };
  owners.set(pane, handle);
  mutations.observe(pane, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-timeline-row-id', 'data-timeline-row-list'] });
  pane.addEventListener('focusin', reconcile); pane.addEventListener('focusout', reconcile); document.addEventListener('visibilitychange', reconcile);
  reconcile(); return handle;
}
