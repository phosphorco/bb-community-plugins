import { createMailbox, requestMailbox, mailboxDeadlines } from "./mailbox.ts";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Record, Run } from "./contracts.ts";
import { terminal, collectorStatusSchema, type CollectorStatus } from "./contracts.ts";
import { Store } from "./store.ts";
import { runBash, CAPTURE_BYTES } from "./runner.ts";

//20s server waits + normal CLI bootstrap fit35s; one transient poll may recover
//within60s. The90s server heartbeat window exceeds that client retry window.
export const collectorPolicy = { ...mailboxDeadlines, transportGraceMs:60000, resultAckMs:45000, heartbeatMs:90000, collectionGraceMs:110000 } as const;
export const collectorRefusal = (message:string) => Object.assign(new Error(message),{collectorRefused:true});
// Called in both the server and serialized provider worker. Only the known
// assignment credential is redacted; error properties and operational IDs remain.
export function collectorDiagnostic(value:unknown, credential:string) {
  const seen=new Set<object>();
  const helpers={visit(v:unknown,depth:number):any {
    if(typeof v==="string")return credential?v.replaceAll(credential,"[REDACTED collector credential]"):v;
    if(v===undefined)return "[undefined]";
    if(v===null||typeof v!=="object")return typeof v==="bigint"||typeof v==="function"||typeof v==="symbol"?String(v):v;
    if(seen.has(v))return "[circular]";if(depth>10)return "[diagnostic nesting limit]";seen.add(v);
    try{
      if(Array.isArray(v))return v.map(x=>helpers.visit(x,depth+1));
      const result:{[key:string]:unknown}={};if(v instanceof Error)result.name=v.name;
      for(const key of Object.getOwnPropertyNames(v))try{result[key]=helpers.visit((v as any)[key],depth+1);}catch(error){result[key]={unreadableProperty:helpers.visit(error,depth+1)};}
      return result;
    }finally{seen.delete(v);}
  }
  };
  return helpers.visit(value,0);
}
const runSchema = z.object({
  id: z.string().min(1).max(200), generation: z.number().int(),
  started_at: z.number().finite(), ended_at: z.number().finite(), duration_ms: z.number().nonnegative().finite(),
  output: z.string().max(CAPTURE_BYTES), stdout: z.string().max(16000), stderr: z.string().max(16000),
  exit_code: z.number().int().nullable(), problem: z.string().max(4000).optional(),
}).strict();

// The mailbox authenticates one provider-launched process per recipe generation.
// Tokens are never included in public inspection, diagnostics, or observer context.
export class Collectors {
  private store: Store;
  private now: () => number;
  constructor(store: Store, now = Date.now) { this.store = store; this.now = now; }
  install(r: Record, authority: NonNullable<Run["provenance"]>) {
    if(r.collector?.status)r.collector_reports=[...(r.collector_reports??[]),r.collector.status].slice(-3);
    r.collector = { token: randomUUID(), generation: r.generation, authority };
    this.store.save(r);
  }
  access(id: string, thread: string, token: string, worker: string) {
    const r = this.store.get(id), c = r.collector;
    if (!c || r.observer !== thread || c.token !== token || c.worker && c.worker !== worker)
      throw collectorRefusal("Collector assignment mismatch; do not retry with another identity");
    return { r, c };
  }
  status(r: Record, worker:string, input:unknown) {
    if(input===undefined)return;
    const encoded=JSON.stringify(input);if(Buffer.byteLength(encoded)>65536)throw collectorRefusal("Collector status exceeds64KiB");
    const status=collectorStatusSchema.parse(JSON.parse(encoded.replaceAll(r.collector!.token,"[REDACTED collector credential]")));
    if(status.worker!==worker||status.generation!==r.collector!.generation||status.sequence>(r.collector!.sequence??0))throw collectorRefusal("Collector status assignment mismatch");
    r.collector!.status=status;
  }
  poll(id: string, thread: string, token: string, worker: string, status?:unknown) {
    const { r, c } = this.access(id, thread, token, worker);
    this.status(r,worker,status);
    const reason=terminal(r.state)?`subscription-${r.state}`:c.generation!==r.generation?"generation-replaced":r.expires_at!==null&&r.expires_at<=this.now()?"subscription-expired":c.stopped_at!==undefined?"collector-already-stopped":null;
    if(reason){this.store.save(r,false);return {stop:true,reason};}
    c.worker = worker;
    c.heartbeat = this.now();
    const task = r.state === "running" ? c.task : undefined;
    if (task && !task.result) {
      task.claimed ??= worker;
      // Upgrade an already assigned pre-sequence task without changing its ID.
      if (!task.sequence) task.sequence = c.sequence = (c.sequence ?? 0) + 1;
    }
    this.store.save(r, false); // Private liveness must not refresh the shared UI.
    return { stop: false, task: task && !task.result ? {
      id: task.id, sequence: task.sequence, generation: r.generation, recipe: r.recipe,
      history: r.recipe?.history_count ? r.runs.slice(-r.recipe.history_count) : [],
    } : null };
  }
  async wait(id: string, thread: string, token: string, worker: string, previousTask: string | undefined, signal?: AbortSignal, status?:unknown) {
    const hint = this.store.watch(id);
    try {
      // Register before the authoritative read so a concurrent assignment cannot
      // be missed. Heartbeat persistence does not signal this private channel.
      const first = this.poll(id, thread, token, worker, status);
      if (first.stop || first.task && first.task.id !== previousTask) return first;
      const initial = first.task?.id, until = Date.now() + 20000;
      while (Date.now() < until) {
        await hint.wait(Math.min(5000, until - Date.now()), signal);
        const { r, c } = this.access(id, thread, token, worker);
        const task = r.state === "running" && !c.task?.result ? c.task?.id : undefined;
        if (terminal(r.state) || c.generation !== r.generation || task !== initial ||
            r.expires_at !== null && r.expires_at <= this.now()) break;
      }
      return this.poll(id, thread, token, worker);
    } finally { hint.close(); }
  }

  submit(id: string, thread: string, token: string, worker: string, taskId: string, input: unknown) {
    const { r, c } = this.access(id, thread, token, worker), task = c.task;
    if (terminal(r.state) || r.expires_at !== null && r.expires_at <= this.now() || c.generation !== r.generation || !task || task.id !== taskId || task.claimed !== worker)
      throw collectorRefusal("Stale collector result rejected");
    const parsed = runSchema.parse(input);
    if (parsed.generation !== r.generation || Buffer.byteLength(parsed.output) > CAPTURE_BYTES)
      throw collectorRefusal("Invalid collector generation or capture size");
    const run: Run = { ...parsed, provenance: c.authority };
    // The service assigns identity; a collector cannot select a retained run.
    run.id = task.id;
    if (run.exit_code !== 0) run.problem ??= `collector exited ${run.exit_code}`;
    if (!run.output.trim()) run.problem ??= "empty evidence";
    if (task.result) {
      if (JSON.stringify(task.result) !== JSON.stringify(run)) throw collectorRefusal("Sealed evidence cannot be replaced");
      return { accepted: true };
    }
    if (r.state !== "running") throw collectorRefusal("No collection is due");
    task.result = run;
    c.heartbeat = this.now();
    this.store.save(r);
    return { accepted: true };
  }
  stopped(id: string, thread: string, token: string, worker: string, status?:unknown) {
    const { r, c } = this.access(id, thread, token, worker);
    this.status(r,worker,status);c.worker??=worker;c.stopped_at = this.now(); this.store.save(r);
    return { accepted: true };
  }
  async run(r: Record, signal: AbortSignal): Promise<Run> {
    if (!r.collector || r.collector.generation !== r.generation)
      throw new Error("Collector not installed for this generation. Install a recipe and launch its collector through the observer's provider shell; never use server-host execution.");
    const id = randomUUID(), started = this.now();
    const current = this.store.get(r.id);
    current.collector!.sequence = (current.collector!.sequence ?? 0) + 1;
    current.collector!.task = { id, sequence: current.collector!.sequence };
    this.store.save(current);
    const hint = this.store.watch(r.id);
    try { for (;;) {
      if (signal.aborted) throw new Error("collection cancelled");
      const latest = this.store.get(r.id), c = latest.collector;
      if (latest.expires_at !== null && latest.expires_at <= this.now())
        throw new Error("Subscription expired during collection");
      if (latest.generation !== r.generation || c?.task?.id !== id || latest.state !== "running")
        throw new Error("Collection assignment withdrawn");
      if (c.task.result) return c.task.result;
      const now = this.now();
      if (c.stopped_at!==undefined || now - started > r.recipe!.timeout_seconds*1000+collectorPolicy.collectionGraceMs ||
          now - (c.heartbeat ?? started) > collectorPolicy.heartbeatMs) {
        const failed: Run = { id, generation: r.generation, started_at: started, ended_at: now,
          duration_ms: now - started, output: "", stdout: "", stderr: "", exit_code: null,
          provenance: c.authority,
          ...(c.status?{stderr:JSON.stringify(c.status).slice(0,15000)+"\n[collector status excerpt; complete bounded report retained under debug.collector.status]"}:{}),
          problem: c.stopped_at!==undefined ? `Provider collector stopped: ${c.status?.stop?.reason??"legacy worker did not report a reason"}; operation ${c.status?.stop?.operation??"unknown"}. Collection did not run or return evidence; do not infer a target outcome.` : "Provider collector did not return evidence; inspect launch/access errors and repair within the original assignment. Do not bypass provider permissions." };
        c.task.result = failed; this.store.save(latest); return failed;
      }
      await hint.wait(1000, signal);
    } } finally { hint.close(); }
  }
}

type CollectorConfig = { id: string; token: string; generation: number; recipe: Record["recipe"]; expires_at: number | null };
// Serialized alongside runBash into a process launched by the provider's shell.
// There is no local server execution path, host credential injection or terminal API.
export async function collectorMain(config: CollectorConfig, run: typeof runBash, connect = createMailbox, policy:typeof collectorPolicy=collectorPolicy, diagnostic=collectorDiagnostic) {
  const { randomUUID } = await import("node:crypto");
  const worker=randomUUID(),startedAt=Date.now();
  let mailbox:Awaited<ReturnType<typeof createMailbox>>|undefined;
  let active:{id:string;submitting:boolean;controller:AbortController;done:Promise<void>}|undefined;
  let lastGood=Date.now(),stopping=false,sequence=0,lastTask:string|undefined;
  let stop:CollectorStatus["stop"],events:CollectorStatus["events"]=[],eventsOmitted=0,pollFailed=false;
  // Object methods stay self-contained under the native keepNames bundler;
  // nested named functions/assigned arrows acquire out-of-scope build helpers.
  const actions={
  bounded(error:unknown) {
    const value=diagnostic(error,config.token),text=JSON.stringify(value),bytes=Buffer.byteLength(text);
    return bytes<=6000?value:{name:(value as any)?.name??"Error",message:String((value as any)?.message??value).slice(0,1000),excerpt:Buffer.from(text).subarray(0,4000).toString("utf8"),originalDiagnosticBytes:bytes,detailsOmitted:true,fullDiagnostic:"sanitized error emitted to worker stderr"};
  },
  event(operation:string,branch:string,error?:unknown,elapsedMs?:number) {
    if(error!==undefined)process.stderr.write(JSON.stringify({collector:config.id,worker,generation:config.generation,sequence,taskId:active?.id??lastTask??null,operation,branch,at:Date.now(),error:diagnostic(error,config.token)})+"\n");
    events.push({at:Date.now(),operation,branch,...(error!==undefined?{error:actions.bounded(error)}:{}),...(elapsedMs!==undefined?{elapsedMs:Math.max(0,elapsedMs)}:{})});if(events.length>8)eventsOmitted+=events.length-8;events=events.slice(-8);
  },
  status():CollectorStatus {
    const report:CollectorStatus={version:1,worker,generation:config.generation,sequence,taskId:active?.id??lastTask??null,transport:mailbox?.transport??"uninitialized",phase:stopping?"stopped":active?(active.submitting?"result":"recipe"):"poll",startedAt,at:Date.now(),lastGoodAt:lastGood,policy,events:[...events],eventsOmitted,...(stop?{stop}:{})};
    while(Buffer.byteLength(JSON.stringify(report))>60000&&report.events.length>1){report.events.shift();report.eventsOmitted=(report.eventsOmitted??0)+1;}
    return report;
  },
  encode(value:unknown) { return Buffer.from(JSON.stringify(value)).toString("base64").match(/.{1,16000}/g)??[]; },
    async rpc(op:string,extra:string[]=[]) {
      if(!mailbox)throw Error("Collector mailbox not initialized");
      const result=await mailbox.rpc(op,extra);lastGood=Date.now();return result;
    },
    pause(ms:number) { return new Promise<void>(resolve=>setTimeout(resolve,ms)); },
    stop(reason="cleanup",operation="worker",failure=false,error?:unknown,signal?:string) {
      if(!stop)stop={reason,operation,failure,...(signal?{signal}:{}),...(error!==undefined?{error:actions.bounded(error)}:{})};
      stopping=true;active?.controller.abort();mailbox?.abort();
    },
    term() { actions.stop("signal","worker",false,undefined,"SIGTERM"); },
    interrupt() { actions.stop("signal","worker",false,undefined,"SIGINT"); }
  };
  const expiry=setInterval(()=>{if(config.expires_at!==null&&Date.now()>=config.expires_at)actions.stop("deadline-expired","expiry");},250);
  process.once("SIGTERM",actions.term);process.once("SIGINT",actions.interrupt);
  try {
    mailbox=await connect(config.id,config.token,worker);
    while(!stopping) {
      const pollStarted=Date.now();
      try {
        const reply=await actions.rpc("collector-poll",[active?.id??"-",...actions.encode(actions.status())]);
        if(stopping)break;
        if(pollFailed){actions.event("collector-poll","transport-recovered",undefined,Date.now()-pollStarted);pollFailed=false;}
        if(reply.stop){actions.stop(reply.reason??"authoritative-stop","collector-poll");break;}
        if(reply.task&&(reply.task.generation!==config.generation||JSON.stringify(reply.task.recipe)!==JSON.stringify(config.recipe))){actions.stop("assignment-mismatch","collector-poll",true);break;}
        if(reply.task){
          if(!Number.isSafeInteger(reply.task.sequence)||reply.task.sequence<1){actions.stop("invalid-sequence","collector-poll",true);break;}
          if(reply.task.sequence<sequence){await actions.pause(100);continue;}
          if(reply.task.sequence===sequence&&reply.task.id!==lastTask){actions.stop("sequence-identity-mismatch","collector-poll",true);break;}
        }
        if(active&&reply.task?.id!==active.id&&(!active.submitting||reply.task))active.controller.abort();
        if(!active&&reply.task&&reply.task.sequence>sequence){
          const task=reply.task,controller=new AbortController();sequence=task.sequence;lastTask=task.id;
          const current={id:task.id,submitting:false,controller,done:Promise.resolve()};active=current;
          current.done=(async()=>{
            const result=await run(task.recipe,task.history,task.generation,controller.signal);current.submitting=true;
            const chunks=actions.encode(result),deadline=Date.now()+policy.resultAckMs;let failed=false;
            for(;;){
              if(stopping||controller.signal.aborted)return;
              const began=Date.now();
              try{await actions.rpc("collector-result",[task.id,...chunks]);if(failed)actions.event("collector-result","acknowledgement-recovered");break;}
              catch(error){actions.event("collector-result","sealed-result-ack-failed",error,Date.now()-began);failed=true;
                if((error as any)?.collectorRefused===true){actions.stop("mailbox-refused","collector-result",true,error);return;}
                if(Date.now()>=deadline||Date.now()-lastGood>policy.transportGraceMs){actions.stop("result-ack-budget-exhausted","collector-result",true,error);return;}
                await actions.pause(1000);
              }
            }
          })().catch(error=>{actions.event("recipe","recipe-threw",error);actions.stop("recipe-threw","recipe",true,error);}).finally(()=>{if(active===current)active=undefined;});
        }
      }catch(error){
        if(stopping)break;
        actions.event("collector-poll","mailbox-poll-failed",error,Date.now()-pollStarted);pollFailed=true;
        if((error as any)?.collectorRefused===true){actions.stop("mailbox-refused","collector-poll",true,error);break;}
        if(Date.now()-lastGood>policy.transportGraceMs){actions.stop("mailbox-grace-exhausted","collector-poll",true,error);break;}
        await actions.pause(1000);
      }
      await actions.pause(100);
    }
  }catch(error){actions.event("mailbox-initialize","worker-initialization-failed",error);actions.stop("mailbox-initialization-failed","mailbox-initialize",true,error);}
  finally {
    clearInterval(expiry);actions.stop();await active?.done;
    const report=actions.status();process.stderr.write(JSON.stringify({collector:config.id,status:report})+"\n");
    if(mailbox)try{await actions.rpc("collector-stopped",actions.encode(report));}catch(error){actions.event("collector-stopped","stop-report-unconfirmed",error);}
    mailbox?.close();process.removeListener("SIGTERM",actions.term);process.removeListener("SIGINT",actions.interrupt);
  }
  return actions.status();
}
export function collectorSource(r: Record) {
  return `const report = await (${collectorMain.toString()})(${JSON.stringify({ id: r.id, token: r.collector!.token, generation: r.generation, recipe: r.recipe, expires_at: r.expires_at })}, ${runBash.toString()}, async function(id, token, worker) { return (${createMailbox.toString()})(id, token, worker, process.env, ${requestMailbox.toString()}, ${JSON.stringify(collectorPolicy)}); }, ${JSON.stringify(collectorPolicy)}, ${collectorDiagnostic.toString()}); if (report.stop?.failure) process.exitCode = 1;`;
}
export function collectorCommand(id: string, generation: number) {
  // IDs are service generated; quote regardless. The token is fetched in the
  // provider's shell, so it does not appear in tool arguments or debug records.
  return `node --input-type=module -e "$(bb subscribe collector-source '${id.replaceAll("'", "'\\''")}' '${generation}')"`;
}
