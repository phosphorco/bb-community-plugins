// @vitest-environment jsdom
import { createElement } from 'react';
import { act, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { loadPluginApp, renderSlot } from '@get-bb/plugin-sdk/testing/app';

vi.mock('../src/guide-content', () => ({ default: () => createElement('div', null, 'Guide content') }));

describe('native floating guide layout', () => {
  it('mounts a scoped nonmodal portal only while open', async () => {
    const app = await loadPluginApp(() => import('../app'));
    const slot = await renderSlot(app.appOverlays[0], {}, { pluginId: 'plugin-guide-for-nerds' });
    try {
      expect(document.querySelector('[data-guide-frame]')).toBeNull();
      act(() => { app.sidebarFooterActions[0].run({ openSettings: vi.fn() }); });
      await waitFor(() => expect(document.body.textContent).toContain('Guide content'));
      const frame = document.querySelector<HTMLElement>('[data-guide-frame]')!;
      expect(frame.getAttribute('data-bb-plugin')).toBe('plugin-guide-for-nerds');
      expect(frame.getAttribute('aria-modal')).toBe('false');
      expect(frame.getAttribute('role')).toBe('dialog');
      expect(document.querySelectorAll('[data-guide-frame]')).toHaveLength(1);
      const viewport = frame.querySelector<HTMLElement>('[data-guide-stage-viewport]')!;
      expect(viewport.style.overflow).toBe('auto');
      expect(viewport.style.containerType).toBe('size');
      expect(document.body.style.overflow).toBe('');
      act(() => { app.sidebarFooterActions[0].run({ openSettings: vi.fn() }); });
      expect(document.querySelector('[data-guide-frame]')).toBeNull();
    } finally { slot.lifecycle.unmount(); }
  });
});
