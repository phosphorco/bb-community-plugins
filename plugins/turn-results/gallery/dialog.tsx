import { useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { BbNavigate, useSdk } from '@get-bb/plugin-sdk/app';
import type { GalleryObservation } from './index.ts';
import type { GalleryRuntime, GalleryPresentationRoot } from './runtime.ts';
import { ResultCard } from './view.tsx';
import { Store } from '@tanstack/store';
import { useSelector } from '@tanstack/react-store';
import { canonicalJson } from '@phosphorco/bb-turn-results';

export interface GalleryDialogInput {
  row: GalleryObservation; sdk: ReturnType<typeof useSdk>; navigate: BbNavigate;
  siteKey: string; retireDock(): void; opener: HTMLElement | null; openerCurrent(): boolean;
}
interface Surface {
  input: GalleryDialogInput; element: HTMLDialogElement; root: ReturnType<typeof createRoot>;
  scope: GalleryPresentationRoot; controller: AbortController; current: boolean;
  store: Store<{ row: GalleryObservation; verified: boolean }>;
  retirement: Promise<void> | null;
}
/** Imported only for a real expansion request. One controller/window; no import
 * effects, supplier portal, timer, polling or independent allocator. */
export function createGalleryDialog(runtime: GalleryRuntime) {
  let surface: Surface | null = null, pending: GalleryDialogInput | null = null;
  let disposed = false, working = false, drain: Promise<void> | null = null, resolve: (() => void) | null = null;
  function retire(value: Surface): Promise<void> {
    if (value.retirement) return value.retirement;
    value.current = false;
    const finish = value.scope.beginDisposal();
    value.controller.abort();
    value.retirement = new Promise<void>(done => queueMicrotask(() => {
      try { value.root.unmount(); finish(); }
      catch { return; } // Actual disposal failure retains its reservation/drain.
      void value.scope.whenDrained().then(() => {
        value.element.remove(); runtime.dialogRetired(value.input.siteKey); done();
      });
    }));
    return value.retirement;
  }
  function mount(input: GalleryDialogInput) {
    const element = document.createElement('dialog'); element.className = 'tr-dialog';
    element.dataset.turnResultsDialog = '';
    element.setAttribute('aria-label', 'Expanded result'); element.setAttribute('aria-modal', 'true');
    document.body.append(element);
    const controller = new AbortController(), root = createRoot(element);
    const value: Surface = { input, element, root, controller, current: true, retirement: null,
      store: new Store({ row: input.row, verified: true }),
      scope: runtime.presentationRoot(controller.signal, () => value.current && runtime.isActive()) };
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); close(); return; }
      if (event.key !== 'Tab') return;
      const controls = [...element.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]')];
      const first = controls[0], last = controls.at(-1);
      if (!first || !last) { event.preventDefault(); element.focus(); }
      else if (event.shiftKey && (document.activeElement === first || !element.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !element.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    };
    element.addEventListener('keydown', keydown);
    element.addEventListener('cancel', event => { event.preventDefault(); close(); });
    element.addEventListener('close', () => close());
    root.render(<ExpandedResult surface={value} runtime={runtime} close={close} />);
    try { if (typeof element.showModal === 'function') element.showModal(); else element.open = true; }
    catch { element.open = true; }
    element.setAttribute('role', 'dialog');
    runtime.dialogMounted(input.siteKey); return value;
  }
  async function advance() {
    if (working) return;
    working = true;
    if (surface) {
      const old = surface; await retire(old); if (surface === old) surface = null;
      if (!pending && !disposed && runtime.isActive() && old.input.opener?.isConnected && old.input.openerCurrent()) old.input.opener.focus();
    }
    const next = pending;
    if (next) {
      // Only admission depends on the opener. An already accepted full view
      // keeps its independent saved-result lifetime after virtualization.
      const admitted = !disposed && runtime.isActive() && next.openerCurrent();
      if (pending === next) {
        pending = null;
        if (admitted) surface = mount(next);
        else if (runtime.dialogSites.state.pending === next.siteKey) runtime.dialogCancelled();
      }
    }
    working = false;
    if (pending || disposed && surface) void advance();
    else if (!surface && resolve) { const done = resolve; resolve = null; done(); }
  }
  function close() { pending = null; runtime.dialogCancelled(); if (surface) void retire(surface); void advance(); }
  return {
    observe(rows: readonly GalleryObservation[]) {
      if (!surface?.current) return;
      const previous = surface.store.state.row;
      const next = rows.find(row => row.key === previous.key && row.owner === previous.owner && canonicalJson(row.identity) === canonicalJson(previous.identity));
      if (next && canonicalJson(next) !== canonicalJson(previous)) surface.store.setState(() => ({ row: next, verified: true }));
    },
    open(input: GalleryDialogInput) {
      if (disposed || !runtime.isActive()) return;
      pending = input; if (surface) void retire(surface); void advance();
    },
    dispose(): Promise<void> {
      disposed = true; pending = null; runtime.dialogCancelled();
      if (!surface && !working) return Promise.resolve();
      if (!drain) drain = new Promise<void>(done => { resolve = done; });
      if (surface) void retire(surface); void advance(); return drain;
    },
  };
}
export type GalleryDialogController = ReturnType<typeof createGalleryDialog>;

function ExpandedResult({ surface, runtime, close }: { surface: Surface; runtime: GalleryRuntime; close(): void }) {
  const { row, verified } = useSelector(surface.store);
  const [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const closeButton = useRef<HTMLButtonElement>(null), read = useRef<AbortController | null>(null);
  useLayoutEffect(() => {
    closeButton.current?.focus();
    return () => { read.current?.abort(); };
  }, []);
  const refresh = async () => {
    if (!surface.current || !runtime.isActive() || read.current) return;
    const controller = new AbortController(); read.current = controller;
    const stop = () => controller.abort(); surface.controller.signal.addEventListener('abort', stop, { once: true });
    const revision = canonicalJson(row.resolution?.revision ?? null);
    surface.store.setState(previous => ({ ...previous, verified: false })); setBusy(true);
    const timer = setTimeout(() => controller.abort('deadline'), 5000);
    try {
      const next = await runtime.refreshDialogRow(row, controller.signal);
      if (!surface.current || controller.signal.aborted || canonicalJson(surface.store.state.row.resolution?.revision ?? null) !== revision) return;
      surface.store.setState(() => ({ row: next, verified: true })); setError(null);
    } catch {
      if (surface.current) setError('Saved result could not be refreshed. Previously saved details remain available.');
    } finally {
      clearTimeout(timer); surface.controller.signal.removeEventListener('abort', stop);
      if (read.current === controller) read.current = null;
      if (surface.current) setBusy(false);
    }
  };
  return <div className="tr-dialog-content">
    <header><h2>Expanded result</h2><button ref={closeButton} onClick={close}>Close expanded result</button></header>
    <div className="tr-dialog-card"><ResultCard row={row} runtime={runtime} sdk={surface.input.sdk} navigate={surface.input.navigate}
      current={() => surface.current && runtime.isActive()
        && canonicalJson(surface.store.state.row.resolution?.revision ?? null) === canonicalJson(row.resolution?.revision ?? null)} lifetime={surface.controller.signal}
      presentationRoot={surface.scope} mode="full" customEnabled={verified} /></div>
    <footer><button disabled={busy} onClick={() => void refresh()}>Refresh saved result</button>
      {!verified && <span role="status">Showing previously saved details while this result needs checking.</span>}
      {error && <span role="status">{error}</span>}</footer>
  </div>;
}
