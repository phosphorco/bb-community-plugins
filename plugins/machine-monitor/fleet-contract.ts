import { z } from "zod";

/**
 * Fleet data is persisted and exchanged using this contract, rather than the
 * current local-only sample shape.  Bump this only by adding a new explicit
 * versioned schema: history must always retain the version that produced it.
 */
export const FLEET_CONTRACT_VERSION = 1 as const;
/**
 * Timeline event producers are independently versioned from the enclosing
 * fleet contract. Version 1 is the only producer payload shape this reader
 * supports; accepting a newer producer version would silently misinterpret
 * producer-owned fields.
 */
export const TIMELINE_EVENT_PRODUCER_CONTRACT_VERSION = 1 as const;
export const LOCAL_BB_SERVER_MACHINE_ID = "local-bb-server";
export const MAX_FLEET_MACHINES = 256;
export const MAX_TIMELINE_BUCKETS = 720;
export const MAX_TIMELINE_EVENTS = 200;
export const MAX_TIMELINE_RANGE_MS = 30 * 24 * 60 * 60_000;
export const MAX_CLOCK_UNCERTAINTY_MS = 60 * 60_000;
export const MAX_TIMELINE_NORMALIZATION_SAMPLES = 1_000_000;

const MAX_SAFE_TIMESTAMP = Number.MAX_SAFE_INTEGER;
const controlCharacter = /\p{Cc}/u;
const opaqueIdSchema = (maxLength = 128) => z.string().min(1).max(maxLength)
  .refine((value) => value.trim().length > 0, "must not be blank")
  .refine((value) => !controlCharacter.test(value), "must not contain control characters");
const timestampSchema = z.number().int().min(0).max(MAX_SAFE_TIMESTAMP);
const revisionSchema = z.number().int().min(0).max(MAX_SAFE_TIMESTAMP);
const finiteNumberSchema = z.number().finite();
const nonnegativeFiniteNumberSchema = finiteNumberSchema.min(0);
const contractVersionSchema = z.literal(FLEET_CONTRACT_VERSION);

/**
 * The attachment snapshot is deliberately repeated here as a wire-only v1
 * schema.  `attachment-contract.ts` also owns projection canonicalization and
 * hashing, which is server work and imports node:crypto.  Fleet views only
 * consume the already-canonical RPC result, so this contract must remain safe
 * to load in the browser.
 */
export const FLEET_ATTACHMENT_SNAPSHOT_VERSION = 1 as const;
const MAX_FLEET_ATTACHMENT_TARGETS = 256;
const MAX_FLEET_ATTACHMENT_KEY_BYTES = 512;
const MAX_FLEET_ATTACHMENT_LABEL_BYTES = 256;
const MAX_FLEET_ATTACHMENT_DETAIL_BYTES = 1_024;
const MAX_FLEET_ATTACHMENT_URL_BYTES = 2_048;
const MAX_FLEET_ATTACHMENT_PRESENTATION_BYTES = 4 * 1_024;
const MAX_FLEET_ATTACHMENT_KEY_MATERIAL_BYTES = 8_192;
const MAX_FLEET_ATTACHMENT_IDENTITY_BYTES = 16 * 1_024;
const fleetAttachmentNamePattern = /^[a-z][a-z0-9._-]{0,63}$/;
const fleetAttachmentBbIdPattern = /^[A-Za-z0-9_-]{1,128}$/;
const fleetAttachmentEncoder = new TextEncoder();

function fleetAttachmentByteLength(value: string): number {
  return fleetAttachmentEncoder.encode(value).byteLength;
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function isFleetAttachmentText(value: string, maxBytes: number, nonblank = false): boolean {
  return isWellFormedUnicode(value)
    && !controlCharacter.test(value)
    && (!nonblank || value.trim().length > 0)
    && fleetAttachmentByteLength(value) <= maxBytes;
}

function addFleetAttachmentIssue(context: z.RefinementCtx, path: (string | number)[], message: string): void {
  context.addIssue({ code: "custom", path, message });
}

export const enrolledHostIdSchema = opaqueIdSchema(256).refine(
  (value) => value !== LOCAL_BB_SERVER_MACHINE_ID,
  "reserved for the local BB server",
);

/**
 * The local source and an enrolled daemon deliberately cannot serialize to
 * the same shape.  A coordinator obtains enrolled host IDs from BB's
 * authenticated host directory; it never accepts this identity from a host
 * response.
 */
export const machineIdentitySchema = z.discriminatedUnion("source", [
  z.object({
    source: z.literal("local-bb-server"),
    machineId: z.literal(LOCAL_BB_SERVER_MACHINE_ID),
  }).strict(),
  z.object({
    source: z.literal("enrolled-host"),
    machineId: enrolledHostIdSchema,
  }).strict(),
]);

export type FleetMachineIdentity = z.infer<typeof machineIdentitySchema>;

export function machineIdentityKey(machine: FleetMachineIdentity): string {
  return `${machine.source}:${machine.machineId}`;
}

export const metricUnitSchema = z.enum([
  "percent",
  "bytes",
  "count",
  "load",
  "pages-per-second",
  "bytes-per-second",
]);
export const metricSemanticsSchema = z.enum(["gauge", "counter"]);
export const metricAggregationSchema = z.enum(["min-average-max-last-count"]);
export const metricAvailabilitySchema = z.enum(["all-platforms", "linux-wsl-only", "capability-gated"]);
export const metricVisualizationHintSchema = z.enum(["line", "area", "step", "hidden"]);

const metricCatalogEntrySchema = z.object({
  id: opaqueIdSchema(96),
  label: z.string().min(1).max(96),
  unit: metricUnitSchema,
  semantics: metricSemanticsSchema,
  aggregation: metricAggregationSchema,
  availability: metricAvailabilitySchema,
  visualization: metricVisualizationHintSchema,
}).strict();

/**
 * This is the only metric namespace accepted at the fleet boundary.  Chart
 * consumers receive the small visualization hint, never arbitrary ECharts
 * options or server-provided renderer configuration.
 */
export const FLEET_METRIC_CATALOG = [
  { id: "cpu.utilization.percent", label: "CPU utilization", unit: "percent", semantics: "gauge", aggregation: "min-average-max-last-count", availability: "all-platforms", visualization: "line" },
  { id: "memory.used.bytes", label: "Memory used", unit: "bytes", semantics: "gauge", aggregation: "min-average-max-last-count", availability: "all-platforms", visualization: "area" },
  { id: "memory.total.bytes", label: "Memory total", unit: "bytes", semantics: "gauge", aggregation: "min-average-max-last-count", availability: "all-platforms", visualization: "hidden" },
  { id: "disk.root.used.bytes", label: "Root disk used", unit: "bytes", semantics: "gauge", aggregation: "min-average-max-last-count", availability: "all-platforms", visualization: "area" },
  { id: "disk.root.total.bytes", label: "Root disk total", unit: "bytes", semantics: "gauge", aggregation: "min-average-max-last-count", availability: "all-platforms", visualization: "hidden" },
  { id: "load.1", label: "Load average (1 minute)", unit: "load", semantics: "gauge", aggregation: "min-average-max-last-count", availability: "all-platforms", visualization: "line" },
  { id: "load.5", label: "Load average (5 minutes)", unit: "load", semantics: "gauge", aggregation: "min-average-max-last-count", availability: "all-platforms", visualization: "line" },
  { id: "memory.pressure.some.percent", label: "Memory pressure (some)", unit: "percent", semantics: "gauge", aggregation: "min-average-max-last-count", availability: "linux-wsl-only", visualization: "line" },
  { id: "memory.pressure.full.percent", label: "Memory pressure (full)", unit: "percent", semantics: "gauge", aggregation: "min-average-max-last-count", availability: "linux-wsl-only", visualization: "line" },
  { id: "memory.swap.in.pages-per-second", label: "Swap in", unit: "pages-per-second", semantics: "counter", aggregation: "min-average-max-last-count", availability: "linux-wsl-only", visualization: "step" },
  { id: "memory.swap.out.pages-per-second", label: "Swap out", unit: "pages-per-second", semantics: "counter", aggregation: "min-average-max-last-count", availability: "linux-wsl-only", visualization: "step" },
] as const satisfies readonly z.infer<typeof metricCatalogEntrySchema>[];

/** Every metric can disclose an independently missing range-start bucket. */
export const MAX_TIMELINE_GAPS = FLEET_METRIC_CATALOG.length * MAX_TIMELINE_BUCKETS;

export const metricIdSchema = z.enum([
  "cpu.utilization.percent",
  "memory.used.bytes",
  "memory.total.bytes",
  "disk.root.used.bytes",
  "disk.root.total.bytes",
  "load.1",
  "load.5",
  "memory.pressure.some.percent",
  "memory.pressure.full.percent",
  "memory.swap.in.pages-per-second",
  "memory.swap.out.pages-per-second",
]);
export type FleetMetricId = z.infer<typeof metricIdSchema>;

const metricOrder = new Map<string, number>(FLEET_METRIC_CATALOG.map((metric, index) => [metric.id, index]));

export function metricCatalogEntry(metricId: FleetMetricId): (typeof FLEET_METRIC_CATALOG)[number] {
  return FLEET_METRIC_CATALOG[metricOrder.get(metricId)!]!;
}

export const observedMetricAvailabilitySchema = z.object({
  state: z.enum(["available", "unavailable", "not-collected"]),
  reason: z.string().min(1).max(256).nullable(),
}).strict();

export const metricObservationSchema = z.object({
  metricId: metricIdSchema,
  value: nonnegativeFiniteNumberSchema.nullable(),
  availability: observedMetricAvailabilitySchema,
}).strict().superRefine((value, context) => {
  const hasValue = value.value != null;
  if (hasValue !== (value.availability.state === "available")) {
    context.addIssue({
      code: "custom",
      message: "an available metric must have a value, and an unavailable metric must not",
      path: ["value"],
    });
  }
  if (value.availability.state === "available" && value.availability.reason != null) {
    context.addIssue({ code: "custom", message: "an available metric has no unavailability reason", path: ["availability", "reason"] });
  }
});

function enforceUniqueMetricObservations(values: readonly { metricId: string }[], context: z.RefinementCtx, path: string): void {
  const seen = new Set<string>();
  let previousOrder = -1;
  for (const [index, value] of values.entries()) {
    if (seen.has(value.metricId)) context.addIssue({ code: "custom", message: "metric IDs must be unique", path: [path, index, "metricId"] });
    const order = metricOrder.get(value.metricId)!;
    if (order <= previousOrder) context.addIssue({ code: "custom", message: "metric IDs must follow catalog order", path: [path, index, "metricId"] });
    seen.add(value.metricId);
    previousOrder = order;
  }
}

/** A machine-reported observation contains no machine identity. */
export const hostCollectionPayloadSchema = z.object({
  contractVersion: contractVersionSchema,
  collectorSessionId: opaqueIdSchema(128),
  sequence: revisionSchema,
  hostObservedAtMs: timestampSchema,
  metrics: z.array(metricObservationSchema).max(FLEET_METRIC_CATALOG.length),
}).strict().superRefine((value, context) => enforceUniqueMetricObservations(value.metrics, context, "metrics"));

/** Timing values observed by the central BB server while it calls a host. */
export const serverCollectionTimingSchema = z.object({
  serverSentAtMs: timestampSchema,
  serverReceivedAtMs: timestampSchema,
  normalizedAtMs: timestampSchema,
  clockUncertaintyMs: timestampSchema.max(MAX_CLOCK_UNCERTAINTY_MS),
}).strict().superRefine((value, context) => {
  if (value.serverReceivedAtMs < value.serverSentAtMs) {
    context.addIssue({ code: "custom", message: "serverReceivedAtMs must not precede serverSentAtMs", path: ["serverReceivedAtMs"] });
  }
});

/**
 * The server creates this envelope by binding a host payload to an identity
 * selected from its own local source or authenticated host directory.
 */
export const collectionEnvelopeSchema = z.object({
  machine: machineIdentitySchema,
  ...hostCollectionPayloadSchema.shape,
  ...serverCollectionTimingSchema.shape,
}).strict().superRefine((value, context) => {
  enforceUniqueMetricObservations(value.metrics, context, "metrics");
  if (value.serverReceivedAtMs < value.serverSentAtMs) {
    context.addIssue({ code: "custom", message: "serverReceivedAtMs must not precede serverSentAtMs", path: ["serverReceivedAtMs"] });
  }
});
export type FleetCollectionEnvelope = z.infer<typeof collectionEnvelopeSchema>;

export function bindCollectionToMachine(
  machine: FleetMachineIdentity,
  hostPayload: z.infer<typeof hostCollectionPayloadSchema>,
  serverTiming: z.infer<typeof serverCollectionTimingSchema>,
): FleetCollectionEnvelope {
  return collectionEnvelopeSchema.parse({ machine, ...hostPayload, ...serverTiming });
}

export const timelineRangeSchema = z.object({
  startMs: timestampSchema,
  endMs: timestampSchema,
}).strict().superRefine((value, context) => {
  if (value.endMs <= value.startMs) context.addIssue({ code: "custom", message: "endMs must be after startMs", path: ["endMs"] });
  if (value.endMs - value.startMs > MAX_TIMELINE_RANGE_MS) {
    context.addIssue({ code: "custom", message: `range may not exceed ${MAX_TIMELINE_RANGE_MS}ms`, path: ["endMs"] });
  }
});

/** Two independent revisions make timeline cache generation deterministic. */
export const timelineGenerationSchema = z.object({
  dataRevision: revisionSchema,
  settingsRevision: revisionSchema,
}).strict();
export type TimelineGeneration = z.infer<typeof timelineGenerationSchema>;

/** Bounded realtime payload published after one machine's committed change. */
export const fleetInvalidationSignalSchema = z.object({
  machine: machineIdentitySchema,
  dataRevision: revisionSchema,
  settingsRevision: revisionSchema,
  kinds: z.array(z.enum([
    "machine",
    "collection",
    "directory",
    "memory",
    "error",
    "settings",
    "retention",
  ])).min(1).max(7).superRefine((kinds, context) => {
    if (new Set(kinds).size !== kinds.length) {
      context.addIssue({ code: "custom", message: "kinds must not contain duplicates" });
    }
  }),
}).strict();
export type FleetInvalidationSignal = z.infer<typeof fleetInvalidationSignalSchema>;

export function timelineGenerationKey(generation: TimelineGeneration): string {
  return `d${generation.dataRevision}:s${generation.settingsRevision}`;
}

export const timelineBucketMetadataSchema = z.object({
  alignment: z.literal("range-start"),
  widthMs: z.number().int().positive().max(MAX_TIMELINE_RANGE_MS),
  count: z.number().int().min(1).max(MAX_TIMELINE_BUCKETS),
}).strict();

export const timelineCoverageSchema = z.object({
  state: z.enum(["complete", "partial", "empty"]),
  firstObservedAtMs: timestampSchema.nullable(),
  lastObservedAtMs: timestampSchema.nullable(),
  retainedFromMs: timestampSchema.nullable(),
  retainedToMs: timestampSchema.nullable(),
}).strict().superRefine((value, context) => {
  if (value.state === "empty" && (value.firstObservedAtMs != null || value.lastObservedAtMs != null)) {
    context.addIssue({ code: "custom", message: "empty coverage cannot contain observations", path: ["firstObservedAtMs"] });
  }
  if (value.firstObservedAtMs != null && value.lastObservedAtMs != null && value.lastObservedAtMs < value.firstObservedAtMs) {
    context.addIssue({ code: "custom", message: "lastObservedAtMs must not precede firstObservedAtMs", path: ["lastObservedAtMs"] });
  }
});

export const timelineTimeNormalizationBasisSchema = z.enum([
  "remote-server-request-midpoint",
  "local-observation",
  "legacy-local-observation",
]);

const timelineTimestampRangeSchema = z.object({
  firstMs: timestampSchema.nullable(),
  lastMs: timestampSchema.nullable(),
}).strict().superRefine((value, context) => {
  if ((value.firstMs == null) !== (value.lastMs == null)) {
    context.addIssue({ code: "custom", message: "time ranges must provide both endpoints or neither", path: ["firstMs"] });
  }
  if (value.firstMs != null && value.lastMs != null && value.lastMs < value.firstMs) {
    context.addIssue({ code: "custom", message: "lastMs must not precede firstMs", path: ["lastMs"] });
  }
});

/**
 * Raw host timestamps are retained exactly, even when their clock is skewed;
 * only the paired normalized range is restricted to the requested timeline.
 */
export const timelineTimeNormalizationSchema = z.object({
  basis: timelineTimeNormalizationBasisSchema,
  sampleCount: z.number().int().min(0).max(MAX_TIMELINE_NORMALIZATION_SAMPLES),
  rawHostObservedRange: timelineTimestampRangeSchema,
  normalizedRange: timelineTimestampRangeSchema,
  maxClockUncertaintyMs: timestampSchema.max(MAX_CLOCK_UNCERTAINTY_MS).nullable(),
}).strict().superRefine((value, context) => {
  const rawPresent = value.rawHostObservedRange.firstMs != null;
  const normalizedPresent = value.normalizedRange.firstMs != null;
  if (value.sampleCount === 0 && (rawPresent || normalizedPresent || value.maxClockUncertaintyMs != null)) {
    context.addIssue({ code: "custom", message: "an empty normalization summary cannot contain time or uncertainty values", path: ["sampleCount"] });
  }
  if (value.sampleCount > 0 && (!rawPresent || !normalizedPresent || value.maxClockUncertaintyMs == null)) {
    context.addIssue({ code: "custom", message: "a non-empty normalization summary requires raw, normalized, and uncertainty values", path: ["sampleCount"] });
  }
  if (value.basis !== "remote-server-request-midpoint" && value.maxClockUncertaintyMs != null && value.maxClockUncertaintyMs !== 0) {
    context.addIssue({ code: "custom", message: "local observations must report zero clock uncertainty", path: ["maxClockUncertaintyMs"] });
  }
});

export const metricBucketSchema = z.object({
  startMs: timestampSchema,
  endMs: timestampSchema,
  min: nonnegativeFiniteNumberSchema.nullable(),
  average: nonnegativeFiniteNumberSchema.nullable(),
  max: nonnegativeFiniteNumberSchema.nullable(),
  last: nonnegativeFiniteNumberSchema.nullable(),
  count: z.number().int().min(0).max(MAX_SAFE_TIMESTAMP),
}).strict().superRefine((value, context) => {
  if (value.endMs <= value.startMs) context.addIssue({ code: "custom", message: "bucket end must follow its start", path: ["endMs"] });
  const statistics = [value.min, value.average, value.max, value.last];
  if (value.count === 0 && statistics.some((statistic) => statistic != null)) {
    context.addIssue({ code: "custom", message: "empty buckets must use null statistics", path: ["count"] });
  }
  if (value.count > 0 && statistics.some((statistic) => statistic == null)) {
    context.addIssue({ code: "custom", message: "non-empty buckets require min, average, max, and last", path: ["count"] });
  }
  if (value.min != null && value.average != null && value.max != null && value.last != null
    && (value.min > value.average || value.average > value.max || value.last < value.min || value.last > value.max)) {
    context.addIssue({ code: "custom", message: "bucket statistics must preserve min/average/max/last ordering", path: ["average"] });
  }
});

export const timelineMetricSeriesSchema = z.object({
  metricId: metricIdSchema,
  availability: observedMetricAvailabilitySchema,
  buckets: z.array(metricBucketSchema).min(1).max(MAX_TIMELINE_BUCKETS),
}).strict();

export const timelineGapSchema = z.object({
  metricId: metricIdSchema,
  startMs: timestampSchema,
  endMs: timestampSchema,
  reason: z.enum(["no-samples", "collector-error", "host-offline", "unavailable", "retention"]),
}).strict().superRefine((value, context) => {
  if (value.endMs <= value.startMs) context.addIssue({ code: "custom", message: "gap end must follow its start", path: ["endMs"] });
});

export const bbProjectThreadReferenceSchema = z.object({
  projectId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  threadId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
}).strict();

export const timelineEventProducerVersionSchema = z.number().int().positive().max(1_000_000)
  .refine(
    (version): boolean => version === TIMELINE_EVENT_PRODUCER_CONTRACT_VERSION,
    `only timeline event producer contract version ${TIMELINE_EVENT_PRODUCER_CONTRACT_VERSION} is supported`,
  );

export const timelineEventProducerSchema = z.object({
  id: opaqueIdSchema(128),
  version: timelineEventProducerVersionSchema,
}).strict();

export const timelineEventProvenanceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("collection"), collectorSessionId: opaqueIdSchema(128), sequence: revisionSchema }).strict(),
  z.object({ kind: z.literal("bb-background-job"), jobId: opaqueIdSchema(128), attempt: z.number().int().min(0).max(1_000_000) }).strict(),
  z.object({ kind: z.literal("system"), component: opaqueIdSchema(128) }).strict(),
  z.object({ kind: z.literal("operator"), action: opaqueIdSchema(128) }).strict(),
]);

export const timelineEventTimeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("instant"), atMs: timestampSchema }).strict(),
  z.object({ kind: z.literal("interval"), startMs: timestampSchema, endMs: timestampSchema }).strict()
    .superRefine((value, context) => {
      if (value.endMs < value.startMs) context.addIssue({ code: "custom", message: "interval end must not precede its start", path: ["endMs"] });
    }),
]);

export const timelineEventSchema = z.object({
  contractVersion: contractVersionSchema,
  producer: timelineEventProducerSchema,
  eventId: opaqueIdSchema(128),
  time: timelineEventTimeSchema,
  category: z.enum(["collection", "machine-health", "bb-job", "deployment", "operator", "unknown"]),
  status: z.enum(["info", "started", "running", "succeeded", "failed", "cancelled", "warning", "unknown"]),
  title: z.string().min(1).max(256),
  detail: z.string().max(1_024).nullable(),
  provenance: timelineEventProvenanceSchema,
  bbReference: bbProjectThreadReferenceSchema.nullable(),
}).strict();

export const timelineEventLaneSchema = z.object({
  events: z.array(timelineEventSchema).max(MAX_TIMELINE_EVENTS),
  totalCount: z.number().int().min(0).max(MAX_SAFE_TIMESTAMP),
  truncated: z.boolean(),
}).strict().superRefine((value, context) => {
  if (value.totalCount < value.events.length) context.addIssue({ code: "custom", message: "totalCount cannot be less than returned events", path: ["totalCount"] });
  if (!value.truncated && value.totalCount !== value.events.length) context.addIssue({ code: "custom", message: "an untruncated event lane must be complete", path: ["truncated"] });
  const identities = new Set<string>();
  let previousKey: string | null = null;
  for (const [index, event] of value.events.entries()) {
    const eventAt = event.time.kind === "instant" ? event.time.atMs : event.time.startMs;
    const identity = `${event.producer.id}\u0000${event.eventId}`;
    if (identities.has(identity)) context.addIssue({ code: "custom", message: "event producer/event identity must be unique", path: ["events", index, "eventId"] });
    identities.add(identity);
    const key = `${String(eventAt).padStart(16, "0")}\u0000${event.producer.id}\u0000${event.eventId}`;
    if (previousKey != null && key <= previousKey) context.addIssue({ code: "custom", message: "events must be deterministically ordered by time, producer, and event ID", path: ["events", index] });
    previousKey = key;
  }
});

function machineSortCheck(machines: readonly { machine: FleetMachineIdentity }[], context: z.RefinementCtx, path: string): void {
  let previousKey: string | null = null;
  for (const [index, machine] of machines.entries()) {
    const key = machineIdentityKey(machine.machine);
    if (previousKey != null && key <= previousKey) context.addIssue({ code: "custom", message: "machines must be unique and sorted by identity", path: [path, index, "machine"] });
    previousKey = key;
  }
}

export const fleetMachineWarningSchema = z.object({
  kind: z.enum(["disconnected", "stale", "collector-error", "metric-threshold", "unsupported-capability"]),
  message: z.string().min(1).max(256),
  metricId: metricIdSchema.nullable(),
}).strict();

export const fleetMachineOverviewSchema = z.object({
  machine: machineIdentitySchema,
  label: z.string().min(1).max(256),
  connection: z.enum(["local", "connected", "disconnected", "unknown"]),
  freshness: z.enum(["fresh", "stale", "unknown"]),
  latestCollectedAtMs: timestampSchema.nullable(),
  lastError: z.string().max(1_024).nullable(),
  capabilities: z.array(opaqueIdSchema(96)).max(32),
  latestMetrics: z.array(metricObservationSchema).max(FLEET_METRIC_CATALOG.length),
  warnings: z.array(fleetMachineWarningSchema).max(32),
  generation: timelineGenerationSchema,
}).strict().superRefine((value, context) => enforceUniqueMetricObservations(value.latestMetrics, context, "latestMetrics"));

const fleetAttachmentPresentationSchema = z.object({
  label: z.string().max(MAX_FLEET_ATTACHMENT_LABEL_BYTES),
  detail: z.string().max(MAX_FLEET_ATTACHMENT_DETAIL_BYTES).optional(),
  url: z.string().max(MAX_FLEET_ATTACHMENT_URL_BYTES).optional(),
}).strict();

const fleetAttachmentResourceSchema = z.object({
  provider: z.string().max(64),
  keys: z.record(z.string().max(64), z.string().max(MAX_FLEET_ATTACHMENT_KEY_BYTES)),
  presentation: fleetAttachmentPresentationSchema,
}).strict().superRefine((resource, context) => {
  if (!fleetAttachmentNamePattern.test(resource.provider)) {
    addFleetAttachmentIssue(context, ["provider"], "has an invalid name");
  }

  const keys = Object.keys(resource.keys);
  if (keys.length < 1 || keys.length > 32) {
    addFleetAttachmentIssue(context, ["keys"], "must contain between 1 and 32 entries");
  }
  let materialBytes = 0;
  for (const key of keys) {
    const value = resource.keys[key]!;
    if (!fleetAttachmentNamePattern.test(key)) {
      addFleetAttachmentIssue(context, ["keys", key], "has an invalid name");
    }
    if (value !== value.normalize("NFC") || !isFleetAttachmentText(value, MAX_FLEET_ATTACHMENT_KEY_BYTES, true)) {
      addFleetAttachmentIssue(context, ["keys", key], "must be canonical, nonblank safe text");
    }
    materialBytes += fleetAttachmentByteLength(key) + fleetAttachmentByteLength(value);
  }
  if (materialBytes > MAX_FLEET_ATTACHMENT_KEY_MATERIAL_BYTES) {
    addFleetAttachmentIssue(context, ["keys"], "key/value material is too large");
  }

  if (resource.provider === "bb") {
    const sorted = [...keys].sort();
    const isBbId = (value: string | undefined) => value != null && fleetAttachmentBbIdPattern.test(value);
    const isProject = sorted.length === 1 && sorted[0] === "project" && isBbId(resource.keys.project);
    const isThread = sorted.length === 2 && sorted[0] === "project" && sorted[1] === "thread"
      && isBbId(resource.keys.project) && isBbId(resource.keys.thread);
    const isMachineMonitor = sorted.length === 2 && sorted[0] === "page" && sorted[1] === "plugin"
      && resource.keys.page === "machine-monitor" && resource.keys.plugin === "machine-monitor";
    if (!isProject && !isThread && !isMachineMonitor) {
      addFleetAttachmentIssue(context, ["keys"], "must use a v1 BB identity");
    }
  }

  const identityJson = JSON.stringify({ provider: resource.provider, keys: resource.keys });
  if (fleetAttachmentByteLength(identityJson) > MAX_FLEET_ATTACHMENT_IDENTITY_BYTES) {
    addFleetAttachmentIssue(context, [], "identity is too large");
  }

  const { presentation } = resource;
  if (!isFleetAttachmentText(presentation.label, MAX_FLEET_ATTACHMENT_LABEL_BYTES, true)) {
    addFleetAttachmentIssue(context, ["presentation", "label"], "must be nonblank safe text");
  }
  if (presentation.detail !== undefined && !isFleetAttachmentText(presentation.detail, MAX_FLEET_ATTACHMENT_DETAIL_BYTES, true)) {
    addFleetAttachmentIssue(context, ["presentation", "detail"], "must be nonblank safe text");
  }
  if (presentation.url !== undefined) {
    const url = presentation.url;
    const isRoute = url.startsWith("/") && !url.startsWith("//") && !url.includes("\\");
    let isHttpUrl = false;
    if (url.startsWith("http://") || url.startsWith("https://")) {
      try {
        const parsed = new URL(url);
        isHttpUrl = parsed.protocol === "http:" || parsed.protocol === "https:";
      } catch {
        isHttpUrl = false;
      }
    }
    if (!isFleetAttachmentText(url, MAX_FLEET_ATTACHMENT_URL_BYTES, true) || (!isRoute && !isHttpUrl)) {
      addFleetAttachmentIssue(context, ["presentation", "url"], "must be a safe same-origin or http(s) URL");
    }
  }
  if (fleetAttachmentByteLength(JSON.stringify(presentation)) > MAX_FLEET_ATTACHMENT_PRESENTATION_BYTES) {
    addFleetAttachmentIssue(context, ["presentation"], "is too large");
  }
});

/** Browser-safe, frozen Cross References v1 getAttachments output. */
export const fleetAttachmentSnapshotSchema = z.object({
  sourceRevision: z.number().int().nonnegative(),
  targets: z.array(fleetAttachmentResourceSchema).max(MAX_FLEET_ATTACHMENT_TARGETS),
  status: z.object({
    state: z.enum(["synced", "pending", "degraded", "blocked"]),
    sourceRevision: z.number().int().nonnegative(),
    desiredRevision: z.number().int().nonnegative(),
    lastAckedRevision: z.number().int().nonnegative(),
    pending: z.boolean(),
    inFlight: z.boolean(),
    attempts: z.number().int().nonnegative(),
    nextAttemptAt: z.number().int().nonnegative().nullable(),
    lastError: z.string().nullable(),
    errorKind: z.enum(["absent", "transient", "incompatible", "blocked"]).nullable(),
  }).strict(),
}).strict();

/** Existing manual Linked threads are one fleet-level snapshot, never events. */
export const fleetAttachmentStateSchema = z.object({
  scope: z.literal("fleet"),
  snapshot: fleetAttachmentSnapshotSchema,
}).strict();

export const fleetOverviewRequestSchema = z.object({
  contractVersion: contractVersionSchema,
}).strict();

export const fleetOverviewResultSchema = z.object({
  contractVersion: contractVersionSchema,
  generatedAtMs: timestampSchema,
  generation: timelineGenerationSchema,
  machines: z.array(fleetMachineOverviewSchema).max(MAX_FLEET_MACHINES),
  attachments: fleetAttachmentStateSchema,
}).strict().superRefine((value, context) => machineSortCheck(value.machines, context, "machines"));

export const machineTimelineRequestSchema = z.object({
  contractVersion: contractVersionSchema,
  machine: machineIdentitySchema,
  range: timelineRangeSchema,
  /** null means the caller has no cached generation yet. */
  generation: timelineGenerationSchema.nullable(),
}).strict();
export type MachineTimelineRequest = z.infer<typeof machineTimelineRequestSchema>;

export function machineTimelineRequestKey(request: MachineTimelineRequest): string {
  const input = machineTimelineRequestSchema.parse(request);
  const generation = input.generation == null ? "none" : timelineGenerationKey(input.generation);
  return [FLEET_CONTRACT_VERSION, machineIdentityKey(input.machine), input.range.startMs, input.range.endMs, generation].join("|");
}

export const machineTimelineResultSchema = z.object({
  contractVersion: contractVersionSchema,
  machine: machineIdentitySchema,
  generation: timelineGenerationSchema,
  range: timelineRangeSchema,
  bucket: timelineBucketMetadataSchema,
  coverage: timelineCoverageSchema,
  timeNormalization: timelineTimeNormalizationSchema,
  metrics: z.array(timelineMetricSeriesSchema).max(FLEET_METRIC_CATALOG.length),
  gaps: z.array(timelineGapSchema).max(MAX_TIMELINE_GAPS),
  events: timelineEventLaneSchema,
}).strict().superRefine((value, context) => {
  if (Math.ceil((value.range.endMs - value.range.startMs) / value.bucket.widthMs) !== value.bucket.count) {
    context.addIssue({ code: "custom", message: "bucket width and count must cover the requested range deterministically", path: ["bucket"] });
  }
  if (value.coverage.firstObservedAtMs != null
    && (value.coverage.firstObservedAtMs < value.range.startMs || value.coverage.firstObservedAtMs > value.range.endMs)) {
    context.addIssue({ code: "custom", message: "first observed time must remain inside the requested range", path: ["coverage", "firstObservedAtMs"] });
  }
  if (value.coverage.lastObservedAtMs != null
    && (value.coverage.lastObservedAtMs < value.range.startMs || value.coverage.lastObservedAtMs > value.range.endMs)) {
    context.addIssue({ code: "custom", message: "last observed time must remain inside the requested range", path: ["coverage", "lastObservedAtMs"] });
  }
  const normalized = value.timeNormalization.normalizedRange;
  if (normalized.firstMs != null && normalized.lastMs != null
    && (normalized.firstMs < value.range.startMs || normalized.lastMs > value.range.endMs)) {
    context.addIssue({ code: "custom", message: "normalized coverage must remain inside the requested range", path: ["timeNormalization", "normalizedRange"] });
  }
  if (value.coverage.state === "empty" && value.timeNormalization.sampleCount !== 0) {
    context.addIssue({ code: "custom", message: "empty coverage requires an empty normalization summary", path: ["timeNormalization", "sampleCount"] });
  }
  if (value.coverage.state !== "empty" && value.timeNormalization.sampleCount === 0) {
    context.addIssue({ code: "custom", message: "non-empty coverage requires normalized samples", path: ["timeNormalization", "sampleCount"] });
  }
  if (value.timeNormalization.sampleCount > 0
    && (value.coverage.firstObservedAtMs !== normalized.firstMs || value.coverage.lastObservedAtMs !== normalized.lastMs)) {
    context.addIssue({ code: "custom", message: "coverage endpoints must match normalized observation endpoints", path: ["coverage"] });
  }
  if (value.machine.source === "enrolled-host" && value.timeNormalization.basis !== "remote-server-request-midpoint") {
    context.addIssue({ code: "custom", message: "enrolled hosts require server midpoint normalization", path: ["timeNormalization", "basis"] });
  }
  if (value.machine.source === "local-bb-server" && value.timeNormalization.basis === "remote-server-request-midpoint") {
    context.addIssue({ code: "custom", message: "the local BB server cannot use remote normalization", path: ["timeNormalization", "basis"] });
  }
  let previousMetricOrder = -1;
  for (const [seriesIndex, series] of value.metrics.entries()) {
    const order = metricOrder.get(series.metricId)!;
    if (order <= previousMetricOrder) context.addIssue({ code: "custom", message: "metric series must be unique and follow catalog order", path: ["metrics", seriesIndex, "metricId"] });
    previousMetricOrder = order;
    if (series.buckets.length !== value.bucket.count) {
      context.addIssue({ code: "custom", message: "each metric series must contain every deterministic bucket", path: ["metrics", seriesIndex, "buckets"] });
    }
    for (const [bucketIndex, bucket] of series.buckets.entries()) {
      const expectedStartMs = value.range.startMs + bucketIndex * value.bucket.widthMs;
      const expectedEndMs = Math.min(value.range.endMs, expectedStartMs + value.bucket.widthMs);
      if (bucket.startMs < value.range.startMs || bucket.endMs > value.range.endMs) {
        context.addIssue({ code: "custom", message: "bucket must remain inside the requested range", path: ["metrics", seriesIndex, "buckets", bucketIndex] });
      }
      if (bucket.startMs !== expectedStartMs || bucket.endMs !== expectedEndMs) {
        context.addIssue({ code: "custom", message: "bucket edges must follow the range-start alignment and width", path: ["metrics", seriesIndex, "buckets", bucketIndex] });
      }
      if (bucketIndex > 0 && bucket.startMs !== series.buckets[bucketIndex - 1]!.endMs) {
        context.addIssue({ code: "custom", message: "buckets must be contiguous and ordered", path: ["metrics", seriesIndex, "buckets", bucketIndex, "startMs"] });
      }
    }
  }
  let previousGapKey: string | null = null;
  for (const [gapIndex, gap] of value.gaps.entries()) {
    if (gap.startMs < value.range.startMs || gap.endMs > value.range.endMs) context.addIssue({ code: "custom", message: "gap must remain inside the requested range", path: ["gaps", gapIndex] });
    const key = `${String(gap.startMs).padStart(16, "0")}\u0000${gap.metricId}\u0000${String(gap.endMs).padStart(16, "0")}`;
    if (previousGapKey != null && key <= previousGapKey) context.addIssue({ code: "custom", message: "gaps must be deterministically ordered", path: ["gaps", gapIndex] });
    previousGapKey = key;
  }
  for (const [eventIndex, event] of value.events.events.entries()) {
    if (event.time.kind === "instant") {
      if (event.time.atMs < value.range.startMs || event.time.atMs > value.range.endMs) {
        context.addIssue({ code: "custom", message: "instant events must remain inside the requested range", path: ["events", "events", eventIndex, "time"] });
      }
    } else if (event.time.endMs < value.range.startMs || event.time.startMs > value.range.endMs) {
      context.addIssue({ code: "custom", message: "interval events must overlap the requested range", path: ["events", "events", eventIndex, "time"] });
    }
  }
});

export type FleetOverviewResult = z.infer<typeof fleetOverviewResultSchema>;
export type MachineTimelineResult = z.infer<typeof machineTimelineResultSchema>;
