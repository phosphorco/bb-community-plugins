import type { PluginBbSdk } from '@get-bb/plugin-sdk';
import { createNativeSourceAdapter } from '../native.js';
import type { NativeEvent, NativeSourceReference, NativeTimeline } from '../native.js';
import { defineNativeSourceConformance } from '../native-testing.js';

declare const sdk: PluginBbSdk;
declare const terminal: NativeSourceReference;
const adapter = createNativeSourceAdapter();
async function publicSdkWitness() {
  const events: NativeEvent[] = await sdk.threads.events.list({ threadId: terminal.threadId, limit: '200', order: 'asc' });
  const timeline: NativeTimeline = await sdk.threads.timeline({ threadId: terminal.threadId, includeNestedRows: 'true', deferContent: 'false', summaryOnly: 'false', segmentLimit: '200' });
  const result = adapter.resolve({ source: terminal, events, timeline });
  if (result.ok) {
    const initiating: 'unknown' = result.value.initiatingPerson.status;
    const noAgent: null = result.value.agentId;
    void [initiating, noAgent];
    // Native evidence must not accidentally become a Contribution.
    // @ts-expect-error no invented Contribution reference
    result.value.reference.contributionId;
  }
  return result;
}
const source: NativeSourceReference = { kind: 'assistant-terminal', threadId: 'thread', terminalEventId: 'terminal', scope: { turnId: 'turn' } };
// @ts-expect-error terminal scope.turnId is required; attemptId cannot substitute
const missingTurn: NativeSourceReference = { kind: 'assistant-terminal', threadId: 'thread', terminalEventId: 'terminal', attemptId: 'attempt' };
// @ts-expect-error attemptId belongs only to optional real provenance
const inventedAttempt: NativeSourceReference = { kind: 'assistant-terminal', threadId: 'thread', terminalEventId: 'terminal', scope: { turnId: 'turn' }, attemptId: 'attempt' };
const event: NativeEvent = {
  type: 'client/turn/requested', id: 'event', threadId: 'thread', seq: 1, createdAt: 1, scope: { kind: 'thread' },
  data: { direction: 'outbound', requestId: 'creq_fixture', source: 'tell', initiator: 'user', senderThreadId: null, input: [{ type: 'text', text: 'fixture', mentions: [] }], target: { kind: 'new-turn' }, request: { method: 'turn/start', params: {} }, execution: { model: 'fixture', reasoningLevel: 'low', permissionMode: 'readonly', serviceTier: 'fixture', source: 'client/turn/requested' } },
};
defineNativeSourceConformance({ test: (_name, _run) => {}, resolve: adapter.resolve, cases: [{ name: 'public source contract', snapshot: { source: { kind: 'event', threadId: 'thread', eventId: 'event' }, events: [event] }, verify: _result => {} }] });
void [publicSdkWitness, source, missingTurn, inventedAttempt];
