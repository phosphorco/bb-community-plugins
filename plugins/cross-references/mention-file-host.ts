import { experimental_defineHostEntry } from '@get-bb/plugin-sdk/host';
import { constants } from 'node:fs';
import { open,realpath,stat } from 'node:fs/promises';
import { isAbsolute,join,relative,sep } from 'node:path';
import { containedMentionPath,mentionFileHostContract } from './mention-file-contract.ts';

const contained=(root:string,target:string)=>{const path=relative(root,target);return path!=='' && !isAbsolute(path) && path!=='..' && !path.startsWith('..'+sep);};
/** No content reads, directory enumeration, watchers or retained handles. Check
 * opened regular-file facts as well as both realpath lookups to fence symlinks. */
export async function mentionFileExists(rootPath:string,path:string,signal:AbortSignal):Promise<{exists:boolean;retryable?:boolean}> {
  if(!isAbsolute(rootPath) || !containedMentionPath(path))return {exists:false};
  let file:Awaited<ReturnType<typeof open>>|undefined;
  try{
    signal.throwIfAborted();const root=await realpath(rootPath);signal.throwIfAborted();
    if(!(await stat(root)).isDirectory())return {exists:false};
    const target=await realpath(join(root,path));signal.throwIfAborted();
    if(!contained(root,target))return {exists:false};
    file=await open(target,constants.O_RDONLY|constants.O_NONBLOCK|constants.O_NOFOLLOW);
    const facts=await file.stat();signal.throwIfAborted();
    if(!facts.isFile())return {exists:false};
    const opened=await realpath(process.platform==='linux'?`/proc/self/fd/${file.fd}`:target);
    if(!contained(root,opened) || await realpath(rootPath)!==root || await realpath(join(root,path))!==opened)return {exists:false};
    const current=await stat(opened);signal.throwIfAborted();
    return {exists:facts.dev===current.dev && facts.ino===current.ino};
  }catch(error){
    if(signal.aborted)throw error;
    const code=(error as NodeJS.ErrnoException)?.code;
    return {exists:false,...(['ENOENT','ENOTDIR','ELOOP','ENAMETOOLONG'].includes(code??'')?{}:{retryable:true})};
  }finally{await file?.close();}
}
export default experimental_defineHostEntry({contract:mentionFileHostContract,handlers:{
  mentionFileExists:({rootPath,path},context)=>mentionFileExists(rootPath,path,AbortSignal.any([context.signal,context.lifecycle.signal])),
}});
