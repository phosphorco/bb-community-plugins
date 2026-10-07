// Signature proof only. Production app.tsx belongs to the steward.
import { definePluginApp } from '@get-bb/plugin-sdk/app';
import { createElement, type ComponentType } from 'react';
import type { FloatingGuideProps, GuideContentModule } from './contract.js';
declare const FloatingGuide: ComponentType<FloatingGuideProps>;
declare function loadContent(): Promise<GuideContentModule>;
const toggleEvent = 'plugin-guide-for-nerds:toggle';
function GuideOverlay() {
  return createElement(FloatingGuide, {
    loadContent, toggleEvent, title: 'BB Plugin Guide for Nerds',
    initialSelection: { section: 'surfaces', pageId: 'app-shell' },
  });
}
export default definePluginApp(app => {
  app.slots.experimental_appOverlay({ id: 'floating-guide', component: GuideOverlay });
  app.slots.sidebarFooterAction({
    id: 'guide-toggle', title: 'Toggle BB Plugin Guide for Nerds', icon: 'Puzzle',
    run: () => { window.dispatchEvent(new Event(toggleEvent)); },
  });
});
