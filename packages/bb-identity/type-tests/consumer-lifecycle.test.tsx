/**
 * Compile-only consumer paths. These are executable-shaped calls/JSX/cleanup
 * witnesses; they do not claim a declaration-only package has a runtime.
 */
import type { ReactElement } from 'react';
import { createIdentityClient, createIdentityFetchConnection, type IdentityClient, type IdentityStateBinding } from '../client.js';
import type { ContributionReference, IdentityError, IdentityKey, ThreadId } from '../model.js';
import { BbIdentity, useBbIdentityConnection, useIdentityStateBinding } from '../react.js';
import { createStateTransport, type DraftStorage, type IdentityState, type StateInvalidation, type StateResource, type StateTransport } from '../state.js';
import type { IdentityServer } from '../server.js';
import type { ConnectionHarness } from '../testing.js';

declare const preferences: StateResource<string>;
declare const preferencesTransport: StateTransport<string>;
declare const preferenceDrafts: DraftStorage<string>;
declare const identityClient: IdentityClient;
declare const identityServer: IdentityServer<never, never, string>;
declare const threadId: ThreadId;
declare const contribution: ContributionReference;
declare const selectedOwner: IdentityKey;
declare const connectionHarness: ConnectionHarness;
declare const unavailable: IdentityError;
declare const stateInvalidation: StateInvalidation;

/** Native root: JSX owns a view; the injected client remains borrowed. */
export function NativePreferencesRoot(): ReactElement {
  void useBbIdentityConnection();
  const state = useIdentityStateBinding({
    resource: preferences,
    recordId: 'preferences',
    drafts: preferenceDrafts,
    target: 'viewed-subject',
    editPolicy: 'collaborators',
    initializeEmpty: true,
    onConflict: () => ({ kind: 'needs-review', reason: 'feature review required' }),
    onUnpersistedDraft: () => undefined,
  });

  void state.edit('next preference value');
  void state.flush();

  return (
    <BbIdentity.Provider client={identityClient}>
      <BbIdentity.Context>{state.getSnapshot().status}</BbIdentity.Context>
    </BbIdentity.Provider>
  );
}

/** Independent-root owner starts and tears down one client with its own signal. */
export function mountIndependentPreferencesRoot(signal: AbortSignal): () => void {
  const endpoint = new URL('https://bb.example.test/api/v1/plugins/preferences/http/');
  const connection = createIdentityFetchConnection({ endpoint, fetch: globalThis.fetch, signal });
  const firstStateTransport = createStateTransport({ connection, resource: preferences });
  const secondStateTransport = createStateTransport({ connection, resource: preferences });
  const client = createIdentityClient({ connection });

  void firstStateTransport;
  void secondStateTransport;
  void client.start();
  return () => {
    client.dispose();
    connection.dispose();
  };
}

/** A concrete test harness can isolate a state-feed outage from identity health. */
export function stateOnlyDisconnectWitness(): void {
  const stateTransport = createStateTransport({ connection: connectionHarness.connection, resource: preferences });
  connectionHarness.setHealth({
    generation: 2,
    identity: { status: 'healthy' },
    state: { status: 'unavailable', error: unavailable },
  });
  connectionHarness.emit({ kind: 'state', event: stateInvalidation });
  const heldReload = connectionHarness.pauseNextRequest('state/load');
  void heldReload.reached;
  heldReload.release();
  void stateTransport;
}

/** A consumer must own a state controller's explicit preservation/cleanup path. */
export async function preserveThenDispose(state: IdentityState<string>): Promise<void> {
  await state.close({ pending: 'preserve' });
  state.dispose();
}

/** Recovery/concurrent-conflict commands require the current controller token. */
export async function resolveCurrentConflict(state: IdentityStateBinding<string>): Promise<void> {
  const snapshot = state.getSnapshot();
  if (snapshot.status !== 'blocked' || snapshot.conflict === null) return;
  await state.resolveConflict(snapshot.conflict.ownerSession, snapshot.conflict.token, {
    kind: 'needs-review',
    reason: `keep ${selectedOwner} pending`,
  });
}

/** No text correlation: history begins with native IDs/references and follows attempts. */
export async function readNativeHistory(): Promise<void> {
  const first = await identityServer.history.contributions({
    kind: 'native-message',
    threadId,
    messageId: 'native-message-id',
    limit: 1,
  });
  if (first.ok && (first.value.status === 'known' || first.value.status === 'partial') && first.value.nextCursor !== null) {
    await identityServer.history.contributions({
      kind: 'native-message',
      threadId,
      messageId: 'native-message-id',
      cursor: first.value.nextCursor,
      limit: 100,
    });
  }
  await identityServer.history.attempts({ kind: 'contribution', reference: contribution, limit: 100 });
}
