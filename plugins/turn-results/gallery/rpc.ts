import { z } from 'zod';
import { IdentifierSchema, PluginIdSchema, canonicalByteLength, InputSchemas } from '@phosphorco/bb-turn-results';
import type { ClaimRef, ResultIdentity } from '@phosphorco/bb-turn-results';
import type { GalleryPage, ObservationPage, StageRecord, PendingResolveInput, PendingResolvePage } from './index.ts';

export const GALLERY_METHODS = Object.freeze({ pending: 'turnResultsGalleryV1Pending', read: 'turnResultsGalleryV1Read', stage: 'turnResultsGalleryV1Stage', apply: 'turnResultsGalleryV1Apply', known: 'turnResultsGalleryV1KnownIdentities' });
const pageCursor = z.object({ seq: z.number().int().nonnegative(), key: z.string().max(1024) }).strict();
const pendingCursor = z.object({ seq: z.number().int().nonnegative().safe(), key: z.string().refine(v => new TextEncoder().encode(v).length <= 1024) }).strict();
export const PendingGallerySchema = z.object({ threadId: IdentifierSchema, owner: PluginIdSchema, turnId: IdentifierSchema,
  fromSeq: z.number().int().nonnegative().safe(), throughSeq: z.number().int().nonnegative().safe(),
  after: pendingCursor.nullable(), limit: z.number().int().min(1).max(8) }).strict().refine(v => v.fromSeq <= v.throughSeq
    && (!v.after || v.after.seq >= v.fromSeq && v.after.seq <= v.throughSeq), 'Invalid pending range.');
export const PendingGalleryOutputSchema = z.object({ rows: z.array(InputSchemas.identity).max(8), next: pendingCursor.nullable() }).strict()
  .transform(value => { canonicalByteLength(value, 65536); return value; });
export const ReadGallerySchema = z.object({ threadId: IdentifierSchema, turnId: IdentifierSchema.optional(), after: pageCursor.optional() }).strict();
export const StageGallerySchema = z.object({ threadId: IdentifierSchema, owner: PluginIdSchema, id: IdentifierSchema }).strict();
/** Internal adapter, not a supplier protocol: exact refs only, no arbitrary keys. */
export const KnownGallerySchema = z.object({ threadId: IdentifierSchema, owner: PluginIdSchema,
  refs: z.array(InputSchemas.ref).max(8) }).strict().refine(input => input.refs.every(ref => ref.source.threadId === input.threadId), 'Foreign claim thread.');
export const KnownGalleryOutputSchema = z.array(InputSchemas.identity).max(8).transform(value => {
  canonicalByteLength(value, 65536); return value;
});
const stage = z.object({ stage: z.enum(['discover', 'native', 'recognize', 'resolve', 'feed', 'maintenance']),
  cursor: z.string().max(512).nullable(), status: z.enum(['ready', 'parked', 'complete']), debt: z.json() }).strict();
export const ApplyGallerySchema = z.object({ owner: PluginIdSchema, threadId: IdentifierSchema,
  changes: z.array(z.union([z.object({ kind: z.literal('candidate'), identity: InputSchemas.identity }).strict(), InputSchemas.feedChange])).max(8),
  stage: z.object({ id: IdentifierSchema, expectedVersion: z.number().int().nonnegative().nullable(), value: stage }).strict().optional(),
  supplier: z.object({ revision: IdentifierSchema, connection: z.enum(['connected', 'disconnected', 'unsupported']), freshUntil: z.number().int().nonnegative().nullable(), epoch: IdentifierSchema.nullable().optional() }).strict().optional(),
  coverage: z.array(z.object({ fromSeq: z.number().int().nonnegative(), throughSeq: z.number().int().nonnegative(),
    state: z.enum(['indexed', 'unindexed', 'evicted', 'unsupported', 'oversized', 'unplaced']), owner: PluginIdSchema.optional(), reason: z.string().max(256).optional() }).strict()).max(8).optional(),
}).strict();
export interface GalleryRead { page: ObservationPage; coverage: { state: 'unindexed' | 'partial' | 'deleted'; intervals: unknown[] } }
export interface GalleryBackend {
  /** Required owner-scoped pending lookup; display paging cannot supply resolve work. */
  pending(input: PendingResolveInput, signal: AbortSignal): Promise<PendingResolvePage>;
  knownIdentities(threadId: string, owner: string, refs: ClaimRef[], signal: AbortSignal): Promise<ResultIdentity[]>;
  read(threadId: string, turnId: string | null, signal: AbortSignal, after?: { seq: number; key: string }): Promise<GalleryRead>;
  stage(threadId: string, owner: string, id: string, signal: AbortSignal): Promise<StageRecord | null>;
  apply(page: GalleryPage, signal: AbortSignal): Promise<void>;
}
/** Retain unknown fields until bounded raw admission; SDK parsing is earlier. */
export const GalleryRawSchema = z.unknown().transform(value => { canonicalByteLength(value, 262144); return value; });
