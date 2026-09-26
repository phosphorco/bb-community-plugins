// Historical capture probes only. Never import this module from production code.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
export const EVENT_PAGE_SIZE = 100;
export const EVENTS_PER_THREAD_LIMIT = 500;

type ListedThread = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["list"]>>[number];
type ThreadEvent = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["events"]["list"]>>[number];

const ANALYTICS_EVENT_TYPES = ["item/completed", "turn/started", "turn/completed"] as const;

/**
 * Read Analytics' bounded newest-first window without exceeding BB's per-call
 * API ceiling. `beforeSeq` is exclusive, so carrying the lowest observed
 * sequence into the next descending page neither skips nor duplicates events.
 */
export async function listRecentThreadEvents(
  events: Pick<BbPluginApi["sdk"]["threads"]["events"], "list">,
  input: { threadId: string; signal: AbortSignal },
): Promise<ThreadEvent[]> {
  const collected: ThreadEvent[] = [];
  let beforeSeq: string | undefined;

  while (collected.length < EVENTS_PER_THREAD_LIMIT) {
    const page = await events.list({
      threadId: input.threadId,
      types: ANALYTICS_EVENT_TYPES,
      order: "desc",
      limit: String(EVENT_PAGE_SIZE),
      ...(beforeSeq === undefined ? {} : { beforeSeq }),
      signal: input.signal,
    });
    collected.push(...page);
    if (page.length < EVENT_PAGE_SIZE) break;
    const lowestSeq = page.reduce<number | null>(
      (lowest, event) => lowest == null ? event.seq : Math.min(lowest, event.seq),
      null,
    );
    if (lowestSeq == null) break;
    beforeSeq = String(lowestSeq);
  }

  return collected;
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Skills are an additive retained source.  Preserve the previous copy-on-write
 * skill generation and let the legacy tool snapshot publish on a skill-only
 * source failure.
 */
export async function reconcileSkillsForAnalytics(
  projector: { refresh?(projectId: string, environmentId: string | null): Promise<unknown>; reconcile?(): Promise<unknown> },
  log: Pick<BbPluginApi["log"], "warn">,
  projectId?: string,
  environmentId: string | null = null,
): Promise<string | null> {
  try {
    if (projectId !== undefined && projector.refresh !== undefined) await projector.refresh(projectId, environmentId);
    else if (projector.reconcile !== undefined) await projector.reconcile();
    else throw new Error("Skills projector has no compatible refresh operation.");
    return null;
  } catch (cause) {
    const message = `Skills retained refresh failed: ${errorText(cause).slice(0, 480)}`;
    log.warn(message);
    return message;
  }
}

export type ForkFreeCaptureTrigger = "refresh" | "thread.created" | "thread.active";
export type ForkFreeCapturePartition = Readonly<{ projectId: string; environmentId: string | null }>;

/** Keep a lifecycle invocation alive through its coalesced retained capture. */
export async function awaitLifecycleSkillCapture(
  capture: () => Promise<void>,
  onFailure: (message: string) => void,
): Promise<void> {
  try {
    await capture();
  } catch (cause) {
    onFailure(`Skills retained refresh failed: ${errorText(cause).slice(0, 480)}`);
  }
}

/**
 * The public projector intentionally has one in-flight request.  Keep every
 * partition on one lane, while collapsing only duplicate lifecycle work for
 * the same partition and trigger.  A recent same-partition lifecycle event is
 * also TTL-suppressed; explicit refreshes always enter the lane.
 */
export function createForkFreeCaptureCoordinator(
  runCapture: (partition: ForkFreeCapturePartition, trigger: ForkFreeCaptureTrigger) => Promise<void>,
  options: Readonly<{ ttlMs: number; failureCooldownMs?: number; now?: () => number }> = { ttlMs: 60_000 },
) {
  const now = options.now ?? Date.now;
  const failureCooldownMs = options.failureCooldownMs ?? options.ttlMs;
  const capturedAt = new Map<string, number>();
  const failedAt = new Map<string, number>();
  const pending = new Map<string, Promise<void>>();
  const dirtyVersion = new Map<string, number>();
  let tail: Promise<void> = Promise.resolve();
  const partitionKey = (partition: ForkFreeCapturePartition) => `${partition.projectId}\u0000${partition.environmentId ?? ""}`;
  const schedule = (partition: ForkFreeCapturePartition, trigger: ForkFreeCaptureTrigger): Promise<void> => {
    const key = partitionKey(partition);
    const pendingKey = `${key}\u0000${trigger}`;
    if (trigger !== "refresh") dirtyVersion.set(key, (dirtyVersion.get(key) ?? 0) + 1);
    const existing = pending.get(pendingKey);
    if (existing !== undefined) return existing;
    if (trigger !== "refresh" && capturedAt.has(key) && now() - capturedAt.get(key)! < options.ttlMs) return Promise.resolve();
    const run = tail = tail.catch(() => undefined).then(async () => {
      const versionAtStart = dirtyVersion.get(key) ?? 0;
      await runCapture(partition, trigger);
      capturedAt.set(key, now());
      failedAt.delete(key);
      if ((dirtyVersion.get(key) ?? 0) === versionAtStart) dirtyVersion.delete(key);
    });
    pending.set(pendingKey, run);
    // `finally()` produces a second rejected promise when `run` rejects. Use
    // both branches directly so a contained background refresh cannot leak an
    // unhandled rejection while callers that intentionally await still see it.
    void run.then(
      () => pending.delete(pendingKey),
      () => {
        failedAt.set(key, now());
        pending.delete(pendingKey);
      },
    );
    return run;
  };
  return {
    schedule,
    needsRefresh(partition: ForkFreeCapturePartition): boolean {
      const key = partitionKey(partition);
      const lastFailure = failedAt.get(key);
      if (lastFailure !== undefined && now() - lastFailure < failureCooldownMs) return false;
      return dirtyVersion.has(key) || !capturedAt.has(key) || now() - capturedAt.get(key)! >= options.ttlMs;
    },
    clear(): void { capturedAt.clear(); failedAt.clear(); pending.clear(); dirtyVersion.clear(); },
  };
}
