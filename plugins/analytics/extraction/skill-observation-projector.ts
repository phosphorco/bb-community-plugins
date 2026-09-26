import { createHash } from "node:crypto";

import {
  createRetainedSourceAdapter,
  type RetainedSourceEventTypes,
  type RetainedSourceLimits,
  type RetainedSourceSdk,
} from "./source-adapter.ts";
import {
  projectSkillObservation,
  type AuthoritativeThreadDimensions,
  type ProjectedSkillObservation,
  type RetainedSkillObservationEvent,
  type SkillCoverageEpoch,
} from "../skill-fact-projection.ts";
import { SKILL_FACT_PROJECTION_VERSION } from "../skill-fact-projection.ts";
import { AnalyticsStore } from "../store.ts";

export interface SkillObservationCoverageStart {
  startedAtMs: number;
  epochId?: string;
}

export interface RetainedSkillObservationProjectorOptions {
  /** The real public plugin SDK, not a server implementation detail. */
  sdk: RetainedSourceSdk;
  /** Concrete SQLite publisher; this is the sole publication path. */
  store: AnalyticsStore;
  limits?: RetainedSourceLimits;
  clock?: () => number;
  /** Establishes prospective unknown coverage before source traversal. */
  coverageStart?: SkillObservationCoverageStart;
}

export interface SkillObservationProjectionResult {
  observationCount: number;
  sourceDigest: string;
  coverageEpochs: readonly SkillCoverageEpoch[];
  completedAtMs: number;
}

const SKILL_OBSERVED_EVENT_TYPES: RetainedSourceEventTypes = ["skill/observed"];

function dimensionsFromAuthoritativeThread(thread: unknown): AuthoritativeThreadDimensions {
  if (thread == null || typeof thread !== "object") {
    throw new Error("Public threads.get did not return thread metadata.");
  }
  const row = thread as Record<string, unknown>;
  if (typeof row.projectId !== "string" || row.projectId.length === 0) {
    throw new Error("Public threads.get did not return an authoritative projectId.");
  }
  if (typeof row.providerId !== "string" || row.providerId.length === 0) {
    throw new Error("Public threads.get did not return an authoritative providerId.");
  }
  if (row.environmentId !== null && (typeof row.environmentId !== "string" || row.environmentId.length === 0)) {
    throw new Error("Public threads.get did not return a nullable authoritative environmentId.");
  }
  return {
    projectId: row.projectId,
    environmentId: row.environmentId,
    providerId: row.providerId,
  };
}

function retainedSkillObservationFromRow(event: unknown): RetainedSkillObservationEvent | null {
  if (event == null || typeof event !== "object") return null;
  const row = event as Record<string, unknown>;
  if (row.type !== "skill/observed") return null;
  // Public threads.events.list returns StoredThreadEventRow: provider event
  // payload lives in data, not at the row top level. Refuse test-only rows
  // that flatten observation onto the transport envelope.
  if ("observation" in row || row.data == null || typeof row.data !== "object") {
    throw new Error("Public skill observation rows must carry data.observation.");
  }
  const data = row.data as Record<string, unknown>;
  if (data.observation == null || typeof data.observation !== "object") {
    throw new Error("Public skill observation row data has no observation.");
  }
  const observation = data.observation as Record<string, unknown>;
  if (
    observation.schemaVersion !== 1
    || typeof observation.threadId !== "string" || observation.threadId !== row.threadId
    || typeof observation.observationId !== "string" || observation.observationId.length === 0
    || typeof observation.providerSessionId !== "string" || observation.providerSessionId.length === 0
    || typeof observation.providerId !== "string" || observation.providerId.length === 0
    || observation.providerTurnId !== null && typeof observation.providerTurnId !== "string"
    || observation.actor == null || typeof observation.actor !== "object"
    || typeof (observation.actor as Record<string, unknown>).principalId !== "string"
  ) throw new Error("Public skill observation row data.observation is invalid.");
  const seq = row.seq;
  const createdAt = row.createdAt;
  if (
    typeof row.id !== "string" || row.id.length === 0
    || typeof row.threadId !== "string" || row.threadId.length === 0
    || !Number.isSafeInteger(seq) || (seq as number) < 0
    || !Number.isSafeInteger(createdAt) || (createdAt as number) < 0
  ) throw new Error("Public skill observation row has an invalid source identity.");
  return {
    id: row.id,
    threadId: row.threadId,
    seq: seq as number,
    createdAt: createdAt as number,
    type: "skill/observed",
    observation: data.observation as RetainedSkillObservationEvent["observation"],
  };
}

function sourceDigest(observations: readonly ProjectedSkillObservation[]): string {
  const hash = createHash("sha256");
  for (const observation of [...observations].sort((left, right) => left.sourceEventId.localeCompare(right.sourceEventId))) {
    hash.update(observation.sourceDigest);
    hash.update("\n");
  }
  return hash.digest("hex");
}

/**
 * Reconciles durable skill observations directly from the public threads SDK.
 * A run reads every known source thread afresh, so event-history rewrites are
 * represented by the next atomic generation. A thread is removed only after
 * its own public `threads.get` responds with the exact not-found witness.
 */
export class RetainedSkillObservationProjector {
  private readonly sdk: RetainedSourceSdk;
  private readonly store: AnalyticsStore;
  private readonly limits: RetainedSourceLimits | undefined;
  private readonly clock: () => number;
  private readonly coverageStart: SkillObservationCoverageStart | undefined;
  private inFlight: Promise<SkillObservationProjectionResult> | null = null;

  constructor(options: RetainedSkillObservationProjectorOptions) {
    this.sdk = options.sdk;
    this.store = options.store;
    this.limits = options.limits;
    this.clock = options.clock ?? (() => Date.now());
    this.coverageStart = options.coverageStart;
  }

  async reconcile(): Promise<SkillObservationProjectionResult> {
    if (this.inFlight != null) return this.inFlight;
    const run = this.reconcileOnce();
    this.inFlight = run;
    try {
      return await run;
    } finally {
      if (this.inFlight === run) this.inFlight = null;
    }
  }

  private async reconcileOnce(): Promise<SkillObservationProjectionResult> {
    const completedAtMs = this.clock();
    if (!Number.isSafeInteger(completedAtMs) || completedAtMs < 0) {
      throw new Error("Skill projection clock must return a nonnegative safe integer.");
    }
    if (this.store.listSkillCoverageEpochs().length === 0) {
      const start = this.coverageStart ?? { startedAtMs: completedAtMs };
      this.store.initializeSkillProjectionCoverage(start.startedAtMs, start.epochId);
    }
    const adapter = createRetainedSourceAdapter(this.sdk, this.limits);
    const threadIds = new Set<string>(this.store.listActiveSkillSourceThreadIds());
    let offset = 0;
    for (;;) {
      const page = await adapter.listPage({ offset });
      for (const thread of page.rows) threadIds.add(thread.id);
      if (page.metadata.pageExhausted) break;
      offset = page.metadata.nextOffset;
    }

    const pending: Array<{ event: RetainedSkillObservationEvent; dimensions: AuthoritativeThreadDimensions }> = [];
    for (const threadId of [...threadIds].sort()) {
      const thread = await adapter.getThread({ threadId });
      // A list omission is not deletion. The exact public get witness is.
      if (thread.kind === "confirmed-not-found") continue;
      const dimensions = dimensionsFromAuthoritativeThread(thread.thread);
      let afterSeq: string | null = null;
      for (;;) {
        const page = await adapter.eventPage({ threadId, afterSeq, eventTypes: SKILL_OBSERVED_EVENT_TYPES });
        for (const event of page.rows) {
          const observation = retainedSkillObservationFromRow(event);
          if (observation != null) pending.push({ event: observation, dimensions });
        }
        if (page.metadata.pageExhausted) break;
        afterSeq = page.metadata.returnedMaxSeq;
        if (afterSeq === null) throw new Error("A full skill-observation event page did not advance its source cursor.");
      }
    }
    const coverageEpochs = this.establishObservedCoverage();
    const observations = deduplicateProjectedObservations(pending.map(({ event, dimensions }) =>
      projectSkillObservation(event, coverageEpochs, dimensions),
    ));
    const digest = sourceDigest(observations);
    // This concrete AnalyticsStore call is the production publication seam;
    // no internal server-side retained-projector helper participates here.
    this.store.commitSkillProjection({
      observations,
      coverageEpochs,
      completedAtMs,
      sourceDigest: digest,
      projectionVersion: SKILL_FACT_PROJECTION_VERSION,
    });
    return { observationCount: observations.length, sourceDigest: digest, coverageEpochs, completedAtMs };
  }

  /** A completed public traversal proves lifecycle visibility, never activation. */
  private establishObservedCoverage(): SkillCoverageEpoch[] {
    const epochs = this.store.listSkillCoverageEpochs();
    const current = epochs.find((epoch) => epoch.endedAtMs === null);
    if (current == null) throw new Error("Skill projection coverage has no open epoch.");
    if (current.lifecycle === "observed" && current.activation === "unsupported") return epochs;
    return this.store.openSkillCoverageEpoch({
      id: `coverage-lifecycle-observed-${current.startedAtMs}`,
      startedAtMs: current.startedAtMs,
      lifecycle: "observed",
      activation: "unsupported",
    });
  }
}

function deduplicateProjectedObservations(
  observations: readonly ProjectedSkillObservation[],
): readonly ProjectedSkillObservation[] {
  const bySourceEventId = new Map<string, ProjectedSkillObservation>();
  for (const observation of observations) {
    const prior = bySourceEventId.get(observation.sourceEventId);
    if (prior != null && prior.sourceDigest !== observation.sourceDigest) {
      throw new Error(`Conflicting duplicate skill source event ${observation.sourceEventId}.`);
    }
    bySourceEventId.set(observation.sourceEventId, observation);
  }
  return [...bySourceEventId.values()].sort((left, right) => left.sourceEventId.localeCompare(right.sourceEventId));
}
