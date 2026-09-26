import { createHash } from "node:crypto";

/**
 * The Analytics-side vocabulary for SkillObservation v1.  This module is
 * deliberately projection-only: it does not claim that a provider emitted a
 * signal which the durable runtime observation did not contain.
 */
export const SKILL_ANALYTICS_CONTRACT_VERSION = 1 as const;

export const lifecycleEvidenceKinds = [
  "resolved",
  "active-staged",
  "bridge-acknowledged",
  "provider-observed",
  "activated",
  "registered-skill-md-read",
  "subtree-read",
] as const;
export type LifecycleEvidenceKind = (typeof lifecycleEvidenceKinds)[number];

export const lifecycleEvidencePrecedence: Readonly<Record<LifecycleEvidenceKind, number>> = {
  resolved: 10,
  "active-staged": 20,
  "bridge-acknowledged": 30,
  "provider-observed": 40,
  activated: 50,
  "registered-skill-md-read": 60,
  "subtree-read": 70,
};

export type ObservationStatus = "supported" | "unsupported" | "failure";
export type CoverageState = "observed" | "unsupported" | "unknown" | "pre-instrumentation";
export type MeasurementFamily = "content-footprint" | "context-occupancy" | "attributable-consumption";
export type ContentComponent = "catalog-entry" | "body" | "reference" | "asset";
export type MeasurementMethod =
  | "local-content-estimate"
  | "provider-reported-named-context-estimate"
  | "provider-attributable-consumption";

export interface SkillRevisionIdentity {
  skillId: string;
  name: string;
  skillMarkdownPath: string;
  sourceKind: string;
  sourceId: string;
  pluginId: string | null;
  catalogRevision: string;
  skillMarkdownRevision: string;
  treeRevision: string;
}

export interface ObservationGrain {
  observationId: string;
  sourceEventId: string;
  coverageEpochId: string;
  observedAtMs: number;
  sessionId: string;
  threadId: string;
  /** Deliberately present and nullable: session-scoped reports have no turn. */
  providerTurnId: string | null;
  principalId: string;
  /** Authoritative thread ownership, never inferred from the emitting actor. */
  projectId: string;
  /** A thread may deliberately have no environment. */
  environmentId: string | null;
  providerId: string;
  providerModel: string | null;
}

export interface LifecycleObservationFact extends ObservationGrain {
  factId: string;
  revision: SkillRevisionIdentity;
  evidenceKind: LifecycleEvidenceKind;
  status: ObservationStatus;
  /** Whether absence of activation is observable for this delivery unit. */
  activationObservability: CoverageState;
  captureTrigger: string;
  providerEventId: string | null;
  failure: string | null;
}

export interface MeasurementPartition {
  family: MeasurementFamily;
  method: MeasurementMethod;
  serializer: string;
  tokenizer: string;
  providerId: string;
  providerModel: string | null;
}

export interface SkillMeasurementFact extends ObservationGrain, MeasurementPartition {
  factId: string;
  revision: SkillRevisionIdentity;
  contentComponent: ContentComponent | null;
  /** Null is an unavailable value, never a numeric zero. */
  bytes: number | null;
  /** Null is an unavailable value, never a numeric zero. */
  tokens: number | null;
  status: ObservationStatus;
  estimated: boolean;
  rawObservationId: string | null;
}

export interface MeasurementSummary {
  count: number;
  mean: number | null;
  median: number | null;
  p95: number | null;
  minimum: number | null;
  maximum: number | null;
}

export interface ActivationSummary {
  eligibleUnits: number;
  activatedUnits: number;
  noActivationObservedUnits: number;
  activationRate: number | null;
  unsupportedUnits: number;
  unknownCoverageUnits: number;
  contributingFactIds: readonly string[];
}

export interface AnalyticsWindow {
  startMs: number;
  endMs: number;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}

export function deterministicSkillFactId(kind: string, value: unknown): string {
  if (!/^[a-z][a-z0-9-]*$/u.test(kind)) throw new Error("invalid skill fact kind");
  return `skillfact_v1_${createHash("sha256").update(`${kind}\n${canonical(value)}`).digest("hex")}`;
}

/** The identity used for joins, cohorts and raw-detail drilldown. */
export function revisionKey(revision: SkillRevisionIdentity): string {
  return canonical({
    skillId: revision.skillId,
    sourceKind: revision.sourceKind,
    sourceId: revision.sourceId,
    pluginId: revision.pluginId,
    skillMarkdownPath: revision.skillMarkdownPath,
    catalogRevision: revision.catalogRevision,
    skillMarkdownRevision: revision.skillMarkdownRevision,
    treeRevision: revision.treeRevision,
  });
}

export function evidencePrecedence(kind: LifecycleEvidenceKind): number {
  return lifecycleEvidencePrecedence[kind];
}

export function inWindow(observedAtMs: number, window: AnalyticsWindow): boolean {
  if (!Number.isSafeInteger(observedAtMs) || !Number.isSafeInteger(window.startMs) || !Number.isSafeInteger(window.endMs) || window.startMs > window.endMs) {
    throw new Error("invalid inclusive analytics window");
  }
  return observedAtMs >= window.startMs && observedAtMs <= window.endMs;
}

function deliveryUnit(fact: LifecycleObservationFact): string {
  return canonical({
    revision: revisionKey(fact.revision),
    coverageEpochId: fact.coverageEpochId,
    providerId: fact.providerId,
    sessionId: fact.sessionId,
    threadId: fact.threadId,
  });
}

/**
 * An activation denominator is a distinct supported active-staged delivery
 * unit in an epoch where activation absence is observable.  A provider that
 * cannot emit activation does not enter the denominator.
 */
export function summarizeActivation(
  observations: readonly LifecycleObservationFact[],
  window: AnalyticsWindow,
): ActivationSummary {
  const active = observations.filter((fact) =>
    fact.evidenceKind === "active-staged" && fact.status === "supported" && inWindow(fact.observedAtMs, window),
  );
  const activated = observations.filter((fact) =>
    fact.evidenceKind === "activated" && fact.status === "supported" && inWindow(fact.observedAtMs, window),
  );
  const units = new Map<string, LifecycleObservationFact>();
  let unsupportedUnits = 0;
  let unknownCoverageUnits = 0;
  for (const fact of active) {
    const key = deliveryUnit(fact);
    if (units.has(key)) continue;
    if (fact.activationObservability === "observed") units.set(key, fact);
    else if (fact.activationObservability === "unsupported") unsupportedUnits += 1;
    else unknownCoverageUnits += 1;
  }
  let activatedUnits = 0;
  const noActivationObservedFactIds: string[] = [];
  for (const [key, exposure] of units) {
    const observedActivation = activated.some((fact) =>
      deliveryUnit(fact) === key && fact.observedAtMs >= exposure.observedAtMs,
    );
    if (observedActivation) activatedUnits += 1;
    else noActivationObservedFactIds.push(exposure.factId);
  }
  const eligibleUnits = units.size;
  return {
    eligibleUnits,
    activatedUnits,
    noActivationObservedUnits: noActivationObservedFactIds.length,
    activationRate: eligibleUnits === 0 ? null : activatedUnits / eligibleUnits,
    unsupportedUnits,
    unknownCoverageUnits,
    contributingFactIds: [...units.values()].map((fact) => fact.factId).sort(),
  };
}

/** Uses the nearest-rank definition: sorted[ceil(.95 * n) - 1]. */
export function summarizeMeasuredValues(values: readonly (number | null)[]): MeasurementSummary {
  const known = values.filter((value): value is number => value !== null);
  if (known.some((value) => !Number.isFinite(value) || value < 0)) throw new Error("measurements must be finite nonnegative values or null");
  const sorted = [...known].sort((left, right) => left - right);
  const count = sorted.length;
  if (count === 0) return { count: 0, mean: null, median: null, p95: null, minimum: null, maximum: null };
  const middle = Math.floor(count / 2);
  const median = count % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
  return {
    count,
    mean: sorted.reduce((total, value) => total + value, 0) / count,
    median,
    p95: sorted[Math.ceil(0.95 * count) - 1]!,
    minimum: sorted[0]!,
    maximum: sorted[count - 1]!,
  };
}

/**
 * Reconciliation accepts one exact method partition only.  It returns raw row
 * identities, so every displayed total is reconstructable without allocation.
 */
export function reconcileMeasurementRows(
  rows: readonly SkillMeasurementFact[],
  value: "bytes" | "tokens",
): { total: number | null; contributingFactIds: readonly string[]; missingFactIds: readonly string[] } {
  if (rows.length === 0) return { total: null, contributingFactIds: [], missingFactIds: [] };
  const partition = canonical({ family: rows[0]!.family, method: rows[0]!.method, serializer: rows[0]!.serializer, tokenizer: rows[0]!.tokenizer, providerId: rows[0]!.providerId, providerModel: rows[0]!.providerModel });
  for (const row of rows) {
    const candidate = canonical({ family: row.family, method: row.method, serializer: row.serializer, tokenizer: row.tokenizer, providerId: row.providerId, providerModel: row.providerModel });
    if (candidate !== partition) throw new Error("measurement partitions must not be pooled");
  }
  const present = rows.filter((row) => row[value] !== null);
  const missing = rows.filter((row) => row[value] === null);
  return {
    total: present.length === 0 ? null : present.reduce((sum, row) => sum + (row[value] ?? 0), 0),
    contributingFactIds: present.map((row) => row.factId).sort(),
    missingFactIds: missing.map((row) => row.factId).sort(),
  };
}

/**
 * Fork-free public-SDK evidence contract. These rows intentionally describe
 * what the existing SDK exposes, rather than a provider's private skill
 * lifecycle. A current catalog snapshot is BB-visible at capture time only.
 */
export const FORK_FREE_SKILL_EVIDENCE_VERSION = 1 as const;

export type PublicSkillScope =
  | "bb-builtin"
  | "bb-user"
  | "bb-project"
  | "provider-user"
  | "provider-project"
  | "shared-user"
  | "shared-project"
  | "plugin";

export interface PublicSkillCatalogEntry {
  skillId: string;
  name: string;
  /** Nullable public sdk.skills.list provider field; null is meaningful. */
  provider: string | null;
  scope: PublicSkillScope;
  pluginId: string | null;
  /** The public sdk.skills.list path for this currently visible skill. */
  filePath: string;
  /** sdk.skills.getContent({ path: filePath }).revision, when captured. */
  contentRevision: string | null;
  /** UTF-8 bytes in the current getContent response; a footprint, not context. */
  contentBytes: number | null;
  /** Exact registered paths returned by listFiles, normalized under filePath. */
  registeredPaths: readonly string[];
  filesTruncated: boolean;
}

export interface PublicSkillCatalogSnapshot {
  version: typeof FORK_FREE_SKILL_EVIDENCE_VERSION;
  snapshotId: string;
  capturedAtMs: number;
  projectId: string;
  environmentId: string | null;
  source: "sdk.skills.list/getContent/listFiles";
  entries: readonly PublicSkillCatalogEntry[];
}

/** Public lifecycle hooks are post-transition; refresh is likewise current-only. */
export type PublicCatalogCaptureTrigger = "thread.created" | "thread.active" | "refresh";

export interface PublicSkillCatalogCapture {
  captureId: string;
  trigger: PublicCatalogCaptureTrigger;
  capturedAtMs: number;
  /** Complete is the only state that yields an exact, BB-visible catalog. */
  completeness: "complete" | "failed";
  error: string | null;
  snapshot: PublicSkillCatalogSnapshot | null;
}

export interface PublicThreadEvent {
  id: string;
  threadId: string;
  seq: number;
  createdAt: number;
  type: "client/turn/requested" | "item/started" | "item/completed" | "thread/context" | "thread/tokenUsage/updated";
  scope: { kind: "thread" | "turn"; turnId?: string };
  data: Record<string, unknown>;
}

export interface PromptMentionEvidence {
  kind: "prompt-mention";
  sourceEventId: string;
  threadId: string;
  seq: number;
  skillId: string;
  /** Exact prompt mention only: prompt text is never retained in this row. */
  mention: string;
  /** A current catalog name match never identifies the prompt-time revision. */
  historicalRevision: null;
}

export interface RegisteredPathCommandCandidate {
  kind: "registered-path-command-candidate";
  sourceStartedEventId: string;
  sourceCompletedEventId: string | null;
  threadId: string;
  startSeq: number;
  completedSeq: number | null;
  itemId: string;
  skillId: string;
  registeredPath: string;
  commandShellWrapped: boolean;
  commandJoined: boolean;
  executionStatus: "pending" | "completed" | "failed" | "declined" | "incomplete";
  exitCode: number | null;
  outputBytes: number | null;
  outputTruncated: boolean | null;
  /** Historical revision is unknown unless a snapshot was captured at that event. */
  historicalRevision: null;
}

export interface AggregateTokenEvidence {
  kind: "aggregate-token";
  sourceEventId: string;
  threadId: string;
  seq: number;
  aggregateTokens: number | null;
}

export interface PublicSkillEvidenceReplay {
  mentions: readonly PromptMentionEvidence[];
  candidates: readonly RegisteredPathCommandCandidate[];
  aggregateTokens: readonly AggregateTokenEvidence[];
  coverage: {
    catalog: "current-snapshot" | "missing";
    providerAccess: "observed-candidates-only" | "incomplete-or-unsupported";
    historicalCatalog: "revision-unknown";
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalPath(path: string): string {
  if (!path.startsWith("/") || path.includes("\0")) throw new Error("registered paths must be absolute and NUL-free");
  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) throw new Error("registered path escapes its root");
      segments.pop();
    } else segments.push(segment);
  }
  return `/${segments.join("/")}`;
}

function isContained(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

function skillRoot(skillMarkdownPath: string): string {
  const normalized = canonicalPath(skillMarkdownPath);
  const slash = normalized.lastIndexOf("/");
  if (slash <= 0) throw new Error("registered SKILL.md path has no skill root");
  return normalized.slice(0, slash);
}

/** Reject malformed catalogs, duplicate identities and private/staged sources. */
export function validatePublicSkillCatalogSnapshot(snapshot: PublicSkillCatalogSnapshot): PublicSkillCatalogSnapshot {
  if (snapshot.version !== FORK_FREE_SKILL_EVIDENCE_VERSION || snapshot.source !== "sdk.skills.list/getContent/listFiles") throw new Error("catalog must be an existing public SDK snapshot");
  if (!Number.isSafeInteger(snapshot.capturedAtMs) || snapshot.capturedAtMs < 0) throw new Error("invalid snapshot capture time");
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const entry of snapshot.entries) {
    if (!entry.skillId || ids.has(entry.skillId)) throw new Error("catalog skill identity conflict");
    if (entry.provider !== null && (typeof entry.provider !== "string" || entry.provider.length === 0)) throw new Error("invalid nullable public skill provider");
    ids.add(entry.skillId);
    const markdownPath = canonicalPath(entry.filePath);
    if (paths.has(markdownPath)) throw new Error("catalog registered-path conflict");
    paths.add(markdownPath);
    const root = skillRoot(markdownPath);
    for (const path of entry.registeredPaths) {
      const normalized = canonicalPath(path);
      if (!isContained(normalized, root)) throw new Error("registered path escapes its skill root");
      if (normalized !== markdownPath && paths.has(normalized)) throw new Error("catalog registered-path conflict");
      paths.add(normalized);
    }
    if (entry.filesTruncated) throw new Error("complete public catalog snapshots reject truncated file lists");
    if (entry.contentRevision !== null && !/^[a-f0-9]{64}$/u.test(entry.contentRevision)) throw new Error("invalid public content revision");
    if (entry.contentBytes !== null && (!Number.isSafeInteger(entry.contentBytes) || entry.contentBytes < 0)) throw new Error("invalid current content byte footprint");
    if ((entry.contentRevision === null) !== (entry.contentBytes === null)) throw new Error("public content revision and byte footprint are captured together");
  }
  return snapshot;
}

/** A failed public capture is coverage information, never an empty catalog. */
export function validatePublicSkillCatalogCapture(capture: PublicSkillCatalogCapture): PublicSkillCatalogCapture {
  if (!capture.captureId || !Number.isSafeInteger(capture.capturedAtMs) || capture.capturedAtMs < 0) throw new Error("invalid public catalog capture");
  if (capture.completeness === "complete") {
    if (capture.error !== null || capture.snapshot === null) throw new Error("complete catalog capture requires an error-free snapshot");
    validatePublicSkillCatalogSnapshot(capture.snapshot);
  } else if (capture.error === null || capture.snapshot !== null) {
    throw new Error("failed catalog capture retains an error and no catalog");
  }
  return capture;
}

function item(event: PublicThreadEvent): Record<string, unknown> | null {
  return isRecord(event.data.item) ? event.data.item : null;
}

function commandItem(event: PublicThreadEvent): Record<string, unknown> | null {
  const candidate = item(event);
  return candidate?.type === "commandExecution" && typeof candidate.id === "string" && typeof candidate.command === "string" ? candidate : null;
}

function eventKey(event: PublicThreadEvent): string {
  return `${event.threadId}\n${event.seq}`;
}

/**
 * Deterministic, fail-closed replay of retained public events. Exact duplicate
 * events are idempotent; conflicting event IDs or thread/sequence rows reject
 * the batch. A joined or shell-wrapped command is still only a lexical path
 * candidate, irrespective of its successful enclosing command completion.
 */
export function replayPublicSkillEvidence(
  snapshot: PublicSkillCatalogSnapshot | null,
  input: readonly PublicThreadEvent[],
): PublicSkillEvidenceReplay {
  if (snapshot !== null) validatePublicSkillCatalogSnapshot(snapshot);
  const byId = new Map<string, string>();
  const bySequence = new Map<string, string>();
  const events: PublicThreadEvent[] = [];
  for (const event of input) {
    if (!event.id || !event.threadId || !Number.isSafeInteger(event.seq) || event.seq < 1 || !Number.isSafeInteger(event.createdAt)) throw new Error("invalid public thread event");
    const encoded = canonical(event);
    const priorId = byId.get(event.id);
    const key = eventKey(event);
    const priorSequence = bySequence.get(key);
    if ((priorId !== undefined && priorId !== encoded) || (priorSequence !== undefined && priorSequence !== encoded)) throw new Error("conflicting public event replay");
    if (priorId === undefined) events.push(event);
    byId.set(event.id, encoded);
    bySequence.set(key, encoded);
  }
  events.sort((left, right) => left.threadId.localeCompare(right.threadId) || left.seq - right.seq || left.id.localeCompare(right.id));
  const mentions: PromptMentionEvidence[] = [];
  const aggregateTokens: AggregateTokenEvidence[] = [];
  const starts = new Map<string, PublicThreadEvent>();
  const candidatesByKey = new Map<string, RegisteredPathCommandCandidate>();
  const catalogPaths = snapshot === null ? [] : snapshot.entries.flatMap((entry) => {
    const paths = new Set([canonicalPath(entry.filePath), ...entry.registeredPaths.map(canonicalPath)]);
    return [...paths].map((path) => ({ skillId: entry.skillId, path }));
  });
  for (const event of events) {
    if (event.type === "client/turn/requested") {
      const inputRows = Array.isArray(event.data.input) ? event.data.input : [];
      for (const row of inputRows) {
        if (!isRecord(row)) continue;
        for (const mention of Array.isArray(row.mentions) ? row.mentions : []) {
          if (isRecord(mention) && typeof mention.skillId === "string" && typeof mention.name === "string") {
            mentions.push({ kind: "prompt-mention", sourceEventId: event.id, threadId: event.threadId, seq: event.seq, skillId: mention.skillId, mention: mention.name, historicalRevision: null });
          }
        }
        if (typeof row.text === "string" && snapshot !== null) {
          for (const entry of snapshot.entries) {
            const escapedName = entry.name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
            const pattern = new RegExp(`(^|[^A-Za-z0-9_-])\\$${escapedName}(?![A-Za-z0-9_-])`, "u");
            if (pattern.test(row.text)) mentions.push({ kind: "prompt-mention", sourceEventId: event.id, threadId: event.threadId, seq: event.seq, skillId: entry.skillId, mention: entry.name, historicalRevision: null });
          }
        }
      }
    }
    if (event.type === "item/started") {
      const started = commandItem(event);
      if (started !== null) {
        const key = `${event.threadId}\n${started.id}`;
        starts.set(key, event);
        const command = String(started.command);
        const shellWrapped = /\b(?:sh|bash|zsh|fish|pwsh|powershell)\b[^\n]*\s-(?:c|lc|Command)\b/u.test(command);
        const joined = /(?:&&|\|\||;|\n|\|)/u.test(command);
        for (const entry of catalogPaths.filter((candidate) => command.includes(candidate.path))) {
          const candidateKey = `${key}\n${entry.skillId}\n${entry.path}`;
          candidatesByKey.set(candidateKey, {
            kind: "registered-path-command-candidate", sourceStartedEventId: event.id, sourceCompletedEventId: null,
            threadId: event.threadId, startSeq: event.seq, completedSeq: null, itemId: String(started.id), skillId: entry.skillId,
            registeredPath: entry.path, commandShellWrapped: shellWrapped, commandJoined: joined, executionStatus: "pending",
            exitCode: null, outputBytes: null, outputTruncated: null, historicalRevision: null,
          });
        }
      }
    }
    if (event.type === "item/completed") {
      const completed = commandItem(event);
      if (completed === null) continue;
      const started = starts.get(`${event.threadId}\n${completed.id}`) ?? null;
      if (started === null) continue;
      for (const [candidateKey, candidate] of candidatesByKey) {
        if (!candidateKey.startsWith(`${event.threadId}\n${completed.id}\n`)) continue;
        const status = typeof completed.status === "string" && ["completed", "failed", "declined"].includes(completed.status) ? completed.status as RegisteredPathCommandCandidate["executionStatus"] : "incomplete";
        const output = typeof completed.aggregatedOutput === "string" ? Buffer.byteLength(completed.aggregatedOutput, "utf8") : null;
        const truncation = isRecord(completed.truncation) && typeof completed.truncation.truncated === "boolean" ? completed.truncation.truncated : null;
        candidatesByKey.set(candidateKey, { ...candidate, sourceCompletedEventId: event.id, completedSeq: event.seq, executionStatus: status, exitCode: typeof completed.exitCode === "number" ? completed.exitCode : null, outputBytes: output, outputTruncated: truncation });
      }
    }
    if (event.type === "thread/context" || event.type === "thread/tokenUsage/updated") {
      const tokens = typeof event.data.totalTokens === "number" ? event.data.totalTokens : null;
      aggregateTokens.push({ kind: "aggregate-token", sourceEventId: event.id, threadId: event.threadId, seq: event.seq, aggregateTokens: tokens });
    }
  }
  return {
    mentions: mentions.sort((a, b) => a.threadId.localeCompare(b.threadId) || a.seq - b.seq || a.skillId.localeCompare(b.skillId)),
    candidates: [...candidatesByKey.values()].sort((a, b) => a.threadId.localeCompare(b.threadId) || a.startSeq - b.startSeq || a.skillId.localeCompare(b.skillId) || a.registeredPath.localeCompare(b.registeredPath)),
    aggregateTokens: aggregateTokens.sort((a, b) => a.threadId.localeCompare(b.threadId) || a.seq - b.seq),
    coverage: { catalog: snapshot === null ? "missing" : "current-snapshot", providerAccess: snapshot === null || candidatesByKey.size === 0 ? "incomplete-or-unsupported" : "observed-candidates-only", historicalCatalog: "revision-unknown" },
  };
}
