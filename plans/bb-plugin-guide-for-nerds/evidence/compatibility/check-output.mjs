import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
const root = path.dirname(new URL(import.meta.url).pathname);
const marker = 'GUIDE_COMPAT_LAZY_PAYLOAD_68749';
const flatRoot = path.join(root, 'output-044');
const flat = fs.readFileSync(path.join(flatRoot, 'app.js'), 'utf8');
assert.equal(JSON.parse(fs.readFileSync(path.join(flatRoot, 'app.meta.json'))).artifactFormatVersion, 1);
assert(flat.includes(marker));
assert(!/import\s*\(/.test(flat));
assert(flat.includes('globalThis.__bbPluginRuntime'));
const forkRoot = path.join(root, 'output-fork');
const meta = JSON.parse(fs.readFileSync(path.join(forkRoot, 'app.meta.json')));
assert.equal(meta.artifactFormatVersion, 2);
const base = path.join(forkRoot, '.bb-artifacts', meta.appArtifact.generation);
const urlBase = `/api/v1/plugins/${meta.pluginId}/assets/g/${meta.appArtifact.generation}/`;
const names = new Set(meta.appArtifact.files.map(f => f.path));
for (const file of meta.appArtifact.files) {
  const data = fs.readFileSync(path.join(base,file.path));
  assert.equal(data.length, file.bytes);
  assert.equal(crypto.createHash('sha256').update(data).digest('hex'), file.sha256);
}
const staticClosure = new Set();
const dynamicImports = new Set();
function visit(name) {
  if (staticClosure.has(name)) return;
  staticClosure.add(name);
  const source = fs.readFileSync(path.join(base,name),'utf8');
  const imports = [...source.matchAll(/(?:from\s*|import\s*(\()?\s*)["']([^"']+)["']/g)];
  for (const match of imports) {
    const spec = match[2];
    assert(spec.startsWith(urlBase), `unexpected import ${spec}`);
    const relative = spec.slice(urlBase.length);
    assert(names.has(relative), `missing ${relative}`);
    if (match[1]) dynamicImports.add(relative); else visit(relative);
  }
}
visit('app.js');
assert(dynamicImports.size > 0);
for (const name of staticClosure) assert(!fs.readFileSync(path.join(base,name),'utf8').includes(marker), `eager marker in ${name}`);
assert([...dynamicImports].some(name => fs.readFileSync(path.join(base,name),'utf8').includes(marker)));
const result = {
  flat: { format:1, appBytes:Buffer.byteLength(flat), lazyPayloadInInitialTransfer:true, imports:[] },
  fork: { format:2, generation:meta.appArtifact.generation, staticClosure:[...staticClosure], staticBytes:[...staticClosure].reduce((sum,name)=>sum+fs.statSync(path.join(base,name)).size,0), dynamicImports:[...dynamicImports], files:meta.appArtifact.files },
  runtimeObserved:false
};
fs.writeFileSync(path.join(root,'output-contract.json'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result,null,2));
