import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {threadResource,canonicalizeResource,projectionPayloadDigest,sha256Hex,type Resource} from '../canonical.ts';
import {CrossReferenceStore,crossReferencesMigrations,enableForeignKeys} from '../store.ts';
import {collectConversationMentions} from '../mention-collection.ts';
import {createMentionReader,boundedCoverageReasons} from '../mention-query.ts';
const href='https://example.test/referent',source=threadResource('proj_v2','thr_v2source',{label:'Source'}),identity={provider:source.provider,keys:source.keys};
function open(file=':memory:',migrate=true){const db=new Database(file);enableForeignKeys(db);if(migrate)for(const m of crossReferencesMigrations)db.exec(m);return {db,store:new CrossReferenceStore(db),reader:createMentionReader(db)};}
async function scan(texts:string[],threadId='thr_v2source'){
 return collectConversationMentions({messages:texts.map((text,i)=>({id:`msg_${i}`,text,createdAt:100+i,messageSeq:i+7,anchorSeq:null,role:i%2?'assistant':'user'})),context:{consumer:{pluginId:'cross-references'},threadId,projectId:'proj_v2',links:[]},clients:[],getThread:async id=>({id,projectId:'proj_v2'}),signal:new AbortController().signal});
}
const query={version:2 as const,query:{kind:'authored-url' as const,href},pageSize:25};
test('actual collector/store read: exact counts, original excerpts, evidence-only edits, no-op clocks and partial retained children survive reopen',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'bb-v2-store-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const file=join(dir,'data.db');let f=open(file);t.after(()=>{if(f.db.open)f.db.close();});
 f.store.replaceConversationMentions(source,await scan([`First ${href}.`,`🙂 Another ${href}.`]));
 const page=f.reader.read(query);assert.equal(page.status,'page');if(page.status!=='page')return;
 assert.deepEqual(page.counts,{retainedOccurrences:2,confirmedOccurrences:2,unconfirmedOccurrences:0,producerClaims:1,indexedSources:1,claimsWithoutLocations:0,excerptUnavailable:0});
 assert.ok(page.items.every((i:any)=>i.kind==='occurrence'&&i.excerpt.state==='ready'&&i.authoredUrlState==='exact'));
 const projection=f.store.getProjection({producerPluginId:'cross-references',source:identity}).projection!,state=f.store.mentionState(identity);
 f.store.replaceConversationMentions(source,await scan([`First ${href}.`,`🙂 Another ${href}.`]));
 assert.equal(f.store.mentionState(identity).revision,state.revision);assert.equal(f.reader.read(query).status,'page');
 const conditional=f.reader.read({...query,ifSnapshot:page.snapshot});assert.equal(conditional.status,'not-modified');if(conditional.status==='not-modified')assert.ok(conditional.coverage.authoredUrlCoverage.watermark);
 f.store.replaceConversationMentions(source,await scan([`Changed context ${href}.`,`🙂 Another ${href}.`]));
 assert.equal(f.store.getProjection({producerPluginId:'cross-references',source:identity}).projection!.revision,projection.revision);assert.notEqual(f.store.mentionState(identity).revision,state.revision);
 const incomplete=await scan([]);incomplete.coverage.timelineComplete=false;incomplete.coverage.reasons=['supplier-failure'];f.store.replaceConversationMentions(source,incomplete);
 assert.equal((f.db.prepare('SELECT COUNT(*) n FROM mention_excerpts').get() as any).n,2);
 f.db.close();f=open(file,false);const retained=f.reader.read(query);assert.equal(retained.status,'page');if(retained.status==='page'){assert.equal(retained.counts.confirmedOccurrences,0);assert.equal(retained.counts.excerptUnavailable,0);assert.equal(retained.items.length,2);}
 f.store.replaceConversationMentions(source,await scan([]),true);const gone=f.reader.read(query);assert.equal(gone.status,'page');if(gone.status==='page')assert.equal(gone.counts.producerClaims,0);assert.equal((f.db.prepare('SELECT COUNT(*) n FROM mention_excerpts').get() as any).n,0);
});
test('direct full-key active membership and literal missing-source/producer scopes; unknown coverage independent of item snapshot',async t=>{
 const f=open();t.after(()=>f.db.close());f.store.replaceConversationMentions(source,await scan([`Here ${href}`]));
 const original=f.reader.read(query);assert.equal(original.status,'page');if(original.status!=='page')return;
 const other=threadResource('proj_v2','thr_other',{label:'Other'}),s=await scan(['There https://different.test/a'],'thr_other');
 // A legacy P1 observation has no source spelling proof; do not reconstruct it.
 for(const row of s.occurrences){delete row.excerpt;delete row.exactAuthoredHref;row.authoredUrlState='unknown';}f.store.replaceConversationMentions(other,s);
 const unchanged=f.reader.read({...query,ifSnapshot:original.snapshot});assert.equal(unchanged.status,'not-modified');if(unchanged.status==='not-modified')assert.equal(unchanged.coverage.authoredUrlCoverage.unknownLocations,1);
 const missing=f.reader.read({...query,source:{provider:'bb',keys:{project:'proj_none',thread:'thr_none'}}});assert.equal(missing.status,'page');if(missing.status==='page'){assert.equal(missing.counts.producerClaims,0);assert.equal(missing.coverage.authoredUrlCoverage.unknownLocations,0);}
 const filtered=f.reader.read({...query,source:identity,producerPluginId:'elsewhere'});assert.equal(filtered.status,'page');if(filtered.status==='page'){assert.equal(filtered.items.length,0);assert.equal(filtered.coverage.authoredUrlCoverage.unknownLocations,0);}
 f.db.prepare("UPDATE source_projections SET tombstone=1 WHERE producer_plugin_id='cross-references'").run();
 const orphan=f.reader.read(query);assert.equal(orphan.status,'page');if(orphan.status==='page'){assert.equal(orphan.items.length,0);assert.equal(orphan.coverage.authoredUrlCoverage.unknownLocations,0);}
});
test('external actual applyProjection CAS/duplicate/no-op, null binding and delete/reappear invalidate only relevant snapshots',async t=>{
 const f=open();t.after(()=>f.db.close());f.store.replaceConversationMentions(source,await scan([href]));
 const p=f.store.getProjection({producerPluginId:'cross-references',source:identity}).projection!,base=f.reader.read(query);assert.equal(base.status,'page');if(base.status!=='page')return;
 const command={...p,protocolVersion:1 as const,expectedRevision:p.revision,revision:p.revision,mutationId:'00000000-0000-4000-8000-000000000099'};
 assert.equal(f.store.applyProjection({...command,revision:p.revision+1,expectedRevision:0}).outcome,'cas-mismatch');assert.equal((f.reader.read(query) as any).snapshot,base.snapshot);
 assert.equal(f.store.applyProjection(command).outcome,'equal');assert.equal((f.reader.read(query) as any).snapshot,base.snapshot,'equal payload preserves graph revision');
 const target={...p.targets[0]!,presentation:{...p.targets[0]!.presentation,label:'Changed presentation'}};
 const changed={...command,revision:p.revision+1,targets:[target],payloadDigest:projectionPayloadDigest('cross-references',canonicalizeResource(source),false,[canonicalizeResource(target)])};
 assert.equal(f.store.applyProjection(changed).outcome,'applied');assert.equal(f.store.applyProjection(changed).outcome,'duplicate');
 const unconfirmed=f.reader.read(query);assert.equal(unconfirmed.status,'page');if(unconfirmed.status==='page'){assert.equal(unconfirmed.counts.confirmedOccurrences,0);assert.notEqual(unconfirmed.snapshot,base.snapshot);}
 f.db.prepare('UPDATE mention_streams SET bound_graph_revision=NULL').run();assert.equal((f.reader.read(query) as any).counts.confirmedOccurrences,0);
 const deletion={...changed,revision:changed.revision+1,expectedRevision:changed.revision,mutationId:'00000000-0000-4000-8000-000000000100',tombstone:true,targets:[],payloadDigest:projectionPayloadDigest('cross-references',canonicalizeResource(source),true,[])};
 assert.equal(f.store.applyProjection(deletion).outcome,'applied');const removed=f.reader.read(query) as any;assert.equal(removed.counts.producerClaims,0);
 const reappear={...changed,revision:deletion.revision+1,expectedRevision:deletion.revision,mutationId:'00000000-0000-4000-8000-000000000101'};
 assert.equal(f.store.applyProjection(reappear).outcome,'applied');assert.notEqual((f.reader.read(query) as any).snapshot,base.snapshot);
});
test('one shared1MiB budget shortens an actual100-location page and cursor emits every retained location exactly once',async t=>{
 const f=open();t.after(()=>f.db.close());const wide:Resource={provider:'wide',keys:{thread:'thr_wide',...Object.fromEntries(Array.from({length:15},(_,i)=>['pad'+i,'x'.repeat(500)]))},presentation:{label:'L'.repeat(256),detail:'D'.repeat(1024),url:'https://wide.test/'+ 'a'.repeat(1900)}};
 f.store.replaceConversationMentions(wide,await scan(Array.from({length:100},()=>`See ${href}`),'thr_wide'));
 const all=new Set<string>();let cursor:string|undefined,first=true;
 do{const page=f.reader.read({...query,pageSize:100,...(cursor?{cursor}:{})});assert.equal(page.status,'page');if(page.status!=='page')return;
  assert.ok(Buffer.byteLength(JSON.stringify(page))<=1048576);if(first){assert.ok(page.items.length<100);assert.ok(page.nextCursor);first=false;}
  for(const item of page.items){assert.equal(item.kind,'occurrence');if(item.kind==='occurrence'){assert.equal(all.has(item.occurrenceKey),false);all.add(item.occurrenceKey);}}
  cursor=page.nextCursor??undefined;
 }while(cursor);assert.equal(all.size,100);
});
test('safe coverage reasons measure UTF8 and account for mapped detail',()=>{
 const out=boundedCoverageReasons(['界'.repeat(128),'🙂'.repeat(128),'recognition-budget','unknown']);assert.ok(out.reasons.every(r=>Buffer.byteLength(r)<=128));assert.equal(out.reasonsClipped,true);assert.deepEqual(out.reasons,['recognition-budget','unknown-collection-reason']);
});

test('original prose URL spelling survives canonical identity normalization; literal matching never invents an alias occurrence',async t=>{
 const f=open();t.after(()=>f.db.close());const original='https://Example.test/Path?x=1';f.store.replaceConversationMentions(source,await scan(['See '+original]));
 const exact=f.reader.read({version:2,query:{kind:'authored-url',href:original}});assert.equal(exact.status,'page');if(exact.status==='page'){assert.equal(exact.counts.retainedOccurrences,1);assert.equal((exact.items[0] as any).provenance.authoredHref,original);}
 const canonical=f.reader.read({version:2,query:{kind:'authored-url',href:'https://example.test/Path?x=1'}});assert.equal(canonical.status,'page');if(canonical.status==='page'){assert.equal(canonical.counts.retainedOccurrences,0);assert.ok(canonical.items.every(i=>i.kind==='claim-without-evidence'));}
});
