import type { Anchor } from './anchor.ts';

const panes = new WeakMap<HTMLElement, { dispose: () => void }>();
let nextPane = 0;
export interface MountHandle { dispose(): void }
export interface PaneReceipt {
  paneId: number;
  state: 'attached' | 'detached' | 'waiting' | 'retired';
  rowId: string;
  mountedRows: number;
}
/** Own only an appended child. Native hooks/state/styles remain untouched. */
export function mountProbePane(sentinel: HTMLElement, anchor: Anchor,
  mount: (host: HTMLElement, isCurrent: () => boolean, lifetime: AbortSignal) => MountHandle,
  report: (receipt: PaneReceipt) => void): MountHandle {
  const foundPane = sentinel.closest<HTMLElement>('[data-thread-window]');
  if (!foundPane) throw new Error('Composer has no local native thread window.');
  const pane: HTMLElement = foundPane;
  // Replacement sentinel retires its predecessor; a stale disposer cannot remove its successor.
  panes.get(pane)?.dispose();
  const paneId = ++nextPane;
  let alive = true;
  let queued = false;
  let host: HTMLElement | null = null;
  let row: HTMLElement | null = null;
  let root: MountHandle | null = null;
  let rootLifetime: AbortController | null = null;
  let observer: MutationObserver;
  const ownsPane = () => alive && panes.get(pane) === handle && sentinel.isConnected
    && sentinel.closest('[data-thread-window]') === pane;
  const current = () => ownsPane() && host !== null && row !== null && host.isConnected
    && row.isConnected && host.parentElement === row
    && row.dataset.timelineRowId === anchor.rowId && row.closest('[data-thread-window]') === pane;
  function detach() {
    const oldRoot = root, oldHost = host;
    host = null; row = null; root = null; // fence async work immediately
    rootLifetime?.abort(); // stop resource stages before deferred React cleanup
    rootLifetime = null;
    // Native may be committing a row removal. Do not synchronously unmount another root.
    queueMicrotask(() => { oldRoot?.dispose(); oldHost?.remove(); });
  }
  function reconcile() {
    queued = false;
    if (!ownsPane()) { handle.dispose(); return; }
    const rows = [...pane.querySelectorAll<HTMLElement>('[data-timeline-row-id]')].filter(el =>
      el.closest('[data-thread-window]') === pane
      && el.closest('[data-timeline-row-list]')?.getAttribute('data-timeline-row-list') === 'top-level');
    if (rows.length > 1000) { handle.dispose(); return; }
    const matches = rows.filter(el => el.dataset.timelineRowId === anchor.rowId);
    const next = matches.length === 1 ? matches[0]! : null;
    if (next === row && current()) return;
    if (host) { detach(); report({ paneId, state: 'detached', rowId: anchor.rowId, mountedRows: rows.length }); }
    if (!next) { report({ paneId, state: 'waiting', rowId: anchor.rowId, mountedRows: rows.length }); return; }
    row = next;
    host = document.createElement('div');
    host.dataset.turnResultsProbe = String(paneId);
    host.dataset.sourceThread = anchor.threadId;
    host.dataset.sourceTurn = anchor.turnId;
    host.dataset.sourceRow = anchor.rowId;
    next.append(host);
    const ownedHost = host;
    rootLifetime = new AbortController();
    root = mount(host, () => host === ownedHost && current(), rootLifetime.signal);
    report({ paneId, state: 'attached', rowId: anchor.rowId, mountedRows: rows.length });
  }
  function schedule() {
    if (queued || !alive) return;
    queued = true;
    queueMicrotask(reconcile);
  }
  const handle: MountHandle = { dispose() {
    if (!alive) return;
    alive = false;
    observer?.disconnect();
    if (panes.get(pane) === handle) panes.delete(pane);
    detach();
    report({ paneId, state: 'retired', rowId: anchor.rowId, mountedRows: 0 });
  } };
  panes.set(pane, handle);
  observer = new MutationObserver(records => {
    const external = records.some(record => {
      // Ignore own rendering, but catch native removal of the owned host/row.
      const target = record.target instanceof Element ? record.target : record.target.parentElement;
      return !target?.closest('[data-turn-results-probe]');
    });
    if (external) schedule();
  });
  observer.observe(pane, { childList: true, subtree: true, attributes: true,
    attributeFilter: ['data-timeline-row-id', 'data-timeline-row-list'] });
  reconcile();
  return handle;
}
