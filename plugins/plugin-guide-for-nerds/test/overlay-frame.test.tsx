// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createContext, StrictMode, useContext, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { renderSlot } from '@get-bb/plugin-sdk/testing/app';
import { useBbContext, useBbNavigate, useSdk } from '@get-bb/plugin-sdk/app';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { FloatingGuide } from '../src/floating';
import type { GuideContentModule, GuideContentProps, FloatingGuideProps } from '../src/floating/contract';
import { clampFrame, GEOMETRY_KEY, initialFrame } from '../src/floating/geometry';
const toggleEvent = 'plugin-guide-for-nerds:toggle', title = 'BB Plugin Guide for Nerds';
const props = (loadContent: FloatingGuideProps['loadContent']): FloatingGuideProps => ({ loadContent, toggleEvent, title });
function deferred<T>() { let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function toggle() { act(() => { window.dispatchEvent(new Event(toggleEvent)); }); }
function Content({ initialSelection, onSelectionChange }: GuideContentProps) {
  const [page, setPage] = useState(initialSelection.pageId);
  return <div><output data-testid="page">{page}</output><button onClick={() => { setPage('sidebar'); onSelectionChange({ section: 'surfaces', pageId: 'sidebar' }); }}>Select sidebar</button></div>;
}
const ready = () => Promise.resolve({ default: Content });
function host() { const footer = document.createElement('button'); footer.textContent = 'Footer guide'; document.body.append(footer);
  const composer = document.createElement('textarea'); composer.value = 'underlying draft'; document.body.append(composer); footer.focus(); return { footer, composer }; }
const frame = () => screen.getByRole('dialog', { name: title });
const body = () => document.querySelector<HTMLElement>('[data-guide-stage-viewport]')!;
function rect() { const node = frame(); return { x: parseFloat(node.style.left), y: parseFloat(node.style.top), width: parseFloat(node.style.width), height: parseFloat(node.style.height) }; }
let capture: Mock<(this: HTMLElement, id: number) => void>, release: Mock<(this: HTMLElement, id: number) => void>;
// jsdom lacks pointer capture: only the fixture supplies these methods.
for (const method of ['setPointerCapture', 'releasePointerCapture', 'hasPointerCapture']) {
  if (!(method in HTMLElement.prototype)) Object.defineProperty(HTMLElement.prototype, method, { configurable: true, writable: true, value: () => false });
}
beforeEach(() => {
  window.localStorage.clear(); vi.stubGlobal('innerWidth', 1200); vi.stubGlobal('innerHeight', 900); vi.stubGlobal('visualViewport', undefined);
  class FixturePointerEvent extends MouseEvent {
    pointerId: number; isPrimary: boolean;
    constructor(type: string, options: PointerEventInit = {}) { super(type, options); this.pointerId = options.pointerId ?? 1; this.isPrimary = options.isPrimary ?? true; }
  }
  vi.stubGlobal('PointerEvent', FixturePointerEvent);
  const captured = new WeakMap<HTMLElement, number>();
  capture = vi.fn(function(this: HTMLElement, id: number) { captured.set(this, id); });
  release = vi.fn(function(this: HTMLElement, id: number) { if (captured.get(this) === id) captured.delete(this); });
  vi.spyOn(HTMLElement.prototype, 'setPointerCapture').mockImplementation(capture);
  vi.spyOn(HTMLElement.prototype, 'releasePointerCapture').mockImplementation(release);
  vi.spyOn(HTMLElement.prototype, 'hasPointerCapture').mockImplementation(function(this: HTMLElement, id) { return captured.get(this) === id; });
});
afterEach(() => { cleanup(); document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('injected-content lifetime', () => {
  it('keeps closed startup empty and mounts one scoped nonmodal portal; open-only listeners dispose', async () => {
    const loader = vi.fn(ready), add = vi.spyOn(window, 'addEventListener'), remove = vi.spyOn(window, 'removeEventListener');
    const view = render(<FloatingGuide {...props(loader)} />);
    expect(loader).not.toHaveBeenCalled(); expect(document.querySelector('[data-guide-frame]')).toBeNull(); expect(add.mock.calls.filter(([name]) => name === 'resize')).toHaveLength(0);
    toggle(); await screen.findByTestId('page'); expect(loader).toHaveBeenCalledTimes(1);
    expect(frame().getAttribute('aria-modal')).toBe('false'); expect(frame().getAttribute('data-bb-plugin')).toBe('plugin-guide-for-nerds'); expect(frame().hasAttribute('data-bb-plugin-root')).toBe(true); expect(view.container.contains(frame())).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Close guide' })); expect(document.querySelector('[data-guide-frame]')).toBeNull(); expect(remove.mock.calls.filter(([name]) => name === 'resize')).toHaveLength(1);
    view.unmount(); expect(remove.mock.calls.some(([name]) => name === toggleEvent)).toBe(true);
  });
  it('close cancels pending success without late mount or stealing composer focus', async () => {
    const pending = deferred<GuideContentModule>(), mounted = vi.fn(), { composer } = host();
    function Late() { useEffect(() => { mounted(); }, []); return <span>Late guide</span>; }
    render(<FloatingGuide {...props(() => pending.promise)} />); toggle(); expect(screen.getByRole('status').textContent).toContain('Loading'); composer.focus(); toggle();
    await act(async () => { pending.resolve({ default: Late }); await pending.promise; }); expect(mounted).not.toHaveBeenCalled(); expect(document.activeElement).toBe(composer); expect(screen.queryByText('Late guide')).toBeNull();
  });
  it.each(['reject','resolve'])('ignores superseded %s while only the new open controls loading', async kind => {
    const old = deferred<GuideContentModule>(), next = deferred<GuideContentModule>(); const loader = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    render(<FloatingGuide {...props(loader)} />); toggle(); toggle(); toggle();
    await act(async () => { if (kind === 'reject') old.reject(Error('obsolete')); else old.resolve({ default: Content }); await old.promise.catch(() => {}); });
    expect(screen.getByRole('status')).toBeDefined(); expect(screen.queryByRole('alert')).toBeNull(); expect(screen.queryByTestId('page')).toBeNull();
    await act(async () => { next.resolve({ default: Content }); await next.promise; }); expect(screen.getByTestId('page').textContent).toBe('app-shell');
  });
  it('supports async/sync failure, retry, and bounded successful module reuse', async () => {
    const loader = vi.fn().mockRejectedValueOnce(Error('chunk')).mockImplementationOnce(() => { throw Error('sync'); }).mockImplementation(ready);
    render(<FloatingGuide {...props(loader)} />); toggle(); await screen.findByRole('alert'); fireEvent.click(screen.getByRole('button', { name: 'Retry' })); await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' })); await screen.findByTestId('page'); toggle(); toggle(); await screen.findByTestId('page'); expect(loader).toHaveBeenCalledTimes(3);
  });
  it('generation unmount invalidates pending import and aborts mounted content', async () => {
    const pending = deferred<GuideContentModule>(), mounted = vi.fn(); const view = render(<FloatingGuide {...props(() => pending.promise)} />); toggle(); view.unmount();
    function Late() { useEffect(() => { mounted(); }, []); return <span>late</span>; }
    await act(async () => { pending.resolve({ default: Late }); await pending.promise; }); expect(mounted).not.toHaveBeenCalled(); expect(document.querySelector('[data-guide-frame]')).toBeNull();
    let signal: AbortSignal | undefined, disposed = 0;
    function Session(p: GuideContentProps) { signal = p.sessionSignal; useEffect(() => () => { disposed++; }, []); return <span>session</span>; }
    const next = render(<FloatingGuide {...props(() => Promise.resolve({ default: Session }))} />); toggle(); await screen.findByText('session'); next.unmount(); expect(signal!.aborted).toBe(true); expect(disposed).toBe(1);
  });
  it('aborts before content cleanup; retains selection locally with underlying route and draft intact', async () => {
    const aborted: boolean[] = []; function Session(p: GuideContentProps) { useEffect(() => () => { aborted.push(p.sessionSignal.aborted); }, [p.sessionSignal]); return <Content {...p} />; }
    const { composer } = host(), pathname = location.pathname; render(<FloatingGuide {...props(() => Promise.resolve({ default: Session }))} />); toggle(); await screen.findByTestId('page');
    fireEvent.click(screen.getByRole('button', { name: 'Select sidebar' })); toggle(); expect(aborted).toEqual([true]); toggle(); await screen.findByTestId('page'); expect(screen.getByTestId('page').textContent).toBe('sidebar'); expect(composer.value).toBe('underlying draft'); expect(location.pathname).toBe(pathname);
  });
  it('StrictMode does not duplicate the toggle listener or load hidden content', async () => {
    const loader = vi.fn(ready); render(<StrictMode><FloatingGuide {...props(loader)} /></StrictMode>); toggle(); await screen.findByTestId('page'); expect(screen.getAllByRole('dialog', { name: title })).toHaveLength(1); expect(loader).toHaveBeenCalledTimes(1); toggle(); expect(screen.queryByRole('dialog', { name: title })).toBeNull();
  });
});

describe('focus, nested Escape, and scroll ownership', () => {
  it('hands focus back after native overflow teardown and returns to its connected More trigger', async () => {
    const callbacks = new Map<number, FrameRequestCallback>(); let serial = 0;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callbacks.set(++serial, callback); return serial; });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => callbacks.delete(id));
    const more = document.createElement('button'); more.id = 'sidebar-footer-more'; more.setAttribute('aria-expanded','true');
    const menu = document.createElement('div'); menu.setAttribute('role','menu');
    const item = document.createElement('button'); menu.append(item); document.body.append(more,menu); item.focus();
    render(<FloatingGuide {...props(ready)} />); toggle(); await screen.findByTestId('page');
    menu.remove(); more.setAttribute('aria-expanded','false'); more.focus();
    act(() => { const first=[...callbacks.values()]; callbacks.clear(); first.forEach(fn=>fn(0)); });
    expect(document.activeElement).toBe(screen.getByRole('button',{name:'Close guide'}));
    fireEvent.keyDown(document.activeElement!,{key:'Escape'});
    expect(document.activeElement).toBe(more); expect(screen.queryByRole('dialog',{name:title})).toBeNull();
  });
  it('focuses close immediately during loading and returns connected invoker on scoped Escape', () => {
    const { footer } = host(); render(<FloatingGuide {...props(() => new Promise(() => {}))} />); toggle(); expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close guide' })); fireEvent.keyDown(frame(), { key: 'Escape' }); expect(document.activeElement).toBe(footer);
  });
  it('late load/close do not steal composer focus', async () => {
    const { composer } = host(), pending = deferred<GuideContentModule>(); render(<FloatingGuide {...props(() => pending.promise)} />); toggle(); composer.focus(); await act(async () => { pending.resolve({ default: Content }); await pending.promise; }); expect(document.activeElement).toBe(composer); toggle(); expect(document.activeElement).toBe(composer);
  });
  it('does not restore removed invoker or move focus on generation disposal', async () => {
    const { footer, composer } = host(); const view = render(<FloatingGuide {...props(ready)} />); toggle(); await screen.findByTestId('page'); footer.remove(); fireEvent.keyDown(frame(), { key: 'Escape' }); expect(document.activeElement).not.toBe(footer);
    composer.focus(); toggle(); await screen.findByTestId('page'); composer.focus(); view.unmount(); expect(document.activeElement).toBe(composer);
  });
  it('respects inner menu/card/defaultPrevented Escape and portaled layers; ignores composer Escape', async () => {
    let dismissCard = 0, dismissMenu = 0;
    function Nested() { const [menu, setMenu] = useState(true), [card, setCard] = useState(true);
      return <div onKeyDown={e => { if (e.key === 'Escape' && card) { e.preventDefault(); e.stopPropagation(); setCard(false); dismissCard++; } }}><button>Map target</button><div role="dialog" aria-label="Inner card"><button>Card target</button></div>{menu && createPortal(<div role="menu" data-guide-inner-layer="" onKeyDown={e => { e.preventDefault(); e.stopPropagation(); setMenu(false); dismissMenu++; }}><button>Menu target</button></div>, document.body)}</div>;
    }
    const { composer } = host(); render(<FloatingGuide {...props(() => Promise.resolve({ default: Nested }))} />); toggle(); await screen.findByText('Map target');
    fireEvent.keyDown(screen.getByText('Menu target'), { key: 'Escape' }); expect(dismissMenu).toBe(1); expect(dismissCard).toBe(0); expect(frame()).toBeDefined();
    fireEvent.keyDown(screen.getByText('Map target'), { key: 'Escape' }); expect(dismissCard).toBe(1); expect(frame()).toBeDefined(); fireEvent.keyDown(screen.getByText('Card target'), { key: 'Escape' }); expect(frame()).toBeDefined(); fireEvent.keyDown(composer, { key: 'Escape' }); expect(frame()).toBeDefined(); fireEvent.keyDown(screen.getByText('Map target'), { key: 'Escape' }); expect(screen.queryByRole('dialog', { name: title })).toBeNull();
  });
  it('respects defaultPrevented even when a child still bubbles, and skips inner layers without handlers', async () => {
    function Layer() { return <div><button onKeyDown={e => e.preventDefault()}>Consumed target</button><div data-guide-inner-layer=""><button>Layer target</button></div></div>; }
    render(<FloatingGuide {...props(() => Promise.resolve({ default: Layer }))} />); toggle(); await screen.findByText('Consumed target');
    fireEvent.keyDown(screen.getByText('Consumed target'), { key: 'Escape' }); expect(frame()).toBeDefined();
    fireEvent.keyDown(screen.getByText('Layer target'), { key: 'Escape' }); expect(frame()).toBeDefined();
  });
  it('portal keeps parent context and geometry updates do not rerender content', async () => {
    const Context = createContext('missing'), renders = vi.fn(); function Injected() { renders(); return <span>{useContext(Context)}</span>; }
    render(<Context.Provider value="retained host context"><FloatingGuide {...props(() => Promise.resolve({ default: Injected }))} /></Context.Provider>); toggle(); await screen.findByText('retained host context'); const before = renders.mock.calls.length;
    fireEvent.keyDown(screen.getByRole('button', { name: 'Move guide' }), { key: 'ArrowLeft' }); fireEvent.keyDown(screen.getByRole('button', { name: 'Resize guide' }), { key: 'ArrowDown' }); expect(renders).toHaveBeenCalledTimes(before);
  });
  it('injected public SDK hooks keep mock slot context without navigation calls', async () => {
    function HookContent() { const context = useBbContext(), sdk = useSdk(), nav = useBbNavigate(); return <span>{context.threadId}/{typeof sdk.threads.get}/{typeof nav.toPluginPanel}</span>; }
    const view = renderSlot({ component: FloatingGuide }, props(() => Promise.resolve({ default: HookContent })), { context: { threadId: 't' } }); toggle(); await screen.findByText('t/function/function'); expect(view.inspection.navigateCalls).toEqual([]); view.lifecycle.unmount();
  });
  it('has one independently scrolling size-container; restores bounded scroll without host overflow mutations', async () => {
    document.body.style.overflow = 'auto'; document.documentElement.style.overflow = 'visible'; render(<FloatingGuide {...props(ready)} />); toggle(); await screen.findByTestId('page');
    expect(document.querySelectorAll('[data-guide-stage-viewport]')).toHaveLength(1); expect(body().style.overflow).toBe('auto'); expect(body().style.containerType).toBe('size'); expect(body().style.overscrollBehavior).toBe('contain');
    body().scrollTop = 900; toggle(); vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockReturnValue(700); vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(500); toggle(); await screen.findByTestId('page'); expect(body().scrollTop).toBe(200); expect(document.body.style.overflow).toBe('auto'); expect(document.documentElement.style.overflow).toBe('visible'); expect(window.scrollY).toBe(0); document.body.style.overflow = ''; document.documentElement.style.overflow = '';
  });
});

describe('viewport geometry and capture disposal', () => {
  it('constrains dimensions before position for narrow, offset, and tiny viewports', () => {
    for (const viewport of [{ x: 0, y: 0, width: 320, height: 568 }, { x: 10, y: 200, width: 320, height: 220 }, { x: 0, y: 0, width: 12, height: 12 }]) {
      const r = clampFrame({ x: 5000, y: -500, width: 960, height: 720 }, viewport); expect(r.x).toBeGreaterThanOrEqual(viewport.x); expect(r.y).toBeGreaterThanOrEqual(viewport.y); expect(r.x + r.width).toBeLessThanOrEqual(viewport.x + viewport.width); expect(r.y + r.height).toBeLessThanOrEqual(viewport.y + viewport.height);
    }
  });
  it('reclamps on visualViewport scroll/resize and removes open-only listeners', async () => {
    const viewport = new EventTarget() as EventTarget & { width: number; height: number; offsetLeft: number; offsetTop: number }; Object.assign(viewport, { width: 1200, height: 900, offsetLeft: 0, offsetTop: 0 }); vi.stubGlobal('visualViewport', viewport); const remove = vi.spyOn(viewport, 'removeEventListener');
    render(<FloatingGuide {...props(ready)} />); toggle(); await screen.findByTestId('page'); Object.assign(viewport, { width: 320, height: 220, offsetLeft: 20, offsetTop: 200 }); act(() => viewport.dispatchEvent(new Event('resize'))); expect(rect()).toEqual({ x: 28, y: 208, width: 304, height: 204 }); viewport.offsetTop = 300; act(() => viewport.dispatchEvent(new Event('scroll'))); expect(rect().y).toBe(308); toggle(); expect(remove.mock.calls.map(([name]) => name).sort()).toEqual(['resize', 'scroll']);
  });
  it('moves and resizes via captured primary desktop/touch pointers and ignores other pointers/buttons', async () => {
    render(<FloatingGuide {...props(ready)} />); toggle(); await screen.findByTestId('page'); const header = document.querySelector('[data-guide-drag-header]')!, before = rect();
    fireEvent.pointerDown(header, { pointerId: 1, button: 2, clientX: 100, clientY: 100 }); expect(capture).not.toHaveBeenCalled(); fireEvent.pointerDown(header, { pointerId: 1, button: 0, isPrimary: false, clientX: 100, clientY: 100 }); expect(capture).not.toHaveBeenCalled();
    fireEvent.pointerDown(header, { pointerId: 2, button: 0, pointerType: 'touch', clientX: 100, clientY: 100 }); fireEvent.pointerMove(header, { pointerId: 3, clientX: 0, clientY: 0 }); fireEvent.lostPointerCapture(header, { pointerId: 3 }); fireEvent.pointerDown(header, { pointerId: 3, button: 0 }); expect(capture).toHaveBeenCalledTimes(1); expect(rect()).toEqual(before); fireEvent.pointerMove(header, { pointerId: 2, clientX: 40, clientY: 50 }); expect(rect().x).toBe(before.x - 60); expect(rect().y).toBe(before.y - 50); fireEvent.pointerUp(header, { pointerId: 2 }); expect(release).toHaveBeenCalledWith(2);
    const resize = screen.getByRole('button', { name: 'Resize guide' }), old = rect(); fireEvent.pointerDown(resize, { pointerId: 4, button: 0, clientX: 100, clientY: 100 }); fireEvent.pointerMove(resize, { pointerId: 4, clientX: 60, clientY: 40 }); expect(rect().width).toBe(old.width - 40); expect(rect().height).toBe(old.height - 60); fireEvent.pointerUp(resize, { pointerId: 4 }); expect(release).toHaveBeenCalledWith(4);
  });
  it.each(['cancel', 'lost', 'close', 'unmount'])('releases capture on %s and rejects disposed moves', async reason => {
    const view = render(<FloatingGuide {...props(ready)} />); toggle(); await screen.findByTestId('page'); const handle = screen.getByRole('button', { name: 'Move guide' }); fireEvent.pointerDown(handle, { pointerId: 9, button: 0 });
    if (reason === 'cancel') fireEvent.pointerCancel(handle, { pointerId: 9 }); else if (reason === 'lost') fireEvent.lostPointerCapture(handle, { pointerId: 9 }); else if (reason === 'close') toggle(); else view.unmount(); expect(release).toHaveBeenCalledWith(9); if (reason === 'cancel' || reason === 'lost') { const old = rect(); fireEvent.pointerMove(handle, { pointerId: 9, clientX: 100 }); expect(rect()).toEqual(old); }
  });
  it('does not drag buttons; permits keyboard geometry and denied storage', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw Error('denied'); }); vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw Error('denied'); }); render(<FloatingGuide {...props(ready)} />); toggle(); await screen.findByTestId('page');
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Close guide' }), { pointerId: 1, button: 0 }); expect(capture).not.toHaveBeenCalled(); const old = rect(); fireEvent.keyDown(screen.getByRole('button', { name: 'Move guide' }), { key: 'ArrowLeft', shiftKey: true }); expect(rect().x).toBe(old.x - 8); fireEvent.keyDown(screen.getByRole('button', { name: 'Resize guide' }), { key: 'ArrowLeft' }); expect(rect().width).toBe(old.width - 32); toggle(); expect(screen.queryByRole('dialog', { name: title })).toBeNull();
  });
  it('ignores malformed persisted state and clamps oversized saved state', () => {
    const viewport = { x: 0, y: 0, width: 320, height: 568 }; window.localStorage.setItem(GEOMETRY_KEY, '{broken'); expect(initialFrame(viewport).width).toBe(304); window.localStorage.setItem(GEOMETRY_KEY, JSON.stringify({ x: 9999, y: 9999, width: 99999, height: 99999 })); expect(initialFrame(viewport)).toEqual({ x: 8, y: 8, width: 304, height: 552 });
  });
});
