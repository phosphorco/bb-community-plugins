import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const scratch = mkdtempSync(join(tmpdir(), 'bb-markdown-source-gate-'));
after(() => rmSync(scratch, { recursive: true, force: true }));
const gatePath = fileURLToPath(new URL('../src/source-gate.ts', import.meta.url));
const apiPath = join(scratch, 'api-proof.mts');
writeFileSync(apiPath, `import {checkSources, inspectSource, type GateResult, type DebtManifest} from ${JSON.stringify(gatePath)};
const debt: DebtManifest = {version:1,entries:[]};
const result: GateResult = checkSources({roots:[{id:'org',path:'.'}],debt});
inspectSource({root:'org',path:'app.tsx',source:'export {}'}).findings.map(f=>f.sha256);
result.stale.map(e=>e.intent);
`);
const options = { strict: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler, skipLibCheck: true,
  allowImportingTsExtensions: true, noEmit: true, types: ['node'],
  typeRoots: [resolve(dirname(gatePath), '../../../node_modules/@types')] };
// Compile actual exported APIs and typed consumer: transpilation alone is not proof.
const program = ts.createProgram([gatePath, apiPath], options);
const diagnostics = ts.getPreEmitDiagnostics(program);
assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, {
  getCurrentDirectory: () => process.cwd(), getCanonicalFileName: f => f, getNewLine: () => '\n',
}));
const compiled = ts.transpileModule(readFileSync(gatePath, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
writeFileSync(join(scratch, 'gate.mjs'), compiled.outputText);
symlinkSync(dirname(dirname(require.resolve('typescript/package.json'))), join(scratch, 'node_modules'), 'dir');
const { inspectSource, checkSources } = await import(pathToFileURL(join(scratch, 'gate.mjs')).href);
const inspect = (source, path = 'plugins/example/app.tsx', root = 'org') => inspectSource({ root, path, source });
const rules = source => inspect(source).findings.map(f => f.rule);
const sdk = '@get-bb/plugin-sdk/app';

for (const [name, source, expected] of [
  ['named alias', `import {Markdown as M} from '${sdk}'; const X=()=> <M content={text}/>;`, 'sdk-use'],
  ['memo and HOC alias', `import {Markdown as M} from '${sdk}'; const P=memo(M); const Q=memo(P); const X=()=> <Q content={text}/>;`, 'sdk-use'],
  ['injected component', `import {Markdown as M} from '${sdk}'; const P=memo(M); const X=()=> <Editor Preview={P}/>;`, 'sdk-use'],
  ['reexport alias', `export {Markdown as M} from '${sdk}';`, 'renderer-reexport'],
  ['star reexport', `export * from '${sdk}';`, 'renderer-reexport'],
  ['namespace reexport', `export * as UI from '${sdk}';`, 'renderer-reexport'],
  ['namespace access', `import * as UI from '${sdk}'; const M=UI.Markdown;`, 'sdk-access'],
  ['namespace computed', `import * as UI from '${sdk}'; const M=UI['Markdown'];`, 'sdk-access'],
  ['namespace nonliteral access', `import * as UI from '${sdk}'; const M=UI[name];`, 'sdk-access'],
  ['namespace destructuring', `import * as UI from '${sdk}'; const {Markdown:M}=UI; use(M);`, 'sdk-namespace-escape'],
  ['static dynamic import', `const M=(await import('${sdk}')).Markdown;`, 'renderer-load'],
  ['CJS destructuring', `const {Markdown:M}=require('${sdk}'); use(M);`, 'renderer-load'],
  ['TypeScript import equals', `import UI = require('${sdk}');`, 'renderer-load'],
  ['side-effect parser', "import 'marked';", 'parser-import'],
  ['CJS property access', `const M=require('${sdk}')['Markdown'];`, 'renderer-load'],
  ['injected children renderer', 'function X({Markdown}) {return <Markdown>{text}</Markdown>}', 'local-prose-component'],
  ['injected createElement renderer', 'createElement(Preview, {content:text});', 'local-prose-component'],
  ['component prop contract', `function X({Preview}) {return <Preview content={text}/>}`, 'local-prose-component'],
  ['parser ESM', `import {marked as parse} from 'marked'; const html=parse(text);`, 'parser-use'],
  ['parser alias expansion', `import {marked} from 'marked'; const p=marked; const html=p(text);`, 'parser-use'],
  ['parser CJS', `const p=require('markdown-it');`, 'renderer-load'],
  ['DOM assignment', `target.innerHTML=sanitize(html);`, 'html-sink'],
  ['computed DOM assignment', `target['innerHTML']=html;`, 'html-sink'],
  ['React HTML prop', `const X=()=> <div dangerouslySetInnerHTML={{__html:text}}/>;`, 'html-sink'],
  ['object HTML prop', `const props={dangerouslySetInnerHTML:{__html:text}};`, 'html-sink'],
  ['DOM insertion', `target.insertAdjacentHTML('beforeend', html);`, 'html-sink'],
  ['DOM parsing', `new DOMParser().parseFromString(html,'text/html');`, 'html-sink'],
  ['dynamic AST tree', `createElement(node.tagName, props, children);`, 'dynamic-element'],
  ['HTML literal renderer', `const render=(s)=>'<p>'+s+'</p>';`, 'html-template'],
  ['named regex renderer', `function renderMarkdown(s){return s.replace(/#/g,'');}`, 'local-renderer'],
  ['short served script', 'const js="document.body.innerHTML=value;";', 'served-template'],
  ['inline HTML script', 'const html="<script>target.innerHTML=value;</script>";', 'served-template'],
  ['embedded template', 'const CLIENT_JS=`function md(s){return "<p>"+s+"</p>";} document.body.innerHTML=md(text);`;', 'served-template'],
  ['shared source missing', `import {Markdown as M} from '@phosphorco/bb-markdown/react'; const X=()=> <M content={text} intent="full"/>;`, 'shared-context'],
]) test(`rejects ${name}`, () => assert.ok(rules(source).includes(expected), `${expected}: ${JSON.stringify(inspect(source).findings)}`));

test('embedded template syntax and HTML sinks are inspected, with exact outer fingerprint', () => {
  const source = 'const CLIENT_JS=`function md(s){return "<p>"+s+"</p>";} document.body.innerHTML=md(text);`;';
  const result = inspect(source);
  assert.equal(result.templates, 1);
  assert.ok(result.findings.some(f => f.rule === 'html-sink'));
  assert.ok(result.findings.some(f => f.rule === 'local-renderer'));
  assert.ok(result.findings.every(f => f.line > 0 && f.column > 0 && f.sha256.length === 64));
  assert.notEqual(result.findings.find(f => f.rule === 'served-template').sha256,
    inspect(source.replace('md(text)', 'md(other)')).findings.find(f => f.rule === 'served-template').sha256);
});
test('served HTML and its inline script fail closed', () => {
  const result = inspect('<html><script>document.body.innerHTML=value;</script></html>', 'plugins/example/view.html');
  assert.equal(result.templates, 1);
  assert.ok(result.findings.some(f => f.rule === 'served-template'));
  assert.ok(result.findings.some(f => f.rule === 'html-sink'));
});
test('malformed ordinary and embedded code fails closed', () => {
  assert.ok(rules('const x = ;').includes('syntax'));
  assert.ok(rules('const X=`function md( { document.body.innerHTML=x;`;').includes('syntax'));
});
test('native delegate is the single exact SDK exception, not a folder exemption', () => {
  const source = `import {Markdown as M} from '${sdk}'; const X=()=> <M content={text}/>;`;
  const native=inspect(source, 'packages/bb-markdown/src/native.tsx', 'community').findings;
  assert.ok(!native.some(f=>f.rule==='sdk-markdown'));
  assert.ok(native.some(f=>f.rule==='sdk-use')); // Uses need exact reviewed fingerprints.
  assert.ok(inspect(source, 'packages/bb-markdown/src/other.tsx', 'community').findings.length);
  assert.ok(inspect(source + 'target.innerHTML=text;', 'packages/bb-markdown/src/native.tsx', 'community').findings.some(f => f.rule === 'html-sink'));
});
test('SDK nonrenderer named/static namespace imports, type imports, literals and shared source+intent pass', () => {
  const source = `import {ThreadChat, type MarkdownProps} from '${sdk}';
import * as UI from '${sdk}';
import type {Markdown} from '${sdk}';
import {Markdown as M} from '@phosphorco/bb-markdown/react';
const X=()=> <><UI.ThreadChat threadId="t"/><pre>{text}</pre><M content={text} source={captured} intent="full"/></>;`;
  assert.deepEqual(inspect(source).findings, []);
});
function fixture(source) {
  const root = mkdtempSync(join(scratch, 'fixture-')); mkdirSync(join(root, 'plugins'));
  writeFileSync(join(root, 'plugins/app.tsx'), source);
  const roots = [{ id: 'org', path: root }];
  const result = checkSources({ roots });
  const groups = new Map();
  for (const f of result.findings) {
    const k = `${f.rule}:${f.sha256}`;
    if (groups.has(k)) groups.get(k).count++;
    else groups.set(k, {root:f.root,path:f.path,rule:f.rule,sha256:f.sha256,count:1,kind:'debt',intent:'Reviewed existing fixture prose boundary'});
  }
  return { root, roots, debt: { version: 1, entries: [...groups.values()] } };
}
test('exact subtree debt permits unrelated edits; changes, expansion and duplication fail', () => {
  const source = `import {Markdown as M} from '${sdk}'; const X=()=> <M content={text}/>;`;
  const f = fixture(source);
  assert.equal(checkSources(f).ok, true);
  writeFileSync(join(f.root, 'plugins/app.tsx'), source + '\nconst unrelated=1;');
  assert.equal(checkSources(f).ok, true);
  writeFileSync(join(f.root, 'plugins/app.tsx'), source.replace('content={text}', 'content={other}'));
  assert.equal(checkSources(f).ok, false);
  writeFileSync(join(f.root, 'plugins/app.tsx'), source + 'const Y=()=> <M content={text}/>;');
  assert.equal(checkSources(f).ok, false);
  writeFileSync(join(f.root, 'plugins/app.tsx'), 'export {};');
  const deleted = checkSources(f);
  assert.equal(deleted.ok, true); assert.equal(deleted.stale.length, f.debt.entries.length);
});
test('parser-only intent cannot authorize HTML and adding a parser call fails', () => {
  const f = fixture(`import {marked} from 'marked'; const tokens=marked.lexer(text);`);
  for (const e of f.debt.entries) {e.kind='parser-only';e.intent='Extract links from lexer tokens; no UI HTML';}
  assert.equal(checkSources(f).ok, true);
  writeFileSync(join(f.root, 'plugins/app.tsx'), `import {marked} from 'marked'; const tokens=marked.lexer(text); target.innerHTML=marked.parse(text);`);
  assert.equal(checkSources(f).ok, false);
  const sink = checkSources(f).findings.find(x => x.rule === 'html-sink');
  assert.throws(() => checkSources({...f,debt:{version:1,entries:[{...sink,count:1,kind:'parser-only',intent:'cannot allow HTML'}]}}));
});
test('two independent explicit roots, own-root stale accounting, and exact counts', () => {
  const a=fixture('target.innerHTML=text;'), b=fixture('target.outerHTML=other;');
  const roots=[a.roots[0],{id:'community',path:b.root}];
  const debt={version:1,entries:[...a.debt.entries,...b.debt.entries.map(e=>({...e,root:'community'}))]};
  const both=checkSources({roots,debt});
  assert.equal(both.ok,true); assert.equal(both.coverage.files,2); assert.equal(both.coverage.debt,2); assert.equal(both.coverage.violations,0);
  assert.equal(checkSources({roots:[a.roots[0]],debt}).stale.length,0);
  assert.throws(()=>checkSources({roots:[]}));
  assert.throws(()=>checkSources({roots:[a.roots[0],a.roots[0]]}));
  assert.throws(()=>checkSources({roots,debt:{version:1,entries:[{...debt.entries[0],path:'plugins/*'}]}}));
});
test('active vendor CJS included; tests, build output and dependency links excluded explicitly', () => {
  const f=fixture('export {};'); mkdirSync(join(f.root,'plugins/vendor'));
  writeFileSync(join(f.root,'plugins/vendor/template.cjs'),'module.exports=`function md(s){return "<p>"+s+"</p>";} x.innerHTML=md(text);`;');
  mkdirSync(join(f.root,'dist'));writeFileSync(join(f.root,'dist/app.js'),'x.innerHTML=text;');
  writeFileSync(join(f.root,'plugins/app.test.ts'),'x.innerHTML=text;');
  const r=checkSources({roots:f.roots});
  assert.equal(r.ok,false);assert.equal(r.coverage.files,2);assert.equal(r.coverage.templates,1);
  assert.ok(r.findings.every(x=>x.path==='plugins/vendor/template.cjs'));
});


test('reviewed Mermaid SVG boundary changes fail while unrelated source edits pass', () => {
  const source='import mermaid from "mermaid"; mermaid.initialize({securityLevel:"strict"}); mermaid.render(id,source,host); host.innerHTML=svg;';
  const f=fixture(source);
  for(const e of f.debt.entries){e.kind='reviewed-exception';e.intent='Generated Mermaid SVG only, strict configuration and fixed boundary';}
  assert.equal(checkSources(f).ok,true);
  writeFileSync(join(f.root,'plugins/app.tsx'),source.replace('"strict"','"loose"'));
  assert.ok(checkSources(f).findings.some(e=>e.rule==='diagram-use'));
});
test('wrong/empty repository root fails instead of reporting vacuous success', () => {
  const root=mkdtempSync(join(scratch,'empty-'));
  assert.throws(()=>checkSources({roots:[{id:'org',path:root}]}),/No plugins/);
});
test('production source symlinks cannot silently hide new rendering', () => {
  const f=fixture('export {};');
  writeFileSync(join(scratch,'external.tsx'),'target.innerHTML=text;');
  symlinkSync(join(scratch,'external.tsx'),join(f.root,'plugins','hidden.tsx'));
  assert.ok(checkSources(f).findings.some(e=>e.rule==='source-symlink'));
});
test('actual CLI argument/result interface works using the compiled gate in scratch', () => {
  const f=fixture('target.innerHTML=text;');
  const cli=readFileSync(new URL('../tools/check-sources.mjs',import.meta.url),'utf8').replace("'../dist/testing-source-gate.js'", "'./gate.mjs'");
  const cliPath=join(scratch,'check-sources.mjs'), debtPath=join(scratch,'debt.json');
  writeFileSync(cliPath,cli);writeFileSync(debtPath,JSON.stringify(f.debt));
  const args=[cliPath,'--root',`org=${f.root}`,'--debt',debtPath,'--json'];
  let run=spawnSync(process.execPath,args,{encoding:'utf8'});
  assert.equal(run.status,0,run.stderr);assert.equal(JSON.parse(run.stdout).coverage.debt,1);
  writeFileSync(join(f.root,'plugins/app.tsx'),'target.innerHTML=other;');
  run=spawnSync(process.execPath,args,{encoding:'utf8'});
  assert.equal(run.status,1,run.stderr);assert.equal(JSON.parse(run.stdout).findings[0].rule,'html-sink');
  run=spawnSync(process.execPath,[cliPath,'--root','org='],{encoding:'utf8'});
  assert.notEqual(run.status,0);assert.match(run.stderr,/--root requires/);
});


test('native technical-leaf defensive functions require whole-function review', () => {
  const source=`import {Markdown as M} from '${sdk}'; export function NativeCodeBlock({value}) {return <M content={safeFence(value)}/>;} export function NativeMath({value}) {return <M content={safeMath(value)}/>;}`;
  const result=inspect(source,'packages/bb-markdown/src/native.tsx','community');
  assert.equal(result.findings.filter(f=>f.rule==='native-delegate').length,2);
  const hashes=result.findings.filter(f=>f.rule==='native-delegate').map(f=>f.sha256);
  const changed=inspect(source.replace('safeFence(value)','value'),'packages/bb-markdown/src/native.tsx','community');
  assert.notEqual(changed.findings.find(f=>f.rule==='native-delegate').sha256,hashes[0]);
});


test('native helper and bound mutations require independent reviewed fingerprints', () => {
  const source='const NODE_CHARS=100; export function safeCodeFence(value){return value.length>NODE_CHARS?null:makeFence(value);} export function safeMathSource(value){return value.includes("$")?null:value;}';
  const result=inspect(source,'packages/bb-markdown/src/native.tsx','community');
  assert.equal(result.findings.filter(f=>f.rule==='native-delegate').length,3);
  const changed=inspect(source.replace('NODE_CHARS=100','NODE_CHARS=1000'),'packages/bb-markdown/src/native.tsx','community');
  assert.notEqual(result.findings.find(f=>f.rule==='native-delegate').sha256,changed.findings.find(f=>f.rule==='native-delegate').sha256);
  const mutation=inspect(source+'safeCodeFence=unsafe;','packages/bb-markdown/src/native.tsx','community');
  assert.ok(mutation.findings.some(f=>f.rule==='native-helper-use'&&f.excerpt.includes('=unsafe')));
});

for (const [kind, edge] of [
  ['static import', `import {Unsafe} from '../test/renderer.tsx'; export {Unsafe};`],
  ['named reexport', `export {Unsafe} from '../test/renderer.tsx';`],
  ['star reexport', `export * from '../test/renderer.tsx';`],
  ['static dynamic import', `export const load=()=>import('../test/renderer.tsx');`],
  ['runtime CJS', `module.exports=require('../test/renderer.tsx');`],
  ['TS runtime import equals', `import Unsafe=require('../test/renderer.tsx'); export {Unsafe};`],
]) test(`production ${kind} into excluded test source fails`, () => {
  const root=mkdtempSync(join(scratch,'excluded-edge-'));
  mkdirSync(join(root,'packages','x','src'),{recursive:true});
  mkdirSync(join(root,'packages','x','test'),{recursive:true});
  writeFileSync(join(root,'packages','x','src','index.tsx'),edge);
  writeFileSync(join(root,'packages','x','test','renderer.tsx'),`import {Markdown} from '${sdk}'; export const Unsafe=()=> <Markdown content="unsafe prose"/>;`);
  const result=checkSources({roots:[{id:'community',path:root}]});
  assert.equal(result.ok,false);
  assert.equal(result.coverage.files,1);
  assert.ok(result.findings.some(f=>f.rule==='excluded-source-import' && f.path==='packages/x/src/index.tsx'));
});

for (const excluded of ['test/renderer.tsx','fixture/renderer.tsx','fixtures/renderer.tsx','spec/renderer.tsx','__tests__/renderer.tsx','renderer.test.tsx','renderer.spec.tsx','renderer.fixture.tsx']) test(`relative closure cannot hide rendering behind intermediate module -> ${excluded}`, () => {
  const root=mkdtempSync(join(scratch,'closure-edge-'));
  mkdirSync(join(root,'packages','x','src'),{recursive:true});
  mkdirSync(dirname(join(root,'bridge',excluded)),{recursive:true});
  writeFileSync(join(root,'packages','x','src','index.tsx'),`export * from '../../../bridge/middle.js';`);
  writeFileSync(join(root,'bridge','middle.ts'),`export * from './${excluded}';`);
  writeFileSync(join(root,'bridge',excluded),`import {Markdown} from '${sdk}'; export const Unsafe=()=> <Markdown content="unsafe"/>;`);
  const result=checkSources({roots:[{id:'community',path:root}]});
  assert.equal(result.ok,false);assert.equal(result.coverage.files,2);
  assert.ok(result.findings.some(f=>f.path==='bridge/middle.ts'&&f.rule==='excluded-source-import'));
});
test('relative closure scans nonexcluded intermediate renderer and handles cycles', () => {
  const root=mkdtempSync(join(scratch,'closure-renderer-'));
  mkdirSync(join(root,'packages','x','src'),{recursive:true});mkdirSync(join(root,'bridge'));
  writeFileSync(join(root,'packages','x','src','index.tsx'),`export * from '../../../bridge/middle.js';`);
  writeFileSync(join(root,'bridge','middle.ts'),`export * from './renderer.js'; export * from '../packages/x/src/index.js';`);
  writeFileSync(join(root,'bridge','renderer.tsx'),`import {Markdown} from '${sdk}'; export const Unsafe=()=> <Markdown content="unsafe"/>;`);
  const result=checkSources({roots:[{id:'community',path:root}]});
  assert.equal(result.ok,false);assert.equal(result.coverage.files,3);
  assert.ok(result.findings.some(f=>f.path==='bridge/renderer.tsx'&&f.rule==='sdk-markdown'));
});
test('type-only imports/reexports do not make excluded tests a runtime renderer', () => {
  const f=fixture(`import type {A} from './test/types.ts'; import {type B} from './test/types.ts'; export type {A} from './test/types.ts'; export {type B} from './test/types.ts';`);
  assert.equal(checkSources(f).ok,true);
});
test('NativeImage whole-function guard detects the reviewer original-prose mutation', () => {
  const source=`import {Markdown as M} from '${sdk}'; export function NativeImage({target,alt}) { const label=alt.replace(/\n/g,' '); const content='!['+label+']('+target+')'; return <M content={content}/>; }`;
  const original=inspect(source,'packages/bb-markdown/src/native.tsx','community');
  const changed=inspect(source.replace("const content='!['+label+']('+target+')'",'const content=alt'),'packages/bb-markdown/src/native.tsx','community');
  const before=original.findings.find(f=>f.rule==='native-delegate'&&f.excerpt.includes('NativeImage'));
  const after=changed.findings.find(f=>f.rule==='native-delegate'&&f.excerpt.includes('NativeImage'));
  assert.ok(before);assert.ok(after);assert.notEqual(before.sha256,after.sha256);
  assert.equal(original.findings.filter(f=>f.rule==='sdk-use').length,changed.findings.filter(f=>f.rule==='sdk-use').length);
});
test('future extracted NativeImage helper or limit changes are independently pinned', () => {
  const source='const IMAGE_CHARS=100; function imageSource(value){return value.length<IMAGE_CHARS?value:null;} export function NativeImage({alt}){return imageSource(alt);}';
  const original=inspect(source,'packages/bb-markdown/src/native.tsx','community');
  const changed=inspect(source.replace('IMAGE_CHARS=100','IMAGE_CHARS=1000'),'packages/bb-markdown/src/native.tsx','community');
  assert.equal(original.findings.filter(f=>f.rule==='native-delegate').length,3);
  assert.notEqual(original.findings.find(f=>f.rule==='native-delegate').sha256,changed.findings.find(f=>f.rule==='native-delegate').sha256);
  assert.ok(original.findings.some(f=>f.rule==='native-helper-use'&&f.excerpt.includes('imageSource(alt)')));
});


test('encoded relative import and module query cannot hide an excluded runtime edge', () => {
  const root=mkdtempSync(join(scratch,'encoded-closure-'));
  mkdirSync(join(root,'packages','x','src'),{recursive:true});
  for(const specifier of ['../%74est/renderer.tsx','../test/renderer.tsx?worker','../test/renderer.tsx#module']) {
    writeFileSync(join(root,'packages','x','src','index.tsx'),`export const load=()=>import('${specifier}');`);
    const result=checkSources({roots:[{id:'community',path:root}]});
    assert.equal(result.ok,false);assert.ok(result.findings.some(f=>f.rule==='excluded-source-import'));
  }
});
test('fixture data remains data, while executable test sources still fail', () => {
  const f=fixture(`import data from './fixtures/data.json'; export {data};`);
  assert.equal(checkSources(f).ok,true);
});


test('actual shared grammar safeLocal policy weakening changes the module fingerprint', () => {
  const source=readFileSync(new URL('../src/grammar.ts',import.meta.url),'utf8');
  const sf=ts.createSourceFile('grammar.ts',source,ts.ScriptTarget.Latest,true);
  const local=sf.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='safeLocal');
  assert.ok(local?.body,'shared grammar must have a reviewable safeLocal policy');
  const changed=source.slice(0,local.body.getStart(sf))+'{ return true; }'+source.slice(local.body.end);
  const original=inspect(source,'packages/bb-markdown/src/grammar.ts','community');
  const weakened=inspect(changed,'packages/bb-markdown/src/grammar.ts','community');
  assert.notEqual(original.findings.find(f=>f.rule==='shared-policy-boundary').sha256,weakened.findings.find(f=>f.rule==='shared-policy-boundary').sha256);
});
test('actual NativeImage content=alt mutation changes whole native policy fingerprint', () => {
  const source=readFileSync(new URL('../src/native.tsx',import.meta.url),'utf8');
  const sf=ts.createSourceFile('native.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  const image=sf.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='NativeImage');
  assert.ok(image?.body,'shared native module must have a reviewable NativeImage boundary');
  let value;
  function visit(n){if(ts.isVariableDeclaration(n)&&ts.isIdentifier(n.name)&&n.name.text==='content')value=n.initializer;ts.forEachChild(n,visit);}
  visit(image.body);assert.ok(value);
  const changed=source.slice(0,value.getStart(sf))+'alt'+source.slice(value.end);
  const original=inspect(source,'packages/bb-markdown/src/native.tsx','community');
  const weakened=inspect(changed,'packages/bb-markdown/src/native.tsx','community');
  for(const rule of ['shared-policy-boundary','native-delegate']) {
    const select=rows=>rows.filter(f=>f.rule===rule).map(f=>f.sha256);
    assert.notDeepEqual(select(original.findings),select(weakened.findings));
  }
});
test('excluded-source imports and skipped source links cannot be granted a debt optout', () => {
  const f=fixture(`export * from './test/renderer.tsx';`);
  assert.throws(()=>checkSources(f),/closure violations/);
});


test('frozen shared React renderer admission and tree dispatch are a reviewed policy boundary', () => {
  const source=readFileSync(new URL('../src/react.tsx',import.meta.url),'utf8');
  const changed=source.replace('MarkdownRequestSchema.safeParse','UnreviewedSchema.safeParse');
  assert.notEqual(source,changed);
  const original=inspect(source,'packages/bb-markdown/src/react.tsx','community');
  const weakened=inspect(changed,'packages/bb-markdown/src/react.tsx','community');
  assert.notEqual(original.findings.find(f=>f.rule==='shared-policy-boundary').sha256,weakened.findings.find(f=>f.rule==='shared-policy-boundary').sha256);
});
test('frozen actual-SDK oracle routing changes require exact renewed review', () => {
  const source=readFileSync(new URL('../tools/check-native.mjs',import.meta.url),'utf8');
  const changed=source.replace("args.path==='@get-bb/plugin-sdk/app'","args.path==='@get-bb/plugin-sdk/other'");
  assert.notEqual(source,changed);
  const original=inspect(source,'packages/bb-markdown/tools/check-native.mjs','community');
  const altered=inspect(changed,'packages/bb-markdown/tools/check-native.mjs','community');
  assert.notEqual(original.findings.find(f=>f.rule==='technical-oracle-boundary').sha256,altered.findings.find(f=>f.rule==='technical-oracle-boundary').sha256);
});


test('domain wrappers derive source internally without inheriting shared leaf props', () => {
  const source=`import {Markdown as M} from '@phosphorco/bb-markdown/react'; const Message=memo(function Message({message}){return <M source={message.source} intent="prose" content={message.text}/>;}); const X=()=> <Message message={message}/>;`;
  assert.deepEqual(inspect(source).findings,[]);
  assert.ok(rules(`import {Markdown as M} from '@phosphorco/bb-markdown/react'; const Alias=memo(M); const X=()=> <Alias content={text}/>;`).includes('shared-context'));
});

test('reviewed frozen manifest admits exact boundaries and rejects actual weakened policies', () => {
  const root=mkdtempSync(join(scratch,'frozen-policy-'));
  const packageRoot=join(root,'packages','bb-markdown');
  mkdirSync(join(packageRoot,'src'),{recursive:true});mkdirSync(join(packageRoot,'tools'));
  for(const path of ['src/grammar.ts','src/native.tsx','src/react.tsx','tools/check-native.mjs']) {
    writeFileSync(join(packageRoot,path),readFileSync(new URL('../'+path,import.meta.url),'utf8'));
  }
  const roots=[{id:'community',path:root}], debt=JSON.parse(readFileSync(new URL('../tools/markdown-debt.json',import.meta.url),'utf8'));
  const baseline=checkSources({roots,debt});assert.equal(baseline.ok,true,JSON.stringify(baseline.findings));
  const grammarPath=join(packageRoot,'src/grammar.ts'), originalGrammar=readFileSync(grammarPath,'utf8');
  const sf=ts.createSourceFile('grammar.ts',originalGrammar,ts.ScriptTarget.Latest,true);
  const local=sf.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='safeLocal');assert.ok(local?.body);
  writeFileSync(grammarPath,originalGrammar.slice(0,local.body.getStart(sf))+'{return true;}'+originalGrammar.slice(local.body.end));
  assert.ok(checkSources({roots,debt}).findings.some(f=>f.rule==='shared-policy-boundary'&&f.path.endsWith('/grammar.ts')));
  writeFileSync(grammarPath,originalGrammar);
  const nativePath=join(packageRoot,'src/native.tsx'), originalNative=readFileSync(nativePath,'utf8');
  const nf=ts.createSourceFile('native.tsx',originalNative,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  const image=nf.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='NativeImage');assert.ok(image?.body);
  let initializer;function visit(n){if(ts.isVariableDeclaration(n)&&ts.isIdentifier(n.name)&&n.name.text==='content')initializer=n.initializer;ts.forEachChild(n,visit);}visit(image.body);assert.ok(initializer);
  writeFileSync(nativePath,originalNative.slice(0,initializer.getStart(nf))+'alt'+originalNative.slice(initializer.end));
  assert.ok(checkSources({roots,debt}).findings.some(f=>f.rule==='native-delegate'&&f.path.endsWith('/native.tsx')));
});
