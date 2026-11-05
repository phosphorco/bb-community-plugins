import { Store } from '@tanstack/store';
import { MARKDOWN_LIMITS, MarkdownPrepareOutputSchema, MarkdownRequestSchema, createLiteralMarkdown, markdownRequestKey, type MarkdownRequest, type MarkdownPrepareInput, type PreparedMarkdown } from './index.js';

/** One transport belongs to a mounted surface and calls that plugin's backend. */
export interface MarkdownTransport {
  prepare(input: MarkdownPrepareInput, signal: AbortSignal): Promise<unknown>;
  invalidate?(): Promise<void> | void;
}
export type MarkdownSnapshot = { model: PreparedMarkdown; error: string | null };
type Entry = {
  request: MarkdownRequest; store: Store<MarkdownSnapshot>; refs: number; visible: number;
  base: boolean; enriched: boolean; flight: number | null; pending?: PreparedMarkdown;
};
export const SURFACE_LIMITS = Object.freeze({ entries: 256, chars: 4_194_304, concurrency: 2, batch: MARKDOWN_LIMITS.requests, timeoutMs: 7000 });

/** TanStack owns values/subscriptions. This owner schedules bounded resources only:
 * no polling, supplier discovery, clocks in leaves or second notification graph. */
export function createMarkdownSurface(transport: MarkdownTransport) {
  const entries = new Map<string, Entry>();
  const flights = new Set<AbortController>();
  let active = false, visible = true, generation = 0, scheduled = false, refreshing = false, running = 0, retainedChars = 0;
  let busy: (key: string) => boolean = () => false;
  function publish(key: string, entry: Entry, model: PreparedMarkdown) {
    if (busy(key)) { entry.pending = model; return; }
    delete entry.pending;
    entry.store.setState(() => ({model, error: null}));
  }
  function collect() {
    for (const [key, entry] of entries) {
      if (entries.size < SURFACE_LIMITS.entries && retainedChars < SURFACE_LIMITS.chars) break;
      if (!entry.refs && entry.flight===null) { entries.delete(key); retainedChars -= key.length + entry.request.content.length; }
    }
  }
  function entryFor(request: MarkdownRequest): Entry {
    const parsed = MarkdownRequestSchema.parse(request), key = markdownRequestKey(parsed);
    const existing = entries.get(key); if (existing) return existing;
    collect();
    const row: Entry = { request: parsed, store: new Store<MarkdownSnapshot>({model:createLiteralMarkdown(parsed),error:null}), refs:0,visible:0,base:false,enriched:false,flight:null };
    const size = key.length + parsed.content.length;
    // Over-capacity content stays readable and inert; it never forces an
    // unbounded active cache or evicts a mounted source's state.
    if (entries.size >= SURFACE_LIMITS.entries || retainedChars + size > SURFACE_LIMITS.chars) return row;
    entries.set(key,row); retainedChars += size; return row;
  }
  function queue() {
    if (scheduled || !active || !visible || refreshing) return;
    scheduled = true;
    queueMicrotask(() => { scheduled = false; pump(); });
  }
  function pump() {
    if (!active || !visible || refreshing) return;
    while (running < SURFACE_LIMITS.concurrency) {
      const eligible = [...entries].filter(([,e]) => e.refs > 0 && e.visible > 0 && e.flight===null && (!e.base || !e.enriched));
      if (!eligible.length) break;
      // Base work is always admitted before metadata enrichment.
      const phase = eligible.some(([,e])=>!e.base) ? 'base' : 'enrich';
      let chars=0;
      const batch = eligible.filter(([,e]) => phase === 'base' ? !e.base : e.base && !e.enriched).filter(([,e])=> {
        if(chars+e.request.content.length > MARKDOWN_LIMITS.textChars) return false;
        chars += e.request.content.length; return true;
      }).slice(0,SURFACE_LIMITS.batch);
      if (!batch.length) break;
      const epoch=generation, controller=new AbortController(); flights.add(controller); running++;
      for(const [,e] of batch)e.flight=epoch;
      let timer: ReturnType<typeof setTimeout>;
      const timeout = new Promise<never>((_,reject)=>{ timer=setTimeout(()=>{controller.abort();reject(Error('Markdown preparation deadline reached.'));},SURFACE_LIMITS.timeoutMs); });
      const operation = Promise.resolve().then(()=>transport.prepare({phase,requests:batch.map(([,e])=>e.request)},controller.signal));
      void Promise.race([operation,timeout]).then(raw=>{
        if(controller.signal.aborted || !active || epoch!==generation)return;
        const models=MarkdownPrepareOutputSchema.parse(raw);
        if(models.length!==batch.length)throw Error('Markdown response does not match the requested batch.');
        // Validate every response before publishing any part of a batch.
        for(let i=0;i<batch.length;i++) {
          const [key,e]=batch[i]!, model=models[i]!;
          if(model.key!==key || model.original!==e.request.content || model.phase!==phase || JSON.stringify(model.source)!==JSON.stringify(e.request.source)) throw Error('Markdown response source does not match its request.');
        }
        for(let i=0;i<batch.length;i++) {
          const [key,e]=batch[i]!, model=models[i]!;
          if(phase==='base')e.base=true;else e.enriched=true;
          if(e.refs && e.visible)publish(key,e,model);else e.pending=model;
        }
      }).catch(error=>{
        if(controller.signal.aborted && epoch!==generation || !active || epoch!==generation)return;
        for(const [,e] of batch){
          // No automatic retry loop. A shared reconnect/refresh invalidates
          // failures, including unchanged content, and retries once on demand.
          e.base=true;e.enriched=true;
          e.store.setState(previous=>({...previous,error:error instanceof Error?error.message:String(error)}));
        }
      }).finally(()=>{
        clearTimeout(timer!);flights.delete(controller);running--;
        for(const [,e] of batch)if(e.flight===epoch)e.flight=null;
        if(active)queue();
      });
    }
  }
  function retire() {
    generation++;refreshing=false;for(const controller of flights)controller.abort();
    // Old operations may ignore abort. Their completions are fenced by the
    // generation; the bounded local race retires them without new fanout.
    for(const entry of entries.values()){entry.flight=null;}
  }
  return {
    entry: entryFor,
    key: markdownRequestKey,
    acquire(request: MarkdownRequest, onScreen=true) {
      const key=markdownRequestKey(request), entry=entryFor(request);entry.refs++;if(onScreen){entry.visible++;if(entry.pending)publish(key,entry,entry.pending);}queue();
      let released=false, currentVisible=onScreen;
      return {store:entry.store,key,
        visibility(value:boolean){if(released||value===currentVisible)return;entry.visible+=value?1:-1;currentVisible=value;if(value&&entry.pending)publish(key,entry,entry.pending);queue();},
        release(){if(released)return;released=true;entry.refs--;if(currentVisible)entry.visible--;collect();},
      };
    },
    start(){if(active)return;active=true;queue();},
    stop(){active=false;retire();},
    visibility(value:boolean){visible=value;if(!value)retire();else{for(const [key,e]of entries)if(e.refs&&e.visible&&e.pending)publish(key,e,e.pending);queue();}},
    interaction(predicate:(key:string)=>boolean){busy=predicate;},
    flushInteractions(){for(const [key,entry] of entries)if(entry.refs&&entry.visible&&entry.pending&&!busy(key))publish(key,entry,entry.pending);},
    refresh(){
      retire();const epoch=generation;
      for(const e of entries.values()){e.base=false;e.enriched=false;delete e.pending;}
      // One owner-local read-cache refresh, never one retry loop per leaf.
      refreshing=true;
      let timer:ReturnType<typeof setTimeout>;
      const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('Markdown cache refresh deadline reached.')),SURFACE_LIMITS.timeoutMs);});
      void Promise.race([Promise.resolve().then(()=>transport.invalidate?.()),timeout]).catch(error=>{
        if(epoch!==generation)return;
        for(const e of entries.values())if(e.refs)e.store.setState(previous=>({...previous,error:error instanceof Error?error.message:String(error)}));
      }).finally(()=>{clearTimeout(timer!);if(epoch===generation){refreshing=false;queue();}});
    },
    inspect(){return {entries:entries.size,chars:retainedChars,active,running,generation};},
  };
}
export type MarkdownSurface = ReturnType<typeof createMarkdownSurface>;
