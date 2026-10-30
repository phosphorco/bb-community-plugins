/** Installs only the actual packed artifact into disposable consumer scratch. No registry publication. */
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join,dirname} from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const root=fileURLToPath(new URL('../',import.meta.url));
const require=createRequire(import.meta.url);
const bunManifest=require.resolve('bun/package.json');
assert.equal(JSON.parse(readFileSync(bunManifest,'utf8')).version,'1.3.14');
const bun=resolve(dirname(bunManifest),'bin/bun.exe');
const scratch=mkdtempSync(join(tmpdir(),'bb-markdown-packed-'));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
function run(command,args,cwd){
 const result=spawnSync(command,args,{cwd,encoding:'utf8',timeout:300000,maxBuffer:8*1024*1024,env:{...process.env,npm_config_cache:join(scratch,'npm-cache')}});
 if(result.error)throw result.error;
 assert.equal(result.status,0,`${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
 return result.stdout;
}
try{
 const manifest=JSON.parse(readFileSync(join(root,'package.json'),'utf8'));
 const packed=JSON.parse(run('npm',['pack','--json','--ignore-scripts','--pack-destination',scratch],root))[0];
 assert.equal(packed.version,'0.1.0');
 for(const file of packed.files)assert.ok(!/^(?:src|node_modules|test)\//u.test(file.path),`Private source in package: ${file.path}`);
 for(const file of ['dist/index.js','dist/server.js','dist/bb.js','dist/react.js','dist/testing-source-gate.js','tools/check-sources.mjs','tools/markdown-debt.json','README.md','LICENSE'])assert.ok(packed.files.some(f=>f.path===file),`Missing packed ${file}`);
 const consumer=join(scratch,'consumer');mkdirSync(consumer);
 writeFileSync(join(consumer,'package.json'),JSON.stringify({name:'markdown-packed-proof',version:'1.0.0',private:true,type:'module'}));
 run('npm',['install','--ignore-scripts','--no-audit','--no-fund',join(scratch,packed.filename),'@get-bb/plugin-sdk@0.6.52','react@19.2.1','react-dom@19.2.1','@types/react@19.2.2','@types/react-dom@19.2.2','@types/node@22','typescript@5.9.3'],consumer);
 writeFileSync(join(consumer,'probe.mjs'),`
import assert from 'node:assert/strict';
import {readFileSync,realpathSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import * as root from '@phosphorco/bb-markdown';
import * as server from '@phosphorco/bb-markdown/server';
import * as bb from '@phosphorco/bb-markdown/bb';
import * as react from '@phosphorco/bb-markdown/react';
import * as gate from '@phosphorco/bb-markdown/testing/source-gate';
assert.equal(typeof bb.registerMarkdown,'function');assert.ok(react.Markdown);assert.equal(typeof react.MarkdownProvider,'function');
const source={kind:'detached',producer:'packed',sourceKey:'one',revision:'r1',origin:'foreign'};
const request={source,intent:'prose',content:'**Readable** [exact](https://example.test/a?q=1&b=2#x) \\u0060/outside/file.ts\\u0060'};
const owner=server.createMarkdownOwner({sdk:{threads:{get(){throw Error('Detached must not read thread');}},environments:{get(){throw Error('Detached must not read environment');}},plugins:{list:async()=>({plugins:[]}),callRpc:async()=>{throw Error('No suppliers');}}},consumer:{pluginId:'packed'}});
try{const [model]=await owner.prepare({phase:'base',requests:[request]});assert.ok(root.PreparedMarkdownSchema.safeParse(model).success);assert.equal(model.original,request.content);assert.equal(model.document,null);assert.equal(model.format,'markdown');assert.ok(model.tree.children.length);}finally{owner.dispose();}
assert.equal(gate.inspectSource({root:'consumer',path:'plugins/new/app.tsx',source:'import {Markdown as Raw} from "@get-bb/plugin-sdk/app"; export const V=()=> <Raw content="x" />;'}).findings.length>0,true);
const resolution={};for(const entry of ['', '/bb','/server','/react','/testing/source-gate'])resolution[entry||'.']=realpathSync(fileURLToPath(import.meta.resolve('@phosphorco/bb-markdown'+entry)));
console.log(JSON.stringify({sdk:'0.6.52',recognition:'0.4.1',entries:resolution,proof:'packed imports/base/sanitized tree/gate; no host navigation or delivery'}));
`);
 writeFileSync(join(consumer,'probe.tsx'),`
import type {BbPluginApi} from '@get-bb/plugin-sdk';
import {Markdown,MarkdownProvider} from '@phosphorco/bb-markdown/react';
import {registerMarkdown} from '@phosphorco/bb-markdown/bb';
import type {MarkdownSource} from '@phosphorco/bb-markdown';
declare const bb:BbPluginApi;
registerMarkdown(bb,{consumer:{pluginId:'packed'}});
const source:MarkdownSource={kind:'detached',producer:'packed',sourceKey:'one',revision:'r1',origin:'unknown'};
const view=<MarkdownProvider><Markdown source={source} intent="prose" content="hello" /></MarkdownProvider>;
// @ts-expect-error every ordinary prose leaf requires a source
const unsafe=<Markdown intent="prose" content="hello" />;
// @ts-expect-error callers cannot select arbitrary literal bypass reasons
const bypass=<Markdown source={source} intent="literal" content="hello" />;
void [view,unsafe,bypass];
`);
 run(process.execPath,['node_modules/typescript/bin/tsc','--noEmit','--strict','--skipLibCheck','--module','NodeNext','--moduleResolution','NodeNext','--jsx','react-jsx','--target','ES2023','probe.tsx'],consumer);
 const nodeImportPattern=/(?:\bfrom|\bimport|\brequire|\b__require)\s*(?:\(\s*)?['"]node:/u;
 assert.ok(nodeImportPattern.test("import 'node:fs'"));assert.ok(nodeImportPattern.test('const x=__require("node:path")'));
 const browserEntry=join(consumer,'browser.ts');writeFileSync(browserEntry,"export {Markdown,MarkdownProvider} from '@phosphorco/bb-markdown/react';\n");
 const browserProof=JSON.parse(run(bun,['-e',`const r=await Bun.build({entrypoints:[${JSON.stringify(browserEntry)}],target:'browser',format:'esm',sourcemap:'external',external:['react','react/*','react-dom','react-dom/*','@get-bb/plugin-sdk','@get-bb/plugin-sdk/*'],define:{'process.env.NODE_ENV':'"production"'}});if(!r.success)throw new AggregateError(r.logs);const map=JSON.parse(await r.outputs.find(o=>o.path.endsWith('.map')).text());const text=await r.outputs.find(o=>o.path.endsWith('.js')).text();console.log(JSON.stringify({sources:map.sources,hasNodeImport:new RegExp(${JSON.stringify(nodeImportPattern.source)},'u').test(text)}));`],consumer));
 assert.equal(browserProof.hasNodeImport,false);for(const source of browserProof.sources)assert.ok(!/(?:bb-markdown\/dist\/(?:server|bb|testing-source-gate)\.js|node_modules\/(?:unified|remark-|rehype-|typescript)\b)/u.test(source),`Eager browser server/parser dependency: ${source}`);
 const runtime=run(process.execPath,['probe.mjs'],consumer).trim();
 // Execute the existing emitted server conformance matrix from the packed public entries.
 const tests=readFileSync(join(root,'test/server.test.mjs'),'utf8').replaceAll("'../dist/server.js'","'@phosphorco/bb-markdown/server'").replaceAll("'../dist/index.js'","'@phosphorco/bb-markdown'");
 writeFileSync(join(consumer,'server.test.mjs'),tests);
 const conformance=run(process.execPath,['--test','--test-reporter=dot','server.test.mjs'],consumer).trim();
 const installed=join(consumer,'node_modules/@phosphorco/bb-markdown');
 const emissions={};for(const name of ['index.js','server.js','bb.js','react.js','testing-source-gate.js']){const bytes=readFileSync(join(installed,'dist',name));assert.equal(sha(bytes),sha(readFileSync(join(root,'dist',name))));emissions[name]=sha(bytes);}
 const receipt={toolSha256:sha(readFileSync(fileURLToPath(import.meta.url))),proof:'packed-registry-peer-consumer',version:manifest.version,tarballSha256:sha(readFileSync(join(scratch,packed.filename))),integrity:packed.integrity,files:packed.files.map(f=>f.path),emissions,browserClosure:{inputs:browserProof.sources.length,noServerParserNode:true},runtime:JSON.parse(runtime),types:'actual registry SDK0.6.52 registration + React source/intent',serverConformance:conformance,limits:'Disposable tarball consumer, not registry publication, canonical install, actual host navigation, or runtime adoption.'};
 if(process.env.BB_MARKDOWN_PACK_RECEIPT)writeFileSync(resolve(process.env.BB_MARKDOWN_PACK_RECEIPT),JSON.stringify(receipt,null,2)+'\n');
 console.log(JSON.stringify(receipt,null,2));
}finally{rmSync(scratch,{recursive:true,force:true});}
