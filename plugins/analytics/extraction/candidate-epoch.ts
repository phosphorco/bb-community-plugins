import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";

export const MANAGED_CANDIDATE_TARGET_PROJECTION_VERSION = 5 as const;
export const MANAGED_CANDIDATE_ALGORITHM = "retained-fact-projection-v1" as const;
export const MANAGED_CANDIDATE_RESTART = "beginning" as const;
export const MANAGED_CANDIDATE_BASELINE_FRONTIER_UNAVAILABLE = "unavailable" as const;
export const MANAGED_CANDIDATE_MAX_IDENTIFIER_BYTES = 512 as const;
export const MANAGED_CANDIDATE_MAX_CURSOR_BYTES = 8 * 1024;
export const MANAGED_CANDIDATE_MAX_ERROR_BYTES = 2_000 as const;
export const MANAGED_CANDIDATE_MAX_REASON_BYTES = 512 as const;
export const MANAGED_CANDIDATE_MAX_DIRECTIVE_BYTES = 2_048 as const;
export const MANAGED_CANDIDATE_SEAL_ROW_LIMIT = 256 as const;
export const MANAGED_CANDIDATE_SEAL_TARGET_BYTES = 1_048_576n;
export const MANAGED_CANDIDATE_ROLLING_SEED = "0".repeat(64);

export type ManagedCandidateMode = "rewrite" | "upgrade";
export type ManagedCandidateEpochState = "open" | "freezing" | "frozen" | "sealing" | "sealed";
export type ManagedCandidatePinState = "bound" | "pinned";
export type ManagedCandidateOutcome = "source-exhausted" | "failed" | "terminal-capped";
export type ManagedCandidateObservationQuality = "clean" | "degraded";
export type ManagedCandidateOperation = "freeze" | "seal";

export interface OpenManagedCandidateEpoch {
  epochId: string;
  mode: ManagedCandidateMode;
  targetProjectionVersion: typeof MANAGED_CANDIDATE_TARGET_PROJECTION_VERSION;
  algorithm: typeof MANAGED_CANDIDATE_ALGORITHM;
  restart: typeof MANAGED_CANDIDATE_RESTART;
  observedAt: number;
}

export interface BindManagedCandidateMember {
  epochId: string;
  threadId: string;
  runId: string;
}

export interface CandidateRevisionInput {
  epochId: string;
  expectedManifestRevision: bigint;
}

export interface AdvanceManagedCandidateEpoch extends CandidateRevisionInput {
  operation: ManagedCandidateOperation;
}

export interface PinManagedCandidateMember {
  epochId: string;
  threadId: string;
  expectedMemberRevision: bigint;
}

export interface ManagedCandidateEpochProgress {
  epochId: string;
  mode: ManagedCandidateMode;
  targetProjectionVersion: typeof MANAGED_CANDIDATE_TARGET_PROJECTION_VERSION;
  algorithm: typeof MANAGED_CANDIDATE_ALGORITHM;
  restart: typeof MANAGED_CANDIDATE_RESTART;
  state: ManagedCandidateEpochState;
  manifestRevision: bigint;
  createdAt: number;
  frozenAt: number | null;
  sealedAt: number | null;
  baselineGenerationId: bigint;
  baselineProjectionVersion: bigint;
  baselineSourceFrontierState: typeof MANAGED_CANDIDATE_BASELINE_FRONTIER_UNAVAILABLE;
  membershipCount: bigint | null;
  membershipCursor: string | null;
  membershipRollingDigest: string | null;
  membershipDigest: string | null;
  pinCursor: string | null;
  pinnedCount: bigint | null;
  pinnedRollingDigest: string | null;
  sealMembershipRollingDigest: string | null;
  observationDigest: string | null;
  observationQuality: ManagedCandidateObservationQuality | null;
  lastOperationDigest: string | null;
  error: string | null;
}

export interface ManagedCandidateMemberProgress {
  epochId: string;
  threadId: string;
  runId: string;
  memberRevision: bigint;
  pinOperationDigest: string | null;
  boundStageAccountingRevision: bigint;
  boundNextPage: number;
  boundCheckpointDigest: string;
  pinState: ManagedCandidatePinState;
  outcome: ManagedCandidateOutcome | null;
  observedNextPage: number | null;
  observedLastPageDigest: string | null;
  observedCheckpointDigest: string | null;
  observedOperationDigest: string | null;
  observedSourceAfterSeq: string | null;
  observedFactMaxSeq: number | null;
  observedIncompleteReasonsJson: string;
  observedRewriteRequired: boolean;
  observedRewriteDirectiveJson: string | null;
  failureReason: string | null;
  terminalReason: string | null;
  error: string | null;
  observationDigest: string | null;
  observedAt: number | null;
  observedStageAccountingRevision: bigint | null;
}

export function candidateDigest(value: string, name: string): string {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error(`Invalid managed candidate ${name}.`);
  return value;
}

export function candidateIdentifier(value: string, name: string): string {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > MANAGED_CANDIDATE_MAX_IDENTIFIER_BYTES) {
    throw new Error(`Invalid managed candidate ${name}.`);
  }
  return value;
}

export function candidateCursor(value: string | null, name: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > MANAGED_CANDIDATE_MAX_CURSOR_BYTES) {
    throw new Error(`Invalid managed candidate ${name}.`);
  }
  return value;
}

export function candidateError(value: string | null, name = "error"): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > MANAGED_CANDIDATE_MAX_ERROR_BYTES) {
    throw new Error(`Invalid managed candidate ${name}.`);
  }
  return value;
}

export function candidateOperationDigest(kind: string, value: unknown): string {
  return createHash("sha256").update(JSON.stringify({ kind, value })).digest("hex");
}

export function candidateRollingDigest(previous: string, tuple: readonly unknown[]): string {
  candidateDigest(previous, "rolling digest");
  return createHash("sha256").update(`${previous}\n${JSON.stringify(tuple)}`).digest("hex");
}

export function candidateObservationDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
