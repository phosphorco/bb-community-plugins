import {
  memo, useCallback, useEffect, useId, useLayoutEffect, useRef, useState,
  type ComponentType, type CSSProperties, type KeyboardEvent, type PointerEvent,
} from 'react';
import { createPortal } from 'react-dom';
import type { FloatingGuideProps, GuideContentProps, GuideSelection } from './contract';
import { clampFrame, initialFrame, readViewport, saveFrame, type FrameRect } from './geometry';

interface OpenSession {
  controller: AbortController;
  initialSelection: GuideSelection;
  invoker: HTMLElement | null;
  footerOverflowMenu: Element | null;
}
type LoadState = { status: 'loading' } | { status: 'failed' } |
  { status: 'ready'; component: ComponentType<GuideContentProps> };
interface Gesture {
  kind: 'move' | 'resize'; id: number; element: HTMLElement;
  x: number; y: number; rect: FrameRect;
}
const chromeButton: CSSProperties = {
  border: '1px solid var(--border)', borderRadius: 6, background: 'var(--background)',
  color: 'var(--foreground)', minWidth: 44, minHeight: 44, cursor: 'pointer', flexShrink: 0,
};
const ContentMount = memo(function ContentMount({ component: Content, session, onSelectionChange }: {
  component: ComponentType<GuideContentProps>; session: OpenSession;
  onSelectionChange(selection: GuideSelection): void;
}) {
  return <Content initialSelection={session.initialSelection}
    onSelectionChange={onSelectionChange} sessionSignal={session.controller.signal} />;
});

function isInnerLayer(target: Element, frame: HTMLElement): boolean {
  const layer = target.closest('[data-guide-inner-layer], [role="dialog"], [role="menu"], [role="listbox"]');
  return layer !== null && layer !== frame;
}

/** Mounted by the native overlay slot. Only the host owns a React root. */
export function FloatingGuide({ loadContent, toggleEvent, title, initialSelection }: FloatingGuideProps) {
  const [session, setSession] = useState<OpenSession | null>(null);
  const [load, setLoad] = useState<LoadState>({ status: 'loading' });
  const [geometry, setGeometry] = useState<FrameRect | null>(null);
  const liveSession = useRef<OpenSession | null>(null);
  const retainedSelection = useRef<GuideSelection>(initialSelection ?? { section: 'surfaces', pageId: 'app-shell' });
  const retainedScroll = useRef(0);
  const geometryRef = useRef<FrameRect | null>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const cache = useRef<{ loader: FloatingGuideProps['loadContent']; component: ComponentType<GuideContentProps> } | null>(null);
  const labelId = useId();
  const helpId = useId();

  const finishGesture = useCallback((persist: boolean) => {
    const current = gesture.current;
    gesture.current = null;
    if (current) {
      try {
        if (current.element.hasPointerCapture?.(current.id)) current.element.releasePointerCapture(current.id);
      } catch { /* The browser can already have disposed a captured pointer. */ }
      if (persist && geometryRef.current) saveFrame(geometryRef.current);
    }
  }, []);

  const place = useCallback((rect: FrameRect) => {
    const clamped = clampFrame(rect, readViewport());
    geometryRef.current = clamped;
    setGeometry(clamped);
  }, []);

  const close = useCallback(() => {
    const current = liveSession.current;
    if (!current) return;
    const frame = frameRef.current;
    const active = document.activeElement;
    const ownedFocus = active === document.body || (active instanceof Element && !!frame?.contains(active));
    retainedScroll.current = bodyRef.current?.scrollTop ?? retainedScroll.current;
    liveSession.current = null;
    current.controller.abort();
    finishGesture(false);
    if (geometryRef.current) saveFrame(geometryRef.current);
    setSession(null);
    // Restore only when closing still owns focus. Never steal host composer focus.
    if (ownedFocus && current.invoker?.isConnected) current.invoker.focus({ preventScroll: true });
  }, [finishGesture]);

  const open = useCallback(() => {
    const active = document.activeElement;
    // Native hidden footer actions run from a disappearing menu item. The
    // existing host trigger ID is a documented, narrow DOM dependency.
    const more = document.getElementById('sidebar-footer-more');
    const menu = active instanceof Element ? active.closest('[role="menu"]') : null;
    const footerOverflow = !!menu &&
      more?.getAttribute('aria-expanded') === 'true';
    const current: OpenSession = {
      controller: new AbortController(), initialSelection: retainedSelection.current,
      invoker: footerOverflow ? more : active instanceof HTMLElement ? active : null,
      footerOverflowMenu: footerOverflow ? menu : null,
    };
    liveSession.current = current;
    place(geometryRef.current ?? initialFrame(readViewport()));
    setLoad({ status: 'loading' });
    setSession(current);
  }, [place]);

  useEffect(() => {
    const toggle = () => { if (liveSession.current) close(); else open(); };
    window.addEventListener(toggleEvent, toggle);
    return () => {
      window.removeEventListener(toggleEvent, toggle);
      liveSession.current?.controller.abort();
      liveSession.current = null;
      finishGesture(false);
      cache.current = null;
      // Generation disposal never moves focus into an unrelated/new plugin.
    };
  }, [toggleEvent, close, open, finishGesture]);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    const valid = () => !cancelled && liveSession.current === session && !session.controller.signal.aborted;
    const cached = cache.current;
    if (cached?.loader === loadContent) {
      setLoad({ status: 'ready', component: cached.component });
    } else {
      setLoad({ status: 'loading' });
      void (async () => {
        try {
          const module = await loadContent();
          if (!module?.default) throw new Error('Missing guide content');
          if (!valid()) return;
          cache.current = { loader: loadContent, component: module.default };
          setLoad({ status: 'ready', component: module.default });
        } catch {
          if (valid()) { cache.current = null; setLoad({ status: 'failed' }); }
        }
      })();
    }
    return () => { cancelled = true; };
  }, [session, loadContent]);

  useLayoutEffect(() => {
    if (session) closeRef.current?.focus({ preventScroll: true });
  }, [session]);

  useEffect(() => {
    if (!session?.footerOverflowMenu || !session.invoker) return;
    const menu = session.footerOverflowMenu;
    const trigger = session.invoker;
    let frame: number | undefined;
    const dispose = () => {
      trigger.removeEventListener('focus', returned);
      window.clearTimeout(timeout);
      if (frame !== undefined) window.cancelAnimationFrame(frame);
    };
    const returned = () => {
      if (menu.isConnected) return;
      trigger.removeEventListener('focus', returned);
      // Native focus scopes remain active through the menu's exit animation.
      // Wait for its actual return to More, then let that cleanup finish.
      frame = window.requestAnimationFrame(() => {
        if (liveSession.current !== session || session.controller.signal.aborted) return;
        const active = document.activeElement;
        if (active === document.body || (active === session.invoker &&
            session.invoker?.getAttribute('aria-expanded') !== 'true')) {
          closeRef.current?.focus({ preventScroll: true });
        }
        dispose();
      });
    };
    trigger.addEventListener('focus', returned);
    // Bound the handoff to this opening; later user focus changes stay theirs.
    const timeout = window.setTimeout(dispose, 1000);
    if (document.activeElement === trigger) returned();
    return dispose;
  }, [session]);

  useLayoutEffect(() => {
    if (!session || load.status !== 'ready' || !bodyRef.current) return;
    const viewport = bodyRef.current;
    viewport.scrollTop = Math.max(0, Math.min(retainedScroll.current, viewport.scrollHeight - viewport.clientHeight));
  }, [session, load]);

  useEffect(() => {
    if (!session) return;
    const reclamp = () => { if (geometryRef.current) place(geometryRef.current); };
    const viewport = window.visualViewport;
    window.addEventListener('resize', reclamp);
    viewport?.addEventListener('resize', reclamp);
    viewport?.addEventListener('scroll', reclamp);
    return () => {
      window.removeEventListener('resize', reclamp);
      viewport?.removeEventListener('resize', reclamp);
      viewport?.removeEventListener('scroll', reclamp);
    };
  }, [session, place]);

  const rememberSelection = useCallback((selection: GuideSelection) => {
    if (session && liveSession.current === session && !session.controller.signal.aborted &&
      selection.section === 'surfaces' && selection.pageId.length > 0 && selection.pageId.length <= 128) {
      if (selection.pageId !== retainedSelection.current.pageId) retainedScroll.current = 0;
      retainedSelection.current = selection;
    }
  }, [session]);

  const retry = () => {
    if (!session || liveSession.current !== session) return;
    session.controller.abort();
    finishGesture(false);
    const next = { ...session, controller: new AbortController(), initialSelection: retainedSelection.current };
    liveSession.current = next;
    setLoad({ status: 'loading' });
    setSession(next);
  };

  const startGesture = (event: PointerEvent<HTMLElement>, kind: Gesture['kind']) => {
    if (event.button !== 0 || event.isPrimary === false || !geometryRef.current || !liveSession.current || gesture.current) return;
    event.preventDefault();
    event.stopPropagation();
    try { event.currentTarget.setPointerCapture(event.pointerId); }
    catch { return; }
    gesture.current = {
      kind, id: event.pointerId, element: event.currentTarget,
      x: event.clientX, y: event.clientY, rect: geometryRef.current,
    };
  };
  const moveGesture = (event: PointerEvent<HTMLElement>) => {
    const current = gesture.current;
    if (!current || current.id !== event.pointerId || !liveSession.current) return;
    const dx = event.clientX - current.x, dy = event.clientY - current.y;
    place(current.kind === 'move'
      ? { ...current.rect, x: current.rect.x + dx, y: current.rect.y + dy }
      : { ...current.rect, width: current.rect.width + dx, height: current.rect.height + dy });
  };
  const endGesture = (event: PointerEvent<HTMLElement>) => {
    if (gesture.current?.id === event.pointerId) finishGesture(event.type === 'pointerup');
  };
  const keyboardGeometry = (event: KeyboardEvent<HTMLButtonElement>, kind: Gesture['kind']) => {
    const rect = geometryRef.current;
    if (!rect || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const step = event.shiftKey ? 8 : 32;
    const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
    const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;
    const next = kind === 'move' ? { ...rect, x: rect.x + dx, y: rect.y + dy }
      : { ...rect, width: rect.width + dx, height: rect.height + dy };
    place(next);
    if (geometryRef.current) saveFrame(geometryRef.current);
  };

  if (!session || !geometry) return null;
  return createPortal(
    <div ref={frameRef} role="dialog" aria-modal="false" aria-labelledby={labelId}
      data-guide-frame="" data-bb-plugin-root="" data-bb-plugin="plugin-guide-for-nerds"
      className="nerd-guide-frame" tabIndex={-1}
      onKeyDown={event => {
        const target = event.target;
        if (event.key !== 'Escape' || event.defaultPrevented || !(target instanceof Element) ||
          !event.currentTarget.contains(target) || isInnerLayer(target, event.currentTarget)) return;
        event.preventDefault(); event.stopPropagation(); close();
      }}
      style={{ position: 'fixed', left: geometry.x, top: geometry.y, width: geometry.width, height: geometry.height,
        zIndex: 40, display: 'grid', gridTemplateRows: 'auto minmax(0, 1fr)', boxSizing: 'border-box',
        overflow: 'hidden', border: '1px solid var(--border)', borderRadius: 10,
        background: 'var(--background)', color: 'var(--foreground)', boxShadow: '0 12px 32px rgb(0 0 0 / 0.18)' }}>
      <div className="nerd-guide-header" data-guide-drag-header=""
        onPointerDown={event => {
          if (event.target instanceof Element && event.target.closest('button,a,input,select,textarea,[contenteditable]')) return;
          startGesture(event, 'move');
        }}
        onPointerMove={moveGesture} onPointerUp={endGesture} onPointerCancel={endGesture}
        onLostPointerCapture={endGesture}
        style={{ display: 'flex', gap: 6, alignItems: 'center', padding: '4px 8px',
          borderBottom: '1px solid var(--border)', touchAction: 'none', cursor: 'move', userSelect: 'none', minWidth: 0 }}>
        <span id={labelId} style={{ flex: 1, minWidth: 0, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</span>
        <button type="button" aria-label="Move guide" aria-describedby={helpId} title="Drag to move, or use arrow keys"
          className="nerd-guide-chrome-button" style={{ ...chromeButton, touchAction: 'none', cursor: 'move' }}
          onPointerDown={event => startGesture(event, 'move')} onPointerMove={moveGesture}
          onPointerUp={endGesture} onPointerCancel={endGesture} onLostPointerCapture={endGesture}
          onKeyDown={event => keyboardGeometry(event, 'move')}><span aria-hidden="true">↔</span></button>
        <button ref={closeRef} type="button" aria-label="Close guide" title="Close guide"
          className="nerd-guide-chrome-button" style={chromeButton} onClick={close}><span aria-hidden="true">×</span></button>
      </div>
      <div ref={bodyRef} data-guide-stage-viewport="" className="nerd-guide-scroll"
        style={{ minHeight: 0, minWidth: 0, overflow: 'auto', overscrollBehavior: 'contain', scrollBehavior: 'auto', containerType: 'size', padding: '8px 8px 44px' }}>
        <span id={helpId} style={{ position: 'absolute', width: 1, height: 1, padding: 0, margin: -1,
          overflow: 'hidden', clipPath: 'inset(50%)', whiteSpace: 'nowrap' }}>
          Drag the move or resize control, or focus it and use arrow keys. Hold Shift for smaller steps.
        </span>
        {load.status === 'loading' ? <p role="status">Loading guide…</p> : load.status === 'failed'
          ? <div role="alert"><p>The guide couldn’t load.</p><button type="button" className="nerd-guide-chrome-button" style={chromeButton} onClick={retry}>Retry</button></div>
          : <ContentMount component={load.component} session={session} onSelectionChange={rememberSelection} />}
      </div>
      <button type="button" aria-label="Resize guide" aria-describedby={helpId} title="Drag to resize, or use arrow keys"
        className="nerd-guide-chrome-button nerd-guide-resize" data-guide-resize=""
        style={{ ...chromeButton, position: 'absolute', right: 2, bottom: 2, touchAction: 'none', cursor: 'nwse-resize' }}
        onPointerDown={event => startGesture(event, 'resize')} onPointerMove={moveGesture}
        onPointerUp={endGesture} onPointerCancel={endGesture} onLostPointerCapture={endGesture}
        onKeyDown={event => keyboardGeometry(event, 'resize')}><span aria-hidden="true">↘</span></button>
    </div>, document.body,
  );
}
