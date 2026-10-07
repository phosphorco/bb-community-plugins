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
import type { SourceIdentity, ResolveInputV1 } from './index.js';
import type { PresentationNavigator } from './presentation.js';
export const HOSTED_SDK_APP_ALLOWLIST:readonly string[]=Object.freeze([
 'useBbContext','useRealtimeConnectionState','experimental_useProviders','useEnvironmentProviders','experimental_useCodeTheme',
 'Markdown','UrlLink','experimental_FileLink','experimental_Icon','experimental_ProviderIcon','ThreadTitle','experimental_Diff','experimental_SourceCode',
]);
export class SlotHookInHostedPresentation extends Error {
 constructor(name:string){super(`SlotHookInHostedPresentation: ${name}`);this.name='SlotHookInHostedPresentation';}
}
export interface PresentationConformanceOptions {
 pluginId:string;
 register(bb:ReturnType<typeof createFakePluginHost>['bb']):void|Promise<void>;
 mountContentScript(ctx:Pick<PluginContentScriptContext,'pluginId'|'generation'|'signal'>):void|(()=>void|Promise<void>)|Promise<void|(()=>void|Promise<void>)>;
 cases:readonly {identity:SourceIdentity;detail:'card';revision?:string;expect:{schema:string;text?:string}}[];
 modes?:readonly ('docked'|'full')[];
}
const noopNavigate:PresentationNavigator={toThread(){},openUrl(){},openFile(){return true;}};
/** Hooks in the entire SDK runtime fail closed except the explicit hosted allowlist. */
export async function runPresentationConformance(opts:PresentationConformanceOptions):Promise<SupplierConformanceReport> {
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
  const client=createSupplierClient(sdk as Parameters<typeof createSupplierClient>[0],opts.pluginId);
  for(const [index,c] of opts.cases.entries()) {
   const input:ResolveInputV1={version:1,context:{consumer:{pluginId:'conformance-consumer'}},sources:[c.identity],detail:'card'};
   const output=await client.resolve(input);
   const resolution=output.resolutions[0];
   await check(`presentation:${index}:ready-card`,()=>require(resolution?.state==='ready'&&resolution.card&&resolution.presentation?.schema===c.expect.schema,'Expected ready presentation and fallback card'));
   const ref=resolution?.presentation;
   if(!ref)continue;
   const entry=lookupPresentation(opts.pluginId,ref.schema);
   await check(`presentation:${index}:registration`,()=>require(entry,'Content script did not register the presentation'));
   if(!entry)continue;
   const fallback=createElement('span',null,'Data card fallback');
   const props={sdk,consumer:{pluginId:'conformance-consumer',surface:'conformance'},stamp:{pluginId:opts.pluginId,...ref},identity:resolution.source,readyPlugins:new Set([opts.pluginId]),mode:'docked' as const,size:{maxWidth:600,maxHeight:400,preferredHeight:240},navigate:noopNavigate,fallback,...(resolution.revision?{revision:resolution.revision}:{})};
   for(const mode of opts.modes??['docked','full'])await check(`presentation:${index}:mode:${mode}`,async()=>{
    const before=calls.length;
    root=createRoot(dom.window.document.getElementById('root')!);
    await act(async()=>{root!.render(createElement(PresentationHost,{...props,mode}));});
    const end=performance.now()+2000;
    while(dom.window.document.body.textContent?.includes('Data card fallback')&&!dom.window.document.body.textContent?.includes('Plan view failed')&&performance.now()<end)await act(async()=>{await new Promise(r=>setTimeout(r,10));});
    require(!dom.window.document.body.textContent?.includes('Plan view failed'),'Hosted component crashed (including a forbidden slot hook)');
    require(dom.window.document.querySelector(`[data-bb-plugin="${opts.pluginId}"]`),'No owner-scoped root');
    require(!dom.window.document.body.textContent?.includes('Data card fallback'),'Hosted view never replaced fallback');
    if(c.expect.text)require(dom.window.document.body.textContent?.includes(c.expect.text),'Expected hosted content');
    require(calls.slice(before).every(call=>entry.methods.includes(call.method)),'Hosted code called outside its allowlist');
    await act(async()=>{root!.unmount();});root=undefined;
    require(calls.slice(before).every(call=>call.signal?.aborted),'Unmount did not dispose owner call signals');
   });
   await check(`presentation:${index}:garbage`,()=>require(entry.decode({__conformanceGarbage:true})===null,'Supplier decoder accepted garbage'));
   await check(`presentation:${index}:decode-fallback`,async()=>{
    const dispose=registerPresentation({pluginId:opts.pluginId,generation:++generation,signal:controller.signal},{...entry,decode:()=>null});
    root=createRoot(dom.window.document.getElementById('root')!);
    await act(async()=>{root!.render(createElement(PresentationHost,props));});
    require(dom.window.document.body.textContent?.includes('Data card fallback'),'Decode miss did not use fallback');
    await act(async()=>{root!.unmount();});root=undefined;dispose();
   });
   await check(`presentation:${index}:throw-fallback`,async()=>{
    const dispose=registerPresentation({pluginId:opts.pluginId,generation:++generation,signal:controller.signal},{...entry,load:async()=>()=>{throw new Error('Deliberate hosted crash');}});
    root=createRoot(dom.window.document.getElementById('root')!);
    await act(async()=>{root!.render(createElement(PresentationHost,props));});
    await act(async()=>{await new Promise(r=>setTimeout(r,20));});
    require(dom.window.document.body.textContent?.includes('Data card fallback')&&dom.window.document.body.textContent.includes('Plan view failed'),'Crash escaped fallback boundary');
    await act(async()=>{root!.unmount();});root=undefined;dispose();
   });
   // Restore the real registration for subsequent cases.
   await cleanup?.();cleanup=await opts.mountContentScript({pluginId:opts.pluginId,generation:++generation,signal:controller.signal});
  }
  await check('presentation:disposal',async()=>{controller.abort();await cleanup?.();for(const c of opts.cases)require(!lookupPresentation(opts.pluginId,c.expect.schema),'Disposal left a live registration');});
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
const result=await Bun.build({entrypoints:[process.argv[1]],target:'browser',write:false,external:['react','react/*','react-dom','react-dom/*','@get-bb/plugin-sdk','@get-bb/plugin-sdk/*'],plugins:[{name:'hosted-scan',setup(build){build.onLoad({filter:/\.[cm]?[jt]sx?$/},args=>{
const source=readFileSync(args.path,'utf8');files++;
const transpiler=new Bun.Transpiler({loader:args.path.endsWith('x')?'tsx':'ts'});
const imported=transpiler.scanImports(source).filter(i=>i.path==='@get-bb/plugin-sdk/app');
let classified=0;
for(const match of source.matchAll(/(?:import|export)\s+(?:type\s+)?([^;]*?)\s+from\s*['"]@get-bb\/plugin-sdk\/app['"]/g)){
const clause=match[1].trim();if(/^(?:import|export)\s+type\b/.test(match[0]))continue;classified++;
if(!clause.startsWith('{')||!clause.endsWith('}')){violations.push({file:args.path,message:'SDK namespace/default import is not allowed'});continue;}
for(let name of clause.slice(1,-1).split(',')){name=name.trim();if(!name||name.startsWith('type '))continue;name=name.split(/\s+as\s+/)[0].trim();if(!allowed.has(name))violations.push({file:args.path,message:'SDK app export not allowed: '+name});}
}
if(imported.length>classified)violations.push({file:args.path,message:'Unclassified SDK app import is not allowed'});
if(/(?:import\s*\(|require\s*\()\s*['"]@get-bb\/plugin-sdk\/app['"]/.test(source))violations.push({file:args.path,message:'Dynamic SDK app import is not allowed'});
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
