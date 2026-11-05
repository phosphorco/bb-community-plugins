import { canonicalJson, canonicalByteLength, LIMITS } from './bounds.js';
import { InputSchemas, OutputSchemas, PluginIdSchema, SafeUrlSchema } from './schemas.js';
import type { ClaimRef, ResultIdentity, Resolution, SourceRef } from './types.js';

export class ResultsContractError extends Error {
  readonly kind: 'invalid-input' | 'incompatible' | 'identity-conflict';
  constructor(kind: ResultsContractError['kind'], message: string) { super(message); this.name = 'ResultsContractError'; this.kind = kind; }
}
export function sourceRefEqual(a: SourceRef, b: SourceRef): boolean {
  return a.threadId === b.threadId && a.turnId === b.turnId && a.eventId === b.eventId && a.seq === b.seq && a.itemId === b.itemId && a.eventType === b.eventType;
}
/** Canonical storage key always includes the LISTED owner, never artifact provider. */
export function claimKey(listedOwner: string, value: ClaimRef): string {
  PluginIdSchema.parse(listedOwner);
  const ref = InputSchemas.ref.parse(value);
  const result = canonicalJson([listedOwner, ref.source.threadId, ref.source.eventId, ref.member, ref.kind], LIMITS.keyBytes);
  return result;
}
export function occurrenceGroupKey(listedOwner: string, value: ResultIdentity): string {
  const identity = OutputSchemas.identity.parse(value);
  if (!identity.equivalence || identity.specificity !== 'typed') return claimKey(listedOwner, identity.ref);
  PluginIdSchema.parse(listedOwner);
  const { ref, equivalence } = identity;
  return canonicalJson([ref.source.threadId, ref.source.eventId, ref.kind, equivalence.namespace, equivalence.operationId, equivalence.member], LIMITS.keyBytes);
}
export function canonicalTargetUrl(value: string): string {
  const url = new URL(SafeUrlSchema.parse(value));
  // WHATWG URL normalizes scheme, host and default port; keeps query order/fragment.
  return url.href;
}
/** Suppression is display-only; the generic owner-bound claim remains stored. */
export function suppressesGeneric(typed: ResultIdentity, generic: ResultIdentity): boolean {
  if (typed.specificity !== 'typed' || generic.specificity !== 'generic' || generic.evidence.basis !== 'text-link' || !sourceRefEqual(typed.ref.source, generic.ref.source)) return false;
  if (!generic.evidence.sites.length || !generic.evidence.targetUrls.length) return false;
  const targets = new Set(typed.evidence.targetUrls.map(canonicalTargetUrl));
  return generic.evidence.targetUrls.every(url => targets.has(canonicalTargetUrl(url))) && generic.evidence.sites.every(span => typed.evidence.sites.some(cover => cover.eventId === span.eventId && cover.field === span.field && cover.start <= span.start && cover.end >= span.end));
}
export async function sha256Canonical(value: unknown, maxBytes: number = LIMITS.responseBytes): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(value, maxBytes));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), v => v.toString(16).padStart(2, '0')).join('');
}
export async function identityDigest(value: ResultIdentity): Promise<string> {
  return sha256Canonical(InputSchemas.identity.parse(value), LIMITS.identityBytes);
}
export type TransitionDecision = 'apply' | 'unchanged' | 'stale' | 'revalidate';
/** Validate evidence transitions; storage/epochs and side effects remain source-owned. */
export function checkResolutionTransition(previous: Resolution, next: Resolution): TransitionDecision {
  const a = OutputSchemas.resolution.parse(previous), b = OutputSchemas.resolution.parse(next);
  if (canonicalJson(a.identity) !== canonicalJson(b.identity)) throw new ResultsContractError('identity-conflict', 'An admitted claim cannot change immutable identity.');
  const sameEpoch = a.revision.epoch === b.revision.epoch;
  if (sameEpoch && b.revision.sequence < a.revision.sequence) return 'stale';
  if (sameEpoch && b.revision.sequence === a.revision.sequence) {
    if (canonicalJson(a) !== canonicalJson(b)) throw new ResultsContractError('incompatible', 'Same revision has conflicting snapshots.');
    return 'unchanged';
  }
  // Original carrier/operation facts remain bound to this identity. The only
  // optional proof enrichment is learning a native image's artifact digest;
  // once present it cannot disappear or change (even with an outcome correction).
  const binding = (proof: Resolution['proof']) => {
    if (proof.kind !== 'native-image') return proof;
    const { artifactDigest: _optionalDigest, ...original } = proof;
    return original;
  };
  const proofA = binding(a.proof), proofB = binding(b.proof);
  const sameBinding = canonicalJson(proofA) === canonicalJson(proofB)
    && !(a.proof.kind === 'native-image' && a.proof.artifactDigest !== undefined
      && (b.proof.kind !== 'native-image' || b.proof.artifactDigest !== a.proof.artifactDigest));
  if (!sameBinding) {
    if (!sameEpoch) return 'revalidate';
    throw new ResultsContractError('incompatible', 'Original proof binding cannot change within an admitted identity.');
  }
  const terminal = a.knowledge === 'confirmed' || a.knowledge === 'failed';
  if (terminal) {
    const sameEvidence = canonicalJson(a.outcomeEvidence) === canonicalJson(b.outcomeEvidence);
    const corrected = !!a.outcomeEvidence && b.correction?.supersedesEvidenceDigest === a.outcomeEvidence.digest;
    if ((!sameEvidence || a.knowledge !== b.knowledge) && !corrected) {
      if (!sameEpoch) return 'revalidate';
      throw new ResultsContractError('incompatible', 'Terminal evidence changes require an explicit correction.');
    }
  } else if (a.knowledge === 'unknown' && b.knowledge === 'pending') {
    throw new ResultsContractError('incompatible', 'A retry cannot erase an ambiguous operation outcome.');
  }
  canonicalByteLength(b); // Whole known v1 snapshot, independent of sparse storage encoding.
  return 'apply';
}
