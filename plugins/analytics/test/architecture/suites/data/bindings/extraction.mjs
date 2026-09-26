import { createRetainedFactProjector, RetainedFactStore } from "../../../../../extraction/retained-projector.mjs";

function notFound() {
  const error = new Error("thread not found");
  error.name = "BbHttpError";
  error.status = 404;
  error.code = "thread_not_found";
  return error;
}

/** This test-owned source implements only the public SDK calls consumed by the
 * production projector.  Results are not projected or published here. */
function createPublicSource(fixture) {
  const listed = new Set(fixture.threads);
  const notFoundThreads = new Set();
  let nextFailure = null;
  let failures = 0;
  const source = {
    coverage: fixture.coverage,
    threads: {
      async list({ limit, offset }) {
        if (nextFailure != null) { const error = nextFailure; nextFailure = null; failures += 1; throw error; }
        return fixture.threads.filter((id) => listed.has(id)).slice(offset, offset + limit).map((id) => ({ id, projectId: "project-1", providerId: "provider-1", updatedAt: fixture.clock }));
      },
      async get({ threadId }) {
        if (notFoundThreads.has(threadId)) throw notFound();
        return { id: threadId, projectId: "project-1", providerId: "provider-1", updatedAt: fixture.clock };
      },
      events: {
        async list({ threadId, limit, afterSeq }) {
          const after = afterSeq == null ? -1 : Number(afterSeq);
          return (fixture.events[threadId] ?? []).filter((row) => row.sequence > after).slice(0, Number(limit)).map((row) => ({
            id: `${threadId}:${row.sequence}`,
            threadId,
            seq: row.sequence,
            createdAt: fixture.clock + row.sequence,
            scope: { kind: "thread" },
            type: "item/completed",
            data: { item: { type: "toolCall", server: "fixture", tool: "retained", retainedValue: row.value, status: "completed", durationMs: 1 } },
          }));
        },
      },
    },
    append(threadId, row) { fixture.events[threadId].push(clone(row)); },
    rewrite(threadId, sequence, patch) { const row = fixture.events[threadId].find((candidate) => candidate.sequence === sequence); Object.assign(row, patch); },
    omitFromList(threadId) { listed.delete(threadId); },
    restoreToList(threadId) { listed.add(threadId); },
    confirmNotFound(threadId) { notFoundThreads.add(threadId); },
    failNextRead(error) { nextFailure = error; },
    getInjectedFailureCount() { return failures; },
  };
  return source;
}

function clone(value) { return structuredClone(value); }

export async function loadOperations() {
  return {
    createPublicSource,
    createPersistentStore: () => new RetainedFactStore(),
    createProjector: async ({ source, store, clock, policy, persistenceFault }) => {
      const projector = createRetainedFactProjector({ source, store, clock, policy, persistenceFault });
      return {
        ...projector,
        async readPublishedSnapshot() {
          const snapshot = await projector.readPublishedSnapshot();
          return {
            rows: Object.values(snapshot.threads).flatMap((thread) => thread.facts),
            checkpoint: snapshot.checkpoint,
            coverage: snapshot.coverage,
          };
        },
      };
    },
  };
}
