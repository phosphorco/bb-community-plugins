import assert from 'node:assert/strict';
import {readFile,readdir,realpath,stat} from 'node:fs/promises';
import {resolve,dirname,relative} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {publicEntries,publicBuildOptions} from './build.mjs';
const pkg=fileURLToPath(new URL('../',import.meta.url));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function inventory(){
 const result=[];for(const name of (await readdir(resolve(pkg,'dist'),{recursive:true})).sort()){
  const file=resolve(pkg,'dist',name),s=await stat(file);if(s.isFile())result.push({name,sha256:hash(await readFile(file)),size:s.size,mtime:s.mtimeMs,ctime:s.ctimeMs});
 }return result;
}
/** Builds into memory only. No outdir/write option is passed to Bun. */
export async function checkLibrary({read=readFile,build=options=>Bun.build(options)}={}){
 const prior=process.cwd(),before=await inventory(),outputs=[];process.chdir(pkg);
 try{
  for(const [entry,name,target]of publicEntries){
   const options=publicBuildOptions(entry,name,target);
   assert.ok(!('outdir'in options)&&!('write'in options));
   const result=await build(options);assert.ok(result.success,result.logs?.map(String).join('\n'));
   const emitted=result.outputs.find(output=>output.path.endsWith('/'+name)||output.path===name);
   assert.ok(emitted,`Missing in-memory ${name}`);
   const expected=new Uint8Array(await emitted.arrayBuffer()),installed=await read(resolve(pkg,'dist',name));
   assert.equal(hash(installed),hash(expected),`Stale installed emission: ${name}; run the ordinary package build.`);
   outputs.push({entry,path:await realpath(resolve(pkg,'dist',name)),sha256:hash(installed)});
  }
  assert.deepEqual(await inventory(),before,'Freshness verification changed dist bytes or metadata.');
  return outputs;
 }finally{process.chdir(prior);}
}
if(import.meta.main){
 const outputs=await checkLibrary();
 for(const output of outputs)console.log(JSON.stringify({assertion:'fresh authoritative emission',...output}));
 const manifest=JSON.parse(await readFile(resolve(pkg,'package.json'),'utf8'));
 assert.equal(manifest.dependencies['@phosphorco/bb-context-recognition'],'0.4.1');
 for(const suffix of ['', '/bb']){
  const installed=await realpath(fileURLToPath(import.meta.resolve('@phosphorco/bb-context-recognition'+suffix,pathToFileURL(resolve(pkg,'dist/server.js')).href)));
  const root=dirname(dirname(installed)),m=JSON.parse(await readFile(resolve(root,'package.json'),'utf8'));
  assert.equal(m.version,'0.4.1');assert.equal(installed,await realpath(resolve(root,m.exports[suffix?'./bb':'.'].import)));
  console.log(JSON.stringify({assertion:'installed recognition public entry',version:m.version,specifier:'@phosphorco/bb-context-recognition'+suffix,path:installed,sha256:hash(await readFile(installed))}));
 }
 console.log('PASS: non-writing freshness; source-loader and production activation are separate checks');
}
