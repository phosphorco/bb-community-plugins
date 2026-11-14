import { randomUUID } from "node:crypto";
import { Store } from "./store.ts";
import {
  terminal,
  validateRequest,
  recipeSchema,
  publicRecord,
} from "./contracts.ts";
import type { Record, Mode, Run, Finding, Recipe } from "./contracts.ts";
import type { Decision } from "./classifier.ts";

export type Ports = {
  now: () => number;
  owner: (r: Record) => Promise<"available" | "closed" | "offline">;
  launch: (r: Record) => Promise<string>;
  wake: (r: Record) => Promise<unknown>;
  stop: (r: Record) => Promise<void>;
  withdraw?: (f: Finding) => Promise<boolean>;
  send: (f: Finding, r: Record) => Promise<unknown>;
  run: (r: Record, signal: AbortSignal) => Promise<Run>;
  classify: (r: Record, run: Run, signal: AbortSignal) => Promise<Decision>;
};
// A maximum-wait notification has independent timing; only the idle branch
// is invalidated by a newer human acceptance before dispatch.
function idleFinding(f: Finding): { anchor?: number; observed: number } | null {
  if (f.outcome !== "triggered") return null;
  try {
    const evidence = JSON.parse(f.evidence);
    if (evidence?.trigger !== "idle" || evidence.branch !== "idle" || typeof evidence.observed_at !== "number") return null;
    return { observed: evidence.observed_at, ...(typeof evidence.idle_anchor === "number" ? { anchor: evidence.idle_anchor } : {}) };
  } catch { return null; }
}

export class Engine {
  store: Store;
  ports: Ports;
  tasks = new Map<string, Promise<void>>();
  delivering = false;
  busy = new Set<string>();
  controllers = new Map<string, AbortController>();
  constructor(store: Store, ports: Ports) {
    this.store = store;
    this.ports = ports;
  }
  recover() {
    this.store.atomic(() => {
      for (const r of this.store.active()) {
        if (r.state === "running") {
          const sealed = r.collector?.task?.result;
          r.report_blocked = true;
          if (sealed && sealed.generation === r.generation) {
            if (!r.runs.some(run => run.id === sealed.id)) r.runs.push(sealed);
            r.runs = r.runs.slice(-5);
            r.report_blocked = !!sealed.problem;
          }
          r.state = "reviewing";
          r.problem =
            "Host restarted during collection/classification; evidence is incomplete";
          r.review_wake = "pending";
          r.review_due = this.ports.now() + 15 * 60000;
        }
        if (r.launch === "intent") {
          r.state = "uncertain";
          r.problem =
            "Observer launch interrupted; no automatic duplicate launch";
          this.attention(r, r.problem);
        }
        if (r.review_wake === "sending") {
          r.review_wake = "uncertain";
          r.problem = "Observer wake acceptance unknown";
        }
        this.store.save(r);
      }
      for (const f of this.store.findings())
        if (f.delivery === "sending") {
          f.delivery = "uncertain";
          f.problem =
            "Delivery interrupted; may already have reached the thread";
          this.store.putFinding(f);
        }
    });
  }
  attention(r: Record, reason: string) {
    const occurrence = "attention:observer-launch";
    if (!this.store.hasOccurrence(r.id, occurrence))
      this.store.putFinding({
        id: `finding_${randomUUID()}`,
        subscription_id: r.id,
        owner: r.owner,
        occurrence,
        created_at: this.ports.now(),
        outcome: "attention",
        summary: reason,
        evidence:
          "Inspect this subscription; do not recreate or message its observer directly.",
        delivery: "pending",
      });
  }
  create(
    owner: string,
    project: string,
    environment: string | null,
    mode: Mode,
    input: unknown,
  ) {
    const request = validateRequest(mode, input),
      now = this.ports.now();
    if (
      this.store.active().length >= 100 ||
      this.store.owned(owner).filter((r) => !terminal(r.state)).length >= 20
    )
      throw new Error("Active subscription limit reached");
    if (
      "trigger" in request &&
      request.trigger.kind === "idle" &&
      request.trigger.thread !== owner
    )
      throw new Error("Idle subscriptions must target their requesting thread");
    const r: Record = {
      id: `sub_${randomUUID()}`,
      owner,
      project,
      environment,
      mode,
      request,
      state: "subject" in request ? "preparing" : "watching",
      created_at: now,
      expires_at: request.timeout_minutes
        ? now + request.timeout_minutes * 60000
        : null,
      next_at:
        "trigger" in request ? now + request.trigger.seconds * 1000 : now,
      generation: 0,
      revisions: [],
      runs: [],
      checks: 0,
      observer_turns: 0,
      repairs: 0,
      idle_anchor: now,
      idle_fired: false,
      max_anchor: now,
    };
    this.store.save(r);
    return { status: "accepted", subscription_id: r.id };
  }
  owned(id: string, owner: string) {
    const r = this.store.get(id);
    if (r.owner !== owner)
      throw new Error("Subscription belongs to another thread");
    return r;
  }
  inspect(id: string, owner: string, debug = false) {
    return {
      ...publicRecord(this.owned(id, owner), debug),
      findings: this.store.findings(id),
    };
  }
  async cancel(id: string, owner: string) {
    const r = this.owned(id, owner);
    if (!terminal(r.state)) {
      r.state = "cancelled";
      r.generation++;
      r.problem = "Cancelled by owner";
    }
    r.notifications_cancelled=true;
    if (r.observer) r.stop_pending = true;
    this.store.atomic(() => {
      this.store.save(r);
      for (const f of this.store.findings(id))
        if (f.delivery === "pending") {
          f.delivery = "cancelled";
          this.store.putFinding(f);
        } else if(f.delivery==="accepted") {f.withdraw_pending=true;this.store.putFinding(f);}
    });
    this.controllers.get(id)?.abort();
    let shutdown = "not-running";
    if (r.observer) {
      try {
        await this.ports.stop(r);
        const stopped = this.store.get(id);
        stopped.stop_pending = false;
        this.store.save(stopped);
        shutdown = "stop-requested";
      } catch {
        shutdown = "unknown";
      }
    }
    return {
      subscription_id: id,
      state: r.state,
      shutdown,
      already_dispatched: "Queued messages are withdrawn when identifiable; dispatched messages cannot be recalled",
    };
  }
  observer(thread: string, allowUnstartedCollector = false) {
    const r = this.store.active().find((r) => r.observer === thread);
    const unstarted = r?.collector && !r.collector.worker && ["watching", "running"].includes(r.state);
    if (!r || !(["preparing", "reviewing"].includes(r.state) || allowUnstartedCollector && unstarted))
      throw new Error("No active observer disposition is due for this thread");
    if (r.expires_at !== null && r.expires_at <= this.ports.now())
      throw new Error("Subscription has expired");
    return r;
  }
  install(thread: string, input: unknown) {
    const r = this.observer(thread),
      recipe = recipeSchema.parse(input);
    if (recipe.evaluation.kind === "json_changes" && r.mode !== "changes")
      throw new Error("json_changes requires changes mode");
    if (recipe.evaluation.kind === "json_equals" && r.mode === "changes")
      throw new Error("Use json_changes for recurring exact observations");
    if (r.repairs >= 5)
      throw new Error("Recipe revision budget exhausted; report failure");
    r.repairs++;
    r.generation++;
    r.recipe = recipe;
    r.collector = undefined;
    r.report_blocked = true;
    r.revisions.push(recipe);
    r.baseline = undefined;
    r.runs = [];
    r.state = "watching";
    r.next_at = this.ports.now();
    r.problem = undefined;
    r.review_wake = undefined;
    this.store.save(r);
    return { accepted: true, generation: r.generation };
  }
  wait(thread: string, seconds: number, reason: string) {
    const r = this.observer(thread);
    if (!r.recipe) throw new Error("Install a recipe before waiting");
    if (!Number.isInteger(seconds) || seconds < 30 || seconds > 86400)
      throw new Error("Wait must be 30–86400 seconds");
    if (r.mode === "changes" && r.baseline === undefined && r.runs.at(-1) &&
        !r.report_blocked && !r.runs.at(-1)!.problem)
      r.baseline = r.runs.at(-1)!.output;
    r.state = "watching";
    r.next_at = this.ports.now() + seconds * 1000;
    r.problem = reason;
    r.review_wake = undefined;
    this.store.save(r);
    return { accepted: true };
  }
  report(thread: string, summary: string, evidence: string, runId: string) {
    const r = this.observer(thread),
      run = r.runs.at(-1);
    if (
      !run ||
      r.report_blocked ||
      run.id !== runId ||
      run.generation !== r.generation ||
      run.problem
    )
      throw new Error("A current successful sealed run is required");
    if (r.mode === "changes" && r.baseline === undefined)
      throw new Error(
        "Establish the initial baseline with subscription_wait first",
      );
    const occurrence = run.id;
    if (r.recipe?.evaluation.kind === "semantic" && r.mode === "changes") {
      r.baseline = run.output;
      r.last_change_at = run.ended_at;
    }
    this.finding(r, "matched", summary, evidence, occurrence);
    return { accepted: true };
  }
  fail(thread: string, reason: string) {
    const r = this.observer(thread, true);
    this.finding(r, "failed", reason, "", `failed:${r.generation}`);
    return { accepted: true };
  }
  finding(
    r: Record,
    outcome: string,
    summary: string,
    evidence: string,
    occurrence: string,
  ) {
    this.store.atomic(() => {
      if (!this.store.hasOccurrence(r.id, occurrence))
        this.store.putFinding({
          id: `finding_${randomUUID()}`,
          subscription_id: r.id,
          owner: r.owner,
          occurrence,
          created_at: this.ports.now(),
          outcome,
          summary,
          evidence,
          delivery: "pending",
        });
      if (outcome === "expired" || outcome === "failed") r.state = outcome;
      else if (r.mode === "until") r.state = "fulfilled";
      else {
        r.state = "watching";
        r.next_at =
          this.ports.now() + (r.recipe?.interval_seconds ?? 60) * 1000;
      }
      if (terminal(r.state) && r.observer) r.stop_pending = true;
      r.review_wake = undefined;
      r.problem = undefined;
      this.store.save(r);
    });
  }
  activity(owner: string, at: number) {
    for (const r of this.store.owned(owner))
      if (
        (!terminal(r.state) || (r.state === "fulfilled" && this.store.findings(r.id).some(f => f.delivery === "pending" && idleFinding(f) !== null))) &&
        "trigger" in r.request &&
        r.request.trigger.kind === "idle" &&
        at > r.idle_anchor
      ) {
        if (r.state === "fulfilled") r.state = "watching";
        r.idle_anchor = at;
        r.idle_fired = false;
        r.next_at = at + r.request.trigger.seconds * 1000;
        this.store.save(r);
      }
  }
  async tick(signal: AbortSignal, waitForChecks = true) {
    const now = this.ports.now();
    for(const f of this.store.withdrawals()) {
      try {const removed=await this.ports.withdraw?.(f);f.withdraw_pending=false;if(removed)f.delivery="cancelled";this.store.putFinding(f);}catch {/* Retry after transient queue access failure. */}
    }
    for (const cleanup of this.store.cleanups()) {
      try {
        await this.ports.stop(cleanup);
        const latest = this.store.get(cleanup.id);
        latest.stop_pending = false;
        this.store.save(latest);
      } catch {
        /* Durable cleanup retries on the next sweep. */
      }
    }
    for (const snapshot of this.store.active()) {
      if (signal.aborted) break;
      if (this.busy.has(snapshot.id)) continue;
      const due =
        (snapshot.state === "preparing" && !snapshot.launch) ||
        (snapshot.state === "reviewing" &&
          snapshot.review_wake === "pending") ||
        (snapshot.state === "watching" &&
          (snapshot.next_at <= now ||
            ("trigger" in snapshot.request &&
              snapshot.request.trigger.kind === "idle" &&
              snapshot.request.trigger.max_wait_seconds !== undefined &&
              now >=
                snapshot.max_anchor +
                  snapshot.request.trigger.max_wait_seconds * 1000))) ||
        (snapshot.expires_at !== null && snapshot.expires_at <= now) ||
        ((snapshot.state === "preparing" || snapshot.state === "reviewing") &&
          !!snapshot.review_due &&
          snapshot.review_due <= now);
      if (!due || (this.tasks.size >= 4 && !("trigger" in snapshot.request))) continue;
      this.busy.add(snapshot.id);
      const task = this.step(snapshot.id, now, signal)
        .catch((e) => {
          const r = this.store.get(snapshot.id);
          if (!terminal(r.state)) {
            r.problem = String(e);
            r.next_at = now + 60000;
            if (r.state === "running") {
              r.state = "reviewing";
              r.review_wake = "pending";
              r.review_due = now + 15 * 60000;
            }
            this.store.save(r);
          }
        })
        .finally(() => {
          this.busy.delete(snapshot.id);
          this.tasks.delete(snapshot.id);
        });
      this.tasks.set(snapshot.id, task);
    }
    if (waitForChecks) await Promise.all(this.tasks.values());
    if (this.delivering) return;
    this.delivering = true;
    try {
      for (const f of this.store.findings()) {
        if (signal.aborted) break;
        if (f.delivery !== "pending") continue;
        const r = this.store.get(f.subscription_id);
        if (r.state === "cancelled" || r.notifications_cancelled) {
          f.delivery = "cancelled";
          this.store.putFinding(f);
          continue;
        }
        if ((await this.ports.owner(r)) !== "available") continue;
        // Recheck after the asynchronous owner read: cancellation can win there.
        if(this.store.get(r.id).notifications_cancelled){f.delivery="cancelled";this.store.putFinding(f);continue;}
        const current = this.store.get(r.id);
        const idle = idleFinding(f);
        if (idle && "trigger" in current.request && current.request.trigger.kind === "idle" &&
            (idle.anchor === undefined ? current.idle_anchor + current.request.trigger.seconds * 1000 > idle.observed : current.idle_anchor > idle.anchor)) {
          f.delivery = "cancelled";
          f.problem = "New human acceptance invalidated this pending idle finding before dispatch.";
          this.store.putFinding(f);
          continue;
        }
        f.delivery = "sending";
        this.store.putFinding(f);
        try {
          f.receipt = await this.ports.send(f, r);
          f.delivery = "accepted";
          if(this.store.get(r.id).notifications_cancelled)f.withdraw_pending=true;
        } catch (e) {
          f.delivery = "uncertain";
          f.problem = String(e);
        }
        this.store.putFinding(f);
      }
    } finally {
      this.delivering = false;
    }
  }
  async step(id: string, now: number, signal: AbortSignal) {
    let r = this.store.get(id);
    const owner = await this.ports.owner(r);
    r = this.store.get(id);
    if (terminal(r.state)) return;
    if (owner === "closed") {
      await this.cancel(r.id, r.owner);
      return;
    }
    if (r.expires_at !== null && now >= r.expires_at) {
      this.finding(
        r,
        "expired",
        "Subscription lifetime ended before a verified finding.",
        "",
        "expiry",
      );
      this.controllers.get(id)?.abort();
      await this.ports.stop(r).catch(() => {});
      return;
    }
    if (owner !== "available") return;
    if (r.state === "preparing" && !r.launch) {
      if (r.observer_turns >= 20) {
        this.finding(
          r,
          "failed",
          "Observer turn budget exhausted",
          "",
          "budget",
        );
        return;
      }
      r.launch = "intent";
      r.observer_turns++;
      this.store.save(r);
      try {
        const thread = await this.ports.launch(r);
        const latest = this.store.get(id);
        if (terminal(latest.state)) {
          await this.ports.stop({ ...latest, observer: thread });
          return;
        }
        latest.observer = thread;
        latest.launch = "confirmed";
        latest.review_due = this.ports.now() + 15 * 60000;
        this.store.save(latest);
      } catch (e) {
        r = this.store.get(id);
        if (!terminal(r.state)) {
          r.state = "uncertain";
          r.problem = `Observer launch uncertain: ${String(e)}`;
          this.attention(r, r.problem);
          this.store.save(r);
        }
      }
      return;
    }
    if (
      (r.state === "preparing" || r.state === "reviewing") &&
      r.review_due &&
      now >= r.review_due
    ) {
      this.finding(
        r,
        "failed",
        "Observer did not submit a disposition within 15 minutes.",
        "",
        "observer-timeout",
      );
      await this.ports.stop(r).catch(() => {});
      return;
    }
    if (r.state === "reviewing" && r.review_wake === "pending") {
      if (r.observer_turns >= 20) {
        this.finding(
          r,
          "failed",
          "Observer turn budget exhausted",
          "",
          "budget",
        );
        return;
      }
      r.review_wake = "sending";
      r.observer_turns++;
      r.review_due = now + 15 * 60000;
      this.store.save(r);
      try {
        await this.ports.wake(r);
        const latest = this.store.get(id);
        if (latest.state === "reviewing" && latest.review_wake === "sending") {
          latest.review_wake = "accepted";
          this.store.save(latest);
        }
      } catch (e) {
        const latest = this.store.get(id);
        if (latest.state === "reviewing") {
          latest.review_wake = "uncertain";
          latest.problem = String(e);
          this.store.save(latest);
        }
      }
      return;
    }
    if (r.state !== "watching") return;
    if ("trigger" in r.request) {
      const t = r.request.trigger;
      const maxDue =
        t.kind === "idle" &&
        t.max_wait_seconds !== undefined &&
        now >= r.max_anchor + t.max_wait_seconds * 1000;
      if (now < r.next_at && !maxDue) return;
      if (
        t.kind === "idle" &&
        r.idle_fired &&
        t.repeat === "per_idle_episode" &&
        !maxDue
      ) {
        r.next_at = now + Math.min(t.seconds, 30) * 1000;
        this.store.save(r);
        return;
      }
      const boundary =
        t.kind === "interval"
          ? Math.floor((now - r.created_at) / (t.seconds * 1000))
          : now;
      const missed =
        t.kind === "interval"
          ? Math.max(0, Math.floor((now - r.next_at) / (t.seconds * 1000)))
          : 0;
      this.finding(
        r,
        "triggered",
        r.request.message,
        JSON.stringify({
          trigger: t.kind,
          branch: maxDue ? "maximum_wait" : t.kind,
          scheduled_at: r.next_at,
          observed_at: now,
          ...(t.kind === "idle" ? { idle_anchor: r.idle_anchor } : {}),
          missed_boundaries: missed,
        }),
        `timer:${boundary}`,
      );
      r = this.store.get(id);
      r.next_at =
        t.kind === "interval"
          ? r.created_at + (boundary + 1) * t.seconds * 1000
          : now + t.seconds * 1000;
      r.idle_fired = true;
      r.max_anchor = now;
      this.store.save(r);
      return;
    }
    if (now < r.next_at || !r.recipe) return;
    r.state = "running";
    r.report_blocked = true;
    if (r.collector) r.collector.task = undefined;
    const generation = r.generation;
    this.store.save(r);
    const controller = new AbortController();
    this.controllers.set(id, controller);
    try {
      const run = await this.ports.run(
        r,
        AbortSignal.any([signal, controller.signal]),
      );
      let latest = this.store.get(id);
      if (latest.generation !== generation || latest.state !== "running")
        return;
      if (latest.expires_at !== null && this.ports.now() >= latest.expires_at) {
        this.finding(
          latest,
          "expired",
          "Subscription expired during observation",
          "",
          "expiry",
        );
        return;
      }
      const decision = await this.ports.classify(
        r,
        run,
        AbortSignal.any([signal, controller.signal]),
      );
      latest = this.store.get(id);
      if (latest.generation !== generation || latest.state !== "running")
        return;
      if (latest.expires_at !== null && this.ports.now() >= latest.expires_at) {
        this.finding(
          latest,
          "expired",
          "Subscription expired during classification",
          "",
          "expiry",
        );
        return;
      }
      run.classification = decision.reason;
      latest.runs.push(run);
      latest.report_blocked = !!run.problem;
      latest.runs = latest.runs.slice(-5);
      latest.checks++;
      if (decision.baseline !== undefined) {
        if (latest.baseline !== decision.baseline)
          latest.last_change_at = run.ended_at;
        latest.baseline = decision.baseline;
      }
      latest.state = decision.kind === "pending" ? "watching" : "reviewing";
      latest.next_at =
        this.ports.now() + latest.recipe!.interval_seconds * 1000;
      latest.problem =
        decision.kind === "pending" ? undefined : decision.reason;
      if (decision.kind === "review") {
        latest.review_wake = "pending";
        latest.review_due = this.ports.now() + 15 * 60000;
      }
      this.store.save(latest);
    } finally {
      this.controllers.delete(id);
    }
  }
}
