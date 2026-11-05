import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { alice } from './backend-fixtures';

test('production SQLite driver under Node preserves definitions, personal state and exact receipt after close/reopen',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'templates-node-proof-'));
  try {
    const bundle=join(dir,'store.mjs');
    // A fresh build process cannot inherit other tests' module mocks/resolver state.
    execFileSync(process.execPath,['build',new URL('../store.ts',import.meta.url).pathname,'--target=node','--format=esm','--outfile='+bundle],{encoding:'utf8'});
    const source=`import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(${JSON.stringify(new URL('../../../package.json',import.meta.url).pathname)});
const Database=require('better-sqlite3');
const {TemplatesStore}=await import(${JSON.stringify(pathToFileURL(bundle).href)});
const path=${JSON.stringify(join(dir,'data.db'))};
let db=new Database(path);let store=new TemplatesStore(db);store.seed();
assert.equal(store.get('review-pr').published.revision,1);
const actor=${JSON.stringify(alice)};
const address={instanceId:'node-instance',pluginId:'new-thread-templates',collection:'input-drafts',recordId:'review-pr',owner:actor.identity.key};
let storage=store.personalStorage();const initial=await storage.read(address);assert.equal(initial.ok,true);
const mutation={kind:'initialize',address,expectedVersion:initial.value.version,expected:{actor:actor.identity.key,session:'node-session'},ownerSession:'node-owner-session',localGeneration:1,operationId:'node-operation',schemaVersion:1,value:{inputs:{pr_url:'https://example.com/pr/1'}}};
const saved=await storage.commit({mutation,validateAtCommit:()=>{assert.equal(db.inTransaction,true);return {ok:true,value:actor};}});assert.equal(saved.value.status,'saved');db.close();
db=new Database(path);store=new TemplatesStore(db);storage=store.personalStorage();
const replay=await storage.commit({mutation,validateAtCommit:()=>{throw new Error('receipt replay must precede commit validation');}});assert.deepEqual(replay,saved);
assert.equal((await storage.read(address)).value.envelope.value.inputs.pr_url,'https://example.com/pr/1');assert.equal(store.get('review-pr').published.revision,1);db.close();console.log('node-better-sqlite-reopen: passed');`;
    const script=join(dir,'proof.mjs');writeFileSync(script,source);
    expect(execFileSync('node',[script],{encoding:'utf8'})).toContain('node-better-sqlite-reopen: passed');
  }finally{rmSync(dir,{recursive:true,force:true});}
});
