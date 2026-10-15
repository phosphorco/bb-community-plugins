import { z } from 'zod';
export const LIMITS = Object.freeze({ imageBytes:10*1024*1024, fileBytes:25*1024*1024, attachmentCount:5, totalBytes:50*1024*1024, filenameBytes:200, responseBytes:16*1024, messageBytes:1024*1024, sendMessageCharacters:32000 });
const bounded = (max:number) => z.string().min(1).max(max);
export const opaqueIdSchema = bounded(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
export const filenameSchema = bounded(200).refine(s => new TextEncoder().encode(s).length <= LIMITS.filenameBytes && !/[\/\\\x00-\x1f\x7f]/.test(s) && s !== '.' && s !== '..', 'Expected a basename of at most 200 UTF-8 bytes');
export const declaredMimeTypeSchema = bounded(127).regex(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/).refine(s => !/^image\/(heic|heif)(-sequence)?$/.test(s), 'HEIF conversion is unsupported');
export const presentationKindSchema = z.enum(['image','file']);
export const uploadRequestSchema = z.object({operationId:opaqueIdSchema,filename:filenameSchema,declaredMimeType:declaredMimeTypeSchema,sizeBytes:z.number().int().positive().max(LIMITS.fileBytes),presentationKind:presentationKindSchema}).strict().superRefine((v,c)=>{
 if((v.presentationKind === 'image') !== v.declaredMimeType.startsWith('image/') || (v.presentationKind === 'image' && v.sizeBytes > LIMITS.imageBytes)) c.addIssue({code:'custom',message:'Image type or byte limit invalid'});
});
export const attachmentReferenceSchema = z.object({uploadId:opaqueIdSchema,filename:filenameSchema,declaredMimeType:declaredMimeTypeSchema,sizeBytes:z.number().int().positive().max(LIMITS.fileBytes),sha256:z.string().regex(/^[a-f0-9]{64}$/),presentationKind:presentationKindSchema}).strict().superRefine((v,c)=>{if((v.presentationKind==='image') !== v.declaredMimeType.startsWith('image/') || (v.presentationKind==='image' && v.sizeBytes>LIMITS.imageBytes)) c.addIssue({code:'custom',message:'Image type or byte limit invalid'});});
export type AttachmentReference = z.infer<typeof attachmentReferenceSchema>;
export type UploadRequest = z.infer<typeof uploadRequestSchema>;
export const attachmentReferencesSchema = z.array(attachmentReferenceSchema).max(LIMITS.attachmentCount).superRefine((v,c)=>{if(v.reduce((n,r)=>n+r.sizeBytes,0)>LIMITS.totalBytes)c.addIssue({code:'custom',message:'Aggregate byte limit exceeded'});if(new Set(v.map(r=>r.uploadId)).size!==v.length)c.addIssue({code:'custom',message:'Duplicate upload reference'});});
export const UPLOAD_PROTOCOL = Object.freeze({protocol:'bb-agent-connection-upload',version:1,binary:'raw-body',automaticRetry:false} as const);
export const uploadResponseSchema = z.object({protocol:z.literal(UPLOAD_PROTOCOL.protocol),version:z.literal(1),operationId:opaqueIdSchema,attachment:attachmentReferenceSchema});
export const uploadErrorSchema = z.object({code:z.enum(['INVALID_UPLOAD','UPLOAD_TOO_LARGE','UPLOAD_CONFLICT','REFERENCE_UNAVAILABLE','SCOPE_MISMATCH','UNSUPPORTED_MEDIA','QUOTA_EXCEEDED']),message:bounded(1024)});
// Existing direct-connection wire fields and defaults are deliberately retained.
export const connectionSchema = z.object({nickname:bounded(1024),path:bounded(8192),createdAt:z.number().finite()}).strict();
export const canonicalSendModeSchema = z.enum(['AUTO','STEER','QUEUE']);
export type CanonicalSendMode = z.infer<typeof canonicalSendModeSchema>;
export const directSendInputSchema = z.object({message:z.string().max(LIMITS.sendMessageCharacters),mode:canonicalSendModeSchema.default('AUTO'),operationId:z.string().min(1).max(256).nullable().optional(),attachments:attachmentReferencesSchema.optional()}).strict().superRefine((v,c)=>{if(v.message.trim().length===0 && !v.attachments?.length)c.addIssue({code:'custom',message:'Message must contain non-whitespace text or an attachment'});});
export const threadTargetSchema = z.object({id:bounded(256),title:z.string().max(8192),status:bounded(128),url:z.string().url().max(8192)});
export const sendCapabilitySchema = z.object({canSend:z.boolean(),supportedModes:z.array(canonicalSendModeSchema).max(3),code:z.string().max(256).nullable(),reason:z.string().max(4096).nullable(),recommendedAction:z.string().max(4096).nullable()});
export type SendCapability = z.infer<typeof sendCapabilitySchema>;
export const connectedMessageSchema = z.object({id:bounded(256),seq:z.number().int().nonnegative(),role:z.enum(['user','assistant']),author:z.string().max(1024),text:z.string().max(LIMITS.messageBytes),createdAt:z.number().finite(),attachments:attachmentReferencesSchema.optional()});
export type ConnectedMessage = z.infer<typeof connectedMessageSchema>;
export type ThreadTargetSummary = z.infer<typeof threadTargetSchema>;
export type DirectConnectionDescriptor = z.infer<typeof connectionSchema>;
export const directSubmissionReceiptSchema = z.object({clientOperationId:z.string().max(256).nullable(),serverOperationId:bounded(256),acceptanceStatus:z.enum(['SUBMITTED','INDETERMINATE']),threadId:bounded(256)});
export type DirectSubmissionReceipt = z.infer<typeof directSubmissionReceiptSchema>;
export const connectionErrorSchema = z.object({code:bounded(256),reason:bounded(4096),recommendedAction:bounded(4096)});
export function connectionPath(token:string):string {return `/api/v1/plugins/agent-connect/http/connection?token=${encodeURIComponent(token)}`;}
export function connectionInstructions(nickname:string,url:string):string {return `<thread-connect acting-as=${nickname}>GET ${url} for usage documentation.</thread-connect>`;}

export const CONNECTION_GRAPHQL_TYPES = /* GraphQL */ `
  enum MessageRole {
    USER
    ASSISTANT
  }

  enum SendMode {
    AUTO
    STEER
    QUEUE
  }

  type SendCapability {
    canSend: Boolean!
    supportedModes: [SendMode!]!
    code: String
    reason: String
    recommendedAction: String
  }

  type Connection {
    nickname: String!
  }

  type Thread {
    id: ID!
    title: String!
    status: String!
    url: String!
  }

  type Message {
    id: ID!
    seq: ID!
    role: MessageRole!
    author: String!
    text: String!
    createdAt: Float!
  }

  enum AcceptanceStatus {
    SUBMITTED
    INDETERMINATE
  }

  "The immutable record for one external submission. Keep clientOperationId to retry after a lost response."
  type SubmissionReceipt {
    clientOperationId: String
    serverOperationId: ID!
    acceptanceStatus: AcceptanceStatus!
    threadId: ID!
  }

`;
