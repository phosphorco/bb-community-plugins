import {readFileSync} from 'node:fs';
import {basename,dirname,resolve} from 'node:path';
// Generator supplies public sources/targets/externals. No source aliases or peer bundling.
const entrypoints = [], external = [], targets = [];
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 2) {
 const value = args[i + 1];
 if (!value) throw Error(`Missing value for ${args[i]}`);
 if (args[i] === '--entry') entrypoints.push(value);
 else if (args[i] === '--external') external.push(value);
 else if (args[i] === '--target') targets.push(value);
 else throw Error(`Unknown build argument ${args[i]}`);
}
if (!entrypoints.length || targets.length !== entrypoints.length || new Set(targets).size !== 1) throw Error('Explicit entrypoints with a common target required');
// Testing-kit entries import sibling public entries (./index.js, ./bb.js, ...)
// as externals. dist mirrors the src stems, so a consumer's kit and production
// imports share one module instance instead of an inlined copy.
const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
const stem = path => basename(path).replace(/\.[^.]+$/, '');
const sources = new Map(Object.entries(manifest.exports).filter(([, target]) => typeof target === "object" && target.import).flatMap(([key, target]) => entrypoints
 .filter(entry => stem(entry) === stem(target.import)).map(entry => [resolve(entry).replace(/\.[^.]+$/, ''), key])));
const kitImports = { name: 'kit-sibling-entries', setup(build) {
 build.onResolve({ filter: /^\.\/[^/]+\.js$/ }, args => {
  const importer = sources.get(args.importer.replace(/\.[^.]+$/, ''));
  const target = sources.get(resolve(dirname(args.importer), args.path).replace(/\.js$/, ''));
  return importer?.startsWith('./testing') && target && target !== importer ? { path: args.path, external: true } : undefined;
 });
} };
const options = { outdir: 'dist', target: targets[0], format: 'esm',
 minify: false, jsx: { runtime: 'automatic', development: false },
 define: { 'process.env.NODE_ENV': JSON.stringify('production') }, external };
// Kit entries build separately so production entries are emitted exactly as before.
const isKit = entry => sources.get(resolve(entry).replace(/\.[^.]+$/, ''))?.startsWith('./testing');
const builds = [await Bun.build({ ...options, entrypoints: entrypoints.filter(e => !isKit(e)) })];
if (entrypoints.some(isKit)) builds.push(await Bun.build({ ...options, entrypoints: entrypoints.filter(isKit), plugins: [kitImports] }));
const result = { success: builds.every(b => b.success), logs: builds.flatMap(b => b.logs), outputs: builds.flatMap(b => b.outputs) };
if (!result.success) throw Error(result.logs.map(String).join('\n'));
console.log(`Bun ${Bun.version} at ${process.execPath}`);
console.log(`Production JSX emitted without minification: ${result.outputs.length} public entries`);
