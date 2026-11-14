import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
const cwd=resolve(import.meta.dirname,'..'),scratch=mkdtempSync(join(tmpdir(),'bb-jev-packed-'));
const run=(command,args,where=scratch)=>{const r=spawnSync(command,args,{cwd:where,encoding:'utf8',env:{...process.env,npm_config_cache:join(scratch,'cache')}});if(r.status!==0)throw Error(`${command} ${args.join(' ')}\n${r.stdout}\n${r.stderr}`);return r.stdout;};
try{
 const pack=JSON.parse(run('npm',['pack','--ignore-scripts','--json','--pack-destination',scratch],cwd))[0];
 writeFileSync(join(scratch,'package.json'),JSON.stringify({private:true,type:'module'}));
 run('npm',['install','--save-exact','--ignore-scripts','--no-audit','--no-fund',join(scratch,pack.filename),'@get-bb/plugin-sdk@0.6.52','typescript@5.9.3']);
 writeFileSync(join(scratch,'consumer.ts'),`import type {BbPluginApi} from '@get-bb/plugin-sdk';\nimport {createJevClient,registerJevOwner,type OwnerPort} from '@phosphorco/bb-jev/bb';\nimport {SubmitSchema,type Submit} from '@phosphorco/bb-jev';\nimport {runJevConformance} from '@phosphorco/bb-jev/testing';\ndeclare const bb:BbPluginApi;declare const port:OwnerPort;\ncreateJevClient(bb.sdk);registerJevOwner(bb,port);const request:Submit=SubmitSchema.parse({});void request;void runJevConformance;\n`);
 writeFileSync(join(scratch,'tsconfig.json'),JSON.stringify({compilerOptions:{target:'ES2023',module:'NodeNext',moduleResolution:'NodeNext',strict:true,exactOptionalPropertyTypes:true,skipLibCheck:true,noEmit:true},files:['consumer.ts']}));
 run(process.execPath,['node_modules/typescript/bin/tsc','--project','tsconfig.json']);
 const imports=await import('node:url');
 for(const file of ['protocol.js','bb.js','testing.js'])await import(imports.pathToFileURL(join(scratch,'node_modules/@phosphorco/bb-jev/dist',file)).href);
 const lock=JSON.parse(readFileSync(join(scratch,'package-lock.json'),'utf8'));const sdk=lock.packages['node_modules/@get-bb/plugin-sdk'];
 console.log(JSON.stringify({pack:{filename:pack.filename,integrity:pack.integrity,files:pack.files.map(f=>f.path)},sdk:{version:sdk.version,resolved:sdk.resolved,integrity:sdk.integrity},strictPublicTypes:true,allEntriesLoaded:true,localPackNotRegistry:true},null,2));
}finally{rmSync(scratch,{recursive:true,force:true});}
