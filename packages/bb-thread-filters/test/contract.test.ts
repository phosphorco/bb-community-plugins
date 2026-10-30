import { test,expect } from 'bun:test';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { registerThreadFilterSupplier,createThreadFilterClient } from '../src/bb.ts';
import { validateMatch,matchValues,parseBounded,matchOutputSchema,METHODS } from '../src/index.ts';
import { checkThreadFilterSupplier } from '../src/testing.ts';
const input={viewerKey:'cole',selection:{dimensionId:'tag',values:['one'],mode:'any' as const},threads:[{id:'a',projectId:'p',parentThreadId:null}]};
const output={rows:[{threadId:'a',matches:true}],revision:'r1',coverage:'complete' as const,message:null,refreshAt:null};
test('strict inputs and additive nested output; rejects missing, duplicate or extraneous rows',()=>{
 expect(validateMatch(input,{...output,extra:true,rows:[{...output.rows[0],extra:true}]}).rows[0]?.matches).toBe(true);
 for(const rows of [[],[...output.rows,...output.rows],[{threadId:'other',matches:true}],[{threadId:'a',matches:null}]])expect(()=>validateMatch(input,{...output,rows})).toThrow();
 expect(()=>parseBounded(matchOutputSchema,{...output,extra:'x'.repeat(300000)},262144)).toThrow();
 expect(matchValues(['one','two'],['one','two'],'all')).toBe(true);
 expect(matchValues(['one'],['one','two'],'all')).toBe(false);
});
test('actual registration conformance, owner targeting, choice reads and input rejection',async()=>{
 const host=createFakePluginHost({pluginId:'supplier'});
 registerThreadFilterSupplier(host.bb,{dimensions:[{id:'tag',label:'Tags',multiple:true,description:'Fixture'}],choices:()=>({choices:[{id:'one',label:'One'}],nextCursor:null,revision:'r1'}),match:()=>output});
 const transport=async(args:any)=>{expect(args.pluginId).toBe('supplier');return host.harness.behavior.callRpc(args.method,args.input);};
 try{
  expect((await checkThreadFilterSupplier({transport,pluginId:'supplier',cases:[{input,expected:[true]}]})).cases).toBe(1);
  const client=createThreadFilterClient(transport,'supplier');expect((await client.choices({dimensionId:'tag',viewerKey:'cole',query:'',cursor:null,limit:1})).choices[0]?.id).toBe('one');
  await expect(host.harness.behavior.callRpc(METHODS.match,{...input,extra:true})).rejects.toThrow();
  await expect(host.harness.behavior.callRpc(METHODS.match,{...input,selection:{...input.selection,extra:true}})).rejects.toThrow();
 }finally{await host.harness.dispose();}
});
test('negotiates version envelope before details and serializes calls to the same owner',async()=>{
 let active=0,peak=0;
 const client=createThreadFilterClient(async()=>{active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,10));active--;return {protocol:'bb.thread-filters',versions:[1,2],dimensions:[]};},'supplier');
 await Promise.all([client.describe(),client.describe()]);expect(peak).toBe(1);
 for(const versions of [[2],[],['bad']]){const incompatible=createThreadFilterClient(async()=>({protocol:'bb.thread-filters',versions}),'supplier');await expect(incompatible.describe()).rejects.toThrow();}
});
test('abort settles locally but retains admission until the raw owner call settles',async()=>{
 let starts=0,release:(value:unknown)=>void=()=>{};
 const held=new Promise(resolve=>{release=resolve;});
 const description={protocol:'bb.thread-filters',versions:[1],dimensions:[]};
 const client=createThreadFilterClient(async()=>{starts++;return starts===1?held:description;},'supplier');
 const controller=new AbortController(),first=client.describe(controller.signal);
 for(let i=0;i<5;i++)await Promise.resolve();
 controller.abort();await expect(first).rejects.toThrow();
 await expect(client.describe()).rejects.toThrow('outstanding');expect(starts).toBe(1);
 release(description);for(let i=0;i<8;i++)await Promise.resolve();
 expect(await client.describe()).toEqual([]);expect(starts).toBe(2);
});
