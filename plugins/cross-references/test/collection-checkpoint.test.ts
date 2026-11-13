import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { CandidateV1Schema, LIMITS, type TaggedCandidateV1 } from '@phosphorco/bb-context-recognition';
import { RecognitionCheckpointCache } from '../collection-checkpoint.ts';
import { crossReferencesMigrations } from '../store.ts';

test('durable UTF-8 budget does not remove existing hot-cache reuse across source attempts',t=>{
 const db=new Database(':memory:');t.after(()=>db.close());for(const sql of crossReferencesMigrations)db.exec(sql);
 const values:TaggedCandidateV1[]=Array.from({length:64},(_,i)=>({
  candidate:CandidateV1Schema.parse({span:{start:0,end:5},match:'TOKEN',source:{provider:'test.issue',id:'あ'.repeat(500)+i,kind:'issue'},confidence:'high',provenance:{basis:'explicit',explanation:'あ'.repeat(100)}}),
  origin:'contributed',pluginId:'supplier'+(i%4),specificity:'typed',providers:['test.issue'],
 }));
 // Each supplier's wire result fits its real response budget. Tagging/fanout
 // still fits the pre-existing UTF-16 cache limit, while exceeding64KiB UTF-8.
 for(let supplier=0;supplier<4;supplier++)assert.ok(Buffer.byteLength(JSON.stringify({candidates:values.filter(v=>v.pluginId==='supplier'+supplier).map(v=>v.candidate)}))<=LIMITS.responseBytes);
 assert.ok(JSON.stringify(values).length<=65536);assert.ok(Buffer.byteLength(JSON.stringify(values))>65536);
 const first=new RecognitionCheckpointCache(db,()=>true);first.set('key',values);
 assert.deepEqual(first.get('key'),values);assert.equal(db.prepare('SELECT 1 FROM assistant_link_recognition_cache').get(),undefined);
 const next=new RecognitionCheckpointCache(db,()=>true,first);assert.deepEqual(next.get('key'),values);
});
