/** Additive native evidence. Importing existing entries does not require these SDK capabilities. */
import type { PluginBbSdk } from '@get-bb/plugin-sdk';
import type { Contribution, EvidencePage, ExecutionProvenance, ExternalPersonSnapshotV1, ProvenanceReader, ReadOptions, Result } from './model.js';

export type NativeEvent = Awaited<ReturnType<PluginBbSdk['threads']['events']['list']>>[number];
export type NativeTimeline = Awaited<ReturnType<PluginBbSdk['threads']['timeline']>>;
type RequestData = Extract<NativeEvent, { type: 'client/turn/requested' }>['data'];
/** An absent public SDK property is an absent capability, not a copied fork type. */
type NativeArrayMember<T, Key extends PropertyKey> = Key extends keyof T
  ? NonNullable<T[Key]> extends readonly (infer Member)[] ? NonNullable<Member> : never
  : never;
export type NativeActor = NativeArrayMember<RequestData, 'p6rAuthors'>;
export type NativeMention = NativeArrayMember<RequestData, 'p6rMentionedTargets'>;
/** Recorded source attribution may also carry the existing shared external-person assertion.
 * This does not add a capability to the consumed SDK or change its NativeActor type. */
export type NativeSourceActor = NativeActor | ExternalPersonSnapshotV1;
type NativeRequestEvent = Extract<NativeEvent, { type: 'client/turn/requested' }>;
/** Package-owned recorded-source seam, derived from the public SDK request shape.
 * Ordinary SDK events remain assignable; richer recorded assertions need this input type. */
export type NativeSourceEvent = Exclude<NativeEvent, { type: 'client/turn/requested' }> | (
  Omit<NativeRequestEvent, 'data'> & {
    readonly data: Omit<RequestData, 'p6rAuthors' | 'p6rEditors'> & {
      readonly p6rAuthors?: readonly (NativeSourceActor | null)[] | undefined;
      readonly p6rEditors?: readonly (NativeSourceActor | null)[] | undefined;
    };
  }
);
export type NativeSourceReference =
  | { readonly kind: 'request-group'; readonly threadId: string; readonly eventId: string; readonly requestId: string; readonly groupIndex: number }
  | { readonly kind: 'event'; readonly threadId: string; readonly eventId: string }
  | { readonly kind: 'assistant-item'; readonly threadId: string; readonly itemId: string; readonly terminalEventId: string; readonly scope: { readonly turnId: string } }
  | { readonly kind: 'assistant-terminal'; readonly threadId: string; readonly terminalEventId: string; readonly scope: { readonly turnId: string } };
export interface NativeSourceSnapshot {
  readonly source: NativeSourceReference;
  /** Retained public threads.events.list results or recorded-source events. Gaps are not proof of deletion or completeness. */
  readonly events: readonly NativeSourceEvent[];
  /** Public threads.timeline result with content and nested rows requested. No internal projection imports. */
  readonly timeline?: NativeTimeline;
}
export interface NativeCoverage {
  readonly status: 'known' | 'partial' | 'unknown';
  readonly reasons: readonly string[];
}
export interface NativeInputLink {
  readonly requestEventId: string;
  readonly requestId: string;
  readonly acceptedEventId: string;
  readonly turnId: string;
  readonly groupCount: number;
}
export interface NativeTextEvidence {
  readonly text: string;
  readonly basis: 'request-input' | 'public-timeline';
  readonly eventIds: readonly string[];
  readonly sourceSeqStart: number;
  readonly sourceSeqEnd: number;
  readonly itemId: string | null;
  /** Recorded public item parent; null when absent, never inferred delegation. */
  readonly parentToolCallId: string | null;
  readonly timelineRowId: string | null;
  readonly phase: 'commentary' | 'final_answer' | null;
}
export interface NativeSourceEvidence {
  readonly source: NativeSourceReference;
  readonly basis: 'public-sdk-native';
  /** Dispatch role does not establish a human identity. Assistant output always remains assistant. */
  readonly origin: 'assistant' | 'agent' | 'user' | 'system' | 'unknown';
  readonly author: NativeSourceActor | null;
  readonly latestEditor: NativeSourceActor | null;
  /** Targets are request-wide: never silently assigned to an individual group. */
  readonly mentionedTargets: readonly NativeMention[];
  readonly dispatch: { readonly initiator: RequestData['initiator']; readonly source: RequestData['source']; readonly senderThreadId: string | null } | null;
  readonly terminal: { readonly terminalEventId: string; readonly scope: { readonly turnId: string }; readonly status: 'completed' | 'failed' | 'interrupted' } | null;
  readonly text: readonly NativeTextEvidence[];
  readonly inputs: readonly NativeInputLink[];
  /** Native input authors, editor, mentions and dispatch do not prove personal lineage or an agent identity. */
  readonly initiatingPerson: { readonly status: 'unknown'; readonly reason: 'not-established-by-native-source' };
  readonly carriedPerson: { readonly status: 'unknown'; readonly reason: 'not-established-by-native-source' };
  readonly agentId: null;
  readonly delegation: { readonly status: 'unknown'; readonly reason: 'not-established-by-native-source' };
  readonly coverage: {
    readonly source: NativeCoverage;
    readonly attribution: NativeCoverage;
    readonly execution: NativeCoverage;
    readonly personalLineage: NativeCoverage;
  };
  /** Each result is the actual reader outcome. Success here never changes native source/lineage coverage. */
  readonly history: readonly NativeHistoryRead[];
}
export type NativeHistoryRead =
  | { readonly kind: 'contributions'; readonly eventId: string; readonly result: Result<EvidencePage<Contribution>> }
  | { readonly kind: 'attempts'; readonly contribution: Contribution['reference']; readonly result: Result<EvidencePage<ExecutionProvenance>> };
export interface NativeSourceAdapter {
  /** Snapshot normalization only. No scans, subscriptions, mutations, or automatic retries. */
  resolve(snapshot: NativeSourceSnapshot): Result<NativeSourceEvidence>;
  /** Optional genuine history reads. Preserves pending/unavailable/partial results and exact causal joins. */
  enrich(evidence: NativeSourceEvidence, options?: ReadOptions): Promise<Result<NativeSourceEvidence>>;
}
export declare const NATIVE_SOURCE_LIMITS: Readonly<{ events: 2000; rows: 2000; bytes: 2097152; depth: 8; historyReads: 16; identifier: 256; dataDepth: 64 }>;
export declare function createNativeSourceAdapter(options?: { readonly history?: ProvenanceReader }): NativeSourceAdapter;
