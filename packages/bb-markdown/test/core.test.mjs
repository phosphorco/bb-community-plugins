import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MarkdownSourceSchema, MarkdownFileTargetSchema, MarkdownRequestSchema, MarkdownPrepareInputSchema, PreparedMarkdownSchema, MarkdownTreeSchema, MarkdownNodeSchema, MARKDOWN_LIMITS, markdownRequestKey, createLiteralMarkdown } from '../dist/index.js';
const source={kind:'thread-message',instance:'local',threadId:'thr_23456789ab',messageId:'msg:42',revision:'r1',projectId:'proj_source',environmentId:'env_source'};
const request=(content='hello')=>({source,intent:'prose',content});
test('source and intent are required strict recursively; no viewer, root or dummy frame',()=>{
  assert.equal(MarkdownRequestSchema.safeParse(request()).success,true);
  for(const change of [r=>delete r.source,r=>delete r.intent,r=>r.intent='literal',r=>r.source.threadId='thr_dummy',r=>r.source.instance='foreign',r=>r.source.rootPath='/viewer',r=>r.source.viewer='viewer',r=>r.source.kind='selected-file',r=>r.extra=true]){const r=structuredClone(request());change(r);assert.equal(MarkdownRequestSchema.safeParse(r).success,false);}
  for(const origin of ['foreign','unknown'])assert.equal(MarkdownSourceSchema.safeParse({kind:'detached',producer:'notification',sourceKey:'remote:42',revision:'r1',origin}).success,true);
  assert.equal(MarkdownSourceSchema.safeParse({kind:'detached',producer:'x',sourceKey:'k',revision:'1',origin:'local',threadId:source.threadId}).success,false);
});
test('phase and batch limits are shared public bounds',()=>{
  assert.ok(MarkdownPrepareInputSchema.safeParse({phase:'base',requests:[request()]}).success);
  assert.equal(MarkdownPrepareInputSchema.safeParse({phase:'ready',requests:[]}).success,false);
  assert.equal(MarkdownPrepareInputSchema.safeParse({phase:'base',requests:Array.from({length:MARKDOWN_LIMITS.requests+1},()=>request())}).success,false);
});
test('literal fallback preserves original bytes without requiring native routing',()=>{
  const r=request('  `a.ts`\r\n[title](/outside) **bold**');const value=createLiteralMarkdown(r);
  assert.equal(value.original,r.content);assert.equal(value.content,r.content);assert.equal(value.format,'literal');assert.equal(value.tree,null);assert.equal(value.document,null);
  assert.ok(PreparedMarkdownSchema.safeParse(value).success);
  assert.equal(createLiteralMarkdown({content:'exact'}).status,'invalid');
});
test('keys correlate exact source, revision and content including escaping',()=>{
  const a=request('\\"\u0000'.repeat(5000));const value=createLiteralMarkdown(a);
  assert.ok(PreparedMarkdownSchema.safeParse(value).success,'valid JSON-expanded keys fit output bounds');
  for(const changed of [{...a,content:a.content+' '},{...a,source:{...source,revision:'r2'}},{...a,source:{...source,messageId:'another'}},{...a,source:{...source,environmentId:'env_other'}}])assert.notEqual(markdownRequestKey(a),markdownRequestKey(changed));
  assert.equal(markdownRequestKey({...a,source:{revision:'r1',messageId:'msg:42',environmentId:'env_source',projectId:'proj_source',threadId:'thr_23456789ab',instance:'local',kind:'thread-message'}}),markdownRequestKey(a));
});
test('tree decoder rejects executable attributes, local hrefs, arbitrary tags, unbounded/cyclic trees',()=>{
  const text={kind:'text',value:'hello'};const element={kind:'element',tag:'p',children:[text]};
  assert.ok(MarkdownTreeSchema.safeParse({version:1,children:[element]}).success);
  for(const node of [{...element,tag:'script'},{...element,onClick:'run()'},{...element,style:'url(/tmp/a)'},{kind:'element',tag:'a',href:'file:///tmp/a',children:[text]},{kind:'image',src:'/tmp/x',alt:'x'},{kind:'file',target:{kind:'workspace',environmentId:'env_a',path:'../private'},children:[text]},{kind:'code-block',value:'x',language:'js\n[escape](/tmp)'},{kind:'math',value:'x'.repeat(16385),display:false}])assert.equal(MarkdownNodeSchema.safeParse(node).success,false,JSON.stringify(node).slice(0,100));
  let deep=text;for(let i=0;i<MARKDOWN_LIMITS.treeDepth;i++)deep={kind:'element',tag:'span',children:[deep]};assert.equal(MarkdownTreeSchema.safeParse({version:1,children:[deep]}).success,false);
  const cyclic={kind:'element',tag:'p',children:[]};cyclic.children.push(cyclic);assert.equal(MarkdownTreeSchema.safeParse({version:1,children:[cyclic]}).success,false);
  assert.equal(MarkdownTreeSchema.safeParse({version:1,children:Array.from({length:MARKDOWN_LIMITS.treeNodes+1},()=>text)}).success,false);
});
test('formatted models must carry a validated tree, output metadata remains additive',()=>{
  const value=createLiteralMarkdown(request());assert.equal(PreparedMarkdownSchema.safeParse({...value,format:'markdown'}).success,false);
  assert.ok(PreparedMarkdownSchema.safeParse({...value,format:'markdown',tree:{version:1,children:[{kind:'text',value:'hello'}]},future:'allowed'}).success);
});
test('browser data entry has no parser, SDK, server, React, Node or supplier runtime imports',()=>{
  const sourceText=readFileSync(new URL('../src/index.ts',import.meta.url),'utf8');
  const imports=[...sourceText.matchAll(/(?:from\s*|import\s*)['"]([^'"]+)['"]/gu)].map(match=>match[1]);assert.deepEqual(imports,['zod']);
});

test('prepared output rejects injected file targets outside the correlated local document',()=>{
  const value=createLiteralMarkdown(request());const tree={version:1,children:[{kind:'file',target:{kind:'workspace',environmentId:'env_source',path:'a.ts'},children:[{kind:'text',value:'file'}]}]};
  const document={threadId:source.threadId,rootPath:'/source',target:{kind:'workspace',environmentId:'env_source',path:'.'}};
  const valid={...value,format:'markdown',document,tree};assert.ok(PreparedMarkdownSchema.safeParse(valid).success);
  for(const changed of [{...valid,document:null},{...valid,document:{...document,threadId:'thr_cdefghijkm'}},{...valid,document:{...document,target:{...document.target,environmentId:'env_foreign'}}},{...valid,tree:{...tree,children:[{...tree.children[0],target:{...tree.children[0].target,environmentId:'env_foreign'}}]}},{...valid,key:'another-key'}])assert.equal(PreparedMarkdownSchema.safeParse(changed).success,false);
  const detachedSource={kind:'detached',producer:'remote',sourceKey:'key',revision:'r',origin:'foreign'};const detachedModel=createLiteralMarkdown({source:detachedSource,intent:'prose',content:'hello'});
  assert.equal(PreparedMarkdownSchema.safeParse({...detachedModel,format:'markdown',tree,document}).success,false);
  assert.equal(PreparedMarkdownSchema.safeParse({...detachedModel,format:'markdown',tree,document:null}).success,false);
});

test('local-image transport nodes require the validated local document and exact environment',()=>{
  const value=createLiteralMarkdown(request());const node={kind:'local-image',target:{kind:'workspace',environmentId:'env_source',path:'images/a.png'},alt:'image',title:'Authored title'};
  const tree={version:1,children:[node]},document={threadId:source.threadId,rootPath:'/source',target:{kind:'workspace',environmentId:'env_source',path:'.'}};
  assert.ok(PreparedMarkdownSchema.safeParse({...value,format:'markdown',tree,document}).success);
  for(const changed of [{...value,format:'markdown',tree,document:null},{...value,format:'markdown',tree:{version:1,children:[{...node,target:{...node.target,environmentId:'env_foreign'}}]},document},{...value,format:'markdown',tree:{version:1,children:[{...node,target:{...node.target,path:'../private/a.png'}}]},document}])assert.equal(PreparedMarkdownSchema.safeParse(changed).success,false);
  const foreignSource={kind:'detached',producer:'remote',sourceKey:'key',revision:'r',origin:'foreign'};const foreign=createLiteralMarkdown({source:foreignSource,intent:'prose',content:'image'});
  assert.equal(PreparedMarkdownSchema.safeParse({...foreign,format:'markdown',tree,document}).success,false);
});

test('native file target DTO rejects ambiguous URL/editor delimiter filenames',()=>{
  for(const path of ['images/a:b.png','images/a?b.png','images/a%b.png','images/a#b.png','images/%23name.png']){
    const target={kind:'workspace',environmentId:'env_source',path};assert.equal(MarkdownFileTargetSchema.safeParse(target).success,false,path);
    assert.equal(MarkdownNodeSchema.safeParse({kind:'local-image',target,alt:'alt'}).success,false,path);
    assert.equal(MarkdownNodeSchema.safeParse({kind:'file',target,children:[{kind:'text',value:'label'}]}).success,false,path);
  }
  assert.ok(MarkdownFileTargetSchema.safeParse({kind:'workspace',environmentId:'env_source',path:'images/a [bracket] b.png'}).success);
});
