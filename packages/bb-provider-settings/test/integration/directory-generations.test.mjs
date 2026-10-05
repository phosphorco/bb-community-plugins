import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPublic } from './public-entry.mjs';
import { descriptor } from './fixtures.mjs';
test('mounted production Directory cancels prior read generation and drops late owner description',async()=>{
  const api=await loadPublic('./react'),{JSDOM}=await import('jsdom'),React=await import('react'),{createRoot}=await import('react-dom/client');
  const dom=new JSDOM('<div id="root"></div>',{url:'http://test-only.invalid'}),previous=new Map();
  for(const key of ['window','document','navigator','HTMLElement','MutationObserver','IS_REACT_ACT_ENVIRONMENT']){previous.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,writable:true,value:key==='IS_REACT_ACT_ENVIRONMENT'?true:dom.window[key]});}
  const pending=[],calls=[];
  const sdk={plugins:{async list(){calls.push('list');return{plugins:[{id:'b',name:'B',status:'running'}]}},callRpc(args){calls.push(args);assert.equal(args.pluginId,'b');assert.equal(args.method,'providerSettingsDescribe');return new Promise(resolve=>pending.push({args,resolve}));}},providers:{async list(){throw Error('Directory loaded catalogs on discovery')},async models(){throw Error('Directory loaded models on discovery')}}};
  const root=createRoot(dom.window.document.querySelector('#root'));
  try {
    await React.act(async()=>root.render(React.createElement(api.ProviderSettingsDirectory,{sdk,reconnectKey:0})));
    assert.equal(pending.length,1);
    await React.act(async()=>root.render(React.createElement(api.ProviderSettingsDirectory,{sdk,reconnectKey:1})));
    assert.equal(pending.length,2);
    assert.equal(pending[0].args.signal?.aborted,true);
    const response=label=>({protocol:'bb-provider-settings',versions:[1],roles:[descriptor({label})]});
    await React.act(async()=>pending[1].resolve(response('Fresh role')));
    assert.match(dom.window.document.body.textContent,/Fresh role/);
    await React.act(async()=>pending[0].resolve(response('Stale role')));
    assert.match(dom.window.document.body.textContent,/Fresh role/);
    assert.doesNotMatch(dom.window.document.body.textContent,/Stale role/);
    assert.equal(calls.filter(c=>c==='list').length,2);
  }finally{
    await React.act(async()=>root.unmount());dom.window.close();for(const[key,d]of previous){if(d)Object.defineProperty(globalThis,key,d);else delete globalThis[key];}
  }
});
