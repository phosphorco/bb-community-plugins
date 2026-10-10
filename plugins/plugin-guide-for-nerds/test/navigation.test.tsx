// @vitest-environment jsdom
import { createElement } from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProductMap } from '../src/product-map';
import { surfaceLabel } from '../src/surface-labels';

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('matchMedia', () => ({ matches:false, addEventListener() {}, removeEventListener() {} }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('compact instant reference', () => {
  it('names every rendered surface without hover and preserves actionable marker names', () => {
    const view = render(createElement(ProductMap));
    const active = view.container.querySelector('[data-map-section]:not([inert])')!;
    const badges = active.querySelectorAll<HTMLElement>('[data-guide-badge]');
    expect(badges).toHaveLength(16);
    for (const badge of badges) {
      const id=badge.dataset.guideBadge!;
      expect(badge.querySelector('[data-guide-label]')?.textContent).toBe(surfaceLabel(id));
      expect(badge.querySelector('[data-guide-number]')?.textContent).toMatch(/^\d+$/);
    }
    const action=active.querySelector('a[href="#surface-sidebar-navigation"]')!;
    expect(action.getAttribute('aria-label')).toContain('sidebar navigation');
    fireEvent.click(action);
    expect(view.container.querySelector('[data-guide-card] h3')?.textContent).toBe('Sidebar navigation');
  });
  it('replaces pages synchronously without a transition timer or inactive fixtures', () => {
    vi.useFakeTimers();
    const view=render(createElement(ProductMap));
    const before=vi.getTimerCount();
    fireEvent.click(view.getByRole('button',{name:'Command palette'}));
    expect(view.container.querySelector('[data-map-section]:not([inert])')?.getAttribute('data-map-section')).toBe('command-palette');
    expect(view.container.querySelectorAll('[data-map-section][hidden] [data-guide-responsive-strategy]')).toHaveLength(0);
    expect(view.container.querySelector('[data-guide-fixture="command-palette-dialog"]')).not.toBeNull();
    expect(view.container.innerHTML).not.toMatch(/transition-|duration-300|translateX/);
    expect(vi.getTimerCount()).toBe(before);
  });
});
