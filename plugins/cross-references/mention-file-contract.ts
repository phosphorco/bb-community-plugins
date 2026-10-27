import { defineRpcContract } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import type { SourceIdentity } from '@phosphorco/bb-context-recognition';

/** Same canonical relative-path admission as the existing native consumer.
 * The shared recognizer supplies candidates; this is filesystem containment. */
export function containedMentionPath(path:string):boolean {
  return path.length>0 && path.length<=4096 && !path.startsWith('/') &&
    !/[\\:%?#\u0000-\u001f\u007f]/u.test(path) &&
    path.split('/').every(part=>part.length>0 && part!=='.' && part!=='..');
}
export function mentionFileFrame(source:SourceIdentity,sourceThreadId:string):{path:string;frame?:'workspace'|'thread-storage'}|undefined {
  if(source.provider!=='bb.file')return;
  const colon=source.id.indexOf(':');
  if(colon<=0 || source.id.slice(0,colon)!==sourceThreadId)return;
  let path=source.id.slice(colon+1),frame:'workspace'|'thread-storage'|undefined;
  for(const candidate of ['workspace','thread-storage'] as const)if(path.startsWith(candidate+':')){frame=candidate;path=path.slice(candidate.length+1);break;}
  return containedMentionPath(path)?{path,...(frame?{frame}:{})}:undefined;
}
const path=z.string().min(1).max(4096);
export const mentionFileHostContract=defineRpcContract({
  mentionFileExists:{input:z.strictObject({rootPath:path,path}),output:z.strictObject({exists:z.boolean(),retryable:z.boolean().optional()})},
});
