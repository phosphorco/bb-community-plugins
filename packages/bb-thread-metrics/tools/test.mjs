import { spawnSync } from 'node:child_process';

function run(command,args,cwd){
 const result=spawnSync(command,args,{stdio:'inherit',timeout:300000,...(cwd?{cwd}:{})});
 if(result.error)throw result.error;
 if(result.status!==0)process.exit(result.status??1);
}

run('bun',['run','build']);
run('bun',['test','test']);
run('tsc',['-p','tsconfig.public-tests.json','--noEmit']);
