import { SURFACES_BY_ID } from './surfaces';

// Short scan labels; full names and descriptions remain in the detail cards.
const labels: Readonly<Record<string, string>> = {
  'sidebar-navigation': 'Navigation', 'nav-panel': 'Panels',
  'thread-row-status': 'Status', 'thread-list': 'Threads',
  'sidebar-footer': 'Footer', 'thread-header': 'Header',
  'timeline-renderers': 'Timeline', 'message-directives': 'Embeds',
  'message-actions': 'Actions', 'pending-interaction': 'Forms',
  'code-renderers': 'Code', 'browser-toolbar': 'Browser',
  'thread-panel': 'Tabs', 'file-opener': 'Files',
  'app-overlay': 'Overlays', 'content-scripts': 'Scripts',
  'command-palette-actions': 'Commands', 'composer-banners': 'Banners',
  'composer-state': 'Draft state', 'mention-provider': 'Mentions',
  'composer-rich-text': 'Highlighting', 'composer-plus-menu': '+ menu',
  'provider-picker': 'Providers', 'composer-actions': 'Inline actions',
  'homepage-section': 'Home sections', 'new-thread-panel': 'New thread',
  'declarative-settings': 'Fields', 'settings-section': 'Settings',
  'plugin-status': 'Configuration',
};

export function surfaceLabel(id: string): string {
  return labels[id] ?? SURFACES_BY_ID.get(id)?.title ?? id;
}
