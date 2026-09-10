import { createHash } from "node:crypto";

import {
  projectToolExecutionFact,
  type ToolExecutionFact,
  type TurnTiming,
} from "../fact-projection.ts";
import {
  canonicalizeRetainedProjectionCheckpoint,
  canonicalizeRetainedRefRelease,
  canonicalizeRetainedStageFact,
  retainedProjectionMinimumCheckpointBytes,
  RETAINED_CHECKPOINT_FORMAT,
  RETAINED_PROJECTION_ALGORITHM,
  RETAINED_STAGE_HARD_LIMITS,
  RETAINED_TARGET_PROJECTION_VERSION,
  type RetainedProjectionCheckpoint,
  type RetainedRefRelease,
  type RetainedRevisitReason,
  type RetainedRewriteReason,
  type RetainedStageMode,
  type RetainedTimestampRevision,
  type RetainedTimingRef,
  type RetainedTurnState,
} from "./staging.ts";
import {
  RETAINED_SOURCE_MAX_IDENTIFIER_BYTES,
  RETAINED_SOURCE_MAX_CURSOR_BYTES,
  RETAINED_SOURCE_MAX_SEQUENCE,
  RETAINED_SOURCE_POLICY_MAXIMA,
  type RetainedSourceBudgetUsage,
  type RetainedSourceEvent,
  type RetainedSourceEventPage,
} from "./source-adapter.ts";

export interface RetainedProjectionLimits {
  maxTurnStates: number;
  maxTimingRefs: number;
  maxCheckpointBytes: number;
}

export interface RetainedProjectionPageInput {
  runId: string;
  threadId: string;
  mode: RetainedStageMode;
  targetProjectionVersion: typeof RETAINED_TARGET_PROJECTION_VERSION;
  algorithm: typeof RETAINED_PROJECTION_ALGORITHM;
  stagePage: number;
  dimensions: { projectId: string; providerId: string };
  source: RetainedSourceEventPage;
  checkpoint: RetainedProjectionCheckpoint | null;
  limits: RetainedProjectionLimits;
  receivedAt: number;
}

export interface RetainedProjectedEventPage {
  facts: readonly ToolExecutionFact[];
  timestampRevisions: readonly RetainedTimestampRevision[];
  refReleases: readonly RetainedRefRelease[];
  checkpoint: RetainedProjectionCheckpoint;
  checkpointDigestIn: string;
  source: {
    cursorIn: string | null;
    cursorOut: string | null;
    pageExhausted: boolean;
    pageDigest: string;
  };
}

interface MutableTimingState {
  turnId: string;
  startedAtMs: number | null;
  completedAtMs: number | null;
  startedSeq: number | null;
  completedSeq: number | null;
  revisionSeq: number | null;
  lastSeenSeq: number;
  degraded: boolean;
  status: RetainedTurnState["status"];
}

interface Boundary {
  kind: "started" | "completed";
  turnId: string;
  createdAt: unknown;
  seq: number;
}

const EMPTY_LIMITS: RetainedProjectionLimits = {
  maxTurnStates: RETAINED_STAGE_HARD_LIMITS.maxTurnStates,
  maxTimingRefs: RETAINED_STAGE_HARD_LIMITS.maxTimingRefs,
  maxCheckpointBytes: RETAINED_STAGE_HARD_LIMITS.maxCheckpointBytes,
};

const SOURCE_BUDGET_MAX_KEYS = {
  calls: "maxCalls",
  listPages: "maxListPages",
  eventPages: "maxEventPages",
  rows: "maxRows",
  responseBytes: "maxResponseBytes",
} as const satisfies Record<keyof RetainedSourceBudgetUsage, keyof typeof RETAINED_SOURCE_POLICY_MAXIMA>;

function positiveReduction(value: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`${name} must be a positive reduction of the retained projection hard cap.`);
  }
  return value;
}

function validateLimits(input: RetainedProjectionLimits): RetainedProjectionLimits {
  return {
    maxTurnStates: positiveReduction(input.maxTurnStates, RETAINED_STAGE_HARD_LIMITS.maxTurnStates, "maxTurnStates"),
    maxTimingRefs: positiveReduction(input.maxTimingRefs, RETAINED_STAGE_HARD_LIMITS.maxTimingRefs, "maxTimingRefs"),
    maxCheckpointBytes: positiveReduction(input.maxCheckpointBytes, RETAINED_STAGE_HARD_LIMITS.maxCheckpointBytes, "maxCheckpointBytes"),
  };
}

function safeTimestamp(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function eventScope(event: RetainedSourceEvent): { kind: string; turnId?: string } | null {
  if (event.scope == null || typeof event.scope !== "object") return null;
  return event.scope as { kind: string; turnId?: string };
}

function eventTurnId(event: RetainedSourceEvent): string | null {
  const scope = eventScope(event);
  return scope?.kind === "turn" && typeof scope.turnId === "string" && scope.turnId.length > 0
    ? scope.turnId
    : null;
}

function boundaryFor(event: RetainedSourceEvent): Boundary | null {
  if (event.type !== "turn/started" && event.type !== "turn/completed") return null;
  const turnId = eventTurnId(event);
  if (turnId == null) return null;
  return {
    kind: event.type === "turn/started" ? "started" : "completed",
    turnId,
    createdAt: event.createdAt,
    seq: event.seq,
  };
}

function cloneState(state: RetainedTurnState): MutableTimingState {
  return { ...state };
}

function addReason(reasons: RetainedRevisitReason[], reason: RetainedRevisitReason): void {
  if (reason !== "incomplete" && !reasons.includes("incomplete")) reasons.unshift("incomplete");
  if (!reasons.includes(reason) && reasons.length < RETAINED_STAGE_HARD_LIMITS.maxReasons) {
    reasons.push(reason);
  }
}

function addRewriteReason(reasons: RetainedRewriteReason[], reason: RetainedRewriteReason): void {
  if (!reasons.includes(reason)) reasons.push(reason);
}

function addRelease(releases: RetainedRefRelease[], sourceEventId: string, reason: RetainedRefRelease["reason"]): void {
  if (!releases.some((release) => release.sourceEventId === sourceEventId)) {
    releases.push({ sourceEventId, reason });
  }
}

function markIncomplete(reasons: RetainedRevisitReason[], reason: RetainedRevisitReason): void {
  addReason(reasons, "incomplete");
  if (reason !== "incomplete") addReason(reasons, reason);
}

function stateStatus(state: MutableTimingState): MutableTimingState["status"] {
  if (
    state.startedAtMs != null
    && state.completedAtMs != null
    && state.completedAtMs < state.startedAtMs
  ) return "degraded";
  if (state.startedAtMs != null && state.completedAtMs != null) return "complete";
  return state.degraded ? "degraded" : "partial";
}

function evictTurnState(
  states: Map<string, MutableTimingState>,
  refs: Map<string, RetainedTimingRef>,
  limits: RetainedProjectionLimits,
  reasons: RetainedRevisitReason[],
  rewriteReasons: RetainedRewriteReason[],
  releases: RetainedRefRelease[],
): void {
  if (states.size < limits.maxTurnStates) return;
  const candidate = [...states.values()]
    .sort((left, right) => left.lastSeenSeq - right.lastSeenSeq || left.turnId.localeCompare(right.turnId))[0];
  if (candidate == null) return;
  states.delete(candidate.turnId);
  markIncomplete(reasons, "turn-state-evicted");
  addRewriteReason(rewriteReasons, "turn-cap");
  for (const ref of [...refs.values()]) {
    if (ref.turnId !== candidate.turnId) continue;
    refs.delete(ref.sourceEventId);
    addRelease(releases, ref.sourceEventId, "turn-cap");
  }
}

function ensureState(
  states: Map<string, MutableTimingState>,
  refs: Map<string, RetainedTimingRef>,
  turnId: string,
  seq: number,
  limits: RetainedProjectionLimits,
  reasons: RetainedRevisitReason[],
  rewriteReasons: RetainedRewriteReason[],
  releases: RetainedRefRelease[],
): MutableTimingState {
  const existing = states.get(turnId);
  if (existing != null) {
    existing.lastSeenSeq = Math.max(existing.lastSeenSeq, seq);
    return existing;
  }
  evictTurnState(states, refs, limits, reasons, rewriteReasons, releases);
  const created: MutableTimingState = {
    turnId,
    startedAtMs: null,
    completedAtMs: null,
    startedSeq: null,
    completedSeq: null,
    revisionSeq: null,
    lastSeenSeq: seq,
    degraded: false,
    status: "partial",
  };
  states.set(turnId, created);
  return created;
}

function mergeBoundary(
  state: MutableTimingState,
  boundary: Boundary,
  reasons: RetainedRevisitReason[],
): boolean {
  state.lastSeenSeq = Math.max(state.lastSeenSeq, boundary.seq);
  const timestamp = safeTimestamp(boundary.createdAt);
  if (timestamp == null) {
    state.degraded = true;
    state.status = "degraded";
    markIncomplete(reasons, "invalid-turn-boundary");
    return false;
  }
  const before = `${state.startedAtMs}:${state.completedAtMs}:${state.status}:${state.degraded}`;
  if (boundary.kind === "started" && (state.startedAtMs == null || timestamp < state.startedAtMs)) {
    state.startedAtMs = timestamp;
    state.startedSeq = boundary.seq;
  }
  if (boundary.kind === "completed" && (state.completedAtMs == null || timestamp > state.completedAtMs)) {
    state.completedAtMs = timestamp;
    state.completedSeq = boundary.seq;
  }
  if (
    state.startedAtMs != null
    && state.completedAtMs != null
    && state.completedAtMs >= state.startedAtMs
  ) state.degraded = false;
  state.status = stateStatus(state);
  if (state.status === "degraded") markIncomplete(reasons, "inverted-turn-boundary");
  const after = `${state.startedAtMs}:${state.completedAtMs}:${state.status}:${state.degraded}`;
  if (before === after) return false;
  state.revisionSeq = Math.max(state.revisionSeq ?? boundary.seq, boundary.seq);
  return true;
}

function currentTiming(state: MutableTimingState | undefined): { startedAtMs: number | null; completedAtMs: number | null } {
  if (state?.status === "degraded") return { startedAtMs: null, completedAtMs: null };
  return {
    startedAtMs: state?.startedAtMs ?? null,
    completedAtMs: state?.completedAtMs ?? null,
  };
}

function factDigest(fact: ToolExecutionFact): string {
  const json = canonicalizeRetainedStageFact(fact).json;
  return createHash("sha256").update(json).digest("hex");
}

function sourcePageDigest(source: RetainedSourceEventPage): string {
  const hash = createHash("sha256");
  hash.update(JSON.stringify({
    operation: source.metadata.operation,
    page: source.metadata.page,
    threadId: source.metadata.threadId,
    requestedAfterSeq: source.metadata.requestedAfterSeq,
    sourceAfterSeq: source.metadata.sourceAfterSeq,
    pageExhausted: source.metadata.pageExhausted,
  }));
  for (const row of source.rows) hash.update(JSON.stringify(row));
  return hash.digest("hex");
}

function initialCheckpoint(input: RetainedProjectionPageInput): RetainedProjectionCheckpoint {
  return {
    format: RETAINED_CHECKPOINT_FORMAT,
    algorithm: RETAINED_PROJECTION_ALGORITHM,
    targetProjectionVersion: RETAINED_TARGET_PROJECTION_VERSION,
    mode: input.mode,
    runId: input.runId,
    threadId: input.threadId,
    nextStagePage: input.stagePage,
    sourceAfterSeq: input.source.metadata.requestedAfterSeq,
    maxFactSeq: null,
    turns: [],
    timingRefs: [],
    revisitReasons: [],
    rewriteRequired: false,
    rewriteDirective: null,
  };
}

function exactSourceKeys(value: Record<string, unknown>, expected: readonly string[], name: string): void {
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== "string" || !Object.prototype.propertyIsEnumerable.call(value, key))) {
    throw new Error(`Invalid retained source ${name} fields.`);
  }
  const actual = (ownKeys as string[]).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`Invalid retained source ${name} fields.`);
  }
}

function sourceCursor(value: unknown, name: string): string | null {
  if (value === null) return null;
  if (
    typeof value !== "string"
    || Buffer.byteLength(value, "utf8") > RETAINED_SOURCE_MAX_CURSOR_BYTES
    || !/^\d+$/.test(value)
    || BigInt(value) > BigInt(RETAINED_SOURCE_MAX_SEQUENCE)
  ) throw new Error(`Invalid retained source ${name}.`);
  const normalized = BigInt(value).toString();
  if (normalized !== value) throw new Error(`Invalid retained source ${name}.`);
  return normalized;
}

function validateSourcePage(source: RetainedSourceEventPage, threadId: string): void {
  if (!source || typeof source !== "object" || !Array.isArray(source.rows)) {
    throw new Error("Invalid retained source event page rows.");
  }
  const metadata = source.metadata as unknown as Record<string, unknown>;
  if (metadata == null || typeof metadata !== "object") {
    throw new Error("Invalid retained source event metadata.");
  }
  exactSourceKeys(metadata, [
    "operation", "page", "requestedLimit", "returnedRows", "responseBytes", "pageExhausted",
    "budget", "threadId", "requestedAfterSeq", "returnedMaxSeq", "sourceAfterSeq",
  ], "event metadata");
  if (metadata.operation !== "events" || metadata.threadId !== threadId) throw new Error("Invalid retained source event operation/thread.");
  if (
    !Number.isSafeInteger(metadata.page)
    || (metadata.page as number) <= 0
    || (metadata.page as number) > RETAINED_SOURCE_POLICY_MAXIMA.maxEventPages
  ) throw new Error("Invalid retained source event page index.");
  if (!Number.isSafeInteger(metadata.requestedLimit) || (metadata.requestedLimit as number) <= 0 || (metadata.requestedLimit as number) > RETAINED_SOURCE_POLICY_MAXIMA.eventPageSize) {
    throw new Error("Invalid retained source event page limit.");
  }
  if (
    source.rows.length > (metadata.requestedLimit as number)
    || source.rows.length > RETAINED_STAGE_HARD_LIMITS.maxPageRows
  ) throw new Error("Retained source event page exceeded its bounded row limit.");
  if (!Number.isSafeInteger(metadata.returnedRows) || (metadata.returnedRows as number) < 0 || metadata.returnedRows !== source.rows.length) {
    throw new Error("Invalid retained source returned row count.");
  }
  if (!Number.isSafeInteger(metadata.responseBytes) || (metadata.responseBytes as number) < 0 || (metadata.responseBytes as number) > RETAINED_SOURCE_POLICY_MAXIMA.maxResponseBytes) {
    throw new Error("Invalid retained source response byte metadata.");
  }
  if (typeof metadata.pageExhausted !== "boolean" || metadata.pageExhausted !== source.rows.length < (metadata.requestedLimit as number)) {
    throw new Error("Retained source exhaustion metadata is inconsistent.");
  }
  const requestedAfterSeq = sourceCursor(metadata.requestedAfterSeq, "requestedAfterSeq");
  const returnedMaxSeq = sourceCursor(metadata.returnedMaxSeq, "returnedMaxSeq");
  const sourceAfterSeq = sourceCursor(metadata.sourceAfterSeq, "sourceAfterSeq");
  const budget = metadata.budget as unknown as Record<string, unknown>;
  if (budget == null || typeof budget !== "object") throw new Error("Invalid retained source budget metadata.");
  exactSourceKeys(budget, ["calls", "listPages", "eventPages", "rows", "responseBytes"], "budget");
  for (const name of Object.keys(SOURCE_BUDGET_MAX_KEYS) as Array<keyof RetainedSourceBudgetUsage>) {
    const maximum = RETAINED_SOURCE_POLICY_MAXIMA[SOURCE_BUDGET_MAX_KEYS[name]];
    if (!Number.isSafeInteger(budget[name]) || (budget[name] as number) < 0 || (budget[name] as number) > maximum) {
      throw new Error("Invalid retained source budget metadata.");
    }
  }
  if ((budget.eventPages as number) < (metadata.page as number) || (budget.rows as number) < source.rows.length || (budget.responseBytes as number) < (metadata.responseBytes as number)) {
    throw new Error("Retained source budget metadata regressed.");
  }
  let previous = requestedAfterSeq == null ? null : BigInt(requestedAfterSeq);
  let last: string | null = null;
  for (const event of source.rows) {
    const row = event as unknown as Record<string, unknown>;
    if (typeof row.id !== "string" || row.id.length === 0 || Buffer.byteLength(row.id, "utf8") > RETAINED_SOURCE_MAX_IDENTIFIER_BYTES) throw new Error("Invalid retained source event ID.");
    if (row.threadId !== threadId) throw new Error("Retained source event thread mismatch.");
    if (!Number.isSafeInteger(row.seq) || (row.seq as number) < 0 || (row.seq as number) > RETAINED_SOURCE_MAX_SEQUENCE) throw new Error("Invalid retained source event sequence.");
    const seq = BigInt(row.seq as number);
    if (previous != null && seq <= previous) throw new Error("Retained source events are not strictly increasing after cursor.");
    previous = seq;
    last = seq.toString();
    if (typeof row.createdAt !== "number" || !Number.isSafeInteger(row.createdAt) || row.createdAt < 0) throw new Error("Invalid retained source event timestamp.");
  }
  const expectedAfter = last ?? requestedAfterSeq;
  if (returnedMaxSeq !== (last ?? null) || sourceAfterSeq !== expectedAfter) throw new Error("Retained source cursor metadata is inconsistent.");
}

function completeTimings(states: Iterable<MutableTimingState>): ReadonlyMap<string, TurnTiming> {
  const result = new Map<string, TurnTiming>();
  for (const state of states) {
    if (
      state.status === "complete"
      && state.startedAtMs != null
      && state.completedAtMs != null
      && state.completedAtMs >= state.startedAtMs
    ) {
      result.set(state.turnId, { startedAtMs: state.startedAtMs, completedAtMs: state.completedAtMs });
    }
  }
  return result;
}

function checkpointValue(
  input: RetainedProjectionPageInput,
  stagePage: number,
  sourceAfterSeq: string | null,
  maxFactSeq: number | null,
  states: Map<string, MutableTimingState>,
  refs: Map<string, RetainedTimingRef>,
  reasons: RetainedRevisitReason[],
  rewriteReasons: RetainedRewriteReason[],
): RetainedProjectionCheckpoint {
  const rewriteDirective = rewriteReasons.length === 0
    ? null
    : { threadId: input.threadId, restart: "beginning" as const, reasons: [...rewriteReasons] };
  return {
    format: RETAINED_CHECKPOINT_FORMAT,
    algorithm: RETAINED_PROJECTION_ALGORITHM,
    targetProjectionVersion: RETAINED_TARGET_PROJECTION_VERSION,
    mode: input.mode,
    runId: input.runId,
    threadId: input.threadId,
    nextStagePage: stagePage,
    sourceAfterSeq,
    maxFactSeq,
    turns: [...states.values()],
    timingRefs: [...refs.values()],
    revisitReasons: [...reasons],
    rewriteRequired: rewriteDirective !== null,
    rewriteDirective,
  };
}

function fitCheckpoint(
  input: RetainedProjectionPageInput,
  limits: RetainedProjectionLimits,
  stagePage: number,
  sourceAfterSeq: string | null,
  maxFactSeq: number | null,
  states: Map<string, MutableTimingState>,
  refs: Map<string, RetainedTimingRef>,
  reasons: RetainedRevisitReason[],
  rewriteReasons: RetainedRewriteReason[],
  releases: RetainedRefRelease[],
  revisions: RetainedTimestampRevision[],
): RetainedProjectionCheckpoint & { json: string; bytes: number } {
  while (true) {
    try {
      return canonicalizeRetainedProjectionCheckpoint(
        checkpointValue(input, stagePage, sourceAfterSeq, maxFactSeq, states, refs, reasons, rewriteReasons),
        limits,
      );
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("exceeds the byte limit")) throw error;
      addRewriteReason(rewriteReasons, "checkpoint-byte-cap");
      const ref = [...refs.values()]
        .sort((left, right) => left.sequence - right.sequence || left.sourceEventId.localeCompare(right.sourceEventId))[0];
      if (ref != null) {
        markIncomplete(reasons, "timing-ref-evicted");
        refs.delete(ref.sourceEventId);
        addRelease(releases, ref.sourceEventId, "checkpoint-byte-cap");
        continue;
      }
      const state = [...states.values()]
        .sort((left, right) => left.lastSeenSeq - right.lastSeenSeq || left.turnId.localeCompare(right.turnId))[0];
      if (state != null) {
        for (const release of releases) {
          if (release.reason !== "completed") continue;
          const revision = revisions.find((candidate) => candidate.sourceEventId === release.sourceEventId);
          if (revision?.turnId !== state.turnId) continue;
          release.reason = "checkpoint-byte-cap";
          markIncomplete(reasons, "timing-ref-evicted");
          addRewriteReason(rewriteReasons, "checkpoint-byte-cap");
        }
        for (let index = revisions.length - 1; index >= 0; index -= 1) {
          if (revisions[index]?.turnId === state.turnId) revisions.splice(index, 1);
        }
        states.delete(state.turnId);
        markIncomplete(reasons, "turn-state-evicted");
        addRewriteReason(rewriteReasons, "turn-cap");
        for (const stateRef of [...refs.values()]) {
          if (stateRef.turnId !== state.turnId) continue;
          refs.delete(stateRef.sourceEventId);
          addRelease(releases, stateRef.sourceEventId, "checkpoint-byte-cap");
        }
        continue;
      }
      throw new Error("Retained projection checkpoint minimum exceeds its configured byte cap.");
    }
  }
}

function validateCheckpoint(
  checkpoint: RetainedProjectionCheckpoint,
  input: RetainedProjectionPageInput,
  limits: RetainedProjectionLimits,
): RetainedProjectionCheckpoint {
  const canonical = canonicalizeRetainedProjectionCheckpoint(checkpoint, limits);
  const { json: _json, bytes: _bytes, ...plain } = canonical;
  if (
    plain.runId !== input.runId
    || plain.threadId !== input.threadId
    || plain.mode !== input.mode
    || plain.nextStagePage !== input.stagePage
    || plain.sourceAfterSeq !== input.source.metadata.requestedAfterSeq
  ) throw new Error("Retained projection checkpoint does not own this source page.");
  return plain;
}

export function projectRetainedEventPage(input: RetainedProjectionPageInput): RetainedProjectedEventPage {
  if (input.targetProjectionVersion !== RETAINED_TARGET_PROJECTION_VERSION) {
    throw new Error("Retained projector requires target projection version 5.");
  }
  if (input.algorithm !== RETAINED_PROJECTION_ALGORITHM) {
    throw new Error("Retained projector requires the retained algorithm format.");
  }
  if (
    !Number.isSafeInteger(input.stagePage)
    || input.stagePage < 0
    || input.stagePage >= RETAINED_STAGE_HARD_LIMITS.maxPages
    || !Number.isSafeInteger(input.receivedAt)
  ) {
    throw new Error("Invalid retained projection page metadata.");
  }
  const limits = validateLimits(input.limits ?? EMPTY_LIMITS);
  if (limits.maxCheckpointBytes < retainedProjectionMinimumCheckpointBytes(input.runId, input.threadId, input.mode)) {
    throw new Error("Retained projection checkpoint budget cannot preserve bounded progress metadata.");
  }
  validateSourcePage(input.source, input.threadId);
  if (input.source.metadata.threadId !== input.threadId) throw new Error("Retained source page thread mismatch.");
  const cursorIn = input.source.metadata.requestedAfterSeq;
  const cursorOut = input.source.metadata.sourceAfterSeq;
  const prior = input.checkpoint == null
    ? initialCheckpoint(input)
    : validateCheckpoint(input.checkpoint, input, limits);
  const priorCheckpointCanonical = canonicalizeRetainedProjectionCheckpoint(prior, limits);
  const checkpointDigestIn = createHash("sha256").update(priorCheckpointCanonical.json).digest("hex");
  if (prior.sourceAfterSeq !== cursorIn) throw new Error("Retained source cursor mismatch.");

  const states = new Map(prior.turns.map((turn) => [turn.turnId, cloneState(turn)]));
  const refs = new Map(prior.timingRefs.map((ref) => [ref.sourceEventId, { ...ref }]));
  const reasons = [...prior.revisitReasons];
  const rewriteReasons = [...(prior.rewriteDirective?.reasons ?? [])];
  const refReleases: RetainedRefRelease[] = [];
  const changedTurns = new Set<string>();
  const priorStates = new Map(prior.turns.map((turn) => [turn.turnId, cloneState(turn)]));

  for (const event of input.source.rows) {
    const boundary = boundaryFor(event);
    if (boundary == null) continue;
    const state = ensureState(states, refs, boundary.turnId, boundary.seq, limits, reasons, rewriteReasons, refReleases);
    if (mergeBoundary(state, boundary, reasons)) changedTurns.add(boundary.turnId);
  }
  for (const event of input.source.rows) {
    const turnId = eventTurnId(event);
    if (turnId == null) continue;
    ensureState(states, refs, turnId, event.seq, limits, reasons, rewriteReasons, refReleases);
  }
  for (const state of states.values()) {
    if (state.status !== "complete") markIncomplete(reasons, "partial-turn-timing");
  }

  const revisions: RetainedTimestampRevision[] = [];
  for (const ref of [...refs.values()].sort((left, right) => left.sourceEventId.localeCompare(right.sourceEventId))) {
    const state = states.get(ref.turnId);
    if (state == null) {
      if (changedTurns.has(ref.turnId)) markIncomplete(reasons, "timing-revision-missed");
      continue;
    }
    const timing = currentTiming(state);
    const changed = changedTurns.has(ref.turnId)
      && (ref.turnStartedAtMs !== timing.startedAtMs || ref.turnCompletedAtMs !== timing.completedAtMs);
    if (changed) {
      const timingRevisionSeq = state.revisionSeq
        ?? (input.source.metadata.returnedMaxSeq == null
          ? ref.sequence
          : Number(input.source.metadata.returnedMaxSeq));
      const revisionKey = `${ref.sourceEventId}:${timingRevisionSeq}`;
      revisions.push({
        revisionKey,
        sourceEventId: ref.sourceEventId,
        turnId: ref.turnId,
        sequence: ref.sequence,
        timingRevisionSeq,
        expectedFactDigest: ref.factDigest,
        turnStartedAtMs: timing.startedAtMs,
        turnCompletedAtMs: timing.completedAtMs,
      });
      ref.turnStartedAtMs = timing.startedAtMs;
      ref.turnCompletedAtMs = timing.completedAtMs;
    }
    if (state.status === "complete") {
      refs.delete(ref.sourceEventId);
      addRelease(refReleases, ref.sourceEventId, "completed");
    }
  }

  for (const turnId of changedTurns) {
    const before = priorStates.get(turnId);
    const after = states.get(turnId);
    if (before?.status === "complete" && after != null && ![...refs.values()].some((ref) => ref.turnId === turnId)) {
      markIncomplete(reasons, "revisit-required");
      addRewriteReason(rewriteReasons, "revisit-required");
    }
  }

  const facts: ToolExecutionFact[] = [];
  let maxFactSeq = prior.maxFactSeq;
  const pageSourceIds = new Set<string>();
  const timingMap = completeTimings(states.values());
  for (const event of input.source.rows) {
    const fact = projectToolExecutionFact(event, input.dimensions, timingMap);
    if (fact == null) continue;
    if (pageSourceIds.has(fact.sourceEventId)) throw new Error("Duplicate retained source event ID in page.");
    pageSourceIds.add(fact.sourceEventId);
    const state = fact.turnId == null ? undefined : states.get(fact.turnId);
    const timing = currentTiming(state);
    const retainedFact: ToolExecutionFact = {
      ...fact,
      turnStartedAtMs: timing.startedAtMs,
      turnCompletedAtMs: timing.completedAtMs,
    };
    facts.push(retainedFact);
    maxFactSeq = maxFactSeq == null ? fact.sequence : Math.max(maxFactSeq, fact.sequence);
    if (state != null && state.status !== "complete" && fact.turnId != null) {
      refs.set(fact.sourceEventId, {
        sourceEventId: fact.sourceEventId,
        turnId: fact.turnId,
        sequence: fact.sequence,
        factDigest: factDigest(retainedFact),
        turnStartedAtMs: timing.startedAtMs,
        turnCompletedAtMs: timing.completedAtMs,
      });
      markIncomplete(reasons, "partial-turn-timing");
    }
  }

  while (refs.size > limits.maxTimingRefs) {
    const candidate = [...refs.values()]
      .sort((left, right) => left.sequence - right.sequence || left.sourceEventId.localeCompare(right.sourceEventId))[0];
    if (candidate == null) break;
    refs.delete(candidate.sourceEventId);
    markIncomplete(reasons, "timing-ref-evicted");
    addRewriteReason(rewriteReasons, "ref-cap");
    addRelease(refReleases, candidate.sourceEventId, "ref-cap");
  }
  if (states.size > limits.maxTurnStates) throw new Error("Retained projector failed to enforce turn-state cap.");
  if (refs.size > limits.maxTimingRefs) throw new Error("Retained projector failed to enforce timing-ref cap.");
  const canonicalCheckpoint = fitCheckpoint(
    input,
    limits,
    input.stagePage + 1,
    cursorOut,
    maxFactSeq,
    states,
    refs,
    reasons,
    rewriteReasons,
    refReleases,
    revisions,
  );
  const { json: _checkpointJson, bytes: _checkpointBytes, ...checkpoint } = canonicalCheckpoint;
  const pageDigest = sourcePageDigest(input.source);
  const cappedReleaseIds = new Set(
    refReleases
      .filter((release) => release.reason !== "completed")
      .map((release) => release.sourceEventId),
  );
  return {
    facts,
    timestampRevisions: revisions.filter((revision) => !cappedReleaseIds.has(revision.sourceEventId)),
    refReleases: refReleases.map((release) => canonicalizeRetainedRefRelease(release)),
    checkpoint,
    checkpointDigestIn,
    source: { cursorIn, cursorOut, pageExhausted: input.source.metadata.pageExhausted, pageDigest },
  };
}
