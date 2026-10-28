/** Synthetic borrowed clients, real public packed React entries/controllers. No native host proof. */
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import * as core from '@phosphorco/bb-identity/react-core';
import * as native from '@phosphorco/bb-identity/react';
import { createIdentityEditingState, EDITING_PROTOCOL } from '@phosphorco/bb-identity/editing';
import { idCodec, identityKeyCodec } from '@phosphorco/bb-identity/model';
import type { Codec, IdentityError, Result } from '@phosphorco/bb-identity/model';
import { createIdentityState } from '@phosphorco/bb-identity/state';
import type { IdentityStateBinding, IdentityClient } from '@phosphorco/bb-identity/client';
import type { ServerSession } from '@phosphorco/bb-identity/host';
import type { EditingDraftStorage, IdentityEditingBinding } from '@phosphorco/bb-identity/editing';
const ok = <T,>(value:T) => ({ok:true as const,value});
const err = (code:IdentityError['code'],message:string):Result<never> => ({ok:false,error:{code,message,retry:'never'}});
const id = <K extends string>(kind: K, text: string) => { const r = idCodec(kind).decode(text); if (!r.ok) throw new Error(r.error.message); return r.value; };
const key = (text: string) => { const r = identityKeyCodec.decode(text); if (!r.ok) throw new Error(r.error.message); return r.value; };
const person = (name: string) => ({ kind: 'person' as const, key: key(`issuer:${name}`), issuer: 'issuer', subject: name });
const session: ServerSession = { status:'ready',instanceId:id('instance','mixed-entries'),mode:'multi-user',stamp:id('server-session','session/a%2F'),actor:{identity:person('a'),presentation:{displayName:'A',handle:null,avatarUrl:null},evidence:'provider-verified'},capabilities:{requestIdentity:'host-resolved',acceptance:'transactional-check',forwarding:'host-bound',directory:{search:false,lookup:true},participants:false,externalSend:'structured',toolProvenance:'unknown',operationLookup:true} };
const unsupported = async () => err('unsupported','Unused fixture route.');
let active = 0, starts = 0, disposes = 0;
const client: IdentityClient = { getSnapshot:()=>session,currentSession:()=>ok(session),subscribe:()=>{active++;return()=>{active--;};},start:async()=>{starts++;return ok(undefined);},refresh:async()=>ok(undefined),selfProfile:unsupported,dispose(){disposes++;},
 directory:{search:unsupported,getMany:async q=>ok(q.keys.map(k=>({status:'found' as const,key:k,profile:{identity:person('b'),presentation:{displayName:'B',handle:null,avatarUrl:null},revision:id('revision','profile-b/v1'),status:'current' as const}}))),subscribe:()=>()=>{}},participants:{list:unsupported,previews:unsupported},
 connection:{getHealth:()=>({generation:1,identity:{status:'healthy'},state:{status:'healthy'}}),subscribeHealth:()=>()=>{},subscribe:()=>()=>{},request:unsupported,revalidate:async()=>ok(undefined),dispose(){disposes++;}} };
const text: Codec<string> = { encode:v=>v,decode:v=>typeof v==='string'?ok(v):err('invalid-input','Expected text.') };
type Target={readonly mapId:string};const targetCodec:Codec<Target>={encode:v=>({mapId:v.mapId}),decode:v=>typeof v==='object'&&v!==null&&'mapId'in v&&typeof v.mapId==='string'?ok({mapId:v.mapId}):err('invalid-input','Expected target.')};
type Hooks=typeof core;type PanelProbe={ binding:IdentityEditingBinding<string,Target>|null; legacy:IdentityStateBinding<string>|null; failures:readonly core.EditingPreservationFailure[]; same:boolean; fail:boolean; target:(value:string)=>void; attach:(value:boolean)=>void; select:()=>Promise<boolean>; reset:()=>Promise<boolean>; acknowledge:(generation:number)=>boolean };
const probes:Record<string,PanelProbe>={};
function Panel({name,parent,context,hooks}:{name:string;parent:Hooks;context:Hooks;hooks:Hooks}) {
 const [mapId,setMapId]=React.useState('map-1'),[attached,setAttached]=React.useState(true);
 const probe=React.useMemo<PanelProbe>(()=>({binding:null,legacy:null,failures:[],same:false,fail:false,target:setMapId,attach:setAttached,select:async()=>false,reset:async()=>false,acknowledge:()=>false}),[]);probes[name]=probe;
 const Provider=parent.BbIdentity.Provider,Context=context.BbIdentity.Context;
 return <section data-panel={name}><Provider client={attached?client:null} fallback={<span data-detached={name}/> }><Context><Editor name={name} mapId={mapId} hooks={hooks} probe={probe}/><Reader name={name} probe={probe}/></Context></Provider></section>;
}
function Editor({name,mapId,hooks,probe}:{name:string;mapId:string;hooks:Hooks;probe:PanelProbe}) {
 const drafts=React.useMemo<EditingDraftStorage<string,Target>>(()=>({find:async()=>ok([]),write:async(draft,revision)=>probe.fail?err('unavailable','Synthetic checkpoint failed.'):ok({draft,revision:(revision??0)+1}),remove:async()=>ok(undefined)}),[probe]);
 const binding=hooks.useIdentityEditingBinding({resourceKey:`mixed:${name}`,target:{mapId},targetCodec,create({session,ownerSession}) {
  const address={instanceId:session.instanceId,pluginId:id('plugin','mixed-core-test'),collection:'editor',recordId:mapId,owner:session.actor.identity.key};
  return createIdentityEditingState({draftAddress:address,target:{mapId},targetCodec,expected:{actor:session.actor.identity.key,session:session.stamp},ownerSession,definition:{collection:'editor',schemaVersion:1,codec:text,initialValue:()=>'',equal:(a,b)=>a===b},drafts,
   transport:{protocol:EDITING_PROTOCOL,load:async()=>ok({status:'present',envelope:{address,version:{epoch:'epoch',sequence:1},schemaVersion:1,value:'base',lastEditedBy:null}}),save:async r=>ok({protocol:EDITING_PROTOCOL,status:'indeterminate',operationId:r.mutation.operationId}),reconcile:async()=>ok({status:'pending'}),subscribe:()=>()=>{}},onConflict:()=>({kind:'needs-review',reason:'Review'}),initializeEmpty:false,currentSession:()=>client.currentSession()});
 }});
 probe.binding=binding;const state=hooks.useIdentityEditingSnapshot(binding);
 return <output data-editor={name} data-status={state.status} data-map={mapId}>{state.status==='waiting-for-identity'?'':state.desired}</output>;
}
function Reader({name,probe}:{name:string;probe:PanelProbe}) {
 const create=React.useCallback<NonNullable<Parameters<typeof core.useIdentityStateBinding<string>>[0]['create']>>(({session,subject,ownerSession})=>{
  const address={instanceId:session.instanceId,pluginId:id('plugin','mixed-core-test'),collection:'sections',recordId:name,owner:subject.key};
  return createIdentityState({address,expected:{actor:session.actor.identity.key,session:session.stamp},ownerSession,definition:{collection:'sections',schemaVersion:1,codec:text,initialValue:()=>'',equal:(a,b)=>a===b},transport:{load:async()=>ok({status:'present',envelope:{address,version:{epoch:'sections',sequence:1},schemaVersion:1,value:'sections',lastEditedBy:null}}),save:async r=>ok({status:'indeterminate',operationId:r.operationId}),reconcile:async()=>ok({status:'pending'}),subscribe:()=>()=>{}},onConflict:()=>({kind:'needs-review',reason:'Review'}),initializeEmpty:false,currentSession:()=>client.currentSession()});
 },[name]);
 probe.legacy=core.useIdentityStateBinding({target:'viewed-subject',editPolicy:'actor-only',create});
 const legacyState=core.useIdentityStateSnapshot(probe.legacy);
 const c=core.useBorrowedIdentityClient(),n=native.useBorrowedIdentityClient(),cs=core.useIdentitySession(),ns=native.useIdentitySession(),cv=core.useIdentityViewSnapshot(),nv=native.useIdentityViewSnapshot();
 const ca=core.useIdentityViewActions(),na=native.useIdentityViewActions(),cf=core.useIdentityEditingPreservationFailures(),nf=native.useIdentityEditingPreservationFailures();
 const cfLegacy=core.useIdentityPreservationFailures(),nfLegacy=native.useIdentityPreservationFailures();
 const ack=native.useAcknowledgeIdentityEditingPreservationFailure();probe.same=c===client&&n===client&&cs===ns&&cv===nv&&cf===nf&&cfLegacy===nfLegacy;probe.failures=cf;probe.acknowledge=ack;
 probe.select=async()=>(await ca.select({kind:'person',key:key('issuer:b')})).ok;probe.reset=async()=>(await na.reset()).ok;
 return <output data-reader={name} data-state={legacyState.status} data-same={String(probe.same)} data-view={cv.status==='ready'?String(cv.overriding):cv.status} data-failures={cf.length}>{cs.status==='ready'?cs.actor.presentation.displayName:cs.status}<core.IdentityViewStatus labels={{viewing:'Viewing B',returnSelf:'Return self'}}/></output>;
}
const root=createRoot(document.getElementById('root')!);
root.render(<React.StrictMode><Panel name="core-parent" parent={core} context={native} hooks={native}/><Panel name="native-parent" parent={native} context={core} hooks={core}/></React.StrictMode>);
declare global { interface Window { reactCoreProbe:{edit(name:string,value:string):boolean;editViewed(name:string):boolean;flush(name:string):Promise<boolean>;select(name:string):Promise<boolean>;reset(name:string):Promise<boolean>;target(name:string):void;attach(name:string,value:boolean):void;fail(name:string):void;ack(name:string):boolean;stats(name:string):unknown;unmount():void} } }
window.reactCoreProbe={editViewed:n=>probes[n]!.legacy?.edit('forbidden').ok??false,edit:(n,v)=>probes[n]!.binding?.edit(v).ok??false,flush:async n=>(await probes[n]!.binding?.flush())?.ok??false,select:n=>probes[n]!.select(),reset:n=>probes[n]!.reset(),target:n=>probes[n]!.target('map-2'),attach:(n,v)=>probes[n]!.attach(v),fail:n=>{probes[n]!.fail=true;},ack:n=>probes[n]!.acknowledge(probes[n]!.failures[0]?.generation??-1),stats:n=>({same:probes[n]!.same,failures:probes[n]!.failures,active,starts,disposes}),unmount:()=>root.unmount()};
