import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
function run(command,args){const r=spawnSync(command,args,{stdio:'inherit',timeout:300000});if(r.error)throw r.error;if(r.status!==0)process.exit(r.status??1);}
run('bun',['run','build']);
run('node',['--test',...readdirSync('test').filter(n=>n.endsWith('.test.mjs')).sort().map(n=>'test/'+n)]);
run('tsc',['--noEmit','--strict','--skipLibCheck','--target','ES2023','--module','NodeNext','--moduleResolution','NodeNext','test/public-types.mts']);
