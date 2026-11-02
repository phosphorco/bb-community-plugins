import { test, expect } from 'bun:test';
import { definition } from './backend-fixtures';
import { defaultInputs, definitionSchema, inputsSchema, renderText, starterDefinitions, legacyGenericStarterDefinitions, validateDefinition, validateInputs } from '../model';

test('interpolation is literal, supports fallbacks, and does not execute inputs',()=>{
  expect(renderText('Hello {{task}} / {{missing|fallback}}',{task:'$(touch /tmp/never) {{other}}'})).toBe('Hello $(touch /tmp/never) {{other}} / fallback');
});
test('definition validation blocks unknown tokens, unstable keys, invalid defaults/options/ranges',()=>{
  const d=definition({fields:[{key:'same',label:'Pick',type:'select',order:0,required:false,options:[{value:'a',label:'A'},{value:'a',label:'Again'}],default:'missing'},{key:'same',label:'',type:'number',order:1,required:false,validation:{min:10,max:2}}],promptTemplate:'{{unknown}}'});
  const issues=validateDefinition(d);expect(issues.some(i=>i.message.includes('Unknown field'))).toBe(true);expect(issues.some(i=>i.message.includes('unique'))).toBe(true);expect(issues.some(i=>i.path.endsWith('default'))).toBe(true);expect(issues.some(i=>i.message.includes('Minimum exceeds'))).toBe(true);
  expect(validateDefinition(definition({fields:[{key:'__proto__',label:'Bad',type:'text',order:0,required:false}]})).some(i=>i.path==='fields.0.key')).toBe(true);
});
test('all six types validate presence, finite numbers, URL, options, boolean false and typed defaults',()=>{
  const d=definition({fields:[{key:'task',label:'Task',type:'text',order:0,required:true,validation:{minLength:3,maxLength:6}},{key:'notes',label:'Notes',type:'textarea',order:1,required:false},{key:'url',label:'URL',type:'url',order:2,required:true},{key:'count',label:'Count',type:'number',order:3,required:true,validation:{min:1,max:3}},{key:'pick',label:'Pick',type:'select',order:4,required:true,options:[{value:'a',label:'A'}]},{key:'enabled',label:'Enabled',type:'checkbox',order:5,required:true,default:false}]});
  expect(defaultInputs(d)).toEqual({enabled:false});
  expect(validateInputs(d,{task:'test',url:'https://example.com',count:2,pick:'a'}).issues).toEqual([]);
  expect(validateInputs(d,{task:'a',url:'javascript:alert(1)',count:Infinity,pick:'b',enabled:'yes',extra:'bad'}).issues.length).toBeGreaterThanOrEqual(6);
  expect(validateInputs(d,{}).issues.map(i=>i.path)).toContain('task');
});
test('unfinished drafts are structurally valid but cannot publish; templates and total input are bounded',()=>{
  expect(definitionSchema.safeParse(definition({name:'',promptTemplate:''})).success).toBe(true);
  expect(validateDefinition(definition({name:'',promptTemplate:''})).length).toBeGreaterThan(0);
  expect(inputsSchema.safeParse({task:'é'.repeat(40000)}).success).toBe(false);
  expect(()=>renderText('{{task}}'.repeat(100),{task:'x'.repeat(60000)})).toThrow('size limit');
});
test('fresh starters are only customer Feedback and PR with real choose-at-launch context; generic values remain audit-only',()=>{
  const starters=starterDefinitions();expect(starters.map(d=>d.id)).toEqual(['feedback-session','review-pr']);
  for(const d of starters){expect(d.destination.kind).toBe('choose-at-launch');expect(validateDefinition(d)).toEqual([]);}
  expect(legacyGenericStarterDefinitions().map(d=>d.id)).toEqual(['fix-bug','explore-idea','start-project','implement-change']);
});

test('binary checkbox without explicit default normalizes false for required and optional fields',()=>{
  const d=definition({fields:[{key:'requiredCheck',label:'Required checkbox',type:'checkbox',order:0,required:true},{key:'optionalCheck',label:'Optional checkbox',type:'checkbox',order:1,required:false}],promptTemplate:'Required {{requiredCheck}} / Optional {{optionalCheck}}'});
  expect(defaultInputs(d)).toEqual({requiredCheck:false,optionalCheck:false});const checked=validateInputs(d,{});expect(checked.issues).toEqual([]);expect(renderText(d.promptTemplate,checked.inputs)).toBe('Required false / Optional false');expect(validateInputs(d,{requiredCheck:true,optionalCheck:false}).inputs).toEqual({requiredCheck:true,optionalCheck:false});
});

test('customer PR Review preserves subject/focus and independent posted review sequencing without unconditional merge',()=>{
  const pr=starterDefinitions().find(d=>d.id==='review-pr')!;expect(pr.name).toBe('PR Review');expect(validateInputs(pr,{pr_url:'https://example.com/pr/7'}).issues.map(i=>i.path)).toContain('subject');const values=validateInputs(pr,{pr_url:'https://example.com/pr/7',subject:'Typed routing repair',focus:'Restart windows and provenance'});expect(values.issues).toEqual([]);const prompt=renderText(pr.promptTemplate,values.inputs);expect(renderText(pr.titleTemplate,values.inputs)).toBe('PR Review: Typed routing repair');for(const text of ['Typed routing repair','Restart windows and provenance','independent second mate','run and post a /github-pr-review','/pr-review','/bb-delegation-mode','Address initial feedback thoughtfully before any squash-merge step.'])expect(prompt).toContain(text);expect(prompt).not.toContain('Merge the PR');expect(renderText(pr.promptTemplate,{pr_url:'https://example.com/pr/7',subject:'Subject'})).toContain('Assess correctness, regressions, and missing tests');expect(pr.destination.kind).toBe('choose-at-launch');
});
test('customer Feedback Session preserves contributors, subject, focus and feedback/review separation with exact named skills',()=>{
  const feedback=starterDefinitions().find(d=>d.id==='feedback-session')!;expect(feedback.name).toBe('Feedback Session');expect(validateInputs(feedback,{}).issues.map(i=>i.path)).toEqual(['subject','focus']);const values=validateInputs(feedback,{subject:'Preview signup flow',focus:'Keyboard and recovery paths',contributors:'Alice and Bob',target_url:'https://preview.example.com'});expect(values.issues).toEqual([]);const prompt=renderText(feedback.promptTemplate,values.inputs);expect(renderText(feedback.titleTemplate,values.inputs)).toBe('Feedback Session: Preview signup flow');for(const text of ['Preview signup flow','Keyboard and recovery paths','Alice and Bob','https://preview.example.com','/rapid-fire-feedback-in-bb-mode','/thread-brief','/workbench-plan','subject, intent,','feedback giver and reviewer','completion separately from','review and approval','multiple contributors','ready to receive the first feedback item'])expect(prompt).toContain(text);const fallback=renderText(feedback.promptTemplate,{subject:'Subject',focus:'Focus'});expect(fallback).toContain("selected project's current environment/context");expect(fallback).toContain('Multiple people may contribute');expect(fallback).not.toContain('Oliver');expect(feedback.destination.kind).toBe('choose-at-launch');
});
