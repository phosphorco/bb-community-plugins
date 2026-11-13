import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
const file=path=>readFileSync(new URL('../'+path,import.meta.url),'utf8');
test('emitted public entries keep SDK, React and sibling copies out of bundles',()=>{
  const manifest=JSON.parse(file('package.json'));assert.equal(manifest.version,'0.1.0-alpha.2');assert.deepEqual(Object.keys(manifest.dependencies),['zod']);
  assert.deepEqual(Object.keys(manifest.exports),['./protocol','./bb','./testing']);
  for(const target of Object.values(manifest.exports)){const js=file(target.import);assert(!/@get-bb|react|setInterval|setTimeout/.test(js));assert(file(target.types).length>0);}
  assert.match(file('dist/bb.js'),/from ["']\.\/protocol\.js["']/);assert.match(file('dist/testing.js'),/from ["']\.\/bb\.js["']/);
  assert(!file('dist/types/protocol.d.ts').includes('@get-bb'));
});
