// Requires a coordinated check window: installs only into disposable scratch.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const selectedSdk=process.env.BB_CONTEXT_RECOGNITION_SDK || resolve(packageRoot,'../../../sdk-artifacts/get-bb-plugin-sdk-0.6.29+phosphor.81da17d778dc.sdk.86b45b082135.tgz');
const scratch = mkdtempSync(join(tmpdir(), 'bb-context-recognition-packed-'));
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 300000,
    env: { ...process.env, npm_config_cache: join(scratch, 'npm-cache') } });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited ${result.status}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
try {
  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  const packed = JSON.parse(run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', scratch], packageRoot))[0];
  const proofs=[];
  for(const sdkVersion of existsSync(selectedSdk)?['0.5.29','0.6.29']:['0.5.29']) {
  const consumer = join(scratch, 'consumer-'+sdkVersion);
  mkdirSync(consumer);
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ name: 'packed-recognition-consumer', version: '1.0.0', private: true, type: 'module' }));
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', join(scratch, packed.filename), sdkVersion==='0.5.29'?'@get-bb/plugin-sdk@'+sdkVersion:selectedSdk, 'typescript@5.9.3', 'better-sqlite3@12.10.0', 'cron-parser@5.5.0', 'hono@4.11.9', 'react@19.2.1', 'react-dom@19.2.1', 'jsdom@27.4.0', '@testing-library/react@16.3.2'], consumer);
  writeFileSync(join(consumer, 'probe.mjs'), `
import assert from 'node:assert/strict';
import * as root from '@phosphorco/bb-context-recognition';
import * as bb from '@phosphorco/bb-context-recognition/bb';
import * as kit from '@phosphorco/bb-context-recognition/testing';
import * as registry from '@phosphorco/bb-context-recognition/presentation';
import * as react from '@phosphorco/bb-context-recognition/react';
import * as mounted from '@phosphorco/bb-context-recognition/testing/react';
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {JSDOM} from 'jsdom';
assert.equal(typeof registry.registerPresentation,'function');assert.equal(typeof react.PresentationHost,'function');assert.equal(typeof mounted.runPresentationConformance,'function');
assert.equal(root.METHODS.describe, 'contextRecognitionDescribe');
assert.equal(typeof bb.enumerateRecognitionSuppliers, 'function');
assert.equal(typeof kit.runSupplierConformance, 'function');
const report = await kit.runSupplierConformance({ pluginId: 'packed-supplier', register(host) {
  bb.registerRecognitionSupplier(host, { revision: 'packed/1', linkify: { providers: [{ provider: 'packed', kinds: ['item'] }], handler: () => ({ candidates: [] }) } });
} });
assert.equal(report.passed, true, JSON.stringify(report));
const dom=new JSDOM('<div id="root"></div>');
for(const key of ['window','document','navigator','HTMLElement','Element','Node'])Object.defineProperty(globalThis,key,{configurable:true,value:dom.window[key]});
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const owner=new AbortController();let broken=true,ready=0;
const dispose=registry.registerPresentation({pluginId:'packed-supplier',generation:1,signal:owner.signal},{schema:'packed-supplier/view@1',decode:d=>d,methods:['scene'],load:async()=>()=>{if(broken)throw new Error('Packed transient renderer failure');return React.createElement('p',null,'Recovered packed view');}});
const rootNode=createRoot(dom.window.document.getElementById('root'));
const props={sdk:{plugins:{callRpc:async()=>({})}},consumer:{pluginId:'packed-consumer',surface:'brief'},stamp:{pluginId:'packed-supplier',schema:'packed-supplier/view@1',data:{}},identity:{provider:'packed',id:'item'},readyPlugins:new Set(['packed-supplier']),mode:'docked',size:{maxWidth:400,maxHeight:300,preferredHeight:240},navigate:{toThread(){},openUrl(){},openFile(){return true;}},fallback:React.createElement('span',null,'Packed fallback'),onReady:()=>ready++};
try{
 await act(async()=>rootNode.render(React.createElement(react.PresentationHost,{...props,retryKey:0})));
 assert.match(dom.window.document.body.textContent,/Plan view failed/);assert.equal(ready,0);
 broken=false;await act(async()=>rootNode.render(React.createElement(react.PresentationHost,{...props,retryKey:1})));
 assert.match(dom.window.document.body.textContent,/Recovered packed view/);assert.doesNotMatch(dom.window.document.body.textContent,/Plan view failed/);assert.equal(ready,1);
}finally{await act(async()=>rootNode.unmount());dispose();owner.abort();dom.window.close();}

console.log('Packed consumer imports all six entries and runs source conformance; SDK ${sdkVersion}.');
`);
  writeFileSync(join(consumer,'probe.ts'), `
import type { PluginBrowserBbSdk } from '@get-bb/plugin-sdk';
import type { PresentationEntryV1 } from '@phosphorco/bb-context-recognition/presentation';
import { createOwnerPresentationClient } from '@phosphorco/bb-context-recognition/react';
import { createSupplierClient } from '@phosphorco/bb-context-recognition/bb';
declare const sdk: PluginBrowserBbSdk;
declare const entry: PresentationEntryV1;
createOwnerPresentationClient(sdk, entry);
createSupplierClient(sdk, 'plan-graph');
`);
  run(process.execPath,['node_modules/typescript/bin/tsc','--noEmit','--strict','--skipLibCheck','--module','NodeNext','--moduleResolution','NodeNext','--target','ES2023','probe.ts'],consumer);
  const output = run(process.execPath, ['probe.mjs'], consumer).trim();
  proofs.push({sdk:sdkVersion,types:true,output});
  }
  console.log(JSON.stringify({ proof: 'packed-consumer-source', version: manifest.version, sdks: proofs, selectedSdkAvailable:existsSync(selectedSdk), entries: ['.', './bb', './testing', './presentation', './react', './testing/react'], sdkTestingPeers: ['better-sqlite3@12.10.0', 'cron-parser@5.5.0', 'hono@4.11.9', '@testing-library/react@16.3.2'], nativeDatabaseTested: false }));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
