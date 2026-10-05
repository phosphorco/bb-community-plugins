/** Runtime validators for the declaration-only portable vocabulary. */
import type {
  Codec, ConflictToken, ContributionReference, ExecutionProvenance, IdentityError,
  IdentityKey, IdentityProfile, Id, InstanceId, Json, OperationId, Result,
} from './model.js';

const ID_MAX_LENGTH = 256;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/;

function failure(code: IdentityError['code'], message: string, retry: IdentityError['retry'] = 'never'): IdentityError {
  return { code, message, retry };
}

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function err<T = never>(code: IdentityError['code'], message: string, retry: IdentityError['retry'] = 'never'): Result<T> {
  return { ok: false, error: failure(code, message, retry) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBoundedString(value: unknown, maximum = ID_MAX_LENGTH): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum;
}

/** Validates opaque identifiers at the one runtime boundary that creates their brand. */
export function idCodec<Kind extends string>(kind: Kind): Codec<Id<Kind>> {
  return {
    decode(input: unknown): Result<Id<Kind>> {
      // Session stamps are opaque host-issued comparison tokens, not resource
      // slugs. P6R embeds encodeURIComponent(identityKey) and a generation in
      // them. Preserve the exact token; decoding/normalizing changes ownership.
      const valid = kind === 'server-session'
        ? isBoundedString(input, 4096) && !/[\u0000-\u0020\u007f]/.test(input)
        : isBoundedString(input) && ID_PATTERN.test(input);
      if (!valid) {
        return err('invalid-input', `Invalid ${kind} identifier.`);
      }
      return ok(input as Id<Kind>);
    },
    encode(value: Id<Kind>): Json {
      return value;
    },
  };
}

export const identityKeyCodec: Codec<IdentityKey> = {
  decode(input: unknown): Result<IdentityKey> {
    if (!isBoundedString(input, 512) || /[\u0000-\u001f\u007f]/.test(input)) {
      return err('invalid-input', 'Invalid identity key.');
    }
    return ok(input as IdentityKey);
  },
  encode(value: IdentityKey): Json {
    return value;
  },
};

function decodePresentation(value: unknown): boolean {
  return isRecord(value)
    && isBoundedString(value.displayName, 512)
    && (value.handle === null || isBoundedString(value.handle, 512))
    && (value.avatarUrl === null || isBoundedString(value.avatarUrl, 2_048));
}

function decodeIdentity(value: unknown): boolean {
  if (!isRecord(value) || !identityKeyCodec.decode(value.key).ok) return false;
  if (value.kind === 'person') return isBoundedString(value.issuer, 512) && isBoundedString(value.subject, 512);
  if (value.kind === 'default-user') return isBoundedString(value.instanceId);
  if (value.kind === 'machine') {
    return isBoundedString(value.instanceId) && (value.hostId === null || isBoundedString(value.hostId, 512));
  }
  return value.kind === 'external' && isBoundedString(value.pluginId) && isBoundedString(value.subject, 512);
}

export const profileCodec: Codec<IdentityProfile> = {
  decode(input: unknown): Result<IdentityProfile> {
    if (!isRecord(input) || !decodeIdentity(input.identity) || !decodePresentation(input.presentation)
      || !isBoundedString(input.revision) || (input.status !== 'current' && input.status !== 'historical')) {
      return err('invalid-input', 'Invalid identity profile.');
    }
    return ok(input as unknown as IdentityProfile);
  },
  encode(value: IdentityProfile): Json {
    return value as unknown as Json;
  },
};

function isContributionReference(value: unknown): value is ContributionReference {
  return isRecord(value) && idCodec('thread').decode(value.threadId).ok && idCodec('contribution').decode(value.contributionId).ok;
}

function isPersonReference(value: unknown): boolean {
  return isRecord(value) && (value.kind === 'person' || value.kind === 'default-user') && decodeIdentity(value);
}

function isMachineReference(value: unknown): boolean {
  return isRecord(value) && value.kind === 'machine' && decodeIdentity(value);
}

function isActorSnapshot(value: unknown): boolean {
  if (!isRecord(value) || !decodeIdentity(value.identity) || !decodePresentation(value.presentation)) return false;
  const evidence = value.evidence;
  if (evidence !== 'provider-verified' && evidence !== 'local-user' && evidence !== 'upstream-default'
    && evidence !== 'integration-asserted' && evidence !== 'legacy' && evidence !== 'machine') return false;
  return isMachineReference(value.identity) ? evidence === 'machine' : evidence !== 'machine';
}

function isOrigin(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.kind === 'person') {
    const actor = value.actor;
    return isActorSnapshot(actor) && isRecord(actor) && isPersonReference(actor.identity);
  }
  if (value.kind === 'machine') {
    const actor = value.actor;
    return isActorSnapshot(actor) && isRecord(actor) && isMachineReference(actor.identity)
      && isRecord(actor) && actor.evidence === 'machine';
  }
  if (value.kind === 'external') {
    const actor = value.actor;
    return isActorSnapshot(actor) && isRecord(actor) && isRecord(actor.identity) && actor.identity.kind === 'external'
      && actor.evidence !== 'machine';
  }
  if (value.kind === 'agent') return value.agentId === null || isBoundedString(value.agentId);
  if (value.kind === 'system') return isBoundedString(value.reason, 1_024);
  return value.kind === 'unknown' && (value.reason === 'legacy' || value.reason === 'upstream-unattributed' || value.reason === 'missing-source');
}

function isContribution(value: unknown): boolean {
  return isRecord(value) && isContributionReference(value.reference) && isOrigin(value.author)
    && (value.latestEditor === null || isActorSnapshot(value.latestEditor))
    && isBoundedString(value.acceptedAt, 256)
    && Array.isArray(value.mentionedPeople) && value.mentionedPeople.every(isPersonReference);
}

function isCorrelation(value: unknown): boolean {
  return isRecord(value) && idCodec('thread').decode(value.threadId).ok
    && isBoundedString(value.turnId) && isBoundedString(value.attemptId)
    && (value.toolCallId === null || isBoundedString(value.toolCallId));
}

function referenceKey(value: ContributionReference): string {
  return `${value.threadId}\u0000${value.contributionId}`;
}

function isInputSource(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.kind === 'contribution') return isContributionReference(value.reference);
  if (value.kind === 'interaction') return isBoundedString(value.interactionId) && isOrigin(value.resolver);
  return value.kind === 'generated' && (value.purpose === 'continuation' || value.purpose === 'resolved-resource' || value.purpose === 'system-context')
    && Array.isArray(value.basedOn) && value.basedOn.every(isContributionReference);
}

function causalReferences(groups: readonly unknown[]): readonly ContributionReference[] | null {
  const references: ContributionReference[] = [];
  for (const group of groups) {
    if (!isRecord(group) || !Array.isArray(group.sources) || !group.sources.every(isInputSource)) return null;
    for (const source of group.sources) {
      if (!isRecord(source)) return null;
      if (source.kind === 'contribution' && isContributionReference(source.reference)) references.push(source.reference);
      if (source.kind === 'generated' && Array.isArray(source.basedOn) && source.basedOn.every(isContributionReference)) references.push(...source.basedOn);
    }
  }
  return references;
}

function hasCompleteCausality(groups: readonly unknown[], contributions: readonly unknown[], missing: readonly unknown[]): boolean {
  const references = causalReferences(groups);
  if (references === null || !contributions.every(isContribution) || !missing.every(isContributionReference)) return false;
  const required = new Set(references.map(referenceKey));
  const found = new Set<string>();
  for (const contribution of contributions) {
    if (!isRecord(contribution) || !isContributionReference(contribution.reference)) return false;
    const key = referenceKey(contribution.reference);
    if (found.has(key)) return false;
    found.add(key);
  }
  const absent = new Set<string>();
  for (const reference of missing) {
    const key = referenceKey(reference);
    if (absent.has(key) || found.has(key)) return false;
    absent.add(key);
  }
  return required.size === found.size + absent.size
    && [...required].every((key) => found.has(key) || absent.has(key));
}

/** The adapter verifies the discriminant and causal references before exposing provenance. */
export const provenanceCodec: Codec<ExecutionProvenance> = {
  decode(input: unknown): Result<ExecutionProvenance> {
    if (!isRecord(input) || (input.status !== 'known' && input.status !== 'partial' && input.status !== 'unknown')) {
      return err('invalid-input', 'Invalid execution provenance.');
    }
    if (input.status === 'unknown') return (input.correlation === null || isCorrelation(input.correlation)) && isBoundedString(input.reason, 1_024)
      ? ok(input as ExecutionProvenance) : err('invalid-input', 'Unknown provenance needs a valid correlation and reason.');
    if (!Array.isArray(input.inputGroups) || !Array.isArray(input.contributions)) return err('invalid-input', 'Provenance needs input groups and contributions.');
    if (input.status === 'known') {
      return isCorrelation(input.correlation) && hasCompleteCausality(input.inputGroups, input.contributions, [])
        ? ok(input as ExecutionProvenance) : err('invalid-input', 'Known provenance needs complete correlated evidence.');
    }
    if ((input.correlation === null || isCorrelation(input.correlation)) && Array.isArray(input.missing)
      && isBoundedString(input.reason, 1_024) && hasCompleteCausality(input.inputGroups, input.contributions, input.missing)) {
      return ok(input as ExecutionProvenance);
    }
    return err('invalid-input', 'Partial provenance needs complete causal accounting.');
  },
  encode(value: ExecutionProvenance): Json {
    return value as unknown as Json;
  },
};

export function defaultIdentityKey(instance: InstanceId): IdentityKey {
  return `local:${instance}` as IdentityKey;
}

export function newOperationId(): OperationId {
  const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `op-${random}` as OperationId;
}

/** Useful only to runtime fixtures that need an opaque conflict token. */
export function newConflictToken(): ConflictToken {
  return `conflict-${globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36)}` as ConflictToken;
}
