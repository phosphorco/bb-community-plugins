import { experimental_defineHostEntry } from '@get-bb/plugin-sdk/host';
import { constants } from 'node:fs';
import { open,realpath,stat } from 'node:fs/promises';
import { isAbsolute,join,relative,sep } from 'node:path';
import { containedMentionPath,mentionFileHostContract,diagnosticNow,type MentionDiagnostic,type MentionDiagnosticStage } from './mention-file-contract.ts';

const contained=(root:string,target:string)=>{const path=relative(root,target);return path!=='' && !isAbsolute(path) && path!=='..' && !path.startsWith('..'+sep);};
/** No content reads, directory enumeration, watchers or retained handles. Check
 * opened regular-file facts as well as both realpath lookups to fence symlinks. */
export async function mentionFileExists(rootPath:string,path:string,signal:AbortSignal):Promise<{exists:boolean;retryable?:boolean;diagnostic?:MentionDiagnostic}> {
  if(!isAbsolute(rootPath) || !containedMentionPath(path))return {exists:false};
  let stage:MentionDiagnosticStage='host-root-realpath',started=diagnosticNow();
  const enter=(next:MentionDiagnosticStage)=>{stage=next;started=diagnosticNow();};
  let file:Awaited<ReturnType<typeof open>>|undefined;
  try{
    signal.throwIfAborted();const root=await realpath(rootPath);signal.throwIfAborted();
    enter('host-root-stat');if(!(await stat(root)).isDirectory())return {exists:false};
    enter('host-target-realpath');const target=await realpath(join(root,path));signal.throwIfAborted();
    if(!contained(root,target))return {exists:false};
    enter('host-open');file=await open(target,constants.O_RDONLY|constants.O_NONBLOCK|constants.O_NOFOLLOW);
    enter('host-file-stat');const facts=await file.stat();signal.throwIfAborted();
    if(!facts.isFile())return {exists:false};
    enter('host-opened-realpath');const opened=await realpath(process.platform==='linux'?`/proc/self/fd/${file.fd}`:target);
    enter('host-revalidate');if(!contained(root,opened) || await realpath(rootPath)!==root || await realpath(join(root,path))!==opened)return {exists:false};
    enter('host-current-stat');const current=await stat(opened);signal.throwIfAborted();
    return {exists:facts.dev===current.dev && facts.ino===current.ino};
  }catch(error){
    if(signal.aborted)throw error;
    const code=(error as NodeJS.ErrnoException)?.code;
    if(['ENOENT','ENOTDIR','ELOOP','ENAMETOOLONG'].includes(code??''))return {exists:false};
    const elapsed=diagnosticNow()-started;
    return {exists:false,retryable:true,diagnostic:{stage,reason:['EACCES','EPERM'].includes(code??'')?'host-permission':
      ['EIO','EBUSY','EMFILE','ENFILE','ESTALE'].includes(code??'')?'host-io':'host-unknown',frame:'unknown',
      ...(Number.isFinite(elapsed)?{elapsedMs:Math.min(60_000,Math.max(0,Math.floor(elapsed))),...((elapsed<0||elapsed>60_000)?{capped:true}:{})}:{})}};
  }finally{
    // A failed close still rejects the handler. Without a returned host result
    // the server can honestly identify only the transport boundary.
    enter('host-close');await file?.close();
  }
}
export default experimental_defineHostEntry({contract:mentionFileHostContract,handlers:{
  mentionFileExists:({rootPath,path},context)=>mentionFileExists(rootPath,path,AbortSignal.any([context.signal,context.lifecycle.signal])),
}});
