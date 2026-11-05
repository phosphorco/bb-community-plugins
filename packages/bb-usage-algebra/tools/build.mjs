for (const entry of ['index','vector']) {
  const result = await Bun.build({entrypoints:[`src/${entry}.ts`],outdir:'dist',target:'browser',format:'esm',external:['zod']});
  if (!result.success) throw new Error(result.logs.map(String).join('\n'));
}
console.log(`Bun ${Bun.version}: emitted root and seed-free vector entries`);
