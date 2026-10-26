import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { createIdentityReactRuntime } from '../react-runtime.js';
import { createIdentityEditingState, EDITING_PROTOCOL } from '../editing-runtime.js';
import { idCodec, identityKeyCodec, ok, err } from '../model-runtime.js';
import type { Codec, Result } from '../model.js';
import type { IdentityClient } from '../client.js';
import type { ServerSession } from '../host.js';
import type { EditingDraft, EditingDraftStorage, IdentityEditingBinding } from '../editing.js';
const id = <K extends string>(kind: K, raw: string) => { const value = idCodec(kind).decode(raw); if (!value.ok) throw new Error(value.error.message); return value.value; };
const actor = identityKeyCodec.decode('issuer:a'); if (!actor.ok) throw new Error('fixture identity');
const session: ServerSession = { status: 'ready', instanceId: id('instance', 'browser-editing'), mode: 'multi-user', stamp: id('server-session', 'a1/opaque%2F'),
  actor: { identity: { kind: 'person', key: actor.value, issuer: 'issuer', subject: 'a' }, presentation: { displayName: 'A', handle: null, avatarUrl: null }, evidence: 'provider-verified' },
  capabilities: { requestIdentity: 'host-resolved', acceptance: 'transactional-check', forwarding: 'host-bound', directory: { search: false, lookup: false }, participants: false, externalSend: 'structured', toolProvenance: 'unknown', operationLookup: true } };
const unsupported = async () => err('unsupported', 'Unused browser fixture route.');
const client: IdentityClient = { getSnapshot: () => session, currentSession: () => ok(session), subscribe: () => () => {}, start: async () => ok(undefined), refresh: async () => ok(undefined), selfProfile: unsupported, dispose() {},
  directory: { search: unsupported, getMany: unsupported, subscribe: () => () => {} }, participants: { list: unsupported, previews: unsupported },
  connection: { getHealth: () => ({ generation: 1, identity: { status: 'healthy' }, state: { status: 'healthy' } }), subscribeHealth: () => () => {}, subscribe: () => () => {}, request: unsupported, revalidate: async () => ok(undefined), dispose() {} } };
const runtime = createIdentityReactRuntime({ useRpc() { throw new Error('unused native acquisition'); }, useRealtime() {}, useRealtimeConnectionState() { throw new Error('unused native acquisition'); } });
const text: Codec<string> = { encode: value => value, decode: value => typeof value === 'string' ? ok(value) : err('invalid-input', 'Expected text.') };
type Target = { readonly mapId: string };
const targetCodec: Codec<Target> = { encode: value => ({ mapId: value.mapId }), decode: value => typeof value === 'object' && value !== null && 'mapId' in value && typeof value.mapId === 'string' ? ok({ mapId: value.mapId }) : err('invalid-input', 'Expected map.') };
let failed = false; let mounts = 0; const retained: EditingDraft<string, Target>[] = [];
const drafts: EditingDraftStorage<string, Target> = { find: async () => ok([]), async write(draft, revision) { if (failed) return err('unavailable', 'Browser checkpoint failed.'); retained.push(draft); return ok({ draft, revision: (revision ?? 0) + 1 }); }, remove: async () => ok(undefined) };
let binding: IdentityEditingBinding<string, Target> | null = null;
let rerender: (() => void) | null = null; let switchTarget: ((target: string) => void) | null = null;
let failures: ReturnType<typeof runtime.useEditingPreservationFailures> = [];
let acknowledge: (generation: number) => boolean = () => false;
function Editor({ mapId }: { mapId: string }) {
  binding = runtime.useBoundIdentityEditing({ resourceKey: 'source-editor/v1', target: { mapId }, targetCodec,
    create({ session, ownerSession }) {
      mounts++;
      const address = { instanceId: session.instanceId, pluginId: id('plugin', 'editing-fixture'), collection: 'source', recordId: mapId, owner: session.actor.identity.key };
      return createIdentityEditingState({ draftAddress: address, target: { mapId }, targetCodec, expected: { actor: session.actor.identity.key, session: session.stamp }, ownerSession,
        definition: { collection: 'source', schemaVersion: 1, codec: text, initialValue: () => '', equal: (a,b) => a === b }, drafts,
        transport: { protocol: EDITING_PROTOCOL, load: async () => ok({ status: 'present', envelope: { address, version: { epoch: 'epoch', sequence: 1 }, schemaVersion: 1, value: 'base', lastEditedBy: null } }),
          save: async request => ok({ protocol: EDITING_PROTOCOL, status: 'indeterminate', operationId: request.mutation.operationId }), reconcile: async () => ok({ status: 'pending' }), subscribe: () => () => {} },
        onConflict: () => ({ kind: 'needs-review', reason: 'review' }), initializeEmpty: false, currentSession: () => client.currentSession() });
    } });
  const state = runtime.useIdentityEditingSnapshot(binding);
  return <output data-testid="editor" data-status={state.status} data-map={state.status === 'waiting-for-identity' ? '' : state.scope.target.mapId} data-owner={binding?.currentOwnerSession() ?? ''}>{state.status === 'waiting-for-identity' ? '' : state.desired}</output>;
}
function FailureView() { failures = runtime.useEditingPreservationFailures(); acknowledge = runtime.useAcknowledgeEditingPreservationFailure(); return <output data-testid="failures">{failures.length}</output>; }
function App() { const [mapId, setMapId] = React.useState('map-1'); const [render, setRender] = React.useState(0); rerender = () => setRender(value => value + 1); switchTarget = setMapId;
  return <main data-render={render}><runtime.Provider client={client}><runtime.Context><Editor mapId={mapId} /><FailureView /></runtime.Context></runtime.Provider></main>; }
declare global { interface Window { editingProbe: { stats(): unknown; edit(value: string): boolean; flush(): Promise<boolean>; rerender(): void; target(value: string): void; fail(): void; acknowledge(generation: number): boolean; } } }
window.editingProbe = { stats: () => ({ mounts, owner: binding?.currentOwnerSession(), state: binding?.getSnapshot(), failures, retained }), edit: value => binding?.edit(value).ok ?? false,
  flush: async () => (await binding?.flush())?.ok ?? false, rerender: () => rerender?.(), target: value => switchTarget?.(value), fail: () => { failed = true; }, acknowledge: generation => acknowledge(generation) };
createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
