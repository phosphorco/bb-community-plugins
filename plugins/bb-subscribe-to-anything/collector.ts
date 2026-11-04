import { createMailbox, requestMailbox } from "./mailbox.ts";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Record, Run } from "./contracts.ts";
import { terminal } from "./contracts.ts";
import { Store } from "./store.ts";
import { runBash, CAPTURE_BYTES } from "./runner.ts";

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
    r.collector = { token: randomUUID(), generation: r.generation, authority };
    this.store.save(r);
  }
  access(id: string, thread: string, token: string, worker: string) {
    const r = this.store.get(id), c = r.collector;
    if (!c || r.observer !== thread || c.token !== token || c.worker && c.worker !== worker)
      throw new Error("Collector assignment mismatch; do not retry with another identity");
    return { r, c };
  }
  poll(id: string, thread: string, token: string, worker: string) {
    const { r, c } = this.access(id, thread, token, worker);
    if (terminal(r.state) || c.generation !== r.generation ||
        r.expires_at !== null && r.expires_at <= this.now()) return { stop: true };
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
  async wait(id: string, thread: string, token: string, worker: string, previousTask: string | undefined, signal?: AbortSignal) {
    const hint = this.store.watch(id);
    try {
      // Register before the authoritative read so a concurrent assignment cannot
      // be missed. Heartbeat persistence does not signal this private channel.
      const first = this.poll(id, thread, token, worker);
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
      throw new Error("Stale collector result rejected");
    const parsed = runSchema.parse(input);
    if (parsed.generation !== r.generation || Buffer.byteLength(parsed.output) > CAPTURE_BYTES)
      throw new Error("Invalid collector generation or capture size");
    const run: Run = { ...parsed, provenance: c.authority };
    // The service assigns identity; a collector cannot select a retained run.
    run.id = task.id;
    if (run.exit_code !== 0) run.problem ??= `collector exited ${run.exit_code}`;
    if (!run.output.trim()) run.problem ??= "empty evidence";
    if (task.result) {
      if (JSON.stringify(task.result) !== JSON.stringify(run)) throw new Error("Sealed evidence cannot be replaced");
      return { accepted: true };
    }
    if (r.state !== "running") throw new Error("No collection is due");
    task.result = run;
    c.heartbeat = this.now();
    this.store.save(r);
    return { accepted: true };
  }
  stopped(id: string, thread: string, token: string, worker: string) {
    const { r, c } = this.access(id, thread, token, worker);
    c.stopped_at = this.now(); this.store.save(r);
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
      if (now - started > (r.recipe!.timeout_seconds + 45) * 1000 ||
          now - (c.heartbeat ?? started) > 30000) {
        const failed: Run = { id, generation: r.generation, started_at: started, ended_at: now,
          duration_ms: now - started, output: "", stdout: "", stderr: "", exit_code: null,
          provenance: c.authority,
          problem: "Provider collector did not return evidence; inspect launch/access errors and repair within the original assignment. Do not bypass provider permissions." };
        c.task.result = failed; this.store.save(latest); return failed;
      }
      await hint.wait(1000, signal);
    } } finally { hint.close(); }
  }
}

type CollectorConfig = { id: string; token: string; generation: number; recipe: Record["recipe"]; expires_at: number | null };
// Serialized alongside runBash into a process launched by the provider's shell.
// There is no local server execution path, host credential injection or terminal API.
export async function collectorMain(config: CollectorConfig, run: typeof runBash, connect = createMailbox) {
  const { randomUUID } = await import("node:crypto");
  const worker = randomUUID();
  const mailbox = await connect(config.id, config.token, worker);
  const actions = {
  rpc(op: string, extra: string[] = []) { return mailbox.rpc(op, extra); },
  pause(ms: number) { return new Promise<void>(resolve => setTimeout(resolve, ms)); },
  stop() { stopping = true; active?.controller.abort(); mailbox.abort(); },
  };
  let active: { id: string; submitting: boolean; controller: AbortController; done: Promise<void> } | undefined;
  let lastGood = Date.now(), stopping = false;
  let sequence = 0, lastTask: string | undefined;
  const expiry = setInterval(() => {
    if (config.expires_at !== null && Date.now() >= config.expires_at) actions.stop();
  }, 250);
  process.once("SIGTERM", actions.stop); process.once("SIGINT", actions.stop);
  try {
    while (!stopping) {
      try {
        const reply = await actions.rpc("collector-poll", active ? [active.id] : []); lastGood = Date.now();
        if (stopping) break;
        if (reply.stop) { actions.stop(); break; }
        if (reply.task && (reply.task.generation !== config.generation ||
            JSON.stringify(reply.task.recipe) !== JSON.stringify(config.recipe))) {
          actions.stop(); break;
        }
        if (reply.task) {
          if (!Number.isSafeInteger(reply.task.sequence) || reply.task.sequence < 1) { actions.stop(); break; }
          // One fixed generation and a durable monotonic ordinal replace an
          // unbounded UUID Set. Late older replies cannot withdraw newer work.
          if (reply.task.sequence < sequence) { await actions.pause(100); continue; }
          if (reply.task.sequence === sequence && reply.task.id !== lastTask) { actions.stop(); break; }
        }
        if (active && reply.task?.id !== active.id && (!active.submitting || reply.task)) active.controller.abort();
        if (!active && reply.task && reply.task.sequence > sequence) {
          const task = reply.task, controller = new AbortController();
          sequence = task.sequence; lastTask = task.id;
          const current = { id: task.id, submitting: false, controller, done: Promise.resolve() };
          active = current;
          current.done = (async () => {
            const result = await run(task.recipe, task.history, task.generation, controller.signal);
            current.submitting = true;
            // Retry only this sealed payload, never rerun a task after a lost receipt.
            const encoded = Buffer.from(JSON.stringify(result)).toString("base64");
            const chunks = encoded.match(/.{1,16000}/g) || [];
            const deadline = Date.now() + 15000;
            for (;;) {
              if (stopping || controller.signal.aborted) return;
              try { await actions.rpc("collector-result", [task.id, ...chunks]); break; }
              catch { if (Date.now() >= deadline || Date.now() - lastGood > 15000) { actions.stop(); return; } await actions.pause(1000); }
            }
          })().catch(() => actions.stop()).finally(() => { if (active === current) active = undefined; });
        }
      } catch {
        // A lost server connection never broadens authority or replays a recipe.
        if (Date.now() - lastGood > 15000) { actions.stop(); break; }
        await actions.pause(1000);
      }
      await actions.pause(100);
    }
  } finally {
    clearInterval(expiry);
    actions.stop(); await active?.done;
    await actions.rpc("collector-stopped").catch(() => {});
    mailbox.close();
    process.removeListener("SIGTERM", actions.stop); process.removeListener("SIGINT", actions.stop);
  }
}
export function collectorSource(r: Record) {
  return `await (${collectorMain.toString()})(${JSON.stringify({ id: r.id, token: r.collector!.token, generation: r.generation, recipe: r.recipe, expires_at: r.expires_at })}, ${runBash.toString()}, async function(id, token, worker) { return (${createMailbox.toString()})(id, token, worker, process.env, ${requestMailbox.toString()}); });`;
}
export function collectorCommand(id: string, generation: number) {
  // IDs are service generated; quote regardless. The token is fetched in the
  // provider's shell, so it does not appear in tool arguments or debug records.
  return `node --input-type=module -e "$(bb subscribe collector-source '${id.replaceAll("'", "'\\''")}' '${generation}')"`;
}
