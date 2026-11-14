const result = await Bun.build({entrypoints:['src/protocol.ts','src/bb.ts','src/testing.ts'],outdir:'dist',target:'browser',format:'esm',external:['zod'],plugins:[{name:'public-siblings',setup(build){build.onResolve({filter:/^\.\/(protocol|bb)\.js$/},args=>({path:args.path,external:true}));}}]});
if (!result.success) throw new Error(result.logs.map(String).join('\n'));
console.log(`Bun ${Bun.version}: ${result.outputs.length} public entries`);
