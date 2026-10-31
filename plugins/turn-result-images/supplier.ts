import {
  canonicalJson, buildResolveOutput, sourceRefEqual, ResultsContractError,
} from '@phosphorco/bb-turn-results';
import type { ResultIdentity, Resolution, ProposedResolveOutcome } from '@phosphorco/bb-turn-results';
import { registerTurnResultsParticipant, ResultsCallError } from '@phosphorco/bb-turn-results/bb';
import type { RegistrationPort } from '@phosphorco/bb-turn-results/bb';
import { IMAGE_REVISION, IMAGE_KIND_DESCRIPTOR, recognizeImages } from './recognition.ts';
import { verifyImage } from './verification.ts';
import type { ImageHistory, ImageVerificationPorts, ImageMaterialization } from './verification.ts';
import type { ImageObservationStore, ImageStoreEntry } from './store.ts';
import { ImageStoreError } from './store.ts';
import { registerImageMedia } from './media.ts';
import type { ImagePreviewPort } from './media.ts';

export const IMAGE_PLUGIN_ID = 'turn-result-images';
export const IMAGE_FRESH_MS = 30_000;
export interface ImageSupplierPorts {
  store: ImageObservationStore;
  verification: Omit<ImageVerificationPorts, 'materializations'>;
  preview?: ImagePreviewPort;
  now(): number;
}
const equal = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
function resolutionFor(history: ImageHistory, materialization: ImageMaterialization | null,
  observation: { asOf: number; verified: boolean; reason: string; displaySupported: boolean },
  previous: Resolution | undefined): Resolution {
  const { identity, proof, nativeCreatedAt } = history;
  return {
    identity, proof, revision: previous?.revision ?? { epoch: 'pending-store-commit', sequence: 0 },
    // A completed native image is historical generation evidence. File existence
    // and renderability are separate; losing a file never retracts generation.
    knowledge: 'confirmed', outcomeEvidence: { kind: 'observation', id: identity.ref.source.eventId,
      digest: identity.evidence.selectedDigest, recordedAt: nativeCreatedAt },
    availability: { state: observation.verified ? 'available' : 'unavailable', asOf: observation.asOf,
      expiresAt: observation.verified ? Math.min(Number.MAX_SAFE_INTEGER, observation.asOf + IMAGE_FRESH_MS) : null,
      ...(observation.verified ? {} : { reason: observation.reason }) },
    route: materialization ? { kind: 'file', target: materialization.target }
      : { kind: 'source', threadId: identity.ref.source.threadId, eventId: identity.ref.source.eventId, seq: identity.ref.source.seq },
    provenance: { originHost: { state: 'unknown', reason: 'not-recorded' }, artifactLocation:
      materialization ? { state: 'verified', target: materialization.target, observedAt: observation.verified
        ? observation.asOf : previous?.provenance.artifactLocation.state === 'verified'
          ? previous.provenance.artifactLocation.observedAt : materialization.verifiedAt,
        basis: 'explicit-host-read', sha256: materialization.providerSha256 }
        : { state: 'unknown', reason: 'not-verified' } },
    fallback: { kind: 'image', title: 'Generated image', alt: 'Image generated in this turn' },
    layout: materialization && observation.displaySupported
      ? { preferred: 'compact', aspectRatio: Math.max(0.05, Math.min(20, materialization.width / materialization.height)) }
      : { preferred: 'compact' },
    sourceState: { artifact: observation.verified ? 'verified' : 'unavailable', reason: observation.reason,
      display: observation.displaySupported ? 'supported' : 'unsupported-or-unverified' },
    spans: { width: 2, height: 2 },
  };
}

/** Production factory. Pure recognition; all durable facts and native reads stay
 * with this independently installable supplier, never in the gallery package.
 * No startup scan, background task, polling or file bytes are retained. Media
 * URLs exist only in replies from the optional source-owned media handler.
 */
export function registerImageResults(bb: RegistrationPort, ports: ImageSupplierPorts) {
  let activeResolves = 0;
  const acquire = () => {
    if (activeResolves >= 2) return null;
    activeResolves++;
    return () => { activeResolves--; };
  };
  async function resolveOne(identity: ResultIdentity, signal: AbortSignal): Promise<ProposedResolveOutcome> {
    signal.throwIfAborted();
    let existing: ImageStoreEntry | null;
    try { existing = ports.store.read(identity.ref.source); }
    catch (error) {
      if (error instanceof ImageStoreError && error.code === 'capacity') return { state: 'unavailable', reason: 'source-key-capacity' };
      throw error;
    }
    if (existing && !equal(existing.history.identity, identity)) return { state: 'unrecognized', reason: 'source-binding-conflict' };
    // A bounded fresh persisted observation is reusable after output pruning or
    // restart. Expiry triggers a fixed-target recheck, never current-host moves.
    const now = ports.now();
    if (existing && existing.resolution.availability.state === 'available'
      && existing.resolution.availability.expiresAt !== null
      && existing.resolution.availability.asOf <= now && existing.resolution.availability.expiresAt > now) {
      return { state: 'resolved', value: existing.resolution };
    }
    const result = await verifyImage(identity, { ...ports.verification,
      materializations: { async read(source) {
        signal.throwIfAborted();
        const record = ports.store.read(source);
        if (!record) return null;
        if (!sourceRefEqual(record.history.identity.ref.source, source)) throw new ResultsContractError('identity-conflict', 'Stored source differs.');
        return record.materialization;
      } },
    }, signal);
    signal.throwIfAborted();
    if (result.state === 'conflict') return { state: 'unavailable', reason: result.reason };
    let history: ImageHistory | null = existing?.history ?? null;
    let materialization = existing?.materialization ?? null;
    let asOf = now, verified = false, reason: string, displaySupported = false;
    if (result.state === 'verified') {
      materialization = result.binding;
      history = { identity: result.binding.identity, proof: result.binding.proof,
        nativeCreatedAt: result.binding.nativeCreatedAt, path: result.binding.path, providerSha256: result.binding.providerSha256 };
      asOf = result.observedAt; verified = true; reason = result.displayUnsupported ?? 'verified'; displaySupported = result.layout !== null;
    } else {
      reason = result.state === 'unrecognized' ? 'source-evidence-unavailable' : result.reason;
      // Retained facts remain authoritative when native selectedDigest changes
      // due to output retention. Never replace known proof with a weaker read.
      if (result.state === 'unavailable' && result.historical && !existing) history = result.historical;
      if (!history) return { state: result.state === 'unrecognized' ? 'unrecognized' : 'unavailable', reason };
    }
    if (!history) return { state: 'unavailable', reason: 'source-evidence-unavailable' };
    const proposal: ImageStoreEntry = { history, materialization,
      resolution: resolutionFor(history, materialization, { asOf, verified, reason, displaySupported }, existing?.resolution) };
    signal.throwIfAborted();
    const committed = ports.store.commit(proposal);
    if (!('entry' in committed)) return { state: 'unavailable', reason: committed.reason };
    return { state: 'resolved', value: committed.entry.resolution };
  }
  const participant = registerTurnResultsParticipant(bb, {
    pluginId: IMAGE_PLUGIN_ID,
    capabilities: { revision: IMAGE_REVISION, supplier: { kinds: [IMAGE_KIND_DESCRIPTOR], recognize: true, resolve: true, enumerate: false } },
    recognize: input => recognizeImages(input),
    async resolve(input, signal) {
      // Two global source requests maximum, each reads at most one image at a
      // time. An independently enforced registration deadline aborts later I/O.
      const release = acquire();
      if (!release) throw new ResultsCallError('source-error');
      try {
        const outcomes: ProposedResolveOutcome[] = [];
        for (const identity of input.items) { signal.throwIfAborted(); outcomes.push(await resolveOne(identity, signal)); }
        signal.throwIfAborted();
        return await buildResolveOutput(input, outcomes);
      } finally { release(); }
    },
  });
  const media = ports.preview ? registerImageMedia(bb, { ...ports, preview: ports.preview, acquire }) : null;
  return { dispose() { participant.dispose(); media?.dispose(); } };
}
