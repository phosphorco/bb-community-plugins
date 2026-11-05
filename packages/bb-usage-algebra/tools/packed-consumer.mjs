import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
// Scratch stays inside this new package; never installs or mutates parent deps.
const dir=mkdtempSync(resolve('.pack-proof-'));
function run(command,args,options={}) {const r=spawnSync(command,args,{encoding:'utf8',timeout:60000,...options});if(r.status!==0)throw new Error(`${command}: ${r.stderr}\n${r.stdout}`);return r.stdout;}
try {
  const result=JSON.parse(run('npm',['pack','--json','--ignore-scripts','--pack-destination',dir]))[0];
  const consumer=join(dir,'consumer');mkdirSync(consumer);
  const target=join(consumer,'node_modules','@phosphorco','bb-usage-algebra');mkdirSync(target,{recursive:true});
  run('tar',['-xzf',join(dir,result.filename),'-C',target,'--strip-components=1']);
  writeFileSync(join(consumer,'package.json'),'{"type":"module"}');
  writeFileSync(join(consumer,'proof.mjs'),`import assert from 'node:assert/strict';
import {UsageVectorSchema,zeroUsageVector} from '@phosphorco/bb-usage-algebra/vector';
import {price,DEFAULT_RATE_TABLE} from '@phosphorco/bb-usage-algebra';
assert.deepEqual(UsageVectorSchema.parse(zeroUsageVector()),{inputUncached:0,cacheRead:0,cacheWrite:0,output:0});
assert.equal(price(DEFAULT_RATE_TABLE,'codex','gpt-6.1-sol',zeroUsageVector()).amount,0);
`);
  writeFileSync(join(consumer,'proof.mts'),`import {type UsageVector, UsageVectorSchema} from '@phosphorco/bb-usage-algebra/vector';
import {price,DEFAULT_RATE_TABLE} from '@phosphorco/bb-usage-algebra';
const v:UsageVector=UsageVectorSchema.parse({});const n:number|null=price(DEFAULT_RATE_TABLE,'codex',null,v).amount;void n;
`);
  run(process.execPath,[join(consumer,'proof.mjs')]);
  run(process.execPath,[fileURLToPath(import.meta.resolve('typescript/bin/tsc')),'--noEmit','--strict','--skipLibCheck','--target','ES2023','--module','NodeNext','--moduleResolution','NodeNext',join(consumer,'proof.mts')]);
  console.log(`Packed consumer runtime + declarations passed: ${result.filename}; ${result.files.length} files`);
} finally {rmSync(dir,{recursive:true,force:true});}
