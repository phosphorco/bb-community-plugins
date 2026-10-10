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
  it('hands map-origin focus to details and returns focus, linked state and owned scroll', () => {
    const view = render(createElement('div', { 'data-guide-stage-viewport': true }, createElement(ProductMap)));
    const viewport = view.container.querySelector<HTMLElement>('[data-guide-stage-viewport]')!;
    const marker = view.container.querySelector<HTMLAnchorElement>('a[href="#surface-sidebar-navigation"]')!;
    act(() => marker.focus());
    viewport.scrollTop = 140;
    fireEvent.click(marker);
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Close');
    viewport.scrollTop = 500;
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(document.activeElement).toBe(marker);
    expect(viewport.scrollTop).toBe(140);
    expect(view.container.querySelector<HTMLElement>('[data-guide-reference="sidebar-navigation"]')?.dataset.active).toBe('true');
  });
  it('hands focus back to details when selecting a different map marker while details are open', () => {
    const view = render(createElement(ProductMap));
    const first = view.container.querySelector<HTMLAnchorElement>('a[href="#surface-sidebar-navigation"]')!;
    const second = view.container.querySelector<HTMLAnchorElement>('a[href="#surface-nav-panel"]')!;
    act(() => first.focus());
    fireEvent.click(first);
    act(() => second.focus());
    fireEvent.click(second);
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Close');
    fireEvent.keyDown(document.activeElement!, { key:'Escape' });
    expect(document.activeElement).toBe(second);
    expect(view.container.querySelector<HTMLElement>('[data-guide-reference="nav-panel"]')?.dataset.active).toBe('true');
  });
  it('restores a low reference row and outer viewport scroll after details close', () => {
    const view = render(createElement('div', { 'data-guide-stage-viewport': true }, createElement(ProductMap)));
    const viewport = view.container.querySelector<HTMLElement>('[data-guide-stage-viewport]')!;
    const column = view.container.querySelector<HTMLElement>('[data-guide-reference-column]')!;
    const row = () => view.container.querySelector<HTMLButtonElement>('[data-guide-reference="content-scripts"]')!;
    act(() => row().focus());
    viewport.scrollTop = 800;
    column.scrollTop = 350;
    fireEvent.click(row());
    viewport.scrollTop = 100;
    fireEvent.keyDown(document.activeElement!, { key:'Escape' });
    expect(document.activeElement).toBe(row());
    expect(viewport.scrollTop).toBe(800);
    expect(column.scrollTop).toBe(350);
  });
  it('exposes status and location/API descriptions and uses the primary provider declaration', () => {
    const view = render(createElement(ProductMap));
    const experimental = view.container.querySelector('[data-guide-reference="sidebar-navigation"]')!;
    expect(experimental.textContent).toContain('experimental');
    const ordinary = view.container.querySelector('[data-guide-reference="nav-panel"]')!;
    expect(ordinary.textContent).not.toContain('experimental');
    const ids = experimental.getAttribute('aria-describedby')!.split(' ');
    expect(ids.map(id => document.getElementById(id)?.textContent).join(' ')).toContain('ExperimentalSidebarNavigationRegistration');
    fireEvent.click(view.getByRole('button',{name:'The composer'}));
    const provider = view.container.querySelector('[data-guide-reference="provider-picker"]')!;
    expect(provider.querySelector('code')?.textContent).toBe('PluginProviderDeclaration');
    fireEvent.click(provider);
    expect(view.container.querySelector('[data-guide-reference-note]')?.textContent).toContain('PluginProviderDeclaration');
    fireEvent.keyDown(document.activeElement!,{key:'Escape'});
    const mention = view.container.querySelector('[data-guide-reference="mention-provider"]')!;
    expect(mention.textContent).toContain('configured trigger');
    expect(mention.textContent).toContain('@ by default');
    fireEvent.click(mention);
    expect(view.container.querySelector('[data-guide-reference-note]')?.textContent).toContain('configured trigger');
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
