import {readFileSync} from 'node:fs';
import {basename,dirname,resolve} from 'node:path';

// Explicit entries and externals keep the published graph auditable. Public
// sibling imports remain external in every entry so runtime copies are shared.
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
if (!entrypoints.length || targets.length !== entrypoints.length || new Set(targets).size !== 1) {
  throw Error('Explicit entrypoints with a common target required');
}

const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
const stem = path => basename(path).replace(/\.[^.]+$/, '');
const sources = new Map(Object.entries(manifest.exports).flatMap(([key, target]) => entrypoints
  .filter(entry => stem(entry) === stem(target.import)).map(entry => [resolve(entry).replace(/\.[^.]+$/, ''), key])));
const siblingImports = {name: 'public-sibling-entries', setup(build) {
  build.onResolve({filter: /^\.\/[^/]+\.js$/}, args => {
    const importer = sources.get(args.importer.replace(/\.[^.]+$/, ''));
    const target = sources.get(resolve(dirname(args.importer), args.path).replace(/\.js$/, ''));
    return importer && target && importer !== target ? {path: args.path, external: true} : undefined;
  });
}};
const options = {
  outdir: 'dist', target: targets[0], format: 'esm', minify: false,
  jsx: {runtime: 'automatic', development: false},
  define: {'process.env.NODE_ENV': JSON.stringify('production')}, external
};
const result = await Bun.build({...options, entrypoints, plugins: [siblingImports]});
if (!result.success) throw Error(result.logs.map(String).join('\n'));
console.log(`Bun ${Bun.version} at ${process.execPath}`);
console.log(`Production ESM entries emitted without bundling peers: ${result.outputs.length}`);
