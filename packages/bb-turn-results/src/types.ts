/** Structural data only. Occurrence framing is separate from reusable content. */
import type { SourceIdentity, PresentationRefV1 } from '@phosphorco/bb-context-recognition';
import type { EventEnvelope } from './events.js';
export type { SourceIdentity, PresentationRefV1 } from '@phosphorco/bb-context-recognition';
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
/** Method failure, never a result/page or acknowledgement of applied work. */
export interface ResultsSourceFault {
  protocol: 'bb-turn-results-fault'; version: 1;
  method: 'turnResultsDescribe' | 'turnResultsV1Recognize' | 'turnResultsV1Resolve' | 'turnResultsV1Enumerate' | 'turnResultsV1Invalidate';
  code: 'timeout' | 'incompatible' | 'aborted' | 'stale' | 'source-error';
}
export interface SourceRef {
  threadId: string; turnId: string; eventId: string; seq: number;
  itemId: string; eventType: 'item/completed';
}
export interface EvidenceSite { eventId: string; field: 'tool.result' | 'command.output' | 'image.path'; start: number; end: number }
export interface ClaimRef { source: SourceRef; member: string; kind: string }
export interface Equivalence { namespace: string; operationId: string; member: string }
export interface ResultIdentity {
  version: 1; ref: ClaimRef; artifact: SourceIdentity; equivalence?: Equivalence | undefined;
  specificity: 'typed' | 'generic';
  evidence: { basis: 'typed-receipt' | 'native-completion' | 'command-output' | 'text-link'; sites: EvidenceSite[]; targetUrls: string[]; selectedDigest: string };
  lookup: JsonValue;
}
export interface Candidate { identity: ResultIdentity }
export type ResultProof =
  | { kind: 'native-image'; source: SourceRef; selectedDigest: string; artifactDigest?: string | undefined }
  | { kind: 'native-command'; source: SourceRef; selectedDigest: string; exitCode: number | null; assertion: 'address-observed' | 'command-succeeded' | 'artifact-reported' }
  | { kind: 'native-tool-observation'; source: SourceRef; selectedDigest: string; tool: { server: string; name: string }; assertion: 'link-observed' | 'artifact-reported' }
  | { kind: 'initial-operation'; source: SourceRef; receiptId: string; receiptDigest: string; operationId: string; binderVersion: string; tool: { pluginId: string; name: string } };
export type FileIdentity =
  | { kind: 'host'; hostId: string; path: string }
  | { kind: 'workspace'; environmentId: string; path: string }
  | { kind: 'thread-storage'; threadId: string; path: string };
export type ReferenceNavigation =
  | { kind: 'file'; target: FileIdentity }
  | { kind: 'url'; href: string }
  | { kind: 'thread'; threadId: string };
export type ResultRoute = ReferenceNavigation
  | { kind: 'source'; threadId: string; eventId: string; seq: number }
  | { kind: 'unavailable'; reason: string };
export interface RouteProvenance {
  originHost: { state: 'recorded'; hostId: string; sourceEventId: string; capturedAt: number } | { state: 'unknown'; reason: 'not-recorded' | 'unverifiable' };
  artifactLocation:
    | { state: 'verified'; target: FileIdentity; observedAt: number; basis: 'explicit-host-read' | 'source-owned-receipt'; sha256?: string | undefined }
    | { state: 'candidate'; hostId: string; observedAt: number; basis: 'current-thread-environment' | 'current-storage-location' }
    | { state: 'unknown'; reason: string };
}
/** Ephemeral display data, excluded from durable artifact/operation identity. */
export interface MediaLease { href: string; expiresAt: number; width?: number | undefined; height?: number | undefined }
export type FallbackCanvas =
  | { kind: 'image'; title: string; alt: string; media?: MediaLease | undefined }
  | { kind: 'file'; title: string; description?: string | undefined; media?: MediaLease | undefined }
  | { kind: 'link' | 'preview'; title: string; description?: string | undefined; media?: MediaLease | undefined }
  | { kind: 'card'; title: string; description?: string | undefined; fields?: { label: string; value: string }[] | undefined };
/** Supplier preference only. The consumer owns placement, constraints and expansion. */
export interface LayoutHints { preferred: 'compact' | 'expanded' | 'full-width'; aspectRatio?: number | undefined }
/** Compatible content needs no tool occurrence, receipt, outcome or action caption.
 * CR owns registration/runtime; these data types add no registry or React layer.
 */
export interface ContentPresentation { fallback: FallbackCanvas; presentation?: PresentationRefV1 | undefined; layout?: LayoutHints | undefined }
export interface ContentBlock extends ContentPresentation { identity: SourceIdentity; navigation?: ReferenceNavigation | undefined }
export type Knowledge = 'pending' | 'unknown' | 'confirmed' | 'failed';
export type Availability = 'available' | 'unavailable' | 'unknown';
export interface SourceRevision { epoch: string; sequence: number }
export interface OutcomeEvidence { kind: 'observation' | 'external-success' | 'definite-failure'; id: string; digest: string; recordedAt: number }
export interface Resolution extends ContentPresentation {
  identity: ResultIdentity; proof: ResultProof; revision: SourceRevision; knowledge: Knowledge;
  outcomeEvidence: OutcomeEvidence | null; sourceState?: JsonValue | undefined;
  availability: { state: Availability; asOf: number; expiresAt: number | null; reason?: string | undefined };
  route: ResultRoute; provenance: RouteProvenance; spans: { width: 1 | 2 | 3 | 4; height: 1 | 2 | 3 | 4 };
  correction?: { supersedesEvidenceDigest: string; reason: string } | undefined;
}
export interface ResolveInput { version: 1; threadId: string; items: ResultIdentity[]; maxOutcomeBytes: number }
export type ResolveOutcome = { requestIndex: number; identityDigest: string } & (
  | { state: 'resolved'; value: Resolution }
  | { state: 'unavailable' | 'unrecognized'; reason: string }
  | { state: 'budget-deferred'; neededBytes: number }
  | { state: 'oversized'; reason: 'resolved-entry-over-cap'; neededBytes: number }
);
export interface ResolveOutput { resolutions: ResolveOutcome[] }
export interface SeqRange { fromSeq: number; throughSeq: number }
export interface RecognitionContext {
  consumer: { pluginId: string; surface: string }; threadId: string; range: SeqRange;
  projectId?: string | undefined; environmentId?: string | undefined;
  /** Current routing candidate, never historical origin proof. */
  routeContext?: { currentHostId: string; observedAt: number } | undefined;
}
export interface RecognizeOutput { candidates: Candidate[]; page: { nextCursor: string | null; state: 'complete' | 'continued' | 'truncated'; reason?: string | undefined } }
export interface RecognizeInput { version: 1; context: RecognitionContext; events: EventEnvelope[]; page: { cursor: string | null; limit: number } }
export type FeedChange =
  | { kind: 'upsert'; value: Resolution }
  | { kind: 'source-expired'; ref: ClaimRef; revision: SourceRevision }
  | { kind: 'retract'; ref: ClaimRef; revision: SourceRevision; supersedesEvidenceDigest: string; reason: string };
export interface FeedInput { version: 1; threadId: string; range: SeqRange | null; cursor: string | null; limit: number }
export type FeedOutput =
  | { state: 'page'; epoch: string; phase: 'snapshot' | 'changes'; throughRevision: number; rows: FeedChange[]; nextCursor: string; settled: boolean; coverage: { retainedFrom: number | null; unplaced: number; complete: boolean } }
  | { state: 'reset'; epoch: string; reason: 'expired' | 'epoch-changed' | 'retention-gap' | 'source-error'; restartCursor: null; retainedFrom: number | null };
export interface InvalidateInput { version: 1; supplierPluginId: string; threadId: string; revision: SourceRevision; affected: 'thread' | ClaimRef[] }
export interface InvalidateOutput { state: 'dirty' | 'not-admitted' | 'obsolete' }
export interface KindDescriptor {
  kind: string; namespace: string; neutralLabel: string; confirmedLabel: string;
  specificity: 'typed' | 'generic'; memberVersion: string; equivalenceNamespaces: string[];
}
export interface CapabilitiesV1 {
  revision: string;
  supplier?: { kinds: KindDescriptor[]; recognize: boolean; resolve: true; enumerate: boolean } | undefined;
  consumer?: { invalidate: true } | undefined;
}
export interface DescribeEnvelope { protocol: 'bb-turn-results'; versions: number[]; capabilities: unknown }
