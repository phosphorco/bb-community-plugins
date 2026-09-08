import {
  canonicalizeIdentity,
  canonicalizeResource,
  projectionPayloadJson,
  sha256Hex,
  type CanonicalIdentity,
  type CanonicalResource,
  type Presentation,
  type Resource,
  type ResourceIdentity,
} from "./canonical.ts";
import {
  CrossReferenceValidationError,
  MAX_TARGETS,
  PROTOCOL_VERSION,
  validateDigest,
  validateMutationId,
  validateProducerPluginId,
  validateRevision,
} from "./canonical.ts";

export {
  PROTOCOL_VERSION,
  CrossReferenceValidationError,
  type Presentation,
  type Resource,
  type ResourceIdentity,
};

export interface ApplyProjectionInput {
  protocolVersion: 1;
  producerPluginId: string;
  mutationId: string;
  source: Resource;
  revision: number;
  expectedRevision: number;
  payloadDigest: string;
  tombstone: boolean;
  targets: Resource[];
}

export type ProjectionOutcome = "applied" | "duplicate" | "equal" | "stale" | "conflict" | "cas-mismatch";

export interface ApplyProjectionResponse {
  outcome: ProjectionOutcome;
  currentRevision: number;
  currentDigest: string | null;
}

export interface NormalizedProjectionCommand extends Omit<ApplyProjectionInput, "source" | "targets"> {
  source: CanonicalResource;
  targets: CanonicalResource[];
  payloadJson: string;
  computedPayloadDigest: string;
}

export interface Projection {
  producerPluginId: string;
  source: Resource;
  revision: number;
  mutationId: string;
  payloadDigest: string;
  tombstone: boolean;
  targets: Resource[];
}

export interface GetProjectionResponse {
  projection: Projection | null;
}

export interface ListBacklinksInput {
  target: ResourceIdentity;
  pageSize?: number;
  cursor?: string;
}

export interface BacklinkRow {
  source: Resource;
  producerPluginId: string;
  revision: number;
  targetPresentation: Presentation;
  position: number;
}

export interface ListBacklinksResponse {
  rows: BacklinkRow[];
  nextCursor: string | null;
}

export interface CrossReferencesChangedSignal {
  protocolVersion: 1;
  affectedIdentityDigests: string[];
  producerPluginId: string;
  sourceIdentityDigest: string;
  revision: number;
}

function assertInputRecord(value: unknown): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CrossReferenceValidationError("projection input must be an object.");
  }
  const fields = Object.keys(value).sort();
  if (fields.join(",") !== "expectedRevision,mutationId,payloadDigest,producerPluginId,protocolVersion,revision,source,targets,tombstone") {
    throw new CrossReferenceValidationError("projection input fields are invalid.");
  }
}

export function normalizeProjectionCommand(input: ApplyProjectionInput): NormalizedProjectionCommand {
  assertInputRecord(input);
  if (input.protocolVersion !== PROTOCOL_VERSION) {
    throw new CrossReferenceValidationError(`protocolVersion must be ${PROTOCOL_VERSION}.`);
  }
  const producerPluginId = validateProducerPluginId(input.producerPluginId);
  const mutationId = validateMutationId(input.mutationId);
  const revision = validateRevision(input.revision, "revision", 1);
  const expectedRevision = validateRevision(input.expectedRevision, "expectedRevision", 0);
  if (typeof input.tombstone !== "boolean") {
    throw new CrossReferenceValidationError("tombstone must be a boolean.");
  }
  if (!Array.isArray(input.targets) || input.targets.length > MAX_TARGETS) {
    throw new CrossReferenceValidationError(`targets must contain at most ${MAX_TARGETS} resources.`);
  }

  const source = canonicalizeResource(input.source);
  const targets = input.targets.map((target) => canonicalizeResource(target));
  const identitySet = new Set<string>();
  for (const target of targets) {
    if (identitySet.has(target.canonicalIdentityJson)) {
      throw new CrossReferenceValidationError("targets must not contain duplicate resource identities.");
    }
    identitySet.add(target.canonicalIdentityJson);
  }
  if (input.tombstone && targets.length !== 0) {
    throw new CrossReferenceValidationError("a tombstone must have an empty target list.");
  }

  const payloadJson = projectionPayloadJson(producerPluginId, source, input.tombstone, targets);
  const computedPayloadDigest = sha256Hex(payloadJson);
  const payloadDigest = validateDigest(input.payloadDigest);
  if (payloadDigest !== computedPayloadDigest) {
    throw new CrossReferenceValidationError("payloadDigest does not match the canonical projection payload.");
  }

  return {
    protocolVersion: PROTOCOL_VERSION,
    producerPluginId,
    mutationId,
    source,
    revision,
    expectedRevision,
    payloadDigest,
    tombstone: input.tombstone,
    targets,
    payloadJson,
    computedPayloadDigest,
  };
}

export function normalizeIdentityInput(input: ResourceIdentity): CanonicalIdentity {
  return canonicalizeIdentity(input);
}

export function defaultPageSize(pageSize: number | undefined): number {
  if (pageSize === undefined) return 25;
  const validated = validateRevision(pageSize, "pageSize", 1);
  if (validated > 100) {
    throw new CrossReferenceValidationError("pageSize must be between 1 and 100.");
  }
  return validated;
}
