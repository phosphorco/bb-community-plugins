import type Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AtomicStateStorage, StateAddress, StateRead, StateMutation, StateOutcome } from '@phosphorco/bb-identity/state';
import { stateCodecs } from '@phosphorco/bb-identity/state';
import type { Result, OperationLookup, ActorSnapshot } from '@phosphorco/bb-identity/model';
import { definitionSchema, draftSchema, entrySchema, revisionSchema, schemaCodec, personalDraftSchema, starterDefinitions, legacyPrReviewDefinition, prReviewDefinition, validateDefinition, type TemplateDefinition, type TemplateActor, type TemplateEntry, type PersonalDraft } from './model';
import { launchRequestSchema, launchStatusSchema, resolvedEffectsSchema, removeRequestSchema, removalSchema, type RemoveRequest, type TemplateRemoval, type AssignmentStatus, type LaunchStatus, type RecentLaunch } from './rpc-contract';

export const HISTORY_PAGE_BYTES_LIMIT=4*1024*1024;
const RECOVERABLE_PHASES_SQL="('preparing','ready','project-claimed','spawn-claimed')";
const utf8Bytes=(value:unknown)=>new TextEncoder().encode(JSON.stringify(value)).length;
export type Db = Pick<Database.Database, 'prepare' | 'exec' | 'transaction'>;
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.entries(value).filter(([,v])=>v !== undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',') + '}';
  return JSON.stringify(value);
}
export function fingerprint(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }
const identitySchema = z.discriminatedUnion('kind', [
  z.object({kind:z.literal('person'),key:z.string(),issuer:z.string(),subject:z.string()}).strict(),
  z.object({kind:z.literal('default-user'),key:z.string(),instanceId:z.string()}).strict(),
  z.object({kind:z.literal('machine'),key:z.string(),instanceId:z.string(),hostId:z.string().nullable()}).strict(),
  z.object({kind:z.literal('external'),key:z.string(),pluginId:z.string(),subject:z.string()}).strict(),
]);
export const capturedActorSchema = z.object({identity:identitySchema,presentation:z.object({displayName:z.string(),handle:z.string().nullable(),avatarUrl:z.string().nullable()}).strict(),evidence:z.enum(['provider-verified','local-user','upstream-default','integration-asserted','legacy','machine'])}).strict();
export const journalSchema = z.object({
  status: launchStatusSchema, request: launchRequestSchema, revision: revisionSchema,
  capturedActor: capturedActorSchema, fingerprint: z.string(), token: z.string(),
  assignmentDispatch:z.object({attempted:z.boolean(),generation:z.string(),claim:z.string(),rawPending:z.boolean(),sent:z.boolean().default(false)}).strict().optional(),
  effects: resolvedEffectsSchema.nullable(), nativeRequest: z.record(z.string(),z.json()).nullable(),
  creation: z.object({name:z.string(),hostId:z.string(),path:z.string()}).strict().nullable(),
  projectClaim:z.string().nullable().default(null),spawnClaim:z.string().nullable().default(null),confirmation:z.enum(['native-ack','lifecycle']).nullable().default(null),
}).strict();
export type LaunchRecord = z.infer<typeof journalSchema>;
const rowSchema = z.object({ data: z.string() });
const tombstoneSchema=removalSchema.extend({entry:entrySchema}).strict();
const fail = (message:string): Result<never> => ({ok:false,error:{code:'invalid-operation',message,retry:'never'}});
export class TemplatesStore {
  constructor(readonly db: Db, readonly now: () => number = Date.now) {
    db.exec(`CREATE TABLE IF NOT EXISTS templates (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS template_tombstones (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS template_revisions (id TEXT NOT NULL, revision INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(id,revision));
      CREATE TABLE IF NOT EXISTS template_launches (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS template_launch_candidate ON template_launches(json_extract(data,'$.status.candidate.threadId'));
      CREATE INDEX IF NOT EXISTS template_launch_thread ON template_launches(json_extract(data,'$.status.threadId'));
      CREATE INDEX IF NOT EXISTS template_launch_actor_history ON template_launches(json_extract(data,'$.capturedActor.identity.key'),json_extract(data,'$.status.createdAt') DESC,id DESC);
      CREATE INDEX IF NOT EXISTS template_launch_recoverable_phase ON template_launches(json_extract(data,'$.status.phase')) WHERE json_extract(data,'$.status.phase') IN ${RECOVERABLE_PHASES_SQL};
      CREATE TABLE IF NOT EXISTS template_removed_threads (thread_id TEXT PRIMARY KEY, observed_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS template_seed_updates (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL, outcome TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS template_personal_state (address TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS template_state_receipts (id TEXT NOT NULL, address TEXT NOT NULL, fingerprint TEXT NOT NULL, data TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(address,id));`);
  }
  private atomic<T>(run:()=>T):T { return this.db.transaction(run).immediate(); }
  private readRow(table: string, key: string): string | null {
    const row = this.db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(key);
    return row ? rowSchema.parse(row).data : null;
  }
  private tombstone(id:string) {const data=this.readRow('template_tombstones',id);return data?tombstoneSchema.parse(JSON.parse(data)):null;}
  get(id:string):TemplateEntry|null { if(this.tombstone(id))return null;const data=this.readRow('templates',id); return data ? entrySchema.parse(JSON.parse(data)) : null; }
  catalog():TemplateEntry[] { return this.db.prepare('SELECT data FROM templates WHERE NOT EXISTS (SELECT 1 FROM template_tombstones WHERE template_tombstones.id=templates.id) ORDER BY id').all().map(row=>entrySchema.parse(JSON.parse(rowSchema.parse(row).data))); }
  private putEntry(entry:TemplateEntry) { this.db.prepare('INSERT INTO templates(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(entry.id,JSON.stringify(entrySchema.parse(entry))); }
  seed() {
    const actor={key:'starter',name:'New Thread Templates'};
    this.atomic(()=> {
      const addMissing=(definition:TemplateDefinition)=>{
        if(this.get(definition.id)||this.tombstone(definition.id))return;
        const draft=this.saveDraft(definition,null,actor);
        if(validateDefinition(definition).length===0)this.publish(definition.id,draft.generation,actor);
      };
      const migrationId='customer-defaults-2026-10-30';
      if(!this.db.prepare('SELECT id FROM template_seed_updates WHERE id=?').get(migrationId)) {
        const current=this.get('review-pr'),legacy=legacyPrReviewDefinition(),customer=prReviewDefinition();
        let outcome='fresh';
        if(this.tombstone('review-pr'))outcome='preserved-removal';
        else if(current) {
          const untouched=current.draft?.generation===1&&current.published?.revision===1&&current.latestRevision===1
            &&canonical(current.draft.editedBy)===canonical(actor)&&canonical(current.published.publishedBy)===canonical(actor)
            &&canonical(current.draft.definition)===canonical(legacy)&&canonical(current.published.definition)===canonical(legacy);
          if(untouched) {
            // Normal generation CAS and immutable publication in the same immediate transaction.
            const saved=this.saveDraft(customer,current.draft!.generation,actor);
            const result=this.publish(customer.id,saved.generation,actor);
            if(result.issues.length)throw new Error('Customer default failed validation');
            outcome='upgraded-untouched';
          } else if(!current.published||canonical(current.published.definition)!==canonical(customer)) {
            // Preserve collaborator content; expose the new customer definition separately.
            let fallbackId='pr-review-default';
            for(let suffix=2;;suffix++) {
              // An explicit removal is a decision, not an available ID to replace.
              if(this.tombstone(fallbackId))break;
              const fallback=this.get(fallbackId),desired=prReviewDefinition(fallbackId);
              if(!fallback){addMissing(desired);break;}
              if(fallback.published&&canonical(fallback.published.definition)===canonical(desired))break;
              fallbackId='pr-review-default-'+suffix;
            }
            outcome='preserved-existing-with-separate-default:'+fallbackId;
          } else outcome='already-current';
        }
        this.db.prepare('INSERT INTO template_seed_updates(id,applied_at,outcome) VALUES(?,?,?)').run(migrationId,this.now(),outcome);
      }
      for(const definition of starterDefinitions())addMissing(definition);
    });
  }
  saveDraft(definition:TemplateDefinition, expectedGeneration:number|null, actor:TemplateActor, validate:()=>void=()=>{}) {
    definition=definitionSchema.parse(definition);
    return this.atomic(()=> {
      if(this.tombstone(definition.id))throw new Error('This template was removed. Create a new template with a new ID.');
      const current=this.get(definition.id);
      if((current?.draft?.generation ?? null) !== expectedGeneration) throw new Error('Draft changed in another window. Reload before saving.');
      validate();
      const draft=draftSchema.parse({templateId:definition.id,generation:(expectedGeneration??0)+1,definition,editedAt:this.now(),editedBy:actor});
      this.putEntry({id:definition.id,draft,published:current?.published??null,latestRevision:current?.latestRevision??0});
      return draft;
    });
  }
  publish(templateId:string,generation:number,actor:TemplateActor,validate:()=>void=()=>{}) {
    return this.atomic(()=> {
      const entry=this.get(templateId);
      if(!entry?.draft || entry.draft.generation!==generation) throw new Error('Draft changed. Reload before publishing.');
      const issues=validateDefinition(entry.draft.definition);
      if(issues.length) return {entry,issues};
      validate();
      const revision=revisionSchema.parse({templateId,revision:entry.latestRevision+1,definition:entry.draft.definition,publishedAt:this.now(),publishedBy:actor});
      this.db.prepare('INSERT INTO template_revisions(id,revision,data) VALUES(?,?,?)').run(templateId,revision.revision,JSON.stringify(revision));
      const next={...entry,published:revision,latestRevision:revision.revision};this.putEntry(next);
      return {entry:next,issues:[]};
    });
  }
  unpublish(id:string,expectedRevision:number,validate:()=>void=()=>{}) {
    return this.atomic(()=>{const entry=this.get(id);if(!entry?.published || entry.published.revision!==expectedRevision) throw new Error('Published revision changed. Reload before unpublishing.');validate();const next={...entry,published:null};this.putEntry(next);return next;});
  }
  remove(raw:RemoveRequest,actor:TemplateActor,validate:()=>void=()=>{}):TemplateRemoval {
    const request=removeRequestSchema.parse(raw);
    return this.atomic(()=>{
      const removed=this.tombstone(request.templateId);
      const entry=removed?.entry??this.get(request.templateId);
      if(!entry)throw new Error('Template not found. Reload before removing.');
      if((entry.draft?.generation??null)!==request.expectedGeneration||(entry.published?.revision??null)!==request.expectedRevision||entry.latestRevision!==request.expectedLatestRevision)throw new Error('Template changed. Reload before removing.');
      validate();
      if(removed)return {templateId:removed.templateId,removedAt:removed.removedAt,removedBy:removed.removedBy};
      const receipt=removalSchema.parse({templateId:request.templateId,removedAt:this.now(),removedBy:actor});
      this.db.prepare('INSERT INTO template_tombstones(id,data) VALUES(?,?)').run(request.templateId,JSON.stringify(tombstoneSchema.parse({...receipt,entry})));
      return receipt;
    });
  }
  duplicate(id:string,newId:string,actor:TemplateActor,validate:()=>void=()=>{}) {
    const entry=this.get(id);const def=entry?.draft?.definition??entry?.published?.definition;
    if(!def) throw new Error('Template not found');
    return this.saveDraft({...def,id:newId,name:`${def.name} (copy)`},null,actor,validate);
  }
  revision(id:string,revision:number) {
    const row=this.db.prepare('SELECT data FROM template_revisions WHERE id=? AND revision=?').get(id,revision);
    return row ? revisionSchema.parse(JSON.parse(rowSchema.parse(row).data)) : null;
  }
  recentLaunches(actorKey:string,offset=0) {
    const rows=this.db.prepare("SELECT data FROM template_launches WHERE json_extract(data,'$.capturedActor.identity.key')=? ORDER BY json_extract(data,'$.status.createdAt') DESC,id DESC LIMIT 51 OFFSET ?").iterate(actorKey,offset);
    const launches:RecentLaunch[]=[];
    let hasMore=false,used=Math.max(utf8Bytes({launches:[],nextOffset:null}),utf8Bytes({launches:[],nextOffset:offset+50}));
    for(const row of rows) {
      if(launches.length===50){hasMore=true;break;}
      const r=journalSchema.parse(JSON.parse(rowSchema.parse(row).data));
      const record:RecentLaunch={status:r.status,revision:r.revision,...(r.request.projectId?{requestedProjectId:r.request.projectId}:{}),effects:r.effects,...(r.request.nativeSubmission?{nativeSubmission:r.request.nativeSubmission}:{})};
      const size=utf8Bytes(record)+(launches.length?1:0);
      // An unusually large historical record is returned alone, never truncated or stranded.
      if(launches.length&&used+size>HISTORY_PAGE_BYTES_LIMIT){hasMore=true;break;}
      launches.push(record);used+=size;
    }
    return {launches,nextOffset:hasMore?offset+launches.length:null};
  }
  launch(id:string):LaunchRecord|null {const data=this.readRow('template_launches',id);return data?journalSchema.parse(JSON.parse(data)):null;}
  patchAssignment(id:string,update:(record:LaunchRecord)=>{value:AssignmentStatus;dispatch?:LaunchRecord['assignmentDispatch']},validate:()=>void=()=>{}):LaunchRecord|null {
    return this.atomic(()=>{const row=this.launch(id);if(!row?.status.assignment)return null;validate();const patch=update(row),original=row.status.assignment;
      if(patch.value.operationId!==original.operationId||patch.value.actorKey!==original.actorKey||(original.threadId!==null&&patch.value.threadId!==original.threadId))throw new Error('Assignment intent cannot be retargeted');
      const next=journalSchema.parse({...row,...(patch.dispatch?{assignmentDispatch:patch.dispatch}:{}),status:{...row.status,assignment:patch.value}});if(canonical(next)===canonical(row))return row;next.status.updatedAt=this.now();this.db.prepare('UPDATE template_launches SET data=? WHERE id=?').run(JSON.stringify(next),id);return next;
    });
  }
  markThreadRemoved(threadId:string):void {this.db.prepare('INSERT OR IGNORE INTO template_removed_threads(thread_id,observed_at) VALUES(?,?)').run(threadId,this.now());}
  wasThreadRemoved(threadId:string):boolean {return !!this.db.prepare('SELECT thread_id FROM template_removed_threads WHERE thread_id=?').get(threadId);}
  launchForThread(threadId:string):LaunchRecord|null {
    const row=this.db.prepare("SELECT data FROM template_launches WHERE json_extract(data,'$.status.candidate.threadId')=? OR json_extract(data,'$.status.threadId')=? LIMIT 1").get(threadId,threadId);
    return row?journalSchema.parse(JSON.parse(rowSchema.parse(row).data)):null;
  }
  insertLaunch(record:LaunchRecord,validate:()=>void): {created:boolean;record:LaunchRecord} {
    return this.atomic(()=>{const existing=this.launch(record.status.operationId);if(existing) {if(existing.fingerprint!==record.fingerprint) throw new Error('Operation id already belongs to a different immutable launch');return {created:false,record:existing};}validate();const parsed=journalSchema.parse(record);this.db.prepare('INSERT INTO template_launches(id,data) VALUES(?,?)').run(record.status.operationId,JSON.stringify(parsed));return {created:true,record:parsed};});
  }
  transition(id:string,token:string,from:LaunchStatus['phase'][],update:(record:LaunchRecord)=>LaunchRecord,validate:()=>void=()=>{}):LaunchRecord|null {
    return this.atomic(()=>{const current=this.launch(id);if(!current || current.token!==token || !from.includes(current.status.phase)) return null;validate();const next=journalSchema.parse(update(current));if(canonical(next)===canonical(current))return current;next.status.updatedAt=this.now();this.db.prepare('UPDATE template_launches SET data=? WHERE id=?').run(JSON.stringify(next),id);return next;});
  }
  completeEffect(id:string,kind:'project'|'spawn',claimId:string,ownerToken:string,nativeId:string,evidence:'native-ack'|'lifecycle'='native-ack'):LaunchRecord|null {
    return this.atomic(()=>{
      const current=this.launch(id);if(!current||current[kind==='project'?'projectClaim':'spawnClaim']!==claimId)return null;
      if(kind==='spawn') {
        if(current.status.phase==='succeeded'&&evidence==='native-ack'&&current.status.threadId===nativeId)return this.transition(id,current.token,['succeeded'],r=>({...r,confirmation:'native-ack'}));
        if(!['spawn-claimed','indeterminate'].includes(current.status.phase))return current;
        return this.transition(id,current.token,[current.status.phase],r=>({...r,confirmation:evidence,status:{...r.status,phase:'succeeded',threadId:nativeId,candidate:null,retryable:false,message:evidence==='native-ack'?'Native creation acknowledged.':'Confirmed an active or completed native thread.'}}));
      }
      if(!['project-claimed','project-unknown'].includes(current.status.phase))return current;
      return this.transition(id,current.token,[current.status.phase],r=>({...r,status:{...r.status,projectId:nativeId,phase:r.token===ownerToken?'ready':'failed',retryable:r.token!==ownerToken,message:r.token===ownerToken?null:'Recovered a late native project receipt. Retry the same operation to continue.'}}));
    });
  }
  rejectSpawn(id:string,claimId:string,reason:string):LaunchRecord|null {
    return this.atomic(()=>{
      const current=this.launch(id);if(!current||current.spawnClaim!==claimId||current.confirmation==='native-ack')return current;
      return this.transition(id,current.token,['spawn-claimed','indeterminate','succeeded'],r=>({...r,confirmation:null,status:{...r.status,phase:'indeterminate',threadId:null,candidate:r.status.candidate??(r.status.threadId?{threadId:r.status.threadId,state:'failed'}:null),retryable:false,message:reason}}));
    });
  }
  // A fresh owner may resume a definite pre-effect failure. Claimed/unknown effects are never admitted here.
  resume(id:string,validate:()=>void):LaunchRecord|null {
    const record=this.launch(id);if(!record || record.status.phase!=='failed' || !record.status.retryable)return null;
    return this.transition(id,record.token,['failed'],r=>({...r,token:randomUUID(),status:{...r.status,phase:'preparing',retryable:false,message:null}}),validate);
  }
  recoverInterrupted() {
    this.atomic(()=>{for(const row of this.db.prepare("SELECT data FROM template_launches WHERE json_extract(data,'$.status.phase') IN "+RECOVERABLE_PHASES_SQL).iterate()) {
      const r=journalSchema.parse(JSON.parse(rowSchema.parse(row).data));
      const phase=r.status.phase;
      if(['preparing','ready','project-claimed','spawn-claimed'].includes(phase)) {
        r.token=randomUUID();r.status.updatedAt=this.now();
        r.status.phase=phase==='project-claimed'?'project-unknown':phase==='spawn-claimed'?'indeterminate':'failed';
        r.status.retryable=phase==='preparing'||phase==='ready';
        r.status.message=r.status.retryable?'Preparation interrupted before native dispatch. Retry the same operation.':'Native effect was claimed before interruption. Check its receipt; do not resend.';
        this.db.prepare('UPDATE template_launches SET data=? WHERE id=?').run(JSON.stringify(r),r.status.operationId);
      }
    }});
  }
  personalStorage():AtomicStateStorage<PersonalDraft> {
    const codecs=stateCodecs(schemaCodec(personalDraftSchema));
    const addressKey=(a:StateAddress)=>canonical(a);
    const read=(a:StateAddress):StateRead<PersonalDraft>=>{
      const row=this.db.prepare('SELECT data FROM template_personal_state WHERE address=?').get(addressKey(a));
      if(!row)return {status:'empty',address:a,version:{epoch:fingerprint(a),sequence:0}};
      const decoded=codecs.read.decode(JSON.parse(rowSchema.parse(row).data));if(!decoded.ok)throw new Error(decoded.error.message);return decoded.value;
    };
    const receipt=(address:StateAddress,id:string)=>this.db.prepare('SELECT data,fingerprint,created_at FROM template_state_receipts WHERE id=? AND address=?').get(id,addressKey(address));
    const receiptSchema=z.object({data:z.string(),fingerprint:z.string(),created_at:z.number()});
    const retention=30*24*60*60*1000;
    return {
      boundary:'same-process-synchronous',receiptRetentionMs:retention,
      read:async address=>({ok:true,value:read(address)}),
      commit:async ({mutation,validateAtCommit})=>this.atomic(()=>{
        const hash=fingerprint(mutation);const prior=receipt(mutation.address,mutation.operationId);
        if(prior){const p=receiptSchema.parse(prior);if(this.now()-p.created_at>retention)return {ok:false,error:{code:'expired',message:'This operation receipt expired; the operation cannot be reused',retry:'never'}};if(p.fingerprint!==hash)return fail('Operation id reused with different mutation');const decoded=codecs.save.decode(JSON.parse(p.data));return decoded;}
        const actor=validateAtCommit();if(!actor.ok)return actor;
        const current=read(mutation.address);
        if(current.status==='migration-required')return fail('Stored draft requires migration');
        let outcome:StateOutcome<PersonalDraft>;
        if(mutation.kind==='initialize'&&current.status!=='empty')outcome={status:'already-initialized',current,operationId:mutation.operationId};
        else if(canonical(current.status==='present'?current.envelope.version:current.version)!==canonical(mutation.expectedVersion))outcome={status:'conflict',current,operationId:mutation.operationId};
        else {
          const version=current.status==='present'?current.envelope.version:current.version;
          const envelope={address:mutation.address,version:{epoch:version.epoch,sequence:version.sequence+1},schemaVersion:mutation.schemaVersion,value:personalDraftSchema.parse(mutation.value),lastEditedBy:actor.value};
          const same=current.status==='present'&&canonical(current.envelope.value)===canonical(envelope.value);
          if(same)outcome={status:'unchanged',envelope:current.envelope,operationId:mutation.operationId};
          else {outcome={status:'saved',envelope,operationId:mutation.operationId};this.db.prepare('INSERT INTO template_personal_state(address,data) VALUES(?,?) ON CONFLICT(address) DO UPDATE SET data=excluded.data').run(addressKey(mutation.address),JSON.stringify(codecs.read.encode({status:'present',envelope})));}
        }
        this.db.prepare('INSERT INTO template_state_receipts(id,address,fingerprint,data,created_at) VALUES(?,?,?,?,?)').run(mutation.operationId,addressKey(mutation.address),hash,JSON.stringify(codecs.save.encode(outcome)),this.now());
        return {ok:true,value:outcome};
      }),
      reconcile:async ({address,operationId})=>{
        const row=receipt(address,operationId);
        if(!row)return {ok:true,value:{status:'absent-final',retry:'same-operation-only'}};
        const r=receiptSchema.parse(row);if(this.now()-r.created_at>retention)return {ok:true,value:{status:'unknown',reason:'expired'}};
        const decoded=codecs.save.decode(JSON.parse(r.data));if(!decoded.ok)return decoded;
        if(decoded.value.status==='indeterminate')return {ok:true,value:{status:'unknown',reason:'expired'}};
        return {ok:true,value:{status:'final',outcome:decoded.value}};
      },
    };
  }
}
export function actorSummary(actor:ActorSnapshot):TemplateActor { return {key:actor.identity.key,name:actor.presentation.displayName}; }
