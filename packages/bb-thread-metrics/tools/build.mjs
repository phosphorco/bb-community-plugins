const external = ['zod','@phosphorco/bb-usage-algebra/*','@get-bb/plugin-sdk','@get-bb/plugin-sdk/*'];
for (const entry of ['index','bb','testing']) {
 const result = await Bun.build({entrypoints:[`src/${entry}.ts`],outdir:'dist',target:'browser',format:'esm',external,
  plugins:[{name:'public-siblings',setup(build){build.onResolve({filter:/^\.\/(index|bb)\.js$/},args=>({path:args.path,external:true}));}}]});
 if (!result.success) throw new Error(result.logs.map(String).join('\n'));
}
