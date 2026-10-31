/** Same-archive source proof. Installs only into disposable npm consumers. */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const sdkArchive = process.env.BB_TURN_RESULTS_SDK_ARCHIVE ?? resolve(packageRoot, '../../../sdk-artifacts/get-bb-plugin-sdk-0.6.52+phosphor.975e38f02f1a.sdk.12eb78c20820.tgz');
const modes = (process.env.BB_TURN_RESULTS_PACKED_MODES ?? 'core,testing,react').split(',');
if (modes.some(value => !['core', 'testing', 'react'].includes(value))) throw Error('Unknown packed proof mode.');
const scratch = mkdtempSync(join(tmpdir(), 'bb-turn-results-packed-'));
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 180000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, npm_config_cache: join(scratch, 'npm-cache') } });
  if (result.error) throw result.error;
  if (result.status !== 0) throw Error(`${command} exited ${result.status}\n${result.stdout.slice(-12000)}\n${result.stderr.slice(-12000)}`);
  return result.stdout;
}
function file(cwd, name, content) { writeFileSync(join(cwd, name), content); }
const reports = [];
try {
  const packed = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', scratch], packageRoot))[0];
  const archive = join(scratch, packed.filename);
  const digest = createHash('sha256').update(readFileSync(archive)).digest('hex');
  const kitPeers = [sdkArchive, '@types/react@19.2.2', '@types/node@22', '@types/better-sqlite3@7.6.13', 'better-sqlite3@12.10.0', 'cron-parser@5.5.0', 'hono@4.11.9'];
  for (const mode of modes) {
    if (mode !== 'core' && !existsSync(sdkArchive)) throw Error('Selected SDK archive missing; cannot substitute another artifact.');
    const cwd = join(scratch, mode); mkdirSync(cwd);
    file(cwd, 'package.json', JSON.stringify({ name: `packed-results-${mode}`, private: true, version: '0.0.0', type: 'module' }));
    const peers = mode === 'core' ? [] : [...kitPeers, ...(mode === 'react' ? ['react@19.2.1', 'react-dom@19.2.1', '@types/react-dom@19.2.2', 'jsdom@27.4.0', '@types/jsdom@27.0.0', '@testing-library/react@16.3.2', 'recognition-old@npm:@phosphorco/bb-context-recognition@0.4.1'] : [])];
    run('npm', ['install', '--ignore-scripts', '--omit=optional', '--no-audit', '--no-fund', archive, 'typescript@5.9.3', ...peers], cwd);
    file(cwd, 'tsconfig.json', JSON.stringify({ compilerOptions: { strict: true, skipLibCheck: false, noEmit: true, module: 'NodeNext', moduleResolution: 'NodeNext', target: 'ES2023', lib: ['ES2023', 'DOM'], types: [] }, files: ['probe.ts'] }));
    file(cwd, 'probe.ts', mode === 'core' ? `
import {identityDigest, ContentBlockSchema, type ResultIdentity} from '@phosphorco/bb-turn-results';
import {adaptCompletedEvent} from '@phosphorco/bb-turn-results/events';
import {createResultsSupplierClient, type RpcPort} from '@phosphorco/bb-turn-results/bb';
declare const rpc:RpcPort; declare const identity:ResultIdentity;
identityDigest(identity); createResultsSupplierClient({plugins:rpc},'images');
adaptCompletedEvent({}); ContentBlockSchema.parse({});
` : mode === 'testing' ? `
import {runSupplierConformance,runConsumerConformance, type ParticipantSource} from '@phosphorco/bb-turn-results/testing';
import {registerTurnResultsParticipant} from '@phosphorco/bb-turn-results/bb';
declare const source:ParticipantSource<{}>;
void runSupplierConformance;void runConsumerConformance;void source;void registerTurnResultsParticipant;
` : `
import {runResultPresentationConformance,type ResultPresentationConformanceOptions} from '@phosphorco/bb-turn-results/testing/react';
declare const options:ResultPresentationConformanceOptions<{}>;
void runResultPresentationConformance;void options;
`);
    run(process.execPath, ['node_modules/typescript/bin/tsc', '--project', 'tsconfig.json'], cwd);
    file(cwd, 'probe.mjs', mode === 'core' ? `
import assert from 'node:assert/strict';import{existsSync}from'node:fs';
import * as root from '@phosphorco/bb-turn-results';
import * as events from '@phosphorco/bb-turn-results/events';
import * as bb from '@phosphorco/bb-turn-results/bb';
assert.equal(root.resolveOutcomeBudget(8),8064);assert.equal(typeof events.adaptCompletedEvent,'function');assert.equal(typeof bb.createResultsSupplierClient,'function');
for(const path of ['@get-bb/plugin-sdk','react','react-dom','jsdom'])assert.equal(existsSync('node_modules/'+path),false,path+' unexpectedly installed');
root.ContentBlockSchema.parse({identity:{provider:'threads',id:'thr_x',kind:'thread'},fallback:{kind:'card',title:'Thread'},navigation:{kind:'thread',threadId:'thr_x'}});
` : mode === 'testing' ? `
import assert from 'node:assert/strict';import{existsSync}from'node:fs';
import {runConsumerConformance} from '@phosphorco/bb-turn-results/testing';
import {registerTurnResultsParticipant} from '@phosphorco/bb-turn-results/bb';
const result=await runConsumerConformance({pluginId:'packed-consumer',source:{entry:'package-owned-archive-adapter-witness',revision:'1'},sourcePorts:{},participantFactory(bb){return registerTurnResultsParticipant(bb,{pluginId:'packed-consumer',capabilities:{revision:'1',consumer:{invalidate:true}},invalidate:()=>({state:'dirty'})});},invalidateCases:[{name:'registered-adapter',input:{version:1,supplierPluginId:'packed-supplier',threadId:'thr_x',revision:{epoch:'e1',sequence:1},affected:'thread'},expected:{state:'dirty'}}]});
assert.equal(result.passed,true,JSON.stringify(result));for(const path of ['react','react-dom','jsdom'])assert.equal(existsSync('node_modules/'+path),false,path+' unexpectedly installed');
` : `
import assert from 'node:assert/strict';import React from 'react';import{z}from'zod';
import{definePluginApp}from'@get-bb/plugin-sdk/app';
import{registerPresentation,lookupPresentation}from'@phosphorco/bb-context-recognition/presentation';
import{registerPresentation as oldRegister,lookupPresentation as oldLookup}from'recognition-old/presentation';
import{runResultPresentationConformance}from'@phosphorco/bb-turn-results/testing/react';
const result=await runResultPresentationConformance({pluginId:'packed-visual',source:{entry:'package-owned-archive-app-witness',revision:'1'},sourcePorts:{},participantFactory(bb){bb.rpc.register({scene:{input:z.unknown(),output:z.unknown()}},{scene:()=>({})});},appDefinition:()=>definePluginApp(app=>app.contentScripts.register({id:'scene',mount:ctx=>oldRegister(ctx,{schema:'packed-visual/view@1',methods:['scene'],decode:data=>data,load:async()=>()=>React.createElement('p',null,'Packed referent')})})),cases:[{name:'referent',loadContent:()=>({identity:{provider:'threads',id:'thr_x',kind:'thread'},fallback:{kind:'card',title:'Thread'},navigation:{kind:'thread',threadId:'thr_x'},presentation:{schema:'packed-visual/view@1',data:{}}}),expect:{schema:'packed-visual/view@1',state:'ready',text:'Packed referent'}}]});assert.equal(result.passed,true,JSON.stringify(result));
const a=new AbortController(),b=new AbortController();const registration={schema:'mixed-visual/view@1',methods:['scene'],decode:data=>data,load:async()=>()=>null};
const disposeOld=oldRegister({pluginId:'mixed-visual',generation:1,signal:a.signal},registration);
assert.equal(lookupPresentation('mixed-visual',registration.schema).generation,1);
const disposeNew=registerPresentation({pluginId:'mixed-visual',generation:2,signal:b.signal},registration);
disposeOld();a.abort();assert.equal(oldLookup('mixed-visual',registration.schema).generation,2);
disposeNew();b.abort();assert.equal(lookupPresentation('mixed-visual',registration.schema),undefined);
`);
    run(process.execPath, ['probe.mjs'], cwd);
    const cr = JSON.parse(readFileSync(join(cwd, 'node_modules/@phosphorco/bb-context-recognition/package.json')));
    reports.push({ mode, imports: true, types: true, skipLibCheck: false, contextRecognition: cr.version,
      reactRuntimeInstalled: existsSync(join(cwd, 'node_modules/react')), sdkInstalled: existsSync(join(cwd, 'node_modules/@get-bb/plugin-sdk')),
      ...(mode === 'react' ? { mixedReleasedContextRecognition: ['0.4.1', cr.version], staleDisposer: true, oldRegistrationNewHost: true } : {}) });
  }
  console.log(JSON.stringify({ proof: 'same-archive-package-source', version: packed.version, archiveSha256: digest, bytes: packed.size, modes: reports,
    actualAdopterConformance: false, live: false, published: false, selectedSdkArchiveSha256: modes.some(mode => mode !== 'core') ? createHash('sha256').update(readFileSync(sdkArchive)).digest('hex') : null }));
} finally { rmSync(scratch, { recursive: true, force: true }); }
