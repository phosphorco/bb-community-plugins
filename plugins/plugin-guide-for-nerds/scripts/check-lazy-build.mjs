import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import ts from 'typescript';

const root = resolve(import.meta.dirname, '..');
const dist = resolve(process.argv[2] ?? join(root, 'dist'));
const meta = JSON.parse(readFileSync(join(dist, 'app.meta.json'), 'utf8'));
assert.equal(meta.pluginId, 'plugin-guide-for-nerds');
assert.equal(meta.artifactFormatVersion, 2, 'Lazy proof requires generation-serving format 2');
assert.equal(meta.sdkVersion, '0.5.29');
assert.match(meta.appArtifact.generation, /^[a-f0-9]{32}$/);
const generation = meta.appArtifact.generation;
const prefix = `/api/v1/plugins/plugin-guide-for-nerds/assets/g/${generation}/`;
const files = new Map();
for (const file of meta.appArtifact.files) {
  assert(!files.has(file.path), 'Duplicate manifest path');
  assert.match(file.path, /^(?:app\.(?:js|css)|chunks\/[A-Za-z0-9_-]+\.js)$/);
  const bytes = readFileSync(join(dist, '.bb-artifacts', generation, file.path));
  assert.equal(bytes.length, file.bytes, `Byte count: ${file.path}`);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256, `Hash: ${file.path}`);
  files.set(file.path, { ...file, source: bytes.toString('utf8'), static: [], dynamic: [] });
}
assert(files.has('app.js'));
const graphPath = (specifier, from) => {
  const url = new URL(specifier, 'http://proof.test' + prefix + from);
  assert.equal(url.origin, 'http://proof.test', 'Unexpected external module');
  assert(url.pathname.startsWith(prefix), 'Cross-plugin/generation module');
  assert.equal(url.search, '');
  const path = url.pathname.slice(prefix.length);
  assert(files.has(path), `Undeclared module: ${path}`);
  return path;
};
let retryImports = 0;
const directFactories = [];
for (const [path, file] of files) {
  if (!path.endsWith('.js')) continue;
  const ast = ts.createSourceFile(path, file.source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  assert.equal(ast.parseDiagnostics.length, 0);
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      assert(ts.isStringLiteral(node.moduleSpecifier));
      file.static.push(graphPath(node.moduleSpecifier.text, path));
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      assert.equal(node.arguments.length, 1);
      const argument = node.arguments[0];
      if (ts.isStringLiteral(argument)) {
        const target = graphPath(argument.text, path);
        file.dynamic.push(target);
        if (path === 'app.js' && ts.isArrowFunction(node.parent) && node.parent.body === node) {
          directFactories.push({ target, source: node.parent.getText(ast) });
        }
      } else {
        // The only variable import is the tested generation-scoped retry hook.
        assert.equal(path, 'app.js');
        assert(ts.isIdentifier(argument) && ts.isArrowFunction(node.parent));
        retryImports++;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
}
assert.equal(retryImports, 1);
assert.equal(directFactories.length, 1, 'Compiled literal content factory must remain reflectable');
const factory = directFactories[0];
assert.match(factory.target, /^chunks\/guide-content-[A-Za-z0-9_-]+\.js$/);
assert.match(factory.source, /\bimport\s*\(\s*"[^"]+"\s*\)/);
const closure = (start) => {
  const visited = new Set();
  const walk = (path) => { if (visited.has(path)) return; visited.add(path); files.get(path).static.forEach(walk); };
  walk(start);
  return visited;
};
const initial = closure('app.js');
const content = closure(factory.target);
assert(!initial.has(factory.target), 'Content was eagerly imported');
// Retrying the leaf is sound only when all its static dependencies were already
// loaded by the entry. Reject unproven transitive failure recovery.
for (const path of content) {
  assert(path === factory.target || initial.has(path), `Deferred dependency needs its own recovery: ${path}`);
}
const donor = readFileSync(join(root, 'src/surfaces.ts'), 'utf8');
const markers = [...donor.matchAll(/summary:\s*"([^"\n]{70,})"/g)]
  .map(match => match[1]).filter(value => /^[\x20-\x7e]+$/.test(value) && !value.includes('\\')).slice(0, 3);
assert.equal(markers.length, 3);
for (const marker of markers) {
  assert([...content].some(path => files.get(path).source.includes(marker)), 'Lost guide dataset');
  assert([...initial].every(path => !files.get(path).source.includes(marker)), 'Guide dataset in closed closure');
}
const receipt = {
  generation, sdkVersion: meta.sdkVersion, builtWith: meta.builtWith,
  manifestSha256: createHash('sha256').update(readFileSync(join(dist, 'app.meta.json'))).digest('hex'),
  initialStaticClosure: [...initial], initialJavaScriptBytes: [...initial].reduce((sum, path) => sum + files.get(path).bytes, 0),
  deferredContentClosure: [...content], contentEntry: factory.target, compiledFactory: factory.source,
  eagerCssBytes: files.get('app.css')?.bytes ?? 0,
  coverage: 'Manifest bytes/hashes and parsed import graph; native network/lifecycle proof is separate.',
};
writeFileSync(join(dist, 'lazy-build-proof.json'), JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify(receipt, null, 2));
