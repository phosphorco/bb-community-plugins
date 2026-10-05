// ./testing must stay DOM-free: neither its emitted import graph nor loading it
// may pull in react, react-dom, jsdom or the SDK's DOM test runtime.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { publicTarget } from '../integration/public-entry.mjs';

const DOM = /^(react|react-dom|jsdom|@testing-library\/[^/]+|@get-bb\/plugin-sdk\/testing\/app)(\/|$)/;
function imports(target, seen = new Set()) {
  const file = fileURLToPath(target);
  if (seen.has(file)) return [];
  seen.add(file);
  const found = [];
  const walk = node => {
    const spec = (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text
      : ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && ts.isStringLiteral(node.arguments[0]) ? node.arguments[0].text : null;
    if (spec) { found.push(spec); if (spec.startsWith('.')) found.push(...imports(new URL(spec, target), seen)); }
    ts.forEachChild(node, walk);
  };
  walk(ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS));
  return found;
}

test('DOM-free ./testing: the emitted import graph has no DOM or React dependency', () => {
  const graph = imports(publicTarget('./testing'));
  assert.deepEqual(graph.filter(s => DOM.test(s)), []);
  assert.ok(graph.includes('./bb.js') && graph.includes('./index.js'), 'the kit should import the public entries, not inline a copy');
  assert.ok(imports(publicTarget('./testing/react')).some(s => DOM.test(s)), 'sanity: ./testing/react does use the DOM peers');
});

test('DOM-free ./testing: it loads and runs without any DOM globals', async () => {
  assert.equal(typeof globalThis.document, 'undefined');
  const kit = await import(publicTarget('./testing'));
  const catalog = kit.createFakeCatalog();
  assert.equal((await catalog.sdk.providers.list({})).length, 1);
  assert.equal(typeof globalThis.document, 'undefined');
  assert.equal(typeof globalThis.window, 'undefined');
});
