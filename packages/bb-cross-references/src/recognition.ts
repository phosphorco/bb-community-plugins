/** Pure identity codec. Verification is supplied by the consumer, never inferred
 * from recognition attribution. kind and authored location are not identity. */
import { z } from 'zod';
import { canonicalJson, SourceIdentitySchema, SafeHrefSchema, type SourceIdentity } from '@phosphorco/bb-context-recognition';
import { canonicalizeIdentity, threadIdentity, sha256Hex, type ResourceIdentity } from './canonical.js';
export const RECOGNITION_CODEC_VERSION = 1;
export const MAX_RECOGNITION_IDENTITY_BYTES = 16_384;
export type VerifiedRecognitionThread = {id:string;projectId:string;deletedAt?:number|null};
export function recognitionIdentity(source: SourceIdentity, verified?: VerifiedRecognitionThread): ResourceIdentity {
  const parsed = SourceIdentitySchema.parse(source);
  if (parsed.provider === 'bb.thread') {
    if (!verified || verified.id !== parsed.id || verified.deletedAt != null) throw new Error('A verified existing thread is required.');
    return threadIdentity(verified.projectId, verified.id);
  }
  if (parsed.provider === 'bb.file') throw new Error('Use verifiedFileIdentity with verified frame metadata.');
  if (parsed.provider === 'bb.url') {
    const href = SafeHrefSchema.parse(parsed.id);
    return {provider:'url',keys:canonicalizeIdentity({provider:'url',keys:{href:new URL(href).href}}).keys};
  }
  return {provider:'recognition', keys:{provider:parsed.provider,identity:sha256Hex(canonicalJson([parsed.provider,parsed.id]))}};
}
export function recognitionIdentityRecord(source: SourceIdentity): string {
  const parsed = SourceIdentitySchema.parse(source);
  const json = canonicalJson({provider:parsed.provider,id:parsed.id});
  if (new TextEncoder().encode(json).length > MAX_RECOGNITION_IDENTITY_BYTES) throw new Error('Recognition identity mapping exceeds its bound.');
  return json;
}

/** Verified installation-local file codec. Lexical paths are canonical slash
 * segments; filesystem verification stays in the consumer. No Unicode/case or
 * symlink alias rewriting: realpath establishes containment, never identity. */
export const VerifiedFileTargetSchema = z.discriminatedUnion('kind',[
  z.strictObject({kind:z.literal('workspace'),environmentId:fileOwnerId(),path:verifiedFilePath()}),
  z.strictObject({kind:z.literal('thread-storage'),threadId:fileOwnerId(),path:verifiedFilePath()}),
]);
export type VerifiedFileTarget = z.infer<typeof VerifiedFileTargetSchema>;
function fileOwnerId(){return z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);}
function verifiedFilePath(){return z.string().min(1).max(4096).refine(path=>
  !path.startsWith('/') && !/[\\:%?#\u0000-\u001f\u007f]/u.test(path) &&
  path.split('/').every(part=>part.length>0 && part!=='.' && part!=='..'),'Expected a canonical relative file path.');}
export function verifiedFileIdentity(value:VerifiedFileTarget):ResourceIdentity {
  const file=VerifiedFileTargetSchema.parse(value);
  const owner=file.kind==='workspace'?file.environmentId:file.threadId;
  return {provider:'recognition',keys:{provider:'bb.file',identity:sha256Hex(canonicalJson(['bb.file',file.kind,owner,file.path]))}};
}
export function verifiedFileIdentityRecord(value:VerifiedFileTarget):string {
  const json=canonicalJson({provider:'bb.file',verifiedFile:VerifiedFileTargetSchema.parse(value)});
  if(new TextEncoder().encode(json).length>MAX_RECOGNITION_IDENTITY_BYTES)throw new Error('Verified file mapping exceeds its bound.');
  return json;
}
