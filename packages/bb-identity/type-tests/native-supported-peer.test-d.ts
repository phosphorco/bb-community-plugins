/** Minimal public SDK calls shared by the actual registry 0.6.31 and inspected fork.
 * Wider fork-only query flags are intentionally exercised in a separate host witness. */
import type { PluginBbSdk } from '@get-bb/plugin-sdk';
import { createNativeSourceAdapter } from '@phosphorco/bb-identity/native';
import type { NativeEvent, NativeTimeline, NativeSourceReference } from '@phosphorco/bb-identity/native';
declare const sdk: PluginBbSdk;
const source: NativeSourceReference = { kind: 'assistant-terminal', threadId: 'thread', terminalEventId: 'event', scope: { turnId: 'turn' } };
async function actualPublicPeerCalls() {
  const events: NativeEvent[] = await sdk.threads.events.list({ threadId: source.threadId, limit: '200', order: 'asc' });
  const timeline: NativeTimeline = await sdk.threads.timeline({ threadId: source.threadId });
  return createNativeSourceAdapter().resolve({ source, events, timeline });
}
void actualPublicPeerCalls;
