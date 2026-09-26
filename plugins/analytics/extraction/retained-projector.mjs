/**
 * The retained projection owner deliberately lives below the server boundary.
 * It talks only to the public threads SDK shape and to a small durable snapshot
 * port.  Server/RPC wiring is a later composition concern.
 */

const DEFAULTS = Object.freeze({
  listPageSize: 200,
  eventPageSize: 100,
  maxListPages: 512,
  maxEventPagesPerThread: 512,
  maxResponseBytes: 32 * 1024 * 1024,
  pullFreshnessMs: 60_000,
  retentionMs: 90 * 24 * 60 * 60 * 1000,
});

function clone(value) { return structuredClone(value); }
function byteLength(value) { return new TextEncoder().encode(JSON.stringify(value)).byteLength; }
function abortError() { const error = new Error("The operation was aborted."); error.name = "AbortError"; return error; }
function failure(code, message) { const error = new Error(message); error.code = code; return error; }

/** Only the exact structural public SDK deletion witness authorizes removal. */
export function isExactThreadNotFound(error) {
  return error != null && typeof error === "object"
    && error.name === "BbHttpError" && error.status === 404 && error.code === "thread_not_found";
}

/**
 * A durable snapshot port.  The implementation is intentionally tiny but its
 * publish operation is copy-on-write: readers see either the old generation or
 * the fully reconciled next generation, never a half-applied member update.
 */
export class RetainedFactStore {
  #snapshot = { generation: 0, checkpoint: { generation: 0 }, threads: {}, coverage: null, publishedAt: null };
  #inFlight = null;
  #injectedWriteFailures = 0;

  read() { return clone(this.#snapshot); }
  getInjectedWriteFailureCount() { return this.#injectedWriteFailures; }
  currentFlight() { return this.#inFlight; }
  setFlight(promise) { this.#inFlight = promise; }
  clearFlight(promise) { if (this.#inFlight === promise) this.#inFlight = null; }

  /** Publication is the sole mutation point and is atomic for all members. */
  publish(next, fault) {
    if (fault === "before-publication") {
      this.#injectedWriteFailures += 1;
      throw failure("persistence-failure", "injected before publication");
    }
    const candidate = clone(next);
    // This is deliberately before assignment.  An interrupted checkpoint write
    // therefore cannot expose candidate rows without its matching checkpoint.
    if (fault === "after-rows-before-checkpoint") {
      this.#injectedWriteFailures += 1;
      throw failure("persistence-failure", "injected after rows before checkpoint");
    }
    this.#snapshot = candidate;
  }
}

function projectedFact(event, dimensions) {
  const item = event?.data?.item;
  if (event?.type !== "item/completed" || item == null || item.status === "pending") return null;
  const type = item.type;
  if (type !== "toolCall" && type !== "commandExecution" && type !== "fileRead") return null;
  const failed = type === "commandExecution"
    ? item.status === "failed" || (item.exitCode ?? 0) !== 0
    : item.status === "failed";
  return {
    sourceEventId: event.id,
    threadId: event.threadId,
    turnId: event.scope?.kind === "turn" ? event.scope.turnId : null,
    sequence: event.seq,
    projectId: dimensions.projectId,
    providerId: dimensions.providerId,
    createdAtMs: event.createdAt,
    turnStartedAtMs: null,
    turnCompletedAtMs: null,
    capabilityKind: type === "toolCall" ? "tool" : type === "commandExecution" ? "command" : "file_read",
    capabilityKey: type === "toolCall" ? `${item.server ?? "unknown"}:${item.tool}` : type === "commandExecution" ? "native:command_execution" : "native:file_read",
    status: item.status === "completed" || item.status === "failed" || item.status === "interrupted" ? item.status : "unknown",
    durationMs: type === "fileRead" ? 0 : Math.max(0, Math.round(item.durationMs ?? 0)),
    failed,
    errorClass: failed ? "other" : null,
    errorSignature: null,
    commandBinary: null,
    commandArgument1: null,
    commandArgument2: null,
    commandUsesHelp: false,
    commandShape: null,
    commandShellWrapped: false,
    commandAttributionEligible: false,
    // A fixture may encode a synthetic value in its public tool name.  This is
    // not a raw event field and is retained only to make the projection result
    // observable by the architecture instrument.
    value: typeof item.retainedValue === "string" ? item.retainedValue : undefined,
  };
}

function sourceLimits(policy) {
  return {
    ...DEFAULTS,
    ...policy,
    listPageSize: Math.max(1, Math.min(DEFAULTS.listPageSize, policy?.listPageSize ?? DEFAULTS.listPageSize)),
    eventPageSize: Math.max(1, Math.min(DEFAULTS.eventPageSize, policy?.eventPageSize ?? DEFAULTS.eventPageSize)),
  };
}

function assertRows(rows, operation) {
  if (!Array.isArray(rows)) throw failure("invalid-source", `${operation} SDK response was not an array.`);
  return rows;
}

/**
 * Demand-owned, single-flight reconciliation.  There is no interval and no
 * unattended background owner: callers cause a pull and share the one actual
 * source traversal for a store.  Every traversal re-pages source history, so
 * rewrites cannot be mistaken for appends.
 */
export function createRetainedFactProjector({ source, store, clock = () => Date.now(), policy = {}, persistenceFault = null }) {
  if (source?.threads == null || typeof source.threads.list !== "function" || typeof source.threads.get !== "function" || typeof source.threads.events?.list !== "function") {
    throw new TypeError("Retained projector requires the public threads SDK port.");
  }
  if (!(store instanceof RetainedFactStore)) throw new TypeError("Retained projector requires a RetainedFactStore.");
  const limits = sourceLimits(policy);
  let disposed = false;
  let lastPullAt = null;

  async function reconcile({ signal } = {}) {
    if (disposed) throw failure("disposed", "Retained projector is disposed.");
    if (signal?.aborted) throw abortError();
    const prior = store.read();
    const now = clock();
    if (lastPullAt != null && now - lastPullAt < limits.pullFreshnessMs) return prior;

    let responseBytes = 0;
    const listed = new Map();
    let offset = 0;
    for (let page = 0; page < limits.maxListPages; page += 1) {
      if (signal?.aborted) throw abortError();
      const rows = assertRows(await source.threads.list({ includeHidden: true, limit: limits.listPageSize, offset, ...(signal ? { signal } : {}) }), "threads.list");
      responseBytes += byteLength(rows);
      if (responseBytes > limits.maxResponseBytes) throw failure("source-read-failure", "retained source response budget exceeded");
      for (const row of rows) {
        if (typeof row?.id !== "string" || row.id.length === 0) throw failure("invalid-source", "threads.list returned an invalid thread ID");
        listed.set(row.id, row);
      }
      offset += rows.length;
      if (rows.length < limits.listPageSize) break;
      if (page === limits.maxListPages - 1) throw failure("source-read-failure", "retained source list page budget exceeded");
    }

    const next = clone(prior);
    const nextThreads = clone(prior.threads);
    let changed = false;
    let degraded = false;
    for (const [threadId, listedThread] of listed) {
      if (signal?.aborted) throw abortError();
      let observed;
      try {
        observed = await source.threads.get({ threadId, ...(signal ? { signal } : {}) });
      } catch (error) {
        if (isExactThreadNotFound(error)) {
          if (Object.hasOwn(nextThreads, threadId)) { delete nextThreads[threadId]; changed = true; }
          continue;
        }
        // A generic read failure never becomes a deletion; do not publish a
        // mixed partial generation after a source uncertainty.
        degraded = true;
        throw failure("source-read-failure", String(error?.message ?? error));
      }
      const dimensions = { projectId: observed.projectId ?? listedThread.projectId, providerId: observed.providerId ?? listedThread.providerId };
      if (typeof dimensions.projectId !== "string" || typeof dimensions.providerId !== "string") throw failure("invalid-source", "thread dimensions were missing from the public SDK result");

      const facts = new Map();
      let afterSeq = null;
      let exhausted = false;
      for (let page = 0; page < limits.maxEventPagesPerThread; page += 1) {
        if (signal?.aborted) throw abortError();
        let rows;
        try {
          rows = assertRows(await source.threads.events.list({ threadId, limit: String(limits.eventPageSize), order: "asc", ...(afterSeq == null ? {} : { afterSeq }), ...(signal ? { signal } : {}) }), "threads.events.list");
        } catch (error) {
          degraded = true;
          throw failure("source-read-failure", String(error?.message ?? error));
        }
        responseBytes += byteLength(rows);
        if (responseBytes > limits.maxResponseBytes) throw failure("source-read-failure", "retained source response budget exceeded");
        if (rows.length > limits.eventPageSize) throw failure("invalid-source", "threads.events.list exceeded its requested page size");
        let previous = afterSeq == null ? -1 : Number(afterSeq);
        for (const event of rows) {
          if (event?.threadId !== threadId || !Number.isSafeInteger(event?.seq) || event.seq <= previous) throw failure("invalid-source", "thread events were not strictly ascending");
          previous = event.seq;
          afterSeq = String(event.seq);
          const fact = projectedFact(event, dimensions);
          if (fact != null) facts.set(fact.sourceEventId, fact);
        }
        if (rows.length < limits.eventPageSize) { exhausted = true; break; }
      }
      if (!exhausted) throw failure("source-read-failure", "retained source event page budget exceeded");
      const retainedFacts = [...facts.values()].filter((fact) => fact.createdAtMs >= now - limits.retentionMs);
      const priorFacts = nextThreads[threadId]?.facts ?? [];
      if (JSON.stringify(priorFacts) !== JSON.stringify(retainedFacts)) changed = true;
      nextThreads[threadId] = { projectId: dimensions.projectId, providerId: dimensions.providerId, facts: retainedFacts, maxObservedSeq: afterSeq == null ? null : Number(afterSeq), updatedAt: observed.updatedAt ?? now };
    }

    // List omission is deliberately not deletion: nextThreads began as the
    // previous retained union and only exact get(404/thread_not_found) removed.
    next.threads = nextThreads;
    const allFacts = Object.values(nextThreads).flatMap((thread) => thread.facts);
    next.coverage = {
      mode: source.coverage?.mode ?? "partial-retained-projection",
      incompleteReasons: source.coverage?.incompleteReasons ?? [],
      earliestVerifiedRetainedInclusiveMs: source.coverage?.earliestVerifiedRetainedInclusiveMs ?? null,
      degraded,
    };
    if (changed) next.generation = prior.generation + 1;
    next.checkpoint = { generation: next.generation, factCount: allFacts.length, observedAt: now };
    next.publishedAt = now;
    store.publish(next, persistenceFault);
    lastPullAt = now;
    return store.read();
  }

  function pull(input = {}) {
    const active = store.currentFlight();
    if (active != null) return active;
    let promise;
    promise = reconcile(input).finally(() => store.clearFlight(promise));
    store.setFlight(promise);
    return promise;
  }

  return {
    pull,
    readPublishedSnapshot: async () => store.read(),
    dispose: async () => { disposed = true; },
  };
}
