import { createHash } from "node:crypto";

import { deterministicSkillFactId, type CoverageState, type LifecycleObservationFact, type SkillMeasurementFact, type SkillRevisionIdentity } from "./skill-observation-contract.ts";

/** The independently specified retained projection is versioned separately from tool_execution_fact_v1. */
export const SKILL_FACT_PROJECTION_VERSION = 1;

export interface RetainedSkillObservationEvent {
  id: string;
  threadId: string;
  seq: number;
  createdAt: number;
  type: "skill/observed";
  observation: {
    schemaVersion: 1;
    observationId: string;
    dedupeKey: string;
    evidenceKind: "resolved" | "active-staged" | "bridge-acknowledged" | "provider-observed" | "activated" | "registered-skill-md-read" | "subtree-read" | "named-token-measurement";
    status: "supported" | "unsupported" | "failure";
    captureTrigger: string;
    actor: { principalId: string };
    threadId: string;
    providerSessionId: string;
    providerId: string;
    providerModel: string | null;
    providerTurnId: string | null;
    providerEventId: string | null;
    skill: SkillRevisionIdentity | null;
    measurement: null | {
      method: "local-content-estimate" | "provider-reported-named-context-estimate" | "provider-aggregate-usage";
      serializer: string;
      tokenizer: string;
      estimated: boolean;
      attribution: "per-skill" | "aggregate-unassigned";
      bytes: number | null;
      tokens: number | null;
    };
    failure: string | null;
  };
}

export interface SkillCoverageEpoch {
  id: string;
  startedAtMs: number;
  endedAtMs: number | null;
  lifecycle: CoverageState;
  activation: CoverageState;
}

/**
 * Dimensions returned by the authoritative public `threads.get` response.
 * They are deliberately separate from the provider event: the actor is not a
 * project authority and provider event metadata can be stale after a move.
 */
export interface AuthoritativeThreadDimensions {
  projectId: string;
  environmentId: string | null;
  providerId: string;
}

export interface ProjectedSkillObservation {
  sourceEventId: string;
  sourceSequence: number;
  sourceDigest: string;
  /** Bounded by the upstream durable event contract; retained for exact drilldown. */
  sourceEventJson: string;
  lifecycle: LifecycleObservationFact | null;
  measurement: SkillMeasurementFact | null;
}

function sourceDigest(event: RetainedSkillObservationEvent): string {
  return createHash("sha256").update(JSON.stringify(event)).digest("hex");
}

function assertEvent(event: RetainedSkillObservationEvent): void {
  if (event.type !== "skill/observed" || event.observation.schemaVersion !== 1) throw new Error("Unsupported skill observation source event.");
  if (!Number.isSafeInteger(event.seq) || event.seq < 0 || !Number.isSafeInteger(event.createdAt) || event.createdAt < 0) throw new Error("Invalid retained skill source sequence or timestamp.");
  if (event.id.length === 0 || event.threadId.length === 0 || event.observation.threadId !== event.threadId) throw new Error("Skill observation source identity does not match its thread event.");
}

function epochAt(epochs: readonly SkillCoverageEpoch[], at: number): SkillCoverageEpoch {
  const epoch = epochs.find((candidate) => at >= candidate.startedAtMs && (candidate.endedAtMs === null || at < candidate.endedAtMs));
  if (epoch == null) throw new Error("Skill observation has no truthful coverage epoch.");
  return epoch;
}

/**
 * Converts only the durable, public `skill/observed` event into query rows.
 * It intentionally refuses aggregate-unassigned usage: a total without an
 * exact revision must never be apportioned into a per-skill measurement.
 */
export function projectSkillObservation(
  event: RetainedSkillObservationEvent,
  epochs: readonly SkillCoverageEpoch[],
  dimensions: AuthoritativeThreadDimensions,
): ProjectedSkillObservation {
  assertEvent(event);
  if (
    dimensions.projectId.length === 0
    || dimensions.providerId.length === 0
    || (dimensions.environmentId !== null && dimensions.environmentId.length === 0)
  ) throw new Error("Skill observation requires authoritative thread dimensions.");
  const observation = event.observation;
  const epoch = epochAt(epochs, event.createdAt);
  const common = {
    observationId: observation.observationId,
    sourceEventId: event.id,
    coverageEpochId: epoch.id,
    observedAtMs: event.createdAt,
    sessionId: observation.providerSessionId,
    threadId: event.threadId,
    providerTurnId: observation.providerTurnId,
    principalId: observation.actor.principalId,
    projectId: dimensions.projectId,
    environmentId: dimensions.environmentId,
    providerId: dimensions.providerId,
    providerModel: observation.providerModel,
  };
  let lifecycle: LifecycleObservationFact | null = null;
  let measurement: SkillMeasurementFact | null = null;
  if (observation.skill !== null && observation.evidenceKind !== "named-token-measurement") {
    lifecycle = {
      ...common,
      factId: deterministicSkillFactId("lifecycle", { sourceEventId: event.id, observationId: observation.observationId, evidenceKind: observation.evidenceKind }),
      revision: observation.skill,
      evidenceKind: observation.evidenceKind,
      status: observation.status,
      activationObservability: epoch.activation,
      captureTrigger: observation.captureTrigger,
      providerEventId: observation.providerEventId,
      failure: observation.failure,
    } satisfies LifecycleObservationFact;
  }
  if (observation.skill !== null && observation.measurement?.attribution === "per-skill") {
    const measurementInput = observation.measurement;
    if (measurementInput.method === "provider-aggregate-usage") {
      throw new Error("Aggregate provider usage cannot be projected as a per-skill measurement.");
    }
    const family = measurementInput.method === "local-content-estimate"
      ? "content-footprint"
      : "context-occupancy";
    measurement = {
      ...common,
      factId: deterministicSkillFactId("measurement", { sourceEventId: event.id, observationId: observation.observationId, method: measurementInput.method }),
      revision: observation.skill,
      family,
      method: measurementInput.method,
      serializer: measurementInput.serializer,
      tokenizer: measurementInput.tokenizer,
      contentComponent: family === "content-footprint" ? "catalog-entry" : null,
      bytes: measurementInput.bytes,
      tokens: measurementInput.tokens,
      status: observation.status,
      estimated: measurementInput.estimated,
      rawObservationId: observation.observationId,
    } satisfies SkillMeasurementFact;
  }
  return { sourceEventId: event.id, sourceSequence: event.seq, sourceDigest: sourceDigest(event), sourceEventJson: JSON.stringify(event), lifecycle, measurement };
}

export function reconcileProjectedSkillObservations(
  events: readonly RetainedSkillObservationEvent[],
  epochs: readonly SkillCoverageEpoch[],
  dimensions: AuthoritativeThreadDimensions,
): readonly ProjectedSkillObservation[] {
  const byId = new Map<string, ProjectedSkillObservation>();
  for (const event of events) {
    const fact = projectSkillObservation(event, epochs, dimensions);
    const prior = byId.get(fact.sourceEventId);
    if (prior != null && prior.sourceDigest !== fact.sourceDigest) throw new Error(`Conflicting duplicate skill source event ${fact.sourceEventId}.`);
    byId.set(fact.sourceEventId, fact);
  }
  return [...byId.values()].sort((left, right) => left.sourceEventId.localeCompare(right.sourceEventId));
}
