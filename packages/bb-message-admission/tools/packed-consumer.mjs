/** Disposable local tarball consumer, with actual exact registry SDK. Never registry proof for this package. */
import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('..',import.meta.url));
const scratch=mkdtempSync(join(tmpdir(),'bb-message-admission-packed-'));
function run(command,args,cwd){const output=spawnSync(command,args,{cwd,encoding:'utf8',timeout:300000,env:{...process.env,npm_config_cache:join(scratch,'npm-cache')}});if(output.error)throw output.error;if(output.status!==0)throw new Error(`${command} failed (${output.status})\n${output.stdout}\n${output.stderr}`);return output.stdout;}
try{
  const packed=JSON.parse(run('npm',['pack','--json','--ignore-scripts','--pack-destination',scratch],root))[0];
  const consumer=join(scratch,'consumer');mkdirSync(consumer);
  writeFileSync(join(consumer,'package.json'),JSON.stringify({name:'packed-message-admission-consumer',private:true,version:'1.0.0',type:'module'}));
  run('npm',['install','--ignore-scripts','--no-audit','--no-fund',join(scratch,packed.filename),'@get-bb/plugin-sdk@0.6.52','typescript@5.9.3'],consumer);
  writeFileSync(join(consumer,'probe.mts'),`
import type {BbPluginApi,PluginBrowserBbSdk} from '@get-bb/plugin-sdk';
import type {NativeAdmissionProtocolV1,SubmissionV1,RequestedIntent,EvaluationResultV1} from '@phosphorco/bb-message-admission/protocol';
import {bindMessageAdmission} from '@phosphorco/bb-message-admission/bb';
import {runCapabilityConformance} from '@phosphorco/bb-message-admission/testing';
declare const backend:BbPluginApi;declare const browser:PluginBrowserBbSdk;
void bindMessageAdmission(backend);void bindMessageAdmission(browser);
// The owned contract does not augment the exact registry SDK baseline.
// @ts-expect-error No such member in actual registry SDK0.6.52.
backend.experimental_messageAdmission;
const boundary:unknown={};void bindMessageAdmission(boundary);
void runCapabilityConformance;export type {NativeAdmissionProtocolV1,SubmissionV1,RequestedIntent,EvaluationResultV1};
`);
  run(process.execPath,['node_modules/typescript/bin/tsc','--noEmit','--strict','--skipLibCheck','--target','ES2023','--module','NodeNext','--moduleResolution','NodeNext','probe.mts'],consumer);
  writeFileSync(join(consumer,'probe.mjs'),`
import assert from 'node:assert/strict';
import * as p from '@phosphorco/bb-message-admission/protocol';
import {bindMessageAdmission} from '@phosphorco/bb-message-admission/bb';
import {runCapabilityConformance} from '@phosphorco/bb-message-admission/testing';
assert.equal(p.PROTOCOL,'bb-message-admission');assert.equal(p.VERSION,1);
assert.equal((await bindMessageAdmission({})).reason,'absent');
assert.equal((await bindMessageAdmission({experimental_messageAdmission:{describe(){return {protocol:p.PROTOCOL,versions:[2],capabilities:'not decoded'};}}})).reason,'incompatible');
const limits={requestBytes:2097152,responseBytes:2097152,snapshotBytes:1048576,evidenceBytes:1048576,manifestBytes:2097152,evaluationMs:30000,concurrentEvaluations:4};
const native={describe(){return {protocol:p.PROTOCOL,versions:[1,2],capabilities:{admission:true,publication:true,operations:true,placement:false,originalManifest:false,activity:false,feedback:false,limits}};},registerEvaluator(){throw Error('unused boundary fixture');},unregisterEvaluator(){throw Error('unused boundary fixture');},publish(){throw Error('unused boundary fixture');},readActivePublication(){return null;},lookupOperation(){return {version:1,status:'missing',record:null};},recheckOperation(){throw Error('unused boundary fixture');}};
const report=await runCapabilityConformance({bb:{experimental_messageAdmission:native},subject:'packed scripted boundary fixture only',cases:[{name:'readActivePublication',run:client=>client.readActivePublication({version:1,providerId:'fixture'}),verify:value=>assert.equal(value,null)}]});assert.equal(report.passed,true,JSON.stringify(report));
console.log('All three installed package entries imported; absent/incompatible/capable binding fixtures passed.');
`);
  const runtime=run(process.execPath,['probe.mjs'],consumer).trim();
  const own=JSON.parse(readFileSync(join(consumer,'node_modules/@phosphorco/bb-message-admission/package.json'),'utf8'));
  const sdk=JSON.parse(readFileSync(join(consumer,'node_modules/@get-bb/plugin-sdk/package.json'),'utf8'));
  console.log(JSON.stringify({proof:'local-packed-consumer',package:own.name,version:own.version,tarballIntegrity:packed.integrity,sdk:{source:'npm registry',version:sdk.version},types:true,runtime,registryPublicationOfOwnedPackage:false,nativeConformance:false}));
}finally{rmSync(scratch,{recursive:true,force:true});}
