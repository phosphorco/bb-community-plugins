import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPublic } from './public-entry.mjs';
import { descriptor, provider, catalog } from './fixtures.mjs';
// SDK testing/app uses TestProviderModelPicker. These exercise actual production
// controls, and do not prove real picker storage effects (separate host slot).
export async function mount(choice, extra={}) {
  const api=await loadPublic('./react');
  const {JSDOM}=await import('jsdom');const dom=new JSDOM('<div id="root"></div>',{url:'http://test-only.invalid'});
  const previous=new Map();for(const key of ['window','document','navigator','HTMLElement','MutationObserver','IS_REACT_ACT_ENVIRONMENT']){previous.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,writable:true,value:key==='IS_REACT_ACT_ENVIRONMENT'?true:dom.window[key]});}
  const React=await import('react'),{createRoot}=await import('react-dom/client'),{installTestPluginRuntime}=await import('@get-bb/plugin-sdk/testing/app');
  installTestPluginRuntime();
  const calls=[],read={version:1,role:'expert',stored:{status:'valid-shape',choice,staticIssues:[]},fingerprint:'f'.repeat(64),ownedFieldsDigest:null,eligibility:{status:'unverified'},ownedFieldsPresent:[],rule:'inherits caller',destinationRoute:null,destinationPreview:false};
  const client={pluginId:'b',async read(){calls.push('read:b');return read},async validate(){calls.push('validate:b');return extra.validation??{shapeIssues:[],eligibility:{status:'deferred',reason:'invocation'}}},async save(){calls.push('save:b');throw new Error('unexpected save')}};
  const catalogSdk={providers:{async list(){calls.push('providers.list');return[provider()]},async models(){calls.push('providers.models');return catalog()}}};
  const root=createRoot(dom.window.document.querySelector('#root'));
  await React.act(async()=>{root.render(React.createElement(api.RoleSettingsEditor,{client,role:descriptor(),catalogSdk,sampleRoute:{kind:'host',hostId:'h'},...extra}));});
  async function click(text){const b=[...dom.window.document.querySelectorAll('button')].find(b=>text.test(b.textContent?.trim()??''));assert.ok(b,`Missing production control ${text}`);await React.act(async()=>b.dispatchEvent(new dom.window.MouseEvent('click',{bubbles:true})));}
  async function dispose(){await React.act(async()=>root.unmount());dom.window.close();for(const[k,d]of previous){if(d)Object.defineProperty(globalThis,k,d);else delete globalThis[k]}}
  return{dom,calls,click,dispose};
}
test('mounted production row displays stored choice without catalog or picker/save',async()=>{
  const m=await mount({kind:'fields',fields:{model:'old-id'}});try{
    // Expanded display may issue Read; neither display nor Read browses a catalog.
    assert.equal(m.calls.some(c=>c.startsWith('providers.')),false);assert.equal(m.calls.includes('save:b'),false);
    assert.equal(m.dom.window.document.querySelector('[data-testid="bb-provider-model-picker"]'),null);
    assert.equal(m.calls.some(c=>c.endsWith(':a')),false);
  }finally{await m.dispose()}
});
test('deliberate Edit mounts SDK picker using explicit route and labelled browse seed, with no save intent',async()=>{
  const m=await mount({kind:'inherit'});try{
    await m.click(/^Edit$/i);
    assert.ok(m.calls.includes('validate:b'));
    const picker=m.dom.window.document.querySelector('[data-testid="bb-provider-model-picker"]');assert.ok(picker);
    assert.equal(picker.getAttribute('data-routing-kind'),'host');assert.equal(picker.getAttribute('data-routing-id'),'h');
    assert.equal(m.calls.includes('save:b'),false);
    const save=[...m.dom.window.document.querySelectorAll('button')].find(b=>/^Save$/i.test(b.textContent?.trim()??''));assert.ok(!save || save.disabled,'Browsing seed enabled Save');
  }finally{await m.dispose()}
});
