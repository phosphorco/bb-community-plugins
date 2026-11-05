/** Authoritative, plugin-local read-only owner. No service, watchers, graph or product imports. */
import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { identityKey, checkCandidate, type ContextBundleV1, type TaggedCandidateV1, type ResolutionV1, type SourceIdentity, type JsonValue } from '@phosphorco/bb-context-recognition';
import { createRecognitionDiscoveryOwner, enumerateRecognitionSuppliers, linkifyAll, resolveAll, type RecognitionDiscoverySnapshot, type RecognitionSdk } from '@phosphorco/bb-context-recognition/bb';
import { MARKDOWN_LIMITS, MarkdownRequestSchema, MarkdownPrepareInputSchema, createLiteralMarkdown, markdownRequestKey, type MarkdownRequest, type MarkdownPrepareInput, type PreparedMarkdown, type MarkdownDocument, type MarkdownDiagnostic } from './index.js';
import { compileGrammar, compilePreparedTree, opaqueUriTokens, applyEdits, nativeThreadTokens, escapeLabel, safeExternal, safeAppRoute, overlap, type MarkdownGrammar, type Edit } from './grammar.js';
export { MarkdownPrepareInputSchema, MarkdownPrepareOutputSchema } from './index.js';
export interface MarkdownSdk {
  threads: Pick<BbPluginApi['sdk']['threads'], 'get'>;
  environments: Pick<BbPluginApi['sdk']['environments'], 'get'>;
  plugins: {
    list: RecognitionSdk['plugins']['list'];
    /** The SDK transport consumes parse() and returns the parsed result.
     * A nongeneric method keeps cross-SDK/Zod structural checks finite. */
    callRpc(args:{pluginId:string;method:string;input?:JsonValue;outputSchema:{parse(input:unknown):unknown};signal?:AbortSignal}):Promise<unknown>;
  };
}
export interface MarkdownOwnerOptions { sdk: MarkdownSdk; consumer: { pluginId: string; surface?: string }; publicOrigin?: string }
export interface MarkdownOwner { prepare(input: MarkdownPrepareInput, signal?: AbortSignal): Promise<PreparedMarkdown[]>; invalidate(): void; dispose(): void }
const threadMetaSchema = z.object({ id: z.string().regex(/^thr_[23456789abcdefghijkmnpqrstuvwxyz]{10}$/), projectId: z.string().regex(/^proj_[a-z0-9]+$/).max(128), environmentId: z.string().regex(/^env_[a-z0-9]+$/).max(128).nullable(), deletedAt: z.number().nullable(), title: z.string().max(4096).nullable(), titleFallback: z.string().max(4096).nullable().optional() });
const environmentMetaSchema = z.object({ id: z.string(), projectId: z.string(), path: z.string().max(4096).nullable() });
type ThreadMeta = z.infer<typeof threadMetaSchema>;
type EnvironmentMeta = z.infer<typeof environmentMetaSchema>;
interface Base { request: MarkdownRequest; prepared: PreparedMarkdown; grammar: MarkdownGrammar | undefined; context: ContextBundleV1; local: boolean }
const diagnostic = (code: string, message: string): MarkdownDiagnostic => ({code,message});
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
function abortError(): Error { return Object.assign(new Error('Markdown demand cancelled.'), {name:'AbortError'}); }
function live(signal: AbortSignal) { if (signal.aborted) throw abortError(); }
/** Deadline and abort fence do not assert that a remote read stopped. */
function bounded<T>(read: (signal: AbortSignal) => Promise<T>, signal: AbortSignal, ms: number): Promise<T> {
  return new Promise((resolve,reject) => {
    if (signal.aborted) { reject(abortError()); return; }
    const controller = new AbortController();
    let done = false;
    const finish = (error?: unknown, value?: T) => { if(done)return; done=true; clearTimeout(timer); signal.removeEventListener('abort',abort); controller.abort(); if(error)reject(error);else resolve(value as T); };
    const abort = () => finish(abortError());
    const timer = setTimeout(() => finish(new Error('Markdown read deadline exceeded.')),ms);
    signal.addEventListener('abort',abort,{once:true});
    Promise.resolve().then(() => { live(controller.signal); return read(controller.signal); }).then(value => finish(undefined,value),error => finish(error));
  });
}
function fence<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if(!signal)return promise;
  return new Promise((resolve,reject) => {
    const abort=()=>reject(abortError());
    if(signal.aborted){abort();return;}
    signal.addEventListener('abort',abort,{once:true});
    promise.then(value=>{signal.removeEventListener('abort',abort);if(signal.aborted)reject(abortError());else resolve(value);},error=>{signal.removeEventListener('abort',abort);reject(error);});
  });
}
class Lru<T> {
  private values = new Map<string,{value:T;size:number}>(); private size=0;
  constructor(private count:number,private chars=MARKDOWN_LIMITS.cacheChars){}
  get(key:string):T|undefined { const row=this.values.get(key);if(!row)return;this.values.delete(key);this.values.set(key,row);return row.value; }
  set(key:string,value:T,size=1) { const old=this.values.get(key);if(old){this.size-=old.size;this.values.delete(key);} if(size>this.chars)return;this.values.set(key,{value,size});this.size+=size;while(this.values.size>this.count || this.size>this.chars){const first=this.values.keys().next().value!;this.size-=this.values.get(first)!.size;this.values.delete(first);} }
  clear(){this.values.clear();this.size=0;}
}
/** Admission and aggregate concurrency are shared by all source and supplier reads. */
class ReadQueue {
  private active=0; private pending:{run:()=>void;reject:(error:unknown)=>void}[]=[];
  run<T>(fn:()=>Promise<T>,signal:AbortSignal):Promise<T>{
    if(this.pending.length>=MARKDOWN_LIMITS.inflight)return Promise.reject(new Error('Markdown read capacity reached.'));
    return new Promise<T>((resolve,reject)=>{
      const run=()=>{if(signal.aborted){reject(abortError());this.drain();return;}this.active++;Promise.resolve().then(fn).then(resolve,reject).finally(()=>{this.active--;this.drain();});};
      if(this.active<MARKDOWN_LIMITS.concurrency)run();else this.pending.push({run,reject});
    });
  }
  private drain(){while(this.active<MARKDOWN_LIMITS.concurrency && this.pending.length)this.pending.shift()!.run();}
  clear(){for(const row of this.pending)row.reject(abortError());this.pending=[];}
}
export function createMarkdownOwner(options: MarkdownOwnerOptions): MarkdownOwner {
  const {sdk}=options;
  const consumer=z.object({pluginId:z.string().min(1).max(128),surface:z.string().min(1).max(64).optional()}).strict().parse(options.consumer);
  let origin:string|undefined;
  if(options.publicOrigin){const url=new URL(options.publicOrigin);if(!safeExternal(options.publicOrigin)||url.pathname!=='/'||url.search||url.hash)throw new Error('publicOrigin must be an HTTP(S) origin.');origin=url.origin;}
  const queue=new ReadQueue();
  const sourceCache=new Lru<Base>(MARKDOWN_LIMITS.sources), enrichedCache=new Lru<PreparedMarkdown>(MARKDOWN_LIMITS.sources);
  const threadCache=new Lru<ThreadMeta>(MARKDOWN_LIMITS.metadata), environmentCache=new Lru<EnvironmentMeta>(MARKDOWN_LIMITS.metadata);
  const resolutionCache=new Lru<ResolutionV1>(MARKDOWN_LIMITS.resources);
  const pending=new Map<string,Promise<unknown>>();
  let generation=0, disposed=false, controller=new AbortController();
  let discovery:Promise<RecognitionDiscoverySnapshot>|undefined;
  let discoveryOwner=createRecognitionDiscoveryOwner();
  const metadata = <T>(key:string,cache:Lru<T>,read:(signal:AbortSignal)=>Promise<T>,signal:AbortSignal):Promise<T> => {
    const cached=cache.get(key);if(cached)return Promise.resolve(cached);
    return coalesce(key, async()=>{const value=await queue.run(()=>bounded(read,signal,MARKDOWN_LIMITS.metadataMs),signal);live(signal);cache.set(key,value,JSON.stringify(value).length);return value;});
  };
  function coalesce<T>(key:string,read:()=>Promise<T>):Promise<T>{
    const existing=pending.get(key);if(existing)return existing as Promise<T>;
    if(pending.size>=MARKDOWN_LIMITS.inflight)return Promise.reject(new Error('Markdown demand capacity reached.'));
    const promise=Promise.resolve().then(read);pending.set(key,promise);
    void promise.finally(()=>{if(pending.get(key)===promise)pending.delete(key);}).catch(()=>{});
    return promise;
  }
  const readThread=(id:string,signal:AbortSignal)=>metadata(`thread:${id}`,threadCache,async s=>{const value=threadMetaSchema.parse(await sdk.threads.get({threadId:id,signal:s}));if(value.id!==id || value.deletedAt!==null)throw new Error('Thread is deleted or metadata does not match the requested identity.');return value;},signal);
  const readEnvironment=(id:string,signal:AbortSignal)=>metadata(`environment:${id}`,environmentCache,async s=>{const value=environmentMetaSchema.parse(await sdk.environments.get({environmentId:id,signal:s}));if(value.id!==id)throw new Error('Environment metadata does not match the requested identity.');return value;},signal);
  // Public SDK transport stays injected; the contract retains owner-bound RPC schemas.
  if(typeof sdk.plugins?.list!=='function'||typeof sdk.plugins?.callRpc!=='function')throw new Error('Markdown recognition requires SDK plugins.list and plugins.callRpc.');
  // Recognition 0.4.1's declared RecognitionSdk overstates the capability:
  // its clients use only list/callRpc, always pass a real UnknownResultSchema,
  // and perform bounded semantic decoding afterwards. This one private bridge
  // avoids comparing unrelated provisioning APIs and generic Zod SDK copies.
  // It grants no missing methods; runtime conformance exercises both functions.
  const recognitionSdk={plugins:{
    ...sdk.plugins,
    list: (...args:Parameters<typeof sdk.plugins.list>) => {const activeSignal=controller.signal;return queue.run(()=>bounded(()=>sdk.plugins.list(...args),activeSignal,MARKDOWN_LIMITS.enrichMs),activeSignal);},
    callRpc: ((args:Parameters<typeof sdk.plugins.callRpc>[0])=>{const activeSignal=args.signal??controller.signal;return queue.run(()=>bounded(s=>sdk.plugins.callRpc({...args,signal:s}),activeSignal,MARKDOWN_LIMITS.enrichMs),activeSignal);}) as typeof sdk.plugins.callRpc,
  }} as unknown as RecognitionSdk;
  const discover=(signal:AbortSignal)=>{
    if(!discovery)discovery=enumerateRecognitionSuppliers({sdk:recognitionSdk,owner:discoveryOwner,exclude:[],signal,budgets:{overallMs:MARKDOWN_LIMITS.enrichMs}});
    return discovery;
  };
  const keyFor=(request:MarkdownRequest)=>digest(markdownRequestKey(request));
  async function base(request:MarkdownRequest,signal:AbortSignal):Promise<Base>{
    const cacheKey=keyFor(request), cached=sourceCache.get(cacheKey);if(cached)return cached;
    return coalesce(`base:${cacheKey}`,async()=>{
      let document:MarkdownDocument|null=null, local=false;
      const diagnostics:MarkdownDiagnostic[]=[];
      const context:ContextBundleV1={consumer,links:[]};
      if(request.source.kind==='thread-message'){
        const source=request.source;
        try {
          const thread=await readThread(source.threadId,signal);live(signal);
          if((source.projectId && source.projectId!==thread.projectId)||(source.environmentId && source.environmentId!==thread.environmentId))throw new Error('Source assertions disagree with authoritative thread metadata.');
          local=true;context.threadId=thread.id;context.projectId=thread.projectId;
          if(thread.environmentId){
            context.environmentId=thread.environmentId;
            try {
              const environment=await readEnvironment(thread.environmentId,signal);live(signal);
              if(environment.projectId!==thread.projectId || !environment.path || !path.posix.isAbsolute(environment.path) || /[\\\u0000-\u001f\u007f]/u.test(environment.path))throw new Error('Source environment root is unavailable or belongs to another project.');
              const rootPath=path.posix.normalize(environment.path);
              document={threadId:thread.id,rootPath,target:{kind:'workspace',environmentId:environment.id,path:'.'}};
            }catch(error){live(signal);diagnostics.push(diagnostic('unverified-environment','Source environment root could not be validated; local destinations remain inert.'));}
          }
        }catch(error){live(signal);diagnostics.push(diagnostic('invalid-source','Source thread metadata was unavailable, malformed, deleted or disagreed with the asserted frame.'));}
      }
      live(signal);
      let grammar:MarkdownGrammar|undefined;
      if(request.content.length<=MARKDOWN_LIMITS.parseChars){try{grammar=compileGrammar(request.content,document);}catch{diagnostics.push(diagnostic('tree-limit','Source exceeds the safe tree budget and remains exact readable text.'));}}
      else diagnostics.push(diagnostic('text-limit','Source exceeds the parser budget and remains exact readable text.'));
      if(grammar){document=grammar.document;diagnostics.push(...grammar.diagnostics);}
      const literal=!grammar;
      if(!document && !diagnostics.length)diagnostics.push(diagnostic('inert-source','No validated local file frame is available; individual local targets remain inert.'));
      const prepared:PreparedMarkdown={key:markdownRequestKey(request),source:request.source,intent:'prose',original:request.content,content:literal?request.content:applyEdits(request.content,grammar!.edits),format:literal?'literal':'markdown',phase:'base',status:diagnostics.length?'partial':'ready',document,tree:grammar?.tree??null,diagnostics:diagnostics.slice(0,32)};
      const value={request,prepared,grammar,context,local};
      // Failed metadata must recover on the next authoritative request without a timer.
      if(request.source.kind==='detached'||(local && !diagnostics.some(d=>d.code==='unverified-environment')))sourceCache.set(cacheKey,value,prepared.key.length+prepared.original.length+prepared.content.length+(grammar?.text.length??0)+JSON.stringify(prepared.tree).length);
      return value;
    });
  }
  async function contributed(base:Base,signal:AbortSignal,deadline:number):Promise<{edits:Edit[];diagnostics:MarkdownDiagnostic[]}>{
    const grammar=base.grammar!;
    const diagnostics:MarkdownDiagnostic[]=[], edits:Edit[]=[];
    if(base.request.content.length>MARKDOWN_LIMITS.recognitionChars || grammar.excluded.length>512){return {edits,diagnostics:[diagnostic('recognition-limit','Optional recognition exceeded its text or exclusion budget; safe base remains available.')]};}
    const found=await discover(signal);live(signal);
    if(found.rows.some(row=>!['ready','absent','unavailable'].includes(row.state))||found.omittedCount)diagnostics.push(diagnostic('supplier-partial','One or more optional suppliers were unavailable, conflicted or outside admission bounds.'));
    const clients=found.rows.filter(row=>row.admitted && (row.state==='ready'||row.state==='contested') && row.capabilities);
    // The discovery snapshot owns clients through resolver routes. Linkify-only suppliers
    // still get owner-bound clients; never import supplier implementations.
    const {createSupplierClient}=await import('@phosphorco/bb-context-recognition/bb');
    const ready=clients.map(row=>({client:createSupplierClient(recognitionSdk,row.pluginId),capabilities:row.capabilities!}));
    const input={version:1 as const,text:grammar.text,format:'markdown' as const,excluded:grammar.excluded,context:base.context};
    const linked=await linkifyAll({clients:ready,input,signal,budgets:{overallDeadline:deadline}});live(signal);
    if(linked.outcomes.some(outcome=>outcome.state!=='ready'))diagnostics.push(diagnostic('linkify-partial','An optional recognizer failed or exceeded its deadline.'));
    const uris=opaqueUriTokens(grammar.text);
    const explicit=linked.results.filter(tag=>{
      const candidate=tag.candidate;
      if(candidate.source.provider.startsWith('bb.') || !['explicit','text-url'].includes(candidate.provenance.basis))return false;
      if(!checkCandidate(candidate,{text:grammar.text,excluded:grammar.excluded,context:base.context,providers:tag.providers}).valid)return false;
      if(!grammar.textSpans.some(span=>candidate.span.start>=span.start && candidate.span.end<=span.end))return false;
      // A whole URL must be recruited in full, without dropping query/fragment tails.
      const containingUris=uris.filter(uri=>overlap(uri,candidate.span));
      if(containingUris.length && !(containingUris.length===1 && tag.specificity==='typed' && safeExternal(candidate.match) && containingUris[0]!.start===candidate.span.start && containingUris[0]!.end===candidate.span.end))return false;
      if(safeExternal(candidate.match)){
        const before=grammar.text[candidate.span.start-1]??'', after=grammar.text[candidate.span.end]??'';
        if((before && /[^\s<>()\[\]"']/u.test(before)) || (after && /[^\s<>()\[\]"',;]/u.test(after)))return false;
      }
      return true;
    });
    const selected:TaggedCandidateV1[]=[];
    for(const tag of explicit.sort((a,b)=>a.candidate.span.start-b.candidate.span.start || b.candidate.span.end-a.candidate.span.end)){
      const collisions=explicit.filter(other=>overlap(tag.candidate.span,other.candidate.span));
      const top=collisions.some(other=>other.specificity==='typed')?'typed':'generic';
      if(tag.specificity!==top)continue;
      if(collisions.some(other=>other.specificity===top && identityKey(other.candidate.source)!==identityKey(tag.candidate.source))){diagnostics.push(diagnostic('conflicting-claims','Equal-specificity identity claims conflict; the original token remains literal.'));continue;}
      if(!selected.some(other=>overlap(other.candidate.span,tag.candidate.span)))selected.push(tag);
      if(selected.length>=64)break;
    }
    const sources=[...new Map(selected.map(tag=>[identityKey(tag.candidate.source),tag.candidate.source])).values()];
    const resolved=new Map<string,ResolutionV1>();
    const missing:SourceIdentity[]=[];
    for(const source of sources){const route=found.routes.get(source.provider);if(route?.state!=='ready')continue;const cacheKey=JSON.stringify([generation,route.pluginId,source]);const cached=resolutionCache.get(cacheKey);if(cached)resolved.set(identityKey(source),cached);else missing.push(source);}
    // Identical source sets coalesce before resolve; per-identity tasks also coalesce
    // across different documents without turning one read into a leaf-owned scheduler.
    await Promise.all(missing.map(source=>{
      const route=found.routes.get(source.provider)!;if(route.state!=='ready')return;
      const cacheKey=JSON.stringify([generation,route.pluginId,source]);
      return coalesce(`resolve:${cacheKey}`,async()=>{
        const result=await resolveAll({routes:found.routes,sources:[source],detail:'label',context:{consumer,...(base.context.threadId?{threadId:base.context.threadId}:{})},signal,budgets:{overallDeadline:deadline}});live(signal);
        const resolution=result.results.find(row=>identityKey(row.source)===identityKey(source));
        if(resolution?.state==='ready'){resolutionCache.set(cacheKey,resolution,JSON.stringify(resolution).length);return resolution;}
        return undefined;
      }).then(resolution=>{if(resolution)resolved.set(identityKey(source),resolution);},()=>{diagnostics.push(diagnostic('resolve-partial','An optional identity resolver failed or exceeded its deadline.'));});
    }));
    live(signal);
    for(const tag of selected){const c=tag.candidate, resolution=resolved.get(identityKey(c.source));if(!resolution || !resolution.label || !resolution.href){diagnostics.push(diagnostic('unresolved-reference','An optional identity has no readable label link and remains literal.'));continue;}
      // Supplied file targets, cards, excerpts and arbitrary app routes are never used.
      // A whole authored URL keeps its exact destination, even when metadata canonicalizes it.
      const href=safeExternal(c.match)?c.match:resolution.href;
      if(!safeExternal(href))continue;
      edits.push({...c.span,value:`[${escapeLabel(resolution.label)}](<${href.replace(/&/g,'&amp;').replace(/</g,'%3C').replace(/>/g,'%3E')}>)`});
    }
    return {edits,diagnostics};
  }
  async function enrich(value:Base,signal:AbortSignal):Promise<PreparedMarkdown>{
    const cacheKey=keyFor(value.request),cached=enrichedCache.get(cacheKey);if(cached)return cached;
    return coalesce(`enrich:${cacheKey}`,async()=>{
      if(!value.grammar || value.prepared.format==='literal')return {...value.prepared,phase:'enrich'};
      const edits:Edit[]=[], diagnostics=[...value.prepared.diagnostics];
      const deadline=performance.now()+MARKDOWN_LIMITS.enrichMs;
      try {
        const optional=await bounded(async stageSignal=>{
          const native=value.local?nativeThreadTokens(value.grammar!):[];
          await Promise.all([...new Set(native.map(token=>token.threadId))].map(async id=>{
            try {const target=await readThread(id,stageSignal);live(stageSignal);
              for(const token of native.filter(token=>token.threadId===id)){
                const href=`${origin??''}/projects/${target.projectId}/threads/${target.id}${token.anchor}`;
                if(!safeAppRoute(href.replace(origin??'','')))continue;
                edits.push({start:token.start,end:token.end,value:`[${escapeLabel(target.title||target.titleFallback||target.id)}](<${href}>)`});
              }
            }catch{live(stageSignal);diagnostics.push(diagnostic('native-unavailable','An explicit thread reference could not be validated and remains literal.'));}
          }));
          const contributedResult=await contributed(value,stageSignal,deadline);live(stageSignal);return contributedResult;
        },signal,MARKDOWN_LIMITS.enrichMs);
        diagnostics.push(...optional.diagnostics);edits.push(...optional.edits);
      }catch{live(signal);diagnostics.push(diagnostic('enrichment-unavailable','Optional enrichment exceeded its budget or failed; validated base content remains available.'));}
      live(signal);
      let tree=value.prepared.tree;
      try{if(edits.length)tree=compilePreparedTree(applyEdits(value.request.content,edits),value.prepared.document);}catch{diagnostics.push(diagnostic('enrichment-tree-limit','Enriched tree exceeded its budget; validated base formatting is retained.'));}
      const prepared:PreparedMarkdown={...value.prepared,phase:'enrich',content:applyEdits(value.request.content,[...value.grammar!.edits,...edits]),tree,status:diagnostics.length?'partial':'ready',diagnostics:diagnostics.slice(0,32)};
      if(!diagnostics.some(row=>['native-unavailable','enrichment-unavailable','supplier-partial','linkify-partial','resolve-partial','unresolved-reference','invalid-source','unverified-environment'].includes(row.code)))enrichedCache.set(cacheKey,prepared,prepared.key.length+prepared.original.length+prepared.content.length+JSON.stringify(prepared.tree).length);
      return prepared;
    });
  }
  function invalidate(){generation++;controller.abort();controller=new AbortController();discoveryOwner.dispose();discoveryOwner=createRecognitionDiscoveryOwner();discovery=undefined;pending.clear();queue.clear();sourceCache.clear();enrichedCache.clear();threadCache.clear();environmentCache.clear();resolutionCache.clear();}
  return {
    async prepare(input,signal){
      if(disposed)throw new Error('Markdown owner is disposed.');if(signal?.aborted)throw abortError();
      const frame=input as unknown as Record<string,unknown>;
      const requests=Array.isArray(frame?.requests)?frame.requests:[];
      if(!frame || Object.keys(frame).some(key=>!['phase','requests'].includes(key)) || !['base','enrich'].includes(frame.phase as string) || requests.length>MARKDOWN_LIMITS.requests || requests.reduce((sum:number,request:unknown)=>sum+(typeof (request as MarkdownRequest)?.content==='string'?(request as MarkdownRequest).content.length:0),0)>MARKDOWN_LIMITS.textChars) {
        return requests.slice(0,MARKDOWN_LIMITS.requests).map(request=>({...createLiteralMarkdown(request as MarkdownRequest),status:'invalid',diagnostics:[diagnostic('invalid-batch','Batch shape or aggregate content exceeds the public bounds.')]}));
      }
      const activeSignal=controller.signal;
      const result=Promise.all(requests.map(async request=>{
        const parsed=MarkdownRequestSchema.safeParse(request);
        if(!parsed.success)return createLiteralMarkdown(request as MarkdownRequest);
        try {const value=await base(parsed.data,activeSignal);live(activeSignal);return frame.phase==='base'?value.prepared:await enrich(value,activeSignal);}
        catch{live(activeSignal);return {...createLiteralMarkdown(parsed.data),phase:frame.phase as 'base'|'enrich',diagnostics:[diagnostic('read-unavailable','Source read capacity or metadata is unavailable; exact content remains readable.')]};}
      }));
      return fence(result,signal);
    },
    invalidate(){if(!disposed)invalidate();},
    dispose(){if(disposed)return;invalidate();disposed=true;controller.abort();discoveryOwner.dispose();},
  };
}
