import { GROUP_BY_SURFACE_ID, SURFACES_BY_ID } from './surfaces';

const locations: Readonly<Record<string, string>> = {
  'sidebar-navigation': 'Left sidebar: New thread, Search, Plugins and Skills, above the thread list.',
  'nav-panel': 'A plugin row in the left sidebar that opens its page in the main content area.',
  'thread-row-status': 'The status icon and label beside a thread in the left sidebar.',
  'thread-list': 'The thread rows and project groups in the left sidebar.',
  'sidebar-footer': 'The action buttons at the bottom of the left sidebar.',
  'thread-header': 'The title and action controls above an open thread conversation.',
  'timeline-renderers': 'Messages and tool results in the thread conversation timeline.',
  'message-directives': 'Embedded plugin content inside a message in the thread timeline.',
  'message-actions': 'The action controls attached to a message in the thread timeline.',
  'pending-interaction': 'A question or approval form waiting for a response in the thread timeline.',
  'code-renderers': 'The code or diff content in the thread’s right-hand side panel.',
  'browser-toolbar': 'The navigation and action toolbar inside the right-hand Browser tab.',
  'thread-panel': 'A plugin tab beside Browser and Terminal in the thread’s right-hand side panel.',
  'file-opener': 'The viewer or editor opened for a file in the right-hand side panel.',
  'app-overlay': 'A plugin surface displayed over the current BB page.',
  'content-scripts': 'App-wide plugin logic that runs beyond the currently visible page.',
  'command-palette-actions': 'An action in BB’s command palette, opened with Cmd/Ctrl+K.',
  'composer-banners': 'A banner directly above the prompt editor in the composer.',
  'composer-state': 'The prompt draft and its state in the composer.',
  'mention-provider': 'Suggestions after a configured trigger in the prompt editor; @ by default.',
  'composer-rich-text': 'Highlighted or decorated text inside the prompt editor.',
  'composer-plus-menu': 'An item in the + menu at the bottom-left of the composer.',
  'provider-picker': 'The model/provider picker along the bottom of the composer.',
  'composer-actions': 'An inline action button along the bottom of the composer.',
  'homepage-section': 'A plugin content section below the new-thread composer on the home page.',
  'new-thread-panel': 'A plugin tab in the side panel on the home/new-thread screen.',
  'declarative-settings': 'Plugin configuration fields rendered by BB in Settings.',
  'settings-section': 'A custom plugin section inside BB Settings.',
  'plugin-status': 'Configuration, connection and recovery information on the plugin’s page.',
};

export function surfaceLabel(id: string): string {
  return SURFACES_BY_ID.get(id)?.title ?? id;
}

export function surfaceLocation(id: string): string {
  return locations[id] ?? `On ${GROUP_BY_SURFACE_ID.get(id)?.title ?? 'the BB plugin backend'}.`;
}

export function surfacePrimaryApi(id: string): string {
  const surface = SURFACES_BY_ID.get(id);
  return surface?.primaryApi ?? surface?.apiSymbols[0] ?? '';
}

export function surfaceReferenceNote(id: string): string {
  const surface = SURFACES_BY_ID.get(id);
  if (!surface) return surfaceLocation(id);
  return `In BB, I mean “${surface.title}” (${id}). ${surfaceLocation(id)} Start with the public Plugin SDK’s ${surfacePrimaryApi(id)} API and the Plugin Guide reference for this surface.`;
}
