import type { ToolExecutionFact } from "../fact-projection.ts";

export type RetainedStageMode = "delta" | "rewrite" | "upgrade";
/** No completion state is exposed until a source adapter can prove completion. */
export type RetainedStageState = "collecting" | "failed";

/** Numeric version 5 is intentionally separate from the active legacy version 4. */
export const RETAINED_TARGET_PROJECTION_VERSION = 5 as const;
export const RETAINED_PROJECTION_ALGORITHM = "retained-fact-projection-v1" as const;
export const RETAINED_CHECKPOINT_FORMAT = "retained-fact-projection-checkpoint-v1" as const;

export const RETAINED_CHECKPOINT_RESERVE_REVISIT_REASONS: readonly RetainedRevisitReason[] = [
  "incomplete",
  "partial-turn-timing",
  "invalid-turn-boundary",
  "inverted-turn-boundary",
  "turn-state-evicted",
  "timing-ref-evicted",
  "timing-revision-missed",
  "revisit-required",
];
export const RETAINED_CHECKPOINT_RESERVE_REWRITE_REASONS: readonly RetainedRewriteReason[] = [
  "ref-cap",
  "turn-cap",
  "checkpoint-byte-cap",
  "revisit-required",
];

export type RetainedRevisitReason =
  | "incomplete"
  | "partial-turn-timing"
  | "invalid-turn-boundary"
  | "inverted-turn-boundary"
  | "turn-state-evicted"
  | "timing-ref-evicted"
  | "timing-revision-missed"
  | "revisit-required";

export type RetainedRewriteReason = "ref-cap" | "turn-cap" | "checkpoint-byte-cap" | "revisit-required";
export type RetainedRefReleaseReason = "completed" | "ref-cap" | "turn-cap" | "checkpoint-byte-cap";
export type RetainedTerminalReason = "pages" | "rows" | "bytes" | "metadata" | "revisions";
export type RetainedProjectionFailureReason = "source-error" | "aborted" | "invalid-source" | "degraded";

export type RetainedTurnStateStatus = "partial" | "complete" | "degraded";

export interface RetainedTurnState {
  turnId: string;
  startedAtMs: number | null;
  completedAtMs: number | null;
  startedSeq: number | null;
  completedSeq: number | null;
  revisionSeq: number | null;
  lastSeenSeq: number;
  degraded: boolean;
  status: RetainedTurnStateStatus;
}

export interface RetainedRewriteDirective {
  threadId: string;
  restart: "beginning";
  reasons: readonly RetainedRewriteReason[];
}

export interface RetainedTimingRef {
  sourceEventId: string;
  turnId: string;
  sequence: number;
  factDigest: string;
  turnStartedAtMs: number | null;
  turnCompletedAtMs: number | null;
}

export interface RetainedProjectionCheckpoint {
  format: typeof RETAINED_CHECKPOINT_FORMAT;
  algorithm: typeof RETAINED_PROJECTION_ALGORITHM;
  targetProjectionVersion: typeof RETAINED_TARGET_PROJECTION_VERSION;
  mode: RetainedStageMode;
  runId: string;
  threadId: string;
  nextStagePage: number;
  sourceAfterSeq: string | null;
  maxFactSeq: number | null;
  turns: readonly RetainedTurnState[];
  timingRefs: readonly RetainedTimingRef[];
  revisitReasons: readonly RetainedRevisitReason[];
  rewriteRequired: boolean;
  rewriteDirective: RetainedRewriteDirective | null;
}

export interface RetainedProjectionStageBudget extends RetainedStageBudget {
  maxCheckpointBytes: number;
  maxMetadataBytes: number;
  maxTurnStates: number;
  maxTimingRefs: number;
  maxRevisions: number;
}

export interface RetainedTimestampRevision {
  revisionKey: string;
  sourceEventId: string;
  turnId: string;
  sequence: number;
  timingRevisionSeq: number;
  expectedFactDigest: string;
  turnStartedAtMs: number | null;
  turnCompletedAtMs: number | null;
}

export interface RetainedRefRelease {
  sourceEventId: string;
  reason: RetainedRefReleaseReason;
}

export interface RetainedProjectionPageSource {
  cursorIn: string | null;
  cursorOut: string | null;
  pageExhausted: boolean;
  pageDigest: string;
}

export interface RetainedProjectionStagePage {
  runId: string;
  threadId: string;
  mode: RetainedStageMode;
  targetProjectionVersion: typeof RETAINED_TARGET_PROJECTION_VERSION;
  algorithm: typeof RETAINED_PROJECTION_ALGORITHM;
  page: number;
  checkpointDigestIn: string;
  source: RetainedProjectionPageSource;
  facts: readonly ToolExecutionFact[];
  timestampRevisions: readonly RetainedTimestampRevision[];
  refReleases: readonly RetainedRefRelease[];
  checkpoint: RetainedProjectionCheckpoint;
  receivedAt: number;
}

export interface RetainedProjectionStageProgress {
  runId: string;
  threadId: string;
  epochId: string;
  mode: RetainedStageMode;
  state: RetainedStageState;
  targetProjectionVersion: typeof RETAINED_TARGET_PROJECTION_VERSION;
  algorithm: typeof RETAINED_PROJECTION_ALGORITHM;
  maxPages: number;
  maxRows: number;
  maxBytes: number;
  maxCheckpointBytes: number;
  maxMetadataBytes: number;
  maxTurnStates: number;
  maxTimingRefs: number;
  maxRevisions: number;
  nextPage: number;
  sourceAfterSeq: string | null;
  maxFactSeq: number | null;
  rows: number;
  bytes: number;
  revisionCount: number;
  revisionPayloadBytes: number;
  metadataBytes: number;
  checkpoint: RetainedProjectionCheckpoint;
  checkpointDigest: string;
  lastOperationDigest: string | null;
  revisitReasons: readonly RetainedRevisitReason[];
  rewriteRequired: boolean;
  rewriteDirective: RetainedRewriteDirective | null;
  terminalReason: RetainedTerminalReason | null;
  terminal: boolean;
  failureReason: RetainedProjectionFailureReason | null;
  error: string | null;
}

export interface OpenRetainedProjectionStage {
  runId: string;
  epochId: string;
  threadId: string;
  mode: RetainedStageMode;
  targetProjectionVersion: typeof RETAINED_TARGET_PROJECTION_VERSION;
  algorithm: typeof RETAINED_PROJECTION_ALGORITHM;
  budget: RetainedProjectionStageBudget;
  startedAt: number;
}

/** Fixed ceilings keep a caller from turning a persisted stage into unbounded work. */
export const RETAINED_STAGE_HARD_LIMITS = {
  maxPages: 512,
  maxRows: 50_000,
  maxBytes: 32 * 1024 * 1024,
  maxPageRows: 500,
  maxPageBytes: 512 * 1024,
  maxFactBytes: 16 * 1024,
  maxIdentifierBytes: 512,
  maxCursorBytes: 8 * 1024,
  maxCheckpointBytes: 256 * 1024,
  maxMetadataBytes: 4 * 1024 * 1024,
  maxTurnStates: 512,
  maxTimingRefs: 2_048,
  maxRevisions: 50_000,
  maxReasons: 8,
} as const;

export interface RetainedStageBudget {
  maxPages: number;
  maxRows: number;
  maxBytes: number;
}

export interface OpenRetainedStage {
  runId: string;
  epochId: string;
  threadId: string;
  mode: RetainedStageMode;
  targetProjectionVersion: number;
  budget: RetainedStageBudget;
  startedAt: number;
}

export interface RetainedStagePage {
  runId: string;
  threadId: string;
  page: number;
  cursorIn: string | null;
  cursorOut: string | null;
  facts: readonly ToolExecutionFact[];
  receivedAt: number;
}

export interface RetainedStageProgress {
  runId: string;
  threadId: string;
  epochId: string;
  mode: RetainedStageMode;
  state: RetainedStageState;
  targetProjectionVersion: number;
  maxPages: number;
  maxRows: number;
  maxBytes: number;
  nextPage: number;
  nextCursor: string | null;
  rows: number;
  bytes: number;
  maxObservedSeq: number | null;
  error: string | null;
}

export interface CanonicalRetainedStageFact {
  readonly sourceEventId: string;
  readonly threadId: string;
  readonly sequence: number;
  readonly json: string;
  readonly bytes: number;
}

const FACT_KEYS = [
  "sourceEventId",
  "threadId",
  "turnId",
  "sequence",
  "projectId",
  "providerId",
  "createdAtMs",
  "turnStartedAtMs",
  "turnCompletedAtMs",
  "capabilityKind",
  "capabilityKey",
  "status",
  "durationMs",
  "failed",
  "errorClass",
  "errorSignature",
  "commandBinary",
  "commandArgument1",
  "commandArgument2",
  "commandUsesHelp",
  "commandShape",
  "commandShellWrapped",
  "commandAttributionEligible",
] as const;

const CAPABILITY_KINDS = new Set<ToolExecutionFact["capabilityKind"]>([
  "tool",
  "command",
  "file_read",
]);
const STATUSES = new Set<ToolExecutionFact["status"]>([
  "completed",
  "failed",
  "interrupted",
  "unknown",
]);
const COMMAND_SHAPES = new Set<NonNullable<ToolExecutionFact["commandShape"]>>([
  "simple",
  "pipeline",
  "joined",
  "pipeline_and_joined",
  "unparsed",
]);

/**
 * Canonical staging payload. It is intentionally narrower than a source event:
 * exactly the declared projected-fact fields are persisted, in a stable order.
 */
export function canonicalizeRetainedStageFact(value: unknown): CanonicalRetainedStageFact {
  if (!isPlainRecord(value)) throw new Error("Invalid retained stage fact.");
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== FACT_KEYS.length
    || keys.some(
      (key) => typeof key !== "string"
        || !Object.prototype.propertyIsEnumerable.call(value, key)
        || !FACT_KEYS.includes(key as (typeof FACT_KEYS)[number]),
    )
  ) {
    throw new Error("Invalid retained stage fact fields.");
  }

  const sourceEventId = requiredString(value.sourceEventId, "sourceEventId");
  const threadId = requiredString(value.threadId, "threadId");
  const turnId = nullableString(value.turnId, "turnId");
  const sequence = nonnegativeInteger(value.sequence, "sequence");
  const projectId = requiredString(value.projectId, "projectId");
  const providerId = requiredString(value.providerId, "providerId");
  const createdAtMs = nonnegativeInteger(value.createdAtMs, "createdAtMs");
  const turnStartedAtMs = nullableNonnegativeInteger(value.turnStartedAtMs, "turnStartedAtMs");
  const turnCompletedAtMs = nullableNonnegativeInteger(value.turnCompletedAtMs, "turnCompletedAtMs");
  const capabilityKind = enumValue(value.capabilityKind, CAPABILITY_KINDS, "capabilityKind");
  const capabilityKey = requiredString(value.capabilityKey, "capabilityKey");
  const status = enumValue(value.status, STATUSES, "status");
  const durationMs = nonnegativeInteger(value.durationMs, "durationMs");
  if (typeof value.failed !== "boolean") throw new Error("Invalid retained stage fact failed.");
  const errorClass = nullableString(value.errorClass, "errorClass");
  const errorSignature = nullableString(value.errorSignature, "errorSignature");
  const commandBinary = nullableString(value.commandBinary, "commandBinary");
  const commandArgument1 = nullableString(value.commandArgument1, "commandArgument1");
  const commandArgument2 = nullableString(value.commandArgument2, "commandArgument2");
  if (
    typeof value.commandUsesHelp !== "boolean"
    || typeof value.commandShellWrapped !== "boolean"
    || typeof value.commandAttributionEligible !== "boolean"
  ) throw new Error("Invalid retained stage fact command flags.");
  const commandShape = value.commandShape === null
    ? null
    : enumValue(value.commandShape, COMMAND_SHAPES, "commandShape");

  const canonical: ToolExecutionFact = {
    sourceEventId,
    threadId,
    turnId,
    sequence,
    projectId,
    providerId,
    createdAtMs,
    turnStartedAtMs,
    turnCompletedAtMs,
    capabilityKind,
    capabilityKey,
    status,
    durationMs,
    failed: value.failed,
    errorClass,
    errorSignature,
    commandBinary,
    commandArgument1,
    commandArgument2,
    commandUsesHelp: value.commandUsesHelp,
    commandShape,
    commandShellWrapped: value.commandShellWrapped,
    commandAttributionEligible: value.commandAttributionEligible,
  };
  const json = JSON.stringify(canonical);
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes > RETAINED_STAGE_HARD_LIMITS.maxFactBytes) {
    throw new Error("Retained stage fact exceeds the configured byte limit.");
  }
  return { sourceEventId, threadId, sequence, json, bytes };
}

const REVISIT_REASONS: ReadonlySet<RetainedRevisitReason> = new Set([
  "incomplete",
  "partial-turn-timing",
  "invalid-turn-boundary",
  "inverted-turn-boundary",
  "turn-state-evicted",
  "timing-ref-evicted",
  "timing-revision-missed",
  "revisit-required",
]);
const REWRITE_REASONS: ReadonlySet<RetainedRewriteReason> = new Set([
  "ref-cap",
  "turn-cap",
  "checkpoint-byte-cap",
  "revisit-required",
]);
const REF_RELEASE_REASONS: ReadonlySet<RetainedRefReleaseReason> = new Set([
  "completed",
  "ref-cap",
  "turn-cap",
  "checkpoint-byte-cap",
]);
const TURN_STATUSES: ReadonlySet<RetainedTurnStateStatus> = new Set([
  "partial",
  "complete",
  "degraded",
]);

function digest(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw new Error(`Invalid retained projection ${name}.`);
  return value;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], name: string): void {
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== "string" || !Object.prototype.propertyIsEnumerable.call(value, key))) {
    throw new Error(`Invalid retained projection ${name} fields.`);
  }
  const keys = ownKeys as string[];
  keys.sort();
  const canonical = [...expected].sort();
  if (keys.length !== canonical.length || keys.some((key, index) => key !== canonical[index])) {
    throw new Error(`Invalid retained projection ${name} fields.`);
  }
}

function nullableSequence(value: unknown, name: string): number | null {
  return value === null ? null : nonnegativeInteger(value, name);
}

function cursor(value: unknown, name: string): string | null {
  if (value === null) return null;
  if (
    typeof value !== "string"
    || Buffer.byteLength(value, "utf8") > RETAINED_STAGE_HARD_LIMITS.maxCursorBytes
    || !/^\d+$/.test(value)
    || BigInt(value) > BigInt(Number.MAX_SAFE_INTEGER)
  ) throw new Error(`Invalid retained projection ${name}.`);
  return BigInt(value).toString();
}

function exactMode(value: unknown): RetainedStageMode {
  if (value !== "delta" && value !== "rewrite" && value !== "upgrade") {
    throw new Error("Invalid retained projection stage mode.");
  }
  return value;
}

export function canonicalizeRetainedProjectionCheckpoint(
  value: unknown,
  budget: Pick<RetainedProjectionStageBudget, "maxCheckpointBytes" | "maxTurnStates" | "maxTimingRefs"> = {
    maxCheckpointBytes: RETAINED_STAGE_HARD_LIMITS.maxCheckpointBytes,
    maxTurnStates: RETAINED_STAGE_HARD_LIMITS.maxTurnStates,
    maxTimingRefs: RETAINED_STAGE_HARD_LIMITS.maxTimingRefs,
  },
): RetainedProjectionCheckpoint & { json: string; bytes: number } {
  if (!isPlainRecord(value)) throw new Error("Invalid retained projection checkpoint.");
  exactKeys(value, [
    "format", "algorithm", "targetProjectionVersion", "mode", "runId", "threadId",
    "nextStagePage", "sourceAfterSeq", "maxFactSeq", "turns", "timingRefs", "revisitReasons",
    "rewriteRequired", "rewriteDirective",
  ], "checkpoint");
  if (value.format !== RETAINED_CHECKPOINT_FORMAT || value.algorithm !== RETAINED_PROJECTION_ALGORITHM) {
    throw new Error("Invalid retained projection checkpoint format.");
  }
  if (value.targetProjectionVersion !== RETAINED_TARGET_PROJECTION_VERSION) {
    throw new Error("Invalid retained projection target version.");
  }
  const mode = exactMode(value.mode);
  const runId = requiredString(value.runId, "checkpoint.runId");
  const threadId = requiredString(value.threadId, "checkpoint.threadId");
  const nextStagePage = nonnegativeInteger(value.nextStagePage, "checkpoint.nextStagePage");
  const sourceAfterSeq = cursor(value.sourceAfterSeq, "checkpoint.sourceAfterSeq");
  const maxFactSeq = nullableSequence(value.maxFactSeq, "checkpoint.maxFactSeq");
  if (typeof value.rewriteRequired !== "boolean") throw new Error("Invalid retained projection rewriteRequired.");
  if (!Array.isArray(value.turns) || value.turns.length > budget.maxTurnStates) {
    throw new Error("Retained projection turn-state cap exceeded.");
  }
  if (!Array.isArray(value.timingRefs) || value.timingRefs.length > budget.maxTimingRefs) {
    throw new Error("Retained projection timing-ref cap exceeded.");
  }
  if (!Array.isArray(value.revisitReasons) || value.revisitReasons.length > RETAINED_STAGE_HARD_LIMITS.maxReasons) {
    throw new Error("Retained projection reason cap exceeded.");
  }

  const turns = value.turns.map((turn) => {
    if (!isPlainRecord(turn)) throw new Error("Invalid retained projection turn state.");
    exactKeys(turn, [
      "turnId", "startedAtMs", "completedAtMs", "startedSeq", "completedSeq",
      "revisionSeq", "lastSeenSeq", "degraded", "status",
    ], "turn state");
    const turnId = requiredString(turn.turnId, "turn.turnId");
    const startedAtMs = nullableSequence(turn.startedAtMs, "turn.startedAtMs");
    const completedAtMs = nullableSequence(turn.completedAtMs, "turn.completedAtMs");
    const startedSeq = nullableSequence(turn.startedSeq, "turn.startedSeq");
    const completedSeq = nullableSequence(turn.completedSeq, "turn.completedSeq");
    const revisionSeq = nullableSequence(turn.revisionSeq, "turn.revisionSeq");
    const lastSeenSeq = nonnegativeInteger(turn.lastSeenSeq, "turn.lastSeenSeq");
    if (typeof turn.degraded !== "boolean") throw new Error("Invalid retained projection turn degraded flag.");
    if (!TURN_STATUSES.has(turn.status as RetainedTurnStateStatus)) {
      throw new Error("Invalid retained projection turn status.");
    }
    if ((startedAtMs == null) !== (startedSeq == null) || (completedAtMs == null) !== (completedSeq == null)) {
      throw new Error("Retained projection turn timing/sequence mismatch.");
    }
    if (
      (startedSeq != null && startedSeq > lastSeenSeq)
      || (completedSeq != null && completedSeq > lastSeenSeq)
      || (revisionSeq != null && revisionSeq > lastSeenSeq)
    ) throw new Error("Retained projection turn sequence exceeds lastSeenSeq.");
    const inverted = startedAtMs != null && completedAtMs != null && completedAtMs < startedAtMs;
    const expectedStatus: RetainedTurnStateStatus = turn.degraded || inverted
      ? "degraded"
      : startedAtMs != null && completedAtMs != null
        ? "complete"
        : "partial";
    if (turn.status !== expectedStatus) throw new Error("Retained projection turn status/timing mismatch.");
    return {
      turnId,
      startedAtMs,
      completedAtMs,
      startedSeq,
      completedSeq,
      revisionSeq,
      lastSeenSeq,
      degraded: turn.degraded,
      status: turn.status as RetainedTurnStateStatus,
    } satisfies RetainedTurnState;
  }).sort((left, right) => left.turnId.localeCompare(right.turnId));
  if (new Set(turns.map((turn) => turn.turnId)).size !== turns.length) {
    throw new Error("Duplicate retained projection turn state.");
  }

  const timingRefs = value.timingRefs.map((ref) => {
    if (!isPlainRecord(ref)) throw new Error("Invalid retained projection timing ref.");
    exactKeys(ref, [
      "sourceEventId", "turnId", "sequence", "factDigest", "turnStartedAtMs", "turnCompletedAtMs",
    ], "timing ref");
    return {
      sourceEventId: requiredString(ref.sourceEventId, "timingRef.sourceEventId"),
      turnId: requiredString(ref.turnId, "timingRef.turnId"),
      sequence: nonnegativeInteger(ref.sequence, "timingRef.sequence"),
      factDigest: digest(ref.factDigest, "timingRef.factDigest"),
      turnStartedAtMs: nullableSequence(ref.turnStartedAtMs, "timingRef.turnStartedAtMs"),
      turnCompletedAtMs: nullableSequence(ref.turnCompletedAtMs, "timingRef.turnCompletedAtMs"),
    } satisfies RetainedTimingRef;
  }).sort((left, right) => left.sourceEventId.localeCompare(right.sourceEventId));
  if (new Set(timingRefs.map((ref) => ref.sourceEventId)).size !== timingRefs.length) {
    throw new Error("Duplicate retained projection timing ref.");
  }
  const turnsById = new Map(turns.map((turn) => [turn.turnId, turn]));
  for (const ref of timingRefs) {
    const turn = turnsById.get(ref.turnId);
    if (
      turn == null
      || ref.sequence > turn.lastSeenSeq
      || turn.status === "complete"
      || (turn.status === "degraded"
        ? ref.turnStartedAtMs !== null || ref.turnCompletedAtMs !== null
        : ref.turnStartedAtMs !== turn.startedAtMs || ref.turnCompletedAtMs !== turn.completedAtMs)
    ) throw new Error("Retained projection timing ref does not match its turn state.");
  }

  const revisitReasons = value.revisitReasons.map((reason) => {
    if (!REVISIT_REASONS.has(reason as RetainedRevisitReason)) {
      throw new Error("Invalid retained projection revisit reason.");
    }
    return reason as RetainedRevisitReason;
  });
  if (new Set(revisitReasons).size !== revisitReasons.length) {
    throw new Error("Duplicate retained projection revisit reason.");
  }
  const incomplete = turns.some((turn) => turn.status !== "complete") || timingRefs.length > 0;
  if (incomplete && !revisitReasons.includes("incomplete")) {
    throw new Error("Retained projection checkpoint omitted the sticky incomplete reason.");
  }
  const rewriteRequired = value.rewriteRequired as boolean;
  let rewriteDirective: RetainedRewriteDirective | null = null;
  if (value.rewriteDirective !== null) {
    if (!isPlainRecord(value.rewriteDirective)) throw new Error("Invalid retained projection rewrite directive.");
    exactKeys(value.rewriteDirective, ["threadId", "restart", "reasons"], "rewrite directive");
    const directiveThreadId = requiredString(value.rewriteDirective.threadId, "rewriteDirective.threadId");
    if (directiveThreadId !== threadId || value.rewriteDirective.restart !== "beginning") {
      throw new Error("Retained projection rewrite directive identity mismatch.");
    }
    if (
      !Array.isArray(value.rewriteDirective.reasons)
      || value.rewriteDirective.reasons.length === 0
      || value.rewriteDirective.reasons.length > RETAINED_STAGE_HARD_LIMITS.maxReasons
    ) {
      throw new Error("Retained projection rewrite directive has no reason.");
    }
    const directiveReasons = value.rewriteDirective.reasons.map((reason) => {
      if (!REWRITE_REASONS.has(reason as RetainedRewriteReason)) throw new Error("Invalid retained projection rewrite reason.");
      return reason as RetainedRewriteReason;
    });
    if (new Set(directiveReasons).size !== directiveReasons.length) throw new Error("Duplicate retained projection rewrite reason.");
    rewriteDirective = { threadId, restart: "beginning", reasons: directiveReasons };
  }
  if (rewriteRequired !== (rewriteDirective !== null)) {
    throw new Error("Retained projection rewrite directive/flag mismatch.");
  }
  const canonical: RetainedProjectionCheckpoint = {
    format: RETAINED_CHECKPOINT_FORMAT,
    algorithm: RETAINED_PROJECTION_ALGORITHM,
    targetProjectionVersion: RETAINED_TARGET_PROJECTION_VERSION,
    mode,
    runId,
    threadId,
    nextStagePage,
    sourceAfterSeq,
    maxFactSeq,
    turns,
    timingRefs,
    revisitReasons,
    rewriteRequired,
    rewriteDirective,
  };
  const json = JSON.stringify(canonical);
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes > budget.maxCheckpointBytes) throw new Error("Retained projection checkpoint exceeds the byte limit.");
  return { ...canonical, json, bytes };
}

/**
 * Minimum durable space for cursor/page progress plus every sticky reason and
 * rewrite directive. Turn/ref state remains evictable above this reservation.
 */
export function retainedProjectionMinimumCheckpointBytes(
  runId: string,
  threadId: string,
  mode: RetainedStageMode,
): number {
  const checkpoint: RetainedProjectionCheckpoint = {
    format: RETAINED_CHECKPOINT_FORMAT,
    algorithm: RETAINED_PROJECTION_ALGORITHM,
    targetProjectionVersion: RETAINED_TARGET_PROJECTION_VERSION,
    mode,
    runId,
    threadId,
    nextStagePage: RETAINED_STAGE_HARD_LIMITS.maxPages,
    sourceAfterSeq: String(Number.MAX_SAFE_INTEGER),
    maxFactSeq: Number.MAX_SAFE_INTEGER,
    turns: [],
    timingRefs: [],
    revisitReasons: [...RETAINED_CHECKPOINT_RESERVE_REVISIT_REASONS],
    rewriteRequired: true,
    rewriteDirective: {
      threadId,
      restart: "beginning",
      reasons: [...RETAINED_CHECKPOINT_RESERVE_REWRITE_REASONS],
    },
  };
  return canonicalizeRetainedProjectionCheckpoint(checkpoint, {
    maxCheckpointBytes: RETAINED_STAGE_HARD_LIMITS.maxCheckpointBytes,
    maxTurnStates: RETAINED_STAGE_HARD_LIMITS.maxTurnStates,
    maxTimingRefs: RETAINED_STAGE_HARD_LIMITS.maxTimingRefs,
  }).bytes;
}

export function canonicalizeRetainedTimestampRevision(value: unknown): {
  revision: RetainedTimestampRevision;
  json: string;
  bytes: number;
} {
  if (!isPlainRecord(value)) throw new Error("Invalid retained timestamp revision.");
  exactKeys(value, [
    "revisionKey", "sourceEventId", "turnId", "sequence", "timingRevisionSeq",
    "expectedFactDigest", "turnStartedAtMs", "turnCompletedAtMs",
  ], "revision");
  const revision: RetainedTimestampRevision = {
    revisionKey: requiredString(value.revisionKey, "revision.revisionKey"),
    sourceEventId: requiredString(value.sourceEventId, "revision.sourceEventId"),
    turnId: requiredString(value.turnId, "revision.turnId"),
    sequence: nonnegativeInteger(value.sequence, "revision.sequence"),
    timingRevisionSeq: nonnegativeInteger(value.timingRevisionSeq, "revision.timingRevisionSeq"),
    expectedFactDigest: digest(value.expectedFactDigest, "revision.expectedFactDigest"),
    turnStartedAtMs: nullableSequence(value.turnStartedAtMs, "revision.turnStartedAtMs"),
    turnCompletedAtMs: nullableSequence(value.turnCompletedAtMs, "revision.turnCompletedAtMs"),
  };
  const json = JSON.stringify(revision);
  return { revision, json, bytes: Buffer.byteLength(json, "utf8") };
}

export function canonicalizeRetainedRefRelease(value: unknown): RetainedRefRelease {
  if (!isPlainRecord(value)) throw new Error("Invalid retained ref-release evidence.");
  exactKeys(value, ["sourceEventId", "reason"], "ref release");
  const reason = value.reason;
  if (!REF_RELEASE_REASONS.has(reason as RetainedRefReleaseReason)) {
    throw new Error("Invalid retained ref-release reason.");
  }
  return {
    sourceEventId: requiredString(value.sourceEventId, "refRelease.sourceEventId"),
    reason: reason as RetainedRefReleaseReason,
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value == null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requiredString(value: unknown, name: string): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || Buffer.byteLength(value, "utf8") > RETAINED_STAGE_HARD_LIMITS.maxIdentifierBytes
  ) throw new Error(`Invalid retained stage fact ${name}.`);
  return value;
}

function nullableString(value: unknown, name: string): string | null {
  if (value === null) return null;
  return requiredString(value, name);
}

function nonnegativeInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid retained stage fact ${name}.`);
  }
  return value;
}

function nullableNonnegativeInteger(value: unknown, name: string): number | null {
  return value === null ? null : nonnegativeInteger(value, name);
}

function enumValue<T extends string>(value: unknown, allowed: ReadonlySet<T>, name: string): T {
  if (typeof value !== "string" || !allowed.has(value as T)) {
    throw new Error(`Invalid retained stage fact ${name}.`);
  }
  return value as T;
}
