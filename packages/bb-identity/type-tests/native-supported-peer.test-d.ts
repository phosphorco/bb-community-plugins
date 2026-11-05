/** Minimal public SDK calls shared by the actual registry 0.6.31 and inspected fork.
 * Wider fork-only query flags are intentionally exercised in a separate host witness. */
import type { PluginBbSdk } from '@get-bb/plugin-sdk';
import { createNativeSourceAdapter } from '@phosphorco/bb-identity/native';
import type { NativeEvent, NativeSourceEvent, NativeSourceActor, NativeTimeline, NativeSourceReference } from '@phosphorco/bb-identity/native';
import { externalPersonSnapshotCodec } from '@phosphorco/bb-identity/model';
declare const sdk: PluginBbSdk;
const source: NativeSourceReference = { kind: 'assistant-terminal', threadId: 'thread', terminalEventId: 'event', scope: { turnId: 'turn' } };
async function actualPublicPeerCalls() {
  const events: NativeEvent[] = await sdk.threads.events.list({ threadId: source.threadId, limit: '200', order: 'asc' });
  const timeline: NativeTimeline = await sdk.threads.timeline({ threadId: source.threadId });
  return createNativeSourceAdapter().resolve({ source, events, timeline });
}
void actualPublicPeerCalls;

// Package recorded-source capability is independent of absent SDK attribution members.
const asserted = externalPersonSnapshotCodec.decode({
  identity: { kind: 'person', key: 'person:external', issuer: 'fixture', subject: 'external' },
  presentation: { displayName: 'external', handle: null, avatarUrl: null }, evidence: 'integration-asserted',
});
declare const sdkRequest: Extract<NativeEvent, { type: 'client/turn/requested' }>;
if (asserted.ok) {
  const actor: NativeSourceActor = asserted.value;
  const recorded = { ...sdkRequest, data: { ...sdkRequest.data, p6rAuthors: [actor], p6rEditors: [asserted.value] } } satisfies NativeSourceEvent;
  createNativeSourceAdapter().resolve({ source, events: [recorded] });
}
declare const ordinaryEvents: readonly NativeEvent[];
const sourceEvents: readonly NativeSourceEvent[] = ordinaryEvents;
void sourceEvents;
