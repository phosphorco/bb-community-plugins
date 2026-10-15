import { z } from 'zod';
import type { BbPluginApi } from '@get-bb/plugin-sdk';
import type { BbPromptInput, BbIdentityBinding } from '@phosphorco/bb-identity/bb';
import { attachmentReferencesSchema, filenameSchema, declaredMimeTypeSchema, LIMITS } from './index.js';
import type { AttachmentReference } from './index.js';
export type { BbPromptInput } from '@phosphorco/bb-identity/bb';
export type ExternalAcceptanceGateway = Pick<BbIdentityBinding['server'],'sendExternal'|'lookupOperation'|'history'>;
export type NativeAttachmentClient = BbPluginApi['sdk']['projects']['attachments'];
export type NativeAttachmentDescriptor = Awaited<ReturnType<NativeAttachmentClient['upload']>>;
// Private feature manifests only. Never expose these paths in external DTOs.
const pathSchema=z.string().min(1).max(4096).refine(p=>!p.includes('\0')&&!p.split(/[\\/]/).includes('..'));
export const nativeAttachmentDescriptorSchema = z.object({type:z.enum(['localImage','localFile']),path:pathSchema,name:filenameSchema,sizeBytes:z.number().int().positive().max(LIMITS.fileBytes),mimeType:declaredMimeTypeSchema.optional(),sourceProjectId:z.string().min(1).max(256).optional()}).strict().superRefine((v,c)=>{if(v.type==='localImage' && (v.sizeBytes>LIMITS.imageBytes || (v.mimeType!==undefined && !v.mimeType.startsWith('image/'))))c.addIssue({code:'custom',message:'Invalid native image metadata'});if(v.type==='localFile' && v.mimeType?.startsWith('image/'))c.addIssue({code:'custom',message:'Image MIME requires localImage'});if(v.sourceProjectId && /^(\/|[A-Za-z]:|\\)/.test(v.path))c.addIssue({code:'custom',message:'Source hint requires relative native path'});});
export function nativeAttachmentInput(descriptor:NativeAttachmentDescriptor):BbPromptInput {
 const d=nativeAttachmentDescriptorSchema.parse(descriptor);
 const source=d.sourceProjectId?{sourceProjectId:d.sourceProjectId}:{};
 return d.type==='localImage'?{type:'localImage',path:d.path,...source}:{type:'localFile',path:d.path,name:d.name,sizeBytes:d.sizeBytes,...(d.mimeType?{mimeType:d.mimeType}:{}),...source};
}
/** Resolver enforces connection/intake/project ownership and manifest/digest equality.
 * Persist the resulting immutable prompt snapshot before possible dispatch. */
export async function resolveAttachmentInputs(refs:readonly AttachmentReference[],resolve:(ref:AttachmentReference,signal?:AbortSignal)=>Promise<NativeAttachmentDescriptor>,signal?:AbortSignal):Promise<BbPromptInput[]>{
 const parsed=attachmentReferencesSchema.parse(refs);const inputs:BbPromptInput[]=[];
 for(const ref of parsed){signal?.throwIfAborted();const descriptor=nativeAttachmentDescriptorSchema.parse(await resolve(ref,signal));signal?.throwIfAborted();
  if(descriptor.name!==ref.filename||descriptor.sizeBytes!==ref.sizeBytes||descriptor.mimeType!==ref.declaredMimeType||(descriptor.type==='localImage'?'image':'file')!==ref.presentationKind)throw new Error('Native manifest metadata differs');
  inputs.push(nativeAttachmentInput(descriptor));
 }return inputs;
}
