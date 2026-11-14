/** Mounted source conformance. Real BB style/lifecycle proof is a separate gate. */
import { act, createElement } from 'react';
import type { ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import type { PluginBrowserBbSdk, PluginContentScriptContext } from '@get-bb/plugin-sdk';
import { installTestPluginRuntime } from '@get-bb/plugin-sdk/testing/app';
import { createSupplierClient } from './bb.js';
import { PresentationHost } from './react.js';
import { lookupPresentation, registerPresentation } from './presentation.js';
import { createIsolatedPresentationRealm } from './testing.js';
import type { SupplierConformanceReport } from './testing.js';
import { PresentationRefV1Schema } from './index.js';
import type { SourceIdentity, ResolveInputV1, JsonValue, PresentationRefV1 } from './index.js';
import type { PresentationNavigator } from './presentation.js';
export const HOSTED_SDK_APP_ALLOWLIST:readonly string[]=Object.freeze([
 'useBbContext','useRealtimeConnectionState','experimental_useProviders','useEnvironmentProviders','experimental_useCodeTheme',
 'Markdown','UrlLink','experimental_FileLink','experimental_Icon','experimental_ProviderIcon','ThreadTitle','experimental_Diff','experimental_SourceCode',
]);
export class SlotHookInHostedPresentation extends Error {
 constructor(name:string){super(`SlotHookInHostedPresentation: ${name}`);this.name='SlotHookInHostedPresentation';}
}
interface ConformanceBase {
 pluginId:string;
 register(bb:ReturnType<typeof createFakePluginHost>['bb']):void|Promise<void>;
 mountContentScript(ctx:Pick<PluginContentScriptContext,'pluginId'|'generation'|'signal'>):void|(()=>void|Promise<void>)|Promise<void|(()=>void|Promise<void>)>;
 modes?:readonly ('docked'|'full')[];
}
export interface PresentationConformanceOptions extends ConformanceBase {
 cases:readonly {identity:SourceIdentity;detail:'card';revision?:string;expect:{schema:string;text?:string}}[];
}
/** A consumer stamps the presentation itself (no recognizer resolves it): the same hosted checks, driven by explicit stamps. */
export interface HostedPresentationConformanceOptions extends ConformanceBase {
 stamps:readonly {schema:string;data:JsonValue;identity:SourceIdentity;revision?:string;expect?:{text?:string}}[];
}
interface StampCase {label:string;ref:PresentationRefV1;identity:SourceIdentity;revision?:string;text?:string}
type CollectStamps=(tools:{sdk:Pick<PluginBrowserBbSdk,'plugins'>;check:(name:string,run:()=>Promise<void>|void)=>Promise<void>;require:(value:unknown,message:string)=>void})=>Promise<StampCase[]>;
const noopNavigate:PresentationNavigator={toThread(){},openUrl(){},openFile(){return true;}};
/** Hooks in the entire SDK runtime fail closed except the explicit hosted allowlist. */
export function runPresentationConformance(opts:PresentationConformanceOptions):Promise<SupplierConformanceReport> {
 return runConformanceCore(opts,async({sdk,check,require})=>{
  const client=createSupplierClient(sdk as Parameters<typeof createSupplierClient>[0],opts.pluginId);
  const stamps:StampCase[]=[];
  for(const [index,c] of opts.cases.entries()) {
   const input:ResolveInputV1={version:1,context:{consumer:{pluginId:'conformance-consumer'}},sources:[c.identity],detail:'card'};
   const output=await client.resolve(input);
   const resolution=output.resolutions[0];
   await check(`presentation:${index}:ready-card`,()=>require(resolution?.state==='ready'&&resolution.card&&resolution.presentation?.schema===c.expect.schema,'Expected ready presentation and fallback card'));
   const ref=resolution?.presentation;
   if(!ref||!resolution)continue;
   stamps.push({label:String(index),ref,identity:resolution.source,...(resolution.revision?{revision:resolution.revision}:{}),...(c.expect.text?{text:c.expect.text}:{})});
  }
  return stamps;
 });
}
/** Host-stamped presentations: the stamp must be a valid PresentationRefV1; everything after is identical to the resolver path. */
export function runHostedPresentationConformance(opts:HostedPresentationConformanceOptions):Promise<SupplierConformanceReport> {
 return runConformanceCore(opts,async({check,require})=>{
  const stamps:StampCase[]=[];
  for(const [index,s] of opts.stamps.entries()) {
   const ref={schema:s.schema,data:s.data};
   let valid=false;
   await check(`presentation:stamp-${index}:ref`,()=>{valid=PresentationRefV1Schema.safeParse(ref).success;require(valid,'Stamp is not a valid PresentationRefV1');});
   if(!valid)continue;
   stamps.push({label:`stamp-${index}`,ref:ref as PresentationRefV1,identity:s.identity,...(s.revision?{revision:s.revision}:{}),...(s.expect?.text?{text:s.expect.text}:{})});
  }
  return stamps;
 });
}
async function runConformanceCore(opts:ConformanceBase,collect:CollectStamps):Promise<SupplierConformanceReport> {
 const checks:SupplierConformanceReport['checks']=[];
 const check=async(name:string,run:()=>Promise<void>|void)=>{try{await run();checks.push({name,state:'passed'});}catch(e){checks.push({name,state:'failed',detail:e instanceof Error?e.message:String(e)});}finally{if(root){await act(async()=>{root!.unmount();});root=undefined;}}};
 const require=(value:unknown,message:string)=>{if(!value)throw new Error(message);};
 const realm=createIsolatedPresentationRealm();
 const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'https://conformance.invalid/'});
 const scope=globalThis as unknown as Record<string,unknown>;
 const saved=new Map<string,PropertyDescriptor|undefined>();
 for(const k of ['window','document','navigator','HTMLElement','Element','Node','IS_REACT_ACT_ENVIRONMENT','__bbPluginRuntime'])saved.set(k,Object.getOwnPropertyDescriptor(globalThis,k));
 for(const k of ['window','document','navigator','HTMLElement','Element','Node'])Object.defineProperty(globalThis,k,{configurable:true,writable:true,value:(dom.window as unknown as Record<string,unknown>)[k]});
 Object.defineProperty(globalThis,'IS_REACT_ACT_ENVIRONMENT',{configurable:true,writable:true,value:true});
 installTestPluginRuntime();
 const runtime=scope.__bbPluginRuntime as {pluginSdkApp:Record<string,unknown>};
 const hostedFacade={...runtime.pluginSdkApp};
 for(const [name,value] of Object.entries(hostedFacade))if(typeof value==='function'&&!HOSTED_SDK_APP_ALLOWLIST.includes(name)&&name!=='definePluginApp')hostedFacade[name]=()=>{throw new SlotHookInHostedPresentation(name);};
 scope.__bbPluginRuntime={...runtime,pluginSdkApp:hostedFacade};
 const host=createFakePluginHost({pluginId:opts.pluginId});
 const calls:{method:string;signal?:AbortSignal}[]=[];
 const sdk={plugins:{async callRpc(args:{pluginId:string;method:string;input:unknown;signal?:AbortSignal}){
  require(args.pluginId===opts.pluginId,'Owner routing targeted another plugin');
  calls.push({method:args.method,...(args.signal?{signal:args.signal}:{})});
  return host.harness.behavior.callRpc(args.method,args.input);
 }}} as unknown as Pick<PluginBrowserBbSdk,'plugins'>;
 const controller=new AbortController();
 let cleanup:void|(()=>void|Promise<void>)=undefined,root:ReturnType<typeof createRoot>|undefined;
 let generation=1;
 try {
  await opts.register(host.bb);
  cleanup=await opts.mountContentScript({pluginId:opts.pluginId,generation:1,signal:controller.signal});
  const collected=await collect({sdk,check,require});
  for(const c of collected) {
   const entry=lookupPresentation(opts.pluginId,c.ref.schema);
   await check(`presentation:${c.label}:registration`,()=>require(entry,'Content script did not register the presentation'));
   if(!entry)continue;
   const fallback=createElement('span',null,'Data card fallback');
   const props={sdk,consumer:{pluginId:'conformance-consumer',surface:'conformance'},stamp:{pluginId:opts.pluginId,...c.ref},identity:c.identity,readyPlugins:new Set([opts.pluginId]),mode:'docked' as const,size:{maxWidth:600,maxHeight:400,preferredHeight:240},navigate:noopNavigate,fallback,...(c.revision?{revision:c.revision}:{})};
   for(const mode of opts.modes??['docked','full'])await check(`presentation:${c.label}:mode:${mode}`,async()=>{
    const before=calls.length;
    root=createRoot(dom.window.document.getElementById('root')!);
    await act(async()=>{root!.render(createElement(PresentationHost,{...props,mode}));});
    const end=performance.now()+2000;
    while(dom.window.document.body.textContent?.includes('Data card fallback')&&!dom.window.document.querySelector('[data-bb-presentation-failed]')&&performance.now()<end)await act(async()=>{await new Promise(r=>setTimeout(r,10));});
    require(!dom.window.document.querySelector('[data-bb-presentation-failed]'),'Hosted component crashed (including a forbidden slot hook)');
    require(dom.window.document.querySelector(`[data-bb-plugin="${opts.pluginId}"]`),'No owner-scoped root');
    require(!dom.window.document.body.textContent?.includes('Data card fallback'),'Hosted view never replaced fallback');
    if(c.text)require(dom.window.document.body.textContent?.includes(c.text),'Expected hosted content');
    require(calls.slice(before).every(call=>entry.methods.includes(call.method)),'Hosted code called outside its allowlist');
    await act(async()=>{root!.unmount();});root=undefined;
    require(calls.slice(before).every(call=>call.signal?.aborted),'Unmount did not dispose owner call signals');
   });
   await check(`presentation:${c.label}:garbage`,()=>require(entry.decode({__conformanceGarbage:true})===null,'Supplier decoder accepted garbage'));
   await check(`presentation:${c.label}:decode-fallback`,async()=>{
    const dispose=registerPresentation({pluginId:opts.pluginId,generation:++generation,signal:controller.signal},{...entry,decode:()=>null});
    root=createRoot(dom.window.document.getElementById('root')!);
    await act(async()=>{root!.render(createElement(PresentationHost,props));});
    require(dom.window.document.body.textContent?.includes('Data card fallback'),'Decode miss did not use fallback');
    await act(async()=>{root!.unmount();});root=undefined;dispose();
   });
   await check(`presentation:${c.label}:throw-fallback`,async()=>{
    const dispose=registerPresentation({pluginId:opts.pluginId,generation:++generation,signal:controller.signal},{...entry,load:async()=>()=>{throw new Error('Deliberate hosted crash');}});
    root=createRoot(dom.window.document.getElementById('root')!);
    await act(async()=>{root!.render(createElement(PresentationHost,props));});
    await act(async()=>{await new Promise(r=>setTimeout(r,20));});
    require(dom.window.document.body.textContent?.includes('Data card fallback')&&dom.window.document.querySelector('[data-bb-presentation-failed]'),'Crash escaped fallback boundary');
    await act(async()=>{root!.unmount();});root=undefined;dispose();
   });
   await cleanup?.();cleanup=await opts.mountContentScript({pluginId:opts.pluginId,generation:++generation,signal:controller.signal});
  }
  await check('presentation:disposal',async()=>{controller.abort();await cleanup?.();for(const c of collected)require(!lookupPresentation(opts.pluginId,c.ref.schema),'Disposal left a live registration');});
 } catch(e){checks.push({name:'presentation:setup',state:'failed',detail:e instanceof Error?e.message:String(e)});}
 finally {
  controller.abort();await cleanup?.();
  if(root)await act(async()=>{root!.unmount();});
  await host.harness.lifecycle.dispose();dom.window.close();realm.restore();
  for(const [k,d]of saved){if(d)Object.defineProperty(globalThis,k,d);else delete scope[k];}
 }
 return {pluginId:opts.pluginId,proof:'source-conformance',passed:checks.every(c=>c.state!=='failed'),checks};
}

export interface ScanReport {proof:'source-scan';passed:boolean;files:number;violations:readonly {file:string;message:string}[]}
/** Bun bundles the complete entry graph; every SDK app import is checked before tree shaking. */
export async function scanPresentationEntry(opts:{entry:string;allow?:never}):Promise<ScanReport> {
 const {spawn}=await import('node:child_process');
 const script=String.raw`
import {readFileSync} from 'node:fs';
const violations=[];let files=0;
const allowed=new Set(JSON.parse(process.argv[2]));
const SDK_APP='@get-bb/plugin-sdk/app',SDK_APP_SOURCE=/@get-bb\/plugin-sdk\/app/.source;
// Strict grammar: identifiers, commas and "as" only, so no other text can sit inside a classified clause.
const NAMED=/\{\s*(?:[\w$]+(?:\s+as\s+[\w$]+)?\s*,\s*)*(?:[\w$]+(?:\s+as\s+[\w$]+)?\s*)?\}/.source,NAMESPACE=/\*\s*as\s+[\w$]+/.source;
const STATEMENT='\\b(?:import|export)\\s+('+NAMED+'|'+NAMESPACE+'|[\\w$]+(?:\\s*,\\s*(?:'+NAMED+'|'+NAMESPACE+'))?)';
const result=await Bun.build({entrypoints:[process.argv[1]],target:'browser',write:false,external:['react','react/*','react-dom','react-dom/*','@get-bb/plugin-sdk','@get-bb/plugin-sdk/*'],plugins:[{name:'hosted-scan',setup(build){build.onLoad({filter:/\.[cm]?[jt]sx?$/},args=>{
const source=readFileSync(args.path,'utf8');files++;
// Only actual import statements are classified. Bun's transform prints the module without comments or type-only
// imports, with decoded specifiers and every value import kept (no tree shaking). Each printed SDK app specifier gets a
// unique tag, and Bun's import scan names the tags that are real statements. Comment, string, template or regex text
// is never a statement, so it can neither classify nor hide one.
let statements=null,dynamic=false;
try{
const printed=new Bun.Transpiler({loader:args.path.endsWith('x')?'tsx':'ts',trimUnusedImports:false,deadCodeElimination:false}).transformSync(source);
let tags=0;const tagged=printed.replaceAll(SDK_APP,specifier=>specifier+'#'+tags++);
statements=new Bun.Transpiler({loader:'js'}).scanImports(tagged).filter(i=>i.path===SDK_APP||i.path.startsWith(SDK_APP+'#')).map(i=>({kind:i.kind,tag:i.path.slice(SDK_APP.length+1),tagged}));
}catch{}
if(!statements)violations.push({file:args.path,message:'Unclassified SDK app import is not allowed'});
for(const {kind,tag,tagged} of statements??[]){
if(kind!=='import-statement'){dynamic=true;violations.push({file:args.path,message:'Dynamic SDK app import is not allowed'});continue;}
// The whole printed statement: braces, a namespace, or a default (optionally with braces), then this tag.
const match=/^\d+$/.test(tag)?new RegExp(STATEMENT+'\\s*from\\s*["\']'+SDK_APP_SOURCE+'#'+tag+'["\']').exec(tagged):null;
if(!match){violations.push({file:args.path,message:'Unclassified SDK app import is not allowed'});continue;}
const clause=match[1];
if(!clause.startsWith('{')){violations.push({file:args.path,message:'SDK namespace/default import is not allowed'});continue;}
for(let name of clause.slice(1,-1).split(',')){name=name.trim();if(!name)continue;name=name.split(/\s+as\s+/)[0];if(!allowed.has(name))violations.push({file:args.path,message:'SDK app export not allowed: '+name});}
}
if(!dynamic&&/(?:import\s*\(|require\s*\()\s*['"]@get-bb\/plugin-sdk\/app['"]/.test(source))violations.push({file:args.path,message:'Dynamic SDK app import is not allowed'});
if(/\b(?:querySelector(?:All)?|getElementsBy\w*|MutationObserver)\b/.test(source))violations.push({file:args.path,message:'DOM scanning is not allowed'});
return undefined;
});}}]});
if(!result.success)for(const log of result.logs)violations.push({file:process.argv[1],message:String(log)});
console.log(JSON.stringify({proof:'source-scan',passed:violations.length===0,files,violations}));
`;
 return new Promise((resolve,reject)=>{
  const child=spawn('bun',['--eval',script,opts.entry,JSON.stringify(HOSTED_SDK_APP_ALLOWLIST)],{stdio:['ignore','pipe','pipe']});let stdout='',stderr='';
  child.stdout.on('data',chunk=>{stdout+=chunk;});child.stderr.on('data',chunk=>{stderr+=chunk;});
  const timer=setTimeout(()=>{child.kill();reject(new Error('Presentation scan timed out'));},30000);
  child.on('error',e=>{clearTimeout(timer);reject(e);});child.on('close',code=>{clearTimeout(timer);if(code!==0)reject(new Error(stderr));else try{resolve(JSON.parse(stdout));}catch(e){reject(e);}});
 });
}
