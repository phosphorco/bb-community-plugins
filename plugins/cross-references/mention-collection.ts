import { LIMITS, arbitrate, nativeCandidates, SafeHrefSchema, type ContextBundleV1, type TaggedCandidateV1, type SourceIdentity, type Span } from '@phosphorco/bb-context-recognition';
import { linkifyAll, type ReadyRecognitionSupplier } from '@phosphorco/bb-context-recognition/bb';
import { recognitionIdentity, recognitionIdentityRecord, verifiedFileIdentity } from '@phosphorco/bb-cross-references';
import { canonicalizeResource, hasSensitiveUrlParameter, serializeResource, sha256Hex, type Resource } from './canonical.ts';
import { assistantLinkLabel, localThreadTarget, webTarget } from './assistant-links.ts';
import { mentionFrame, type MarkdownLink } from './mention-markdown.ts';
import type { MentionFileVerifier, VerifiedMentionFile } from './mention-files.ts';
import { MENTION_LIMITS, MentionLocationSchema, type MentionScan, type ConversationLocator } from './mention-evidence.ts';

export type ConversationMessage = {id:string;text:string;createdAt:number;messageSeq:number;anchorSeq:number|null;role:'user'|'assistant'};
const NATIVE = ['bb.thread','bb.file','bb.url'];
/** Apply existing query/fragment policy to authored routes too. Never strip
 * secrets to manufacture a safe identity or retain them as location metadata. */
function sensitiveDestination(href:string):boolean {
  try{return hasSensitiveUrlParameter(new URL(href,'https://local.invalid'));}catch{return false;}
}
function tagged(source:SourceIdentity, match:string, span:Span):TaggedCandidateV1 {
  return {candidate:{source,match,span,confidence:'high',provenance:{basis:'explicit',explanation:'Authored Markdown destination.'}},
    pluginId:'cross-references',origin:'builtin',specificity:source.provider==='bb.thread'?'typed':'generic',providers:NATIVE};
}
/** One source-wide budget, shared across prose and destination windows. Native
 * candidates are independent of supplier transport and always remain available. */
export async function collectConversationMentions(options:{messages:readonly ConversationMessage[];context:ContextBundleV1;
  clients:readonly ReadyRecognitionSupplier[];getThread:(id:string,signal:AbortSignal)=>Promise<{id:string;projectId:string;deletedAt?:number|null}>;
  signal:AbortSignal;appUrl?:string;discoveryIncomplete?:boolean;failedSuppliers?:string[];verifyFile?:MentionFileVerifier;cache?:Map<string,TaggedCandidateV1[]>;
}):Promise<MentionScan> {
  const scan:MentionScan={occurrences:[],observedMessageIds:[],scannedMessageIds:options.messages.map(m=>m.id),failedSuppliers:[...(options.failedSuppliers??[])],discoveryIncomplete:!!options.discoveryIncomplete,
    coverage:{timelineComplete:true,reasons:[],retentionLimited:false}};
  const reasons=new Set<string>(), failed=new Set(scan.failedSuppliers);
  const deadline=performance.now()+MENTION_LIMITS.sourceMs;
  let calls=0,chars=0,sourceExpired=false;
  const remaining=()=>Math.max(0,deadline-performance.now());
  const expire=()=>{sourceExpired=true;reasons.add('recognition-budget');scan.discoveryIncomplete=true;};
  // Native verification shares the source deadline, even if an injected port
  // ignores AbortSignal. A late result cannot become a confirmed observation.
  const nativeRead=async<T>(run:(signal:AbortSignal)=>Promise<T>):Promise<T>=>{
    const left=remaining();if(sourceExpired || left<=0){expire();throw new Error('Recognition source budget exhausted.');}
    const controller=new AbortController();
    const abort=()=>controller.abort(options.signal.reason);
    options.signal.addEventListener('abort',abort,{once:true});if(options.signal.aborted)abort();
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{
      const value=await Promise.race([Promise.resolve().then(()=>run(controller.signal)),new Promise<never>((_,reject)=>{
        const rejectAbort=()=>reject(controller.signal.reason??new Error('Native verification cancelled.'));
        controller.signal.addEventListener('abort',rejectAbort,{once:true});if(controller.signal.aborted)rejectAbort();
        timer=setTimeout(()=>{if(left<=500)expire();controller.abort(new Error('Native verification deadline exceeded.'));},Math.min(500,left));
      })]);
      options.signal.throwIfAborted();
      if(remaining()<=0){expire();throw new Error('Recognition source budget exhausted.');}
      return value;
    }finally{clearTimeout(timer);options.signal.removeEventListener('abort',abort);controller.abort();}
  };
  const threads=new Map<string,Promise<{id:string;projectId:string;deletedAt?:number|null}>>();
  const getThread = (id:string) => {let promise=threads.get(id);if(!promise){promise=nativeRead(signal=>options.getThread(id,signal));threads.set(id,promise);}return promise;};
  const contribute = async (text:string,excluded:Span[],context:ContextBundleV1,format:'plain'|'markdown'='plain'):Promise<TaggedCandidateV1[]> => {
    if(!options.clients.length)return [];
    const key=sha256Hex(JSON.stringify([options.clients.map(c=>[c.client.pluginId,c.capabilities.revision]),text,format,excluded,context]));
    const cached=options.cache?.get(key);if(cached)return structuredClone(cached);
    if(calls>=MENTION_LIMITS.calls || performance.now()>=deadline){reasons.add('recognition-budget');scan.discoveryIncomplete=true;return [];}
    calls++;
    const result=await linkifyAll({clients:options.clients,input:{version:1,text,format,excluded,context},signal:options.signal,
      budgets:{overallDeadline:deadline}});
    for(const outcome of result.outcomes)if(outcome.state!=='ready')failed.add(outcome.pluginId);
    if(result.outcomes.every(o=>o.state==='ready') && JSON.stringify(result.results).length<=65_536){
      options.cache?.set(key,structuredClone(result.results));
      while(options.cache && options.cache.size>64)options.cache.delete(options.cache.keys().next().value!);
    }
    return result.results;
  };
  const fileChecks=new Map<string,Promise<VerifiedMentionFile|null>>();
  let verificationFailed=false;
  const adapt = async (source:SourceIdentity,label:string,href?:string):Promise<Resource|null> => {
    try {
      let verified;
      if(source.provider==='bb.thread'){
        try{verified=await getThread(source.id);}catch(error){
          if(!(typeof error==='object' && error!==null && 'status' in error && error.status===404)){
            verificationFailed=true;reasons.add('thread-verification');
          }
          return null;
        }
        const local=href?localThreadTarget(href,options.appUrl):null;
        if(local && (local.projectId!==verified.projectId || local.threadId!==verified.id))return null;
      }
      let verifiedFile:VerifiedMentionFile|null|undefined;
      if(source.provider==='bb.file'){
        try{
          let pending=fileChecks.get(source.id);
          if(!pending){
            if(!options.verifyFile)throw new Error('Native file verifier unavailable.');
            pending=nativeRead(signal=>options.verifyFile!(source,signal));fileChecks.set(source.id,pending);
          }
          verifiedFile=await pending;if(!verifiedFile)return null;
        }catch{verificationFailed=true;reasons.add('file-verification');return null;}
      }
      const identity=verifiedFile?verifiedFileIdentity(verifiedFile):recognitionIdentity(source,verified);
      const route=identity.provider==='bb'?`/projects/${identity.keys.project}/threads/${identity.keys.thread}`:identity.provider==='url'?identity.keys.href:href;
      const presentation={label:assistantLinkLabel(label,source.kind??source.provider),detail:source.provider,...(route && SafeHrefSchema.safeParse(route).success?{url:route}:{})};
      recognitionIdentityRecord(source);
      return serializeResource(canonicalizeResource({...identity,presentation}));
    }catch{return null;}
  };
  for(const message of options.messages.slice(0,MENTION_LIMITS.messages)){
    options.signal.throwIfAborted();
    if(sourceExpired || remaining()<=0){expire();break;}
    if(message.text.length>MENTION_LIMITS.messageChars || chars+message.text.length>MENTION_LIMITS.sourceChars){reasons.add('source-text-budget');continue;}
    chars+=message.text.length;
    verificationFailed=false;
    const frame=mentionFrame(message.text);
    let fullyObserved=!frame.limited;
    if(frame.limited)reasons.add('message-window-budget');
    const all:TaggedCandidateV1[]=[];
    const authored=new Map<string,MarkdownLink>();
    // Links are withheld from prose recognition, then recognized as whole
    // destinations. One Markdown link and its typed result share one span.
    for(const window of frame.windows){
      if(window.start<0 || window.end>message.text.length || window.end-window.start>LIMITS.textChars){fullyObserved=false;reasons.add('message-window-budget');continue;}
      const text=message.text.slice(window.start,window.end);
      const excluded=frame.excluded.flatMap(s=>{const start=Math.max(s.start,window.start),end=Math.min(s.end,window.end);return end>start?[{start:start-window.start,end:end-window.start}]:[];});
      if(excluded.length>LIMITS.excludedRanges){fullyObserved=false;reasons.add('exclusion-budget');continue;}
      const links=frame.links.filter(l=>l.span.start>=window.start && l.span.end<=window.end && SafeHrefSchema.safeParse(l.href).success && webTarget({url:l.href,label:l.label,lastSeenAt:message.createdAt}));
      if(links.length>LIMITS.links){fullyObserved=false;reasons.add('context-link-budget');}
      const context={...options.context,links:links.slice(0,LIMITS.links).map(l=>({href:l.href,span:{start:l.span.start-window.start,end:l.span.end-window.start}}))};
      // Mask excluded text so suppliers cannot infer context from code/images.
      let visible=text;
      for(const s of excluded)visible=visible.slice(0,s.start)+' '.repeat(s.end-s.start)+visible.slice(s.end);
      const native=nativeCandidates({version:1,text,format:'markdown',excluded,context},options.appUrl).map(candidate=>({candidate,pluginId:'cross-references',origin:'builtin' as const,specificity:candidate.source.provider==='bb.thread'?'typed' as const:'generic' as const,providers:NATIVE}));
      const contributed=await contribute(visible,excluded,context,'markdown');
      if(native.length>=LIMITS.candidatesPerCall || contributed.length>=LIMITS.candidatesPerCall){fullyObserved=false;reasons.add('candidate-budget');}
      const remap=(item:TaggedCandidateV1):TaggedCandidateV1=>{
        const result=structuredClone(item);result.candidate.span={start:item.candidate.span.start+window.start,end:item.candidate.span.end+window.start};
        if(result.candidate.provenance.evidence?.span){result.candidate.provenance.evidence.span={start:result.candidate.provenance.evidence.span.start+window.start,end:result.candidate.provenance.evidence.span.end+window.start};}
        return result;
      };
      all.push(...native.map(remap),...contributed.map(remap));
    }
    for(const link of frame.links){
      if(sensitiveDestination(link.href))continue;
      if(!frame.windows.some(w=>link.span.start>=w.start && link.span.end<=w.end))continue;
      // Existing canonical URL policy is applied before any supplier can
      // promote a URL to an opaque typed identity.
      const web=webTarget({url:link.href,label:link.label,lastSeenAt:message.createdAt});
      const local=localThreadTarget(link.href,options.appUrl);
      const safe=SafeHrefSchema.safeParse(link.href).success;
      const relative=link.href.length<=4096 && !/^[a-z][a-z0-9+.-]*:|^[\/]|[\\\p{Cc}]/iu.test(link.href) && !link.href.split('/').some(part=>part==='..');
      if(!web && !local && !safe && !relative)continue;
      if(/^https?:/iu.test(link.href) && !web)continue;
      const native:TaggedCandidateV1[]=[];
      if(local)native.push(tagged({provider:'bb.thread',id:local.threadId,kind:'session'},link.href,{start:0,end:link.href.length}));
      if(web)native.push(tagged({provider:'bb.url',id:web.keys.href!,kind:'url'},link.href,{start:0,end:link.href.length}));
      // Relative files retain thread/environment framing, without guessing a
      // target URL or doing filesystem I/O in the recognition stage.
      if(!web && !local)native.push(...nativeCandidates({version:1,text:link.href,format:'plain',excluded:[],context:{...options.context,links:[]}},options.appUrl).map(candidate=>({...tagged(candidate.source,candidate.match,candidate.span),candidate})));
      const context={...options.context,links:safe?[{href:link.href}]:[]};
      const contributed=(safe||relative)?await contribute(link.href,[],context):[];
      const winner=arbitrate([...native,...contributed].filter(t=>t.candidate.span.start===0 && t.candidate.span.end===link.href.length),{text:link.href,excluded:[],implementedProviders:NATIVE}).occurrences[0];
      if(!winner)continue;
      const remap=(item:TaggedCandidateV1):TaggedCandidateV1=>{
        const result=structuredClone(item);result.candidate.span=link.span;result.candidate.match=message.text.slice(link.span.start,link.span.end);
        if(result.candidate.provenance.evidence)delete result.candidate.provenance.evidence;
        return result;
      };
      const mapped=remap(winner);all.push(mapped);
      if(winner.fallback)all.push(remap(winner.fallback));
      authored.set(`${link.span.start}:${link.span.end}`,link);
    }
    // Explicit destinations are excluded in the prose frame, so admit their
    // already validated candidates separately in the final arbitration.
    const admitted=arbitrate(all,{text:message.text,excluded:[],implementedProviders:NATIVE}).occurrences;
    const locator:ConversationLocator={kind:'conversation',threadId:options.context.threadId!,messageId:message.id,messageSeq:message.messageSeq,anchorSeq:message.anchorSeq,role:message.role};
    const sourceContentRevision=sha256Hex(message.text);
    for(const item of admitted){
      if(sourceExpired || remaining()<=0){expire();fullyObserved=false;break;}
      const c=item.candidate, link=authored.get(`${c.span.start}:${c.span.end}`);
      // Prose routes carry an authored project just like Markdown destinations.
      // Keep it through native verification; plain thread IDs have no route to check.
      const fallbackHref=link?.href ?? (localThreadTarget(c.match,options.appUrl)?c.match:
        c.source.provider==='bb.url'?c.source.id:undefined);
      // Supplier candidates cannot sneak a sensitive URL past the native floor.
      if(sensitiveDestination(c.match))continue;
      if(/^https?:\/\//iu.test(c.match) && !webTarget({url:c.match,label:c.match,lastSeenAt:message.createdAt}))continue;
      let selected:TaggedCandidateV1=item;
      let target=await adapt(c.source,link?.label??c.match,fallbackHref);
      if(!target && item.fallback){selected=item.fallback;target=await adapt(selected.candidate.source,link?.label??c.match,fallbackHref);}
      if(sourceExpired || remaining()<=0){expire();fullyObserved=false;break;}
      if(!target)continue;
      const verifiedFile=selected.candidate.source.provider==='bb.file'?await fileChecks.get(selected.candidate.source.id):undefined;
      const location=MentionLocationSchema.parse({locator,sourceContentRevision,span:c.span,messageCreatedAt:message.createdAt,
        provenance:{pluginId:selected.pluginId,origin:selected.origin,confidence:selected.candidate.confidence,recognition:selected.candidate.provenance,source:selected.candidate.source,...(verifiedFile?{verifiedFile}:{}),
          ...(fallbackHref && !sensitiveDestination(fallbackHref) && SafeHrefSchema.safeParse(fallbackHref).success && !new URL(fallbackHref,'https://local.invalid').username?{authoredHref:fallbackHref}:{})}});
      scan.occurrences.push({...location,target});
      if(scan.occurrences.length>=MENTION_LIMITS.locations){fullyObserved=false;reasons.add('location-budget');break;}
    }
    if(fullyObserved && !verificationFailed && !sourceExpired)scan.observedMessageIds.push(message.id);
    if(scan.occurrences.length>=MENTION_LIMITS.locations)break;
  }
  if(options.messages.length>MENTION_LIMITS.messages)reasons.add('message-budget');
  if(failed.size)reasons.add('supplier-failure');
  if(scan.discoveryIncomplete)reasons.add('supplier-coverage');
  scan.failedSuppliers=[...failed].sort();scan.coverage.reasons=[...reasons].sort();
  return scan;
}
