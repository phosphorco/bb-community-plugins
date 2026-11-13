import { setImmediate as yieldToHost } from "node:timers/promises";
import { CollectionCheckpoints, RecognitionCheckpointCache, type CollectionCheckpoint } from "./collection-checkpoint.ts";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type Database from "better-sqlite3";
import { assistantLinkLabel } from "./assistant-links.ts";
import { ContextBundleV1Schema, type ContextBundleV1, type TaggedCandidateV1 } from "@phosphorco/bb-context-recognition";
import { createRecognitionDiscoveryOwner, enumerateRecognitionSuppliers, createSupplierClient, type ReadyRecognitionSupplier } from "@phosphorco/bb-context-recognition/bb";
import { MentionDiagnostics, type MentionDiagnosticOperation } from './mention-file-contract.ts';
import { createMentionFileVerifier } from './mention-files.ts';
import { collectConversationMentions, type ConversationMessage } from "./mention-collection.ts";
import { MENTION_LIMITS, type MentionScan } from "./mention-evidence.ts";
import { type ResourceIdentity, threadIdentity, threadResource, sha256Hex } from "./canonical.ts";
import type { CrossReferencesChangedSignal } from "./model.ts";
import { CrossReferenceStore } from "./store.ts";

/** Bound SDK waits even when a transport ignores cancellation. Late responses
 * have no commit capability; the caller's generation fence still owns writes. */
async function bounded<T>(run:(signal:AbortSignal)=>Promise<T>,signal:AbortSignal,ms=1000,diagnostic?:MentionDiagnosticOperation,native=false):Promise<T> {
  signal.throwIfAborted();
  const controller=new AbortController();
  const abort=()=>controller.abort();signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([run(controller.signal),new Promise<never>((_,reject)=>{
    const fail=()=>reject(new Error('Collection request cancelled or timed out.'));
    controller.signal.addEventListener('abort',fail,{once:true});
    if(controller.signal.aborted)fail();
    timer=setTimeout(()=>{diagnostic?.fail(native?'native-timeout':'outer-timeout');controller.abort();},ms);
  })]);}catch(error){diagnostic?.fail(signal.aborted?'cancelled':'sdk-failure');throw error;}finally{if(!native)diagnostic?.close();clearTimeout(timer);signal.removeEventListener('abort',abort);controller.abort();}
}

type Job = { thread_id: string; project_id: string; version: number; deleted: number; attempts: number };

/** SQLite owns pending work; one abort-aware worker resumes it after reload. */
export class AssistantLinkCollector {
  private disposed = false;
  private running = false;
  private readonly lifetime = new AbortController();
  private recognitionCache=new Map<string,TaggedCandidateV1[]>();
  private readonly continuations=new Map<string,number>();
  private readonly sourceWatches=new Map<string,()=>void>();
  private sourceWatchSignal:AbortSignal|undefined;
  private readonly activeAttempts=new Set<{threadId:string;controller:AbortController}>();
  private readonly discoveryOwner = createRecognitionDiscoveryOwner();
  private suppliers: ReadyRecognitionSupplier[] = [];
  private discoveryNeeded = true;
  private supplierEpoch = 0;
  private discoveryIncomplete = true;
  private failedSuppliers: string[] = [];
  private wake: (() => void) | undefined;
  private readonly bb: BbPluginApi;
  private readonly db: Database.Database;
  private readonly store: CrossReferenceStore;
  private readonly publish: (signal: CrossReferencesChangedSignal, source:ResourceIdentity) => void;
  constructor(bb: BbPluginApi, db: Database.Database, store: CrossReferenceStore, publish: (signal: CrossReferencesChangedSignal, source:ResourceIdentity) => void) {
    this.bb = bb;
    this.db = db;
    this.store = store;
    this.publish = publish;
  }

  /** Read-only snapshot of this service's existing discovery lifetime. No RPC
   * read may trigger discovery, reseed collection or revive a disposed owner. */
  lookupSnapshot():{clients:readonly ReadyRecognitionSupplier[];incomplete:boolean;signal:AbortSignal}{
    if(this.inactive())return {clients:[],incomplete:true,signal:this.lifetime.signal};
    return {clients:[...this.suppliers],incomplete:this.discoveryNeeded||this.discoveryIncomplete||this.failedSuppliers.length>0,signal:this.lifetime.signal};
  }

  /** Discovery is event-driven and shared by this one server collector. Pending
   * source jobs, not a detached promise, own subsequent recognition work. */
  invalidateSuppliers():void {
    if(this.inactive())return;
    // A supplier call may ignore abort and resolve late. Detach its cache so
    // that only attempts in this new epoch can populate it.
    this.recognitionCache=new Map();
    this.db.prepare("DELETE FROM assistant_link_recognition_cache").run();
    this.db.prepare("UPDATE assistant_link_checkpoints SET state_json=json_remove(state_json, '$.pureKey')").run();
    this.supplierEpoch++;
    for(const attempt of this.activeAttempts)attempt.controller.abort();
    this.discoveryNeeded=true;
    this.discoveryOwner.dispose();
    this.seed();
    this.wake?.();
  }

  /** Compaction changes are detail-only native signals. Bind exact cached
   * source IDs, never a catalogue subscription that cannot see those signals. */
  private watchSources(extraThreadId?:string):void {
    const signal=this.sourceWatchSignal;if(!signal || signal.aborted || this.inactive())return;
    const ids=new Set((this.db.prepare('SELECT thread_id FROM assistant_link_checkpoints').all() as {thread_id:string}[]).map(row=>row.thread_id));
    if(extraThreadId)ids.add(extraThreadId);
    for(const [id,off] of this.sourceWatches)if(!ids.has(id)){off();this.sourceWatches.delete(id);}
    for(const id of ids)if(!this.sourceWatches.has(id)){
      let live=true;
      const off=this.bb.sdk.subscribe({event:'thread:changed',threadId:id,callback:event=>{
        if(!live || signal.aborted || this.inactive())return;
        const checkpoint=new CollectionCheckpoints(this.db).load(id);
        const sameSequenceAppend=event.changes.includes('events-appended') &&
          (checkpoint?.maxSeq==null || event.metadata?.timelineSequence===undefined || event.metadata.timelineSequence<=checkpoint.maxSeq);
        if(sameSequenceAppend || event.changes.some(change=>change==='history-rewritten' || change==='history-compacted'))this.invalidateSources(id,true);
      }});
      this.sourceWatches.set(id,()=>{live=false;off();});
    }
  }

  /** Invalidate reconstructible inputs without creating a catalogue backfill
   * for ordinary preference changes. Existing jobs keep priority/backoff. */
  private invalidateSources(threadId?:string,reschedule=false):void {
    if(this.inactive())return;
    const prior=threadId&&reschedule?new CollectionCheckpoints(this.db).load(threadId):undefined;
    const pending=threadId&&reschedule&&!prior?.projectId?this.db.prepare('SELECT project_id FROM assistant_link_jobs WHERE thread_id=?').get(threadId) as {project_id:string}|undefined:undefined;
    if(threadId){new CollectionCheckpoints(this.db).remove(threadId);this.continuations.delete(threadId);}
    else {this.db.prepare('DELETE FROM assistant_link_checkpoints').run();this.continuations.clear();}
    for(const attempt of this.activeAttempts)if(!threadId || attempt.threadId===threadId)attempt.controller.abort();
    this.watchSources();this.wake?.();
    const projectId=prior?.projectId??pending?.project_id;
    // A delayed native notification can arrive after the preceding job already
    // committed. Its durable successor must not depend on another view request.
    if(threadId && reschedule && projectId)this.enqueue(projectId,threadId,false,true,1);
  }

  dispose():void {
    if(this.disposed)return;
    this.disposed=true;
    for(const off of this.sourceWatches.values())off();this.sourceWatches.clear();this.sourceWatchSignal=undefined;
    this.supplierEpoch++;
    this.lifetime.abort();
    this.discoveryOwner.dispose();
    this.recognitionCache=new Map();
    this.suppliers=[];
    this.wake?.();
  }

  /** Candidate rollback closes SQLite without running disposal hooks. Check
   * ownership before touching it, rather than catching a closed-DB exception. */
  private inactive():boolean {
    if(!this.db.open)this.dispose();
    return this.disposed;
  }

  private async discover(signal:AbortSignal):Promise<void> {
    if(this.inactive() || signal.aborted || !this.discoveryNeeded)return;
    const epoch=this.supplierEpoch;
    try {
      const snapshot=await bounded(s=>enumerateRecognitionSuppliers({sdk:this.bb.sdk,owner:this.discoveryOwner,exclude:'cross-references',signal:s,
        previouslyReady:this.suppliers.map(s=>s.client.pluginId)}),signal,3000);
      if(this.inactive() || signal.aborted || epoch!==this.supplierEpoch)return;
      this.suppliers=snapshot.rows.filter(row=>row.admitted && row.capabilities?.linkify).map(row=>({client:createSupplierClient(this.bb.sdk,row.pluginId),capabilities:row.capabilities!}));
      this.failedSuppliers=snapshot.rows.filter(row=>['pending','transient','error','unavailable'].includes(row.state)).map(row=>row.pluginId);
      this.discoveryIncomplete=snapshot.omittedCount>0 || this.failedSuppliers.length>0;
    }catch {
      if(this.inactive() || signal.aborted || epoch!==this.supplierEpoch)return;
      this.failedSuppliers=this.suppliers.map(row=>row.client.pluginId);
      this.suppliers=[];this.discoveryIncomplete=true;
    }
    if(epoch===this.supplierEpoch)this.discoveryNeeded=false;
  }

  /** The SDK's project remote is a sanitized context hint, never a local git
   * scan or a recognizer I/O request. No branch/upstream is invented. */
  private async context(projectId:string,threadId:string,environmentId:string|undefined,signal:AbortSignal,diagnostics:MentionDiagnostics):Promise<ContextBundleV1> {
    const base:ContextBundleV1={consumer:{pluginId:'cross-references',surface:'conversation'},projectId,threadId,links:[],...(environmentId?{environmentId}:{})};
    try {
      const project=await bounded(s=>this.bb.sdk.projects.get({projectId,signal:s}),signal,1000,diagnostics.operation('project-context'));
      const remote=project.gitRemoteUrl;
      if(!remote)return base;
      let url=remote;
      if(/^[a-z][a-z0-9+.-]*:\/\//iu.test(url)){const parsed=new URL(url);parsed.username='';parsed.password='';parsed.search='';parsed.hash='';url=parsed.href;}
      else {const scp=/^(?:[^/@\s]+@)?([^/:\s]+):(.+)$/u.exec(url);if(scp)url=`ssh://${scp[1]}/${scp[2]}`;}
      return ContextBundleV1Schema.parse({...base,git:{remotes:[{name:'origin',url}]}});
    }catch{return base;}
  }

  enqueue(projectId: string, threadId: string, deleted = false, force = false, priority: 0 | 1 | 2 = 0): void {
    if(this.inactive())return;
    threadIdentity(projectId, threadId);
    if (!force && this.db.prepare("SELECT 1 FROM assistant_link_jobs WHERE thread_id = ?").get(threadId) !== undefined) {
      // Demand changes scheduling rank, never eligibility or source generation.
      if (priority) this.db.prepare("UPDATE assistant_link_jobs SET priority = MAX(priority, ?) WHERE thread_id = ?").run(priority, threadId);
      this.wake?.();
      return;
    }
    const synced = this.db.prepare("SELECT synced_at FROM assistant_link_sync WHERE thread_id = ?").get(threadId) as { synced_at: number } | undefined;
    if (!force && synced !== undefined && Date.now() - synced.synced_at < 30_000) return;
    this.db.prepare(`INSERT INTO assistant_link_jobs(thread_id, project_id, version, deleted, retry_at, priority)
      VALUES (?, ?, 1, ?, 0, ?) ON CONFLICT(thread_id) DO UPDATE SET
      version = version + 1, deleted = MAX(deleted, excluded.deleted), retry_at = excluded.retry_at, attempts = 0,
      priority = MAX(priority, excluded.priority)`).run(threadId, projectId, deleted ? 1 : 0, priority);
    if(force)for(const attempt of this.activeAttempts)if(attempt.threadId===threadId)attempt.controller.abort();
    this.wake?.();
  }

  seed(): void {
    if(this.inactive())return;
    const sources = this.db.prepare(`SELECT DISTINCT resources.canonical_keys_json FROM source_projections
      JOIN resources ON resources.id = source_projections.source_resource_id
      WHERE resources.provider = 'bb' AND source_projections.tombstone = 0
        AND source_projections.producer_plugin_id IN ('thread-links', 'cross-references')`).all() as Array<{ canonical_keys_json: string }>;
    for (const source of sources) {
      const keys = JSON.parse(source.canonical_keys_json) as { project?: string; thread?: string };
      if (keys.project !== undefined && keys.thread !== undefined) {
        threadIdentity(keys.project, keys.thread);
        // Startup/reconnect is reconciliation, not a new source generation.
        // An existing retry keeps its intent, attempts and real ready time.
        this.db.prepare(`INSERT INTO assistant_link_jobs(thread_id, project_id, version)
          VALUES (?, ?, 1) ON CONFLICT(thread_id) DO NOTHING`).run(keys.thread, keys.project);
      }
    }
    this.wake?.();
  }

  async processNext(signal: AbortSignal): Promise<boolean> {
    if(this.inactive() || signal.aborted)return false;
    signal=AbortSignal.any([signal,this.lifetime.signal]);
    await this.discover(signal);
    if(this.inactive() || this.discoveryNeeded || signal.aborted)return false;
    const epoch=this.supplierEpoch;
    const job = this.db.prepare("SELECT * FROM assistant_link_jobs WHERE retry_at <= ? ORDER BY priority DESC, retry_at, rowid LIMIT 1").get(Date.now()) as Job | undefined;
    if (job === undefined || signal.aborted) return false;
    const attemptController=new AbortController();
    const attempt={threadId:job.thread_id,controller:attemptController};
    this.activeAttempts.add(attempt);
    signal=AbortSignal.any([signal,attemptController.signal]);
    // Stop obsolete attempts at native-I/O boundaries. Priority-only updates
    // preserve version, so they remain the current attempt.
    const stillCurrent=():boolean=>{
      if(this.inactive() || signal.aborted)return false;
      if(epoch!==this.supplierEpoch)return false;
      const current=this.db.prepare("SELECT version FROM assistant_link_jobs WHERE thread_id = ?").get(job.thread_id) as {version:number}|undefined;
      return current?.version===job.version;
    };
    const diagnostics=new MentionDiagnostics(()=>!this.disposed && this.db.open && !signal.aborted);
    let outerDiagnostic:MentionDiagnosticOperation|undefined;
    const checkpoints=new CollectionCheckpoints(this.db);
    let prefetchedPage:Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["timeline"]>>|undefined;
    let checkpoint=checkpoints.load(job.thread_id);
    const continuing=checkpoint && !checkpoint.ready && this.continuations.get(job.thread_id)===job.version;
    try {
      this.watchSources(job.thread_id);
      let title = continuing ? checkpoint!.title : "Thread";
      let deleted = job.deleted === 1;
      let complete = true;
      const messages = new Map<string, ConversationMessage>();
      let environmentId:string|undefined=continuing?checkpoint!.environmentId:undefined;
      let sourceLimited=false;
      let missingMessageSeq=false;
      if (!deleted && !continuing) {
        if(!stillCurrent())return true;
        try {
          const thread = await bounded(s=>this.bb.sdk.threads.get({ threadId: job.thread_id, signal:s }),signal,1000,outerDiagnostic=diagnostics.operation('source-prefetch'));
          if(!stillCurrent())return true;
          if (thread.id!==job.thread_id || thread.projectId !== job.project_id) {(outerDiagnostic=diagnostics.operation('source-prefetch')).fail('source-identity-mismatch');throw new Error("Thread project identity changed.");}
          deleted = thread.deletedAt != null;
          title = thread.title ?? "Thread";
          environmentId=thread.environmentId??undefined;
        } catch (error) {
          if (typeof error === "object" && error !== null && "status" in error && error.status === 404) deleted = true;
          else throw error;
        }
      }
      if (!deleted) {
        if(checkpoint && !continuing){
          // subscribe() has no server observation acknowledgement. An equal
          // event head, socket-open event or sent detail frame cannot certify
          // that earlier history stayed unchanged across a notification gap.
          // Always obtain a native delta witness before reusing source bodies.
          let witness:Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["timeline"]>>;
          try {
            witness=await bounded(s=>this.bb.sdk.threads.timeline({threadId:job.thread_id,
              includeNestedRows:'false',segmentLimit:'100',...(checkpoint!.maxSeq===null?{}:{afterSequence:String(checkpoint!.maxSeq)}),signal:s}),signal,1000,
              outerDiagnostic=diagnostics.operation('timeline-prefetch'));
          }catch(error){
            if(stillCurrent() && typeof error==='object' && error!==null && 'status' in error && error.status===400){
              checkpoints.remove(job.thread_id);this.continuations.delete(job.thread_id);return true;
            }
            throw error;
          }
          if(!stillCurrent())return true;
          const delta=witness.delta;
          const oldMax=checkpoint.maxSeq;
          const order=delta?.rowOrder??checkpoint.headIds??[];
          const olderEnd=witness.timelinePage.olderRowsSourceSeqEnd;
          const olderStable=(witness.timelinePage.olderRowUpdates?.length??0)===0 &&
            (olderEnd===null || (Number.isSafeInteger(olderEnd) && olderEnd!>=0 && oldMax!==null && olderEnd!<=oldMax));
          const knownBoundary=checkpoint.contextBoundarySeq===null || Number.isSafeInteger(checkpoint.contextBoundarySeq);
          const sameBoundary=knownBoundary && witness.contextBoundarySeq===checkpoint.contextBoundarySeq;
          const unchanged=oldMax!==null && witness.maxSeq===oldMax && delta && delta.upsertRows.length===0 &&
            JSON.stringify(order)===JSON.stringify(checkpoint.headIds??[]) && sameBoundary && olderStable;
          if(unchanged){
            if(!checkpoint.ready){this.continuations.set(job.thread_id,job.version);return true;}
          }else {
            // afterSequence describes the latest window, never all history.
            // Extend only a complete, overlapping, strictly append-only source.
            const priorIds=new Set(checkpoints.messageIds(job.thread_id));
            const overlapping=order.some(id=>priorIds.has(id));
            const rows=delta?.upsertRows??[];
            const appendOnly=oldMax!==null && witness.maxSeq>oldMax && checkpoint.ready && checkpoint.complete && !checkpoint.missingMessageSeq &&
              delta && rows.every(row=>row.threadId===job.thread_id && row.sourceSeqStart>oldMax && !priorIds.has(row.id));
            if(appendOnly && overlapping && sameBoundary && olderStable){
              const accepted:ConversationMessage[]=[];let textChars=checkpoint.textChars;let valid=true;
              for(const row of rows){
                if(row.kind!=='conversation' || (row.role!=='assistant' && row.role!=='user'))continue;
                if(row.role==='user' && (row.initiator==='system' || (row.systemMessageKind && row.systemMessageKind!=='unlabeled')))continue;
                if(!Number.isSafeInteger(row.messageSeq) || row.messageSeq<0 || !Number.isSafeInteger(row.createdAt) || row.createdAt<0 || row.createdAt>8_640_000_000_000_000){valid=false;break;}
                textChars+=row.text.length;
                accepted.push({id:row.id,text:row.text,createdAt:row.createdAt,messageSeq:row.messageSeq,anchorSeq:row.sourceSeqStart,role:row.role});
              }
              if(valid && textChars<=MENTION_LIMITS.sourceChars && priorIds.size+accepted.length<=MENTION_LIMITS.messages){
                checkpoint.maxSeq=witness.maxSeq;checkpoint.textChars=textChars;checkpoint.headIds=order;delete checkpoint.pureKey;
                checkpoints.save(job.thread_id,checkpoint,accepted);
              }else {checkpoints.remove(job.thread_id);this.continuations.delete(job.thread_id);return true;}
            }else {
              checkpoints.remove(job.thread_id);checkpoint=undefined;this.continuations.delete(job.thread_id);
              // A full native response is already a fresh first page. A delta
              // without sufficient overlap needs a full request next quantum.
              if(delta)return true;
              prefetchedPage=witness;
            }
          }
        }
        checkpoint??={projectId:job.project_id,maxSeq:null,cursor:null,pages:0,ready:false,complete:false,sourceLimited:false,
          missingMessageSeq:false,textChars:0,title,environmentId};
        checkpoint.projectId=job.project_id;checkpoint.title=title;checkpoint.environmentId=environmentId;
        if(!checkpoint.ready){
          const messageIds=new Set(checkpoints.messageIds(job.thread_id));
          if(!stillCurrent())return true;
          const cursor=checkpoint.cursor;
          const page=prefetchedPage??await bounded(s=>this.bb.sdk.threads.timeline({
            threadId:job.thread_id,includeNestedRows:'false',segmentLimit:'100',signal:s,
            ...(cursor===null?{}:{beforeAnchorSeq:String(cursor.anchorSeq),beforeAnchorId:cursor.anchorId}),
          }),signal,1000,outerDiagnostic=diagnostics.operation('timeline-prefetch')).catch(error=>{
            // Snapshot cursors can expire after pruning/history replacement.
            // Keep the job/retry, discard only its reconstructible source cache.
            if(stillCurrent() && typeof error==='object' && error!==null && 'status' in error && error.status===400){
              checkpoints.remove(job.thread_id);this.continuations.delete(job.thread_id);
            }
            throw error;
          });
          if(!stillCurrent())return true;
          if(checkpoint.pages===0){
            checkpoint.maxSeq=Number.isSafeInteger(page.maxSeq)?page.maxSeq:null;
            checkpoint.contextBoundarySeq=page.contextBoundarySeq;
            checkpoint.headIds=page.rows.map(row=>row.id);
          }
          const accepted:ConversationMessage[]=[];
          for(const row of page.rows){
            if(row.kind!=='conversation' || (row.role!=='assistant' && row.role!=='user') || row.threadId!==job.thread_id)continue;
            if(row.role==='user' && (row.initiator==='system' || (row.systemMessageKind && row.systemMessageKind!=='unlabeled')))continue;
            if(!Number.isSafeInteger(row.createdAt) || row.createdAt<0 || row.createdAt>8_640_000_000_000_000)continue;
            if(!Number.isSafeInteger(row.messageSeq) || row.messageSeq<0){checkpoint.missingMessageSeq=true;continue;}
            if(messageIds.has(row.id))continue;
            if(messageIds.size>=MENTION_LIMITS.messages || checkpoint.textChars+row.text.length>MENTION_LIMITS.sourceChars){checkpoint.sourceLimited=true;break;}
            checkpoint.textChars+=row.text.length;
            const message:ConversationMessage={id:row.id,text:row.text,createdAt:row.createdAt,messageSeq:row.messageSeq,
              anchorSeq:Number.isSafeInteger(row.sourceSeqStart)&&row.sourceSeqStart>=0?row.sourceSeqStart:null,role:row.role};
            messageIds.add(row.id);accepted.push(message);
          }
          checkpoint.pages++;
          checkpoint.complete=page.timelinePage.olderCursor==null && !checkpoint.sourceLimited;
          checkpoint.ready=checkpoint.complete || checkpoint.sourceLimited || checkpoint.pages>=50;
          const next=page.timelinePage.olderCursor;
          if(!checkpoint.ready && (next===null || (cursor!==null && next.anchorId===cursor.anchorId && next.anchorSeq===cursor.anchorSeq))){
            (outerDiagnostic=diagnostics.operation('timeline-prefetch')).fail('timeline-cursor-stalled');throw new Error('Timeline cursor did not advance.');
          }
          checkpoint.cursor=next;
          if(!stillCurrent())return true;
          checkpoints.save(job.thread_id,checkpoint,accepted);
          if(!checkpoint.ready){this.continuations.set(job.thread_id,job.version);return true;}
        }
        complete=checkpoint.complete;sourceLimited=checkpoint.sourceLimited;missingMessageSeq=checkpoint.missingMessageSeq;
      } else { checkpoints.remove(job.thread_id); }
      if(!stillCurrent())return true;
      let context:ContextBundleV1|undefined;
      if(!deleted){
        context=await this.context(job.project_id,job.thread_id,environmentId,signal,diagnostics);
        if(!stillCurrent())return true;
      }
      if(!stillCurrent())return true;
      const pureKey=sha256Hex(JSON.stringify([1,checkpoint?.maxSeq,title,context,this.bb.server.experimental_appUrl,
        this.suppliers.map(s=>[s.client.pluginId,s.capabilities.revision]),this.discoveryIncomplete,this.failedSuppliers]));
      if(!deleted && checkpoint?.pureKey===pureKey && checkpoint.pureReceipt &&
        JSON.stringify(checkpoints.receipt(job.project_id,job.thread_id))===JSON.stringify(checkpoint.pureReceipt)){
        // Only a successful scan with no native verification can leave this
        // receipt. Its pure inputs and supplier revisions are unchanged. Native
        // thread/file reads are never skipped by a source-sequence checkpoint.
        this.db.transaction(()=>{
          if(!stillCurrent())return;
          this.db.prepare(`UPDATE mention_streams SET last_successful_scan_at=? WHERE producer_plugin_id='cross-references'
            AND source_resource_id IN (SELECT id FROM resources WHERE provider='bb' AND canonical_keys_json=?)`)
            .run(Date.now(),JSON.stringify({project:job.project_id,thread:job.thread_id}));
          this.db.prepare(`UPDATE mention_occurrences SET observed_at=? WHERE producer_plugin_id='cross-references' AND confirmed_in_scan=1
            AND source_resource_id IN (SELECT id FROM resources WHERE provider='bb' AND canonical_keys_json=?)`)
            .run(Date.now(),JSON.stringify({project:job.project_id,thread:job.thread_id}));
          this.db.prepare('DELETE FROM assistant_link_jobs WHERE thread_id=? AND version=?').run(job.thread_id,job.version);
          this.db.prepare(`INSERT INTO assistant_link_sync(thread_id,synced_at) VALUES (?,?)
            ON CONFLICT(thread_id) DO UPDATE SET synced_at=excluded.synced_at`).run(job.thread_id,Date.now());
          checkpoints.save(job.thread_id,checkpoint!,[]);
          this.continuations.delete(job.thread_id);
        })();
        return true;
      }
      if(!deleted){
        const retained=new Map(checkpoints.messages(job.thread_id).map(message=>[message.id,message]));
        for(const id of checkpoint?.headIds??[]){const message=retained.get(id);if(message){messages.set(id,message);retained.delete(id);}}
        for(const [id,message] of retained)messages.set(id,message);
      }
      let nativeReads=false;
      const recognitionCache=new RecognitionCheckpointCache(this.db,stillCurrent,this.recognitionCache);
      this.recognitionCache=recognitionCache;
      const fileVerifier=createMentionFileVerifier(this.bb,{threadId:job.thread_id,projectId:job.project_id,environmentId});
      const scan:MentionScan=deleted?{occurrences:[],observedMessageIds:[],scannedMessageIds:[],failedSuppliers:[],discoveryIncomplete:false,
        coverage:{timelineComplete:true,reasons:[],retentionLimited:false}}:await collectConversationMentions({messages:[...messages.values()],
        context:context!,clients:this.suppliers,
        getThread:(threadId,requestSignal,diagnostic)=>{nativeReads=true;requestSignal.throwIfAborted();return bounded(s=>this.bb.sdk.threads.get({threadId,signal:s}),requestSignal,500,diagnostic,true);},
        verifyFile:(file,requestSignal,diagnostic)=>{nativeReads=true;requestSignal.throwIfAborted();return fileVerifier(file,requestSignal,diagnostic);},signal,appUrl:this.bb.server.experimental_appUrl??undefined,
        discoveryIncomplete:this.discoveryIncomplete,failedSuppliers:this.failedSuppliers,cache:recognitionCache,diagnostics});
      scan.coverage.timelineComplete=complete;
      if(missingMessageSeq){scan.coverage.timelineComplete=false;scan.coverage.reasons.push('missing-message-seq');}
      if(!complete)scan.coverage.reasons.push(sourceLimited?'source-text-budget':'timeline-50-pages');
      if (!stillCurrent()) return true;
      let committed=false;
      const signals = this.db.transaction(() => {
        const current = this.db.prepare("SELECT version FROM assistant_link_jobs WHERE thread_id = ?").get(job.thread_id) as { version: number } | undefined;
        if (current?.version !== job.version || epoch!==this.supplierEpoch || this.disposed || signal.aborted) return [];
        const result = this.store.replaceConversationMentions(
          threadResource(job.project_id, job.thread_id, { label: assistantLinkLabel(title, "Thread"), url: `/projects/${job.project_id}/threads/${job.thread_id}` }),
          scan, deleted,
        );
        this.db.prepare("DELETE FROM assistant_link_jobs WHERE thread_id = ? AND version = ?").run(job.thread_id, job.version);
        this.db.prepare(`INSERT INTO assistant_link_sync(thread_id, synced_at) VALUES (?, ?)
          ON CONFLICT(thread_id) DO UPDATE SET synced_at = excluded.synced_at`).run(job.thread_id, Date.now());
        if(checkpoint && !deleted){
          if(!nativeReads && scan.coverage.reasons.length===0 && !scan.discoveryIncomplete && scan.failedSuppliers.length===0){
            checkpoint.pureKey=pureKey;checkpoint.pureReceipt=checkpoints.receipt(job.project_id,job.thread_id);
          }else {delete checkpoint.pureKey;delete checkpoint.pureReceipt;}
          checkpoints.save(job.thread_id,checkpoint,[]);
        }
        this.continuations.delete(job.thread_id);
        committed=true;
        return result;
      })();
      for (const changed of signals) {if(this.inactive() || signal.aborted)break;this.publish(changed,threadIdentity(job.project_id,job.thread_id));}
      if(committed && !this.inactive() && !signal.aborted && epoch===this.supplierEpoch && scan.coverage.reasons.length)this.bb.log.warn(`Cross References collection incomplete for ${job.thread_id}: ${scan.coverage.reasons.join(', ')}. Prior unvisited locations retained within caps. Diagnostics: ${diagnostics.encode()}`);
    } catch (error) {
      if (stillCurrent()) {
        const retryAt = Date.now() + Math.min(60_000, 1_000 * 2 ** Math.min(job.attempts, 6));
        this.db.prepare(`UPDATE assistant_link_jobs SET retry_at = ?, attempts = attempts + 1
          WHERE thread_id = ? AND version = ?`).run(retryAt, job.thread_id, job.version);
        diagnostics.fallback(outerDiagnostic);
        this.bb.log.warn(`Could not collect Cross References for ${job.thread_id}: Diagnostics: ${diagnostics.encode()}`);
      }
    }
    finally {diagnostics.close();this.activeAttempts.delete(attempt);this.watchSources();}
    return true;
  }

  private wait(signal: AbortSignal, delay: number): Promise<void> {
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout>;
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        if (this.wake === done) this.wake = undefined;
        resolve();
      };
      this.wake = done;
      timer = setTimeout(done, Math.max(1, Math.min(60_000, delay)));
      signal.addEventListener("abort", done, { once: true });
      if (signal.aborted) done();
    });
  }

  async start(signal: AbortSignal): Promise<void> {
    if(this.inactive() || this.running || signal.aborted)return;
    this.running=true;
    signal=AbortSignal.any([signal,this.lifetime.signal]);
    this.sourceWatchSignal=signal;
    const subscriptions:Array<()=>void>=[];
    let listening=true;
    const stop=()=>{listening=false;for(const off of subscriptions.splice(0))off();for(const off of this.sourceWatches.values())off();this.sourceWatches.clear();this.sourceWatchSignal=undefined;};
    signal.addEventListener('abort',stop,{once:true});
    try {
      subscriptions.push(this.bb.sdk.subscribe({event:'system:changed',callback:event=>{
        if(!listening || signal.aborted)return;
        if(event.changes.includes('plugins-changed'))this.invalidateSuppliers();
        if(event.changes.some(change=>change==='config-changed' || change==='ui-preferences-changed' || change==='provider-registrations-changed'))this.invalidateSources();
      }}));
      if(!listening || this.inactive() || signal.aborted)return;
      subscriptions.push(this.bb.sdk.subscribe({event:'realtime:connection',callback:event=>{
        if(listening && !signal.aborted && event.reconnected){this.invalidateSources();this.invalidateSuppliers();}
      }}));
      if(!listening || this.inactive() || signal.aborted)return;
      await this.discover(signal);
      if(this.inactive() || signal.aborted)return;
      // Across a stopped service, public events cannot prove that UI surface
      // preferences stayed unchanged. Reconstruct completed snapshots once;
      // pending cursors still resume or fail closed through native validation.
      this.db.prepare("DELETE FROM assistant_link_checkpoints WHERE json_extract(state_json,'$.ready')=1").run();
      this.watchSources();
      this.seed();
      while (!this.inactive() && !signal.aborted) {
        if (await this.processNext(signal)) { await yieldToHost(); continue; }
        if(this.inactive() || signal.aborted)return;
        const next = this.db.prepare("SELECT MIN(retry_at) AS retry_at FROM assistant_link_jobs").get() as { retry_at: number | null };
        await this.wait(signal, next.retry_at === null ? 60_000 : next.retry_at - Date.now());
      }
    } finally {
      stop();
      signal.removeEventListener('abort',stop);
      this.running=false;
    }
  }
}
