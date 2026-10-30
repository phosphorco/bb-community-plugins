import {test,expect} from 'bun:test';
import {createFakePluginHost} from '@get-bb/plugin-sdk/testing';
import {registerThreadAttributeSupplier,createThreadFilterClient,createThreadAttributeHandlers} from '../src/bb.ts';
import {validateValues,valuesInputSchema,parseBounded,valuesOutputSchema,boundAttributeValues,LIMITS,METHODS} from '../src/index.ts';
import {checkThreadAttributeSupplier} from '../src/testing.ts';
const input={viewerKey:'cole',dimensionIds:['tag'],threads:[{id:'a',projectId:'p',parentThreadId:null}]};
const cell={dimensionId:'tag',values:[{id:'one',label:'One'}],state:'partial' as const,message:'Other memberships are unknown.'};
const output={rows:[{threadId:'a',cells:[cell]}],revision:'r',refreshAt:null};
test('attribute values require every requested row and dimension with honest evidence states',()=>{
 expect(validateValues(input,{...output,extra:true,rows:[{...output.rows[0],extra:true,cells:[{...cell,extra:true,values:[{...cell.values[0],extra:true}]}]}]}).rows[0]?.cells[0]?.values[0]?.label).toBe('One');
 for(const rows of [[],[...output.rows,...output.rows],[{threadId:'other',cells:[cell]}],[{threadId:'a',cells:[]}],[{threadId:'a',cells:[cell,cell]}],[{threadId:'a',cells:[{...cell,dimensionId:'other'}]}],[{threadId:'a',cells:[{...cell,state:'unknown'}]}],[{threadId:'a',cells:[{...cell,state:'not-applicable'}]}],[{threadId:'a',cells:[{...cell,values:[...cell.values,...cell.values]}]}]])expect(()=>validateValues(input,{...output,rows})).toThrow();
 for(const state of ['known','unknown','not-applicable'])expect(validateValues(input,{...output,rows:[{threadId:'a',cells:[{...cell,state,values:[]}]}]}).rows).toHaveLength(1);
 expect(()=>valuesInputSchema.parse({...input,extra:true})).toThrow();
 expect(()=>valuesInputSchema.parse({...input,threads:[{...input.threads[0],extra:true}]})).toThrow();
 expect(()=>validateValues({...input,dimensionIds:['tag','tag']},output)).toThrow();
 expect(()=>parseBounded(valuesOutputSchema,{...output,extra:'x'.repeat(300000)},262144)).toThrow();
});
test('one actual registration supplies both filters and row values, retaining old-client compatibility',async()=>{
 const host=createFakePluginHost({pluginId:'supplier'});
 registerThreadAttributeSupplier(host.bb,{dimensions:[{id:'tag',label:'Tags',multiple:true,description:''}],choices:()=>({choices:cell.values,nextCursor:null,revision:'r'}),match:request=>({rows:request.threads.map(t=>({threadId:t.id,matches:true})),revision:'r',coverage:'complete',message:null,refreshAt:null}),values:()=>output});
 const transport=async(args:any)=>{expect(args.pluginId).toBe('supplier');return host.harness.behavior.callRpc(args.method,args.input);};
 try{
  const client=createThreadFilterClient(transport,'supplier');expect((await client.describe())[0]?.id).toBe('tag');
  expect((await client.describeAttributes()).values).toBe(true);
  expect((await checkThreadAttributeSupplier({pluginId:'supplier',transport,cases:[{input,expected:[[cell]]}]})).cases).toBe(1);
  await expect(host.harness.behavior.callRpc(METHODS.values,{...input,dimensionIds:['other']})).rejects.toThrow();
 }finally{await host.harness.dispose();}
});
test('legacy and future value protocols negotiate without inventing display data',async()=>{
 for(const valueVersions of [undefined,[2],[]]){
  const client=createThreadFilterClient(async()=>({protocol:'bb.thread-filters',versions:[1],valueVersions,dimensions:[]}),'supplier');expect((await client.describeAttributes()).values).toBe(false);
 }
 const client=createThreadFilterClient(async()=>({protocol:'bb.thread-filters',versions:[1],valueVersions:[1,2],dimensions:[]}),'supplier');expect((await client.describeAttributes()).values).toBe(true);
 expect(()=>createThreadAttributeHandlers({dimensions:[],values:undefined} as any)).toThrow('display values');
});
test('oversize display values retain positives with explicit omitted/unknown states',()=>{
 const large={rows:Array.from({length:200},(_,i)=>({threadId:String(i),cells:[{dimensionId:'tag',state:'known' as const,message:null,values:Array.from({length:16},(_,j)=>({id:`${i}-${j}`+'x'.repeat(4000),label:'y'.repeat(512)}))}]})),revision:'r',refreshAt:null};
 const bounded=boundAttributeValues(large);expect(new TextEncoder().encode(JSON.stringify(bounded)).length).toBeLessThanOrEqual(LIMITS.outputBytes);
 expect(bounded.rows[0]?.cells[0]?.values.length).toBeGreaterThan(0);
 expect(bounded.rows.at(-1)?.cells[0]).toMatchObject({values:[],state:'unknown'});
 expect(bounded.rows.some(row=>row.cells.some(cell=>cell.state==='known'&&cell.values.length===0))).toBe(false);
});
