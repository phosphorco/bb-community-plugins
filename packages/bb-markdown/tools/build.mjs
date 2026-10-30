import { readFileSync } from 'node:fs';
// One set of ordinary build options also drives the non-writing freshness oracle.
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
export const publicEntries = [
  ['src/index.ts', 'index.js', 'browser'], ['src/server.ts', 'server.js', 'node'],
  ['src/bb.ts', 'bb.js', 'node'], ['src/react.tsx', 'react.js', 'browser'],
  ['src/source-gate.ts', 'testing-source-gate.js', 'node'],
];
export function publicBuildOptions(entry, name, target) {
  return { entrypoints:[entry], naming:name, target, format:'esm', minify:false, sourcemap:'external',
    external:[...Object.keys(manifest.dependencies),...Object.keys(manifest.peerDependencies),'@get-bb/plugin-sdk/*','react/*','react-dom/*','node:*'],
    jsx:{runtime:'automatic',development:false},define:{'process.env.NODE_ENV':JSON.stringify('production')},
    plugins:[{name:'public-data-entry',setup(build){build.onResolve({filter:/^\.\/(index|server)\.js$/},args=>args.importer.endsWith('/src/index.ts')?undefined:({path:args.path,external:true}));}}],
  };
}
if(import.meta.main){
  for(const [entry,name,target] of publicEntries){
    const result=await Bun.build({...publicBuildOptions(entry,name,target),outdir:'dist'});
    if(!result.success)throw new Error(result.logs.map(String).join('\n'));
  }
  console.log(`bb-markdown public runtime-separated ESM; Bun ${Bun.version}`);
}
