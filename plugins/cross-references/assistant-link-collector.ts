import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type Database from "better-sqlite3";
import { assistantLinkLabel } from "./assistant-links.ts";
import { ContextBundleV1Schema, type ContextBundleV1, type TaggedCandidateV1 } from "@phosphorco/bb-context-recognition";
import { createRecognitionDiscoveryOwner, enumerateRecognitionSuppliers, createSupplierClient, type ReadyRecognitionSupplier } from "@phosphorco/bb-context-recognition/bb";
import { MentionDiagnostics, type MentionDiagnosticOperation } from './mention-file-contract.ts';
import { createMentionFileVerifier } from './mention-files.ts';
import { collectConversationMentions, type ConversationMessage } from "./mention-collection.ts";
import { MENTION_LIMITS, type MentionScan } from "./mention-evidence.ts";
import { threadIdentity, threadResource } from "./canonical.ts";
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
  private readonly recognitionCache=new Map<string,TaggedCandidateV1[]>();
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
  private readonly publish: (signal: CrossReferencesChangedSignal) => void;
  constructor(bb: BbPluginApi, db: Database.Database, store: CrossReferenceStore, publish: (signal: CrossReferencesChangedSignal) => void) {
    this.bb = bb;
    this.db = db;
    this.store = store;
    this.publish = publish;
  }

  /** Discovery is event-driven and shared by this one server collector. Pending
   * source jobs, not a detached promise, own subsequent recognition work. */
  invalidateSuppliers():void {
    if(this.inactive())return;
    this.recognitionCache.clear();
    this.supplierEpoch++;
    this.discoveryNeeded=true;
    this.discoveryOwner.dispose();
    this.seed();
    this.wake?.();
  }

  dispose():void {
    if(this.disposed)return;
    this.disposed=true;
    this.supplierEpoch++;
    this.lifetime.abort();
    this.discoveryOwner.dispose();
    this.recognitionCache.clear();
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
    const diagnostics=new MentionDiagnostics(()=>!this.disposed && this.db.open && !signal.aborted);
    let outerDiagnostic:MentionDiagnosticOperation|undefined;
    try {
      let title = "Thread";
      let deleted = job.deleted === 1;
      let complete = true;
      const messages = new Map<string, ConversationMessage>();
      let environmentId:string|undefined;
      let sourceLimited=false;
      let missingMessageSeq=false;
      let textChars=0;
      if (!deleted) {
        try {
          const thread = await bounded(s=>this.bb.sdk.threads.get({ threadId: job.thread_id, signal:s }),signal,1000,outerDiagnostic=diagnostics.operation('source-prefetch'));
          if(this.inactive() || signal.aborted)return true;
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
        let cursor: { anchorSeq: number; anchorId: string } | null = null;
        for (let pageNumber = 0; pageNumber < 50; pageNumber++) {
          if (this.inactive() || signal.aborted) return true;
          const page = await bounded(s=>this.bb.sdk.threads.timeline({
            threadId: job.thread_id, includeNestedRows: "false", segmentLimit: "100", signal:s,
            ...(cursor === null ? {} : { beforeAnchorSeq: String(cursor.anchorSeq), beforeAnchorId: cursor.anchorId }),
          }),signal,1000,outerDiagnostic=diagnostics.operation('timeline-prefetch'));
          if(this.inactive() || signal.aborted)return true;
          for (const row of page.rows) {
            if (row.kind !== "conversation" || (row.role !== "assistant" && row.role !== "user") || row.threadId!==job.thread_id) continue;
            if(row.role==='user' && (row.initiator==='system' || (row.systemMessageKind && row.systemMessageKind!=='unlabeled')))continue;
            if (!Number.isSafeInteger(row.createdAt) || row.createdAt<0 || row.createdAt>8_640_000_000_000_000)continue;
            if(!Number.isSafeInteger(row.messageSeq) || row.messageSeq<0){missingMessageSeq=true;continue;}
            if(messages.has(row.id))continue;
            if(messages.size>=MENTION_LIMITS.messages || textChars+row.text.length>MENTION_LIMITS.sourceChars){sourceLimited=true;break;}
            textChars+=row.text.length;
            messages.set(row.id, { id:row.id, text:row.text, createdAt:row.createdAt,messageSeq:row.messageSeq,
              anchorSeq:Number.isSafeInteger(row.sourceSeqStart)&&row.sourceSeqStart>=0?row.sourceSeqStart:null,role:row.role });
          }
          complete = page.timelinePage.olderCursor == null;
          if (sourceLimited){complete=false;break;}
          if (complete) break;
          const next = page.timelinePage.olderCursor;
          if (next === null || (cursor !== null && next.anchorId === cursor.anchorId && next.anchorSeq === cursor.anchorSeq)) {(outerDiagnostic=diagnostics.operation('timeline-prefetch')).fail('timeline-cursor-stalled');throw new Error("Timeline cursor did not advance.");}
          cursor = next;
        }
      }
      const scan:MentionScan=deleted?{occurrences:[],observedMessageIds:[],scannedMessageIds:[],failedSuppliers:[],discoveryIncomplete:false,
        coverage:{timelineComplete:true,reasons:[],retentionLimited:false}}:await collectConversationMentions({messages:[...messages.values()],
        context:await this.context(job.project_id,job.thread_id,environmentId,signal,diagnostics),clients:this.suppliers,
        getThread:(threadId,requestSignal,diagnostic)=>bounded(s=>this.bb.sdk.threads.get({threadId,signal:s}),requestSignal,500,diagnostic,true),
        verifyFile:createMentionFileVerifier(this.bb,{threadId:job.thread_id,projectId:job.project_id,environmentId}),signal,appUrl:this.bb.server.experimental_appUrl??undefined,
        discoveryIncomplete:this.discoveryIncomplete,failedSuppliers:this.failedSuppliers,cache:this.recognitionCache,diagnostics});
      scan.coverage.timelineComplete=complete;
      if(missingMessageSeq){scan.coverage.timelineComplete=false;scan.coverage.reasons.push('missing-message-seq');}
      if(!complete)scan.coverage.reasons.push(sourceLimited?'source-text-budget':'timeline-50-pages');
      if (this.inactive() || signal.aborted) return true;
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
        return result;
      })();
      for (const changed of signals) {if(this.inactive() || signal.aborted)break;this.publish(changed);}
      if(!this.inactive() && !signal.aborted && scan.coverage.reasons.length)this.bb.log.warn(`Cross References collection incomplete for ${job.thread_id}: ${scan.coverage.reasons.join(', ')}. Prior unvisited locations retained within caps. Diagnostics: ${diagnostics.encode()}`);
    } catch (error) {
      if (!this.inactive() && !signal.aborted) {
        const retryAt = Date.now() + Math.min(60_000, 1_000 * 2 ** Math.min(job.attempts, 6));
        this.db.prepare(`UPDATE assistant_link_jobs SET retry_at = ?, attempts = attempts + 1
          WHERE thread_id = ? AND version = ?`).run(retryAt, job.thread_id, job.version);
        diagnostics.fallback(outerDiagnostic);
        this.bb.log.warn(`Could not collect Cross References for ${job.thread_id}: Diagnostics: ${diagnostics.encode()}`);
      }
    }
    finally {diagnostics.close();}
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
    const subscriptions:Array<()=>void>=[];
    let listening=true;
    const stop=()=>{listening=false;for(const off of subscriptions.splice(0))off();};
    signal.addEventListener('abort',stop,{once:true});
    try {
      subscriptions.push(this.bb.sdk.subscribe({event:'system:changed',callback:event=>{
        if(listening && !signal.aborted && event.changes.includes('plugins-changed'))this.invalidateSuppliers();
      }}));
      if(!listening || this.inactive() || signal.aborted)return;
      subscriptions.push(this.bb.sdk.subscribe({event:'realtime:connection',callback:event=>{
        if(listening && !signal.aborted && event.reconnected)this.invalidateSuppliers();
      }}));
      if(!listening || this.inactive() || signal.aborted)return;
      await this.discover(signal);
      if(this.inactive() || signal.aborted)return;
      this.seed();
      while (!this.inactive() && !signal.aborted) {
        if (await this.processNext(signal)) continue;
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
