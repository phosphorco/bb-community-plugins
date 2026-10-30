import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (process.env.BB_NATIVE_ORACLE_BUNDLED !== '1') {
  test('materialized native host compatibility oracle', () => {
    execFileSync(process.execPath,[fileURLToPath(new URL('../tools/check-native.mjs',import.meta.url))],{stdio:'inherit'});
  });
} else {
  runNativeOracle().catch(error=>{console.error(error);process.exitCode=1;});
}
async function runNativeOracle() {
const { createElement, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { renderToStaticMarkup } = await import('react-dom/server');
const { JSDOM } = await import('jsdom');
const { MarkdownPreview } = await import('@native/preview');
const { buildMarkdownDocumentLinkRouting } = await import('@native/document');
const { buildMarkdownMessageLinkRouting } = await import('@native/message');
const { LazyMarkdownHtml } = await import('@native/html');
const { MarkdownLocalFileContextMenuContext } = await import('@native/context');
const { hostRoot, packageRoot, environmentSeams } = await import('@native/root');
const {NativeCodeBlock,NativeMath,NativeImage,safeCodeFence,safeMathSource}=await import('@native/technical');
const {MarkdownProvider,Markdown}=await import('@native/adapter');
const {createMarkdownOwner}=await import('@native/server');
const {createBrowserBbSdk}=await import('@native/browser-sdk');
const {registerRecognitionSupplier}=await import('@phosphorco/bb-context-recognition/bb');
const {METHODS}=await import('@phosphorco/bb-context-recognition');

const dom = new JSDOM('<!doctype html><html><body></body></html>', {url:'https://oracle.invalid'});
for (const key of ['window','document','navigator','HTMLElement','Element','Node','MutationObserver','getComputedStyle']) {
  Object.defineProperty(globalThis,key,{configurable:true,value:key==='getComputedStyle'?dom.window.getComputedStyle.bind(dom.window):dom.window[key]});
}
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
globalThis.ResizeObserver=class {observe(){} unobserve(){} disconnect(){}};
globalThis.requestAnimationFrame=fn=>setTimeout(fn,0);
globalThis.cancelAnimationFrame=id=>clearTimeout(id);
window.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});
globalThis.__nativeDelegated=[];
globalThis.__nativePublicFiles=[];globalThis.__nativePublicUrls=[];globalThis.__nativePublicActions=[];
const technicalOpens=[];
globalThis.__nativeTimeline={threadId:'thr_viewer',workspaceRootPath:'/viewer',onOpenLocalFileLink:x=>(technicalOpens.push(x),true)};
globalThis.__nativeNavigation={openUrl:x=>(technicalOpens.push(x),true),openFilePreview:x=>(technicalOpens.push(x),true)};
const sourceDocument={threadId:'thr_parent',rootPath:'/source',target:{kind:'workspace',environmentId:'env_parent',path:'message.md'}};
const link=path=>({path,lineRange:null,openTargetId:null});
function routing(document=sourceDocument) {
  const viewer=[],source=[];
  const messageRouting=buildMarkdownMessageLinkRouting({threadId:'thr_viewer',workspaceRootPath:'/viewer',onOpenLocalFileLink:x=>(viewer.push(x),true)});
  return {viewer,source,messageRouting,value:buildMarkdownDocumentLinkRouting({document,messageRouting,openFilePreview:x=>(source.push(x),true)})};
}
async function mount(content,linkRouting={},options={}) {
  const container=document.createElement('div');document.body.append(container);
  const root=createRoot(container);
  let element=options.element??createElement(MarkdownPreview,{content,allowHtml:true,linkRouting});
  if(options.contextMenu) element=createElement(MarkdownLocalFileContextMenuContext.Provider,{value:()=>[{id:'open',label:'Open file',onSelect:()=>{throw Error('Unsafe context action ran');}}]},element);
  if(options.guard) element=createElement('div',options.guard,element);
  await act(async()=>root.render(element));
  return {container,root, async close(){await act(async()=>root.unmount());container.remove();}};
}

test('actual host document routing uses source environment and records the unsafe fallback',()=>{
  const r=routing();
  assert.equal(r.value.localFile.relativeLinks.baseDir,'/source');
  r.value.localFile.onOpenLink(link('/source/docs/a.ts'));
  assert.deepEqual(r.source,[{target:{kind:'workspace',environmentId:'env_parent',path:'docs/a.ts'},location:null}]);
  assert.equal(r.viewer.length,0);
  r.value.localFile.onOpenLink(link('/outside/a.ts'));
  assert.equal(r.viewer.length,1,'actual host falls back to viewer outside the root; server must prevent this');
  for(const document of [{},null,{...sourceDocument,target:{kind:'host',hostId:'host_foreign',path:'a'}}]) {
    assert.deepEqual(routing(document).value,{},'explicit invalid document disables ambient file and image routing');
  }
});

test('generated technical code stays one native code block through the exact extracted SDK wrapper',async()=>{
  const payload='```\n[escape](file:///outside/secret.ts)\n`/outside/secret.ts`\n<img src="file:///outside/secret.png">\n@thread:thr_abcdefghjk\n````\n# forged heading';
  assert.equal(safeCodeFence(payload,'ts').split('\n')[0],'`````ts');
  globalThis.__nativeDelegated.length=0;technicalOpens.length=0;
  const view=await mount('',{}, {element:createElement(NativeCodeBlock,{value:payload,language:'ts'})});
  try {
    assert.equal(view.container.querySelectorAll('pre code').length,1);
    assert.equal(view.container.querySelector('pre code').textContent,payload);
    assert.equal(view.container.querySelector('a,img,h1,script'),null);
    assert.equal(globalThis.__nativeDelegated.length,1);
    assert.equal(globalThis.__nativeDelegated[0].content,safeCodeFence(payload,'ts'));
    assert.equal('experimental_document' in globalThis.__nativeDelegated[0],false);
    assert.equal(technicalOpens.length,0);
    const copy=view.container.querySelector('button[aria-label="Copy code"]');
    assert.ok(copy);await act(async()=>copy.click());assert.equal(globalThis.__nativeCopied,payload);
  } finally {await view.close();}
});

test('technical fence language injection and adversarial bounds fall back without SDK prose delegation',async()=>{
  assert.equal(safeCodeFence('x','ts\n```\n[attack](file:///outside)'), '```\nx\n```');
  assert.equal(safeCodeFence('`'.repeat(128),'ts').split('\n')[0].length,131);
  for(const value of ['`'.repeat(129),'x'.repeat(262_145)]) {
    assert.equal(safeCodeFence(value,'ts'),null);
    globalThis.__nativeDelegated.length=0;
    const view=await mount('',{}, {element:createElement(NativeCodeBlock,{value,language:'ts'})});
    try {assert.equal(view.container.querySelector('pre code').textContent,value);assert.equal(view.container.querySelector('a'),null);assert.equal(globalThis.__nativeDelegated.length,0);}
    finally {await view.close();}
  }
});

test('technical math delimiters cannot break into arbitrary prose; unsupported values never enter SDK',async()=>{
  assert.equal(safeMathSource('x^2',false),'$$x^2$$');
  assert.equal(safeMathSource('x^2\ny^2',true),'$$\nx^2\ny^2\n$$');
  for(const [value,display] of [['x$$\n[escape](file:///outside)\n$$',true],['x\u0000',true],['x\ny',false],['x'.repeat(65_537),true]]) {
    assert.equal(safeMathSource(value,display),null);
    globalThis.__nativeDelegated.length=0;
    const view=await mount('',{}, {element:createElement(NativeMath,{value,display})});
    try {assert.equal(view.container.querySelector('code').textContent,value);assert.equal(view.container.querySelector('a'),null);assert.equal(globalThis.__nativeDelegated.length,0);}
    finally {await view.close();}
  }
  globalThis.__nativeDelegated.length=0;
  const view=await mount('',{}, {element:createElement(NativeCodeBlock,{value:'$$\n[escape](file:///outside)',language:'math'})});
  try {assert.ok(view.container.querySelector('code[data-markdown-unsupported="math-delimiter"]'));assert.equal(globalThis.__nativeDelegated.length,0);}
  finally {await view.close();}
  // Server markup executes the actual host parser without running its lazy math effect.
  const markup=renderToStaticMarkup(createElement(NativeMath,{value:'x^2',display:false}));
  assert.match(markup,/language-math/);assert.doesNotMatch(markup,/<a\b/);
  assert.equal(globalThis.__nativeDelegated.at(-1).content,'$$x^2$$');
});

test('mixed source-safe tree: real owner/provider isolate unsafe code while explicit public link props stay source framed',async()=>{
  const sourceId='thr_23456789ab',targetId='thr_cdefghijkm';
  const href='https://example.test/a%2Fb?q=one%20two&x=2#part';
  const content=`**Formatted** [safe](docs/a.ts:7) \`/outside/a.ts\` [Exact *label*](${href}) @thread:${targetId}#msg=42\n\n<code>/outside/html.ts</code>`;
  const local={kind:'thread-message',instance:'local',threadId:sourceId,messageId:'42',revision:'mixed-v1'};
  const frames=[local,{kind:'detached',producer:'fixture',sourceKey:'same-message',revision:'mixed-v1',origin:'foreign'},{kind:'detached',producer:'fixture',sourceKey:'same-message',revision:'mixed-v1',origin:'unknown'},undefined];
  for(const source of frames) {
    const calls={threads:[],environments:[],phases:[],list:0};
    const owner=createMarkdownOwner({consumer:{pluginId:'native-oracle',surface:'mixed'},sdk:{
      threads:{async get({threadId}){calls.threads.push(threadId);return {id:threadId,projectId:threadId===sourceId?'proj_source':'proj_target',environmentId:'env_source',deletedAt:null,title:threadId===sourceId?'Source':'Referenced thread'};}},
      environments:{async get({environmentId}){calls.environments.push(environmentId);return {id:environmentId,projectId:'proj_source',path:'/source'};}},
      plugins:{async list(){calls.list++;return {plugins:[]};},async callRpc(){throw Error('No suppliers in mixed fixture');}},
    }});
    const transport={async prepare(input,signal){calls.phases.push(input.phase);return JSON.parse(JSON.stringify(await owner.prepare(input,signal)));}};
    globalThis.__nativeDelegated.length=0;globalThis.__nativePublicFiles.length=0;globalThis.__nativePublicUrls.length=0;globalThis.__nativePublicActions.length=0;technicalOpens.length=0;
    const view=await mount('',{}, {element:createElement(MarkdownProvider,{transport},createElement(Markdown,{source,intent:'prose',content}))});
    try {
      const ready=()=>source===local?[...view.container.querySelectorAll('a')].some(node=>node.getAttribute('href')===`/projects/proj_target/threads/${targetId}#msg=42`):calls.phases.includes('enrich')&&view.container.querySelector('[data-oracle-sdk="UrlLink"]');
      for(let attempt=0;source&&attempt<20&&!ready();attempt++)await act(async()=>new Promise(setImmediate));
      assert.equal(globalThis.__nativeDelegated.length,0,'ordinary prepared prose must never enter native SDK Markdown');
      if(!source) {
        assert.equal(view.container.querySelector('pre').textContent,content);assert.equal(view.container.querySelector('a'),null);assert.deepEqual(calls.phases,[]);
        continue;
      }
      assert.equal(view.container.querySelector('strong').textContent,'Formatted');
      for(const text of ['/outside/a.ts','/outside/html.ts']) {
        const code=[...view.container.querySelectorAll('code')].find(node=>node.textContent===text);
        assert.ok(code);assert.equal(code.closest('a'),null);assert.equal(code.getAttribute('href'),null);assert.equal(code.tabIndex,-1);assert.equal(code.draggable,false);
        for(const type of ['click','contextmenu','dragstart'])code.dispatchEvent(new window.MouseEvent(type,{bubbles:true,cancelable:true}));
        code.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
        assert.equal(document.querySelector('[role="menu"]'),null);
      }
      assert.deepEqual(globalThis.__nativePublicActions,[],'inert code did not trigger public link shims');
      const external=[...view.container.querySelectorAll('a')].find(node=>node.getAttribute('href')===href);
      assert.ok(external);assert.equal(external.textContent,'Exact label');assert.equal(external.querySelector('em').textContent,'label');
      external.focus();assert.equal(document.activeElement,external,'public link shim remains focusable');
      await act(async()=>external.click());assert.deepEqual(globalThis.__nativePublicActions.at(-1),{kind:'url',href});
      if(source===local) {
        const expected={kind:'workspace',environmentId:'env_source',path:'docs/a.ts'};
        assert.ok(globalThis.__nativePublicFiles.length);
        assert.ok(globalThis.__nativePublicFiles.every(props=>JSON.stringify(props.target)===JSON.stringify(expected)));
        const file=view.container.querySelector('[data-oracle-sdk="FileLink"]');assert.equal(file.textContent,'safe');
        await act(async()=>file.click());assert.deepEqual(globalThis.__nativePublicActions.at(-1),{kind:'file',target:expected,location:{kind:'range',startLine:7,endLine:7}});
        const thread=[...view.container.querySelectorAll('a')].find(node=>node.getAttribute('href')===`/projects/proj_target/threads/${targetId}#msg=42`);
        assert.ok(thread,JSON.stringify({calls,links:[...view.container.querySelectorAll('a')].map(node=>node.getAttribute('href')),text:view.container.querySelector('.bb-md')?.textContent}));assert.equal(thread.textContent,'Referenced thread');await act(async()=>thread.click());
        assert.deepEqual(calls.threads,[sourceId,targetId]);assert.deepEqual(calls.environments,['env_source']);
      } else {
        assert.equal(globalThis.__nativePublicFiles.length,0);assert.equal(view.container.querySelectorAll('a').length,1);assert.deepEqual(calls.threads,[]);assert.deepEqual(calls.environments,[]);
        assert.ok(view.container.textContent.includes(`@thread:${targetId}#msg=42`));
      }
      assert.equal(technicalOpens.length,0,'ambient viewer navigation hooks were never called');
      assert.deepEqual(calls.phases,['base','enrich']);
    } finally {await view.close();owner.dispose();}
  }
  console.log('Mixed-tree evidence uses actual createMarkdownOwner, JSON transport decoder, MarkdownProvider and Markdown. Public SDK FileLink/UrlLink are prop/action recording shims; actual host file/url component navigation and keyboard activation are not proven.');
});

test('verified local images use actual host source-environment URL mapping; hostile labels and foreign images cannot escape',async()=>{
  const sourceId='thr_23456789ab';
  const target={kind:'workspace',environmentId:'env_source',path:'assets/safe image[1].png'};
  const alt='x](file:///outside/a.ts) ![steal](https://evil.test/x) <script>bad()</script> & "quote"\\tail\n# heading';
  const title='title" onerror="bad()"><img src="https://evil.test/y">\nmore & text';
  globalThis.__nativeDelegated.length=0;
  const direct=await mount('',{}, {element:createElement(NativeImage,{target,document:{threadId:sourceId,rootPath:'/source'},alt,title})});
  try {
    const image=direct.container.querySelector('img');assert.ok(image);assert.equal(direct.container.querySelectorAll('img').length,1);
    assert.equal(image.alt,alt.replace(/[\r\n]/g,' '));assert.equal(image.title,title.replace(/[\r\n]/g,' '));
    assert.equal(direct.container.querySelector('a,script,h1,[onerror]'),null);
    assert.equal(image.getAttribute('src'),'/api/v1/environments/env_source/files/assets/safe%20image%5B1%5D.png');
    assert.equal(image.getAttribute('src').includes('viewer'),false);
    assert.equal(globalThis.__nativeDelegated.length,1);
    assert.deepEqual(globalThis.__nativeDelegated[0].experimental_document,{threadId:sourceId,rootPath:'/source',target});
    assert.ok(globalThis.__nativeDelegated[0].content.startsWith('!['));
  } finally {await direct.close();}
  for(const path of ['assets/hash#name.png','assets/query?name.png']) {
    globalThis.__nativeDelegated.length=0;
    const unsupported=await mount('',{}, {element:createElement(NativeImage,{target:{...target,path},document:{threadId:sourceId,rootPath:'/source'},alt:'Unsupported filename'})});
    try {assert.ok(!unsupported.container.querySelector('img'),'host-ambiguous #/? filenames must stay readable rather than load another path');assert.equal(unsupported.container.textContent,'Unsupported filename');assert.equal(globalThis.__nativeDelegated.length,0);}
    finally {await unsupported.close();}
  }
  const content='**Images** ![source image](assets/picture.png "Source title") ![unsafe](/outside/secret.png)';
  for(const foreign of [false,true]) {
    const source=foreign?{kind:'detached',producer:'fixture',sourceKey:'foreign-image',revision:'v1',origin:'foreign'}:{kind:'thread-message',instance:'local',threadId:sourceId,messageId:'42',revision:'image-v1'};
    const reads=[];
    const owner=createMarkdownOwner({consumer:{pluginId:'native-oracle',surface:'images'},sdk:{
      threads:{async get({threadId}){reads.push(threadId);return {id:threadId,projectId:'proj_source',environmentId:'env_source',deletedAt:null,title:'Source'};}},
      environments:{async get({environmentId}){reads.push(environmentId);return {id:environmentId,projectId:'proj_source',path:'/source'};}},
      plugins:{async list(){return {plugins:[]};},async callRpc(){throw Error('No suppliers in image fixture');}},
    }});
    const phases=[];const transport={async prepare(input,signal){phases.push(input.phase);return JSON.parse(JSON.stringify(await owner.prepare(input,signal)));}};
    globalThis.__nativeDelegated.length=0;technicalOpens.length=0;
    const view=await mount('',{}, {element:createElement(MarkdownProvider,{transport},createElement(Markdown,{source,intent:'prose',content}))});
    try {
      for(let attempt=0;attempt<20&&(!phases.includes('enrich')||!view.container.querySelector('strong'));attempt++)await act(async()=>new Promise(setImmediate));
      assert.equal(view.container.querySelector('strong').textContent,'Images');
      assert.ok(view.container.querySelector('.bb-md').textContent.includes('unsafe'));
      assert.equal(view.container.querySelector('a'),null);assert.equal(technicalOpens.length,0);
      if(foreign) {assert.equal(view.container.querySelector('img'),null);assert.equal(globalThis.__nativeDelegated.length,0);assert.deepEqual(reads,[]);}
      else {
        const image=view.container.querySelector('img');assert.ok(image);assert.equal(view.container.querySelectorAll('img').length,1);
        assert.equal(image.alt,'source image');assert.equal(image.title,'Source title');
        assert.equal(image.getAttribute('src'),'/api/v1/environments/env_source/files/assets/picture.png');
        assert.ok(!view.container.querySelector('p p,p div'),'prepared paragraphs must not wrap native block islands in invalid paragraph markup');
        assert.ok(globalThis.__nativeDelegated.length>0);
        for(const props of globalThis.__nativeDelegated)assert.deepEqual(props.experimental_document,{threadId:sourceId,rootPath:'/source',target:{kind:'workspace',environmentId:'env_source',path:'assets/picture.png'}});
      }
    } finally {await view.close();owner.dispose();}
  }
  console.log('Image witness mounts actual NativeImage -> extracted PluginMarkdown -> actual MarkdownPreview and document/file-content URL builders. DOM src mapping only; jsdom resource loading is disabled and no image fetch or lightbox behavior is claimed.');
});

test('inline math keeps prepared paragraph/strong ancestry valid and inherits only the standalone native cold markup',async()=>{
  // Hold only the actual loader import boundary; parser, hook and renderer remain host source.
  globalThis.__nativeHoldMath=true;
  const baseline=await mount('',{}, {element:createElement(NativeMath,{value:'x^2',display:false})});
  const nativeColdInvalid=baseline.container.querySelectorAll('p div').length;
  assert.ok(nativeColdInvalid>0,'record the existing host cold code fallback nesting rather than claim completed typesetting');
  await baseline.close();
  const owner=createMarkdownOwner({consumer:{pluginId:'native-oracle',surface:'math-shape'},sdk:{
    threads:{async get(){throw Error('Detached math cannot read local thread metadata');}},
    environments:{async get(){throw Error('Detached math cannot read local environment metadata');}},
    plugins:{async list(){return {plugins:[]};},async callRpc(){throw Error('No math suppliers');}},
  }});
  const phases=[];const transport={async prepare(input,signal){phases.push(input.phase);return JSON.parse(JSON.stringify(await owner.prepare(input,signal)));}};
  const source={kind:'detached',producer:'fixture',sourceKey:'math-shape',revision:'v1',origin:'unknown'};
  const content='Before **bold $$x^2$$** after.\n\nPlain paragraph.';
  globalThis.__nativeDelegated.length=0;
  const view=await mount('',{}, {element:createElement(MarkdownProvider,{transport},createElement(Markdown,{source,intent:'prose',content}))});
  try {
    for(let attempt=0;attempt<20&&(!phases.includes('enrich')||!view.container.querySelector('.bb-md-inline-native'));attempt++)await act(async()=>new Promise(setImmediate));
    const native=view.container.querySelector('.bb-md-inline-native');assert.ok(native);
    assert.ok(!native.parentElement.closest('p,strong,em,span,h1,h2,h3,h4,h5,h6'),'prepared phrasing ancestors must use valid flow containers around native islands');
    const paragraph=native.closest('.bb-md-p');assert.ok(paragraph);assert.equal(paragraph.getAttribute('role'),'paragraph');
    const strong=native.closest('.bb-md-strong');assert.ok(strong);assert.equal(strong.getAttribute('role'),'strong');assert.equal(strong.style.fontWeight,'600');
    assert.equal(view.container.querySelector('.bb-md > p').textContent,'Plain paragraph.');
    assert.equal(native.querySelectorAll('p div').length,nativeColdInvalid,'adapter adds no invalid p/div nesting beyond actual standalone cold host baseline');
    assert.ok(globalThis.__nativeDelegated.length>0);assert.ok(globalThis.__nativeDelegated.every(props=>props.content==='$$x^2$$'));
    assert.equal(view.container.querySelector('a'),null);
  } finally {await view.close();owner.dispose();delete globalThis.__nativeHoldMath;}
  console.log(`Math shape witness holds actual lazy import pending. Standalone native cold baseline has ${nativeColdInvalid} p/div nesting case(s); prepared ancestry adds zero. Completed KaTeX and browser layout remain unproved.`);
});

test('actual browser SDK callRpc validates HTTP envelope then executes supplied outputSchema.parse',async()=>{
  const requests=[];let mode='healthy',parses=0;
  const client=createBrowserBbSdk({baseUrl:'https://fixture.invalid',fetch:async(url,init)=>{
    assert.equal(new URL(url).origin,'https://fixture.invalid');
    requests.push({url:String(url),method:init.method,body:JSON.parse(init.body)});
    return new Response(JSON.stringify(mode==='healthy'?{ok:true,result:{value:7}}:{ok:false,result:{value:7}}),{status:200,headers:{'content-type':'application/json'}});
  }});
  const outputSchema={parse(value){parses++;assert.deepEqual(value,{value:7});return {decoded:value.value};}};
  const result=await client.plugins.callRpc({pluginId:'fixture supplier',method:'proof/v1',input:{message:'exact'},outputSchema});
  assert.deepEqual(result,{decoded:7});assert.equal(parses,1);
  assert.deepEqual(requests,[{url:'https://fixture.invalid/api/v1/plugins/fixture%20supplier/rpc/proof%2Fv1',method:'POST',body:{message:'exact'}}]);
  mode='bad-envelope';await assert.rejects(client.plugins.callRpc({pluginId:'fixture supplier',method:'proof/v1',input:null,outputSchema}));
  assert.equal(parses,1,'bad HTTP envelope must fail before outputSchema.parse');
  const source=readFileSync(`${hostRoot}/packages/sdk/src/areas/plugins.ts`,'utf8');
  assert.match(source,/return input\.outputSchema\.parse\(envelope\.result\)/);
});

test('actual browser SDK transports registered recognition 0.4.1 handlers and isolates malformed/identity/size siblings',async()=>{
  assert.equal(JSON.parse(readFileSync(`${packageRoot}/node_modules/@phosphorco/bb-context-recognition/package.json`,'utf8')).version,'0.4.1');
  const definitions=[['healthy','GOOD'],['malformed','BAD'],['wrong','WRONG'],['oversized','SIZE'],['absent','ABSENT']];
  const handlers=new Map(),calls=[];
  for(const [id,match] of definitions) {
    registerRecognitionSupplier({rpc:{register(_contract,registered){handlers.set(id,registered);}}},{revision:'transport-proof/1',
      linkify:{providers:[{provider:id,kinds:['issue'],specificity:'typed'}],handler(input){const start=input.text.indexOf(match);return {candidates:start<0?[]:[{span:{start,end:start+match.length},match,source:{provider:id,id:`${id}:1`,kind:'issue'},confidence:'high',provenance:{basis:'explicit',explanation:'Transport fixture explicit identity.'}}]};}},
      resolve:{providers:[{provider:id,kinds:['issue']}],handler(input){return {resolutions:input.sources.map(source=>({source,state:'ready',label:id==='healthy'?'Healthy label':'Rejected label',href:`https://example.test/${id}`,reasons:[]}))};}},
    });
  }
  const client=createBrowserBbSdk({baseUrl:'https://fixture.invalid',fetch:async(url,init)=>{
    const parsed=new URL(url);assert.equal(parsed.origin,'https://fixture.invalid');assert.equal(init.method,'POST');
    const match=parsed.pathname.match(/^\/api\/v1\/plugins\/([^/]+)\/rpc\/([^/]+)$/);assert.ok(match,'only in-memory RPC fixture paths are accepted');
    const id=decodeURIComponent(match[1]),method=decodeURIComponent(match[2]),input=JSON.parse(init.body);calls.push({id,method,input});
    if(id==='absent')return new Response(JSON.stringify({error:{code:'unknown_method',message:'Fixture has no recognition method'}}),{status:404,headers:{'content-type':'application/json'}});
    let result=await handlers.get(id)[method](input);
    if(method===METHODS.describe){result={...result,futureEnvelopeField:{ignored:true}};if(id==='malformed')result={...result,capabilities:{revision:42}};}
    if(method===METHODS.resolve&&id==='wrong')result={resolutions:result.resolutions.map(row=>({...row,source:{...row.source,id:'unrequested:identity'}}))};
    if(method===METHODS.resolve&&id==='oversized')result={resolutions:result.resolutions.map(row=>({...row,label:'x'.repeat(300_000)}))};
    return new Response(JSON.stringify({ok:true,result}),{status:200,headers:{'content-type':'application/json'}});
  }});
  let lists=0;
  const owner=createMarkdownOwner({consumer:{pluginId:'native-oracle',surface:'transport'},sdk:{
    threads:{async get(){throw Error('Detached transport fixture cannot read threads');}},environments:{async get(){throw Error('Detached transport fixture cannot read environments');}},
    plugins:{callRpc:client.plugins.callRpc,list:async()=>{lists++;return {plugins:definitions.map(([id])=>({id,name:id,status:'running'}))};}},
  }});
  try {
    const content='GOOD BAD WRONG SIZE ABSENT';
    const [model]=await owner.prepare({phase:'enrich',requests:[{source:{kind:'detached',producer:'fixture',sourceKey:'real-sdk-transport',revision:'v1',origin:'unknown'},intent:'prose',content}]});
    const nodes=[];const walk=node=>{nodes.push(node);node.children?.forEach(walk);};model.tree.children.forEach(walk);
    const links=nodes.filter(node=>node.kind==='element'&&node.tag==='a');
    assert.equal(links.length,1);assert.equal(links[0].href,'https://example.test/healthy');assert.equal(links[0].children.map(node=>node.value??'').join(''),'Healthy label');
    const text=nodes.filter(node=>node.kind==='text').map(node=>node.value).join('');for(const token of ['BAD','WRONG','SIZE','ABSENT'])assert.ok(text.includes(token));
    assert.equal(lists,1);
    for(const [id] of definitions)assert.ok(calls.some(call=>call.id===id&&call.method===METHODS.describe));
    for(const id of ['healthy','wrong','oversized'])assert.ok(calls.some(call=>call.id===id&&call.method===METHODS.resolve));
    assert.ok(!calls.some(call=>['malformed','absent'].includes(call.id)&&call.method===METHODS.resolve));
    assert.equal(model.original,content);assert.equal(model.format,'markdown');
    console.log('Transport proof executes actual createBrowserBbSdk/plugins.callRpc HTTP envelope and outputSchema parser with in-memory fetch only. Installed recognition0.4.1 registration/client/owner are real; plugins.list and metadata remain fixtures. Healthy additive describe survives malformed descriptor, unknown method, wrong identity and oversized response siblings. Existing cancellation/stale semantics remain covered by core/server/react matrix, not re-proven here.');
  } finally {owner.dispose();}
});

test('actual MarkdownPreview inline-code autolinks are source framed; {} disables them',async()=>{
  const r=routing();
  const view=await mount('Read `src/a.ts:7` and `/outside/a.ts`.',r.value);
  try {
    const a=view.container.querySelector('a');
    assert.equal(a.textContent,'src/a.ts:7');assert.equal(a.getAttribute('href'),'file:///source/src/a.ts#L7');
    await act(async()=>a.click());
    assert.equal(r.source[0].target.environmentId,'env_parent');
    assert.equal(r.source[0].location.startLine,7);
    assert.equal(view.container.querySelectorAll('a').length,2,'outside-root inline code is also autolinked by actual native renderer');
  } finally {await view.close();}
  const inert=await mount('Read `src/a.ts:7` and `/outside/a.ts`.',routing({}).value);
  try {assert.equal(inert.container.querySelectorAll('a').length,0);assert.equal(inert.container.querySelectorAll('code').length,2);}
  finally {await inert.close();}
});

test('actual native markup preserves exact URL/label, code bytes, basic semantics and DOM selection',async()=>{
  const url='https://example.test/a%2Fb?q=one%20two&x=2#part';
  const view=await mount(`# Heading\n\n[Exact *label*](${url})\n\n> Quote\n\n3. Three\n\n- [x] Done\n\n| A | B |\n| - | - |\n| x | y |\n\n\`\`\`ts\nconst html = "<script>bad()</script>";\n\`\`\``);
  try {
    assert.equal(view.container.querySelector('a').getAttribute('href'),url);
    assert.equal(view.container.querySelector('a').textContent,'Exact label');
    assert.equal(view.container.querySelector('h1').textContent,'Heading');
    assert.equal(view.container.querySelector('ol').start,3);
    assert.equal(view.container.querySelector('input').disabled,true);
    assert.ok(view.container.querySelector('table th'));
    assert.equal(view.container.querySelector('script'),null);
    assert.equal(view.container.querySelector('pre code').textContent,'const html = "<script>bad()</script>";');
    const copy=view.container.querySelector('button[aria-label="Copy code"]') ?? view.container.querySelector('button[aria-label="Copy to clipboard"]');
    assert.ok(copy,'real native code block exposes a named copy button');
    await act(async()=>copy.click());assert.equal(globalThis.__nativeCopied,'const html = "<script>bad()</script>";');
    const range=document.createRange();range.selectNodeContents(view.container.querySelector('pre code'));
    window.getSelection().removeAllRanges();window.getSelection().addRange(range);
    assert.equal(window.getSelection().toString(),'const html = "<script>bad()</script>";');
    assert.equal(view.container.querySelector('button a,a button'),null);
  } finally {await view.close();}
});

test('actual host HTML pipeline retains allowed HTML and strips script/event handlers',async()=>{
  await LazyMarkdownHtml.preload();
  const view=await mount('Readable\n\n<video controls src="https://example.test/a.mp4" onerror="bad()"></video><script>bad()</script>');
  try {assert.equal(view.container.querySelector('video').getAttribute('src'),'https://example.test/a.mp4');assert.equal(view.container.querySelector('script,[onerror]'),null);}
  finally {await view.close();}
});

test('actual host HTML code also autolinks; ancestor capture can stop native click dispatch',async()=>{
  await LazyMarkdownHtml.preload();
  const r=routing();
  const view=await mount('<code>/outside/a.ts</code> and `/outside/b.ts`.',r.value);
  try {
    const links=[...view.container.querySelectorAll('a')];
    assert.deepEqual(links.map(a=>a.getAttribute('href')),['file:///outside/a.ts','file:///outside/b.ts']);
    const blocked=[];
    const guard=event=>{if(event.target.closest('a')?.getAttribute('href')?.startsWith('file:')){blocked.push(event.type);event.preventDefault();event.stopPropagation();}};
    for(const type of ['click','auxclick','contextmenu','keydown']) view.container.addEventListener(type,guard,true);
    for(const type of ['click','auxclick','contextmenu']) {
      const event=new window.MouseEvent(type,{bubbles:true,cancelable:true});
      await act(async()=>links[0].dispatchEvent(event));
      assert.equal(event.defaultPrevented,true);
    }
    const key=new window.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true});
    links[0].dispatchEvent(key);assert.equal(key.defaultPrevented,true);
    assert.equal(r.viewer.length,0);assert.equal(r.source.length,0);
    assert.deepEqual(blocked,['click','auxclick','contextmenu','keydown']);
  } finally {await view.close();}
});

test('actual Radix native context-menu trigger: React capture blocks menu and touch long-press scheduling',async()=>{
  const blocked=[];
  const guard=event=>{if(event.target.closest('a')?.getAttribute('href')?.startsWith('file:')){blocked.push(event.type);event.preventDefault();event.stopPropagation();}};
  const r=routing();
  const view=await mount('`/outside/a.ts`',r.value,{contextMenu:true,guard:{onContextMenuCapture:guard,onPointerDownCapture:guard,onClickCapture:guard,onKeyDownCapture:guard}});
  const originalTimeout=window.setTimeout;
  let longPressTimers=0;
  window.setTimeout=function(callback,delay,...args){if(delay===700)longPressTimers++;return originalTimeout.call(this,callback,delay,...args);};
  try {
    const anchor=view.container.querySelector('a');
    assert.equal(anchor.getAttribute('data-state'),'closed','actual Radix ContextMenuTrigger mounted');
    for(const type of ['contextmenu','click']) await act(async()=>anchor.dispatchEvent(new window.MouseEvent(type,{bubbles:true,cancelable:true})));
    const pointer=new window.Event('pointerdown',{bubbles:true,cancelable:true});Object.defineProperty(pointer,'pointerType',{value:'touch'});
    await act(async()=>anchor.dispatchEvent(pointer));
    assert.equal(pointer.defaultPrevented,true);assert.equal(longPressTimers,0);
    assert.equal(document.querySelector('[role="menu"]'),null);
    assert.equal(anchor.getAttribute('data-state'),'closed');
    assert.equal(r.viewer.length,0);
    assert.deepEqual(blocked,['contextmenu','click','pointerdown']);
  } finally {window.setTimeout=originalTimeout;await view.close();}
});

test('source contract: actual SDK wrapper selects explicit document and delegates allowHtml to MarkdownPreview',()=>{
  const text=readFileSync(`${hostRoot}/apps/app/src/lib/plugin-sdk-app-impl.tsx`,'utf8');
  const wrapper=text.slice(text.indexOf('function PluginMarkdown('),text.indexOf('\nfunction ',text.indexOf('function PluginMarkdown(')+1));
  assert.match(wrapper,/experimental_document === undefined\s*\? messageRouting\s*:\s*buildMarkdownDocumentLinkRouting/);
  assert.match(wrapper,/<MarkdownPreview\s+allowHtml\s+content=\{content\}/);
  const preview=readFileSync(`${hostRoot}/apps/app/src/components/ui/markdown-preview.tsx`,'utf8');
  assert.match(preview,/<MarkdownMermaidDiagram\s+preferredTheme=\{preferredTheme\}\s+source=\{codeText\}/);
  assert.match(preview,/\[remarkMath, \{ singleDollarTextMath: false \}\]/);
  console.log('Coverage: actual host MarkdownPreview/routing/HTML/code; technical delegates render through exact AST-extracted PluginMarkdown body with injected timeline/navigation hooks. Valid math uses actual cold server markup, not completed KaTeX. Environment seams:',environmentSeams.join(', '));
  console.log('Gaps: browser layout/focus/selection persistence, route navigation, image lightbox, lazy math completion, Mermaid SVG rendering and full SDK provider mount. No fake Markdown renderer is used.');
});
}
