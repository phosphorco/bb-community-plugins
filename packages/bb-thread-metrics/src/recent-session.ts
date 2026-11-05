import { LIMITS,validateRecentSnapshot } from './index.js';
import type { RecentSnapshot,RecentSnapshotInput,RecentPublicationIdentity } from './index.js';

export interface RecentSnapshotSource {
 readonly pluginId:string;
 recentSnapshot(input:RecentSnapshotInput,signal:AbortSignal):Promise<unknown>;
}
export type RecentSessionFailure='inactive'|'busy'|'aborted-before-start'|'aborted'|'timeout'|'source-replaced'|'stale-call'|'stale-publication'|'publication-conflict'|'missing-publication';
export class RecentSnapshotSessionError extends Error {
 constructor(readonly reason:RecentSessionFailure){super(`Recent snapshot session: ${reason}`);}
}
/** Local proof only: this session did not invoke a source transport for this call. */
export class RecentSnapshotNotStarted extends RecentSnapshotSessionError {
 readonly notStarted=true;
 constructor(reason:'inactive'|'busy'|'aborted-before-start'){super(reason);}
}
export interface RecentSnapshotObservation {
 readonly snapshot:RecentSnapshot;
 readonly publication:RecentPublicationIdentity;
 readonly ownerGeneration:number;
 readonly sourceGeneration:number;
}
export interface RecentSessionClock { later(run:()=>void,ms:number):()=>void }
const clock:RecentSessionClock={later(run,ms){const timer=setTimeout(run,ms);return ()=>clearTimeout(timer);}};
function next(n:number){if(n===Number.MAX_SAFE_INTEGER)throw new Error('Recent session generation exhausted');return n+1;}
function sourceCopy(source:RecentSnapshotSource):RecentSnapshotSource {
 if(!source.pluginId||source.pluginId.length>200||typeof source.recentSnapshot!=='function')throw new Error('Invalid recent snapshot source');
 return {pluginId:source.pluginId,recentSnapshot:source.recentSnapshot.bind(source)};
}
function freeze<T>(value:T):T {
 if(value&&typeof value==='object'&&!Object.isFrozen(value)){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;
}
// Public decoded JSON only. No retained second4MiB fingerprint string; object
// key ordering is not part of semantic identity. Unknown additive fields have
// already been bounded and stripped by the versioned public codec.
function same(a:unknown,b:unknown):boolean {
 if(a===b)return true;if(!a||!b||typeof a!=='object'||typeof b!=='object')return false;
 if(Array.isArray(a)!==Array.isArray(b))return false;
 const ak=Object.keys(a),bk=Object.keys(b);if(ak.length!==bk.length)return false;
 return ak.every(key=>Object.hasOwn(b,key)&&same((a as Record<string,unknown>)[key],(b as Record<string,unknown>)[key]));
}

/** ONE instance in an existing native source-owner resource, outside React.
 * No discovery, subscriptions, refresh/retry loop, queue or value graph. The
 * caller drives its existing cadence and owns source-selection authority.
 * Local deadlines/abort/remount/replacement never release an ACTUAL read slot.
 * Do not recreate this instance while it holds a transport. */
export function createRecentSnapshotSession(initial:RecentSnapshotSource,options:{timeoutMs?:number;clock?:RecentSessionClock}={}){
 const timeoutMs=options.timeoutMs??LIMITS.callMs;
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>LIMITS.callMs)throw new Error('Invalid recent session deadline');
 const time=options.clock??clock;
 let source=sourceCopy(initial),active=true,epoch=Symbol('view'),sourceGeneration=1,ownerGeneration=1;
 let held:RecentSnapshotObservation|undefined;
 let actual:{cancel:((reason:RecentSessionFailure)=>void)|undefined}|undefined;
 const admit=(input:RecentSnapshotInput,raw:unknown,current:()=>boolean):RecentSnapshotObservation=>{
  if(!current())throw new RecentSnapshotSessionError('stale-call');
  const value=validateRecentSnapshot(input,raw);
  // Also fence reentrant/injected property getters during raw validation.
  if(!current())throw new RecentSnapshotSessionError('stale-call');
  if(value.unchanged){if(!held||held.snapshot.revision!==value.revision)throw new RecentSnapshotSessionError('publication-conflict');return held;}
  const publication=value.publication;if(!publication)throw new RecentSnapshotSessionError('missing-publication');
  if(held){
   if(publication.sequence<held.publication.sequence)throw new RecentSnapshotSessionError('stale-publication');
   if(publication.sequence===held.publication.sequence){
    if(publication.instance!==held.publication.instance||value.revision!==held.snapshot.revision||!same(value,held.snapshot))throw new RecentSnapshotSessionError('publication-conflict');
    return held;
   }
   if(value.revision===held.snapshot.revision)throw new RecentSnapshotSessionError('publication-conflict');
   if(publication.instance!==held.publication.instance)ownerGeneration=next(ownerGeneration);
  }
  held=freeze({snapshot:value,publication,ownerGeneration,sourceGeneration});return held;
 };
 return {
  get current(){return held;},
  get outstandingReads(){return actual?1:0;},
  get ownerGeneration(){return ownerGeneration;},
  get sourceGeneration(){return sourceGeneration;},
  get pluginId(){return source.pluginId;},
  /** Ordinary wrapper/reconnect update: same selected source, NO reset. */
  updateSource(value:RecentSnapshotSource){const updated=sourceCopy(value);if(updated.pluginId!==source.pluginId)throw new Error('Selected source change requires explicit replacement');source=updated;},
  /** Authoritative selected-source replacement ONLY. A new UUID, lower
   * sequence, timeout or ordinary reconnect is NOT authority to invoke this. */
  replaceSource(value:RecentSnapshotSource){
   const updated=sourceCopy(value),sg=next(sourceGeneration),og=next(ownerGeneration);
   source=updated;sourceGeneration=sg;ownerGeneration=og;held=undefined;epoch=Symbol('source');actual?.cancel?.('source-replaced');
  },
  /** Mount/visibility lifecycle retains both watermark and actual admission. */
  setActive(value:boolean){if(value===active)return;active=value;epoch=Symbol('view');if(!active)actual?.cancel?.('inactive');},
  read(options:{signal?:AbortSignal;full?:boolean}={}):Promise<RecentSnapshotObservation>{
   const signal=options.signal,full=options.full;options={};
   if(!active)return Promise.reject(new RecentSnapshotNotStarted('inactive'));
   if(signal?.aborted)return Promise.reject(new RecentSnapshotNotStarted('aborted-before-start'));
   if(actual)return Promise.reject(new RecentSnapshotNotStarted('busy'));
   const input:RecentSnapshotInput=!full&&held?{ifRevision:held.snapshot.revision}:{};
   let selected:RecentSnapshotSource|undefined=source;const binding=sourceGeneration,view=epoch,control=new AbortController(),slot:{cancel:((reason:RecentSessionFailure)=>void)|undefined}={cancel:undefined};
   actual=slot;
   let finished=false;
   const current=()=>!finished&&active&&epoch===view&&sourceGeneration===binding;
   let resolve:((value:RecentSnapshotObservation)=>void)|undefined,reject:((error:unknown)=>void)|undefined;
   const result=new Promise<RecentSnapshotObservation>((yes,no)=>{resolve=yes;reject=no;});
   let cancelTimer:(()=>void)|undefined;
   const finish=(error:unknown,observation?:RecentSnapshotObservation)=>{
    if(finished)return;finished=true;cancelTimer?.();cancelTimer=undefined;signal?.removeEventListener('abort',abort);slot.cancel=undefined;
    const yes=resolve,no=reject;resolve=undefined;reject=undefined;
    if(observation===undefined)no?.(error);else yes?.(observation);
   };
   const cancel=(reason:RecentSessionFailure)=>{finish(new RecentSnapshotSessionError(reason));control.abort();};
   const abort=()=>cancel('aborted');slot.cancel=cancel;signal?.addEventListener('abort',abort,{once:true});
   try{cancelTimer=time.later(()=>cancel('timeout'),timeoutMs);}catch(error){finish(error);actual=undefined;return result;}
   // Standard timers do not run synchronously. A custom immediate scheduler
   // still cannot invoke a source after its observation already timed out.
   if(finished){actual=undefined;cancelTimer?.();return result;}
   let pending:Promise<unknown>;
   try{pending=Promise.resolve(selected.recentSnapshot(Object.freeze(input),control.signal));}catch(error){pending=Promise.reject(error);}finally{selected=undefined;}
   void pending.then(value=>{
    try{if(!finished)finish(undefined,admit(input,value,current));}catch(error){finish(error);}finally{if(actual===slot)actual=undefined;}
   },error=>{try{finish(error instanceof RecentSnapshotNotStarted?new Error('Recent snapshot source rejected after invocation',{cause:error}):error);}finally{if(actual===slot)actual=undefined;}});
   return result;
  },
 };
}
export type RecentSnapshotSession=ReturnType<typeof createRecentSnapshotSession>;
