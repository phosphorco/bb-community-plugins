import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {RoleSettingsEditor} from '@phosphorco/bb-provider-settings/react';
import {roleDescriptorFixture as descriptor,providerFixture as provider,catalogFixture as catalog} from '@phosphorco/bb-provider-settings/testing';
import {mountEditor} from '@phosphorco/bb-provider-settings/testing/react';
// Plain-language explanations are derived from generic descriptor fields only.
// Each variant mounts the production editor; nothing here saves.
const h=React.createElement;
const read=(choice={kind:'inherit'},staticIssues=[])=>({version:1,role:'expert',stored:{status:'valid-shape',choice,staticIssues},fingerprint:'f',ownedFieldsDigest:null,ownedFieldsPresent:[],rule:'Uses the source defaults.',eligibility:{status:'unverified'},destinationRoute:null,destinationPreview:false});
const support3=(model,reasoning,alone=reasoning)=>({model,reasoningLevel:reasoning,reasoningWithoutModel:alone});
const D='demonstrated',U='unknown';
// A fixed-to-source role: reasoning shown on both paths for one provider, only one path
// for another, reasoning only together with a model for a third, and one blocked provider.
const fixedRole=descriptor({label:'Summary',choiceKinds:['inherit','by-provider'],providerPolicy:'fixed-to-source',capability:{evidence:'test-only',boundaries:['fork-child','create'],providers:{
  'alpha-agent':{perBoundary:{'fork-child':support3(U,D),create:support3(U,D)}},
  beta:{perBoundary:{'fork-child':support3(U,D),create:support3(U,U)}},
  delta:{perBoundary:{'fork-child':support3(D,D,U),create:support3(D,D,U)}},
  gamma:{blocked:['catalog-empty'],perBoundary:{}},
}}});
// Settlement waits on the actual pending owner and catalog promises, as the kit expects of a probe.
function tracker(){let pending=0;const all=new Set();return{get pending(){return pending},track(p){pending++;const q=p.finally(()=>{pending--;all.delete(q);});all.add(q);return p;},async settled(){await Promise.allSettled([...all]);}};}
async function mounted(role,choice,props={},owner={}){
  const calls=[],t=tracker(),job=(name,value)=>t.track((async()=>{calls.push(name);if(value instanceof Error)throw value;return value;})());
  const client={pluginId:'owner',read:()=>job('read',read(choice,owner.staticIssues)),validate:()=>job('validate',owner.validation??{shapeIssues:[],eligibility:{status:'deferred',reason:'invocation'}}),save:(_role,next)=>job('save',owner.save?owner.save(next):Error('explanations must not save'))};
  const catalogSdk={providers:{list:()=>job('providers.list',[provider('alpha-agent'),provider('delta')]),models:()=>job('providers.models',catalog())}};
  const editor=await mountEditor(h(RoleSettingsEditor,{client,role,catalogSdk,sampleRoute:{kind:'host',hostId:'h'},...props}),{probe:t});
  return{editor,calls,text:()=>editor.text().replace(/\s+/g,' ')};
}
function support(editor,providerLabel){
  const row=[...editor.document.querySelectorAll('.bbps-support tbody tr')].find(r=>r.querySelector('th').textContent===providerLabel);
  assert.ok(row,`no support row for ${providerLabel}`);
  const [model,reasoning]=[...row.querySelectorAll('td')];
  return{model:model.dataset.support,reasoning:reasoning.dataset.support,modelTitle:model.title,reasoningTitle:reasoning.title};
}
test('fixed-to-source role explains provider, paths and per-provider limits without internal terms',async()=>{
  const m=await mounted(fixedRole);try{
    const text=m.text();
    assert.match(text,/Always uses the same provider as the conversation it starts from\. You can override reasoning for Alpha Agent\. You can override reasoning together with the model for Delta\. You can override the model for Delta\./);
    assert.match(text,/Current: Inherit\(keeps the original conversation’s model and reasoning\)/);
    assert.match(text,/In a new conversation branched from an existing one and a brand-new conversation\./);
    assert.match(text,/Previewing never changes anything; only Save does/);
    assert.doesNotMatch(text,/fork-child|perBoundary|demonstrated|evidence|by-provider/);
    assert.deepEqual([support(m.editor,'Alpha Agent').model,support(m.editor,'Alpha Agent').reasoning],['unverified','available']);
    // Reasoning shown on only one of the two paths is not offered.
    assert.equal(support(m.editor,'Beta').reasoning,'unverified');
    assert.match(support(m.editor,'Beta').reasoningTitle,/when this role runs in a brand-new conversation/);
    const options=[...m.editor.document.querySelectorAll('select[aria-label="Provider entry"] option')].map(o=>o.textContent);
    assert.deepEqual(options,['Choose provider','Alpha Agent','Beta','Delta'],'a blocked provider without a saved override is not offered');
    assert.match(text,/No Alpha Agent override\. When the original conversation uses Alpha Agent, this role keeps its model and reasoning\./);
    assert.deepEqual(m.calls,['read'],'display loaded a catalog or saved');
  }finally{await m.editor.dispose();}
});
test('a blocked provider has no overrides but still inherits; its saved entry stays removable',async()=>{
  const m=await mounted(fixedRole,{kind:'by-provider',entries:{gamma:{reasoningLevel:'high'}}});try{
    const gamma=support(m.editor,'Gamma');
    assert.deepEqual([gamma.model,gamma.reasoning],['no-overrides','no-overrides']);
    assert.match(gamma.modelTitle,/^Overrides aren’t available for Gamma \(catalog empty\); without an override the role follows its inherited execution\.$/);
    assert.match(m.text(),/No overrides means this provider can’t carry overrides here; without one, the role follows its inherited execution\./);
    assert.doesNotMatch(m.text(),/can’t be used/);
    const options=[...m.editor.document.querySelectorAll('select[aria-label="Provider entry"] option')].map(o=>o.textContent);
    assert.ok(options.includes('Gamma (no overrides)'));
    await m.editor.select('Provider entry','gamma');
    await m.editor.click('Remove entry');
    assert.match(m.text(),/Draft: Inherit/);
    assert.equal(m.editor.button('Save').disabled,false);
    assert.equal(m.calls.includes('save'),false);
  }finally{await m.editor.dispose();}
});
test('a role whose providers are all blocked says no overrides are offered, not that they are unverified',async()=>{
  const role=descriptor({label:'Blocked',choiceKinds:['inherit','by-provider'],providerPolicy:'fixed-to-source',capability:{evidence:'test-only',boundaries:['fork-child'],providers:{
    gamma:{blocked:['catalog-empty'],perBoundary:{}},epsilon:{blocked:['no-source-permission'],perBoundary:{'fork-child':support3(D,D)}},
  }}});
  const m=await mounted(role);try{
    const text=m.text();
    assert.match(text,/Always uses the same provider as the conversation it starts from\. No model or reasoning overrides are offered; the role follows its inherited execution\./);
    assert.doesNotMatch(text,/verified yet/);
    assert.deepEqual([support(m.editor,'Epsilon').model,support(m.editor,'Epsilon').reasoning],['no-overrides','no-overrides']);
    assert.match(text,/Current: Inherit/);
  }finally{await m.editor.dispose();}
});
test('reasoning that needs a model override is explained as conditional, and unlocks with the model',async()=>{
  const m=await mounted(fixedRole);try{
    const delta=support(m.editor,'Delta');
    assert.deepEqual([delta.model,delta.reasoning],['available','with-model']);
    assert.equal(m.editor.document.querySelectorAll('.bbps-support td[data-support=with-model]')[0].textContent,'With a model override');
    await m.editor.select('Provider entry','delta');
    await m.editor.click('Edit');
    const reasoning=()=>m.editor.document.querySelector('select[aria-label="reasoningLevel"]').querySelector('option[value="set"]');
    assert.equal(reasoning().disabled,true);
    assert.match(m.text(),/Override the model too: changing Delta’s reasoning on its own hasn’t been shown to work, but together with a model override it has\./);
    await m.editor.select('model','set');
    assert.equal(reasoning().disabled,false,'reasoning stayed locked with a model override');
    assert.doesNotMatch(m.text(),/Override the model too/);
  }finally{await m.editor.dispose();}
});
test('fixed-to-source edit steps name why a field is off and keep preview separate from the draft',async()=>{
  const m=await mounted(fixedRole);try{
    await m.editor.click('Edit');
    let text=m.text();
    assert.match(text,/1Preview a model/);assert.match(text,/2Choose what to override/);assert.match(text,/3Review the draft below, then Save/);
    assert.match(text,/Browsing: alpha-agent\/exec-model on machine h\. Previewing doesn’t change anything\./);
    assert.match(text,/this role always uses the original conversation’s provider/);
    const model=m.editor.document.querySelector('select[aria-label="model"]');
    assert.equal(model.querySelector('option[value="set"]').disabled,true);
    assert.equal(model.querySelector('option[value="inherit"]').textContent,'Keep original');
    assert.match(text,/Not verified yet: overriding Alpha Agent’s model hasn’t been shown to work when this role runs in a new conversation branched from an existing one, so it’s turned off\./);
    const reasoning=m.editor.document.querySelector('select[aria-label="reasoningLevel"]');
    assert.equal(reasoning.querySelector('option[value="set"]').disabled,false);
    assert.equal(reasoning.querySelector('option[value="set"]').textContent,'Override: low');
    // A picker callback stays a preview. (The SDK test picker re-sends its seeded value,
    // so the label's live update is not observable here.)
    await m.editor.applyPicker({reasoningLevel:'medium'});
    text=m.text();
    assert.doesNotMatch(text,/Draft:/);
    assert.equal(m.editor.button('Save').disabled,true);
    await m.editor.select('reasoningLevel','set');
    text=m.text();
    assert.match(text,/Draft: Alpha Agent: original model · low/);
    assert.match(text,/Not saved yet\. Save applies it to: Used by the next invocation\./);
    assert.equal(m.editor.button('Save').disabled,false);
    assert.equal(m.calls.includes('save'),false);
  }finally{await m.editor.dispose();}
});
test('a saved override is described in user terms in the current value and provider summary',async()=>{
  const m=await mounted(fixedRole,{kind:'by-provider',entries:{'alpha-agent':{reasoningLevel:'medium'}}});try{
    const text=m.text();
    assert.match(text,/Current: Alpha Agent: original model · medium/);
    assert.match(text,/Alpha Agent override: model from the original conversation · reasoning medium/);
    assert.doesNotMatch(text,/\(keeps the original/);
  }finally{await m.editor.dispose();}
});
test('destination-checked tuple role separates custom-choice checks from Inherit',async()=>{
  const role=descriptor({label:'Reviewer',choiceKinds:['inherit','tuple'],providerPolicy:'any',saveValidation:'destination'});
  const m=await mounted(role);try{
    let text=m.text();
    assert.match(text,/Save one provider, model and reasoning for new runs, or inherit the default\./);
    assert.match(text,/Current: Inherit\(uses this role’s default\)/);
    assert.match(text,/Inherit means.*Uses the source defaults\./);
    assert.match(text,/A custom choice is checked against where this role runs before it’s saved; one that isn’t available there can’t be saved\. Inherit restores the default without choosing a model, so no model availability check is needed\./);
    assert.doesNotMatch(text,/Each time the role runs/);
    assert.match(text,/fixes the provider, model and reasoning together/);
    assert.equal(m.editor.document.querySelector('.bbps-support'),null,'a provider-agnostic role shows a support table');
    await m.editor.click('Edit');
    text=m.text();
    assert.match(text,/2Use it as the new choice/);
    assert.match(text,/Copies the preview into a draft\. Nothing is saved yet\./);
    assert.doesNotMatch(text,/always uses the original conversation’s provider/);
    await m.editor.click('Use this selection');
    assert.match(m.text(),/Draft: .*Not saved yet\./);
  }finally{await m.editor.dispose();}
});
test('invocation-checked field-cascade role explains run-time checks and inheritance from the caller',async()=>{
  const m=await mounted(descriptor({label:'Expert'}));try{
    let text=m.text();
    assert.match(text,/Override the provider, model or reasoning\. Anything left on Inherit follows the conversation that uses this role\./);
    assert.match(text,/Current: Inherit\(follows the conversation that uses this role\)/);
    assert.match(text,/replaces the value from the conversation using this role/);
    assert.match(text,/Each time the role runs, against where it actually runs\. Saving checks that the choice is well-formed and allowed for this role\. Check previews eligibility, but it isn’t a promise that the next run will accept the choice\./);
    assert.doesNotMatch(text,/before it’s saved/);
    await m.editor.click('Edit');
    const model=m.editor.document.querySelector('select[aria-label="model"]');
    assert.equal(model.querySelector('option[value="inherit"]').textContent,'Inherit');
    assert.equal(model.querySelector('option[value="set"]').textContent,'Override: exec-model');
    text=m.text();
    assert.match(text,/Only overridden fields are saved; the rest are inherited\./);
  }finally{await m.editor.dispose();}
});
test('without a route the preview names the default catalog, not a particular machine',async()=>{
  const m=await mounted(descriptor({label:'Expert'}),{kind:'inherit'},{sampleRoute:undefined});try{
    await m.editor.click('Edit');
    assert.match(m.text(),/Browsing: alpha-agent\/exec-model on the default catalog\./);
  }finally{await m.editor.dispose();}
});

test('a retained override the role no longer supports is explained in user terms and stays removable',async()=>{
  // Raw owner issues as an owner would report them; unrelated issues keep their text.
  const staticIssues=[{code:'field-not-offered',message:'alpha-agent fields lack evidence at fork-child'},{code:'catalog-unavailable',message:'Owner catalog note'}];
  const saved=[];
  const m=await mounted(fixedRole,{kind:'by-provider',entries:{'alpha-agent':{model:'old-model'}}},{},{
    staticIssues,
    validation:{shapeIssues:staticIssues.slice(0,1),eligibility:{status:'deferred',reason:'invocation'}},
    save:next=>{saved.push(next);return{outcome:'saved',read:read({kind:'inherit'}),eligibility:{status:'deferred',reason:'invocation'}};},
  });try{
    let text=m.text();
    assert.match(text,/Current: Alpha Agent: old-model · original reasoning/,'the retained choice is hidden');
    assert.match(text,/Not verified yet: overriding Alpha Agent’s model hasn’t been shown to work when this role runs in a new conversation branched from an existing one, so it’s turned off\. Remove the Alpha Agent override or choose Inherit\./);
    assert.match(text,/Owner catalog note/,'an unrelated issue lost its text');
    assert.match(text,/The saved value is kept until you replace or clear it\./);
    assert.doesNotMatch(text,/fork-child|lack evidence/);
    assert.ok(m.editor.button('Replace'),'invalid retained choice offers no Replace');
    await m.editor.click('Check');
    text=m.text();
    assert.doesNotMatch(text,/fork-child|lack evidence/,'validation issues show raw capability text');
    assert.match(text,/Remove the Alpha Agent override or choose Inherit\./);
    await m.editor.click('Inherit');
    await m.editor.click('Save');
    assert.deepEqual(saved,[{kind:'inherit'}]);
    assert.match(m.text(),/Current: Inherit/);
  }finally{await m.editor.dispose();}
});
