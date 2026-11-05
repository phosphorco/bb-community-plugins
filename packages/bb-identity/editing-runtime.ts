/** Opt-in shared-work editing, using the same production synchronization engine. */
import type { Codec, Json, Result } from './model.js';
import type { EditingCheckpoint, EditingDraft, EditingReceipt, EditingRequest, EditingScope, EditingSnapshot, EditingState } from './editing.js';
import type { DraftCheckpoint, DraftStorage, StateMutation } from './state.js';
import { err, ok } from './model-runtime.js';
import { createStateController, type CoreDraft, type CoreOutcome, type CoreTransport } from './state-controller-runtime.js';
import { bindOwnedIdentityController } from './client-state-binding-runtime.js';
import type { DraftRetirementOwner } from './draft-retirement-runtime.js';
import { stateAddressKey, stateCodecs } from './state-service-runtime.js';
import { canonicalEditingJson, editingCodecs, EDITING_PROTOCOL } from './editing-codecs-runtime.js';
export { editingCodecs, EDITING_PROTOCOL, EDITING_LIMITS } from './editing-codecs-runtime.js';

function frozen<T>(value: T): T { if (value && typeof value === 'object') { for (const child of Object.values(value)) frozen(child); Object.freeze(value); } return value; }
function clone<T>(codec: Codec<T>, value: T): T { const result = codec.decode(structuredClone(codec.encode(value))); if (!result.ok) throw new TypeError(result.error.message); return frozen(result.value); }

export function createIdentityEditingState<T, Target>(options: Parameters<typeof import('./editing.js').createIdentityEditingState<T, Target>>[0]): EditingState<T, Target> {
  if (options.transport.protocol !== EDITING_PROTOCOL) throw new TypeError('Editing transport requires explicit editing/v1 negotiation.');
  if (options.draftAddress.owner !== options.expected.actor) throw new TypeError('Draft ownership must be the actual actor, distinct from the shared target.');
  const target = clone(options.targetCodec, options.target);
  const scope: EditingScope<Target> = frozen({ draftAddress: { ...options.draftAddress }, target, schemaVersion: options.definition.schemaVersion, expected: { ...options.expected } });
  const codecs = editingCodecs(options.definition.codec, options.targetCodec);
  const stateWire = stateCodecs(options.definition.codec);
  const sameTarget = (candidate: Target) => canonicalEditingJson(options.targetCodec.encode(candidate)) === canonicalEditingJson(options.targetCodec.encode(target));
  const normalize = <V>(codec: Codec<V>, value: V): Result<V> => { try { const parsed = codec.decode(structuredClone(codec.encode(value))); return parsed.ok ? ok(frozen(parsed.value)) : parsed; } catch { return err('incompatible', 'Editing response failed codec validation.'); } };
  const request = (mutation: StateMutation<T>): EditingRequest<T, Target> => clone(codecs.request, { protocol: EDITING_PROTOCOL, target, mutation });
  const checkReceipt = (receipt: EditingReceipt<T, Target>, submitted: EditingRequest<T, Target>): Result<CoreOutcome<T>> => {
    if (canonicalEditingJson(codecs.request.encode(receipt.request)) !== canonicalEditingJson(codecs.request.encode(submitted))) return err('invalid-operation', 'Editing receipt does not bind the exact immutable request.');
    return receipt.outcome.status === 'rejected'
      ? ok({ status: 'rejected', operationId: receipt.outcome.operationId, evidence: codecs.receipt.encode(receipt) })
      : ok(receipt.outcome);
  };
  const transport: CoreTransport<T> = {
    async load(_input, readOptions) { const response = await options.transport.load(scope, readOptions); return response.ok ? normalize(stateWire.read, response.value) : response; },
    async save(mutation, readOptions) {
      const submitted = request(mutation); const response = await options.transport.save(submitted, readOptions);
      if (!response.ok) return response;
      const parsed = normalize(codecs.save, response.value); if (!parsed.ok) return parsed;
      if ('status' in parsed.value) return parsed.value.operationId === mutation.operationId ? ok({ status: 'indeterminate', operationId: mutation.operationId }) : err('invalid-operation', 'Unknown outcome names another operation.');
      return checkReceipt(parsed.value, submitted);
    },
    async reconcile(input, readOptions) {
      const submitted = request(input.mutation); const response = await options.transport.reconcile(submitted, readOptions);
      if (!response.ok) return response;
      const parsed = normalize(codecs.lookup, response.value); if (!parsed.ok) return parsed;
      if (parsed.value.status !== 'final') return ok(parsed.value);
      const checked = checkReceipt(parsed.value.outcome, submitted);
      return checked.ok ? ok({ status: 'final', outcome: checked.value }) : checked;
    },
    subscribe: (_address, listener) => options.transport.subscribe(scope, event => { const parsed = normalize(stateWire.invalidation, event); if (parsed.ok) listener(parsed.value); }),
  };
  const toDraft = (draft: CoreDraft<T>): EditingDraft<T, Target> => {
    const rejection = draft.rejection ? codecs.receipt.decode(draft.rejection) : ok(null);
    if (!rejection.ok) throw new TypeError(rejection.error.message);
    return clone(codecs.draft, { protocol: EDITING_PROTOCOL, target, draft, rejection: rejection.value });
  };
  const fromDraft = (draft: EditingDraft<T, Target>): Result<CoreDraft<T>> => {
    const parsed = normalize(codecs.draft, draft); if (!parsed.ok) return parsed;
    if (!sameTarget(parsed.value.target) || stateAddressKey(parsed.value.draft.key.address) !== stateAddressKey(scope.draftAddress)) return err('invalid-input', 'Checkpoint belongs to another publication target or draft address.');
    return ok(frozen({ ...parsed.value.draft, rejection: parsed.value.rejection ? codecs.receipt.encode(parsed.value.rejection) : null, rejectedGeneration: parsed.value.rejection?.request.mutation.localGeneration ?? -1 }));
  };
  const fromCheckpoint = (checkpoint: EditingCheckpoint<T, Target>): Result<DraftCheckpoint<T>> => {
    if (!Number.isSafeInteger(checkpoint.revision) || checkpoint.revision < 0) return err('invalid-input', 'Invalid checkpoint revision.');
    const parsed = fromDraft(checkpoint.draft); return parsed.ok ? ok({ revision: checkpoint.revision, draft: parsed.value }) : parsed;
  };
  const toCheckpoint = (checkpoint: DraftCheckpoint<T>): EditingCheckpoint<T, Target> => frozen({ revision: checkpoint.revision, draft: toDraft(checkpoint.draft) });
  const storage: DraftStorage<T> | undefined = options.drafts ? {
    async find(_address, _actor, limit) {
      const found = await options.drafts!.find(scope, limit); if (!found.ok) return found;
      if (found.value.length > limit) return err('limit-exceeded', 'Too many editing checkpoints.');
      const results = [];
      for (const entry of found.value) { const parsed = fromCheckpoint(entry); if (!parsed.ok) return parsed; results.push(parsed.value); }
      return ok(results);
    },
    async write(draft, revision) {
      const captured = toDraft(draft); const saved = await options.drafts!.write(captured, revision);
      if (!saved.ok) return saved;
      if (saved.value.revision <= (revision ?? -1)) return err('incompatible', 'Checkpoint storage did not advance its conditional revision.');
      const parsed = fromCheckpoint(saved.value); if (!parsed.ok) return parsed;
      if (canonicalEditingJson(codecs.draft.encode(saved.value.draft)) !== canonicalEditingJson(codecs.draft.encode(captured))) return err('incompatible', 'Checkpoint storage returned different draft content.');
      return parsed;
    },
    remove(key, revision) { return options.drafts!.remove({ target, draftKey: key }, revision); },
  } : undefined;
  const core = createStateController({ address: scope.draftAddress, expected: scope.expected, ownerSession: options.ownerSession,
    definition: options.definition, transport, ...(storage ? { drafts: storage } : {}),
    ...(options.scheduler ? { scheduler: options.scheduler } : {}), retryLimit: 0,
    onConflict: options.onConflict, initializeEmpty: options.initializeEmpty, currentSession: options.currentSession }, true);
  let snapshot: EditingSnapshot<T, Target>;
  const update = () => {
    const state = core.getSnapshot(); const detail = core.inspect();
    const blocked = state.status === 'blocked' ? state : null;
    const status = state.status === 'detached' ? 'detached' : state.status === 'loading' ? 'loading' : detail.editable ? 'loaded' : 'fenced';
    const retained = detail.draft ? toDraft(detail.draft) : null;
    const reason = blocked?.reason;
    const publication = status === 'fenced' || status === 'detached' ? 'fenced' : detail.saving ? 'saving' : detail.pending ? 'unknown' : reason === 'conflict' ? 'conflict' : reason === 'rejected' || retained?.rejection ? 'rejected' : 'idle';
    snapshot = frozen({ protocol: EDITING_PROTOCOL, status, scope, ownerSession: options.ownerSession,
      desired: detail.desired, localGeneration: detail.generation, acknowledged: detail.base, dirty: detail.dirty, editable: detail.editable,
      submitted: detail.pending ? request(detail.pending) : null,
      publication: { eligible: detail.saveEligible && detail.editable && !detail.pending && !detail.saving && reason !== 'conflict' && detail.checkpoint.status !== 'failed',
        status: publication, message: blocked?.message ?? null, rejection: retained?.rejection ?? null, conflict: blocked?.conflict ?? null },
      checkpoint: detail.checkpoint, draft: retained });
  };
  update();
  const stop = core.subscribe(update);
  return {
    draftStorage: options.drafts ?? null,
    getSnapshot: () => snapshot,
    subscribe: listener => core.subscribe(listener),
    start: () => core.start(), edit: value => core.edit(value), flush: () => core.flush(), reconnect: input => core.reconnect(input),
    resolveConflict: (token, decision) => core.resolveConflict(token, decision),
    async checkpoint() { const saved = await core.checkpoint(); return saved.ok ? ok(saved.value ? toCheckpoint(saved.value) : null) : saved; },
    async recoveryCandidates(readOptions) { const found = await core.recoveryCandidates(readOptions); return found.ok ? ok(found.value.map(toCheckpoint)) : found; },
    recover(candidate) { const parsed = fromCheckpoint(candidate); return parsed.ok ? core.recover(parsed.value) : Promise.resolve(parsed); },
    discardRecovery(candidate) { const parsed = fromCheckpoint(candidate); return parsed.ok ? core.discardRecovery(parsed.value) : Promise.resolve(parsed); },
    detach(reason) { const retained = core.detach(reason); return retained ? toDraft(retained) : null; },
    close: input => core.close(input),
    dispose() { core.dispose(); stop(); },
  };
}

/** One owner implementation serves both public state APIs. */
export function bindIdentityEditingState<T, Target>(options: import('./editing.js').EditingBindingOptions<T, Target>, retirementOwner?: DraftRetirementOwner): import('./editing.js').IdentityEditingBinding<T, Target> {
  if (!options.resourceKey || options.resourceKey.length > 1024) throw new TypeError('Editing binding requires a bounded semantic resource key.');
  const target = clone(options.targetCodec, options.target);
  const targetKey = canonicalEditingJson(options.targetCodec.encode(target));
  let currentController: EditingState<T, Target> | null = null;
  return bindOwnedIdentityController<T, EditingDraft<T, Target>, EditingCheckpoint<T, Target>, EditingSnapshot<T, Target>>({
    client: options.client, view: options.view, target: 'actor', editPolicy: 'actor-only',
    ...(options.onUnpersistedDraft ? { onUnpersistedDraft: options.onUnpersistedDraft } : {}),
    hasPending: state => state.dirty || state.submitted !== null || state.checkpoint.status === 'failed' || state.publication.rejection !== null,
    create(input) {
      const controller = options.create(input); const state = controller.getSnapshot();
      if (canonicalEditingJson(options.targetCodec.encode(state.scope.target)) !== targetKey
        || state.scope.expected.actor !== input.session.actor.identity.key || state.scope.expected.session !== input.session.stamp
        || state.scope.draftAddress.owner !== input.session.actor.identity.key || state.ownerSession !== input.ownerSession) {
        controller.dispose(); throw new TypeError('Editing binding factory returned another target or owner.');
      }
      currentController = controller; return controller;
    },
    preservation(controller, session) {
      const actual = currentController; const state = controller.getSnapshot();
      return actual?.draftStorage ? { storage: actual.draftStorage, scope: { address: state.scope.draftAddress,
        actor: session.actor.identity.key, schemaVersion: state.scope.schemaVersion,
        // Target identity belongs in the coordinator scope as well as persisted keys.
        targetKey } } : null;
    },
  }, retirementOwner);
}
