import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
function run(command,args,env={}){const r=spawnSync(command,args,{stdio:'inherit',env:{...process.env,...env},timeout:300000});if(r.error)throw r.error;if(r.status!==0)process.exit(r.status??1);}
run('bun',['run','build']);
const names=['public-api','semantics','owner-protocol','emitted-boundaries','mounted-controls','directory-generations'];
const units=readdirSync('test/unit').filter(n=>n.endsWith('.test.mjs')).map(n=>'test/unit/'+n);
run('node',['--test',...names.map(n=>'test/integration/'+n+'.test.mjs'),...units]);
run('bun',['test','test/integration/late-reconciliation.test.ts'],{RTL_SKIP_AUTO_CLEANUP:'true'});
// The /testing conformance kit: self-tests, negative self-tests, DOM-free isolation and emitted kit types.
const kit=readdirSync('test/testing').filter(n=>n.endsWith('.test.mjs')).sort().map(n=>'test/testing/'+n);
run('node',['--test',...kit]);
for(const types of ['test/integration/public-types.mts','test/testing/kit-types.mts'])run('tsc',['--noEmit','--strict','--skipLibCheck','--target','ES2022','--module','NodeNext','--moduleResolution','NodeNext',types]);
