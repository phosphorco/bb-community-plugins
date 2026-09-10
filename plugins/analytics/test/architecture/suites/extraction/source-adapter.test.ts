import assert from "node:assert/strict";
import test from "node:test";

import {
  createRetainedSourceAdapter,
  isExactThreadNotFound,
  RetainedSourceBudgetError,
  RetainedSourceBusyError,
  type RetainedSourceEvent,
  type RetainedSourceLimits,
  type RetainedSourceSdk,
  type RetainedSourceThread,
  type RetainedSourceThreadResult,
} from "../../../../extraction/source-adapter.ts";

type ListCall = NonNullable<Parameters<RetainedSourceSdk["threads"]["list"]>[0]>;
type GetCall = Parameters<RetainedSourceSdk["threads"]["get"]>[0];
type EventCall = Parameters<RetainedSourceSdk["threads"]["events"]["list"]>[0];

const limits = (overrides: Partial<RetainedSourceLimits> = {}): RetainedSourceLimits => ({
  listPageSize: 2,
  eventPageSize: 2,
  maxCalls: 20,
  maxListPages: 20,
  maxEventPages: 20,
  maxRows: 20,
  maxResponseBytes: 100_000,
  ...overrides,
});

function thread(id: string): RetainedSourceThread {
  return {
    activity: {
      activeBackgroundAgentCount: 0,
      activeBackgroundCommandCount: 0,
      activeGoalCount: 0,
      activePlanModeCount: 0,
      activeWorkflowCount: 0,
    },
    archivedAt: null,
    createdAt: 1_700_000_000_000,
    deletedAt: null,
    environmentBranchName: null,
    environmentHostId: null,
    environmentId: null,
    environmentName: null,
    environmentWorkspaceDisplayKind: "other",
    hasPendingInteraction: false,
    id,
    lastReadAt: null,
    latestAttentionAt: 1_700_000_000_000,
    originKind: null,
    originPluginId: null,
    parentThreadId: null,
    pinSortKey: null,
    pinnedAt: null,
    projectId: "project-1",
    providerId: "provider-1",
    queuedWork: "none",
    runtime: { displayStatus: "idle", hostReconnectGraceExpiresAt: null },
    sectionId: null,
    sourceThreadId: null,
    status: "idle",
    title: null,
    titleFallback: `Thread ${id}`,
    updatedAt: 1_700_000_000_000,
    visibility: "visible",
  } satisfies RetainedSourceThread;
}

function threadResult(id: string): RetainedSourceThreadResult {
  return {
    ...thread(id),
    activeBackgroundAgentCount: 0,
    canSpawnChild: true,
    queuedMessageCount: 0,
  } satisfies RetainedSourceThreadResult;
}

function event(threadId: string, seq: number): RetainedSourceEvent {
  return {
    id: `event-${seq}`,
    threadId,
    seq,
    createdAt: 1_700_000_000_000 + seq,
    scope: { kind: "thread" },
    type: "thread/started",
    data: {},
  } satisfies RetainedSourceEvent;
}

function invalidEvent(overrides: Record<string, unknown>): RetainedSourceEvent {
  return { ...event("thread-1", 1), ...overrides } as unknown as RetainedSourceEvent;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function mockSdk(input: {
  listPages?: readonly (readonly RetainedSourceThread[])[];
  eventPages?: readonly (readonly RetainedSourceEvent[])[];
  get?: (args: GetCall) => Promise<RetainedSourceThreadResult>;
} = {}) {
  const listPages = [...(input.listPages ?? [])];
  const eventPages = [...(input.eventPages ?? [])];
  const calls: {
    list: ListCall[];
    get: GetCall[];
    events: EventCall[];
  } = { list: [], get: [], events: [] };
  const sdk: RetainedSourceSdk = {
    threads: {
      async list(args) {
        calls.list.push(args ?? {});
        return [...(listPages.shift() ?? [])];
      },
      async get(args) {
        calls.get.push(args);
        if (input.get != null) return input.get(args);
        return threadResult(args.threadId);
      },
      events: {
        async list(args) {
          calls.events.push(args);
          return [...(eventPages.shift() ?? [])];
        },
      },
    },
  };
  return { sdk, calls };
}

test("list pages preserve exact SDK args and distinguish short, exact-limit, and empty pages", async () => {
  const { sdk, calls } = mockSdk({
    listPages: [[thread("thread-1"), thread("thread-2")], [], [thread("thread-3")]],
  });
  const adapter = createRetainedSourceAdapter(sdk, limits());

  const exact = await adapter.listPage({ offset: 0 });
  assert.deepEqual(calls.list[0], { includeHidden: true, limit: 2, offset: 0 });
  assert.equal(exact.metadata.pageExhausted, false);
  assert.equal(exact.metadata.nextOffset, 2);

  const empty = await adapter.listPage({ offset: 2 });
  assert.deepEqual(calls.list[1], { includeHidden: true, limit: 2, offset: 2 });
  assert.equal(empty.metadata.pageExhausted, true);
  assert.equal(empty.metadata.returnedRows, 0);

  const short = await adapter.listPage({ offset: 2 });
  assert.equal(short.metadata.pageExhausted, true);
  assert.equal(short.metadata.returnedRows, 1);
  assert.equal(short.metadata.nextOffset, 3);
  assert.equal("archived" in calls.list[0], false);
});

test("event pages are ascending and unfiltered while sourceAfterSeq includes sequence gaps", async () => {
  const { sdk, calls } = mockSdk({
    eventPages: [
      [event("thread-1", 4), event("thread-1", 9)],
      [event("thread-1", 12)],
      [],
    ],
  });
  const adapter = createRetainedSourceAdapter(sdk, limits());

  const first = await adapter.eventPage({ threadId: "thread-1" });
  assert.deepEqual(calls.events[0], {
    threadId: "thread-1",
    limit: "2",
    order: "asc",
  });
  assert.equal("types" in calls.events[0], false);
  assert.equal(first.metadata.returnedMaxSeq, "9");
  assert.equal(first.metadata.sourceAfterSeq, "9");
  assert.equal(first.metadata.pageExhausted, false);

  const second = await adapter.eventPage({ threadId: "thread-1", afterSeq: first.metadata.sourceAfterSeq });
  assert.deepEqual(calls.events[1], {
    threadId: "thread-1",
    afterSeq: "9",
    limit: "2",
    order: "asc",
  });
  assert.equal(second.metadata.returnedMaxSeq, "12");
  assert.equal(second.metadata.sourceAfterSeq, "12");
  assert.equal(second.metadata.pageExhausted, true);

  const empty = await adapter.eventPage({ threadId: "thread-1", afterSeq: second.metadata.sourceAfterSeq });
  assert.equal(empty.metadata.returnedMaxSeq, null);
  assert.equal(empty.metadata.sourceAfterSeq, "12");
  assert.equal(empty.metadata.pageExhausted, true);
});

test("fixed policy maxima allow reductions but reject raised ceilings", () => {
  assert.throws(
    () => createRetainedSourceAdapter(mockSdk().sdk, limits({ listPageSize: 201 })),
    /fixed retained source policy maximum/,
  );
  assert.doesNotThrow(() => createRetainedSourceAdapter(mockSdk().sdk, limits({ listPageSize: 1 })));
});

test("maxCalls stops further SDK work", async () => {
  const { sdk, calls } = mockSdk({
    listPages: [[thread("thread-1")], [thread("thread-2")]],
  });
  const adapter = createRetainedSourceAdapter(sdk, limits({ maxCalls: 1 }));

  await adapter.listPage({ offset: 0 });
  await assert.rejects(
    () => adapter.listPage({ offset: 2 }),
    (error: unknown) => error instanceof RetainedSourceBudgetError && error.reason === "max-calls",
  );
  assert.equal(calls.list.length, 1);
});

test("maxEventPages stops further event SDK work", async () => {
  const { sdk, calls } = mockSdk({ eventPages: [[event("thread-1", 1)], [event("thread-1", 2)]] });
  const pageLimited = createRetainedSourceAdapter(sdk, limits({ maxEventPages: 1 }));
  await pageLimited.eventPage({ threadId: "thread-1" });
  await assert.rejects(
    () => pageLimited.eventPage({ threadId: "thread-1", afterSeq: "1" }),
    (error: unknown) => error instanceof RetainedSourceBudgetError && error.reason === "max-event-pages",
  );
  assert.equal(calls.events.length, 1);
});

test("failed page reservation does not consume the shared call budget", async () => {
  const { sdk, calls } = mockSdk({ listPages: [[thread("thread-1")]] });
  const adapter = createRetainedSourceAdapter(sdk, limits({ maxCalls: 2, maxListPages: 1 }));

  await adapter.listPage({ offset: 0 });
  await assert.rejects(
    () => adapter.listPage({ offset: 1 }),
    (error: unknown) => error instanceof RetainedSourceBudgetError && error.reason === "max-list-pages",
  );
  const found = await adapter.getThread({ threadId: "thread-1" });
  assert.equal(found.kind, "found");
  assert.equal(calls.list.length, 1);
  assert.equal(calls.get.length, 1);
});

test("maxRows stops before another SDK call", async () => {
  const { sdk, calls } = mockSdk({ listPages: [[thread("thread-1")], [thread("thread-2")]] });
  const rowLimited = createRetainedSourceAdapter(sdk, limits({ maxRows: 1 }));
  await rowLimited.listPage({ offset: 0 });
  await assert.rejects(
    () => rowLimited.listPage({ offset: 1 }),
    (error: unknown) => error instanceof RetainedSourceBudgetError && error.reason === "max-rows",
  );
  assert.equal(calls.list.length, 1);
});

test("response-byte overrun is terminal and performs no further SDK work", async () => {
  const { sdk, calls } = mockSdk({ eventPages: [[event("thread-1", 1)], [event("thread-1", 2)]] });
  const byteLimited = createRetainedSourceAdapter(sdk, limits({ maxResponseBytes: 1 }));
  await assert.rejects(
    () => byteLimited.eventPage({ threadId: "thread-1" }),
    (error: unknown) => error instanceof RetainedSourceBudgetError && error.reason === "max-response-bytes",
  );
  await assert.rejects(
    () => byteLimited.eventPage({ threadId: "thread-1" }),
    (error: unknown) => error instanceof RetainedSourceBudgetError && error.reason === "max-response-bytes",
  );
  assert.equal(calls.events.length, 1);
});

test("single in-flight ownership rejects overlap and releases after an SDK error", async () => {
  const started = deferred<void>();
  const pendingRows = deferred<RetainedSourceThread[]>();
  const calls: { list: number; events: number } = { list: 0, events: 0 };
  const sdk: RetainedSourceSdk = {
    threads: {
      async list() {
        calls.list += 1;
        started.resolve();
        return pendingRows.promise;
      },
      async get(args) {
        return threadResult(args.threadId);
      },
      events: {
        async list() {
          calls.events += 1;
          return [];
        },
      },
    },
  };
  const adapter = createRetainedSourceAdapter(sdk, limits());
  const first = adapter.listPage({ offset: 0 });
  await started.promise;
  await assert.rejects(
    () => adapter.eventPage({ threadId: "thread-1" }),
    (error: unknown) => error instanceof RetainedSourceBusyError,
  );
  assert.equal(calls.events, 0);
  pendingRows.resolve([thread("thread-1")]);
  await first;

  let shouldFail = true;
  const failure = new Error("synthetic source failure");
  const retryCalls: { list: number } = { list: 0 };
  const failingSdk: RetainedSourceSdk = {
    threads: {
      async list() {
        retryCalls.list += 1;
        if (shouldFail) {
          shouldFail = false;
          throw failure;
        }
        return [thread("thread-1")];
      },
      async get(args) {
        return threadResult(args.threadId);
      },
      events: { async list() { return []; } },
    },
  };
  const retryable = createRetainedSourceAdapter(failingSdk, limits());
  await assert.rejects(() => retryable.listPage({ offset: 0 }), (error: unknown) => error === failure);
  await retryable.listPage({ offset: 0 });
  assert.equal(retryCalls.list, 2);
});

test("rejects over-limit, foreign-thread, non-increasing, and out-of-range event responses", async () => {
  const overLimit = createRetainedSourceAdapter(
    mockSdk({ eventPages: [[event("thread-1", 1), event("thread-1", 2), event("thread-1", 3)]] }).sdk,
    limits({ eventPageSize: 2 }),
  );
  await assert.rejects(
    () => overLimit.eventPage({ threadId: "thread-1" }),
    /exceeded the requested row limit/,
  );

  const foreign = createRetainedSourceAdapter(
    mockSdk({ eventPages: [[event("thread-2", 1)]] }).sdk,
    limits(),
  );
  await assert.rejects(
    () => foreign.eventPage({ threadId: "thread-1" }),
    /foreign thread row/,
  );

  const duplicate = createRetainedSourceAdapter(
    mockSdk({ eventPages: [[event("thread-1", 1), event("thread-1", 1)]] }).sdk,
    limits(),
  );
  await assert.rejects(
    () => duplicate.eventPage({ threadId: "thread-1" }),
    /strictly after the source cursor/,
  );

  const invalidSequence = createRetainedSourceAdapter(
    mockSdk({ eventPages: [[invalidEvent({ seq: -1 })]] }).sdk,
    limits(),
  );
  await assert.rejects(
    () => invalidSequence.eventPage({ threadId: "thread-1" }),
    /invalid sequence/,
  );

  const notAfterCursor = createRetainedSourceAdapter(
    mockSdk({ eventPages: [[event("thread-1", 4)]] }).sdk,
    limits(),
  );
  await assert.rejects(
    () => notAfterCursor.eventPage({ threadId: "thread-1", afterSeq: "4" }),
    /strictly after the source cursor/,
  );

  const bounded = createRetainedSourceAdapter(mockSdk({ eventPages: [[]] }).sdk, limits());
  await assert.rejects(
    () => bounded.eventPage({ threadId: "x".repeat(513) }),
    /bounded identifier/,
  );
  await assert.rejects(
    () => bounded.eventPage({ threadId: "thread-1", afterSeq: "1".repeat(65) }),
    /bounded decimal cursor/,
  );
  await assert.rejects(
    () => bounded.eventPage({ threadId: "thread-1", afterSeq: "9007199254740992" }),
    /supported sequence range/,
  );
});

test("forwards abort signals and performs no SDK work for a pre-aborted signal", async () => {
  const { sdk, calls } = mockSdk({ eventPages: [[event("thread-1", 1)]], listPages: [[]] });
  const adapter = createRetainedSourceAdapter(sdk, limits());
  const controller = new AbortController();
  await adapter.eventPage({ threadId: "thread-1", signal: controller.signal });
  assert.equal(calls.events[0].signal, controller.signal);

  const preAborted = new AbortController();
  preAborted.abort();
  await assert.rejects(
    () => adapter.listPage({ offset: 0, signal: preAborted.signal }),
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );
  assert.equal(calls.list.length, 0);
});

test("get confirms only structural BbHttpError 404 thread_not_found and preserves other failures", async () => {
  const notFound = Object.assign(new Error("gone"), {
    name: "BbHttpError",
    status: 404,
    code: "thread_not_found",
  });
  assert.equal(isExactThreadNotFound(notFound), true);
  assert.equal(isExactThreadNotFound(Object.assign(new Error("forbidden"), {
    name: "BbHttpError",
    status: 403,
    code: "forbidden",
  })), false);
  assert.equal(isExactThreadNotFound(new Error("generic 404")), false);

  const missing = mockSdk({ get: async () => { throw notFound; } });
  const missingObservation = await createRetainedSourceAdapter(missing.sdk, limits()).getThread({ threadId: "thread-1" });
  assert.deepEqual(missingObservation.kind, "confirmed-not-found");
  assert.deepEqual(missing.calls.get[0], { threadId: "thread-1" });

  const failure = new Error("permission denied");
  const rejected = mockSdk({ get: async () => { throw failure; } });
  await assert.rejects(
    () => createRetainedSourceAdapter(rejected.sdk, limits()).getThread({ threadId: "thread-1" }),
    (error: unknown) => error === failure,
  );
});
