import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import * as root from '@phosphorco/bb-context-recognition';
import * as bb from '@phosphorco/bb-context-recognition/bb';
import * as kit from '@phosphorco/bb-context-recognition/testing';
const text=name=>readFileSync(new URL('../'+name,import.meta.url),'utf8');
function imports(source){return [...source.matchAll(/\b(?:from\s*|import\s*)["']([^"']+)["']/g)].map(m=>m[1]);}
test('all entries self-resolve with matching emitted declarations; optional SDK only, no DOM peer',()=>{
 const manifest=JSON.parse(text('package.json'));assert.equal(manifest.name,'@phosphorco/bb-context-recognition');assert.match(manifest.version,/^0\.1\.\d+$/);
 assert.deepEqual(Object.keys(manifest.exports),['.','./bb','./testing']);
 for(const entry of Object.values(manifest.exports))for(const path of [entry.import,entry.types])assert.ok(existsSync(new URL('../'+path,import.meta.url)),path);
 assert.equal(manifest.devDependencies.bun,'1.3.14');assert.equal(manifest.devDependencies['@get-bb/plugin-sdk'],'0.5.29');assert.equal(manifest.peerDependenciesMeta['@get-bb/plugin-sdk'].optional,true);
 assert.deepEqual(Object.keys(manifest.dependencies),['zod']);assert.deepEqual(Object.keys(manifest.peerDependencies),['@get-bb/plugin-sdk']);
 for(const name of ['LICENSE','PACKAGING.md','README.md','CONTRACT.md'])assert.ok(text(name).length>0);
 assert.equal(root.METHODS.describe,'contextRecognitionDescribe');assert.equal(typeof bb.enumerateRecognitionSuppliers,'function');assert.equal(typeof kit.runSupplierConformance,'function');
});
test('emitted module boundaries keep SDK types out of production and share sibling entries',()=>{
 assert.deepEqual(imports(text('dist/index.js')),['zod']);
 assert.deepEqual(imports(text('dist/bb.js')),['./index.js']);
 assert.deepEqual(new Set(imports(text('dist/testing.js'))),new Set(['@get-bb/plugin-sdk/testing','./bb.js','./index.js']));
 for(const name of ['index','bb','testing'])assert.doesNotMatch(text('dist/'+name+'.js'),/\buseRpc\b|experimental_discoverRpc|experimental_usePluginId|from ["'](?:react|react-dom|jsdom)(?:["'/])/);
});
test('raw shared JSON fixtures exactly equal public kit fixture values',()=>{
 for(const [file,value] of [['versions',kit.versionFixtures],['arbitration',kit.arbitrationFixtures],['worked-examples',kit.workedExamples]])assert.deepEqual(JSON.parse(text('fixtures/'+file+'.json')),value);
});
