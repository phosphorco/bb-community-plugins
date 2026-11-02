import {z} from 'zod';
import {identityKeyCodec} from '@phosphorco/bb-identity/model';
/** Consumer-owned V1 decoder deliberately duplicated from the documented Inbox protocol; no runtime provider import. */
export const CREATED_THREAD_ASSIGNMENT_PROTOCOL='inbox-created-thread-assignment';
export const CREATED_THREAD_ASSIGNMENT_METHODS={describe:'describeCreatedThreadAssignment',claim:'claimCreatedThreadV1',lookup:'lookupCreatedThreadClaimV1'} as const;
export const CREATED_THREAD_ASSIGNMENT_LIMITS={operationId:160,threadId:256,ownerKeys:200,receiptRetention:'indefinite',responseBytes:65536,currentOwnerBytes:32768,providerReadMs:2000,describeWaitMs:1000,claimWaitMs:2500,lookupWaitMs:1000} as const;
const operationId=z.string().min(1).max(160),threadId=z.string().min(1).max(256),actorKey=z.string().min(1).max(512).refine(key=>identityKeyCodec.decode(key).ok,'Invalid identity key');
export const createdThreadClaimInput=z.object({operationId,threadId}).strict();
export const createdThreadReceiptSchema=z.object({operationId,threadId,actorKey,outcome:z.enum(['claimed','skipped-preserved']),reason:z.enum(['claimed-untouched','ownership-touched','thread-ineligible']),decidedAt:z.number().finite(),ownerRevision:z.number().int().nonnegative()}).superRefine((v,ctx)=>{if(v.outcome==='claimed'?(v.reason!=='claimed-untouched'||v.ownerRevision===0):v.reason==='claimed-untouched')ctx.addIssue({code:'custom',message:'Inconsistent assignment receipt outcome'});});
export const currentThreadOwnershipSchema=z.object({threadId,revision:z.number().int().nonnegative(),ownerKeys:z.array(actorKey).max(200),truncated:z.boolean(),explicitlyUnassigned:z.boolean()});
const rejected=z.object({version:z.literal(1),status:z.literal('rejected'),operationId,threadId,code:z.enum(['actor-ineligible','operation-conflict','thread-unavailable']),message:z.string().max(2000)});
export const createdThreadClaimResultSchema=z.union([z.object({version:z.literal(1),status:z.literal('final'),receipt:createdThreadReceiptSchema,current:currentThreadOwnershipSchema}),rejected]);
export const createdThreadLookupResultSchema=z.union([z.object({version:z.literal(1),status:z.literal('found'),receipt:createdThreadReceiptSchema,current:currentThreadOwnershipSchema}),z.object({version:z.literal(1),status:z.literal('absent'),operationId,threadId,current:currentThreadOwnershipSchema}),rejected]);
export const createdThreadDescribeSchema=z.object({protocol:z.literal(CREATED_THREAD_ASSIGNMENT_PROTOCOL),versions:z.array(z.number().int()),limits:z.object({operationId:z.number(),threadId:z.number(),ownerKeys:z.number(),receiptRetention:z.literal('indefinite')})});
export type CreatedThreadClaimInput=z.infer<typeof createdThreadClaimInput>;
export type CreatedThreadReceipt=z.infer<typeof createdThreadReceiptSchema>;
export type CurrentThreadOwnership=z.infer<typeof currentThreadOwnershipSchema>;
export type CreatedThreadClaimResult=z.infer<typeof createdThreadClaimResultSchema>;
export type CreatedThreadLookupResult=z.infer<typeof createdThreadLookupResultSchema>;
export function eligibleCreatedThreadActor(actor:{identity:{kind:string};evidence:string}){return actor.identity.kind==='person'?actor.evidence==='provider-verified':actor.identity.kind==='default-user'&&['upstream-default','local-user'].includes(actor.evidence);}

export const assignmentStatusSchema=z.object({operationId:z.string(),actorKey:z.string(),threadId:z.string().nullable(),state:z.enum(['pending','unknown','unavailable','claimed','skipped-preserved']),message:z.string().nullable(),retryable:z.boolean(),receipt:createdThreadReceiptSchema.optional(),current:currentThreadOwnershipSchema.optional()}).strict();
export type AssignmentStatus=z.infer<typeof assignmentStatusSchema>;
