import {test,expect} from 'bun:test';
import {renderText,createRenderContext,renderContextSchema,validateTemplate,TemplateError} from '../template-renderer';
import {definition} from './backend-fixtures';
import {validateDefinition,definitionSchema} from '../model';
const c=createRenderContext('UTC',Date.parse('2026-11-02T00:04:05Z'));

test('legacy exact fallback bytes, helper-named fields, false0, plaintext and non-recursive values',()=>{
 expect(renderText('{{field|  literal  }} / {{zero|x}} / {{flag|x}} / {{upper}}',{zero:0,flag:false,upper:'<b>& {{@now}}'})).toBe('  literal   / 0 / false / <b>& {{@now}}');expect(renderText('{{x|a " literal }}',{})).toBe('a " literal ');expect(renderText('{{default value "fallback"}}',{value:false})).toBe('false');expect(renderText('{{default value "fallback"}}',{value:0})).toBe('0');
});
test('helpers and nested conditionals use own fields, strict equality, boolean truthiness and quoted closing braces',()=>{
 const source='{{#if (and (eq state "done") (not blocked))}}{{upper (trim name)}}{{else}}{{#unless count}}{{concat "wait }} " (default absent "later")}}{{/unless}}{{/if}}';expect(renderText(source,{state:'done',blocked:false,name:'  ready  '})).toBe('READY');expect(renderText(source,{state:'no',blocked:false,count:0})).toBe('wait }} later');expect(renderText('{{eq n "0"}}',{n:0})).toBe('false');expect(renderText('{{toString|missing}}',{})).toBe('missing');
});
test('all branches validate references, helpers, locations, malformed blocks and properties before publication',()=>{
 const issues=validateTemplate('first\n{{#if yes}}ok{{else}}{{upper missing}}{{/if}}',['yes']);expect(issues[0]).toMatchObject({line:2,message:'Unknown field missing'});
 for(const bad of ['{{#each x}}{{/each}}','{{eval x}}','{{upper x.y}}','{{#if yes}}x{{/unless}}','{{#if yes}}{{else}}{{else}}{{/if}}','{{concat "unterminated}}','{{concat (upper x}}'])expect(validateTemplate(bad,['yes','x']).length).toBeGreaterThan(0);
 expect(validateTemplate('{{#if yes}}ok{{else}}{{date @now "YYYY"}}{{/if}}',['yes'])[0]!.message).toContain('Unknown date format');expect(validateTemplate('{{date "2026-02-30T00:00:00Z"}}',[])[0]!.message).toContain('calendar');
});
test('Unicode whole-string lower keeps final sigma and output/work budgets preflight expansion',()=>{
 expect(renderText('{{lower value}}',{value:'ΟΣ'})).toBe('ος');expect(renderText('{{upper value}}',{value:'Straße'})).toBe('STRASSE');expect(()=>renderText('{{upper value}}',{value:'ﬃ'.repeat(100)},200)).toThrow('size limit');expect(()=>renderText('{{concat value value}}',{value:'x'.repeat(100)},150)).toThrow('size limit');
 const nested='{{'+('upper ('.repeat(40))+'x'+')'.repeat(40)+'}}';expect(()=>renderText(nested,{x:'x'})).toThrow('nesting');expect(()=>renderText('{{concat '+Array.from({length:33},()=> 'x').join(' ')+'}}',{x:'x'})).toThrow('argument');expect(()=>renderText('x'.repeat(300000),{})).toThrow('size limit');
});
test('explicit clock, UTC midnight, month versus minute, DST and non-hour zone offsets',()=>{
 expect(renderText('{{@now}}',{},undefined,c)).toBe('2026-11-02 00:04:05 GMT+00:00 [UTC]');expect(renderText('{{date @now "MM mm EEE"}}',{},undefined,c)).toBe('11 04 Mon GMT+00:00 [UTC]');expect(()=>renderText('{{@now}}',{})).toThrow('frozen render context');
 for(const [iso,offset,hour] of [['2026-01-15T12:00:00Z','GMT+01:00','13'],['2026-07-15T12:00:00Z','GMT+02:00','14']])expect(renderText('{{date @now "HH"}}',{},undefined,createRenderContext('Europe/Berlin',Date.parse(iso!)))).toBe(`${hour} ${offset} [Europe/Berlin]`);
 expect(renderText('{{date @now "yyyy"}}',{},undefined,createRenderContext('Asia/Kathmandu',c.instant))).toBe('2026 GMT+05:45 [Asia/Kathmandu]');
});
test('strict calendar/zone/instant boundaries and era-aware astronomical years never normalize invalid input',()=>{
 for(const iso of ['2026-02-30T00:00:00Z','2025-02-29T00:00:00Z','2026-01-01T24:00:00Z','2026-01-01T00:00:00+24:00','2026-01-01T00:00:00'])expect(()=>renderText('{{date value}}',{value:iso},undefined,c)).toThrow();
 expect(renderText('{{date "0000-01-01T00:00:00Z" "yyyy"}}',{})).toBe('0000 GMT+00:00 [UTC]');expect(renderText('{{date @now "yyyy"}}',{},undefined,createRenderContext('UTC',Date.parse('-000001-01-01T00:00:00Z')))).toBe('-000001 GMT+00:00 [UTC]');expect(renderText('{{date @now "yyyy"}}',{},undefined,c)).toBe('2026 GMT+00:00 [UTC]');
 expect(renderContextSchema.safeParse({...c,instant:Infinity}).success).toBe(false);expect(renderContextSchema.safeParse({...c,timeZone:'+01:00'}).success).toBe(false);expect(renderContextSchema.safeParse({...c,timeZone:'Bad/Zone'}).success).toBe(false);const draft=definitionSchema.parse(definition({timeZone:'Bad/Zone'}));expect(validateDefinition(draft).some(i=>i.path==='timeZone')).toBe(true);expect(()=>renderText('x'.repeat(10),{},5)).toThrow(TemplateError);
});

test('DST boundaries and explicit ISO offsets use the evaluated instant, with no ambiguous date parsing',()=>{
 for(const [iso,expected] of [['2026-03-29T00:59:00Z','01:59 GMT+01:00'],['2026-03-29T01:00:00Z','03:00 GMT+02:00'],['2026-10-25T00:30:00Z','02:30 GMT+02:00'],['2026-10-25T01:30:00Z','02:30 GMT+01:00']])expect(renderText('{{date @now "HH:mm"}}',{},undefined,createRenderContext('Europe/Berlin',Date.parse(iso!)))).toBe(expected+' [Europe/Berlin]');expect(renderText('{{date "2026-11-02T02:04:05+02:00" "HH:mm"}}',{})).toBe('00:04 GMT+00:00 [UTC]');expect(()=>renderText('{{#if false}}yes{{else}}{{date @now "yyyy年"}}{{/if}}',{false:true},undefined,c)).toThrow('Unknown date format');
});

test('aggregate intermediate work and AST node budgets stop nested or repeated expansion before final allocation',()=>{
 const repeated=Array.from({length:30},()=> '{{eq (upper value) (upper value)}}').join('');expect(()=>renderText(repeated,{value:'a'.repeat(50000)})).toThrow('work budget');expect(()=>renderText('{{x}}'.repeat(4100),{x:''})).toThrow('node budget');const format='yyyy'.repeat(1000);expect(()=>renderText('{{date @now fmt}}',{fmt:format},4500,createRenderContext('UTC',8640000000000000))).toThrow('size limit');
});

test('UTF8 limits count multibyte and unpaired surrogate replacement, including lowercase byte expansion',()=>{
 expect(renderText('{{x}}',{x:'😀😀'},8)).toBe('😀😀');expect(()=>renderText('{{x}}',{x:'😀😀'},7)).toThrow('size limit');expect(renderText('{{x}}',{x:'\ud800\ud800'},6)).toBe('\ud800\ud800');expect(()=>renderText('{{x}}',{x:'\ud800\ud800'},5)).toThrow('size limit');expect(()=>renderText('{{lower value}}',{value:'İ'.repeat(10)},25)).toThrow('size limit');
});


test('many unknown references share bounded location indexing and retain UTF16 first/last positions',()=>{
 const chunk='\n'.repeat(100)+'{{missing}}',source=chunk.repeat(2048);
 const issues=validateTemplate(source,[]);expect(issues).toHaveLength(2048);
 expect(issues[0]).toEqual({message:'Unknown field missing',offset:102,line:101,column:3});
 expect(issues.at(-1)).toEqual({message:'Unknown field missing',offset:2047*chunk.length+102,line:204801,column:3});
 expect(validateTemplate('😀\n😀{{missing}}',[])[0]).toMatchObject({offset:7,line:2,column:5});
});
