/** Optional REACT_CORE_PACKAGE selects an exact extracted package's advertised exports only. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
const candidate=process.env.REACT_CORE_PACKAGE;
const manifest=candidate?JSON.parse(await readFile(resolve(candidate,'package.json'),'utf8')):null;
const built=await Bun.build({entrypoints:[new URL('./react-core-browser-app.tsx',import.meta.url).pathname],target:'browser',format:'iife',plugins:candidate?[{name:'exact-public-package',setup(build){build.onResolve({filter:/^@phosphorco\/bb-identity(?:\/.*)?$/},args=>{const key=args.path==='@phosphorco/bb-identity'?'.':'.'+args.path.slice('@phosphorco/bb-identity'.length);const target=manifest.exports[key]?.import;if(!target)throw new Error(`Unadvertised package entry ${key}`);return {path:resolve(candidate,target)};});}}]:[]});
if(!built.success)throw new Error(built.logs.map(log=>log.message).join('\n'));const script=await built.outputs[0]!.text();
const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:r=>new URL(r.url).pathname==='/app.js'?new Response(script,{headers:{'content-type':'application/javascript'}}):new Response('<div id="root"></div><script src="/app.js"></script>',{headers:{'content-type':'text/html'}})});
let browser;
try{
 browser=await chromium.launch();const page=await browser.newPage(),errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(server.url.toString());
 const loaded=async(name:string,map='map-1')=>{await page.locator(`[data-editor="${name}"][data-status="loaded"][data-map="${map}"]`).waitFor();await page.locator(`[data-reader="${name}"][data-same="true"]`).waitFor();};
 for(const name of ['core-parent','native-parent']){
  await loaded(name);assert.equal(await page.evaluate(n=>window.reactCoreProbe.select(n),name),true);await page.locator(`[data-reader="${name}"][data-view="true"][data-state="ready"]`).waitFor();
  assert.equal(await page.evaluate(n=>window.reactCoreProbe.editViewed(n),name),false);assert.equal(await page.evaluate(n=>window.reactCoreProbe.reset(n),name),true);await loaded(name);
 }
 const name='core-parent';assert.equal(await page.evaluate(n=>window.reactCoreProbe.edit(n,'A'),name),true);assert.equal(await page.evaluate(n=>window.reactCoreProbe.flush(n),name),false);assert.equal(await page.evaluate(n=>window.reactCoreProbe.edit(n,'B'),name),true);
 await page.evaluate(n=>{window.reactCoreProbe.fail(n);window.reactCoreProbe.target(n);},name);await loaded(name,'map-2');await page.locator(`[data-reader="${name}"][data-failures="1"]`).waitFor();
 const stats=await page.evaluate(n=>window.reactCoreProbe.stats(n),name) as {same:boolean;failures:{draft:{target:{mapId:string};draft:{desired:string;inFlight:{value:string}}}}[];starts:number;disposes:number};
 assert.equal(stats.same,true);assert.equal(stats.failures[0]!.draft.target.mapId,'map-1');assert.equal(stats.failures[0]!.draft.draft.desired,'B');assert.equal(stats.failures[0]!.draft.draft.inFlight.value,'A');assert.equal(stats.starts,0);assert.equal(stats.disposes,0);
 assert.equal(await page.locator('[data-reader="native-parent"]').getAttribute('data-failures'),'0');
 await page.evaluate(n=>window.reactCoreProbe.attach(n,false),name);await page.locator(`[data-detached="${name}"]`).waitFor({state:'attached'});await page.evaluate(n=>window.reactCoreProbe.attach(n,true),name);await loaded(name,'map-2');await page.locator(`[data-reader="${name}"][data-failures="1"]`).waitFor();
 assert.equal(await page.evaluate(n=>window.reactCoreProbe.ack(n),name),true);await page.locator(`[data-reader="${name}"][data-failures="0"]`).waitFor();assert.equal(await page.evaluate(n=>window.reactCoreProbe.edit(n,'C'),name),true);
 await page.evaluate(()=>window.reactCoreProbe.unmount());await page.waitForFunction(()=>{const s=window.reactCoreProbe.stats('core-parent') as {active:number};return s.active===0;});assert.deepEqual(errors,[]);
 process.stdout.write('mixed public React entries: BOTH Provider/Context/hook directions, shared view-as/reset, read-only, unknownA/typeB, shared failure owner, null-client recovery, root isolation, StrictMode teardown PASS\n');
}finally{await browser?.close();server.stop(true);}
