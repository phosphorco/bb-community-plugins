import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import ts from 'typescript';
import { publicTarget } from './public-entry.mjs';
function graph(target,seen=new Set()){
  const file=fileURLToPath(target);if(seen.has(file))return[];seen.add(file);
  const source=ts.createSourceFile(file,readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.JS), found=[];
  function walk(node){
    if(ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if(node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        const spec=node.moduleSpecifier.text;found.push({kind:'import',value:spec});
        if(spec.startsWith('.'))found.push(...graph(new URL(spec,target),seen));
      }
    }
    if(ts.isIdentifier(node))found.push({kind:'identifier',value:node.text});
    ts.forEachChild(node,walk);
  }walk(source);return found;
}
test('generic emitted import graph has no React, SDK runtime or app registry',()=>{
  const nodes=graph(publicTarget());
  assert.equal(nodes.some(n=>n.kind==='import' && /^(react|react-dom|@get-bb\/plugin-sdk)(\/|$)/.test(n.value)),false);
  // WebCrypto may use globalThis.crypto; only a frontend protocol registry is forbidden.
  assert.equal(nodes.some(n=>n.kind==='identifier' && n.value==='EventTarget'),false);
});
