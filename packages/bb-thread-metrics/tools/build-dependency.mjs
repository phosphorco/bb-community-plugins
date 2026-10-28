import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// npm workspace builds run alphabetically. Build this declared source dependency
// before emitting metrics declarations; packed installs already ship its dist.
const algebraRoot=new URL('../../bb-usage-algebra/',import.meta.url);
if(existsSync(new URL('src/vector.ts',algebraRoot))&&existsSync(new URL('package.json',algebraRoot))){
 const dependency=JSON.parse(readFileSync(new URL('package.json',algebraRoot),'utf8'));
 const metrics=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8'));
 if(dependency.name!=='@phosphorco/bb-usage-algebra'||dependency.version!==metrics.dependencies[dependency.name])throw new Error('Local algebra must match the declared exact dependency');
 const result=spawnSync('bun',['run','build'],{cwd:fileURLToPath(algebraRoot),stdio:'inherit',timeout:300000});
 if(result.error)throw result.error;
 if(result.status!==0)process.exit(result.status??1);
}
