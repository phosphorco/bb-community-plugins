import {test,expect} from 'bun:test';
import {chromium} from '@playwright/test';
import {mkdtemp,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {appFixture} from './app-fixture';
import {mobileReachabilityWithSetup,cleanupMobileResources,type MobileResources} from './browser-mobile';

const failedBuild=()=>Bun.spawnSync([process.execPath,'-e','console.error("INJECTED_MOBILE_BUILD_FAILURE");process.exit(23)'],{stdout:'pipe',stderr:'pipe'});
async function released(resources:Readonly<MobileResources>,url?:string){
 expect(resources.fixture).toBeDefined();expect(resources.scratch).toBeDefined();
 await expect(stat(resources.scratch!)).rejects.toThrow();
 const bootstrap=Object.entries(resources.fixture!.wire.rpc).find(([name])=>name.endsWith('.bootstrap'));expect(bootstrap).toBeDefined();await expect(bootstrap![1]({})).rejects.toThrow();
 if(resources.browser)expect(resources.browser.isConnected()).toBe(false);
 if(url)await expect(fetch(url,{signal:AbortSignal.timeout(2000)})).rejects.toThrow();
}

test('mobile build failure cleans the actual fixture and scratch acquired before the build',async()=>{
 let resources:Readonly<MobileResources>|undefined;
 await expect(mobileReachabilityWithSetup({build:failedBuild,acquired:r=>{resources=r;}})).rejects.toThrow('INJECTED_MOBILE_BUILD_FAILURE');
 expect(resources!.server).toBeUndefined();expect(resources!.browser).toBeUndefined();await released(resources!);
});

test('mobile browser-launch failure stops the actual HTTP listener and disposes fixture/build directory',async()=>{
 let resources:Readonly<MobileResources>|undefined,url:string|undefined;const primary=new Error('INJECTED_MOBILE_LAUNCH_FAILURE');
 await expect(mobileReachabilityWithSetup({launch:async()=>{throw primary;},acquired:r=>{resources=r;if(r.server)url=`http://127.0.0.1:${r.server.port}`;}})).rejects.toBe(primary);
 expect(url).toBeDefined();expect(resources!.browser).toBeUndefined();await released(resources!,url);
},30000);

test('failure after a real browser was acquired closes it and preserves the original context error',async()=>{
 let resources:Readonly<MobileResources>|undefined,url:string|undefined;const primary=new Error('INJECTED_MOBILE_CONTEXT_FAILURE');
 await expect(mobileReachabilityWithSetup({launch:async()=>{const browser=await chromium.launch({headless:true});browser.newContext=async()=>{throw primary;};return browser;},acquired:r=>{resources=r;if(r.server)url=`http://127.0.0.1:${r.server.port}`;}})).rejects.toBe(primary);
 expect(resources!.browser).toBeDefined();await released(resources!,url);
},30000);

test('normal local mobile cleanup closes real browser/page/listener/fixture/directory, and a close error does not skip later resources',async()=>{
 for(const closeFails of [false,true]){
  const resources:MobileResources={};let cleaned=false;const cleanupError=new Error('INJECTED_BROWSER_CLOSE_FAILURE');
  try{resources.fixture=await appFixture(`mobile-cleanup-${crypto.randomUUID()}`);resources.scratch=await mkdtemp(join(tmpdir(),'templates-mobile-cleanup-'));const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response('local cleanup witness')});resources.server=server;
   resources.browser=await chromium.launch({headless:true});const context=await resources.browser.newContext(),page=await context.newPage(),url=server.url.toString();await page.goto(url);expect(await page.textContent('body')).toBe('local cleanup witness');
   if(closeFails){const close=resources.browser.close.bind(resources.browser);resources.browser.close=async()=>{await close();throw cleanupError;};}
   if(closeFails){let caught:unknown;try{await cleanupMobileResources(resources);}catch(error){caught=error;}expect(caught).toBeInstanceOf(AggregateError);expect((caught as AggregateError).errors).toContain(cleanupError);}
   else await cleanupMobileResources(resources);
   cleaned=true;expect(page.isClosed()).toBe(true);await released(resources,url);
  }finally{if(!cleaned)await cleanupMobileResources(resources);}
 }
},30000);

test('cleanup failure is reported but never replaces the primary build failure; scratch removal still runs',async()=>{
 let resources:Readonly<MobileResources>|undefined,wrapped=false;
 let primary:unknown;try{await mobileReachabilityWithSetup({build:failedBuild,acquired:r=>{resources=r;if(r.fixture&&!wrapped){wrapped=true;const dispose=r.fixture.dispose.bind(r.fixture);r.fixture.dispose=async()=>{await dispose();throw new Error('INJECTED_FIXTURE_CLEANUP_FAILURE');};}}});}catch(error){primary=error;}
 expect(primary).toBeInstanceOf(Error);expect(primary).not.toBeInstanceOf(AggregateError);expect((primary as Error).message).toBe('INJECTED_MOBILE_BUILD_FAILURE\n');await released(resources!);
});
