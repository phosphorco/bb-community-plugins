import {test,expect} from 'bun:test';
import {Database} from 'bun:sqlite';
import {TemplatesStore,type Db} from '../store';
import {databaseFixture,definition,published,alice,launchActor,launchRequest,nativeFixture} from './backend-fixtures';
import {legacyPrReviewDefinition,prReviewDefinition} from '../model';
import {LaunchService} from '../launch';
const actor={key:alice.identity.key,name:'Alice'};

test('published clock is transactional, empty authoritative, durable across reopen; drafts and journal do not advance it',async()=>{
 const f=databaseFixture(),n=nativeFixture();let service:LaunchService|undefined;try{const empty=f.store.publishedCatalog();expect(empty.revisions).toEqual([]);f.store.saveDraft(definition(),null,actor);expect(f.store.publishedCatalog()).toEqual(empty);f.store.publish('test-template',1,actor);const first=f.store.publishedCatalog();expect(first.version).toBe(empty.version+1);expect(first.revisions).toHaveLength(1);
  f.store.saveDraft({...definition(),description:'private unfinished'},1,actor);expect(f.store.publishedCatalog()).toEqual(first);service=new LaunchService(f.store,n.native);await service.launch(launchRequest(),launchActor());expect(f.store.publishedCatalog()).toEqual(first);expect(()=>f.store.unpublish('test-template',1,()=>{throw Error('expired owner');})).toThrow();expect(f.store.publishedCatalog()).toEqual(first);
  f.store.unpublish('test-template',1);const removed=f.store.publishedCatalog();expect(removed.revisions).toEqual([]);expect(removed.version).toBe(first.version+1);expect(first.revisions).toHaveLength(1);service.dispose();f.reopen();expect(f.store.publishedCatalog()).toEqual(removed);f.store.publish('test-template',2,actor);const second=f.store.publishedCatalog();f.store.remove({templateId:'test-template',expectedGeneration:2,expectedRevision:2,expectedLatestRevision:2},actor);const tombstone=f.store.publishedCatalog();expect(tombstone.revisions).toEqual([]);expect(tombstone.version).toBe(second.version+1);f.reopen();expect(f.store.publishedCatalog()).toEqual(tombstone);
 }finally{service?.dispose();f.close();}
});

test('catalog projection ignores unfinished draft corruption/bytes and seeds advance only actual publications',()=>{
 const f=databaseFixture();try{const starter={key:'starter',name:'New Thread Templates'};f.store.saveDraft(legacyPrReviewDefinition(),null,starter);f.store.publish('review-pr',1,starter);const before=f.store.publishedCatalog();const rawBefore=f.db.prepare('SELECT data FROM templates WHERE id=?').get('review-pr') as {data:string};const reordered=JSON.parse(rawBefore.data);reordered.published=Object.fromEntries(Object.entries(reordered.published).reverse());f.db.prepare('UPDATE templates SET data=? WHERE id=?').run(JSON.stringify(reordered),'review-pr');expect(f.store.publishedCatalog()).toEqual(before);f.store.seed();const upgraded=f.store.publishedCatalog();expect(upgraded.catalogId).toBe(before.catalogId);expect(upgraded.version).toBeGreaterThan(before.version);expect(upgraded.revisions.find(r=>r.templateId==='review-pr')!.definition).toEqual(prReviewDefinition());f.store.seed();expect(f.store.publishedCatalog()).toEqual(upgraded);
  const raw=f.db.prepare('SELECT data FROM templates WHERE id=?').get('review-pr') as {data:string};const entry=JSON.parse(raw.data);entry.draft={unreadable:'x'.repeat(500000)};f.db.prepare('UPDATE templates SET data=? WHERE id=?').run(JSON.stringify(entry),'review-pr');expect(f.store.publishedCatalog()).toEqual(upgraded);expect(()=>f.store.catalog()).toThrow();
 }finally{f.close();}
});

test('version exhaustion rejects publication atomically instead of returning unsafe cache order; namespaces isolate stores',()=>{
 const f=databaseFixture(),other=databaseFixture();try{expect(f.store.publishedCatalog().catalogId).not.toBe(other.store.publishedCatalog().catalogId);f.store.saveDraft(definition(),null,actor);f.db.exec('UPDATE template_catalog_clock SET version=9007199254740991');expect(()=>f.store.publish('test-template',1,actor)).toThrow('exhausted');expect(f.store.get('test-template')!.published).toBeNull();expect(f.store.revision('test-template',1)).toBeNull();expect(f.store.publishedCatalog().version).toBe(Number.MAX_SAFE_INTEGER);
 }finally{f.close();other.close();}
});

test('published projection and version share a SQLite snapshot when another connection unpublishes between the reads',()=>{
 const f=databaseFixture();let other:import('bun:sqlite').Database|undefined;
 try{f.db.exec('PRAGMA journal_mode=WAL');published(f);const prior=f.store.publishedCatalog();other=new Database(f.db.filename);const writer=new TemplatesStore(other as unknown as Db);const backend=f.db as unknown as Db;let interleaved=false;
  const reader=new TemplatesStore(new Proxy(backend,{get(db,key){
   if(key==='prepare')return (sql:string)=>{const statement=db.prepare(sql);return new Proxy(statement,{get(target,key){if(key==='get'&&sql.startsWith('SELECT catalog_id,version'))return (...args:unknown[])=>{const result=target.get(...args);if(!interleaved){interleaved=true;writer.unpublish('test-template',1);}return result;};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});};
   const value=Reflect.get(db,key,db);return typeof value==='function'?value.bind(db):value;
  }}));
  expect(reader.publishedCatalog()).toEqual(prior);expect(interleaved).toBe(true);expect(writer.publishedCatalog()).toMatchObject({catalogId:prior.catalogId,version:prior.version+1,revisions:[]});expect(reader.publishedCatalog()).toEqual(writer.publishedCatalog());
 }finally{other?.close();f.close();}
});
