import assert from "node:assert/strict";
import test from "node:test";

import {
  createRetainedSourceAdapter,
  type RetainedSourceEvent,
  type RetainedSourceLimits,
  type RetainedSourceSdk,
} from "../../../../extraction/source-adapter.ts";
import {
  projectRetainedEventPage,
  type RetainedProjectionLimits,
} from "../../../../extraction/event-projector.ts";
import {
  RETAINED_PROJECTION_ALGORITHM,
  RETAINED_TARGET_PROJECTION_VERSION,
} from "../../../../extraction/staging.ts";

const dimensions = { projectId: "project-1", providerId: "provider-1" };
const sourceLimits = (overrides: Partial<RetainedSourceLimits> = {}): RetainedSourceLimits => ({
  listPageSize: 2,
  eventPageSize: 2,
  maxCalls: 20,
  maxListPages: 20,
  maxEventPages: 20,
  maxRows: 50,
  maxResponseBytes: 100_000,
  ...overrides,
});
const projectionLimits = (overrides: Partial<RetainedProjectionLimits> = {}): RetainedProjectionLimits => ({
  maxTurnStates: 32,
  maxTimingRefs: 32,
  maxCheckpointBytes: 256 * 1024,
  ...overrides,
});

function turnStarted(threadId: string, seq: number, turnId: string, createdAt: number): RetainedSourceEvent {
  return {
    id: `event-start-${turnId}-${seq}`,
    threadId,
    seq,
    createdAt,
    scope: { kind: "turn", turnId },
    type: "turn/started",
    data: { providerThreadId: "provider-thread" },
    p6rActorHandle: null,
  } satisfies RetainedSourceEvent;
}

function turnCompleted(threadId: string, seq: number, turnId: string, createdAt: number): RetainedSourceEvent {
  return {
    id: `event-complete-${turnId}-${seq}`,
    threadId,
    seq,
    createdAt,
    scope: { kind: "turn", turnId },
    type: "turn/completed",
    data: { providerThreadId: "provider-thread", status: "completed" },
    p6rActorHandle: null,
  } satisfies RetainedSourceEvent;
}

function toolCompleted(
  threadId: string,
  seq: number,
  turnId: string,
  eventId: string,
  createdAt: number,
  durationMs = 120,
): RetainedSourceEvent {
  return {
    id: eventId,
    threadId,
    seq,
    createdAt,
    scope: { kind: "turn", turnId },
    type: "item/completed",
    data: {
      providerThreadId: "provider-thread",
      item: {
        id: `${eventId}-item`,
        type: "toolCall",
        server: "bb",
        tool: "read_slack",
        status: "completed",
        durationMs,
      },
    },
    p6rActorHandle: null,
  } satisfies RetainedSourceEvent;
}

function mockedSdk(pages: readonly (readonly RetainedSourceEvent[])[]): RetainedSourceSdk {
  const remaining = [...pages];
  return {
    threads: {
      async list() {
        return [];
      },
      async get(args) {
        throw new Error(`unexpected get ${args.threadId}`);
      },
      events: {
        async list() {
          return [...(remaining.shift() ?? [])];
        },
      },
    },
  };
}

function projectPage(
  source: Awaited<ReturnType<ReturnType<typeof createRetainedSourceAdapter>["eventPage"]>>,
  stagePage: number,
  checkpoint: Parameters<typeof projectRetainedEventPage>[0]["checkpoint"],
  limits = projectionLimits(),
) {
  return projectRetainedEventPage({
    runId: "run-projector",
    threadId: "thread-1",
    mode: "rewrite",
    targetProjectionVersion: RETAINED_TARGET_PROJECTION_VERSION,
    algorithm: RETAINED_PROJECTION_ALGORITHM,
    stagePage,
    dimensions,
    source,
    checkpoint,
    limits,
    receivedAt: 10_000 + stagePage,
  });
}

test("projects an immediate nullable fact, then revises its staged timing across adapter pages", async () => {
  const sdk = mockedSdk([
    [
      turnStarted("thread-1", 1, "turn-1", 100),
      toolCompleted("thread-1", 2, "turn-1", "event-item-2", 200),
    ],
    [turnCompleted("thread-1", 3, "turn-1", 500)],
  ]);
  const adapter = createRetainedSourceAdapter(sdk, sourceLimits());
  const page1 = await adapter.eventPage({ threadId: "thread-1" });
  const projected1 = projectPage(page1, 0, null);

  assert.deepEqual(projected1.facts, [{
    sourceEventId: "event-item-2",
    threadId: "thread-1",
    turnId: "turn-1",
    sequence: 2,
    projectId: "project-1",
    providerId: "provider-1",
    createdAtMs: 200,
    turnStartedAtMs: 100,
    turnCompletedAtMs: null,
    capabilityKind: "tool",
    capabilityKey: "bb:read_slack",
    status: "completed",
    durationMs: 120,
    failed: false,
    errorClass: null,
    errorSignature: null,
    commandBinary: null,
    commandArgument1: null,
    commandArgument2: null,
    commandUsesHelp: false,
    commandShape: null,
    commandShellWrapped: false,
    commandAttributionEligible: false,
  }]);
  assert.equal(page1.metadata.sourceAfterSeq, "2");
  assert.equal(projected1.checkpoint.sourceAfterSeq, "2");
  assert.equal(projected1.checkpoint.timingRefs.length, 1);
  assert.ok(projected1.checkpoint.revisitReasons.includes("incomplete"));

  const page2 = await adapter.eventPage({ threadId: "thread-1", afterSeq: page1.metadata.sourceAfterSeq });
  const projected2 = projectPage(page2, 1, projected1.checkpoint);
  const expectedRef = projected1.checkpoint.timingRefs[0]!;
  assert.deepEqual(projected2.timestampRevisions, [{
    revisionKey: "event-item-2:3",
    sourceEventId: "event-item-2",
    turnId: "turn-1",
    sequence: 2,
    timingRevisionSeq: 3,
    expectedFactDigest: expectedRef.factDigest,
    turnStartedAtMs: 100,
    turnCompletedAtMs: 500,
  }]);
  assert.equal(projected2.facts.length, 0);
  assert.equal(projected2.checkpoint.sourceAfterSeq, "3");
  assert.equal(projected2.checkpoint.maxFactSeq, 2);
  assert.equal(projected2.checkpoint.timingRefs.length, 0);
});

test("evicts never-completing refs deterministically while the source cursor and later facts progress", async () => {
  const sdk = mockedSdk([
    [
      turnStarted("thread-1", 1, "turn-a", 100),
      toolCompleted("thread-1", 2, "turn-a", "event-a-2", 200),
      turnStarted("thread-1", 3, "turn-b", 300),
      toolCompleted("thread-1", 4, "turn-b", "event-b-4", 400),
    ],
    [
      turnCompleted("thread-1", 5, "turn-b", 900),
      toolCompleted("thread-1", 6, "turn-b", "event-b-6", 910),
    ],
  ]);
  const adapter = createRetainedSourceAdapter(sdk, sourceLimits({ eventPageSize: 4 }));
  const page1 = await adapter.eventPage({ threadId: "thread-1" });
  const projected1 = projectPage(page1, 0, null, projectionLimits({ maxTimingRefs: 1 }));
  assert.equal(projected1.facts.length, 2);
  assert.equal(projected1.checkpoint.sourceAfterSeq, "4");
  assert.equal(projected1.checkpoint.timingRefs.length, 1);
  assert.ok(projected1.checkpoint.revisitReasons.includes("timing-ref-evicted"));
  assert.ok(projected1.checkpoint.revisitReasons.includes("incomplete"));

  const page2 = await adapter.eventPage({ threadId: "thread-1", afterSeq: page1.metadata.sourceAfterSeq });
  const projected2 = projectPage(page2, 1, projected1.checkpoint, projectionLimits({ maxTimingRefs: 1 }));
  assert.equal(projected2.source.cursorOut, "6");
  assert.equal(projected2.facts.length, 1);
  assert.equal(projected2.facts[0]?.sourceEventId, "event-b-6");
  assert.equal(projected2.facts[0]?.turnStartedAtMs, 300);
  assert.equal(projected2.facts[0]?.turnCompletedAtMs, 900);
  assert.equal(projected2.timestampRevisions.length, 1);
  assert.equal(projected2.timestampRevisions[0]?.sourceEventId, "event-b-4");
});

test("evicts checkpoint state deterministically and still advances the source cursor", async () => {
  const adapter = createRetainedSourceAdapter(mockedSdk([[
    turnStarted("thread-1", 1, "turn-byte-cap", 100),
    toolCompleted("thread-1", 2, "turn-byte-cap", "event-byte-cap-2", 200),
    turnStarted("thread-1", 3, "turn-byte-cap-second", 300),
    toolCompleted("thread-1", 4, "turn-byte-cap-second", "event-byte-cap-4", 400),
  ]]), sourceLimits({ eventPageSize: 4 }));
  const page = await adapter.eventPage({ threadId: "thread-1" });
  const projected = projectPage(page, 0, null, projectionLimits({ maxCheckpointBytes: 1024 }));
  assert.equal(projected.source.cursorOut, "4");
  assert.deepEqual(projected.facts.map((fact) => fact.sourceEventId), ["event-byte-cap-2", "event-byte-cap-4"]);
  assert.equal(projected.checkpoint.rewriteRequired, true);
  assert.ok(projected.refReleases.some((release) => release.reason === "checkpoint-byte-cap"));
});

test("evicts checkpoint turn state without claiming nonexistent timing refs were lost", async () => {
  const turnA = `turn-byte-state-a-${"a".repeat(128)}`;
  const turnB = `turn-byte-state-b-${"b".repeat(128)}`;
  const turnC = `turn-byte-state-c-${"c".repeat(128)}`;
  const turnD = `turn-byte-state-d-${"d".repeat(128)}`;
  const adapter = createRetainedSourceAdapter(mockedSdk([[
    turnStarted("thread-1", 1, turnA, 100),
    turnCompleted("thread-1", 2, turnA, 200),
    turnStarted("thread-1", 3, turnB, 300),
    turnCompleted("thread-1", 4, turnB, 400),
    turnStarted("thread-1", 5, turnC, 500),
    turnCompleted("thread-1", 6, turnC, 600),
    turnStarted("thread-1", 7, turnD, 700),
    turnCompleted("thread-1", 8, turnD, 800),
  ]]), sourceLimits({ eventPageSize: 8 }));
  const page = await adapter.eventPage({ threadId: "thread-1" });
  const uncapped = projectPage(page, 0, null);
  assert.equal(uncapped.checkpoint.turns.length, 4);
  assert.ok(Buffer.byteLength(JSON.stringify(uncapped.checkpoint), "utf8") > 1024);
  const projected = projectPage(page, 0, null, projectionLimits({ maxCheckpointBytes: 1024 }));
  assert.equal(projected.source.cursorOut, "8");
  assert.equal(projected.facts.length, 0);
  assert.equal(projected.checkpoint.timingRefs.length, 0);
  assert.equal(projected.refReleases.length, 0);
  assert.ok(projected.checkpoint.turns.length < 4);
  assert.ok(projected.checkpoint.revisitReasons.includes("turn-state-evicted"));
  assert.ok(!projected.checkpoint.revisitReasons.includes("timing-ref-evicted"));
  assert.ok(projected.checkpoint.revisitReasons.includes("incomplete"));
  assert.equal(projected.checkpoint.rewriteRequired, true);
  assert.ok(projected.checkpoint.rewriteDirective?.reasons.includes("checkpoint-byte-cap"));
});

test("suppresses an inverted non-null timing pair while disclosing degraded timing", async () => {
  const adapter = createRetainedSourceAdapter(mockedSdk([[
    turnStarted("thread-1", 1, "turn-inverted", 500),
    turnCompleted("thread-1", 2, "turn-inverted", 100),
    toolCompleted("thread-1", 3, "turn-inverted", "event-inverted-3", 300),
  ]]), sourceLimits({ eventPageSize: 3 }));
  const page = await adapter.eventPage({ threadId: "thread-1" });
  const projected = projectPage(page, 0, null);
  assert.equal(projected.facts[0]?.turnStartedAtMs, null);
  assert.equal(projected.facts[0]?.turnCompletedAtMs, null);
  assert.equal(projected.timestampRevisions.length, 0);
  assert.ok(projected.checkpoint.revisitReasons.includes("inverted-turn-boundary"));
  assert.ok(projected.checkpoint.revisitReasons.includes("incomplete"));
});
