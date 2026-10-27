import type { BbPluginApi } from '@get-bb/plugin-sdk';
import type { VerifiedFileTarget } from '@phosphorco/bb-cross-references';
import type { SourceIdentity } from '@phosphorco/bb-context-recognition';
import { isAbsolute } from 'node:path';
import { mentionFileFrame,mentionFileHostContract } from './mention-file-contract.ts';

export type VerifiedMentionFile=VerifiedFileTarget;
export type MentionFileVerifier=(source:SourceIdentity,signal:AbortSignal)=>Promise<VerifiedMentionFile|null>;
/** One verifier per source scan. Every root comes from the public source SDK,
 * never from a candidate, opaque path identity, viewer or another plugin. */
export function createMentionFileVerifier(bb:Pick<BbPluginApi,'sdk'|'hosts'>,expected:{threadId:string;projectId:string;environmentId?:string}):MentionFileVerifier {
  const files=new Map<string,Promise<VerifiedMentionFile|null>>();
  let thread:Promise<Awaited<ReturnType<typeof bb.sdk.threads.get>>>|undefined;
  let location:Promise<Awaited<ReturnType<typeof bb.sdk.threads.storageLocation>>>|undefined;
  let environment:Promise<Awaited<ReturnType<typeof bb.sdk.environments.get>>>|undefined;
  let host:ReturnType<typeof bb.hosts.experimental_client<typeof mentionFileHostContract>>|undefined;
  const read=async(source:SourceIdentity,signal:AbortSignal):Promise<VerifiedMentionFile|null>=>{
    const frame=mentionFileFrame(source,expected.threadId);if(!frame)return null;
    signal.throwIfAborted();
    const owner=await(thread??=bb.sdk.threads.get({threadId:expected.threadId,include:'host',signal}));signal.throwIfAborted();
    if(owner.id!==expected.threadId || owner.projectId!==expected.projectId || owner.deletedAt!=null)return null;
    if((owner.environmentId??undefined)!==expected.environmentId)throw new Error('Source filesystem frame changed during collection.');
    const hostId='host' in owner?owner.host?.id:undefined;
    const file=async(root:{hostId:string},rootPath:string)=>{
      if(!root.hostId || !isAbsolute(rootPath) || (hostId && hostId!==root.hostId))throw new Error('Source filesystem host/root mismatch.');
      signal.throwIfAborted();host??=bb.hosts.experimental_client({contract:mentionFileHostContract});
      const result=await host.call('mentionFileExists',{rootPath,path:frame.path},{hostId:root.hostId,signal,timeoutMs:500});
      signal.throwIfAborted();if(result.retryable)throw new Error('Native file verification unavailable.');return result.exists;
    };
    if(frame.frame!=='workspace'){
      const storage=await(location??=bb.sdk.threads.storageLocation({threadId:expected.threadId,signal}));signal.throwIfAborted();
      if(await file(storage,storage.storageRootPath))return {kind:'thread-storage',threadId:owner.id,path:frame.path};
      if(frame.frame==='thread-storage')return null;
    }
    if(!owner.environmentId)return null;
    const workspace=await(environment??=bb.sdk.environments.get({environmentId:owner.environmentId,signal}));signal.throwIfAborted();
    if(workspace.id!==owner.environmentId || workspace.projectId!==owner.projectId || !workspace.path)return null;
    return await file(workspace,workspace.path)?{kind:'workspace',environmentId:workspace.id,path:frame.path}:null;
  };
  return (source,signal)=>{
    signal.throwIfAborted();if(!mentionFileFrame(source,expected.threadId))return Promise.resolve(null);
    let pending=files.get(source.id);if(!pending){pending=read(source,signal);files.set(source.id,pending);}return pending;
  };
}
