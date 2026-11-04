for (const entry of ['index','bb','testing']) {
 const result = await Bun.build({entrypoints:[`src/${entry}.ts`],outdir:'dist',target:'browser',format:'esm',external:['zod','@get-bb/plugin-sdk','@get-bb/plugin-sdk/*',...['index','bb'].filter(e=>e!==entry).map(e=>`./${e}.js`)]});
 if (!result.success) throw new Error(result.logs.map(String).join('\n'));
}
