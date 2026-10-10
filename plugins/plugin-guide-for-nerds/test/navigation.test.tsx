// @vitest-environment jsdom
import { createElement } from 'react';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProductMap } from '../src/product-map';
import { surfaceLabel } from '../src/surface-labels';

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('matchMedia', () => ({ matches:false, addEventListener() {}, removeEventListener() {} }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('compact instant reference', () => {
  it('shows full names and exact locations in a numbered side reference, without map labels', () => {
    const view = render(createElement(ProductMap));
    const active = view.container.querySelector('[data-map-section]:not([inert])')!;
    const badges = active.querySelectorAll<HTMLElement>('[data-guide-badge]');
    const reference = view.container.querySelector('[data-guide-reference-column]')!;
    expect(badges).toHaveLength(16);
    expect(reference.querySelectorAll('[data-guide-reference]')).toHaveLength(16);
    expect(active.querySelector('[data-guide-label]')).toBeNull();
    for (const badge of badges) {
      const id = badge.dataset.guideBadge!;
      const row = reference.querySelector(`[data-guide-reference="${id}"]`)!;
      expect(row.textContent).toContain(surfaceLabel(id));
      expect(row.querySelector('[data-guide-reference-number]')?.textContent).toBe(badge.querySelector('[data-guide-number]')?.textContent);
    }
    expect(reference.textContent).toContain('Left sidebar: New thread, Search, Plugins and Skills');
    expect(reference.textContent).toContain('ExperimentalSidebarNavigationRegistration');
  });
  it('links hover and keyboard focus in both directions, then shows details in the side column', () => {
    const view = render(createElement(ProductMap));
    const marker = view.container.querySelector<HTMLAnchorElement>('[data-map-section="app-shell"] a[href="#surface-sidebar-navigation"]')!;
    const row = () => view.container.querySelector<HTMLButtonElement>('[data-guide-reference="sidebar-navigation"]')!;
    fireEvent.mouseEnter(marker);
    expect(row().dataset.active).toBe('true');
    fireEvent.mouseLeave(marker);
    expect(row().dataset.active).toBeUndefined();
    fireEvent.focus(row());
    expect(marker.querySelector('[data-guide-number]')?.className).toContain('nerd-guide-number-active');
    act(() => row().focus());
    const other = view.container.querySelector('[data-map-section="app-shell"] a[href="#surface-nav-panel"]')!;
    fireEvent.mouseEnter(other);
    expect(marker.querySelector('[data-guide-number]')?.className).toContain('nerd-guide-number-active');
    fireEvent.mouseLeave(other);
    expect(marker.querySelector('[data-guide-number]')?.className).toContain('nerd-guide-number-active');
    fireEvent.click(row());
    const card = view.container.querySelector('[data-guide-card]')!;
    expect(card.closest('[data-guide-reference-column]')).not.toBeNull();
    expect(card.textContent).toContain('In BB, I mean “Sidebar navigation” (sidebar-navigation).');
    expect(view.container.querySelector('[data-guide-screen-info]')).toBeNull();
    expect(view.container.querySelector('[data-guide-reference-list]')).toBeNull();
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Close');
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(view.container.querySelector('[data-guide-screen-info]')).not.toBeNull();
    expect(document.activeElement).toBe(row());
    expect(row().closest('[hidden],[inert]')).toBeNull();
    expect(marker.querySelector('[data-guide-number]')?.className).toContain('nerd-guide-number-active');
    act(() => row().blur());
    expect(marker.querySelector('[data-guide-number]')?.className).not.toContain('nerd-guide-number-active');
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
