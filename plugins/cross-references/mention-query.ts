/** Direct V2 queries over primary claims/evidence. No source I/O or enqueue. */
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { canonicalJson } from '@phosphorco/bb-context-recognition';
import { canonicalizeIdentity,canonicalizeResource,serializeResource,sha256Hex,utf8ByteLength,
 listMentionsInputV2Schema,listMentionsOutputV2Schema,locatorOutputV2Schema,safeAuthoredHrefSchema,MENTION_V2_LIMITS,
 type ListMentionsInputV2,type ListMentionsOutputV2,type MentionsChangedV2,type CrossReferencesChangedSignal,type ResourceIdentity } from '@phosphorco/bb-cross-references';
import { persistedExcerpt } from './mention-excerpts.ts';
import { MentionLocationSchema } from './mention-evidence.ts';
const binary=(a:string,b:string)=>Buffer.compare(Buffer.from(a),Buffer.from(b));
const tail=(r:any)=>[r.source_digest,r.producer_plugin_id,r.target_digest,r.item_kind,r.sort_message_id,r.sort_span_start,r.item_key] as const;
const compare=(a:any,b:any)=>{if(a.sort_time!==b.sort_time)return b.sort_time-a.sort_time;const aa=tail(a),bb=tail(b);for(let i=0;i<aa.length;i++){const x=aa[i]!,y=bb[i]!,c=typeof x==='number'&&typeof y==='number'?x-y:binary(String(x),String(y));if(c)return c;}return 0;};
const nonnegative=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const cursorSchema=z.strictObject({v:z.literal(2),codec:z.literal(1),queryHash:z.string().regex(/^[a-f0-9]{64}$/),snapshot:z.string().regex(/^[a-f0-9]{64}$/),
 after:z.tuple([nonnegative.max(8640000000000000),z.string().regex(/^[a-f0-9]{64}$/),z.string().max(64),z.string().regex(/^[a-f0-9]{64}$/),z.union([z.literal(0),z.literal(1)]),z.string().max(256),nonnegative,z.string().max(64)])});
const knownReasons=new Set(['recognition-budget','thread-verification','file-verification','source-text-budget','message-window-budget','exclusion-budget','context-link-budget','candidate-budget','location-budget','message-budget','supplier-failure','supplier-coverage','missing-message-seq','timeline-50-pages','projection-payload-budget','legacy-claim','producer-no-evidence','graph-changed-since-evidence','unknown-collection-reason']);
export function boundedCoverageReasons(values:readonly unknown[]):{reasons:string[];reasonsClipped:boolean}{
 let clipped=false;const set=new Set<string>();for(const raw of values){const code=typeof raw==='string'&&knownReasons.has(raw)&&utf8ByteLength(raw)<=128?raw:'unknown-collection-reason';if(code!==raw)clipped=true;set.add(code);}
 const ordered=[...set].sort(binary);return {reasons:ordered.slice(0,32),reasonsClipped:clipped||ordered.length>32};
}
class ReadBudget extends Error {}
function frame(h:ReturnType<typeof createHash>,v:unknown){const b=Buffer.from(canonicalJson(v));h.update(String(b.length)+':');h.update(b);}
/** One reader/DB lifetime; prepared SQL bounded independently of user text. */
export function createMentionReader(db:Database.Database){
 const prepared=new Map<string,Database.Statement>(),identities=new Map<number,string>();
 db.function('cr_v2_identity_digest',{deterministic:true},(id:number,provider:string,keys:string)=>{
  let value=identities.get(id);if(value)return value;value=canonicalizeIdentity({provider,keys:JSON.parse(keys)}).identityDigest;
  if(identities.size>=65536)identities.delete(identities.keys().next().value!);identities.set(id,value);return value;
 });
 const stmt=(sql:string)=>{let s=prepared.get(sql);if(!s){if(prepared.size>=128)prepared.clear();s=db.prepare(sql);prepared.set(sql,s);}return s;};
 const exact=(identity:ResourceIdentity)=>{const c=canonicalizeIdentity(identity);return {identity:{provider:c.provider,keys:c.keys},id:(stmt('SELECT id FROM resources WHERE provider=? AND canonical_keys_json=?').get(c.provider,c.canonicalKeysJson) as any)?.id??null};};
 function admit(raw:ListMentionsInputV2){
  if(utf8ByteLength(JSON.stringify(raw))>65536)throw new Error('V2 input byte limit.');const input=listMentionsInputV2Schema.parse(raw),q=input.query;
  const target=q.kind==='resource'?exact(q.target):null,source=input.source===undefined?null:exact(input.source);
  const query=q.kind==='resource'?{kind:q.kind,target:target!.identity,relation:q.relation}:q;
  const normalized={version:2,query,...(source?{source:source.identity}:{}),...(input.producerPluginId?{producerPluginId:input.producerPluginId}:{}),pageSize:input.pageSize??25};
  const queryHash=sha256Hex(canonicalJson(normalized));let cursor:z.infer<typeof cursorSchema>|null=null;
  if(input.cursor!==undefined){cursor=cursorSchema.parse(JSON.parse(Buffer.from(input.cursor,'base64url').toString('utf8')));assert.equal(cursor.queryHash,queryHash,'Cursor belongs to another query.');}
  return {normalized,queryHash,targetId:target?.id??-1,sourceId:source?.id??null,sourceMissing:source!==null&&source.id===null,hasSource:source!==null,producer:input.producerPluginId??null,pageSize:normalized.pageSize,cursor,ifSnapshot:input.ifSnapshot};
 }
 type Admission=ReturnType<typeof admit>;
 function relations(a:Admission){
  const params:Record<string,any>={};let filter='';if(a.sourceMissing)filter+=' AND 0';else if(a.hasSource){filter+=' AND p.source_resource_id=@source';params.source=a.sourceId;}if(a.producer){filter+=' AND p.producer_plugin_id=@producer';params.producer=a.producer;}
  const literal=a.normalized.query.kind==='authored-url';let prefix:string;
  if(!literal){params.target=a.targetId;prefix=`WITH c AS MATERIALIZED (SELECT p.id projection_id,p.producer_plugin_id,p.source_resource_id,o.target_resource_id FROM reference_occurrences o JOIN source_projections p ON p.id=o.projection_id WHERE p.tombstone=0 AND o.target_resource_id=@target ${filter})`;}
  else{params.href=(a.normalized.query as {href:string}).href;prefix=`WITH url_l AS MATERIALIZED (SELECT m.producer_plugin_id,m.source_resource_id,m.target_resource_id,m.occurrence_key FROM mention_occurrences m JOIN source_projections p ON p.producer_plugin_id=m.producer_plugin_id AND p.source_resource_id=m.source_resource_id AND p.tombstone=0 JOIN reference_occurrences o ON o.projection_id=p.id AND o.target_resource_id=m.target_resource_id WHERE m.authored_url_state='exact' AND m.exact_authored_href=@href COLLATE BINARY ${filter}),c AS MATERIALIZED (SELECT DISTINCT p.id projection_id,u.producer_plugin_id,u.source_resource_id,u.target_resource_id FROM url_l u JOIN source_projections p ON p.producer_plugin_id=u.producer_plugin_id AND p.source_resource_id=u.source_resource_id AND p.tombstone=0 WHERE 1 ${filter} UNION SELECT p.id,p.producer_plugin_id,p.source_resource_id,o.target_resource_id FROM resource_keys k JOIN reference_occurrences o ON o.target_resource_id=k.resource_id JOIN source_projections p ON p.id=o.projection_id AND p.tombstone=0 WHERE k.provider='url' AND k.key='href' AND k.value=@href COLLATE BINARY ${filter})`;}
  prefix+=`,l AS NOT MATERIALIZED (SELECT m.*,CASE WHEN m.confirmed_in_scan=1 AND s.bound_graph_revision=p.revision THEN 1 ELSE 0 END effective_confirmed FROM c JOIN mention_occurrences m ON m.producer_plugin_id=c.producer_plugin_id AND m.source_resource_id=c.source_resource_id AND m.target_resource_id=c.target_resource_id ${literal?'JOIN url_l u ON u.producer_plugin_id=m.producer_plugin_id AND u.source_resource_id=m.source_resource_id AND u.target_resource_id=m.target_resource_id AND u.occurrence_key=m.occurrence_key':''} JOIN source_projections p ON p.id=c.projection_id LEFT JOIN mention_streams s ON s.producer_plugin_id=c.producer_plugin_id AND s.source_resource_id=c.source_resource_id)`;
  return {params,prefix,literal,noLocation:`NOT EXISTS(SELECT 1 FROM mention_occurrences m WHERE m.producer_plugin_id=c.producer_plugin_id AND m.source_resource_id=c.source_resource_id AND m.target_resource_id=c.target_resource_id ${literal?"AND m.authored_url_state='exact' AND m.exact_authored_href=@href COLLATE BINARY":''})`};
 }
 type Relations=ReturnType<typeof relations>;
 const order='sort_time DESC,source_digest COLLATE BINARY,producer_plugin_id COLLATE BINARY,target_digest COLLATE BINARY,item_kind,sort_message_id COLLATE BINARY,sort_span_start,item_key COLLATE BINARY';
 function keySql(r:Relations,sentinel:boolean,seek:'first'|'equal'|'older'){
  const from=sentinel?`FROM c JOIN resources rs ON rs.id=c.source_resource_id JOIN resources rt ON rt.id=c.target_resource_id WHERE ${r.noLocation}`:`FROM l m JOIN c ON c.producer_plugin_id=m.producer_plugin_id AND c.source_resource_id=m.source_resource_id AND c.target_resource_id=m.target_resource_id JOIN resources rs ON rs.id=c.source_resource_id JOIN resources rt ON rt.id=c.target_resource_id`;
  const select=`SELECT c.projection_id,c.producer_plugin_id,c.source_resource_id,c.target_resource_id,${sentinel?"'claim'":'m.occurrence_key'} item_key,${sentinel?1:0} item_kind,${sentinel?0:'m.message_created_at'} sort_time,cr_v2_identity_digest(rs.id,rs.provider,rs.canonical_keys_json) source_digest,cr_v2_identity_digest(rt.id,rt.provider,rt.canonical_keys_json) target_digest,${sentinel?"''":"json_extract(m.source_locator_json,'$.messageId')"} sort_message_id,${sentinel?0:'m.span_start'} sort_span_start ${from}`;
  const where=seek==='equal'?'WHERE sort_time=@at AND (source_digest,producer_plugin_id,target_digest,item_kind,sort_message_id,sort_span_start,item_key)>(@asrc,@aprod,@atarget,@akind,@amsg,@aspan,@akey)':seek==='older'?'WHERE sort_time<@at':'';
  return `${r.prefix},keys AS NOT MATERIALIZED (${select}) SELECT * FROM keys ${where} ORDER BY ${order} LIMIT @lim`;
 }
 function read(raw:ListMentionsInputV2):ListMentionsOutputV2 {
  const started=performance.now(),check=()=>{if(performance.now()-started>=MENTION_V2_LIMITS.readMs)throw new ReadBudget();};identities.clear();
  try{return db.transaction(()=>{
   const a=admit(raw),r=relations(a);check();
   const loc=stmt(`${r.prefix} SELECT COUNT(*) retained,COALESCE(SUM(m.effective_confirmed),0) confirmed,COALESCE(SUM(CASE WHEN e.state='ready' AND e.codec_version=1 AND e.source_content_revision=m.source_content_revision THEN 0 ELSE 1 END),0) unavailable FROM l m LEFT JOIN mention_excerpts e ON e.producer_plugin_id=m.producer_plugin_id AND e.source_resource_id=m.source_resource_id AND e.target_resource_id=m.target_resource_id AND e.occurrence_key=m.occurrence_key`).get(r.params) as any;
   const claims=stmt(`${r.prefix} SELECT COUNT(*) claims,COUNT(DISTINCT source_resource_id) sources FROM c`).get(r.params) as any;
   const missing=stmt(`${r.prefix} SELECT COUNT(*) n FROM c WHERE ${r.noLocation}`).get(r.params) as any;check();
   const counts={retainedOccurrences:loc.retained,confirmedOccurrences:loc.confirmed,unconfirmedOccurrences:loc.retained-loc.confirmed,producerClaims:claims.claims,indexedSources:claims.sources,claimsWithoutLocations:missing.n,excerptUnavailable:loc.unavailable};
   const coverage={scope:'known-sources' as const,collectionIncomplete:false,retentionLimited:false,capHistoryUnknown:false,legacyClaimsPresent:false,evidenceStateUnknown:false,authoredUrlCoverage:{state:'complete-for-known-locations' as 'complete-for-known-locations'|'partial',unknownLocations:0,scope:'known-locations' as const,watermark:''},reasons:[] as string[],reasonsClipped:false,checkedAt:null as number|null};const reasons:unknown[]=[];
   for(const row of stmt(`${r.prefix} SELECT c.producer_plugin_id,p.revision,s.evidence_revision,s.bound_graph_revision,s.coverage_json,s.last_successful_scan_at,s.cap_history_unknown FROM c JOIN source_projections p ON p.id=c.projection_id LEFT JOIN mention_streams s ON s.producer_plugin_id=c.producer_plugin_id AND s.source_resource_id=c.source_resource_id`).iterate(r.params) as Iterable<any>){
    if(row.producer_plugin_id==='thread-links'){coverage.legacyClaimsPresent=true;reasons.push('legacy-claim');}
    if(row.evidence_revision===null){coverage.evidenceStateUnknown=true;coverage.collectionIncomplete=true;reasons.push('producer-no-evidence');continue;}
    nonnegative.min(1).parse(row.evidence_revision);if(row.bound_graph_revision!==null)nonnegative.parse(row.bound_graph_revision);
    const c=JSON.parse(row.coverage_json);assert.ok(Array.isArray(c.reasons));coverage.collectionIncomplete||=c.timelineComplete!==true||c.reasons.length>0;coverage.retentionLimited||=c.retentionLimited===true;coverage.capHistoryUnknown||=row.cap_history_unknown===1;
    coverage.checkedAt=Math.max(coverage.checkedAt??0,nonnegative.parse(row.last_successful_scan_at));reasons.push(...c.reasons);
    if(row.bound_graph_revision===null||row.bound_graph_revision!==row.revision){coverage.collectionIncomplete=true;coverage.evidenceStateUnknown=true;reasons.push('graph-changed-since-evidence');}check();
   }
   let unknown=0;
   if(!a.sourceMissing){const pa:Record<string,any>={};let f='';if(a.hasSource){f+=' AND m.source_resource_id=@source';pa.source=a.sourceId;}if(a.producer){f+=' AND m.producer_plugin_id=@producer';pa.producer=a.producer;}if(!r.literal){f+=' AND m.target_resource_id=@target';pa.target=a.targetId;}
    unknown=(stmt(`SELECT COUNT(*) n FROM mention_occurrences m JOIN source_projections p ON p.producer_plugin_id=m.producer_plugin_id AND p.source_resource_id=m.source_resource_id AND p.tombstone=0 JOIN reference_occurrences o ON o.projection_id=p.id AND o.target_resource_id=m.target_resource_id WHERE m.authored_url_state='unknown' ${f}`).get(pa) as any).n;
   }
   coverage.authoredUrlCoverage={state:unknown?'partial':'complete-for-known-locations',unknownLocations:unknown,scope:'known-locations',watermark:sha256Hex(canonicalJson(['url-coverage-v1',a.normalized.query.kind,a.hasSource?a.normalized.source:null,a.producer,unknown]))};Object.assign(coverage,boundedCoverageReasons(reasons));check();
   const h=createHash('sha256');frame(h,['direct-v2-semantic-1',a.normalized]);
   for(const x of stmt(`${r.prefix} SELECT c.producer_plugin_id,cr_v2_identity_digest(rs.id,rs.provider,rs.canonical_keys_json) source_digest,cr_v2_identity_digest(rt.id,rt.provider,rt.canonical_keys_json) target_digest,p.revision,p.payload_digest,s.evidence_revision,s.evidence_digest,s.bound_graph_revision FROM c JOIN source_projections p ON p.id=c.projection_id JOIN resources rs ON rs.id=c.source_resource_id JOIN resources rt ON rt.id=c.target_resource_id LEFT JOIN mention_streams s ON s.producer_plugin_id=c.producer_plugin_id AND s.source_resource_id=c.source_resource_id ORDER BY c.producer_plugin_id COLLATE BINARY,source_digest COLLATE BINARY,target_digest COLLATE BINARY`).iterate(r.params) as Iterable<any>){frame(h,[x.producer_plugin_id,x.source_digest,x.target_digest,x.revision,x.payload_digest,x.evidence_revision,x.evidence_digest,x.bound_graph_revision]);check();}
   const snapshot=h.digest('hex');
   if(a.ifSnapshot===snapshot)return finish({version:2,status:'not-modified',snapshot,coverage});
   if(a.cursor&&a.cursor.snapshot!==snapshot)return finish({version:2,status:'restart',reason:'snapshot-changed',snapshot});
   const descriptors:any[]=[];
   for(const sentinel of [false,true]){let rows:any[];
    if(!a.cursor)rows=stmt(keySql(r,sentinel,'first')).all({...r.params,lim:a.pageSize+1});
    else{const x=a.cursor.after,pa={...r.params,at:x[0],asrc:x[1],aprod:x[2],atarget:x[3],akind:x[4],amsg:x[5],aspan:x[6],akey:x[7],lim:a.pageSize+1};rows=stmt(keySql(r,sentinel,'equal')).all(pa);
     if(rows.length<a.pageSize+1){check();rows.push(...stmt(keySql(r,sentinel,'older')).all({...r.params,at:x[0],lim:a.pageSize+1-rows.length}));}}
    descriptors.push(...rows);check();
   }
   const keys=descriptors.sort(compare).slice(0,a.pageSize+1),items:any[]=[];let rowBytes=0,last:any=null;
   const cursor=(k:any)=>{const value=Buffer.from(JSON.stringify({v:2,codec:1,queryHash:a.queryHash,snapshot,after:[k.sort_time,...tail(k)]})).toString('base64url');assert.ok(utf8ByteLength(value)<=4096);return value;};
   for(const key of keys){if(items.length===a.pageSize)break;check();const item=hydrate(key,r.literal),n=utf8ByteLength(JSON.stringify(item));assert.ok(n<=MENTION_V2_LIMITS.rowBytes,'Mention item exceeds row bound.');
    const overhead=utf8ByteLength(JSON.stringify({version:2,status:'page',snapshot,items:[],counts,coverage,nextCursor:cursor(key)}));
    if(rowBytes+n+(items.length?1:0)+overhead>MENTION_V2_LIMITS.responseBytes)break;
    items.push(item);rowBytes+=n+(items.length>1?1:0);last=key;
   }
   assert.ok(items.length>0||keys.length===0,'An admissible mention must fit alone.');
   return finish({version:2,status:'page',snapshot,items,counts,coverage,nextCursor:keys.length>items.length?cursor(last):null});
   function finish(value:ListMentionsOutputV2){const result=listMentionsOutputV2Schema.parse(value);assert.ok(utf8ByteLength(JSON.stringify(result))<=MENTION_V2_LIMITS.responseBytes);check();return result;}
  })();}catch(error){if(error instanceof ReadBudget)return {version:2,status:'unavailable',reason:'read-budget',retryable:true};throw error;}finally{identities.clear();}
 }
 function hydrate(k:any,literal:boolean):any {
  const b=stmt(`SELECT p.source_presentation_json,p.revision graph_revision,o.target_presentation_json,rs.provider source_provider,rs.canonical_keys_json source_keys,rt.provider target_provider,rt.canonical_keys_json target_keys,s.evidence_revision,s.bound_graph_revision,s.cap_history_unknown,cap.state cap_state FROM source_projections p JOIN reference_occurrences o ON o.projection_id=p.id AND o.target_resource_id=@target JOIN resources rs ON rs.id=p.source_resource_id JOIN resources rt ON rt.id=o.target_resource_id LEFT JOIN mention_streams s ON s.producer_plugin_id=p.producer_plugin_id AND s.source_resource_id=p.source_resource_id LEFT JOIN mention_edge_caps cap ON cap.producer_plugin_id=p.producer_plugin_id AND cap.source_resource_id=p.source_resource_id AND cap.target_resource_id=o.target_resource_id WHERE p.id=@projection AND p.tombstone=0`).get({projection:k.projection_id,target:k.target_resource_id}) as any;assert.ok(b);
  const resource=(provider:string,keys:string,presentation:string)=>serializeResource(canonicalizeResource({provider,keys:JSON.parse(keys),presentation:JSON.parse(presentation)}));
  const common={source:resource(b.source_provider,b.source_keys,b.source_presentation_json),target:resource(b.target_provider,b.target_keys,b.target_presentation_json),producerPluginId:k.producer_plugin_id,graphRevision:b.graph_revision,
   cap:{state:b.evidence_revision===null?'unknown':b.cap_state??'uncapped',limit:b.evidence_revision===null?null:100,sourceHistoryUnknown:b.evidence_revision===null?null:b.cap_history_unknown===1}};
  if(k.item_kind===1)return {...common,kind:'claim-without-evidence',reason:k.producer_plugin_id==='thread-links'?'legacy':k.producer_plugin_id==='cross-references'?'not-yet-collected':'producer-no-evidence',matchBasis:literal&&common.target.provider==='url'?'primary-url-identity':'primary-resource'};
  const x=stmt(`SELECT m.*,e.state excerpt_state,e.source_content_revision excerpt_content_revision,e.codec_version,e.excerpt_text,e.excerpt_source_start,e.excerpt_source_end,e.match_start,e.match_end,e.clipped_before,e.clipped_after,e.match_clipped_before,e.match_clipped_after,e.unavailable_reason FROM mention_occurrences m LEFT JOIN mention_excerpts e ON e.producer_plugin_id=m.producer_plugin_id AND e.source_resource_id=m.source_resource_id AND e.target_resource_id=m.target_resource_id AND e.occurrence_key=m.occurrence_key WHERE m.producer_plugin_id=@producer AND m.source_resource_id=@source AND m.target_resource_id=@target AND m.occurrence_key=@key`).get({producer:k.producer_plugin_id,source:k.source_resource_id,target:k.target_resource_id,key:k.item_key}) as any;assert.ok(x);
  if(!['exact','not-url','unknown'].includes(x.authored_url_state)||(x.authored_url_state==='exact')!==(x.exact_authored_href!==null))throw new Error('Invalid persisted URL proof.');
  if(x.exact_authored_href!==null)safeAuthoredHrefSchema.parse(x.exact_authored_href);
  const location=MentionLocationSchema.parse({locator:JSON.parse(x.source_locator_json),sourceContentRevision:x.source_content_revision,span:{start:x.span_start,end:x.span_end},messageCreatedAt:x.message_created_at,provenance:JSON.parse(x.provenance_json)});
  locatorOutputV2Schema.parse(location.locator);
  return {...common,kind:'occurrence',evidenceRevision:b.evidence_revision,occurrenceKey:x.occurrence_key,...location,excerpt:persistedExcerpt(x,x.source_content_revision),observedAt:x.observed_at,
   confirmation:x.confirmed_in_scan===1&&b.bound_graph_revision!==null&&b.bound_graph_revision===b.graph_revision?'observed':'retained-unconfirmed',authoredUrlState:x.authored_url_state};
 }
 return {read};
}
/** Called only after a successful outer transaction, never stored as an outbox
 * during a nested transaction that can still roll back. */
export function mentionsChangedSignal(db:Database.Database,source:ResourceIdentity,changed:CrossReferencesChangedSignal):MentionsChangedV2 {
 const c=canonicalizeIdentity(source),row=db.prepare(`SELECT s.evidence_revision FROM resources r LEFT JOIN mention_streams s ON s.source_resource_id=r.id AND s.producer_plugin_id=? WHERE r.provider=? AND r.canonical_keys_json=?`).get(changed.producerPluginId,c.provider,c.canonicalKeysJson) as any;
 return {version:2,producerPluginId:changed.producerPluginId,sourceIdentityDigest:c.identityDigest,graphRevision:changed.revision,evidenceRevision:row?.evidence_revision??null,affectedIdentityDigests:changed.affectedIdentityDigests.slice(0,512),scopeListClipped:true};
}
