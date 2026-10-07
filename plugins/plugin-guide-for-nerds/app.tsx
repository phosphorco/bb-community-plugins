import './app.css';
import { definePluginApp } from '@get-bb/plugin-sdk/app';
import { FloatingGuide } from './src/floating';
import { createGuideContentLoader } from './src/content-loader';

export const GUIDE_TOGGLE_EVENT = 'plugin-guide-for-nerds:toggle';
export const GUIDE_TITLE = 'BB Plugin Guide for Nerds';
const importContent = () => import('./src/guide-content');
const loadContent = createGuideContentLoader(importContent, import.meta.url);

function GuideOverlay() {
  return <FloatingGuide loadContent={loadContent} toggleEvent={GUIDE_TOGGLE_EVENT}
    title={GUIDE_TITLE} initialSelection={{ section: 'surfaces', pageId: 'app-shell' }} />;
}

export default definePluginApp((app) => {
  app.slots.experimental_appOverlay({ id: 'floating-guide', component: GuideOverlay });
  app.slots.sidebarFooterAction({
    id: 'guide-toggle', title: `Toggle ${GUIDE_TITLE}`, icon: 'Puzzle',
    run: () => { window.dispatchEvent(new Event(GUIDE_TOGGLE_EVENT)); },
  });
});
