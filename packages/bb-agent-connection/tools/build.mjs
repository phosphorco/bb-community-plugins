const entries = ['index', 'client', 'bb', 'react', 'testing'];
for (const entry of entries) {
  const result = await Bun.build({entrypoints:[`src/${entry}.${entry === 'react' ? 'tsx' : 'ts'}`], outdir:'dist', target:'browser', format:'esm', jsx:{runtime:'automatic',development:false}, define:{'process.env.NODE_ENV':'"production"'}, external:['zod','@phosphorco/bb-identity/*','@get-bb/plugin-sdk','@get-bb/plugin-sdk/*','react','react/*','react-dom','react-dom/*'], plugins:[{name:'public-siblings',setup(build){build.onResolve({filter:/^\.\/(index|client|bb|react)\.js$/},args=>({path:args.path,external:true}));}}]});
  if (!result.success) throw new Error(result.logs.map(String).join('\n'));
}
console.log(`Bun ${Bun.version}: emitted 5 public entries`);
