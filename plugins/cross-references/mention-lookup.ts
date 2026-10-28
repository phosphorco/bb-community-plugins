/** Side-effect-free query normalization: no discovery, card resolve or enqueue. */
import { arbitrate,nativeCandidates,canonicalJson,type ContextBundleV1,type TaggedCandidateV1 } from '@phosphorco/bb-context-recognition';
import { linkifyAll,type ReadyRecognitionSupplier } from '@phosphorco/bb-context-recognition/bb';
import { resolveLookupInputV2Schema,resolveLookupOutputV2Schema,safeAuthoredHrefSchema,githubLookup,recognitionIdentity,
 MENTION_V2_LIMITS,utf8ByteLength,type ResolveLookupInputV2,type ResolveLookupOutputV2,type MentionQueryV2 } from '@phosphorco/bb-cross-references';
import { localThreadTarget,webTarget } from './assistant-links.ts';
const nativeProviders=['bb.thread','bb.file','bb.url'];
export function createMentionLookup(options:{snapshot:()=>{clients:readonly ReadyRecognitionSupplier[];incomplete:boolean;signal:AbortSignal};
 now?:()=>number;getThread:(id:string,signal:AbortSignal)=>Promise<{id:string;projectId:string;deletedAt?:number|null}>;appUrl?:string}){
 const now=options.now??(()=>performance.now());
 return async(raw:ResolveLookupInputV2):Promise<ResolveLookupOutputV2>=>{
  if(utf8ByteLength(JSON.stringify(raw))>65536)throw new Error('Lookup input byte bound.');const input=resolveLookupInputV2Schema.parse(raw);
  if(input.mode==='exact-url')return {version:2,state:'ready',options:[{query:{kind:'authored-url',href:safeAuthoredHrefSchema.parse(input.text)},label:'Exact URL',inputSpan:{start:0,end:input.text.length},basis:'native',reasons:[]}],reasons:[]};
  const snapshot=options.snapshot(),deadline=now()+MENTION_V2_LIMITS.lookupMs,reasons=new Set<string>();
  if(snapshot.incomplete)reasons.add('supplier-coverage');
  const context:ContextBundleV1={...input.context,links:input.context?.links??[],consumer:{pluginId:'cross-references',surface:'mention-lookup'}};
  const request={version:1 as const,text:input.text,format:'plain' as const,excluded:[],context};
  const native:TaggedCandidateV1[]=nativeCandidates(request,options.appUrl).map(candidate=>({candidate,pluginId:'cross-references',origin:'builtin',specificity:candidate.source.provider==='bb.url'?'generic':'typed',providers:nativeProviders}));
  const clients=snapshot.clients.slice(0,MENTION_V2_LIMITS.lookupCalls);if(snapshot.clients.length>clients.length)reasons.add('supplier-budget');
  const contributed=clients.length?await linkifyAll({clients,input:request,signal:snapshot.signal,budgets:{overallDeadline:deadline}}):{results:[],outcomes:[]};
  for(const outcome of contributed.outcomes)if(outcome.state!=='ready')reasons.add('supplier-failure');
  if(snapshot.signal.aborted)return {version:2,state:'incomplete',options:[],reasons:['cancelled']};
  const selected=arbitrate([...native,...contributed.results],{text:input.text,excluded:[],implementedProviders:nativeProviders}).occurrences;
  const rows:ResolveLookupOutputV2['options']=[],seen=new Set<string>(),threads=new Map<string,Promise<{id:string;projectId:string;deletedAt?:number|null}>>();
  const add=(query:MentionQueryV2,label:string,span:{start:number;end:number},basis:'native'|'supplier'|'stored-codec')=>{const key=canonicalJson([query,span]);if(seen.has(key))return;seen.add(key);if(rows.length>=8){reasons.add('option-budget');return;}rows.push({query,label:utf8ByteLength(label)<=256?label:'Recognized resource',inputSpan:span,basis,reasons:[]});};
  async function verify(id:string){let promise=threads.get(id);if(promise)return promise;
   const left=deadline-now();if(left<=0)throw new Error('lookup deadline');const controller=new AbortController(),abort=()=>controller.abort(snapshot.signal.reason);snapshot.signal.addEventListener('abort',abort,{once:true});if(snapshot.signal.aborted)abort();
   promise=(async()=>{let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([options.getThread(id,controller.signal),new Promise<never>((_,reject)=>{
    const fail=()=>reject(new Error('Lookup verification cancelled.'));controller.signal.addEventListener('abort',fail,{once:true});if(controller.signal.aborted)fail();timer=setTimeout(()=>controller.abort(),Math.min(500,left));
   })]);}finally{clearTimeout(timer);snapshot.signal.removeEventListener('abort',abort);controller.abort();}})();threads.set(id,promise);return promise;
  }
  // Explicit whole-URL codec authority never creates a graph fact. It also
  // avoids relying on availability of the GitHub supplier for pasted PRs.
  const full=githubLookup(input.text);
  if(full)add(full.query,full.label,{start:0,end:input.text.length},contributed.results.some(r=>r.candidate.span.start===0&&r.candidate.span.end===input.text.length&&r.candidate.source.provider==='github')?'supplier':'stored-codec');
  for(const item of selected){if(now()>=deadline){reasons.add('lookup-budget');break;}snapshot.signal.throwIfAborted();const c=item.candidate;
   if(/^(?:https?:\/\/|\/)/iu.test(c.match)&&!safeAuthoredHrefSchema.safeParse(c.match).success)continue;
   if(full&&c.span.start===0&&c.span.end===input.text.length)continue;
   const codec=githubLookup(c.match);if(codec){add(codec.query,codec.label,c.span,item.origin==='contributed'?'supplier':'stored-codec');continue;}
   try{
    if(c.source.provider==='bb.file'){reasons.add('file-verification-required');continue;}
    let target;
    if(c.source.provider==='bb.thread'){
     const thread=await verify(c.source.id);if(snapshot.signal.aborted||now()>=deadline){reasons.add(snapshot.signal.aborted?'cancelled':'lookup-budget');break;}const route=localThreadTarget(c.match,options.appUrl);
     if(route&&(route.projectId!==thread.projectId||route.threadId!==thread.id)){
      if(/^https?:\/\//iu.test(c.match)&&webTarget({url:c.match,label:c.match,lastSeenAt:0}))add({kind:'resource',target:recognitionIdentity({provider:'bb.url',id:c.match}),relation:'self'},'URL',c.span,'native');
      continue;
     }
     target=recognitionIdentity(c.source,thread);
    }else{if(c.source.provider==='bb.url'&&!webTarget({url:c.source.id,label:c.match,lastSeenAt:0}))continue;target=recognitionIdentity(c.source);}
    add({kind:'resource',target,relation:'self'},c.match,c.span,item.origin==='builtin'?'native':'supplier');
   }catch(error){if(!(typeof error==='object'&&error!==null&&'status' in error&&error.status===404))reasons.add('native-verification');}
  }
  if(now()>=deadline)reasons.add('lookup-budget');
  return resolveLookupOutputV2Schema.parse({version:2,state:reasons.size?'incomplete':rows.length>1?'ambiguous':rows.length?'ready':'unrecognized',options:rows,reasons:[...reasons].sort().slice(0,16)});
 };
}
