// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { loadPluginApp } from '@get-bb/plugin-sdk/testing/app';
import { GUIDE_TITLE, GUIDE_TOGGLE_EVENT } from './app';
const app = await loadPluginApp(() => import('./app'));

describe('Nerd Guide registrations', () => {
  it('registers one native overlay and footer action', () => {
    expect(app.appOverlays.map((slot) => slot.id)).toEqual(['floating-guide']);
    expect(app.sidebarFooterActions.map((slot) => slot.id)).toEqual(['guide-toggle']);
    expect(app.sidebarFooterActions[0].title).toBe(`Toggle ${GUIDE_TITLE}`);
    expect(app.navPanels).toHaveLength(0);
  });
  it('dispatches the namespaced toggle', () => {
    const listener = vi.fn();
    window.addEventListener(GUIDE_TOGGLE_EVENT, listener);
    app.sidebarFooterActions[0].run({ openSettings: vi.fn() });
    expect(listener).toHaveBeenCalledOnce();
    window.removeEventListener(GUIDE_TOGGLE_EVENT, listener);
  });
});
