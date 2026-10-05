/** Server-only state resource adapter. Storage owns atomic receipts and CAS. */
import type {
  ActorSnapshot, Codec, IdentityError, IdentityKey, Json, OperationId, OperationLookup,
  Result,
} from './model.js';
import { err, idCodec, identityKeyCodec, ok } from './model-runtime.js';
import type { ResolvedTarget } from './server.js';
import type {
  AtomicStateStorage, StateAddress, StateDefinition, StateEnvelope, StateInvalidation,
  StateMutation, StateOutcome, StateRead, StateResource, StateSave, StateService,
  StateVersion,
} from './state.js';
import type { CommitValidator } from './server.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function decodeAddress(value: unknown): Result<StateAddress> {
  if (!isRecord(value) || !nonEmpty(value.collection) || !nonEmpty(value.recordId)) return err('invalid-input', 'Invalid state address.');
  const instanceId = idCodec('instance').decode(value.instanceId);
  const pluginId = idCodec('plugin').decode(value.pluginId);
  const owner = identityKeyCodec.decode(value.owner);
  return instanceId.ok && pluginId.ok && owner.ok
    ? ok({ instanceId: instanceId.value, pluginId: pluginId.value, collection: value.collection, recordId: value.recordId, owner: owner.value })
    : err('invalid-input', 'Invalid state address identifiers.');
}

function decodeVersion(value: unknown): Result<StateVersion> {
  return isRecord(value) && nonEmpty(value.epoch) && typeof value.sequence === 'number'
    && Number.isInteger(value.sequence) && value.sequence >= 0
    ? ok({ epoch: value.epoch, sequence: value.sequence })
    : err('invalid-input', 'Invalid state version.');
}

function decodeActor(value: unknown): Result<ActorSnapshot | null> {
  if (value === null) return ok(null);
  if (!isRecord(value) || !isRecord(value.identity) || !isRecord(value.presentation)
    || !nonEmpty(value.presentation.displayName)
    || (value.presentation.handle !== null && typeof value.presentation.handle !== 'string')
    || (value.presentation.avatarUrl !== null && typeof value.presentation.avatarUrl !== 'string')
    || !['provider-verified', 'local-user', 'upstream-default', 'integration-asserted', 'legacy', 'machine'].includes(value.evidence as string)) {
    return err('invalid-input', 'Invalid state editor snapshot.');
  }
  const key = identityKeyCodec.decode(value.identity.key);
  if (!key.ok) return key;
  const identity = value.identity;
  const presentation = { displayName: value.presentation.displayName, handle: value.presentation.handle, avatarUrl: value.presentation.avatarUrl };
  if (identity.kind === 'machine') {
    const instanceId = idCodec('instance').decode(identity.instanceId);
    if (!instanceId.ok || value.evidence !== 'machine'
      || (identity.hostId !== null && (typeof identity.hostId !== 'string' || identity.hostId.length === 0 || identity.hostId.length > 512))) {
      return err('invalid-input', 'Invalid machine editor identity.');
    }
    return ok({ identity: { kind: 'machine', key: key.value, instanceId: instanceId.value, hostId: identity.hostId }, presentation, evidence: 'machine' });
  }
  if (value.evidence === 'machine') return err('invalid-input', 'Machine evidence requires a machine identity.');
  if (identity.kind === 'person' && nonEmpty(identity.issuer) && nonEmpty(identity.subject)) {
    return ok({ identity: { kind: 'person', key: key.value, issuer: identity.issuer, subject: identity.subject }, presentation, evidence: value.evidence as ActorSnapshot['evidence'] });
  }
  if (identity.kind === 'default-user') {
    const instanceId = idCodec('instance').decode(identity.instanceId);
    return instanceId.ok
      ? ok({ identity: { kind: 'default-user', key: key.value, instanceId: instanceId.value }, presentation, evidence: value.evidence as ActorSnapshot['evidence'] })
      : instanceId;
  }
  if (identity.kind === 'external') {
    const pluginId = idCodec('plugin').decode(identity.pluginId);
    return pluginId.ok && nonEmpty(identity.subject)
      ? ok({ identity: { kind: 'external', key: key.value, pluginId: pluginId.value, subject: identity.subject }, presentation, evidence: value.evidence as ActorSnapshot['evidence'] })
      : err('invalid-input', 'Invalid external editor identity.');
  }
  return err('invalid-input', 'Invalid editor identity.');
}

function sameAddress(left: StateAddress, right: StateAddress): boolean {
  return left.instanceId === right.instanceId && left.pluginId === right.pluginId
    && left.collection === right.collection && left.recordId === right.recordId && left.owner === right.owner;
}

function decodeEnvelope<T>(value: unknown, codec: Codec<T>): Result<StateEnvelope<T>> {
  if (!isRecord(value) || typeof value.schemaVersion !== 'number' || !Number.isInteger(value.schemaVersion) || value.schemaVersion < 0) {
    return err('invalid-input', 'Invalid state envelope.');
  }
  const address = decodeAddress(value.address);
  const version = decodeVersion(value.version);
  const decoded = codec.decode(value.value);
  const editor = decodeActor(value.lastEditedBy);
  return address.ok && version.ok && decoded.ok && editor.ok
    ? ok({ address: address.value, version: version.value, schemaVersion: value.schemaVersion, value: decoded.value, lastEditedBy: editor.value })
    : err('invalid-input', 'Invalid state envelope fields.');
}

function decodeRead<T>(value: unknown, codec: Codec<T>): Result<StateRead<T>> {
  if (!isRecord(value) || typeof value.status !== 'string') return err('invalid-input', 'Invalid state read.');
  if (value.status === 'present') {
    const envelope = decodeEnvelope(value.envelope, codec);
    return envelope.ok ? ok({ status: 'present', envelope: envelope.value }) : envelope;
  }
  if (value.status === 'empty') {
    const address = decodeAddress(value.address); const version = decodeVersion(value.version);
    return address.ok && version.ok ? ok({ status: 'empty', address: address.value, version: version.value }) : err('invalid-input', 'Invalid empty state read.');
  }
  if (value.status === 'migration-required') {
    const address = decodeAddress(value.address);
    return address.ok && typeof value.storedSchemaVersion === 'number' && Number.isInteger(value.storedSchemaVersion) && value.storedSchemaVersion >= 0
      ? ok({ status: 'migration-required', address: address.value, storedSchemaVersion: value.storedSchemaVersion })
      : err('invalid-input', 'Invalid migration-required read.');
  }
  return err('invalid-input', 'Unknown state read status.');
}

function decodeMutation<T>(value: unknown, codec: Codec<T>): Result<StateMutation<T>> {
  if (!isRecord(value) || (value.kind !== 'initialize' && value.kind !== 'replace')
    || !isRecord(value.expected) || typeof value.schemaVersion !== 'number' || !Number.isInteger(value.schemaVersion)
    || value.schemaVersion < 0 || typeof value.localGeneration !== 'number' || !Number.isInteger(value.localGeneration) || value.localGeneration < 0) {
    return err('invalid-input', 'Invalid state mutation.');
  }
  const address = decodeAddress(value.address); const expectedVersion = decodeVersion(value.expectedVersion);
  const actor = identityKeyCodec.decode(value.expected.actor);
  const session = idCodec('server-session').decode(value.expected.session);
  const ownerSession = idCodec('owner-session').decode(value.ownerSession);
  const operationId = idCodec('operation').decode(value.operationId);
  const decoded = codec.decode(value.value);
  return address.ok && expectedVersion.ok && actor.ok && session.ok && ownerSession.ok && operationId.ok && decoded.ok
    ? ok({ kind: value.kind, address: address.value, expectedVersion: expectedVersion.value,
      expected: { actor: actor.value, session: session.value }, ownerSession: ownerSession.value,
      localGeneration: value.localGeneration, operationId: operationId.value, schemaVersion: value.schemaVersion, value: decoded.value })
    : err('invalid-input', 'Invalid state mutation fields.');
}

function freezeDeep<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

/** Typed in-process values cross the wire codec only after encoding. */
function cloneTyped<T>(input: T, codec: Codec<T>): Result<T> {
  try { return codec.decode(structuredClone(codec.encode(input))); }
  catch { return err('invalid-input', 'State value could not be encoded.'); }
}

/** A submitted mutation cannot retain caller-owned containers across the storage await. */
function immutableMutation<T>(input: StateMutation<T>, codec: Codec<T>): Result<StateMutation<T>> {
  const decoded = cloneTyped(input, stateCodecs(codec).mutation);
  return decoded.ok ? ok(freezeDeep(decoded.value)) : decoded;
}

function decodeOutcome<T>(value: unknown, codec: Codec<T>): Result<StateOutcome<T>> {
  if (!isRecord(value) || typeof value.status !== 'string') return err('invalid-input', 'Invalid state outcome.');
  const operationId = idCodec('operation').decode(value.operationId);
  if (!operationId.ok) return operationId;
  if (value.status === 'saved' || value.status === 'unchanged') {
    const envelope = decodeEnvelope(value.envelope, codec);
    return envelope.ok ? ok({ status: value.status, envelope: envelope.value, operationId: operationId.value }) : envelope;
  }
  if (value.status === 'already-initialized' || value.status === 'conflict') {
    const current = decodeRead(value.current, codec);
    return current.ok ? ok({ status: value.status, current: current.value, operationId: operationId.value }) : current;
  }
  return err('invalid-input', 'Unknown state outcome status.');
}

function decodeSave<T>(value: unknown, codec: Codec<T>): Result<StateSave<T>> {
  if (isRecord(value) && value.status === 'indeterminate') {
    const operationId = idCodec('operation').decode(value.operationId);
    return operationId.ok ? ok({ status: 'indeterminate', operationId: operationId.value }) : operationId;
  }
  return decodeOutcome(value, codec);
}

function assertRead<T>(read: StateRead<T>, address: StateAddress, schemaVersion: number): Result<StateRead<T>> {
  const actual = read.status === 'present' ? read.envelope.address : read.address;
  if (!sameAddress(actual, address)) return err('incompatible', 'Storage returned a state record for a different address.');
  if (read.status === 'present' && read.envelope.schemaVersion !== schemaVersion) {
    return err('incompatible', 'Storage returned an unexpected state schema.');
  }
  return ok(read);
}

function assertOutcome<T>(outcome: StateOutcome<T>, address: StateAddress, schemaVersion: number, operationId: OperationId): Result<StateOutcome<T>> {
  if (outcome.operationId !== operationId) return err('incompatible', 'Storage returned an outcome for a different operation.');
  const read = 'envelope' in outcome
    ? { status: 'present' as const, envelope: outcome.envelope }
    : outcome.current;
  const checked = assertRead(read, address, schemaVersion);
  return checked.ok ? ok(outcome) : checked;
}

function assertSave<T>(save: StateSave<T>, address: StateAddress, schemaVersion: number, operationId: OperationId): Result<StateSave<T>> {
  if (save.status === 'indeterminate') return save.operationId === operationId
    ? ok(save)
    : err('incompatible', 'Storage returned an indeterminate result for a different operation.');
  return assertOutcome(save, address, schemaVersion, operationId);
}

function addressFor(target: ResolvedTarget<'read'> | ResolvedTarget<'write'>, recordId: string, resource: StateResource<unknown>, instanceId: StateAddress['instanceId']): Result<StateAddress> {
  if (!nonEmpty(recordId)) return err('invalid-input', 'State record id is required.');
  const snapshot = target.snapshot();
  return ok({ instanceId, pluginId: resource.pluginId, collection: resource.definition.collection, recordId, owner: snapshot.subject.key });
}

/** Stable, delimiter-safe address key for local maps; never an authorization token. */
export function stateAddressKey(address: StateAddress): string {
  return JSON.stringify([address.instanceId, address.pluginId, address.collection, address.recordId, address.owner]);
}

export function createStateService<T>(options: {
  readonly instanceId: StateAddress['instanceId']; readonly pluginId: StateAddress['pluginId']; readonly definition: StateDefinition<T>;
  readonly storage: AtomicStateStorage<T>; readonly commits: CommitValidator;
  readonly publish: (event: StateInvalidation) => void;
}): StateService<T> {
  const resource: StateResource<T> = { pluginId: options.pluginId, definition: options.definition };
  const codecs = stateCodecs(options.definition.codec);
  const staticMutation = (target: ResolvedTarget<'write'>, mutation: StateMutation<T>): Result<void> => {
    const expected = addressFor(target, mutation.address.recordId, resource, options.instanceId);
    if (!expected.ok) return expected;
    const snapshot = target.snapshot();
    return sameAddress(mutation.address, expected.value)
      && mutation.schemaVersion === options.definition.schemaVersion
      && mutation.expected.actor === snapshot.expected.actor && mutation.expected.session === snapshot.expected.session
      ? ok(undefined)
      : err('invalid-input', 'Mutation does not match this state resource and target.');
  };
  return {
    async read(target, recordId, readOptions) {
      if (target.signal.aborted) return err('expired', 'The request context is no longer live.');
      const address = addressFor(target, recordId, resource, options.instanceId);
      if (!address.ok) return address;
      const result = await options.storage.read(address.value, readOptions);
      if (!result.ok) return result;
      const decoded = cloneTyped(result.value, codecs.read);
      return decoded.ok ? assertRead(decoded.value, address.value, options.definition.schemaVersion) : decoded;
    },
    async save(target, mutation, readOptions) {
      const submitted = immutableMutation(mutation, options.definition.codec);
      if (!submitted.ok) return submitted;
      const valid = staticMutation(target, submitted.value);
      if (!valid.ok) return valid;
      const targetSnapshot = target.snapshot();
      const expected = Object.freeze({ actor: targetSnapshot.expected.actor, session: targetSnapshot.expected.session });
      const subject = targetSnapshot.subject.key;
      const editor = freezeDeep({
        identity: { ...targetSnapshot.actor.identity }, presentation: { ...targetSnapshot.actor.presentation }, evidence: targetSnapshot.actor.evidence,
      }) as ActorSnapshot;
      const committed = await options.storage.commit({
        mutation: submitted.value,
        validateAtCommit: () => {
          if (readOptions?.signal?.aborted) return err('cancelled', 'State save was cancelled before durable acceptance.');
          const scope = { instanceId: options.instanceId, pluginId: options.pluginId,
            collection: options.definition.collection, recordId: submitted.value.address.recordId,
            subject, expected,
            schemaVersion: options.definition.schemaVersion };
          const live = options.commits.validate(target, scope);
          return live.ok ? ok(editor) : live;
        },
      });
      if (!committed.ok) return committed;
      const decoded = cloneTyped(committed.value, codecs.save);
      if (!decoded.ok) return decoded;
      const checked = assertSave(decoded.value, submitted.value.address, options.definition.schemaVersion, submitted.value.operationId);
      if (!checked.ok) return checked;
      const outcome = checked.value;
      const publishedEnvelope = outcome.status === 'saved' ? outcome.envelope
        : outcome.status === 'already-initialized' && outcome.current.status === 'present' ? outcome.current.envelope : null;
      if (publishedEnvelope) {
        try {
          options.publish({ address: publishedEnvelope.address, version: publishedEnvelope.version, operationId: outcome.operationId });
        } catch { /* durable result remains final; a later receipt replay may notify again. */ }
      }
      return ok(outcome);
    },
    async reconcile(target, recordId, operationId) {
      const address = addressFor(target, recordId, resource, options.instanceId);
      if (!address.ok) return address;
      const result = await options.storage.reconcile({ address: address.value, operationId });
      if (!result.ok) return result;
      const decoded = cloneTyped(result.value, codecs.lookup);
      if (!decoded.ok || decoded.value.status !== 'final') return decoded;
      const checked = assertOutcome(decoded.value.outcome, address.value, options.definition.schemaVersion, operationId);
      return checked.ok ? ok({ status: 'final', outcome: checked.value }) : checked;
    },
  };
}

function decodeLookup<T>(value: unknown, codec: Codec<T>): Result<OperationLookup<StateOutcome<T>>> {
  if (!isRecord(value) || typeof value.status !== 'string') return err('invalid-input', 'Invalid state lookup.');
  if (value.status === 'final') { const outcome = decodeOutcome(value.outcome, codec); return outcome.ok ? ok({ status: 'final', outcome: outcome.value }) : outcome; }
  if (value.status === 'pending') return ok({ status: 'pending' });
  if (value.status === 'absent-final' && value.retry === 'same-operation-only') return ok({ status: 'absent-final', retry: 'same-operation-only' });
  if (value.status === 'unknown' && (value.reason === 'unsupported' || value.reason === 'expired' || value.reason === 'unavailable')) return ok({ status: 'unknown', reason: value.reason });
  return err('invalid-input', 'Invalid state lookup metadata.');
}

function encodeAddress(address: StateAddress): Json { return { instanceId: address.instanceId, pluginId: address.pluginId, collection: address.collection, recordId: address.recordId, owner: address.owner }; }
function encodeVersion(version: StateVersion): Json { return { epoch: version.epoch, sequence: version.sequence }; }
function encodeActor(actor: ActorSnapshot | null): Json {
  return actor === null ? null : { identity: actor.identity as unknown as Json, presentation: actor.presentation as unknown as Json, evidence: actor.evidence };
}
function encodeEnvelope<T>(envelope: StateEnvelope<T>, codec: Codec<T>): Json {
  return { address: encodeAddress(envelope.address), version: encodeVersion(envelope.version), schemaVersion: envelope.schemaVersion, value: codec.encode(envelope.value), lastEditedBy: encodeActor(envelope.lastEditedBy) };
}
function encodeRead<T>(read: StateRead<T>, codec: Codec<T>): Json {
  return read.status === 'present' ? { status: 'present', envelope: encodeEnvelope(read.envelope, codec) }
    : read.status === 'empty' ? { status: 'empty', address: encodeAddress(read.address), version: encodeVersion(read.version) }
    : read.status === 'migration-required' ? { status: 'migration-required', address: encodeAddress(read.address), storedSchemaVersion: read.storedSchemaVersion }
    : (() => { throw new TypeError('Invalid state read status.'); })();
}
function encodeMutation<T>(mutation: StateMutation<T>, codec: Codec<T>): Json {
  return { ...mutation, address: encodeAddress(mutation.address), expectedVersion: encodeVersion(mutation.expectedVersion), value: codec.encode(mutation.value) } as unknown as Json;
}
function encodeOutcome<T>(outcome: StateOutcome<T>, codec: Codec<T>): Json {
  if (outcome.status === 'saved' || outcome.status === 'unchanged') {
    return { status: outcome.status, envelope: encodeEnvelope(outcome.envelope, codec), operationId: outcome.operationId };
  }
  if ('current' in outcome) return { status: outcome.status, current: encodeRead(outcome.current, codec), operationId: outcome.operationId };
  throw new TypeError('Invalid state outcome.');
}
function encodeSave<T>(save: StateSave<T>, codec: Codec<T>): Json {
  return save.status === 'indeterminate' ? { status: 'indeterminate', operationId: save.operationId } : encodeOutcome(save, codec);
}

/** Runtime codecs reject malformed storage metadata before it reaches a feature. */
export function stateCodecs<T>(value: Codec<T>): {
  readonly read: Codec<StateRead<T>>; readonly mutation: Codec<StateMutation<T>>;
  readonly save: Codec<StateSave<T>>; readonly invalidation: Codec<StateInvalidation>;
  readonly lookup: Codec<OperationLookup<StateOutcome<T>>>;
} {
  return {
    read: { decode: (input) => decodeRead(input, value), encode: (input) => encodeRead(input, value) },
    mutation: { decode: (input) => decodeMutation(input, value), encode: (input) => encodeMutation(input, value) },
    save: { decode: (input) => decodeSave(input, value), encode: (input) => encodeSave(input, value) },
    invalidation: {
      decode(input) {
        if (!isRecord(input)) return err('invalid-input', 'Invalid state invalidation.');
        const address = decodeAddress(input.address); const version = decodeVersion(input.version);
        const operationId = input.operationId === null ? ok(null) : idCodec('operation').decode(input.operationId);
        return address.ok && version.ok && operationId.ok ? ok({ address: address.value, version: version.value, operationId: operationId.value }) : err('invalid-input', 'Invalid state invalidation fields.');
      }, encode: (input) => ({ address: encodeAddress(input.address), version: encodeVersion(input.version), operationId: input.operationId }),
    },
    lookup: {
      decode: (input) => decodeLookup(input, value), encode: (input) => input.status === 'final' ? { status: 'final', outcome: encodeOutcome(input.outcome, value) }
        : input as unknown as Json,
    },
  };
}
