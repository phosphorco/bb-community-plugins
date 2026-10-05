import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { loadPublic, required } from './public-entry.mjs';
const override = (boundary, fields) => ({kind:'override', boundary, fields});
for (const [name, boundary] of [['projectSpawnOverride','spawn'],['projectFirstSendOverride','first-send']]) {
  test(`${name}: inherit emits neither fields nor provenance`, async () => {
    const project = required(await loadPublic(), name);
    for (const mode of ['explicit-map','omit-map']) assert.deepEqual(project({kind:'no-override'},mode),{});
  });
  test(`${name}: map keys equal emitted keys, omission is deliberate`, async () => {
    const project = required(await loadPublic(), name);
    for (const fields of [{model:'exec-model'}, {reasoningLevel:'medium'}, {model:'exec-model',reasoningLevel:'medium'}]) {
      assert.deepEqual(project(override(boundary,fields),'explicit-map'),{...fields,executionInputSources:Object.fromEntries(Object.keys(fields).map(k=>[k,'explicit']))});
      assert.deepEqual(project(override(boundary,fields),'omit-map'),fields);
    }
  });
  test(`${name}: the other native boundary is rejected`, async () => {
    const api = await loadPublic();
    assert.throws(()=>required(api,name)(override(boundary === 'spawn' ? 'first-send' : 'spawn',{model:'m'}),'explicit-map'), {name:'ProjectionBoundaryError'});
  });
}
test('first-send cannot switch provider or tier; fork receives no execution projection',async()=>{
  const project=required(await loadPublic(),'projectFirstSendOverride');
  for(const fields of [{providerId:'other',model:'m'},{serviceTier:'fast',model:'m'}]) assert.throws(()=>project(override('first-send',fields),'explicit-map'),{name:'ProjectionBoundaryError'});
});
test('spawn tuple emits exactly its four explicit fields',async()=>{
  const project=required(await loadPublic(),'projectSpawnOverride');
  const fields={providerId:'p',model:'m',reasoningLevel:'low',serviceTier:'default'};
  assert.deepEqual(project(override('spawn',fields),'explicit-map'),{...fields,executionInputSources:{providerId:'explicit',model:'explicit',reasoningLevel:'explicit',serviceTier:'explicit'}});
});
test('fingerprint covers raw ordered multi-key values including instructions, not decoded equivalence',async()=>{
  const fingerprint=required(await loadPublic(),'fingerprintValues');
  const raw=[' {"model":"m","additionalInstructions":"keep"} ','legacy'];
  assert.equal(await fingerprint(raw),createHash('sha256').update(JSON.stringify(raw)).digest('hex'));
  assert.notEqual(await fingerprint(raw),await fingerprint([raw[0].trim(),raw[1]]));
  assert.notEqual(await fingerprint(raw),await fingerprint([raw[0].replace('keep','edited'),raw[1]]));
  assert.notEqual(await fingerprint(raw),await fingerprint([raw[0],'']));
  assert.equal(await fingerprint(['']),createHash('sha256').update(JSON.stringify([''])).digest('hex')); // owner API defaults included, no physical absence claim
});
