/** Versioned opt-in wire contract. Legacy state codecs remain closed. */
import type { Codec, Json, OperationLookup, Result } from './model.js';
import type { EditingDraft, EditingReceipt, EditingRequest, EditingSave, EditingScope } from './editing.js';
import { err, idCodec, identityKeyCodec, ok } from './model-runtime.js';
import { stateAddressKey, stateCodecs } from './state-service-runtime.js';
export const EDITING_PROTOCOL = 'bb-identity.editing/v1' as const;
export const EDITING_LIMITS = Object.freeze({ bytes: 4 * 1024 * 1024, diagnostics: 64, message: 4096, code: 128, path: 32 });
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
function bounded(input: unknown): boolean { try { return new TextEncoder().encode(JSON.stringify(input)).byteLength <= EDITING_LIMITS.bytes; } catch { return false; } }
function keys(input: Record<string, unknown>, allowed: readonly string[]): boolean { return Object.keys(input).every(key => allowed.includes(key)); }
/** Semantic request equality ignores object field order, never values or metadata. */
export function canonicalEditingJson(value: Json): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalEditingJson).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalEditingJson((value as { readonly [key: string]: Json })[key]!)}`).join(',')}}`;
}
export function editingCodecs<T, Target>(value: Codec<T>, target: Codec<Target>): {
  scope: Codec<EditingScope<Target>>;
  request: Codec<EditingRequest<T, Target>>; receipt: Codec<EditingReceipt<T, Target>>;
  save: Codec<EditingSave<T, Target>>; lookup: Codec<OperationLookup<EditingReceipt<T, Target>>>;
  draft: Codec<EditingDraft<T, Target>>;
} {
  const state = stateCodecs(value);
  const invalid = () => err('invalid-input', 'Malformed editing/v1 data.');
  const scope: Codec<EditingScope<Target>> = {
    decode(input) {
      if (!bounded(input) || !record(input) || !keys(input, ['draftAddress', 'schemaVersion', 'target', 'expected'])
        || !record(input.draftAddress) || !keys(input.draftAddress, ['instanceId', 'pluginId', 'collection', 'recordId', 'owner'])
        || !record(input.expected) || !keys(input.expected, ['actor', 'session'])
        || !Number.isSafeInteger(input.schemaVersion) || Number(input.schemaVersion) < 0) return invalid();
      const address = input.draftAddress;
      if (typeof address.collection !== 'string' || !address.collection.length || typeof address.recordId !== 'string' || !address.recordId.length) return invalid();
      // Public primitive codecs retain the same address/session semantics as state.
      // A load has no operation, expected revision, or submitted value to fabricate.
      const instanceId = idCodec('instance').decode(address.instanceId);
      const pluginId = idCodec('plugin').decode(address.pluginId);
      const owner = identityKeyCodec.decode(address.owner);
      const actor = identityKeyCodec.decode(input.expected.actor);
      const session = idCodec('server-session').decode(input.expected.session);
      const selected = target.decode(input.target);
      if (!instanceId.ok || !pluginId.ok || !owner.ok || !actor.ok || !session.ok || !selected.ok || owner.value !== actor.value) return invalid();
      return ok({ draftAddress: { instanceId: instanceId.value, pluginId: pluginId.value, collection: address.collection, recordId: address.recordId, owner: owner.value },
        schemaVersion: Number(input.schemaVersion), target: selected.value, expected: { actor: actor.value, session: session.value } });
    },
    encode(input) {
      return { draftAddress: { instanceId: idCodec('instance').encode(input.draftAddress.instanceId),
        pluginId: idCodec('plugin').encode(input.draftAddress.pluginId), collection: input.draftAddress.collection,
        recordId: input.draftAddress.recordId, owner: identityKeyCodec.encode(input.draftAddress.owner) },
        schemaVersion: input.schemaVersion, target: target.encode(input.target),
        expected: { actor: identityKeyCodec.encode(input.expected.actor), session: idCodec('server-session').encode(input.expected.session) } };
    },
  };
  const request: Codec<EditingRequest<T, Target>> = {
    decode(input) {
      if (!bounded(input) || !record(input) || !keys(input, ['protocol', 'target', 'mutation']) || input.protocol !== EDITING_PROTOCOL) return invalid();
      if (!record(input.mutation) || !keys(input.mutation, ['kind', 'address', 'expectedVersion', 'expected', 'ownerSession', 'localGeneration', 'operationId', 'schemaVersion', 'value'])) return invalid();
      const selected = target.decode(input.target); const mutation = state.mutation.decode(input.mutation);
      if (!selected.ok || !mutation.ok || mutation.value.address.owner !== mutation.value.expected.actor) return invalid();
      return ok({ protocol: EDITING_PROTOCOL, target: selected.value, mutation: mutation.value });
    },
    encode(input) { return { protocol: input.protocol, target: target.encode(input.target), mutation: state.mutation.encode(input.mutation) }; },
  };
  const receipt: Codec<EditingReceipt<T, Target>> = {
    decode(input) {
      if (!bounded(input) || !record(input) || input.protocol !== EDITING_PROTOCOL) return invalid();
      const submitted = request.decode(input.request); if (!submitted.ok || !record(input.outcome)) return invalid();
      const outcome = input.outcome;
      if (outcome.status === 'rejected') {
        const operation = idCodec('operation').decode(outcome.operationId);
        if (!operation.ok || operation.value !== submitted.value.mutation.operationId || !Array.isArray(outcome.diagnostics)
          || !outcome.diagnostics.length || outcome.diagnostics.length > EDITING_LIMITS.diagnostics) return invalid();
        const diagnostics = [];
        for (const diagnostic of outcome.diagnostics) {
          if (!record(diagnostic) || typeof diagnostic.code !== 'string' || !diagnostic.code.length || diagnostic.code.length > EDITING_LIMITS.code
            || typeof diagnostic.message !== 'string' || !diagnostic.message.length || diagnostic.message.length > EDITING_LIMITS.message) return invalid();
          if (diagnostic.path !== undefined && (!Array.isArray(diagnostic.path) || diagnostic.path.length > EDITING_LIMITS.path
            || diagnostic.path.some(part => typeof part !== 'string' && !(typeof part === 'number' && Number.isSafeInteger(part) && part >= 0))
            || diagnostic.path.some(part => typeof part === 'string' && part.length > EDITING_LIMITS.message))) return invalid();
          diagnostics.push({ code: diagnostic.code, message: diagnostic.message, ...(diagnostic.path !== undefined ? { path: diagnostic.path as (string | number)[] } : {}) });
        }
        return ok({ protocol: EDITING_PROTOCOL, request: submitted.value, outcome: { status: 'rejected', operationId: operation.value, diagnostics } });
      }
      const parsed = state.save.decode(outcome);
      if (!parsed.ok || parsed.value.status === 'indeterminate' || parsed.value.operationId !== submitted.value.mutation.operationId) return invalid();
      const read = 'envelope' in parsed.value ? { status: 'present' as const, envelope: parsed.value.envelope } : parsed.value.current;
      const address = read.status === 'present' ? read.envelope.address : read.address;
      if (stateAddressKey(address) !== stateAddressKey(submitted.value.mutation.address)
        || read.status === 'present' && read.envelope.schemaVersion !== submitted.value.mutation.schemaVersion) return invalid();
      return ok({ protocol: EDITING_PROTOCOL, request: submitted.value, outcome: parsed.value });
    },
    encode(input) { return { protocol: input.protocol, request: request.encode(input.request), outcome: input.outcome.status === 'rejected'
      ? { status: 'rejected', operationId: input.outcome.operationId, diagnostics: input.outcome.diagnostics as unknown as Json }
      : state.save.encode(input.outcome) }; },
  };
  const save: Codec<EditingSave<T, Target>> = {
    decode(input) {
      if (record(input) && input.protocol === EDITING_PROTOCOL && input.status === 'indeterminate') {
        const operation = idCodec('operation').decode(input.operationId);
        return operation.ok ? ok({ protocol: EDITING_PROTOCOL, status: 'indeterminate', operationId: operation.value }) : invalid();
      }
      return receipt.decode(input);
    },
    encode(input) { return 'status' in input ? { protocol: input.protocol, status: input.status, operationId: input.operationId } : receipt.encode(input); },
  };
  const lookup: Codec<OperationLookup<EditingReceipt<T, Target>>> = {
    decode(input) {
      if (!bounded(input) || !record(input)) return invalid();
      if (input.status === 'final') { const parsed = receipt.decode(input.outcome); return parsed.ok ? ok({ status: 'final', outcome: parsed.value }) : parsed; }
      if (input.status === 'pending') return ok({ status: 'pending' });
      if (input.status === 'absent-final' && input.retry === 'same-operation-only') return ok({ status: 'absent-final', retry: 'same-operation-only' });
      if (input.status === 'unknown' && ['unsupported', 'expired', 'unavailable'].includes(String(input.reason))) return ok({ status: 'unknown', reason: input.reason as 'unsupported' | 'expired' | 'unavailable' });
      return invalid();
    },
    encode(input) { return input.status === 'final' ? { status: 'final', outcome: receipt.encode(input.outcome) } : { ...input }; },
  };
  const draft: Codec<EditingDraft<T, Target>> = {
    decode(input) {
      if (!bounded(input) || !record(input) || input.protocol !== EDITING_PROTOCOL || !record(input.draft)) return invalid();
      const selected = target.decode(input.target); const raw = input.draft;
      if (!selected.ok || raw.formatVersion !== 1 || !record(raw.key) || !Number.isSafeInteger(raw.schemaVersion) || Number(raw.schemaVersion) < 0
        || !Number.isSafeInteger(raw.localGeneration) || Number(raw.localGeneration) < 0) return invalid();
      const acknowledged = state.read.decode(raw.acknowledged); const desired = value.decode(raw.desired);
      const actor = identityKeyCodec.decode(raw.key.actor); const ownerSession = idCodec('owner-session').decode(raw.key.ownerSession);
      if (!acknowledged.ok || acknowledged.value.status === 'migration-required' || !desired.ok || !actor.ok || !ownerSession.ok) return invalid();
      const readAddress = acknowledged.value.status === 'present' ? acknowledged.value.envelope.address : acknowledged.value.address;
      if (!record(raw.key.address) || canonicalEditingJson(raw.key.address as Json) !== canonicalEditingJson(readAddress as unknown as Json)
        || readAddress.owner !== actor.value || acknowledged.value.status === 'present' && acknowledged.value.envelope.schemaVersion !== raw.schemaVersion) return invalid();
      const inFlight = raw.inFlight === null ? ok(null) : state.mutation.decode(raw.inFlight);
      if (!inFlight.ok || inFlight.value && (stateAddressKey(inFlight.value.address) !== stateAddressKey(readAddress)
        || inFlight.value.expected.actor !== actor.value
        || inFlight.value.schemaVersion !== raw.schemaVersion || inFlight.value.localGeneration > Number(raw.localGeneration))) return invalid();
      const rejection = input.rejection === null ? ok(null) : receipt.decode(input.rejection);
      if (!rejection.ok || rejection.value && (rejection.value.outcome.status !== 'rejected'
        || stateAddressKey(rejection.value.request.mutation.address) !== stateAddressKey(readAddress)
        || rejection.value.request.mutation.schemaVersion !== raw.schemaVersion
        || rejection.value.request.mutation.localGeneration > Number(raw.localGeneration)
        || inFlight.value !== null && (rejection.value.request.mutation.operationId === inFlight.value.operationId
          || rejection.value.request.mutation.localGeneration >= inFlight.value.localGeneration)
        || canonicalEditingJson(target.encode(rejection.value.request.target)) !== canonicalEditingJson(target.encode(selected.value)))) return invalid();
      return ok({ protocol: EDITING_PROTOCOL, target: selected.value, rejection: rejection.value,
        draft: { formatVersion: 1, key: { address: readAddress, actor: actor.value, ownerSession: ownerSession.value },
          schemaVersion: Number(raw.schemaVersion), acknowledged: acknowledged.value, desired: desired.value,
          localGeneration: Number(raw.localGeneration), inFlight: inFlight.value } });
    },
    encode(input) {
      const raw = input.draft;
      return { protocol: input.protocol, target: target.encode(input.target), rejection: input.rejection ? receipt.encode(input.rejection) : null,
        draft: { formatVersion: 1, key: raw.key as unknown as Json, schemaVersion: raw.schemaVersion,
          acknowledged: state.read.encode(raw.acknowledged), desired: value.encode(raw.desired), localGeneration: raw.localGeneration,
          inFlight: raw.inFlight ? state.mutation.encode(raw.inFlight) : null } };
    },
  };
  return { scope, request, receipt, save, lookup, draft };
}
