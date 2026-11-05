import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as rows from '../dist/index.js';
import {createInboxRowsHandlers,createInboxRowsClient,registerInboxRowsSupplier} from '../dist/bb.js';
import {runInboxRowsSupplierConformance} from '../dist/testing.js';
const input=(n=1)=>({version:1,archiveMode:'active',occurrences:Array.from({length:n},(_,i)=>({key:`k${i}`,threadId:`t${i}`}))});
const data=(threadId='t0')=>({v:1,threadId,title:'A row',groupPath:null,tags:[],tagOverflow:0,owners:[{key:'owner',name:'Cole',imageUrl:null,label:'Assignee: Cole',external:false}],ownerOverflow:0,ownerOverflowLabel:'',participants:[],participantOverflow:0,senderDescription:'Assignees: Cole',status:{tone:'quiet',label:'Quiet'},time:{at:0,text:'now',title:'Today'}});
const output=(i=input())=>({version:1,ownerKey:'person',revision:'r1',rows:i.occurrences.map(o=>({...o,state:'ready',revision:'r1',data:data(o.threadId)}))});
test('strict input nested fields, duplicate keys and occurrence cap; repeated IDs are valid',()=>{
 const i=input();for(const raw of [{...i,extra:1},{...i,occurrences:[{...i.occurrences[0],extra:1}]},{...i,occurrences:[i.occurrences[0],i.occurrences[0]]},input(17),{...i,archiveMode:'all'}])assert.throws(()=>rows.parseReadInput(raw));
 assert.doesNotThrow(()=>rows.parseReadInput({...i,occurrences:[{key:'a',threadId:'t'},{key:'b',threadId:'t'}]}));
});
test('additive output preserves nested extras and charges bytes before decode',()=>{
 const o=output();o.extra={field:true};o.rows[0].extra=true;o.rows[0].data.extra=1;o.rows[0].data.owners[0].extra=2;o.rows[0].data.status.extra=3;o.rows[0].data.time.extra=4;
 assert.deepEqual(rows.parseReadOutput(input(),o),o);
 assert.throws(()=>rows.parseReadOutput(input(),{...o,unknown:'x'.repeat(rows.LIMITS.responseBytes)}));
 assert.throws(()=>rows.parseReadOutput(input(),{...o,rows:[{...o.rows[0],data:{...o.rows[0].data,extra:'😀'.repeat(1000)}}]}));
});
test('exact occurrence identity, data identity and subject lens echoes',()=>{
 const i=input();for(const o of [{...output(),rows:[]},{...output(),rows:[output().rows[0],output().rows[0]]},{...output(),rows:[{...output().rows[0],threadId:'other'}]},{...output(),rows:[{...output().rows[0],data:data('other')}]}])assert.throws(()=>rows.parseReadOutput(i,o));
 assert.throws(()=>rows.parseReadOutput({...i,viewAs:'another'},output()));
});
test('canonical UTF8 covers escaping and Unicode; stamp admission keeps healthy sibling faces',()=>{
 assert.equal(rows.canonicalBytes('😀\n"'),Buffer.byteLength(JSON.stringify('😀\n"')));
 const i=input(2),o=output(i);o.rows[0].data.senderDescription='😀'.repeat(1000);
 const bounded=rows.boundReadOutput(i,o);assert.equal(bounded.rows[0].state,'unavailable');assert.equal(bounded.rows[0].reason,'oversize');assert.deepEqual(bounded.rows[1],o.rows[1]);
});
test('complete 16 row response admits in deterministic order within 60KiB',()=>{
 const i=input(16),o=output(i);for(const row of o.rows)row.data.extra='x'.repeat(3400);
 const result=rows.boundReadOutput(i,o);assert.ok(rows.canonicalBytes(result)<=rows.LIMITS.responseBytes);assert.ok(result.rows.some(r=>r.state==='unavailable'));assert.equal(result.rows[0].state,'ready');
});
test('real registration conformance; wrong presentation allowlist fails',async()=>{
 const c={pluginId:'inbox-sidebar-nerd',register:bb=>registerInboxRowsSupplier((contract,handlers)=>bb.rpc.register(contract,handlers),{read:async i=>output(i)}),cases:[{input:input(),check:o=>assert.equal(o.rows[0].state,'ready')}],presentation:{schema:rows.ROW_SCHEMA,methods:[rows.METHODS.read]}};
 const result=await runInboxRowsSupplierConformance(c);assert.equal(result.passed,true,JSON.stringify(result));
 const failed=await runInboxRowsSupplierConformance({...c,presentation:{schema:rows.ROW_SCHEMA,methods:[]}});assert.equal(failed.passed,false);assert.equal(failed.checks.find(c=>c.name==='presentation-read-allowlist').passed,false);
});
test('source error is a bounded unavailable response; invalid inputs are validation errors',async()=>{
 const h=createInboxRowsHandlers({read:async()=>{throw Error('no');}});assert.equal((await h.read(input())).rows[0].reason,'source-error');await assert.rejects(()=>h.read({...input(),extra:1}),{name:'ZodError'});
});
test('one client bounds an outstanding request and abort fences delivery',async()=>{
 let resolve;const c=createInboxRowsClient(()=>new Promise(r=>{resolve=r;}),'owner'),abort=new AbortController();
 const pending=c.read(input(),abort.signal);await new Promise(r=>setImmediate(r));await assert.rejects(()=>c.read(input()),/outstanding/);abort.abort();await assert.rejects(()=>pending,{name:'AbortError'});await assert.rejects(()=>c.read(input()),/outstanding/);resolve(output());await new Promise(r=>setImmediate(r));
});

test('full presentation stamp overhead is charged; data alone fitting is insufficient',()=>{
 const i=input(),o=output();const d=o.rows[0].data;d.extra='';const reserve=rows.LIMITS.stampBytes-rows.canonicalBytes(d);d.extra='x'.repeat(reserve);
 assert.equal(rows.canonicalBytes(d),4096);assert.ok(rows.canonicalBytes(rows.rowPresentation(d))>4096);
 assert.equal(rows.boundReadOutput(i,o).rows[0].reason,'oversize');
});

test('supplier deadline aborts source and bounds noncooperative concurrent work',async()=>{
 let pending=0;const gates=[],signals=[];
 const h=createInboxRowsHandlers({read:async(i,c,signal)=>{pending++;signals.push(signal);await new Promise(r=>gates.push(r));pending--;return output(i);}});
 const first=h.read(input()),second=h.read(input());await new Promise(r=>setImmediate(r));
 assert.equal((await h.read(input())).rows[0].reason,'source-error');assert.equal(pending,2);
 assert.equal((await first).rows[0].reason,'timeout');assert.equal((await second).rows[0].reason,'timeout');assert.ok(signals.every(s=>s.aborted));
 assert.equal((await h.read(input())).rows[0].reason,'source-error');assert.equal(pending,2);
 for(const release of gates)release();await new Promise(r=>setImmediate(r));assert.equal(pending,0);
});
