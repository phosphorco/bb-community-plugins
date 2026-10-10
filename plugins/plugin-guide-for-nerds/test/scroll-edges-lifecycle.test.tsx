// @vitest-environment jsdom
import { createElement, Profiler, useRef } from 'react';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useScrollEdges } from '../src/scroll-edges';
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('keeps interior scroll commits quiet while updating either edge and disposing subscriptions', () => {
  const disconnect = vi.fn();
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect = disconnect; });
  const commit = vi.fn();
  function Consumer() {
    const ref = useRef<HTMLDivElement>(null);
    const state = useScrollEdges(ref);
    return createElement('div', { ref, 'data-left':state.canScrollLeft, 'data-right':state.canScrollRight });
  }
  const view = render(createElement(Profiler,{id:'edges',onRender:commit},createElement(Consumer)));
  const element = view.container.firstElementChild! as HTMLDivElement;
  Object.defineProperties(element,{scrollWidth:{value:1000},clientWidth:{value:200}});
  element.scrollLeft = 200;
  fireEvent.scroll(element);
  expect(element.dataset.left).toBe('true');
  expect(element.dataset.right).toBe('true');
  const count = commit.mock.calls.length;
  for (const left of [220,300,450,600]) { element.scrollLeft=left; fireEvent.scroll(element); }
  expect(commit).toHaveBeenCalledTimes(count);
  element.scrollLeft=0; fireEvent.scroll(element);
  expect(element.dataset.left).toBe('false');
  element.scrollLeft=800; fireEvent.scroll(element);
  expect(element.dataset.right).toBe('false');
  view.unmount();
  expect(disconnect).toHaveBeenCalledOnce();
  const final = commit.mock.calls.length;
  act(() => element.dispatchEvent(new Event('scroll')));
  expect(commit).toHaveBeenCalledTimes(final);
});
