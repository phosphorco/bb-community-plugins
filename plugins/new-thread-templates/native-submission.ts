import { z } from 'zod';
import type { NewThreadRequest, NewThreadComposerProps } from '@get-bb/plugin-sdk/app';
import type { BbPluginApi } from '@get-bb/plugin-sdk';

// Feature-owned runtime validation of the public native submission; no SDK declaration copies.
const text=z.string().max(262144),id=z.string().min(1).max(1000);
const visibility=z.enum(['agent-only']).optional();
export const nativeEnvironmentSchema=z.discriminatedUnion('type',[
  z.object({type:z.literal('reuse'),environmentId:id}).strict(),
  z.object({type:z.literal('project-default')}).strict(),
  z.object({type:z.literal('host'),hostId:id.optional(),workspace:z.discriminatedUnion('type',[
    z.object({type:z.literal('unmanaged'),path:z.string().max(16384).nullable(),branch:z.discriminatedUnion('kind',[
      z.object({kind:z.literal('existing'),name:id}).strict(),
      z.object({kind:z.literal('new'),baseBranch:id}).strict(),
    ]).optional()}).strict(),
    z.object({type:z.literal('managed-worktree'),baseBranch:z.discriminatedUnion('kind',[
      z.object({kind:z.literal('default')}).strict(),z.object({kind:z.literal('named'),name:id}).strict(),
    ])}).strict(),
    z.object({type:z.literal('personal')}).strict(),
  ])}).strict(),
  z.object({type:z.literal('provider'),environmentProviderId:id,inputs:z.json(),machine:z.discriminatedUnion('type',[
    z.object({type:z.literal('existing'),hostId:id}).strict(),
    z.object({type:z.literal('new'),machineProviderId:id,inputs:z.json()}).strict(),
  ]).optional()}).strict(),
]);
export const executionSourcesSchema=z.object({
  providerId:z.enum(['explicit','client-preference']).optional(),model:z.enum(['explicit','client-preference']).optional(),
  reasoningLevel:z.enum(['explicit','client-preference']).optional(),permissionMode:z.enum(['explicit','client-preference']).optional(),serviceTier:z.enum(['explicit','client-preference']).optional(),
}).strict();
const mentionResourceSchema=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('thread'),label:text,threadId:id,projectId:id.optional()}).strict(),
  z.object({kind:z.literal('project'),label:text,projectId:id}).strict(),
  z.object({kind:z.literal('section'),label:text,sectionId:id}).strict(),
  z.object({kind:z.literal('path'),label:text,path:text,source:z.enum(['workspace','thread-storage']),entryKind:z.enum(['file','directory'])}).strict(),
  z.object({kind:z.literal('command'),label:text,name:id,argumentHint:text.nullable(),origin:z.enum(['builtin','project','user']),source:z.enum(['command','skill']),trigger:z.enum(['/','$'])}).strict(),
  z.object({kind:z.literal('plugin'),label:text,pluginId:id,itemId:id,icon:text.nullable().optional()}).strict(),
  z.object({kind:z.literal('attachment'),label:text,path:text}).strict(),
]);
const mentionSchema=z.object({start:z.number().int().nonnegative(),end:z.number().int().positive(),resource:mentionResourceSchema}).strict();
const textInputSchema=z.object({type:z.literal('text'),text,mentions:z.array(mentionSchema).max(1000),visibility}).strict().superRefine((input,ctx)=>{
  let end=0;
  for(const [index,mention] of input.mentions.entries()) {
    if(mention.end<=mention.start||mention.end>input.text.length||mention.start<end)ctx.addIssue({code:'custom',path:['mentions',index],message:'Mention ranges must be ordered, non-overlapping and within the text'});
    end=mention.end;
  }
});
export const promptInputSchema=z.discriminatedUnion('type',[
  textInputSchema,
  z.object({type:z.literal('image'),url:z.string().min(1).max(1048576),visibility}).strict(),
  z.object({type:z.literal('localImage'),path:text,hostId:id.optional(),sourceProjectId:id.optional(),visibility}).strict(),
  z.object({type:z.literal('localFile'),path:text,name:text.optional(),mimeType:text.optional(),sizeBytes:z.number().finite().nonnegative().optional(),hostId:id.optional(),sourceProjectId:id.optional(),visibility}).strict(),
]);
export const nativeInputSchema=z.array(promptInputSchema).min(1).max(200);
export const nativeSubmissionSchema=z.object({
  projectId:id,providerId:id,model:id,reasoningLevel:z.string().max(120),permissionMode:z.enum(['auto','full','accept-edits']),
  serviceTier:z.string().max(120).optional(),sessionOptions:z.record(z.string().min(1).max(200),z.union([z.string().max(10000),z.boolean()])).optional(),
  executionInputSources:executionSourcesSchema,environment:nativeEnvironmentSchema,input:nativeInputSchema,
  sendAt:z.number().int().finite().nonnegative().optional(),
}).strict().superRefine((value,ctx)=>{
  if(new TextEncoder().encode(JSON.stringify(value)).length>1048576)ctx.addIssue({code:'custom',message:'The BB request exceeds the 1 MiB limit'});
  if(!value.input.some(part=>part.type!=='text'||part.text.trim().length>0))ctx.addIssue({code:'custom',path:['input'],message:'Enter a message or attach a file'});
});
export type NativeSubmission=z.infer<typeof nativeSubmissionSchema>;
export const nativeEditorSeedSchema=z.object({
  defaultProjectId:id,defaultProviderId:id.optional(),defaultModel:id.optional(),defaultReasoningLevel:z.string().max(120).optional(),
  defaultServiceTier:z.string().max(120).optional(),defaultPermissionMode:z.enum(['auto','full','accept-edits']).optional(),
  defaultEnvironment:nativeEnvironmentSchema,initialPrompt:text,
}).strict();
export type NativeEditorSeed=z.infer<typeof nativeEditorSeedSchema>;
// Compile-time public compatibility in both directions, with actual decoding at runtime.
export function decodeNativeSubmission(value:NewThreadRequest):NativeSubmission {return nativeSubmissionSchema.parse(value);}
export function publicNativeSubmission(value:NativeSubmission):NewThreadRequest {return value;}
export function publicNativeSeed(value:NativeEditorSeed):Pick<NewThreadComposerProps,'defaultProjectId'|'defaultProviderId'|'defaultModel'|'defaultReasoningLevel'|'defaultServiceTier'|'defaultPermissionMode'|'defaultEnvironment'|'initialPrompt'> {return value;}
export function publicNativeSpawn(value:NativeSubmission):Parameters<BbPluginApi['sdk']['threads']['spawn']>[0] {return value;}
