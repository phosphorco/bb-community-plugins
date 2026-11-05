import test from 'node:test';
import assert from 'node:assert/strict';
import { createMarkdownOwner } from '../dist/server.js';
import { PreparedMarkdownSchema, MARKDOWN_LIMITS } from '../dist/index.js';
import { registerRecognitionSupplier } from '@phosphorco/bb-context-recognition/bb';
import { METHODS } from '@phosphorco/bb-context-recognition';
const sourceId='thr_23456789ab',targetId='thr_cdefghijkm';
const source={kind:'thread-message',instance:'local',threadId:sourceId,messageId:'42',revision:'r1'};
const request=(content='hello',frame=source)=>({source:frame,intent:'prose',content});
const detached={kind:'detached',producer:'remote-notification',sourceKey:'origin:42',revision:'r1',origin:'foreign'};
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
function fixture(overrides={}){
  const calls={threads:[],environments:[],list:0,rpc:[]};
  const sdk={
    threads:{async get(args){calls.threads.push(args.threadId);if(overrides.thread)return overrides.thread(args);return {id:args.threadId,projectId:args.threadId===sourceId?'proj_source':'proj_target',environmentId:'env_source',deletedAt:null,title:args.threadId===sourceId?'Source':'Target [title] `code`',visibility:'hidden'};}},
    environments:{async get(args){calls.environments.push(args.environmentId);if(overrides.environment)return overrides.environment(args);return {id:args.environmentId,projectId:'proj_source',path:'/source'};}},
    plugins:{async list(){calls.list++;return {plugins:overrides.plugins??[]};},async callRpc(args){calls.rpc.push({pluginId:args.pluginId,method:args.method,input:args.input});if(overrides.rpc)return overrides.rpc(args);throw Object.assign(new Error('Unknown method'),{status:404,body:{error:{code:'unknown_method'}}});}},
  };
  const owner=createMarkdownOwner({sdk,consumer:{pluginId:'consumer',surface:'test'}});
  return {owner,calls,sdk};
}
function nodes(tree){const output=[];const visit=node=>{output.push(node);if(node.children)node.children.forEach(visit);};tree?.children.forEach(visit);return output;}
const text=tree=>nodes(tree).filter(node=>node.kind==='text').map(node=>node.value).join('');
function supplier({pluginId='supplier',provider='example',id='global:1',basis='explicit',label='Resolved [label]',href='https://example.test/resource?q=1#frag',match='ITEM',failure=false}={}){
  let handlers;
  registerRecognitionSupplier({rpc:{register(_contract,registered){handlers=registered;}}},{revision:'fixture/1',
    linkify:{providers:[{provider,kinds:['issue'],specificity:'typed'}],handler(input){if(failure)throw new Error('supplier failure');const start=input.text.indexOf(match);return {candidates:start<0?[]:[{span:{start,end:start+match.length},match,source:{provider,id,kind:'issue'},confidence:'high',provenance:{basis,explanation:'An explicit fixture identity.'}}]};}},
    resolve:{providers:[{provider,kinds:['issue']}],handler(input){assert.equal(input.detail,'label');assert.deepEqual(input.sources,[{provider,id,kind:'issue'}]);return {resolutions:input.sources.map(source=>({source,state:'ready',label,href,reasons:[]}))};}},
  });
  return {plugin:{id:pluginId,name:pluginId,status:'running'},call:args=>handlers[args.method](args.input)};
}
async function prepare(owner,content,phase='base',frame=source){const [result]=await owner.prepare({phase,requests:[request(content,frame)]});assert.ok(PreparedMarkdownSchema.safeParse(result).success,JSON.stringify(PreparedMarkdownSchema.safeParse(result).error));return result;}

test('base validates source/thread/environment once and NEVER discovers suppliers',async()=>{
  const {owner,calls}=fixture();const r=request('**hello** [file](docs/a.ts)');
  const values=await owner.prepare({phase:'base',requests:[r,r,r]});assert.equal(values.length,3);assert.equal(values[0].format,'markdown');
  assert.deepEqual(calls.threads,[sourceId]);assert.deepEqual(calls.environments,['env_source']);assert.equal(calls.list,0);assert.equal(calls.rpc.length,0);
  const file=nodes(values[0].tree).find(node=>node.kind==='file');assert.deepEqual(file.target,{kind:'workspace',environmentId:'env_source',path:'docs/a.ts'});
  assert.ok(nodes(values[0].tree).some(node=>node.kind==='element'&&node.tag==='strong'));owner.dispose();
});
test('wrong/missing runtime source and intent produce exact inert invalid fallback with no reads',async()=>{
  const {owner,calls}=fixture();
  const requests=[{content:'original no source',intent:'prose'},{source,content:'original no intent'},{source:{...source,rootPath:'/viewer'},intent:'prose',content:'forged root'}];
  const values=await owner.prepare({phase:'base',requests});for(let i=0;i<values.length;i++){assert.equal(values[i].status,'invalid');assert.equal(values[i].format,'literal');assert.equal(values[i].original,requests[i].content);}
  assert.equal(calls.threads.length,0);assert.equal(calls.list,0);owner.dispose();
});
test('foreign detached sources format useful prose but cannot read any local thread/environment',async()=>{
  const {owner,calls}=fixture();const input=`**foreign** [path](/source/a.ts) @thread:${targetId} \`/outside/a.ts\``;
  const value=await prepare(owner,input,'enrich',detached);assert.equal(value.format,'markdown');assert.equal(value.document,null);assert.equal(value.original,input);
  assert.ok(nodes(value.tree).some(node=>node.kind==='element'&&node.tag==='strong'));assert.ok(nodes(value.tree).some(node=>node.kind==='element'&&node.tag==='code'));
  assert.equal(nodes(value.tree).filter(node=>node.kind==='file').length,0);assert.equal(calls.threads.length,0);assert.equal(calls.environments.length,0);assert.equal(calls.list,1);owner.dispose();
});
test('wrong asserted source project/environment has no native authority; malformed/deleted metadata never fabricates routes',async()=>{
  for(const kind of ['project','environment','id','deleted','malformed','permission']){
    const overrides={thread:async({threadId})=>{if(kind==='permission')throw new Error('forbidden');return {id:kind==='id'?targetId:threadId,projectId:'proj_source',environmentId:'env_source',deletedAt:kind==='deleted'?1:null,...(kind==='malformed'?{}:{title:'Source'})};}};
    const {owner,calls}=fixture(overrides);const frame={...source,...(kind==='project'?{projectId:'proj_forged'}:{}),...(kind==='environment'?{environmentId:'env_forged'}:{})};
    const value=await prepare(owner,`[file](a.ts) @thread:${targetId}`,'enrich',frame);
    assert.equal(value.document,null,kind);assert.equal(nodes(value.tree).filter(node=>node.kind==='file').length,0,kind);assert.deepEqual(calls.threads,[sourceId],kind);assert.equal(calls.environments.length,0,kind);assert.ok(value.diagnostics.some(row=>row.code==='invalid-source'),kind);owner.dispose();
  }
});
test('environment root is authoritative: wrong IDs/projects/nonabsolute paths never grant file targets',async()=>{
  for(const changed of [{id:'env_other'},{projectId:'proj_other'},{path:'relative'},{path:null},{path:'/source\\foreign'}]){
    const {owner}=fixture({environment:async()=>({id:'env_source',projectId:'proj_source',path:'/source',...changed})});
    const value=await prepare(owner,'[file](/source/a.ts)');assert.equal(value.document,null);assert.equal(nodes(value.tree).filter(node=>node.kind==='file').length,0);owner.dispose();
  }
});
test('source read failure automatically recovers on authoritative retry and invalidate refreshes successful metadata',async()=>{
  let failing=true;const {owner,calls}=fixture({thread:async({threadId})=>{if(failing)throw new Error('offline');return {id:threadId,projectId:'proj_source',environmentId:'env_source',deletedAt:null,title:'Recovered'};}});
  const bad=await prepare(owner,'[file](a.ts)');assert.ok(bad.diagnostics.some(row=>row.code==='invalid-source'));failing=false;
  const good=await prepare(owner,'[file](a.ts)');assert.ok(good.document);assert.equal(good.diagnostics.some(row=>row.code==='invalid-source'),false);assert.equal(calls.threads.length,2);
  owner.invalidate();await prepare(owner,'[file](a.ts)');assert.equal(calls.threads.length,3);owner.dispose();
});
test('each unsafe local link/image/code is inert while useful formatted neighbors and native file targets remain',async()=>{
  const {owner}=fixture();const input='**keep** [safe](docs/a.ts:12-14) [outside](/outside/a.ts) [traversal](../private) ![alt](/outside/img.png) `/outside/a.ts` `C:\\repo\\a.ts:12`';
  const value=await prepare(owner,input);assert.equal(value.format,'markdown');assert.ok(value.document);assert.equal(value.original,input);
  const all=nodes(value.tree),files=all.filter(node=>node.kind==='file');assert.equal(files.length,1);assert.deepEqual(files[0].location,{kind:'range',startLine:12,endLine:14});
  assert.equal(all.filter(node=>node.kind==='element'&&node.tag==='code').length,2);assert.equal(all.filter(node=>node.kind==='element'&&node.href?.startsWith('file:')).length,0);assert.ok(text(value.tree).includes('outside'));assert.ok(text(value.tree).includes('/outside/a.ts'));owner.dispose();
});
test('exact authored external link destination/title, label formatting, code and original bytes survive',async()=>{
  const {owner}=fixture();const href='https://example.test/a_(b)?q=1&x=two#part';const input=`[**Label**](<${href}> "Authored title") \`literal @thread:${targetId}\`\n\n\`\`\`js\n[no](../private)\n\`\`\``;
  const value=await prepare(owner,input,'enrich');const link=nodes(value.tree).find(node=>node.kind==='element'&&node.tag==='a');assert.equal(link.href,href);assert.equal(link.title,'Authored title');assert.ok(link.children.some(node=>node.tag==='strong'));
  assert.ok(nodes(value.tree).some(node=>node.kind==='code-block'&&node.value==='[no](../private)'&&node.language==='js'));assert.equal(value.original,input);assert.equal(value.content,input);owner.dispose();
});
test('GFM nested lists, quotes, tables, alignment, task checkboxes, safe HTML and math remain structured',async()=>{
  const {owner}=fixture();const input='> quote\n>\n> - [x] done\n>   - nested\n\n| left | right |\n| :--- | ---: |\n| a | b |\n\n<details><summary>More</summary><b>HTML</b></details>\n\n$$x^2$$';
  const value=await prepare(owner,input);const all=nodes(value.tree);for(const tag of ['blockquote','ul','li','table','thead','tbody','th','td','details','summary','b'])assert.ok(all.some(node=>node.tag===tag),tag);
  assert.ok(all.some(node=>node.tag==='input'&&node.checked===true));assert.ok(all.some(node=>node.tag==='th'&&node.align==='right'));assert.ok(all.some(node=>node.kind==='math'&&node.value==='x^2'));owner.dispose();
});
test('raw HTML is sanitized and local attributes cannot bypass containment via entities, unquoted or mixed case',async()=>{
  const {owner}=fixture();const cases=['<a href=/outside/a.ts>label</a>','<a HREF="&#47;outside/a.ts">label</a>','<img src=/outside/x.png alt="readable">','<a href="javascript:alert(1)">label</a>','<span onclick="evil()"><strong>safe</strong></span>','<code>/outside/a.ts</code>'];
  for(const input of cases){const value=await prepare(owner,input);assert.equal(value.format,'markdown');const all=nodes(value.tree);assert.equal(all.filter(node=>node.kind==='file'||node.href?.startsWith('/outside')||node.src?.startsWith('/outside')).length,0);assert.equal(JSON.stringify(value.tree).includes('onclick'),false);}
  const external=await prepare(owner,'<a href="https://example.test/a?q=1&amp;x=2"><b>HTML link</b></a>');assert.equal(nodes(external.tree).find(node=>node.tag==='a').href,'https://example.test/a?q=1&x=2');owner.dispose();
});
test('native explicit thread tokens use direct readable hidden metadata, verified project and title escaping',async()=>{
  const {owner,calls}=fixture();const input=`See @thread:${targetId}#msg=42 and @thread:${targetId}.`;
  const base=await prepare(owner,input);assert.deepEqual(calls.threads,[sourceId]);assert.equal(base.phase,'base');assert.equal(calls.list,0);
  const value=await prepare(owner,input,'enrich');const links=nodes(value.tree).filter(node=>node.tag==='a');assert.equal(links.length,2);assert.equal(links[0].href,`/projects/proj_target/threads/${targetId}#msg=42`);assert.equal(text({children:links[0].children}),'Target [title] `code`');assert.deepEqual(calls.threads,[sourceId,targetId]);owner.dispose();
});
test('native grammar excludes code, authored labels, HTML, URL/path tails, escapes and Unicode marks',async()=>{
  const {owner,calls}=fixture();const token=`@thread:${targetId}`;const input=[`\`${token}\``,`[${token}](https://example.test)`,`<span>${token}</span>`,`path/${token}`,`x${token}`,`${token}\u0301`,`\\${token}`,`${token}/tail`,`${token}#unsupported`].join('\n\n');
  const value=await prepare(owner,input,'enrich');assert.deepEqual(calls.threads,[sourceId]);assert.equal(nodes(value.tree).filter(node=>node.tag==='a').length,1);owner.dispose();
});
test('registered recognition0.4.1 fixture handlers resolve inline label only and preserve provider/id/kind',async()=>{
  const supplied=supplier();const {owner,calls}=fixture({plugins:[supplied.plugin],rpc:supplied.call});const value=await prepare(owner,'ITEM','enrich');
  const link=nodes(value.tree).find(node=>node.tag==='a');assert.equal(link.href,'https://example.test/resource?q=1#frag');assert.equal(text({children:link.children}),'Resolved [label]');
  const resolved=calls.rpc.find(call=>call.method===METHODS.resolve);assert.equal(resolved.input.detail,'label');assert.deepEqual(resolved.input.sources,[{provider:'example',id:'global:1',kind:'issue'}]);assert.equal(calls.list,1);owner.dispose();
});
test('self supplier is discoverable and detached globally explicit references never infer repo context',async()=>{
  const supplied=supplier({pluginId:'consumer'});const {owner,calls}=fixture({plugins:[supplied.plugin],rpc:args=>{if(args.method===METHODS.linkify){assert.deepEqual(args.input.context,{consumer:{pluginId:'consumer',surface:'test'},links:[]});}return supplied.call(args);}});
  const value=await prepare(owner,'ITEM #23','enrich',detached);assert.ok(nodes(value.tree).some(node=>node.tag==='a'));assert.equal(calls.threads.length,0);assert.equal(calls.list,1);owner.dispose();
});
test('incidental context/git-remote provenance is rejected; explicit unknown references stay literal',async()=>{
  for(const basis of ['context','git-remote']){const supplied=supplier({basis});const {owner,calls}=fixture({plugins:[supplied.plugin],rpc:supplied.call});const value=await prepare(owner,'ITEM','enrich');assert.equal(nodes(value.tree).some(node=>node.tag==='a'),false);assert.equal(calls.rpc.some(call=>call.method===METHODS.resolve),false);owner.dispose();}
});
test('equal-specificity conflicting identity claims remain literal independent of supplier enumeration',async()=>{
  const a=supplier({pluginId:'supplier-a',id:'identity:a'}),b=supplier({pluginId:'supplier-b',id:'identity:b'});const {owner,calls}=fixture({plugins:[b.plugin,a.plugin],rpc:args=>(args.pluginId===a.plugin.id?a:b).call(args)});
  const value=await prepare(owner,'ITEM','enrich');assert.equal(nodes(value.tree).some(node=>node.tag==='a'),false);assert.ok(value.diagnostics.some(row=>row.code==='conflicting-claims'));assert.equal(calls.rpc.some(call=>call.method===METHODS.resolve),false);owner.dispose();
});
test('one failed supplier does not discard healthy explicit links and base is never delayed by suppliers',async()=>{
  const good=supplier({provider:'good',pluginId:'good'}),bad=supplier({provider:'bad',pluginId:'bad',failure:true});const {owner,calls}=fixture({plugins:[bad.plugin,good.plugin],rpc:args=>(args.pluginId==='good'?good:bad).call(args)});
  await prepare(owner,'ITEM');assert.equal(calls.list,0);const value=await prepare(owner,'ITEM','enrich');assert.ok(nodes(value.tree).some(node=>node.tag==='a'));assert.ok(value.diagnostics.some(row=>row.code==='linkify-partial'));owner.dispose();
});
test('contributed whole URL keeps exact query/fragment destination despite canonical resolver href',async()=>{
  const authored='https://example.test/issue/42?tab=notes#comment-17';const supplied=supplier({match:authored,href:'https://example.test/issue/42'});const {owner}=fixture({plugins:[supplied.plugin],rpc:supplied.call});const value=await prepare(owner,`Read ${authored}`,'enrich');const link=nodes(value.tree).find(node=>node.tag==='a');assert.equal(link.href,authored);assert.equal(text({children:link.children}),'Resolved [label]');owner.dispose();
});
test('many repeated and distinct visible sources share metadata, discovery and supplier identity reads',async()=>{
  const supplied=supplier();const {owner,calls}=fixture({plugins:[supplied.plugin],rpc:supplied.call});const distinct=Array.from({length:16},(_,i)=>request(`ITEM distinct ${i}`,{...source,messageId:`message:${i}`}));
  const results=await Promise.all([owner.prepare({phase:'enrich',requests:distinct}),owner.prepare({phase:'enrich',requests:distinct})]);assert.equal(results.flat().length,32);
  assert.deepEqual(calls.threads,[sourceId]);assert.deepEqual(calls.environments,['env_source']);assert.equal(calls.list,1);assert.equal(calls.rpc.filter(call=>call.method===METHODS.describe).length,1);assert.equal(calls.rpc.filter(call=>call.method===METHODS.resolve).length,1);
  await owner.prepare({phase:'enrich',requests:distinct});assert.equal(calls.list,1);assert.equal(calls.rpc.filter(call=>call.method===METHODS.linkify).length,16);owner.invalidate();await prepare(owner,'ITEM','enrich');assert.equal(calls.list,2);owner.dispose();
});
test('caller abort fences local delivery, dispose fences late metadata, and a replacement generation reads afresh',async()=>{
  const held=deferred(),started=deferred();let first=true;const {owner,calls}=fixture({thread:async({threadId})=>{if(first){first=false;started.resolve();await held.promise;}return {id:threadId,projectId:'proj_source',environmentId:'env_source',deletedAt:null,title:'Source'};}});
  const controller=new AbortController();const waiting=owner.prepare({phase:'base',requests:[request()]},controller.signal);await started.promise;controller.abort();await assert.rejects(waiting,{name:'AbortError'});
  owner.invalidate();held.resolve();const value=await prepare(owner,'replacement');assert.ok(value.document);assert.equal(calls.threads.length,2);owner.dispose();await assert.rejects(owner.prepare({phase:'base',requests:[request()]}),/disposed/);
});
test('excess text/tree and invalid batch admission return readable literal models, not spinners',async()=>{
  const {owner}=fixture();const content='x'.repeat(MARKDOWN_LIMITS.parseChars+1);const value=await prepare(owner,content);assert.equal(value.format,'literal');assert.equal(value.content,content);assert.equal(value.tree,null);
  const values=await owner.prepare({phase:'base',requests:Array.from({length:17},()=>request('exact'))});assert.equal(values.length,16);assert.ok(values.every(row=>row.status==='invalid'&&row.content==='exact'));owner.dispose();
});

test('owner read concurrency is bounded across distinct source identities without timing assumptions',async()=>{
  const gate=deferred(),started=deferred();let active=0,maximum=0;
  const {owner,calls}=fixture({thread:async({threadId})=>{active++;maximum=Math.max(maximum,active);if(active===MARKDOWN_LIMITS.concurrency)started.resolve();await gate.promise;active--;return {id:threadId,projectId:'proj_source',environmentId:'env_source',deletedAt:null,title:'Source'};}});
  const ids='23456789abcdefgh'.split('').map(char=>`thr_23456789a${char}`);
  const pending=owner.prepare({phase:'base',requests:ids.map(threadId=>request('**distinct**',{...source,threadId}))});await started.promise;assert.equal(maximum,MARKDOWN_LIMITS.concurrency);gate.resolve();
  const values=await pending;assert.equal(values.length,16);assert.equal(maximum,MARKDOWN_LIMITS.concurrency);assert.equal(calls.threads.length,16);assert.equal(calls.environments.length,1);owner.dispose();
});
test('noncooperating optional supplier reaches contract deadline and leaves formatted readable base',async()=>{
  const supplied=supplier();const {owner}=fixture({plugins:[supplied.plugin],rpc:args=>args.method===METHODS.linkify?new Promise(()=>{}):supplied.call(args)});
  const value=await prepare(owner,'**keep formatted** ITEM','enrich');assert.equal(value.format,'markdown');assert.ok(nodes(value.tree).some(node=>node.tag==='strong'));assert.ok(value.diagnostics.some(row=>row.code==='linkify-partial'));owner.dispose();
});
test('same frame/revision with changed exact content cannot reuse stale source preparation',async()=>{
  const {owner,calls}=fixture();const a=await prepare(owner,'**first**'),b=await prepare(owner,'*second*');assert.notEqual(a.key,b.key);assert.ok(nodes(a.tree).some(node=>node.tag==='strong'));assert.ok(nodes(b.tree).some(node=>node.tag==='em'));assert.deepEqual(calls.threads,[sourceId]);owner.dispose();
});

test('unknown outer URIs and URL query/path substrings never recruit nested native or supplier identities',async()=>{
  for(const content of ['custom:ITEM','mailto:ITEM','https://example.test/path?reference=ITEM']){
    const supplied=supplier();const {owner,calls}=fixture({plugins:[supplied.plugin],rpc:supplied.call});const value=await prepare(owner,content,'enrich');assert.equal(calls.rpc.some(call=>call.method===METHODS.resolve),false,content);assert.equal(text(value.tree).includes('Resolved'),false);owner.dispose();
  }
  const {owner,calls}=fixture();await prepare(owner,`custom:@thread:${targetId}`,'enrich');assert.deepEqual(calls.threads,[sourceId]);owner.dispose();
});

test('verified local images retain explicit source-bound image targets while unsafe/nested images remain inert',async()=>{
  const {owner}=fixture();const original='![Local alt](images/a.png "Authored title") ![Outside](/outside/a.png) [![Nested](images/nested.png)](https://example.test)';
  const value=await prepare(owner,original);const all=nodes(value.tree),local=all.filter(node=>node.kind==='local-image');
  assert.equal(local.length,1);assert.deepEqual(local[0],{kind:'local-image',target:{kind:'workspace',environmentId:'env_source',path:'images/a.png'},alt:'Local alt',title:'Authored title'});assert.equal(value.original,original);
  assert.ok(value.diagnostics.some(row=>row.code==='nested-local-image'));assert.ok(text(value.tree).includes('Nested'));assert.equal(all.some(node=>node.kind==='file'),false);
  const foreign=await prepare(owner,'![Foreign](images/a.png)','base',detached);assert.equal(nodes(foreign.tree).some(node=>node.kind==='local-image'),false);owner.dispose();
});

test('unsupported local filename delimiters remain inert per node without discarding formatted neighbors',async()=>{
  const {owner}=fixture();
  for(const href of ['images/a#b.png','images/a?b.png','images/a%b.png','images/a:b.png','images/a&#35;b.png','images/a&#63;b.png','images/a.png:123']){
    const value=await prepare(owner,`**neighbor** <img src="${href}" alt="retained alt"> <a href="${href.endsWith(':123')?href+'.png':href}">retained label</a>`);
    assert.equal(value.format,'markdown',href);assert.ok(nodes(value.tree).some(node=>node.tag==='strong'),href);
    assert.equal(nodes(value.tree).some(node=>node.kind==='local-image'||node.kind==='file'),false,href);
    assert.ok(text(value.tree).includes('retained alt'),href);assert.ok(text(value.tree).includes('retained label'),href);
  }
  const safe=await prepare(owner,'<img src="images/a [bracket] b.png" alt="safe">');assert.deepEqual(nodes(safe.tree).find(node=>node.kind==='local-image').target,{kind:'workspace',environmentId:'env_source',path:'images/a [bracket] b.png'});owner.dispose();
});
