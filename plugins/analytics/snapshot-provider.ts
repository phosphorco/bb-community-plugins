import { createHash, randomUUID } from "node:crypto";

import {
  AnalyticsSnapshotResetPendingError,
  AnalyticsSnapshotResetSupersededError,
  AnalyticsSnapshotRetentionBlockedError,
  type AnalyticsStore,
  type StoredAnalyticsSnapshot,
} from "./store.ts";

/**
 * The only input port the shared collector is allowed to use.  Implementations
 * are platform capabilities, not plugin SDK adapters: they must return
 * redacted DTOs after their operational read has closed.
 */
export interface TrustedAnalyticsDeltaSource {
  readDelta(input: {
    dataset: string;
    sourceScope: string;
    cursor: string | null;
    limit: number;
    /** Producer-enforced serialized DTO ceiling, before transfer. */
    maxResponseBytes: number;
    signal: AbortSignal;
  }): Promise<AnalyticsDeltaPage>;
}

export interface AnalyticsDeltaPage {
  sourceGeneration: string;
  nextCursor: string;
  exhausted: boolean;
  /** Producer-measured UTF-8 bytes of the emitted DTO. */
  responseBytes: number;
  events: readonly AnalyticsDeltaEvent[];
  coverage: AnalyticsSourceCoverage;
}

/** A recoverable feed reset; callers must preserve last-good data and re-admit reset work. */
export class AnalyticsCursorExpiredError extends Error {
  readonly code = "analytics_cursor_expired";
  readonly sourceGeneration: string;
  readonly resetCursor: string;
  constructor(sourceGeneration: string, resetCursor: string, message = "Analytics source cursor expired.") {
    super(message);
    this.sourceGeneration = sourceGeneration;
    this.resetCursor = resetCursor;
  }
}

export interface AnalyticsDeltaEvent {
  id: string;
  operation: "upsert" | "delete";
  /** An upsert payload is already curated and redacted by the trusted source. */
  fact?: Readonly<Record<string, JsonValue>>;
}

export interface JsonObject { readonly [key: string]: JsonValue; }
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;

export interface AnalyticsSourceCoverage {
  asOfMs: number | null;
  /** Start of the source-declared retained interval. */
  retainedAfterMs: number | null;
  earliestRetainedInclusiveMs: number | null;
  /** Frozen journal watermark used by an initial/reset backfill. */
  resetWatermark: string | null;
  sourceComplete: boolean;
  incompleteReasons: readonly string[];
}

export interface AnalyticsSnapshotCoverage extends AnalyticsSourceCoverage {
  state: "complete" | "stale" | "incomplete" | "failed";
  requestedFastPathDays: 7;
  fastPathCoverage: "complete" | "partial" | "none";
  lastFailure: string | null;
}

export interface AnalyticsSnapshotArtifact {
  format: "analytics-snapshot-v1";
  snapshotId: string;
  dataset: string;
  sourceScope: string;
  generationId: number;
  sourceGeneration: string;
  factProjectionVersion: number;
  cursor: string;
  publishedAtMs: number;
  rowCount: number;
  byteCount: number;
  integrityDigest: string;
  coverage: AnalyticsSnapshotCoverage;
  facts: readonly Readonly<Record<string, JsonValue>>[];
}

export interface AnalyticsSnapshotLease {
  leaseId: string;
  snapshot: AnalyticsSnapshotArtifact;
}

export interface SnapshotProviderLimits {
  maxRequests: number;
  maxPages: number;
  maxRows: number;
  maxBytes: number;
  maxElapsedMs: number;
  maxSnapshotRows: number;
  maxSnapshotBytes: number;
  maxRetainedGenerations: number;
  maxRetainedBytes: number;
  maxRetainedAgeMs: number;
  minimumIntervalMs: number;
}

export const SNAPSHOT_PROVIDER_LIMITS: Readonly<SnapshotProviderLimits> = Object.freeze({
  maxRequests: 64,
  maxPages: 64,
  maxRows: 25_000,
  maxBytes: 16 * 1024 * 1024,
  maxElapsedMs: 15_000,
  maxSnapshotRows: 25_000,
  maxSnapshotBytes: 16 * 1024 * 1024,
  maxRetainedGenerations: 8,
  maxRetainedBytes: 64 * 1024 * 1024,
  maxRetainedAgeMs: 7 * 24 * 60 * 60 * 1000,
  minimumIntervalMs: 60_000,
});

export type CollectResult =
  | { status: "published"; snapshot: AnalyticsSnapshotArtifact }
  | { status: "unchanged"; snapshot: AnalyticsSnapshotArtifact | null }
  | { status: "busy" | "cooldown"; snapshot: AnalyticsSnapshotArtifact | null; retryAfterMs: number }
  | { status: "reset-required"; snapshot: AnalyticsSnapshotArtifact | null; error: string }
  | { status: "retention-blocked"; snapshot: AnalyticsSnapshotArtifact | null; error: string }
  | { status: "cancelled" | "failed"; snapshot: AnalyticsSnapshotArtifact | null; error: string };

const FORBIDDEN_KEY = /(?:path|url|sdk|rpc|function|callback|database|handle|token|secret|credential|authorization)/iu;
const ALLOWED_DATASETS = new Set(["tool-execution-v1", "skill-observation-v1"]);
const MAX_IDENTIFIER_BYTES = 256;
const MAX_CURSOR_BYTES = 4_096;
const MAX_ERROR_BYTES = 2_000;

function bytes(value: unknown): number { return Buffer.byteLength(JSON.stringify(value), "utf8"); }
function digest(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function clone<T>(value: T): T { return structuredClone(value); }
function frozen<T>(value: T): T { return deepFreeze(clone(value)); }

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function validIdentifier(value: string, name: string): string {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > MAX_IDENTIFIER_BYTES || /[\u0000-\u001f]/u.test(value)) {
    throw new TypeError(`Invalid analytics snapshot ${name}.`);
  }
  return value;
}

function validCursor(value: string): string {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > MAX_CURSOR_BYTES) throw new TypeError("Invalid analytics source cursor.");
  return value;
}

function assertSafeJson(value: unknown, depth = 0): asserts value is JsonValue {
  if (depth > 12 || value === undefined || typeof value === "bigint" || typeof value === "function" || typeof value === "symbol") {
    throw new TypeError("Analytics source fact is not bounded JSON.");
  }
  if (value === null || typeof value === "boolean" || typeof value === "string") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Analytics source fact contains a non-finite number.");
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertSafeJson(item, depth + 1);
    return;
  }
  if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError("Analytics source fact must be a plain JSON object.");
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEY.test(key) || key === "__proto__" || key === "constructor" || key === "prototype") {
      throw new TypeError(`Analytics source fact contains forbidden field ${key}.`);
    }
    assertSafeJson(child, depth + 1);
  }
}

function normalizedCoverage(source: AnalyticsSourceCoverage, now: number, failure: string | null): AnalyticsSnapshotCoverage {
  const earliest = source.earliestRetainedInclusiveMs;
  const recentCutoff = now - 7 * 86_400_000;
  const fastPathCoverage = !source.sourceComplete || earliest == null || source.retainedAfterMs == null
    ? "none"
    : source.retainedAfterMs <= recentCutoff && earliest <= recentCutoff ? "complete" : "partial";
  return {
    asOfMs: source.asOfMs,
    retainedAfterMs: source.retainedAfterMs,
    earliestRetainedInclusiveMs: earliest,
    resetWatermark: source.resetWatermark,
    sourceComplete: source.sourceComplete,
    incompleteReasons: [...new Set(source.incompleteReasons)].sort(),
    state: failure != null ? "failed" : source.sourceComplete && fastPathCoverage === "complete" ? "complete" : "incomplete",
    requestedFastPathDays: 7,
    fastPathCoverage,
    lastFailure: failure,
  };
}

function asArtifact(stored: StoredAnalyticsSnapshot): AnalyticsSnapshotArtifact {
  return frozen({
    format: "analytics-snapshot-v1",
    snapshotId: stored.snapshotId,
    dataset: stored.dataset,
    sourceScope: stored.sourceScope,
    generationId: stored.generationId,
    sourceGeneration: stored.sourceGeneration,
    factProjectionVersion: stored.factProjectionVersion,
    cursor: stored.cursor,
    publishedAtMs: stored.publishedAtMs,
    rowCount: stored.rowCount,
    byteCount: stored.byteCount,
    integrityDigest: stored.integrityDigest,
    coverage: stored.coverage,
    facts: stored.facts,
  });
}

/**
 * One platform-owned collector/snapshot supply.  It is injectable so the
 * plugin never obtains an operational SDK or database capability itself.
 */
export class AnalyticsSnapshotProvider {
  private active = false;
  private nextAdmissibleAt = 0;
  private readonly source: TrustedAnalyticsDeltaSource;
  private readonly store: AnalyticsStore;
  private readonly limits: SnapshotProviderLimits;
  private readonly now: () => number;

  constructor(input: { source: TrustedAnalyticsDeltaSource; store: AnalyticsStore; limits?: Partial<SnapshotProviderLimits>; clock?: () => number }) {
    this.source = input.source;
    this.store = input.store;
    this.limits = Object.freeze({ ...SNAPSHOT_PROVIDER_LIMITS, ...input.limits });
    this.now = input.clock ?? Date.now;
    validateLimits(this.limits);
  }

  /** Reads a last-good immutable snapshot only; it never starts collection. */
  readSnapshot(input: { dataset: string; sourceScope: string }): AnalyticsSnapshotLease | null {
    const snapshot = this.store.readLatestAnalyticsSnapshot(input);
    if (snapshot == null) return null;
    const leaseId = randomUUID();
    this.store.leaseAnalyticsSnapshot({ leaseId, snapshotId: snapshot.snapshotId, leasedAtMs: this.now() });
    return frozen({ leaseId, snapshot: asArtifact(snapshot) });
  }

  releaseSnapshot(leaseId: string): void {
    validIdentifier(leaseId, "lease ID");
    this.store.releaseAnalyticsSnapshot(leaseId, this.retentionInput());
  }

  /**
   * An explicit, separately admitted rebuild after the trusted source has
   * declared the durable cursor expired. It starts from no prior facts, so an
   * old epoch can never be combined with a reset epoch. A failed rebuild leaves
   * both the reset request and the last good artifact untouched.
   */
  async rebuild(input: { dataset: string; sourceScope: string; factProjectionVersion: number; signal?: AbortSignal }): Promise<CollectResult> {
    validIdentifier(input.dataset, "dataset");
    validIdentifier(input.sourceScope, "source scope");
    if (!ALLOWED_DATASETS.has(input.dataset)) throw new TypeError("Analytics dataset is not platform allowlisted.");
    if (!Number.isSafeInteger(input.factProjectionVersion) || input.factProjectionVersion < 1) throw new TypeError("Invalid fact projection version.");
    const reset = this.store.readAnalyticsSnapshotReset(input);
    const prior = this.store.readLatestAnalyticsSnapshot(input);
    if (reset == null) return { status: "failed", snapshot: prior == null ? null : asArtifact(prior), error: "No trusted cursor-expiry reset is pending." };
    const now = this.now();
    if (this.active) return { status: "busy", snapshot: prior == null ? null : asArtifact(prior), retryAfterMs: this.limits.minimumIntervalMs };
    if (now < this.nextAdmissibleAt) return { status: "cooldown", snapshot: prior == null ? null : asArtifact(prior), retryAfterMs: this.nextAdmissibleAt - now };
    this.active = true;
    try {
      return await this.collectAdmitted(input, prior, { kind: "reset", cursor: reset.cursor, sourceGeneration: reset.sourceGeneration });
    } finally {
      this.nextAdmissibleAt = this.now() + this.limits.minimumIntervalMs;
      this.active = false;
    }
  }

  async collect(input: { dataset: string; sourceScope: string; factProjectionVersion: number; signal?: AbortSignal }): Promise<CollectResult> {
    validIdentifier(input.dataset, "dataset");
    if (!ALLOWED_DATASETS.has(input.dataset)) throw new TypeError("Analytics dataset is not platform allowlisted.");
    validIdentifier(input.sourceScope, "source scope");
    if (!Number.isSafeInteger(input.factProjectionVersion) || input.factProjectionVersion < 1) throw new TypeError("Invalid fact projection version.");
    const now = this.now();
    const prior = this.store.readLatestAnalyticsSnapshot(input);
    const pendingReset = this.store.readAnalyticsSnapshotReset(input);
    // Do not keep issuing the expired cursor while waiting for separately
    // admitted rebuild work. This is checked before cooldown/busy admission.
    if (pendingReset != null) {
      return { status: "reset-required", snapshot: prior == null ? null : asArtifact(prior), error: pendingReset.error };
    }
    if (this.active) return { status: "busy", snapshot: prior == null ? null : asArtifact(prior), retryAfterMs: this.limits.minimumIntervalMs };
    if (now < this.nextAdmissibleAt) return { status: "cooldown", snapshot: prior == null ? null : asArtifact(prior), retryAfterMs: this.nextAdmissibleAt - now };
    this.active = true;
    try {
      return await this.collectAdmitted(input, prior, { kind: "delta" });
    } finally {
      this.nextAdmissibleAt = this.now() + this.limits.minimumIntervalMs;
      this.active = false;
    }
  }

  private async collectAdmitted(
    input: { dataset: string; sourceScope: string; factProjectionVersion: number; signal?: AbortSignal },
    prior: StoredAnalyticsSnapshot | null,
    mode: { kind: "delta" } | { kind: "reset"; cursor: string; sourceGeneration: string },
  ): Promise<CollectResult> {
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(new Error("Analytics collection deadline exceeded.")), this.limits.maxElapsedMs);
    deadline.unref?.();
    const abort = () => controller.abort(input.signal?.reason ?? new Error("Analytics collection cancelled."));
    input.signal?.addEventListener("abort", abort, { once: true });
    try {
      const facts = new Map<string, Readonly<Record<string, JsonValue>>>();
      if (mode.kind === "delta") for (const fact of prior?.facts ?? []) facts.set(factId(fact), clone(fact));
      let cursor = mode.kind === "reset" ? mode.cursor : this.store.readAnalyticsSnapshotCursor(input) ?? prior?.cursor ?? null;
      let sourceGeneration: string | null = null;
      let resetWatermark: string | null | undefined;
      let coverage: AnalyticsSourceCoverage | null = null;
      let requests = 0;
      let rows = 0;
      let responseBytes = 0;
      let changed = false;
      for (let page = 0; page < this.limits.maxPages; page += 1) {
        controller.signal.throwIfAborted();
        if (rows >= this.limits.maxRows) throw new Error("Analytics collection row budget exceeded.");
        if (++requests > this.limits.maxRequests) throw new Error("Analytics collection request budget exceeded.");
        const pageLimit = Math.min(500, this.limits.maxRows - rows);
        const delta = await this.source.readDelta({ dataset: input.dataset, sourceScope: input.sourceScope, cursor, limit: pageLimit, maxResponseBytes: Math.min(512 * 1024, this.limits.maxBytes - responseBytes), signal: controller.signal });
        controller.signal.throwIfAborted();
        validateDelta(delta);
        if (bytes(delta.events) > delta.responseBytes) throw new Error("Analytics source underreported response bytes.");
        if (sourceGeneration != null && sourceGeneration !== delta.sourceGeneration) throw new Error("Analytics source generation changed during collection.");
        if (mode.kind === "reset" && delta.sourceGeneration !== mode.sourceGeneration) throw new Error("Analytics reset source generation did not match the trusted expiry notice.");
        if (resetWatermark !== undefined && resetWatermark !== delta.coverage.resetWatermark) throw new Error("Analytics source reset watermark changed during collection.");
        sourceGeneration = delta.sourceGeneration;
        resetWatermark = delta.coverage.resetWatermark;
        coverage = delta.coverage;
        responseBytes += delta.responseBytes;
        rows += delta.events.length;
        if (responseBytes > this.limits.maxBytes) throw new Error("Analytics collection response byte budget exceeded.");
        if (rows > this.limits.maxRows) throw new Error("Analytics collection row budget exceeded.");
        for (const event of delta.events) {
          const before = facts.get(event.id);
          if (event.operation === "delete") { if (facts.delete(event.id)) changed = true; continue; }
          // Event identity is retained as the stable upsert/delete key even if
          // the curated relation itself has no natural primary key.
          const next = frozen({ ...event.fact!, id: event.id });
          if (bytes(next) > 16 * 1024) throw new Error("Analytics source fact exceeds the per-fact byte ceiling.");
          if (JSON.stringify(before) !== JSON.stringify(next)) { facts.set(event.id, next); changed = true; }
        }
        cursor = delta.nextCursor;
        if (delta.exhausted) break;
        if (page === this.limits.maxPages - 1) throw new Error("Analytics collection page budget exceeded.");
      }
      if (sourceGeneration == null || coverage == null || cursor == null) throw new Error("Analytics source returned no completion page.");
      if (mode.kind === "reset" && (!coverage.sourceComplete || coverage.resetWatermark == null)) {
        throw new Error("Analytics reset did not establish a complete frozen retained interval.");
      }
      const orderedFacts = [...facts.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, fact]) => fact);
      const serializedBytes = bytes(orderedFacts);
      if (orderedFacts.length > this.limits.maxSnapshotRows || serializedBytes > this.limits.maxSnapshotBytes) throw new Error("Analytics snapshot storage budget exceeded.");
      if (mode.kind === "delta" && !changed && prior != null && prior.sourceGeneration === sourceGeneration && prior.factProjectionVersion === input.factProjectionVersion) {
        this.store.advanceAnalyticsSnapshotCursor({ ...input, cursor, sourceGeneration, checkedAtMs: this.now() });
        return { status: "unchanged", snapshot: asArtifact(prior) };
      }
      const publishedAtMs = this.now();
      const normalized = normalizedCoverage(coverage, publishedAtMs, null);
      const integrityDigest = digest({ dataset: input.dataset, sourceScope: input.sourceScope, sourceGeneration, factProjectionVersion: input.factProjectionVersion, cursor, facts: orderedFacts, coverage: normalized });
      if (!this.store.canPublishAnalyticsSnapshot({ ...input, candidateBytes: serializedBytes, ...this.retentionInput() })) {
        return { status: "retention-blocked", snapshot: prior == null ? null : asArtifact(prior), error: "Pinned analytics snapshot leases exceed the configured retention allowance; wait for trusted worker exit and lease release." };
      }
      const stored = this.store.publishAnalyticsSnapshot({
        snapshotId: `analytics-${integrityDigest.slice(0, 24)}`,
        dataset: input.dataset,
        sourceScope: input.sourceScope,
        sourceGeneration,
        factProjectionVersion: input.factProjectionVersion,
        cursor,
        publishedAtMs,
        rowCount: orderedFacts.length,
        byteCount: serializedBytes,
        integrityDigest,
        coverage: normalized,
        facts: orderedFacts,
        ...(mode.kind === "reset" ? { reset: { sourceGeneration: mode.sourceGeneration, cursor: mode.cursor } } : {}),
        ...this.retentionInput(),
      });
      return { status: "published", snapshot: asArtifact(stored) };
    } catch (error) {
      const cancelled = controller.signal.aborted;
      const message = boundedError(error);
      if (error instanceof AnalyticsCursorExpiredError) {
        this.store.requestAnalyticsSnapshotReset({ dataset: input.dataset, sourceScope: input.sourceScope, sourceGeneration: error.sourceGeneration, cursor: error.resetCursor, requestedAtMs: this.now(), error: message });
        const last = this.store.readLatestAnalyticsSnapshot(input);
        return { status: "reset-required", snapshot: last == null ? null : asArtifact(last), error: message };
      }
      if (error instanceof AnalyticsSnapshotRetentionBlockedError) {
        const last = this.store.readLatestAnalyticsSnapshot(input);
        return { status: "retention-blocked", snapshot: last == null ? null : asArtifact(last), error: message };
      }
      if (error instanceof AnalyticsSnapshotResetPendingError || error instanceof AnalyticsSnapshotResetSupersededError) {
        const pendingReset = this.store.readAnalyticsSnapshotReset(input);
        const last = this.store.readLatestAnalyticsSnapshot(input);
        return {
          status: "reset-required",
          snapshot: last == null ? null : asArtifact(last),
          error: pendingReset?.error ?? message,
        };
      }
      if (!cancelled) this.store.recordAnalyticsSnapshotFailure({ dataset: input.dataset, sourceScope: input.sourceScope, failedAtMs: this.now(), error: message });
      const last = this.store.readLatestAnalyticsSnapshot(input);
      return { status: cancelled ? "cancelled" : "failed", snapshot: last == null ? null : asArtifact(last), error: message };
    } finally {
      clearTimeout(deadline);
      input.signal?.removeEventListener("abort", abort);
    }
  }

  private retentionInput(): Pick<SnapshotProviderLimits, "maxRetainedGenerations" | "maxRetainedBytes" | "maxRetainedAgeMs"> {
    const { maxRetainedGenerations, maxRetainedBytes, maxRetainedAgeMs } = this.limits;
    return { maxRetainedGenerations, maxRetainedBytes, maxRetainedAgeMs };
  }
}

function factId(fact: Readonly<Record<string, JsonValue>>): string {
  const id = fact.id;
  return typeof id === "string" && id.length > 0 ? id : digest(fact);
}

function boundedError(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return Buffer.from(value, "utf8").subarray(0, MAX_ERROR_BYTES).toString("utf8");
}

function validateLimits(limits: SnapshotProviderLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`Invalid snapshot provider limit ${name}.`);
  }
}

function validateDelta(delta: AnalyticsDeltaPage): void {
  if (delta == null || typeof delta !== "object") throw new TypeError("Analytics delta page is invalid.");
  validIdentifier(delta.sourceGeneration, "source generation");
  validCursor(delta.nextCursor);
  if (!Array.isArray(delta.events) || typeof delta.exhausted !== "boolean" || !Number.isSafeInteger(delta.responseBytes) || delta.responseBytes < 0 || delta.responseBytes > 512 * 1024) throw new TypeError("Analytics delta page is malformed.");
  if (delta.coverage == null || !Array.isArray(delta.coverage.incompleteReasons) || typeof delta.coverage.sourceComplete !== "boolean" || (delta.coverage.retainedAfterMs !== null && (!Number.isSafeInteger(delta.coverage.retainedAfterMs) || delta.coverage.retainedAfterMs < 0)) || (delta.coverage.resetWatermark !== null && typeof delta.coverage.resetWatermark !== "string")) throw new TypeError("Analytics delta coverage is malformed.");
  for (const event of delta.events) {
    validIdentifier(event.id, "event ID");
    if (event.operation !== "upsert" && event.operation !== "delete") throw new TypeError("Analytics delta event operation is invalid.");
    if (event.operation === "upsert") {
      if (event.fact == null) throw new TypeError("Analytics upsert event lacks a fact.");
      assertSafeJson(event.fact);
    } else if (event.fact !== undefined) throw new TypeError("Analytics delete event cannot contain a fact.");
  }
}
