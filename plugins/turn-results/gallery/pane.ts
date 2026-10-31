import type { GalleryAnchor } from './anchors.ts';

export interface GalleryRoot {
  dispose(): void | Promise<void>; beginDisposal?(): () => void; whenDrained?(): Promise<void>;
  update?(anchor: GalleryAnchor): void; visible?(visible: boolean): void; suspend?(suspended: boolean): void;
}
export interface GalleryActionCapture { readonly boundary: Readonly<GalleryAnchor>; live(): boolean; release(): void }
export interface GalleryActionScope { capture(): GalleryActionCapture | null }
export function sameBoundary(a: Readonly<GalleryAnchor>, b: Readonly<GalleryAnchor>) {
  return a.threadId === b.threadId && a.turnId === b.turnId && a.rowId === b.rowId
    && a.sourceSeqStart === b.sourceSeqStart && a.sourceSeqEnd === b.sourceSeqEnd
    && a.turnSeqStart === b.turnSeqStart && a.turnSeqEnd === b.turnSeqEnd;
}
const owners = new WeakMap<HTMLElement, { dispose(): Promise<void>; wake(): void; knowsRow(id: string): boolean }>();
const handoffs = new WeakMap<HTMLElement, { drained: boolean; promise: Promise<void> }>();
export const GALLERY_PANE_LIMITS = Object.freeze({ rows: 1000, targets: 20, roots: 64 });
const ownedSurface = '[data-turn-results-gallery], [data-turn-results-sentinel], [data-turn-results-dialog], [data-turn-results-notice], [data-turn-results-bridge]';
const nativeStructure = '[data-timeline-row-id], [data-timeline-row-list], [data-timeline-items], [data-thread-window]';
// Index only actual observed nodes, never opaque IDs/history. This weak index
// shares the prior DOM witness across split observers so an inbound reparent
// cannot impersonate a fresh windowed node in its destination pane.
const domTokens = new WeakMap<Element, object>();
function domToken(element: Element | null): object | null {
  if (!element) return null;
  let token = domTokens.get(element);
  if (!token) { token = {}; domTokens.set(element, token); }
  return token;
}
const rowOrigins = new WeakMap<Element, { pane: object; parent: object | null; list: object | null; id: string }>();
interface ScopeRow { id: string; turnId: string | null }
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
/** Public header props provide thread identity; this local DOM proof provides
 * the physical copy. Never map an empty window attribute or a document thread. */
export function resolveGalleryBridge(marker: HTMLElement): { pane: HTMLElement; scope: HTMLElement } | null {
  if (!marker.isConnected || !marker.hasAttribute('data-turn-results-bridge')) return null;
  const split = marker.closest<HTMLElement>('[data-split-pane-id]');
  let scope: HTMLElement | null = split ?? marker.parentElement;
  for (let depth = 0; scope && depth < 32; depth++, scope = scope.parentElement) {
    if (scope === document.body || scope === document.documentElement || scope.hasAttribute('data-app-content-shell')) return null;
    const windows = [...scope.querySelectorAll<HTMLElement>('[data-thread-window]')].filter(node =>
      !node.parentElement?.closest('[data-thread-window]') && (!split || node.closest('[data-split-pane-id]') === split));
    const bridges = [...scope.querySelectorAll('[data-turn-results-bridge]')].filter(node => !split || node.closest('[data-split-pane-id]') === split);
    if (windows.length) return windows.length === 1 && bridges.length === 1 && bridges[0] === marker
      ? { pane: windows[0]!, scope } : null;
    if (split || scope.hasAttribute('data-split-pane-id')) return null;
  }
  return null;
}

/** A notice needs an actual demanded native row, not an invented turn proof. */
export function mountGalleryNotice(sentinel: HTMLElement, ids: readonly string[]) {
  const pane = sentinel.closest<HTMLElement>('[data-thread-window]');
  if (!pane || ids.length > GALLERY_PANE_LIMITS.targets) return null;
  const rows = nativeRows(pane); if (rows.length > GALLERY_PANE_LIMITS.rows) return null;
  const row = ids.map(id => rows.filter(node => node.dataset.timelineRowId === id)).find(found => found.length === 1)?.[0];
  if (!row) return null;
  const id = row.dataset.timelineRowId, parent = row.parentElement, list = row.closest('[data-timeline-row-list]');
  const element = document.createElement('div'); element.dataset.turnResultsNotice = ''; row.append(element);
  return { element, current: () => sentinel.isConnected && element.isConnected && element.parentElement === row
    && row.isConnected && row.dataset.timelineRowId === id && row.parentElement === parent
    && row.closest('[data-thread-window]') === pane && row.closest('[data-timeline-row-list]') === list,
    dispose() { element.remove(); } };
}

export function observeGalleryDemand(sentinel: HTMLElement, changed: (ids: string[], capacity: boolean, reason: 'demand' | 'mutation' | 'visibility', changedRows: readonly string[] | null) => void) {
  const pane = sentinel.closest('[data-thread-window]');
  if (!pane) return () => {};
  const paneToken = domToken(pane)!;
  let active = true, queued = false, prior = '', rows: HTMLElement[] = [];
  let reason: 'demand' | 'mutation' | 'visibility' = 'demand';
  let broad = false;
  const changedRows = new Set<string>();
  const visible = new Set<Element>();
  // Only the last bounded mounted-row snapshot is retained. A removed row has
  // lost closest()/parent information by delivery time; its prior DOM witness
  // is necessary to distinguish windowing from a move, replacement or reuse.
  let rowWitnesses = new Map<Element, { id: string; parent: Element | null; list: Element | null }>();
  let priorIds = new Map<string, Element | null>();
  // One current placement witness, replaced on each existing bounded row scan.
  // It is never history authority and cannot restore a suspended result.
  let placement: { list: Element; items: Element; chain: Element[] } | null = null;
  function placed() {
    if (!placement || !pane!.isConnected || !placement.list.isConnected
      || placement.list.getAttribute('data-timeline-row-list') !== 'top-level'
      || placement.list.closest('[data-thread-window]') !== pane
      || placement.items.parentElement !== placement.list || !placement.items.hasAttribute('data-timeline-items')) return false;
    const items = [...placement.list.children].filter(child => child.hasAttribute('data-timeline-items'));
    return items.length === 1 && items[0] === placement.items
      && placement.chain.every((node, i) => node.parentElement === (placement!.chain[i + 1] ?? pane));
  }
  function publish() {
    queued = false; if (!active || document.hidden) return;
    const focused = document.activeElement?.closest<HTMLElement>('[data-timeline-row-id]');
    const admitted = rows.filter(row => visible.has(row) || row === focused);
    if (focused && admitted.includes(focused)) { admitted.splice(admitted.indexOf(focused), 1); admitted.unshift(focused); }
    const ids = [...new Set(admitted.map(row => row.dataset.timelineRowId!))].slice(0, GALLERY_PANE_LIMITS.targets);
    const capacity = admitted.length > GALLERY_PANE_LIMITS.targets || rows.length > GALLERY_PANE_LIMITS.rows;
    const key = JSON.stringify([ids, capacity]); if (key === prior && reason === 'demand') return;
    prior = key; const cause = reason, affected = broad ? null : [...changedRows];
    reason = 'demand'; broad = false; changedRows.clear(); changed(ids, capacity, cause, affected);
  }
  function schedule() { if (!queued && active && !document.hidden) { queued = true; queueMicrotask(publish); } }
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) if (entry.isIntersecting) visible.add(entry.target); else visible.delete(entry.target);
    schedule();
  });
  function scan(next?: HTMLElement[]) {
    if (!active || document.hidden) return;
    next ??= nativeRows(pane!);
    const retained = new Set(next);
    for (const row of rows) if (!retained.has(row)) { observer.unobserve(row); visible.delete(row); }
    const old = new Set(rows); rows = next;
    rowWitnesses = new Map(); priorIds = new Map();
    placement = null;
    if (rows.length <= GALLERY_PANE_LIMITS.rows) {
      const lists = [...pane!.querySelectorAll('[data-timeline-row-list="top-level"]')]
        .filter(list => list.closest('[data-thread-window]') === pane);
      if (lists.length === 1) {
        const list = lists[0]!, items = [...list.children].filter(child => child.hasAttribute('data-timeline-items'));
        const chain: Element[] = []; let node: Element | null = list;
        while (node && node !== pane && chain.length < 32) { chain.push(node); node = node.parentElement; }
        if (node === pane && items.length === 1) placement = { list, items: items[0]!, chain };
      }
    }
    if (rows.length <= GALLERY_PANE_LIMITS.rows) for (const row of rows) {
      const id = row.dataset.timelineRowId!;
      const witness = { id, parent: row.parentElement, list: row.closest('[data-timeline-row-list]') };
      rowWitnesses.set(row, witness);
      if (!rowOrigins.has(row) && new TextEncoder().encode(id).length <= 1024) rowOrigins.set(row,
        { pane: paneToken, parent: domToken(witness.parent), list: domToken(witness.list), id });
      priorIds.set(id, priorIds.has(id) ? null : row);
    }
    for (const row of rows.slice(0, GALLERY_PANE_LIMITS.rows)) if (!old.has(row)) {
      if (intersects(row, pane!)) visible.add(row); observer.observe(row);
    }
    schedule();
  }
  const mutations = new MutationObserver(delivered => {
    const records = delivered.filter(record => {
      const target = record.target instanceof Element ? record.target : record.target.parentElement;
      return !target?.closest(ownedSurface) && !(record.type === 'childList' && [...record.addedNodes, ...record.removedNodes].every(node => node instanceof Element && node.matches(ownedSurface)));
    });
    if (!records.length) return;
    if (records.length > 64) { broad = true; reason = 'mutation'; scan(); return; }
    let native = false;
    let chrome = false, visited = 0;
    // Prove absence across the entire batch; never decide from a DIV/class or
    // only the mutation target. Unknown/overflow/mixed batches remain broad.
    const structurallyEmpty = (root: Node) => {
      const walker = document.createTreeWalker(root, 0xffffffff);
      let node: Node | null = root;
      do {
        if (++visited > 128 || ![1, 3, 8].includes(node.nodeType)
          || (node.nodeType === 1 && (!(node instanceof Element) || node.matches(nativeStructure)))) return false;
        node = walker.nextNode();
      } while (node);
      return true;
    };
    const outsideChrome = (record: MutationRecord, target: Element) => {
      if (records.length > 64 || !placed() || !placement
        || !['childList', 'characterData'].includes(record.type)
        || target.closest(nativeStructure) !== pane
        || target === pane || target.contains(placement.list) || placement.list.contains(target)
        || target.contains(placement.items) || placement.items.contains(target)) return false;
      return structurallyEmpty(target) && [...record.addedNodes, ...record.removedNodes].every(structurallyEmpty);
    };
    let nextRows: HTMLElement[] | undefined, nextIds: Map<string, Element | null> | undefined;
    let structuralNodes = 0;
    const structuralIds = new Set<string>();
    const wrapperRows = (record: MutationRecord, target: Element): string[] | null => {
      const list = target.parentElement;
      if (record.type !== 'childList' || !target.hasAttribute('data-timeline-items')
        || list?.getAttribute('data-timeline-row-list') !== 'top-level'
        || rowWitnesses.size === 0 || rows.length > GALLERY_PANE_LIMITS.rows) return null;
      const count = record.addedNodes.length + record.removedNodes.length;
      structuralNodes += count;
      if (!count || structuralNodes > GALLERY_PANE_LIMITS.targets * 2) return null;
      if (!nextIds) {
        nextRows = nativeRows(pane!); nextIds = new Map();
        if (nextRows.length > GALLERY_PANE_LIMITS.rows) return null;
        for (const row of nextRows) {
          const id = row.dataset.timelineRowId!;
          nextIds.set(id, nextIds.has(id) ? null : row);
        }
      }
      if (nextRows!.length > GALLERY_PANE_LIMITS.rows) return null;
      const ids: string[] = [];
      for (const [nodes, adding] of [[record.removedNodes, false], [record.addedNodes, true]] as const) for (const node of nodes) {
        if (!(node instanceof Element)) return null;
        const id = node.getAttribute('data-timeline-row-id');
        if (!id || new TextEncoder().encode(id).length > 1024 || structuralIds.has(id)
          || !owners.get(pane as HTMLElement)?.knowsRow(id)
          || node.matches(ownedSurface)
          || node.querySelector('[data-timeline-row-id], [data-timeline-row-list], [data-thread-window]')) return null;
        const priorRow = rowWitnesses.get(node);
        const origin = rowOrigins.get(node);
        if (origin && (origin.pane !== paneToken || origin.parent !== domToken(target) || origin.list !== domToken(list) || origin.id !== id)) return null;
        if (adding) {
          if (priorRow || priorIds.has(id) || !node.isConnected || node.parentElement !== target
            || node.closest('[data-thread-window]') !== pane || node.closest('[data-timeline-row-list]') !== list
            || nextIds.get(id) !== node) return null;
        } else if (!priorRow || priorRow.id !== id || priorRow.parent !== target || priorRow.list !== list
          || priorIds.get(id) !== node || node.isConnected || nextIds.has(id)) return null;
        structuralIds.add(id); ids.push(id);
        if (structuralIds.size > GALLERY_PANE_LIMITS.targets) return null;
      }
      return ids;
    };
    for (const record of records) {
      const target = record.target instanceof Element ? record.target : record.target.parentElement;
      if (!target || target.closest(ownedSurface)) continue;
      // Attribute records retain structural history even when the node was
      // detached or its marker removed later in this same delivery batch.
      // Only these structural attributes are observed; uncertain old scope
      // cannot become negative proof from the node's final, marker-free DOM.
      if (record.type === 'attributes') {
        const scope = target.closest('[data-thread-window]');
        if (scope && scope !== pane
          && !(record.attributeName === 'data-thread-window' && pane!.contains(target))) continue;
        native = true; broad = true; continue;
      }
      if (!target.isConnected) continue;
      if (target.closest('[data-thread-window]') !== pane) {
        continue;
      }
      if (record.type === 'childList' && [...record.addedNodes, ...record.removedNodes].every(node =>
        node instanceof Element && node.matches(ownedSurface))) continue;
      // Native content is a hint, never parsed as status or turn authority.
      const row = target?.closest<HTMLElement>('[data-timeline-row-id]');
      if (row && !visible.has(row) && !row.contains(document.activeElement)) continue;
      if (!row && outsideChrome(record, target)) { chrome = true; continue; }
      native = true;
      // Structural/identity changes may affect neighbouring turn boundaries.
      // Content confined to one real native row does not revoke other rows.
      if (!row && !broad) {
        const ids = wrapperRows(record, target);
        if (ids) for (const id of ids) changedRows.add(id); else broad = true;
        if (changedRows.size > GALLERY_PANE_LIMITS.targets) broad = true;
      }
      else if (!row || !row.dataset.timelineRowId || row.dataset.timelineRowId.length > 1024 || row.closest('[data-thread-window]') !== pane) broad = true;
      else if (!broad) {
        changedRows.add(row.dataset.timelineRowId);
        if (changedRows.size > GALLERY_PANE_LIMITS.targets) { broad = true; changedRows.clear(); }
      }
    }
    if (!native) return;
    if (chrome || records.length > 64) broad = true;
    reason = 'mutation'; scan(nextRows);
  });
  const visibility = () => { if (!document.hidden) { reason = 'visibility'; prior = ''; scan(); } };
  mutations.observe(pane, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['data-timeline-row-id', 'data-timeline-row-list', 'data-timeline-items', 'data-thread-window'] });
  pane.addEventListener('focusin', schedule); pane.addEventListener('focusout', schedule);
  document.addEventListener('visibilitychange', visibility); scan();
  return () => { active = false; placement = null; rows = []; visible.clear(); changedRows.clear(); rowWitnesses.clear(); priorIds.clear(); observer.disconnect(); mutations.disconnect(); pane.removeEventListener('focusin', schedule);
    pane.removeEventListener('focusout', schedule); document.removeEventListener('visibilitychange', visibility); };
}
/** Native owns scrolling/windowing/pins. A finite set of roots is backed by
 * measured, inert owned shells on still-mounted rows. No native styles/hooks.
 * Exact row reuse aborts input authority synchronously before deferred unmount. */
export function mountGalleryPane(sentinel: HTMLElement, threadId: string,
  initialAnchors: readonly GalleryAnchor[], mount: (host: HTMLElement, anchor: GalleryAnchor, current: () => boolean, lifetime: AbortSignal, actionScope: GalleryActionScope) => GalleryRoot,
  initialScopeRows?: readonly ScopeRow[]) {
  let anchors = initialAnchors;
  const scopeMap = (rows: readonly ScopeRow[] | undefined) => {
    if (!rows || rows.length > GALLERY_PANE_LIMITS.rows
      || !rows.every(row => row.id.length <= 1024 && (row.turnId?.length ?? 0) <= 1024)) return null;
    const result = new Map<string, string | null>();
    for (const row of rows) result.set(row.id, result.has(row.id) ? null : row.turnId);
    return result;
  };
  let scopeRows = scopeMap(initialScopeRows);
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
  const roots = new Map<string, { anchor: GalleryAnchor; row: HTMLElement; host: HTMLElement; controller: AbortController; root: GalleryRoot; validity: { current: boolean };
    actionToken: object; actionCapture: { touched(records: readonly MutationRecord[]): boolean } | null }>();
  const shells = new Map<string, { row: HTMLElement; host: HTMLElement; ready: boolean }>();
  const own = () => active && owners.get(pane) === handle && sentinel.isConnected && sentinel.closest('[data-thread-window]') === pane;
  function retire(key: string, keepShell = false) {
    const old = roots.get(key); if (!old) return;
    old.actionToken = {}; old.actionCapture = null;
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
      const actionScope: GalleryActionScope = { capture() {
        const old = roots.get(anchor.turnId);
        if (!old || old.host !== host || document.hidden || !currentPhysical()) return null;
        const boundary = Object.freeze({ ...old.anchor });
        const chain: Element[] = []; let node: Element | null = next;
        while (node && node !== pane && chain.length < 32) { chain.push(node); node = node.parentElement; }
        const list = next.closest('[data-timeline-row-list]');
        if (node !== pane || list?.getAttribute('data-timeline-row-list') !== 'top-level') return null;
        const token = old.actionToken, watched = [host, ...chain, pane!];
        const guard = { touched(records: readonly MutationRecord[]) {
          if (records.length > 64) return true;
          let visited = 0;
          for (const record of records) {
            if (record.type === 'attributes' && watched.includes(record.target as Element)) return true;
            if (record.type !== 'childList') continue;
            for (const nodes of [record.addedNodes, record.removedNodes]) for (const changed of nodes) {
              if (++visited > 128) return true;
              if (watched.some(element => changed === element || changed.contains(element))) return true;
            }
          }
          return false;
        } };
        old.actionCapture = guard;
        return { boundary, release() { if (old.actionCapture === guard) old.actionCapture = null; },
          live: () => currentPhysical() && !document.hidden && roots.get(anchor.turnId) === old
          && old.actionToken === token && old.actionCapture === guard
          && next.closest('[data-timeline-row-list]') === list && list.getAttribute('data-timeline-row-list') === 'top-level'
          && chain.every((element, i) => element.parentElement === (chain[i + 1] ?? pane))
          && sameBoundary(old.anchor, boundary) };
      } };
      function currentPhysical() { return own() && !controller.signal.aborted && host.isConnected && host.parentElement === next
        && next!.isConnected && next!.dataset.timelineRowId === anchor.rowId && next!.closest('[data-thread-window]') === pane; }
      let root: GalleryRoot;
      try { root = mount(host, anchor, current, controller.signal, actionScope); }
      catch { controller.abort(); host.remove(); capacity = true; continue; }
      roots.set(anchor.turnId, { anchor, row: next, host, controller, root, validity, actionToken: {}, actionCapture: null });
      root.visible?.(!document.hidden && (next.contains(document.activeElement) || intersects(next, pane!)));
      observer.observe(next);
    }
  }
  const observer = new IntersectionObserver(() => reconcile());
  const mutations = new MutationObserver(records => {
    // Structural history revokes a capture even after same-task remove/readd.
    // This is local to a captured root; no historical node/ID registry.
    for (const old of roots.values()) if (old.actionCapture?.touched(records)) { old.actionToken = {}; old.actionCapture = null; }
    if (queued || !active || document.hidden || !records.some(record => {
      const target = record.target instanceof Element ? record.target : record.target.parentElement;
      return target?.isConnected && !target.closest(ownedSurface) && !(record.type === 'childList' && [...record.addedNodes, ...record.removedNodes].every(node => node instanceof Element && node.matches(ownedSurface)));
    })) return;
    queued = true; queueMicrotask(reconcile);
  });
  const handle = { get capacity() { return capacity; }, get pendingRoots() { return roots.size + retiring.size > 0; },
    knowsRow(id: string): boolean { const turn = scopeRows?.get(id); return own() && typeof turn === 'string' && turn.length > 0; },
    wake() { predecessorReady = handoff === null || handoff.drained; if (active) reconcile(); }, invalidate(ids?: readonly string[]) {
    // Match sibling public rows through their witnessed turn, never through an
    // opaque ID convention. Missing proof remains conservative.
    const witnessed = scopeRows;
    const affected = ids && (!witnessed || ids.every(id => witnessed.has(id))) ? new Set(ids) : null;
    const turns = new Set(ids?.flatMap(id => witnessed?.get(id) ? [witnessed.get(id)!] : []) ?? []);
    const includes = (anchor: GalleryAnchor) => !affected || affected.has(anchor.rowId) || turns.has(anchor.turnId);
    const invalidated: string[] = [];
    for (const anchor of anchors) if (includes(anchor)) invalid.add(anchor);
    for (const old of roots.values()) if (includes(old.anchor)) {
      invalidated.push(old.anchor.turnId);
      old.validity.current = false; old.root.suspend?.(true);
    }
    return invalidated;
  }, update(next: readonly GalleryAnchor[], checked: readonly string[] = [], nextScopeRows?: readonly ScopeRow[]) {
    if (!active) return; if (!valid(next)) throw Error('Invalid updated pane scope.');
    if (nextScopeRows) scopeRows = scopeMap(nextScopeRows);
    const confirmed = new Set(next.map(anchor => anchor.rowId)), verified = new Set(checked);
    for (const [key, old] of roots) if (verified.has(old.anchor.rowId) && !confirmed.has(old.anchor.rowId)) retire(key, true);
    for (const anchor of next) {
      invalid.delete(anchor);
      const prior = roots.get(anchor.turnId);
      if (prior?.anchor.rowId === anchor.rowId) {
        if (!sameBoundary(prior.anchor, anchor)) { prior.actionToken = {}; prior.actionCapture = null; }
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
  mutations.observe(pane, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-timeline-row-id', 'data-timeline-row-list', 'data-timeline-items', 'data-thread-window'] });
  pane.addEventListener('focusin', reconcile); pane.addEventListener('focusout', reconcile); document.addEventListener('visibilitychange', reconcile);
  reconcile(); return handle;
}
