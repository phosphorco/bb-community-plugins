/** Internal phase-1 location records; these are not a new public wire API. */
import { z } from 'zod';
import { VerifiedFileTargetSchema } from '@phosphorco/bb-cross-references';
import { CandidateV1Schema, SourceIdentitySchema, canonicalJson } from '@phosphorco/bb-context-recognition';
import { sha256Hex, type Resource, type ResourceIdentity } from './canonical.ts';
export const MENTION_LIMITS = Object.freeze({perEdge:100, targets:256, messageChars:262_144,
  sourceChars:2_097_152, messages:5000, calls:128, sourceMs:10_000, locations:25_600});
const id = z.string().min(1).max(256).refine(v=>!/[\p{Cc}]/u.test(v));
export const ConversationLocatorSchema = z.strictObject({kind:z.literal('conversation'),threadId:id,messageId:id,
  messageSeq:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  anchorSeq:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),role:z.enum(['user','assistant'])});
export type ConversationLocator = z.infer<typeof ConversationLocatorSchema>;
export const MentionLocationSchema = z.strictObject({locator:ConversationLocatorSchema,
  sourceContentRevision:z.string().regex(/^[a-f0-9]{64}$/),span:z.strictObject({start:z.number().int().nonnegative(),end:z.number().int().positive()}).refine(v=>v.start<v.end && v.end<=MENTION_LIMITS.messageChars),
  messageCreatedAt:z.number().int().nonnegative().max(8_640_000_000_000_000),
  provenance: z.object({pluginId:id,origin:z.enum(['builtin','contributed']),confidence:CandidateV1Schema.shape.confidence,
    recognition:CandidateV1Schema.shape.provenance,source:SourceIdentitySchema,verifiedFile:VerifiedFileTargetSchema.optional(),authoredHref:z.string().max(4096).optional()}),
});
export type MentionLocation = z.infer<typeof MentionLocationSchema>;
export type ObservedMention = MentionLocation & {target:Resource};
export type MentionCoverage = {timelineComplete:boolean;reasons:string[];retentionLimited:boolean;capHistoryUnknown?:boolean};
export type MentionScan = {occurrences:ObservedMention[];observedMessageIds:string[];scannedMessageIds:string[];failedSuppliers:string[];
  discoveryIncomplete:boolean;coverage:MentionCoverage};
export function mentionKey(row:Pick<MentionLocation,'locator'|'span'>):string {
  return sha256Hex(canonicalJson([row.locator,row.span]));
}

/** Internal location-retention truth, separate from v1 distinct-resource counts.
 * Unknown preserves pre-migration clipping whose edge attribution was not saved. */
export type MentionEdgeCap = {target:ResourceIdentity;state:'uncapped'|'capped'|'unknown'};
