/** Portable host adapter runtime. Enhanced-host values are decoded before normalization. */
import type {
  AcceptanceOutcome, Codec, Contribution, ExecutionProvenance, IdentityError,
  IdentityProfile, Json, OperationLookup, PersonReference, Result, SendInput, Wire,
} from './model.js';
import {
  err, idCodec, identityKeyCodec, ok, profileCodec, provenanceCodec,
} from './model-runtime.js';
import type {
  Directory, Participant, ParticipantReader, ReadOptions, RequestExpectation, Unsubscribe,
} from './model.js';
import type {
  ExternalAuthorInput, ExtensionDiscovery, ForkIdentityProtocolV1, ForkIdentityProvider, ForkProviderRegistration, HostInvalidation,
  ForkRequestHandle, ForkInvocationScope, HostRequestHandle, IdentityCapabilities, IdentityHost, IdentityProvider, ProviderDirectorySource,
  LiveRequest, ProviderRegistrationV1, ServerSession, UpstreamDriver,
} from './host.js';
import type { EvidencePage, ContributionQuery, AttemptQuery } from './model.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function unavailable(message: string): IdentityError {
  return { code: 'unavailable', message, retry: 'after-reconnect' };
}

function isPresentation(value: unknown): boolean {
  return isRecord(value) && typeof value.displayName === 'string'
    && (value.handle === null || typeof value.handle === 'string')
    && (value.avatarUrl === null || typeof value.avatarUrl === 'string');
}

function isPersonIdentity(value: unknown): boolean {
  if (!isRecord(value) || !identityKeyCodec.decode(value.key).ok) return false;
  return value.kind === 'person'
    ? typeof value.issuer === 'string' && typeof value.subject === 'string'
    : value.kind === 'default-user' && idCodec('instance').decode(value.instanceId).ok;
}

function isMachineIdentity(value: unknown): boolean {
  return isRecord(value) && value.kind === 'machine'
    && identityKeyCodec.decode(value.key).ok
    && idCodec('instance').decode(value.instanceId).ok
    && (value.hostId === null || typeof value.hostId === 'string' && value.hostId.length > 0 && value.hostId.length <= 512);
}

function isActorIdentity(value: unknown): boolean {
  return isPersonIdentity(value) || isMachineIdentity(value);
}

function isCapabilities(value: unknown): boolean {
  return isRecord(value)
    && (value.requestIdentity === 'singleton' || value.requestIdentity === 'host-resolved')
    && (value.acceptance === 'pre-dispatch-check' || value.acceptance === 'transactional-check')
    && (value.forwarding === 'singleton-convention' || value.forwarding === 'host-bound')
    && isRecord(value.directory) && typeof value.directory.search === 'boolean' && typeof value.directory.lookup === 'boolean'
    && typeof value.participants === 'boolean'
    && (value.externalSend === 'source-labelled' || value.externalSend === 'structured')
    && (value.toolProvenance === 'unknown' || value.toolProvenance === 'partial' || value.toolProvenance === 'causal')
    && typeof value.operationLookup === 'boolean';
}

function unsupported(message: string): IdentityError {
  return { code: 'unsupported', message, retry: 'never' };
}

function asResult<T>(value: unknown): Result<T> {
  if (!isRecord(value) || typeof value.ok !== 'boolean') return err('incompatible', 'Host returned a malformed Result.');
  if (value.ok) return 'value' in value
    ? ok(value.value as T)
    : err('incompatible', 'Host returned a successful Result without a value.');
  const failure = decodeError(value.error);
  return failure.ok ? { ok: false, error: failure.value } : failure;
}

function decodeError(value: unknown): Result<IdentityError> {
  const codes = new Set<IdentityError['code']>([
    'unavailable', 'unauthenticated', 'unsupported', 'incompatible', 'invalid-input', 'not-found',
    'ambiguous', 'stale-owner', 'stale-context', 'conflict', 'cancelled', 'disposed', 'limit-exceeded',
    'invalid-operation', 'expired',
  ]);
  const retries = new Set<IdentityError['retry']>(['never', 'after-refresh', 'after-reconnect', 'same-operation']);
  return isRecord(value) && typeof value.code === 'string' && codes.has(value.code as IdentityError['code'])
    && typeof value.message === 'string' && typeof value.retry === 'string' && retries.has(value.retry as IdentityError['retry'])
    ? ok(value as unknown as IdentityError)
    : err('incompatible', 'Host returned a malformed identity error.');
}

function isReference(value: unknown): boolean {
  return isRecord(value) && idCodec('thread').decode(value.threadId).ok && idCodec('contribution').decode(value.contributionId).ok;
}

function isNativeIds(value: unknown): boolean {
  return isRecord(value) && ['deliveryId', 'queuedMessageId', 'turnId'].every((key) => value[key] === null || typeof value[key] === 'string');
}

/** Decode raw acceptance directly: `accept` is an outcome, unlike lookup's Result envelope. */
function decodeAcceptance(value: unknown): Result<AcceptanceOutcome> {
  if (!isRecord(value) || typeof value.status !== 'string') return err('incompatible', 'Host returned a malformed acceptance outcome.');
  if (value.status === 'rejected') {
    const error = decodeError(value.error);
    return error.ok ? ok({ status: 'rejected', error: error.value }) : error;
  }
  if (value.status === 'indeterminate') {
    const operationId = idCodec('operation').decode(value.operationId);
    return operationId.ok && typeof value.message === 'string'
      ? ok({ status: 'indeterminate', operationId: operationId.value, message: value.message })
      : err('incompatible', 'Host returned malformed indeterminate acceptance metadata.');
  }
  if (value.status !== 'submitted' || !isRecord(value.receipt)) return err('incompatible', 'Host returned an unknown acceptance outcome.');
  const receipt = value.receipt;
  const operationId = idCodec('operation').decode(receipt.operationId);
  if (!operationId.ok || !isNativeIds(receipt.native)) return err('incompatible', 'Host returned malformed acceptance receipt identifiers.');
  if (receipt.evidence === 'host-accepted') {
    return typeof receipt.acceptedAt === 'string' && Array.isArray(receipt.references) && receipt.references.every(isReference)
      && receipt.provenance === 'structured' && receipt.deduplication === 'guaranteed' && typeof receipt.retainedUntil === 'string'
      ? ok(value as unknown as AcceptanceOutcome)
      : err('incompatible', 'Host returned malformed durable acceptance metadata.');
  }
  if (receipt.evidence === 'upstream-response') {
    return receipt.acceptedAt === null && receipt.references === null
      && (receipt.provenance === 'source-labelled' || receipt.provenance === 'upstream-default')
      && receipt.deduplication === 'not-guaranteed'
      ? ok(value as unknown as AcceptanceOutcome)
      : err('incompatible', 'Host returned malformed upstream acceptance metadata.');
  }
  return err('incompatible', 'Host returned an unknown acceptance receipt evidence value.');
}

function decodeLookup(value: unknown): Result<OperationLookup<AcceptanceOutcome>> {
  if (!isRecord(value) || typeof value.status !== 'string') return err('incompatible', 'Host returned a malformed operation lookup.');
  if (value.status === 'final') {
    const outcome = decodeAcceptance(value.outcome);
    return outcome.ok ? ok({ status: 'final', outcome: outcome.value }) : outcome;
  }
  if (value.status === 'pending') return ok({ status: 'pending' });
  if (value.status === 'absent-final' && value.retry === 'same-operation-only') return ok({ status: 'absent-final', retry: 'same-operation-only' });
  if (value.status === 'unknown' && (value.reason === 'unsupported' || value.reason === 'expired' || value.reason === 'unavailable')) {
    return ok({ status: 'unknown', reason: value.reason });
  }
  return err('incompatible', 'Host returned malformed operation lookup metadata.');
}

/** Runtime counterpart for serverSessionCodec. Kept here because it validates a host boundary. */
export const serverSessionCodec: Codec<ServerSession> = {
  decode(input: unknown): Result<ServerSession> {
    if (!isRecord(input) || typeof input.status !== 'string' || !identityKeyCodec.decode(input.instanceId).ok) {
      return err('invalid-input', 'Invalid server session.');
    }
    if (input.status !== 'ready') {
      if ((input.status === 'unavailable' || input.status === 'unauthenticated' || input.status === 'incompatible') && isRecord(input.error)) {
        return ok(input as ServerSession);
      }
      return err('invalid-input', 'Invalid unavailable server session.');
    }
    if (!isRecord(input.actor) || !isActorIdentity(input.actor.identity) || !isPresentation(input.actor.presentation)
      || (input.actor.evidence !== 'provider-verified' && input.actor.evidence !== 'local-user'
        && input.actor.evidence !== 'upstream-default' && input.actor.evidence !== 'integration-asserted'
        && input.actor.evidence !== 'legacy' && input.actor.evidence !== 'machine')
      || isMachineIdentity(input.actor.identity) !== (input.actor.evidence === 'machine')
      || !isCapabilities(input.capabilities)
      || typeof input.stamp !== 'string' || (input.mode !== 'single-user' && input.mode !== 'multi-user')) {
      return err('invalid-input', 'Invalid ready server session.');
    }
    return ok(input as ServerSession);
  },
  encode(value) {
    return value as unknown as Json;
  },
};

function unsupportedDirectory(): Directory {
  return {
    search: async () => err('unsupported', 'Directory search is unavailable.'),
    getMany: async () => err('unsupported', 'Directory lookup is unavailable.'),
    subscribe: () => () => {},
  };
}

function unsupportedParticipants(): ParticipantReader {
  return {
    list: async () => err('unsupported', 'Participant history is unavailable.'),
    previews: async () => err('unsupported', 'Participant previews are unavailable.'),
  };
}

function unsupportedHistory() {
  return {
    contributions: async (_query: ContributionQuery): Promise<Result<EvidencePage<Contribution>>> =>
      ok({ status: 'unavailable', reason: 'unsupported' }),
    attempts: async (_query: AttemptQuery): Promise<Result<EvidencePage<ExecutionProvenance>>> =>
      ok({ status: 'unavailable', reason: 'unsupported' }),
  };
}

function isProfilePresentation(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const displayName = value.displayName; const handle = value.handle; const avatarUrl = value.avatarUrl;
  return typeof displayName === 'string' && displayName.length > 0 && displayName.length <= 512
    && (handle === null || typeof handle === 'string' && handle.length > 0 && handle.length <= 512)
    && (avatarUrl === null || typeof avatarUrl === 'string' && avatarUrl.length > 0 && avatarUrl.length <= 2_048);
}

function isExternalIdentity(value: unknown): boolean {
  return isRecord(value) && value.kind === 'external' && identityKeyCodec.decode(value.key).ok
    && idCodec('plugin').decode(value.pluginId).ok && idCodec('subject').decode(value.subject).ok;
}

function isParticipant(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const roles = value.roles;
  return (isActorIdentity(value.identity) || isExternalIdentity(value.identity)) && isProfilePresentation(value.presentation)
    && Array.isArray(roles) && roles.length > 0 && new Set(roles).size === roles.length
    && roles.every((role) => role === 'author' || role === 'editor' || role === 'mentioned' || role === 'interaction-resolver');
}

function decodeParticipantPage(value: unknown): Result<Awaited<ReturnType<ParticipantReader['list']>> extends Result<infer Page> ? Page : never> {
  if (!isRecord(value) || !Array.isArray(value.items) || (value.nextCursor !== null && !idCodec('cursor').decode(value.nextCursor).ok)
    || !idCodec('revision').decode(value.revision).ok || (value.coverage !== 'complete-history' && value.coverage !== 'partial-history')) {
    return err('incompatible', 'Host returned a malformed participant page.');
  }
  const items: Participant[] = [];
  for (const item of value.items) {
    if (!isParticipant(item) || !isRecord(item) || !Array.isArray(item.roles)) return err('incompatible', 'Host returned a malformed participant item.');
    const identity = profileCodec.decode({ identity: item.identity, presentation: item.presentation, revision: 'participant', status: 'current' });
    if (!identity.ok) return err('incompatible', 'Host returned a malformed participant identity.');
    items.push({ identity: identity.value.identity, presentation: identity.value.presentation, roles: [...item.roles] as Participant['roles'] });
  }
  const cursor = value.nextCursor === null ? null : idCodec('cursor').decode(value.nextCursor);
  const revision = idCodec('revision').decode(value.revision);
  if ((cursor !== null && !cursor.ok) || !revision.ok) return err('incompatible', 'Host returned malformed participant identifiers.');
  return ok({ items, nextCursor: cursor === null ? null : cursor.value, revision: revision.value, coverage: value.coverage });
}

function isContribution(value: unknown): boolean {
  if (!isRecord(value) || !isReference(value.reference) || typeof value.acceptedAt !== 'string' || value.acceptedAt.length === 0 || value.acceptedAt.length > 256
    || !Array.isArray(value.mentionedPeople) || !value.mentionedPeople.every(isPersonIdentity)) return false;
  const snapshot = (candidate: unknown) => {
    if (!isRecord(candidate) || !(isActorIdentity(candidate.identity) || isExternalIdentity(candidate.identity))
      || !isProfilePresentation(candidate.presentation)) return false;
    const evidence = candidate.evidence;
    if (!['provider-verified', 'local-user', 'upstream-default', 'integration-asserted', 'legacy', 'machine'].includes(evidence as string)) return false;
    return isMachineIdentity(candidate.identity) ? evidence === 'machine' : evidence !== 'machine';
  };
  const origin = value.author;
  if (!isRecord(origin)) return false;
  const validOrigin = origin.kind === 'person' ? snapshot(origin.actor) && isRecord(origin.actor) && isPersonIdentity(origin.actor.identity)
    : origin.kind === 'machine' ? snapshot(origin.actor) && isRecord(origin.actor) && isMachineIdentity(origin.actor.identity)
    : origin.kind === 'external' ? snapshot(origin.actor) && isRecord(origin.actor) && isExternalIdentity(origin.actor.identity)
      : origin.kind === 'agent' ? origin.agentId === null || idCodec('agent').decode(origin.agentId).ok
        : origin.kind === 'system' ? typeof origin.reason === 'string' && origin.reason.length > 0 && origin.reason.length <= 1_024
          : origin.kind === 'unknown' && (origin.reason === 'legacy' || origin.reason === 'upstream-unattributed' || origin.reason === 'missing-source');
  return validOrigin && (value.latestEditor === null || snapshot(value.latestEditor));
}

function decodeEvidencePage<T>(value: unknown, decodeItem: (item: unknown) => boolean): Result<EvidencePage<T>> {
  if (!isRecord(value) || typeof value.status !== 'string') return err('incompatible', 'Host returned a malformed evidence page.');
  if (value.status === 'pending') return ok({ status: 'pending' });
  if (value.status === 'unavailable') return value.reason === 'unsupported' || value.reason === 'missing-history' || value.reason === 'outage'
    ? ok({ status: 'unavailable', reason: value.reason }) : err('incompatible', 'Host returned an invalid evidence-unavailable reason.');
  if ((value.status !== 'known' && value.status !== 'partial') || !Array.isArray(value.items) || !value.items.every(decodeItem)
    || !Array.isArray(value.missing) || !value.missing.every((missing) => typeof missing === 'string' && missing.length > 0 && missing.length <= 512)
    || (value.nextCursor !== null && !idCodec('cursor').decode(value.nextCursor).ok)
    || (value.traversal !== 'complete' && value.traversal !== 'continued')
    || value.status === 'known' && value.missing.length !== 0) return err('incompatible', 'Host returned malformed evidence metadata.');
  return ok(value as EvidencePage<T>);
}

function validContributionQuery(query: ContributionQuery): boolean {
  const cursor = query.cursor === undefined || idCodec('cursor').decode(query.cursor).ok;
  const limit = query.limit === undefined || Number.isInteger(query.limit) && query.limit >= 1 && query.limit <= 200;
  if (!cursor || !limit) return false;
  return query.kind === 'references' ? query.references.length <= 100 && query.references.every(isReference)
    : idCodec('thread').decode(query.threadId).ok && idCodec(query.kind === 'native-message' ? 'message' : 'event').decode(query.kind === 'native-message' ? query.messageId : query.eventId).ok;
}

function validAttemptQuery(query: AttemptQuery): boolean {
  return (query.cursor === undefined || idCodec('cursor').decode(query.cursor).ok)
    && (query.limit === undefined || Number.isInteger(query.limit) && query.limit >= 1 && query.limit <= 200)
    && (query.kind === 'operation' ? idCodec('operation').decode(query.operationId).ok : isReference(query.reference));
}

type DirectoryMapping = { readonly generation: string; readonly issuer: string; readonly subject: string };

/** Matches the enhanced host's provider-registry keyFor without exposing key parsing to features. */
function decodeP6rPersonKey(key: string): { readonly issuer: string; readonly subject: string } | null {
  const prefix = 'p6r-person:v1:';
  if (!key.startsWith(prefix)) return null;
  const encoded = key.slice(prefix.length); const divider = encoded.indexOf(':');
  if (divider < 1 || divider === encoded.length - 1) return null;
  const encodedIssuer = encoded.slice(0, divider); const encodedSubject = encoded.slice(divider + 1);
  try {
    const issuer = decodeURIComponent(encodedIssuer); const subject = decodeURIComponent(encodedSubject);
    return encodeURIComponent(issuer) === encodedIssuer && encodeURIComponent(subject) === encodedSubject
      && idCodec('issuer').decode(issuer).ok && idCodec('subject').decode(subject).ok ? { issuer, subject } : null;
  } catch { return null; }
}

/** Normalizes the one active enhanced-provider directory rather than teaching features core/provider keys. */
function createEnhancedDirectory<R, T, I>(protocol: ForkIdentityProtocolV1<R, T, I>): Directory {
  const mappings = new Map<string, DirectoryMapping>();
  let activeGeneration: string | null = null;
  const sources = (): Result<readonly ProviderDirectorySource[]> => {
    let raw: readonly ProviderDirectorySource[];
    try { raw = protocol.directorySources(); } catch { return err('unavailable', 'Enhanced provider directory is unavailable.', 'after-reconnect'); }
    if (!Array.isArray(raw)) return err('incompatible', 'Enhanced provider directory sources are malformed.');
    if (raw.length > 1) return err('incompatible', 'Enhanced protocol exposed multiple active provider directories.');
    for (const source of raw) {
      if (!isRecord(source) || !Array.isArray(source.issuers) || source.issuers.length === 0 || new Set(source.issuers).size !== source.issuers.length
        || !source.issuers.every((issuer) => idCodec('issuer').decode(issuer).ok) || !idCodec('provider-generation').decode(source.generation).ok
        || typeof source.person !== 'function' || source.directory !== undefined && typeof source.directory !== 'function'
        || source.lookup !== undefined && typeof source.lookup !== 'function') return err('incompatible', 'Enhanced provider directory source is malformed.');
    }
    const generation = raw[0]?.generation ?? null;
    if (activeGeneration !== generation) { mappings.clear(); activeGeneration = generation; }
    return ok(raw);
  };
  const sameGeneration = (generation: string): Result<ProviderDirectorySource> => {
    const current = sources(); if (!current.ok) return current;
    const source = current.value[0];
    return source && source.generation === generation ? ok(source) : err('unavailable', 'Provider directory generation changed during the read.', 'after-reconnect');
  };
  const remember = (key: string, mapping: DirectoryMapping) => {
    if (mappings.size >= 512 && !mappings.has(key)) {
      const oldest = mappings.keys().next().value;
      if (oldest !== undefined) mappings.delete(oldest);
    }
    mappings.set(key, mapping);
  };
  const profile = (source: ProviderDirectorySource, record: unknown, revision: unknown): Result<IdentityProfile> => {
    if (!isRecord(record) || !source.issuers.includes(record.issuer as string) || !idCodec('issuer').decode(record.issuer).ok
      || !idCodec('subject').decode(record.subject).ok || !isProfilePresentation(record.presentation)
      || (record.status !== 'current' && record.status !== 'historical') || !idCodec('revision').decode(revision).ok) return err('incompatible', 'Provider directory record is malformed.');
    const issuer = record.issuer; const subject = record.subject;
    if (typeof issuer !== 'string' || typeof subject !== 'string') return err('incompatible', 'Provider directory record is malformed.');
    let person: Result<PersonReference>;
    try { person = asResult<PersonReference>(source.person(issuer, subject)); }
    catch { return err('unavailable', 'Provider person normalization failed.', 'after-reconnect'); }
    if (!person.ok) return person;
    if (person.value.kind !== 'person' || person.value.issuer !== record.issuer || person.value.subject !== record.subject || !identityKeyCodec.decode(person.value.key).ok) {
      return err('incompatible', 'Provider directory returned an invalid person reference.');
    }
    return profileCodec.decode({ identity: person.value, presentation: record.presentation, revision, status: record.status });
  };
  return {
    async search(input, options) {
      if (typeof input.query !== 'string' || input.query.length > 512 || !Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100
        || !Array.isArray(input.kinds) || input.kinds.some((kind) => kind !== 'person' && kind !== 'default-user' && kind !== 'machine' && kind !== 'external')
        || (input.history !== 'current' && input.history !== 'include-historical')) return err('invalid-input', 'Invalid directory search request.');
      const available = sources(); if (!available.ok) return available;
      const source = available.value[0];
      if (!source || !source.directory || !input.kinds.includes('person')) return err('unsupported', 'Provider directory search is unavailable.');
      let result: Result<{ readonly records: readonly unknown[]; readonly nextCursor: string | null; readonly revision: string }>;
      try { result = asResult<{ readonly records: readonly unknown[]; readonly nextCursor: string | null; readonly revision: string }>(await source.directory(input, options)); }
      catch { return err('unavailable', 'Provider directory search failed.', 'after-reconnect'); }
      if (!result.ok) return result;
      const current = sameGeneration(source.generation); if (!current.ok) return current;
      if (!Array.isArray(result.value.records) || result.value.records.length > input.limit || (result.value.nextCursor !== null && !idCodec('cursor').decode(result.value.nextCursor).ok)
        || !idCodec('revision').decode(result.value.revision).ok) return err('incompatible', 'Provider directory page is malformed.');
      const profiles: IdentityProfile[] = [];
      for (const record of result.value.records) {
        const decoded = profile(current.value, record, result.value.revision); if (!decoded.ok) return decoded;
        if (input.history === 'current' && decoded.value.status !== 'current') return err('incompatible', 'Provider directory returned historical data for a current query.');
        if (decoded.value.identity.kind !== 'person') return err('incompatible', 'Provider directory returned a non-person profile.');
        remember(decoded.value.identity.key, { generation: current.value.generation, issuer: decoded.value.identity.issuer, subject: decoded.value.identity.subject });
        profiles.push(decoded.value);
      }
      const nextCursor = result.value.nextCursor === null ? null : idCodec('cursor').decode(result.value.nextCursor);
      const revision = idCodec('revision').decode(result.value.revision);
      if ((nextCursor !== null && !nextCursor.ok) || !revision.ok) return err('incompatible', 'Provider directory page identifiers are malformed.');
      return ok({ items: profiles, nextCursor: nextCursor === null ? null : nextCursor.value, revision: revision.value });
    },
    async getMany(input, options) {
      if (!Array.isArray(input.keys) || input.keys.length > 64 || !input.keys.every((key) => identityKeyCodec.decode(key).ok)) return err('invalid-input', 'Invalid profile lookup request.');
      const available = sources(); if (!available.ok) return available;
      const source = available.value[0];
      if (!source || !source.lookup) return err('unsupported', 'Provider directory lookup is unavailable.');
      const selected: (DirectoryMapping | undefined)[] = [];
      for (const key of input.keys) {
        const mapped = mappings.get(key);
        if (mapped?.generation === source.generation) { selected.push(mapped); continue; }
        const decoded = decodeP6rPersonKey(key);
        if (!decoded || !source.issuers.includes(decoded.issuer)) { selected.push(undefined); continue; }
        let person: Result<PersonReference>;
        try { person = asResult<PersonReference>(source.person(decoded.issuer, decoded.subject)); }
        catch { return err('unavailable', 'Provider person normalization failed.', 'after-reconnect'); }
        if (!person.ok) return person;
        if (person.value.kind !== 'person' || person.value.key !== key || person.value.issuer !== decoded.issuer || person.value.subject !== decoded.subject) {
          return err('incompatible', 'Provider directory rejected the canonical profile key.');
        }
        const entry = { generation: source.generation, issuer: decoded.issuer, subject: decoded.subject };
        remember(key, entry); selected.push(entry);
      }
      const unresolved = [...new Map(selected.filter((entry): entry is DirectoryMapping => entry !== undefined).map(entry => [JSON.stringify([entry.issuer, entry.subject]), entry])).values()];
      if (unresolved.length === 0) return ok(input.keys.map((key) => ({ key, status: 'missing' as const })));
      let result: Result<{ readonly revision: string; readonly records: readonly { readonly issuer: string; readonly subject: string; readonly record: unknown | null }[] }>;
      try { result = asResult<{ readonly revision: string; readonly records: readonly { readonly issuer: string; readonly subject: string; readonly record: unknown | null }[] }>(await source.lookup(unresolved.map(({ issuer, subject }) => ({ issuer, subject })), options)); }
      catch { return err('unavailable', 'Provider directory lookup failed.', 'after-reconnect'); }
      if (!result.ok) return result;
      const current = sameGeneration(source.generation); if (!current.ok) return current;
      if (!isRecord(result.value) || !idCodec('revision').decode(result.value.revision).ok || !Array.isArray(result.value.records) || result.value.records.length !== unresolved.length) return err('incompatible', 'Provider profile lookup page is malformed.');
      const found = new Map<string, IdentityProfile>();
      const seen = new Set<string>();
      for (const entry of result.value.records) {
        if (!isRecord(entry) || typeof entry.issuer !== 'string' || typeof entry.subject !== 'string') return err('incompatible', 'Provider profile lookup entry is malformed.');
        const mapping = unresolved.find((candidate) => candidate.issuer === entry.issuer && candidate.subject === entry.subject);
        if (!mapping || seen.has(`${entry.issuer}\u0000${entry.subject}`)) return err('incompatible', 'Provider profile lookup response is misaligned.');
        seen.add(`${entry.issuer}\u0000${entry.subject}`);
        if (entry.record !== null) {
          if (!isRecord(entry.record) || entry.record.issuer !== entry.issuer || entry.record.subject !== entry.subject) return err('incompatible', 'Provider profile lookup identity does not match its requested subject.');
          const decoded = profile(current.value, entry.record, result.value.revision); if (!decoded.ok) return decoded;
          if (decoded.value.identity.kind !== 'person') return err('incompatible', 'Provider lookup returned a non-person profile.');
          remember(decoded.value.identity.key, { generation: current.value.generation, issuer: decoded.value.identity.issuer, subject: decoded.value.identity.subject });
          found.set(`${entry.issuer}\u0000${entry.subject}`, decoded.value);
        }
      }
      return ok(input.keys.map((key, index) => { const mapping = selected[index]; const profileValue = mapping === undefined ? undefined : found.get(`${mapping.issuer}\u0000${mapping.subject}`); return profileValue === undefined ? { key, status: 'missing' as const } : { key, status: 'found' as const, profile: profileValue }; }));
    },
    subscribe: () => () => {},
  };
}

function sameExpectation(session: Extract<ServerSession, { status: 'ready' }>, expected: RequestExpectation): Result<void> {
  return session.actor.identity.key === expected.actor && session.stamp === expected.session
    ? ok(undefined)
    : err('stale-context', 'The request actor or session changed.', 'after-refresh');
}

function toLiveRequest(handle: HostRequestHandle): Result<LiveRequest> {
  const decoded = serverSessionCodec.decode(handle.session);
  if (!decoded.ok) return decoded;
  const session = decoded.value;
  if (session.status !== 'ready') return err('unauthenticated', 'No ready identity session is available.', 'after-refresh');
  const request: LiveRequest = {
    signal: handle.signal,
    session,
    validate(expected) {
      const local = sameExpectation(session, expected);
      if (!local.ok) return local;
      return asResult<void>(handle.validate(expected));
    },
    release: () => handle.release(),
  } as LiveRequest;
  return ok(request);
}

function toForkRequest(handle: ForkRequestHandle): Result<{ readonly request: LiveRequest; readonly scope: ForkInvocationScope }> {
  if (!isRecord(handle.scope) || typeof handle.scope.release !== 'function' || typeof handle.scope.validate !== 'function'
    || !(handle.scope.signal instanceof AbortSignal)) {
    return err('incompatible', 'Host returned an invalid enhanced request scope.');
  }
  const request = toLiveRequest(handle);
  return request.ok ? ok({ request: request.value, scope: handle.scope }) : request;
}

function normalizeRegistration(raw: ForkProviderRegistration): Result<ProviderRegistrationV1> {
  const generation = idCodec('provider-generation').decode(raw.generation);
  if (!generation.ok) return err('incompatible', 'Host returned an invalid provider generation.');
  let disposed = false;
  return ok({
    generation: generation.value,
    configuration: raw.configuration,
    getStatus: () => raw.getStatus(),
    signal: raw.signal,
    subscribe: (listener) => raw.subscribe(listener),
    invalidate: (change) => raw.invalidate(change),
    person(issuer, subject) {
      const result = asResult<PersonReference>(raw.person(issuer, subject));
      if (!result.ok) return result;
      if (result.value.kind === 'default-user'
        || !identityKeyCodec.decode(result.value.key).ok || result.value.issuer !== issuer || result.value.subject !== subject) {
        return err('incompatible', 'Host returned an invalid provider person reference.');
      }
      return ok(result.value);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      raw.dispose();
    },
  });
}

/** Converts the branded package callback to the independently constructible core boundary. */
function toForkProvider(provider: IdentityProvider): ForkIdentityProvider {
  const validateReadiness = provider.validateReadiness;
  const directory = provider.directory;
  const lookup = provider.lookup;
  return {
    issuers: provider.issuers,
    ...(validateReadiness ? { validateReadiness: async (input: { readonly generation: string;
      readonly configuration: Readonly<import('./host.js').ProviderBoundaryConfigurationV1>;
      readonly deadlineAt: number; readonly signal: AbortSignal }) => {
      const generation = idCodec('provider-generation').decode(input.generation);
      if (!generation.ok) return generation;
      return validateReadiness({ ...input, generation: generation.value });
    } } : {}),
    resolve: (evidence) => provider.resolve(evidence),
    ...(directory ? { directory: (input: Parameters<NonNullable<IdentityProvider['directory']>>[0], options?: ReadOptions) => directory(input, options) } : {}),
    ...(lookup ? { lookup: (subjects: Parameters<NonNullable<IdentityProvider['lookup']>>[0], options?: ReadOptions) => lookup(subjects, options) } : {}),
  };
}

/** Re-encodes branded package inputs for the structural core protocol. */
function wireInput<I>(input: SendInput<I>, codec: Codec<I>): Wire<SendInput<I>> {
  return {
    ...input,
    input: input.input.map((value) => codec.encode(value) as Wire<I>),
  };
}

function protocolError<R, T, I>(extension: ExtensionDiscovery<R, T, I>): IdentityError {
  if (extension.status === 'unsupported-version') return { code: 'incompatible', message: `Unsupported identity protocol version ${extension.version}.`, retry: 'never' };
  if (extension.status === 'malformed') return extension.error;
  return unavailable('The configured identity boundary is unavailable.');
}

/**
 * Creates one adapter. Extension absence selects the upstream singleton; malformed,
 * incompatible and unavailable extensions stay errors and never become a singleton.
 */
export function createHostAdapter<R, T, I>(options: {
  readonly upstream: UpstreamDriver<R, T, I>;
  readonly extension: ExtensionDiscovery<R, T, I>;
  readonly directory?: Directory;
}): IdentityHost<R, T, I> {
  const { upstream, extension } = options;
  const directory = options.directory ?? unsupportedDirectory();
  const participants = unsupportedParticipants();
  const history = unsupportedHistory();
  const listeners = new Set<(event: HostInvalidation) => void>();
  let disposed = false;
  const close = () => {
    if (disposed) return;
    disposed = true;
    for (const listener of listeners) listener({ kind: 'disposed' });
    listeners.clear();
  };

  if (extension.status === 'absent') {
    const subscriptions = upstream.subscribe((event) => { for (const listener of listeners) listener(event); });
    const contexts = new WeakMap<LiveRequest, R>();
    return {
      pluginId: upstream.pluginId,
      instanceId: upstream.instanceId,
      session: (context) => upstream.session(context),
      selfProfile: (context, readOptions) => upstream.selfProfile(context, readOptions),
      async openPersonRequest(context) {
        const raw = await upstream.openScope(context);
        if (!raw.ok) return raw;
        const request = toLiveRequest(raw.value);
        if (request.ok) contexts.set(request.value, context);
        return request;
      },
      readToolProvenance: async (context) => ok(upstream.toolCorrelation(context)),
      directory,
      participants,
      history,
      async send(request, input, readOptions) {
        if (request.signal.aborted) return { status: 'rejected', error: { code: 'expired', message: 'The request context is no longer live.', retry: 'never' } };
        return upstream.submit(input, readOptions);
      },
      sendExternal: (author, input, readOptions) => upstream.submit({ ...input, input: upstream.labelExternal(author, input.input) }, readOptions),
      lookupOperation: async () => ok({ status: 'unknown', reason: 'unsupported' }),
      async forward(request, destinationPlugin, method, input) {
        const context = contexts.get(request);
        if (!context) throw { code: 'stale-context', message: 'The request scope is no longer live.', retry: 'after-refresh' };
        return upstream.forward(context, destinationPlugin, method, input);
      },
      registerProvider: async () => err('unsupported', 'Identity provider registration requires the enhanced host.'),
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      dispose() { subscriptions(); close(); },
    };
  }

  if (extension.status !== 'supported') {
    const error = protocolError(extension);
    const unavailableResult = async <V>(): Promise<Result<V>> => ({ ok: false, error });
    return {
      pluginId: upstream.pluginId, instanceId: upstream.instanceId,
      session: async () => ({ status: error.code === 'incompatible' ? 'incompatible' : 'unavailable', instanceId: upstream.instanceId, error }),
      selfProfile: unavailableResult,
      openPersonRequest: unavailableResult,
      readToolProvenance: unavailableResult,
      directory, participants, history,
      send: async () => ({ status: 'rejected', error }), sendExternal: async () => ({ status: 'rejected', error }),
      lookupOperation: unavailableResult,
      forward: async () => { throw error; }, registerProvider: unavailableResult,
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }, dispose: close,
    };
  }

  const protocol = extension.protocol;
  const enhancedDirectory = createEnhancedDirectory(protocol);
  const enhancedParticipants: ParticipantReader = {
    async list(input, readOptions) {
      if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100 || !idCodec('thread').decode(input.threadId).ok
        || input.cursor !== undefined && !idCodec('cursor').decode(input.cursor).ok) return err('invalid-input', 'Invalid participant request.');
      if (disposed) return err('disposed', 'Identity host is disposed.');
      let result: Result<unknown>;
      try { result = asResult(await protocol.participants(input, readOptions)); }
      catch { return err('unavailable', 'Participant history is unavailable.', 'after-reconnect'); }
      return result.ok ? decodeParticipantPage(result.value) : result;
    },
    previews: async () => err('unsupported', 'Participant previews are unavailable from this enhanced protocol.'),
  };
  const enhancedHistory = {
    async contributions(query: ContributionQuery, readOptions?: ReadOptions): Promise<Result<EvidencePage<Contribution>>> {
      if (!validContributionQuery(query)) return err('invalid-input', 'Invalid contribution history request.');
      if (disposed) return err('disposed', 'Identity host is disposed.');
      let result: Result<unknown>;
      try { result = asResult(await protocol.historyContributions(query, readOptions)); }
      catch { return err('unavailable', 'Contribution history is unavailable.', 'after-reconnect'); }
      return result.ok ? decodeEvidencePage<Contribution>(result.value, isContribution) : result;
    },
    async attempts(query: AttemptQuery, readOptions?: ReadOptions): Promise<Result<EvidencePage<ExecutionProvenance>>> {
      if (!validAttemptQuery(query)) return err('invalid-input', 'Invalid execution history request.');
      if (disposed) return err('disposed', 'Identity host is disposed.');
      let result: Result<unknown>;
      try { result = asResult(await protocol.historyAttempts(query, readOptions)); }
      catch { return err('unavailable', 'Execution history is unavailable.', 'after-reconnect'); }
      return result.ok ? decodeEvidencePage<ExecutionProvenance>(result.value, (item) => provenanceCodec.decode(item).ok) : result;
    },
  };
  const subscription = protocol.subscribe((event) => { for (const listener of listeners) listener(event); });
  const scopes = new WeakMap<LiveRequest, ForkInvocationScope>();
  return {
    pluginId: upstream.pluginId, instanceId: protocol.instanceId as typeof upstream.instanceId,
    async session(context) {
      const decoded = serverSessionCodec.decode(await protocol.session(context));
      if (!decoded.ok) return { status: 'incompatible', instanceId: protocol.instanceId as typeof upstream.instanceId, error: decoded.error };
      return decoded.value.instanceId === protocol.instanceId ? decoded.value : { status: 'incompatible', instanceId: protocol.instanceId as typeof upstream.instanceId, error: { code: 'incompatible', message: 'Enhanced ready session instance does not match persisted host instance.', retry: 'never' } };
    },
    async selfProfile(context, readOptions) {
      const result = asResult<IdentityProfile>(await protocol.selfProfile(context, readOptions));
      if (!result.ok) return result;
      return profileCodec.decode(result.value);
    },
    async openPersonRequest(context) {
      const raw = await protocol.openRequest(context);
      if (!raw.ok) return raw;
      const enhanced = toForkRequest(raw.value);
      if (!enhanced.ok) { raw.value.release(); return enhanced; }
      if (enhanced.value.request.session.instanceId !== protocol.instanceId) {
        raw.value.release();
        return err('incompatible', 'Enhanced request instance does not match persisted host instance.');
      }
      scopes.set(enhanced.value.request, enhanced.value.scope);
      return ok(enhanced.value.request);
    },
    async readToolProvenance(context) {
      const result = asResult<ExecutionProvenance>(await protocol.provenance(context));
      return result.ok ? provenanceCodec.decode(result.value) : result;
    },
    directory: {
      search: (input, readOptions) => disposed ? Promise.resolve(err('disposed', 'Identity host is disposed.')) : enhancedDirectory.search(input, readOptions),
      getMany: (input, readOptions) => disposed ? Promise.resolve(err('disposed', 'Identity host is disposed.')) : enhancedDirectory.getMany(input, readOptions),
      subscribe: enhancedDirectory.subscribe,
    },
    participants: enhancedParticipants,
    history: enhancedHistory,
    async send(request, input, readOptions) {
      const scope = scopes.get(request);
      if (!scope) return { status: 'rejected', error: { code: 'stale-context', message: 'The request scope is no longer live.', retry: 'after-refresh' } };
      const result = decodeAcceptance(await protocol.accept({ source: { kind: 'scope', scope }, input: wireInput(input, upstream.inputCodec) }, readOptions));
      return result.ok ? result.value : { status: 'rejected', error: result.error };
    },
    async sendExternal(author, input, readOptions) {
      if (disposed) return { status: 'rejected', error: { code: 'disposed', message: 'Identity host is disposed.', retry: 'never' } };
      const result = decodeAcceptance(await protocol.accept({ source: { kind: 'external', author }, input: wireInput(input, upstream.inputCodec) }, readOptions));
      return result.ok ? result.value : { status: 'rejected', error: result.error };
    },
    async lookupOperation(operationId, readOptions) {
      const result = asResult<unknown>(await protocol.lookup(operationId, readOptions));
      return result.ok ? decodeLookup(result.value) : result;
    },
    async forward(request, destinationPlugin, method, input) {
      const scope = scopes.get(request);
      if (!scope) throw { code: 'stale-context', message: 'The request scope is no longer live.', retry: 'after-refresh' };
      return protocol.forwardRpc(scope, { pluginId: destinationPlugin, method }, input);
    },
    async registerProvider(provider: IdentityProvider) {
      if (disposed) return err('disposed', 'Identity host is disposed.');
      const result = await protocol.registerProvider(toForkProvider(provider));
      if (!result.ok) return result;
      if (disposed) { result.value.dispose(); return err('disposed', 'Identity host is disposed.'); }
      return normalizeRegistration(result.value);
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    dispose() { subscription(); close(); },
  };
}

/** Reads only the trusted optional host member and distinguishes absence from a broken extension. */
export function inspectForkExtension<R, T, I>(value: unknown): ExtensionDiscovery<R, T, I> {
  if (value === undefined) return { status: 'absent' };
  if (!isRecord(value) || value.version !== 1 || !idCodec('instance').decode(value.instanceId).ok || typeof value.bindInvocation !== 'function'
    || typeof value.session !== 'function' || typeof value.openRequest !== 'function'
    || typeof value.selfProfile !== 'function' || typeof value.accept !== 'function' || typeof value.lookup !== 'function'
    || typeof value.provenance !== 'function' || typeof value.historyContributions !== 'function' || typeof value.historyAttempts !== 'function'
    || typeof value.directorySources !== 'function' || typeof value.participants !== 'function' || typeof value.forwardRpc !== 'function'
    || typeof value.registerProvider !== 'function' || typeof value.subscribe !== 'function') {
    const version = isRecord(value) && typeof value.version === 'number' ? value.version : null;
    return version === null
      ? { status: 'malformed', error: { code: 'incompatible', message: 'Malformed experimental_p6rIdentity extension.', retry: 'never' } }
      : { status: 'unsupported-version', version };
  }
  return { status: 'supported', protocol: value as unknown as ForkIdentityProtocolV1<R, T, I> };
}
