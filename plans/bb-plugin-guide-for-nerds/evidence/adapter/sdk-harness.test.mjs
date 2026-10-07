// PUBLIC SDK harness; never native-live proof.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const require=createRequire(new URL('../../../../package.json',import.meta.url));
const {JSDOM}=require('jsdom');const React=require('react');const {createPortal}=require('react-dom');
const dom=new JSDOM('<button id="footer">Guide</button><textarea id="composer">draft</textarea>',{url:'https://fixture.invalid/projects/p/threads/t'});
Object.assign(globalThis,{window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true});
const base=pathToFileURL(process.env.ADAPTER_SDK_PACKAGE+'/');
const sdk=await import(new URL('dist/app.js',base));
const harness=await import(new URL('dist/testing/app.js',base));
harness.installTestPluginRuntime();
test('public SDK .5.29 overlay registration and portal keep mock hook environment; local selection logs zero navigation',async()=>{
  let slot,selected='app-shell',boundSdk,context,nav,live;
  function Content(){boundSdk=sdk.useSdk();nav=sdk.useBbNavigate();context=sdk.useBbContext();live=sdk.useRealtimeConnectionState();const [page,setPage]=React.useState('app-shell');return React.createElement('button',{id:'local-page',onClick:()=>{selected='sidebar';setPage('sidebar');}},page);}
  function Overlay(){return createPortal(React.createElement(Content),document.body);}
  const app=await harness.loadPluginApp(sdk.definePluginApp(builder=>{
    builder.slots.experimental_appOverlay({id:'floating-guide',component:Overlay});
    builder.slots.sidebarFooterAction({id:'guide-toggle',title:'Guide',icon:'Puzzle',run:()=>{}});
  }));
  assert.equal(app.appOverlays.length,1);assert.equal(app.sidebarFooterActions.length,1);
  slot=harness.renderSlot(app.appOverlays[0],{},{pluginId:'plugin-guide-for-nerds',context:{projectId:'p',threadId:'t'}});
  assert.ok(boundSdk);assert.equal(typeof nav.toPluginPanel,'function');assert.deepEqual(context,{projectId:'p',threadId:'t'});assert.equal(live,'connected');
  await React.act(async()=>document.getElementById('local-page').click());assert.equal(selected,'sidebar');assert.equal(document.getElementById('local-page').textContent,'sidebar');
  assert.equal(slot.inspection.navigateCalls.length,0);assert.equal(document.getElementById('composer').value,'draft');assert.equal(window.location.pathname,'/projects/p/threads/t');
  slot.lifecycle.unmount();assert.equal(document.getElementById('local-page'),null);
});
