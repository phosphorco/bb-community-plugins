import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { experimental_FileLink as FileLink, UrlLink, useBbNavigate, useSdk, useRealtime, useRealtimeConnectionState } from '@get-bb/plugin-sdk/app';
import { createBriefNavigationClient, createCrossReferencesProducerClient } from '@phosphorco/bb-cross-references/bb';
import { canonicalizeIdentity, verifiedFileIdentity, MENTIONS_V2_CHANNEL, mentionsChangedV2Schema, briefNavigationInputSchema, validateBriefNavigationResultV1,
 type BriefNavigationInput,type BriefNavigationOutput,type ProducerState,type ListMentionsOutputV2 } from '@phosphorco/bb-cross-references';

type Page=Extract<ListMentionsOutputV2,{status:'page'}>;
export type BriefMention=Extract<Page['items'][number],{kind:'brief-occurrence'}>;
export const BRIEF_OVER_LIMIT='brief references not updated: over limit';
export const BRIEF_IDENTITY_UNREPRESENTABLE='brief references not updated: identity cannot be represented safely';
export function briefStatusMessage(state:ProducerState|null):string|null {
 const s=state?.status;if(!s||s.applicability!=='current')return null;return s.state==='over-limit'?BRIEF_OVER_LIMIT:BRIEF_IDENTITY_UNREPRESENTABLE;
}
/** One fixed source read owner at the thread header, reused by its open detail. */
export function useBriefProducerState(threadId:string){
 const sdk=useSdk(),client=useMemo(()=>createCrossReferencesProducerClient(sdk),[sdk]);
 const source=useMemo(()=>verifiedFileIdentity({kind:'thread-storage',threadId,path:'BRIEF.md'}),[threadId]);
 const sourceDigest=useMemo(()=>canonicalizeIdentity(source).identityDigest,[source]);
 const [view,setView]=useState<{state:ProducerState|null;loading:boolean;error:string|null;stale:boolean}>({state:null,loading:true,error:null,stale:false});
 const refresh=useRef<()=>void>(()=>{}),pending=useRef(false),life=useRef(false),flight=useRef<AbortController|null>(null),timer=useRef<ReturnType<typeof setTimeout>|null>(null);
 const schedule=useCallback(()=>{pending.current=true;if(!life.current||document.hidden||flight.current||timer.current)return;timer.current=setTimeout(()=>{timer.current=null;refresh.current();},250);},[]);
 refresh.current=()=>{if(!life.current||document.hidden){pending.current=true;return;}if(flight.current){pending.current=true;return;}pending.current=false;const c=new AbortController();flight.current=c;
  void(async()=>{try{await client.describe(c.signal);const state=await client.getState({version:1,producerPluginId:'thread-brief',source},c.signal);if(life.current&&!c.signal.aborted)setView({state,loading:false,error:null,stale:false});}
   catch{if(life.current&&!c.signal.aborted)setView(v=>({...v,loading:false,error:'Brief reference state is unavailable.',stale:v.state!==null}));}
   finally{if(flight.current===c)flight.current=null;if(life.current&&pending.current)schedule();}})();
 };
 useRealtime(MENTIONS_V2_CHANNEL,useCallback((raw:unknown)=>{const s=mentionsChangedV2Schema.safeParse(raw);if(s.success&&s.data.producerPluginId==='thread-brief'&&s.data.sourceIdentityDigest===sourceDigest)schedule();},[sourceDigest,schedule]));
 useEffect(()=>{life.current=true;setView({state:null,loading:true,error:null,stale:false});refresh.current();const visibility=()=>{if(document.hidden){if(timer.current)clearTimeout(timer.current);timer.current=null;}else if(pending.current)schedule();};document.addEventListener('visibilitychange',visibility);
  return()=>{life.current=false;flight.current?.abort();flight.current=null;pending.current=false;if(timer.current)clearTimeout(timer.current);timer.current=null;document.removeEventListener('visibilitychange',visibility);};
 },[client,sourceDigest,schedule]);
 const connection=useRealtimeConnectionState(),previous=useRef(connection);useEffect(()=>{if(connection!=='connected')setView(v=>({...v,stale:v.state!==null}));else if(previous.current!=='connected')schedule();previous.current=connection;},[connection,schedule]);
 return {...view,refresh:schedule};
}
export function BriefProducerStatus({threadId,view}:{threadId:string;view:ReturnType<typeof useBriefProducerState>}){
 const s=view.state?.status,message=briefStatusMessage(view.state);return <section className="brief-producer__status" aria-label="Thread Brief producer">
  <strong>Thread Brief</strong> <FileLink target={{kind:'thread-storage',threadId,path:'BRIEF.md'}} location={null}>Open BRIEF.md</FileLink>
  {message&&<><p role="status">{message}</p><ul aria-label="Brief update reasons">{s?.limits.map(code=><li key={code}>{code}</li>)}{s?.state==='identity-unrepresentable'&&s.identityReasons.map(code=><li key={code}>{code}</li>)}</ul></>}
  {s?.applicability==='superseded-by-graph'&&<p>An earlier blocked Brief update was superseded by the graph. Current Brief evidence may be unconfirmed.</p>}
  {view.state?.projection&&<p>{view.state.projection.targets.length} Brief targets. These are separate producer claims; legacy relationship counts are unchanged.</p>}
  {view.stale&&<p role="status">Showing the last available Brief state.</p>}{view.error&&<p role="alert">{view.error}</p>}
 </section>;
}

type Click={button:number;altKey:boolean;ctrlKey:boolean;metaKey:boolean;shiftKey:boolean;defaultPrevented:boolean;currentTarget:{hasAttribute(name:string):boolean};preventDefault():void};
type IntentState={pending:boolean;error:string|null;note:string|null};
type IntentPorts={resolve(input:BriefNavigationInput,signal:AbortSignal):Promise<BriefNavigationOutput>;open(input:{target:BriefNavigationInput['sourceFile'];location:{kind:'line';line:number;column:null}|null}):boolean;changed(state:IntentState):void};
/** Product action owner: one SURFACE, one read AND dispatch entitlement across all rows. */
export function createBriefIntentOwner(ports:IntentPorts){
 let generation=0,active=true,current:{key:string;controller:AbortController;generation:number;promise:Promise<void>;dispatch:boolean}|null=null;
 const cancel=()=>{generation++;current?.controller.abort();current=null;if(active)ports.changed({pending:false,error:null,note:null});};
 return {
  activate(){active=true;},dispose(){active=false;generation++;current?.controller.abort();current=null;},cancel,
  primary(event:Click,input:BriefNavigationInput){
   if(event.defaultPrevented||event.button!==0||event.altKey||event.ctrlKey||event.metaKey||event.shiftKey||event.currentTarget.hasAttribute('download')){cancel();return;}
   event.preventDefault();const parsed=briefNavigationInputSchema.safeParse(input);if(!parsed.success){cancel();if(active)ports.changed({pending:false,error:'Brief location is unavailable.',note:null});return;}const admitted=parsed.data,key=JSON.stringify(admitted);
   if(current?.key===key)return current.promise;
   cancel();if(!active)return;const controller=new AbortController(),seq=++generation;ports.changed({pending:true,error:null,note:null});
   const record={key,controller,generation:seq,dispatch:true,promise:Promise.resolve()};current=record;
   record.promise=(async()=>{
    let result:BriefNavigationOutput|null=null;try{result=validateBriefNavigationResultV1(admitted,await ports.resolve(admitted,controller.signal));}catch{/* Missing/public proof unavailable opens only the fixed top. */}
    if(!active||controller.signal.aborted||current!==record||generation!==seq||!record.dispatch)return;
    record.dispatch=false;
    try{const location=result?.state==='ready'?result.location:null;if(!ports.open({target:admitted.sourceFile,location}))throw new Error('Native open unavailable.');ports.changed({pending:false,error:null,note:location?null:'Current heading could not be verified; opened BRIEF.md at the top.'});}
    catch{ports.changed({pending:false,error:'Could not open BRIEF.md. Use its native file link.',note:null});}
    finally{if(current===record)current=null;}
   })();return record.promise;
  },
 };
}
type IntentOwner=ReturnType<typeof createBriefIntentOwner>;
const IntentContext=createContext<IntentOwner|null>(null);
export function BriefNavigationSurface({children}:{children:ReactNode}){
 const sdk=useSdk(),navigate=useBbNavigate(),[state,setState]=useState<IntentState>({pending:false,error:null,note:null});
 const client=useMemo(()=>createBriefNavigationClient(sdk),[sdk]);
 const owner=useMemo(()=>{let described=false;return createBriefIntentOwner({resolve:async(input,signal)=>{if(!described){await client.describe(signal);described=true;}return client.resolve(input,signal);},open:intent=>navigate.experimental_openFilePreview(intent),changed:setState});},[client,navigate]);
 useEffect(()=>{owner.activate();return()=>owner.dispose();},[owner]);
 return <IntentContext.Provider value={owner}>{children}{state.pending&&<p role="status">Checking current Brief location…</p>}{state.note&&<p role="status">{state.note}</p>}{state.error&&<p role="alert">{state.error}</p>}</IntentContext.Provider>;
}
function navigationInput(item:BriefMention):BriefNavigationInput {
 const f=item.frame,h=item.locator.section.heading;
 return {version:1,sourceFile:{kind:'thread-storage',threadId:item.locator.file.threadId,path:'BRIEF.md'},sourceContentRevision:item.sourceContentRevision,
  frame:{codec:f.codec,rawBytes:f.rawBytes,bomBytes:f.bomBytes,fileUtf16Length:f.fileUtf16Length,bodyBase:{startUtf16:f.bodyBase.startUtf16,startLine:f.bodyBase.startLine,utf16Length:f.bodyBase.utf16Length},lineMapping:{codec:f.lineMapping.codec,fileLineCount:f.lineMapping.fileLineCount}},
  section:{heading:h===null?null:h.state==='named'?{state:'named',text:h.text}:{state:'withheld',digest:h.digest,display:h.display,cause:h.cause},originalLine:item.locator.section.line}};
}
export function BriefMentionRow({item}:{item:BriefMention}){
 const owner=useContext(IntentContext),input=navigationInput(item),heading=item.locator.section.heading;
 const provenance=item.provenance.state==='safe'?{...item.provenance.value,basis:item.provenance.value.recognition.basis}:item.provenance.summary;
 return <article className="mentions__row brief-producer__mention">
  <FileLink target={input.sourceFile} location={null} onClick={event=>owner?.primary(event,input)} onAuxClickCapture={()=>owner?.cancel()} onContextMenuCapture={()=>owner?.cancel()}>{heading===null?'Brief introduction':heading.state==='named'?heading.text||'Untitled heading':heading.display}</FileLink>
  <p>Excerpt unavailable: Brief excerpts are not materialized.</p>
  <small>{item.confirmation==='producer-attested'?'Producer-attested Brief snapshot':'Retained, unconfirmed Brief location'} · {provenance.origin==='contributed'?'Supplier':'Native'} recognition · {provenance.confidence} confidence · {provenance.basis}</small>
  {item.provenance.state==='withheld'&&<p>{item.provenance.display}</p>}
  {item.authoredUrl.state==='exact'?<UrlLink href={item.authoredUrl.href}>Authored destination</UrlLink>:item.authoredUrl.state==='withheld'?<p>{item.authoredUrl.display}</p>:null}
 </article>;
}
