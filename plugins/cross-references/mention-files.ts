import type { BbPluginApi } from '@get-bb/plugin-sdk';
import type { VerifiedFileTarget } from '@phosphorco/bb-cross-references';
import type { SourceIdentity } from '@phosphorco/bb-context-recognition';
import { isAbsolute } from 'node:path';
import { mentionFileFrame,mentionFileHostContract,safeHostMentionDiagnostic,type MentionDiagnosticOperation,type MentionDiagnosticStage } from './mention-file-contract.ts';

export type VerifiedMentionFile=VerifiedFileTarget;
export type MentionFileVerifier=(source:SourceIdentity,signal:AbortSignal,diagnostic?:MentionDiagnosticOperation)=>Promise<VerifiedMentionFile|null>;
/** One verifier per source scan. Every root comes from the public source SDK,
 * never from a candidate, opaque path identity, viewer or another plugin. */
export function createMentionFileVerifier(bb:Pick<BbPluginApi,'sdk'|'hosts'>,expected:{threadId:string;projectId:string;environmentId?:string}):MentionFileVerifier {
  const files=new Map<string,Promise<VerifiedMentionFile|null>>();
  let thread:Promise<Awaited<ReturnType<typeof bb.sdk.threads.get>>>|undefined;
  let location:Promise<Awaited<ReturnType<typeof bb.sdk.threads.storageLocation>>>|undefined;
  let environment:Promise<Awaited<ReturnType<typeof bb.sdk.environments.get>>>|undefined;
  let host:ReturnType<typeof bb.hosts.experimental_client<typeof mentionFileHostContract>>|undefined;
  // Only the initial operation owns a cached SDK failure. Replaying the same
  // rejected metadata promise is not another SDK request/diagnostic observation.
  const metadata=async<T>(stage:MentionDiagnosticStage,cached:Promise<T>|undefined,run:()=>Promise<T>,signal:AbortSignal,diagnostic?:MentionDiagnosticOperation,frame?:'thread-storage'|'workspace'):Promise<T>=>{
    diagnostic?.enter(stage,frame);
    try{return await(cached??run());}catch(error){
      if(cached)diagnostic?.close();else diagnostic?.fail(signal.aborted?'cancelled':'sdk-failure');
      throw error;
    }
  };
  const read=async(source:SourceIdentity,signal:AbortSignal,diagnostic?:MentionDiagnosticOperation):Promise<VerifiedMentionFile|null>=>{
    const frame=mentionFileFrame(source,expected.threadId);if(!frame)return null;
    signal.throwIfAborted();
    const owner=await metadata('source-owner',thread,()=>thread=bb.sdk.threads.get({threadId:expected.threadId,include:'host',signal}),signal,diagnostic,frame.frame);signal.throwIfAborted();
    if(owner.id!==expected.threadId || owner.projectId!==expected.projectId || owner.deletedAt!=null)return null;
    if((owner.environmentId??undefined)!==expected.environmentId){diagnostic?.enter('source-owner');diagnostic?.fail('frame-changed');throw new Error('Source filesystem frame changed during collection.');}
    const hostId='host' in owner?owner.host?.id:undefined;
    const file=async(root:{hostId:string},rootPath:string,kind:'thread-storage'|'workspace')=>{
      diagnostic?.enter('host-admission',kind);
      if(!root.hostId || !isAbsolute(rootPath) || (hostId && hostId!==root.hostId)){diagnostic?.fail('host-root-mismatch');throw new Error('Source filesystem host/root mismatch.');}
      signal.throwIfAborted();
      try{
        host??=bb.hosts.experimental_client({contract:mentionFileHostContract});
        diagnostic?.enter('host-transport',kind);
        const result=await host.call('mentionFileExists',{rootPath,path:frame.path},{hostId:root.hostId,signal,timeoutMs:500});
        signal.throwIfAborted();
        if(result.retryable){
          if(result.diagnostic!==undefined){
            const detail=safeHostMentionDiagnostic(result.diagnostic);
            // Rejected detail knows only the entered server transport wait.
            // Valid host-stage timing (including unknown timing) stays separate.
            if(detail.stage==='host-transport')diagnostic?.fail('host-unknown');
            else diagnostic?.report({...detail,frame:kind});
          }else diagnostic?.fail('retryable-host-response');
          throw new Error('Native file verification unavailable.');
        }
        return result.exists;
      }catch(error){diagnostic?.fail(signal.aborted?'cancelled':'transport-failure');throw error;}
    };
    if(frame.frame!=='workspace'){
      const storage=await metadata('thread-storage',location,()=>location=bb.sdk.threads.storageLocation({threadId:expected.threadId,signal}),signal,diagnostic,'thread-storage');signal.throwIfAborted();
      if(await file(storage,storage.storageRootPath,'thread-storage'))return {kind:'thread-storage',threadId:owner.id,path:frame.path};
      if(frame.frame==='thread-storage')return null;
    }
    if(!owner.environmentId)return null;
    const workspace=await metadata('environment',environment,()=>environment=bb.sdk.environments.get({environmentId:owner.environmentId!,signal}),signal,diagnostic,'workspace');signal.throwIfAborted();
    if(workspace.id!==owner.environmentId || workspace.projectId!==owner.projectId || !workspace.path)return null;
    return await file(workspace,workspace.path,'workspace')?{kind:'workspace',environmentId:workspace.id,path:frame.path}:null;
  };
  return (source,signal,diagnostic)=>{
    signal.throwIfAborted();if(!mentionFileFrame(source,expected.threadId))return Promise.resolve(null);
    let pending=files.get(source.id);if(!pending){pending=read(source,signal,diagnostic);files.set(source.id,pending);}else diagnostic?.close();return pending;
  };
}
