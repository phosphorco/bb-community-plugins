import type Database from "better-sqlite3";

import type { AttachmentSnapshot } from "./attachment-contract.ts";
import {
  FLEET_CONTRACT_VERSION,
  FLEET_METRIC_CATALOG,
  MAX_FLEET_MACHINES,
  MAX_MACHINE_DIRECTORY_SUMMARIES,
  MAX_TIMELINE_BUCKETS,
  MAX_TIMELINE_GAPS,
  fleetOverviewRequestSchema,
  fleetOverviewResultSchema,
  machineIdentityKey,
  machineInventoryRequestSchema,
  machineInventoryResultSchema,
  machineTimelineRequestSchema,
  machineTimelineResultSchema,
  metricObservationSchema,
  type FleetMachineIdentity,
  type FleetMetricId,
  type FleetOverviewResult,
  type MachineTimelineRequest,
  type MachineTimelineResult,
  type MachineInventoryResult,
  type TimelineGeneration,
} from "./fleet-contract.ts";
import { FleetStore, type FleetMachineState } from "./fleet-store.ts";
import {
  FleetCache,
  fleetTimelineCacheKey,
  type FleetCacheInvalidationKind,
  type FleetCacheOptions,
} from "./fleet-cache.ts";
import { MONITORED_DIRECTORIES, SAMPLE_INTERVAL_MS } from "./monitor.ts";

/** A source is stale after two expected core-collection intervals. */
export const FLEET_FRESH_AFTER_MS = SAMPLE_INTERVAL_MS * 2;
const CPU_ROLLING_WINDOW_MS = 5 * 60_000;
const MAX_OVERVIEW_GENERATION_ATTEMPTS = 3;

export type FleetWarningThresholds = Readonly<{
  cpu: number;
  ram: number;
  disk: number;
}>;

/** Server composition supplies its settings here; absent settings never alert. */
export type FleetWarningThresholdProvider = () =>
  | FleetWarningThresholds
  | null
  | undefined
  | Promise<FleetWarningThresholds | null | undefined>;

export type TimelineQueryOptions = Readonly<{
  cache?: FleetCache;
  cacheOptions?: FleetCacheOptions;
  now?: () => number;
  /** Attachments remain a fleet-scoped, SQLite-backed snapshot. */
  attachmentSnapshot?: () => AttachmentSnapshot;
  /** Kept at the server boundary so reads never reach through FleetStore. */
  warningThresholds?: FleetWarningThresholdProvider;
}>;

export type TimelineQueryRowCounts = Readonly<{
  /** At most one row per declared metric/range bucket. */
  metricBucketRows: number;
  /** At most one latest availability row per declared metric. */
  latestAvailabilityRows: number;
  /** Exactly one aggregate row, rather than one collection per sample. */
  normalizationRows: number;
  /** Distinct bucket indexes, capped by the requested bucket count. */
  errorBucketRows: number;
}>;

export type TimelineSqlRead = Readonly<{
  metricBuckets: readonly Readonly<{
    metricId: FleetMetricId;
    bucketIndex: number;
    min: number | null;
    average: number | null;
    max: number | null;
    last: number | null;
    count: number;
    hasUnavailable: boolean;
  }>[];
  latestAvailability: readonly Readonly<{
    metricId: FleetMetricId;
    availability: MachineTimelineResult["metrics"][number]["availability"];
  }>[];
  normalization: Readonly<{
    sampleCount: number;
    rawFirstMs: number | null;
    rawLastMs: number | null;
    normalizedFirstMs: number | null;
    normalizedLastMs: number | null;
    maxClockUncertaintyMs: number | null;
    hasCurrentLocalCollection: boolean;
  }>;
  errorBucketIndexes: readonly number[];
  /** One latest/first aggregate pair per retained monitored directory. */
  directories?: readonly Readonly<{
    id: string;
    bytes: number;
    firstBytes: number;
    collectedAtMs: number;
    firstCollectedAtMs: number;
    partial: boolean;
    onRootFilesystem: boolean;
  }>[];
  rowCounts: TimelineQueryRowCounts;
}>;

export type TimelineOverviewSqlRead = Readonly<{
  /** Exact metric rows from each machine's one newest collection. */
  latestMetrics: ReadonlyMap<string, readonly ReturnType<typeof metricObservationSchema.parse>[]>;
  /** One five-minute normalized-time CPU average per machine, or null. */
  cpuFiveMinuteAverages: ReadonlyMap<string, number | null>;
}>;

/**
 * Deliberately narrow read boundary for the shared central SQLite database.
 * It exposes only bounded, set-based projections; it does not leak FleetStore
 * internals or any host/daemon capability to a read path.
 */
export interface TimelineQuerySource {
  readMachineTimeline(input: Readonly<{
    machine: FleetMachineIdentity;
    range: Readonly<{ startMs: number; endMs: number }>;
    bucketWidthMs: number;
    bucketCount: number;
  }>): TimelineSqlRead;
  /** `nowMs` is the server timestamp used for both generatedAt and CPU windows. */
  readFleetOverview(nowMs: number): TimelineOverviewSqlRead;
}

type MetricBucketRow = {
  metricId: FleetMetricId;
  bucketIndex: number;
  min: number | null;
  average: number | null;
  max: number | null;
  last: number | null;
  count: number;
  hasUnavailable: number;
};

type LatestAvailabilityRow = {
  metricId: FleetMetricId;
  availabilityState: "available" | "unavailable" | "not-collected";
  availabilityReason: string | null;
};

type NormalizationRow = {
  sampleCount: number;
  rawFirstMs: number | null;
  rawLastMs: number | null;
  normalizedFirstMs: number | null;
  normalizedLastMs: number | null;
  maxClockUncertaintyMs: number | null;
  hasCurrentLocalCollection: number | null;
};

type ErrorBucketRow = { bucketIndex: number };

type DirectorySummaryRow = {
  id: string;
  bytes: number;
  firstBytes: number;
  collectedAtMs: number;
  firstCollectedAtMs: number;
  partial: number;
  onRootFilesystem: number;
};

type OverviewMetricRow = LatestAvailabilityRow & {
  machineSource: "local-bb-server" | "enrolled-host";
  machineId: string;
  value: number | null;
  cpuFiveMinuteAverage: number | null;
};

/** Core leaves these four Linux/WSL metrics for the independent memory lane. */
const CORE_MEMORY_PLACEHOLDER_REASON = "Collected by the Linux memory diagnostics lane.";

/**
 * This remains entirely in SQLite: four fixed catalog rows per retained
 * memory observation, rather than process payload hydration or a JS unpivot.
 */
const MEMORY_OBSERVATIONS_CTE = `
  memory_observations AS (
    SELECT collector_session_id, sequence, host_observed_at, server_sent_at,
      server_received_at, normalized_at, clock_uncertainty_ms,
      pressure_some_percent, pressure_full_percent, swap_in_pages_per_second,
      swap_out_pages_per_second
    FROM machine_monitor_fleet_memory_observations
    WHERE machine_source = @machineSource AND machine_id = @machineId
      AND normalized_at BETWEEN @startMs AND @endMs
  )
`;

const NORMALIZED_METRIC_VALUES_CTE = `
  normalized_metric_values AS (
    SELECT metric_id, normalized_at, collector_session_id, sequence, value,
      availability_state, availability_reason
    FROM machine_monitor_fleet_metric_values
    WHERE machine_source = @machineSource AND machine_id = @machineId
      AND normalized_at BETWEEN @startMs AND @endMs
      AND NOT (
        metric_id IN ('memory.pressure.some.percent', 'memory.pressure.full.percent',
          'memory.swap.in.pages-per-second', 'memory.swap.out.pages-per-second')
        AND availability_state = 'not-collected'
        AND availability_reason = '${CORE_MEMORY_PLACEHOLDER_REASON}'
      )
    UNION ALL SELECT 'memory.pressure.some.percent', normalized_at, collector_session_id, sequence,
      pressure_some_percent,
      CASE WHEN pressure_some_percent IS NULL THEN 'not-collected' ELSE 'available' END,
      CASE WHEN pressure_some_percent IS NULL THEN 'Memory diagnostics has not produced a pressure-some value yet.' ELSE NULL END
    FROM memory_observations
    UNION ALL SELECT 'memory.pressure.full.percent', normalized_at, collector_session_id, sequence,
      pressure_full_percent,
      CASE WHEN pressure_full_percent IS NULL THEN 'not-collected' ELSE 'available' END,
      CASE WHEN pressure_full_percent IS NULL THEN 'Memory diagnostics has not produced a pressure-full value yet.' ELSE NULL END
    FROM memory_observations
    UNION ALL SELECT 'memory.swap.in.pages-per-second', normalized_at, collector_session_id, sequence,
      swap_in_pages_per_second,
      CASE WHEN swap_in_pages_per_second IS NULL THEN 'not-collected' ELSE 'available' END,
      CASE WHEN swap_in_pages_per_second IS NULL THEN 'Memory diagnostics is warming up swap-in rate collection.' ELSE NULL END
    FROM memory_observations
    UNION ALL SELECT 'memory.swap.out.pages-per-second', normalized_at, collector_session_id, sequence,
      swap_out_pages_per_second,
      CASE WHEN swap_out_pages_per_second IS NULL THEN 'not-collected' ELSE 'available' END,
      CASE WHEN swap_out_pages_per_second IS NULL THEN 'Memory diagnostics is warming up swap-out rate collection.' ELSE NULL END
    FROM memory_observations
  )
`;

const METRIC_BUCKETS_SQL = `
  WITH ${MEMORY_OBSERVATIONS_CTE}, ${NORMALIZED_METRIC_VALUES_CTE}, filtered AS (
    SELECT metric_id,
      CASE WHEN normalized_at = @endMs THEN @lastBucketIndex
        ELSE CAST((normalized_at - @startMs) / @bucketWidthMs AS INTEGER) END AS bucket_index,
      normalized_at, collector_session_id, sequence, value, availability_state
    FROM normalized_metric_values
  ), bucket_statistics AS (
    SELECT metric_id, bucket_index,
      MIN(value) AS min,
      AVG(value) AS average,
      MAX(value) AS max,
      COUNT(value) AS count,
      MAX(CASE WHEN availability_state = 'unavailable' THEN 1 ELSE 0 END) AS has_unavailable
    FROM filtered
    GROUP BY metric_id, bucket_index
  ), last_values AS (
    SELECT metric_id, bucket_index, value AS last FROM (
      SELECT metric_id, bucket_index, value,
        ROW_NUMBER() OVER (
          PARTITION BY metric_id, bucket_index
          ORDER BY normalized_at DESC, collector_session_id DESC, sequence DESC
        ) AS rank
      FROM filtered
      WHERE value IS NOT NULL
    ) WHERE rank = 1
  )
  SELECT statistics.metric_id AS metricId, statistics.bucket_index AS bucketIndex,
    statistics.min, statistics.average, statistics.max, last_values.last,
    statistics.count, statistics.has_unavailable AS hasUnavailable
  FROM bucket_statistics statistics
  LEFT JOIN last_values ON last_values.metric_id = statistics.metric_id
    AND last_values.bucket_index = statistics.bucket_index
  ORDER BY statistics.metric_id ASC, statistics.bucket_index ASC
`;

const LATEST_AVAILABILITY_SQL = `
  WITH ${MEMORY_OBSERVATIONS_CTE}, ${NORMALIZED_METRIC_VALUES_CTE}, ranked AS (
    SELECT metric_id AS metricId, availability_state AS availabilityState,
      availability_reason AS availabilityReason,
      ROW_NUMBER() OVER (
        PARTITION BY metric_id
        ORDER BY normalized_at DESC, collector_session_id DESC, sequence DESC
      ) AS rank
    FROM normalized_metric_values
  )
  SELECT metricId, availabilityState, availabilityReason
  FROM ranked WHERE rank = 1 ORDER BY metricId ASC
`;

const NORMALIZATION_SQL = `
  WITH observations AS (
    SELECT host_observed_at, normalized_at, clock_uncertainty_ms,
      CASE WHEN collector_session_id NOT LIKE 'legacy-%' THEN 1 ELSE 0 END AS isCurrent
    FROM machine_monitor_fleet_collections
    WHERE machine_source = @machineSource AND machine_id = @machineId
      AND normalized_at BETWEEN @startMs AND @endMs
    UNION ALL SELECT host_observed_at, normalized_at, clock_uncertainty_ms, 1
    FROM machine_monitor_fleet_memory_observations
    WHERE machine_source = @machineSource AND machine_id = @machineId
      AND normalized_at BETWEEN @startMs AND @endMs
  )
  SELECT COUNT(*) AS sampleCount,
    MIN(host_observed_at) AS rawFirstMs,
    MAX(host_observed_at) AS rawLastMs,
    MIN(normalized_at) AS normalizedFirstMs,
    MAX(normalized_at) AS normalizedLastMs,
    MAX(clock_uncertainty_ms) AS maxClockUncertaintyMs,
    MAX(isCurrent) AS hasCurrentLocalCollection
  FROM observations
`;

const ERROR_BUCKETS_SQL = `
  SELECT CASE WHEN occurred_at = @endMs THEN @lastBucketIndex
      ELSE CAST((occurred_at - @startMs) / @bucketWidthMs AS INTEGER) END AS bucketIndex
  FROM machine_monitor_fleet_errors
  WHERE machine_source = @machineSource AND machine_id = @machineId
    AND occurred_at BETWEEN @startMs AND @endMs
  GROUP BY bucketIndex
  ORDER BY bucketIndex ASC
`;

/**
 * The directory lane has its own cadence, so this is intentionally separate
 * from metric buckets. SQLite selects exactly the first and newest retained
 * observation for each location in the requested range; no raw directory
 * history is hydrated into JavaScript.
 */
const DIRECTORY_SUMMARIES_SQL = `
  WITH ranked AS (
    SELECT location AS id, bytes, collected_at AS collectedAtMs,
      partial, on_root_filesystem AS onRootFilesystem,
      ROW_NUMBER() OVER (PARTITION BY location ORDER BY collected_at DESC) AS newestRank,
      ROW_NUMBER() OVER (PARTITION BY location ORDER BY collected_at ASC) AS firstRank
    FROM machine_monitor_fleet_directory_details
    WHERE machine_source = @machineSource AND machine_id = @machineId
      AND collected_at BETWEEN @startMs AND @endMs
  ), newest AS (
    SELECT id, bytes, collectedAtMs, partial, onRootFilesystem
    FROM ranked WHERE newestRank = 1
  ), first AS (
    SELECT id, bytes AS firstBytes, collectedAtMs AS firstCollectedAtMs
    FROM ranked WHERE firstRank = 1
  )
  SELECT newest.id, newest.bytes, first.firstBytes,
    newest.collectedAtMs, first.firstCollectedAtMs,
    newest.partial, newest.onRootFilesystem
  FROM newest JOIN first ON first.id = newest.id
  ORDER BY newest.id ASC
`;

const OVERVIEW_LATEST_METRICS_SQL = `
  WITH latest_collections AS (
    SELECT machine.machine_source, machine.machine_id,
      collection.collector_session_id, collection.sequence, collection.normalized_at
    FROM machine_monitor_fleet_machines machine
    JOIN machine_monitor_fleet_collections collection ON collection.rowid = (
      SELECT candidate.rowid
      FROM machine_monitor_fleet_collections candidate
      WHERE candidate.machine_source = machine.machine_source
        AND candidate.machine_id = machine.machine_id
      ORDER BY candidate.normalized_at DESC, candidate.collector_session_id DESC, candidate.sequence DESC
      LIMIT 1
    )
  ), latest_memory_observations AS (
    SELECT machine.machine_source, machine.machine_id,
      observation.collector_session_id, observation.sequence, observation.normalized_at,
      observation.pressure_some_percent, observation.pressure_full_percent,
      observation.swap_in_pages_per_second, observation.swap_out_pages_per_second
    FROM machine_monitor_fleet_machines machine
    JOIN machine_monitor_fleet_memory_observations observation ON observation.rowid = (
      SELECT candidate.rowid
      FROM machine_monitor_fleet_memory_observations candidate
      WHERE candidate.machine_source = machine.machine_source
        AND candidate.machine_id = machine.machine_id
      ORDER BY candidate.normalized_at DESC, candidate.collector_session_id DESC, candidate.sequence DESC
      LIMIT 1
    )
  ), recent_cpu AS (
    SELECT latest.machine_source, latest.machine_id,
      AVG(cpu.value) AS cpuFiveMinuteAverage
    FROM latest_collections latest
    JOIN machine_monitor_fleet_collections recent
      ON recent.machine_source = latest.machine_source
      AND recent.machine_id = latest.machine_id
      AND recent.normalized_at BETWEEN @overviewNowMs - ${CPU_ROLLING_WINDOW_MS} AND @overviewNowMs
    JOIN machine_monitor_fleet_metric_values cpu
      ON cpu.machine_source = recent.machine_source
      AND cpu.machine_id = recent.machine_id
      AND cpu.collector_session_id = recent.collector_session_id
      AND cpu.sequence = recent.sequence
      AND cpu.metric_id = 'cpu.utilization.percent'
      AND cpu.availability_state = 'available'
    GROUP BY latest.machine_source, latest.machine_id
  ), core_metrics AS (
    SELECT latest.machine_source, latest.machine_id, metric.metric_id,
      metric.value, metric.availability_state, metric.availability_reason
    FROM latest_collections latest
    JOIN machine_monitor_fleet_metric_values metric
      ON metric.machine_source = latest.machine_source
      AND metric.machine_id = latest.machine_id
      AND metric.collector_session_id = latest.collector_session_id
      AND metric.sequence = latest.sequence
    WHERE NOT (
      metric.metric_id IN ('memory.pressure.some.percent', 'memory.pressure.full.percent',
        'memory.swap.in.pages-per-second', 'memory.swap.out.pages-per-second')
      AND (
        (metric.availability_state = 'not-collected'
          AND metric.availability_reason = '${CORE_MEMORY_PLACEHOLDER_REASON}')
        OR EXISTS (
          SELECT 1 FROM latest_memory_observations memory
          WHERE memory.machine_source = latest.machine_source
            AND memory.machine_id = latest.machine_id
        )
      )
    )
  ), memory_metrics AS (
    SELECT machine_source, machine_id, 'memory.pressure.some.percent' AS metric_id,
      pressure_some_percent AS value,
      CASE WHEN pressure_some_percent IS NULL THEN 'not-collected' ELSE 'available' END AS availability_state,
      CASE WHEN pressure_some_percent IS NULL THEN 'Memory diagnostics has not produced a pressure-some value yet.' ELSE NULL END AS availability_reason
    FROM latest_memory_observations
    UNION ALL SELECT machine_source, machine_id, 'memory.pressure.full.percent', pressure_full_percent,
      CASE WHEN pressure_full_percent IS NULL THEN 'not-collected' ELSE 'available' END,
      CASE WHEN pressure_full_percent IS NULL THEN 'Memory diagnostics has not produced a pressure-full value yet.' ELSE NULL END
    FROM latest_memory_observations
    UNION ALL SELECT machine_source, machine_id, 'memory.swap.in.pages-per-second', swap_in_pages_per_second,
      CASE WHEN swap_in_pages_per_second IS NULL THEN 'not-collected' ELSE 'available' END,
      CASE WHEN swap_in_pages_per_second IS NULL THEN 'Memory diagnostics is warming up swap-in rate collection.' ELSE NULL END
    FROM latest_memory_observations
    UNION ALL SELECT machine_source, machine_id, 'memory.swap.out.pages-per-second', swap_out_pages_per_second,
      CASE WHEN swap_out_pages_per_second IS NULL THEN 'not-collected' ELSE 'available' END,
      CASE WHEN swap_out_pages_per_second IS NULL THEN 'Memory diagnostics is warming up swap-out rate collection.' ELSE NULL END
    FROM latest_memory_observations
  )
  SELECT metric.machine_source AS machineSource, metric.machine_id AS machineId,
    metric.metric_id AS metricId, metric.value,
    metric.availability_state AS availabilityState,
    metric.availability_reason AS availabilityReason,
    recent_cpu.cpuFiveMinuteAverage
  FROM core_metrics metric
  LEFT JOIN recent_cpu
    ON recent_cpu.machine_source = metric.machine_source
    AND recent_cpu.machine_id = metric.machine_id
  UNION ALL
  SELECT metric.machine_source AS machineSource, metric.machine_id AS machineId,
    metric.metric_id AS metricId, metric.value,
    metric.availability_state AS availabilityState,
    metric.availability_reason AS availabilityReason,
    recent_cpu.cpuFiveMinuteAverage
  FROM memory_metrics metric
  LEFT JOIN recent_cpu
    ON recent_cpu.machine_source = metric.machine_source
    AND recent_cpu.machine_id = metric.machine_id
  ORDER BY machineSource ASC, machineId ASC, metricId ASC
`;

type QueryPlanRow = { detail: string };

/**
 * The production source takes the shared plugin SQLite handle explicitly.
 * Future RPC/server composition passes its context database here, avoiding a
 * raw history hydration through FleetStore for every uncached detail switch.
 */
export class SqliteTimelineQuerySource implements TimelineQuerySource {
  private readonly db: Database.Database;
  private lastRead: TimelineQueryRowCounts = {
    metricBucketRows: 0,
    latestAvailabilityRows: 0,
    normalizationRows: 0,
    errorBucketRows: 0,
  };
  private lastOverviewMetrics = 0;

  constructor(db: Database.Database) {
    this.db = db;
  }

  get lastTimelineRead(): TimelineQueryRowCounts {
    return this.lastRead;
  }

  get lastOverviewMetricRows(): number {
    return this.lastOverviewMetrics;
  }

  /** Regression-only structural seam; ordinary overview reads never run EXPLAIN. */
  get overviewQueryPlan(): readonly string[] {
    return (this.db.prepare(`EXPLAIN QUERY PLAN ${OVERVIEW_LATEST_METRICS_SQL}`).all({ overviewNowMs: 0 }) as QueryPlanRow[])
      .map((row) => row.detail);
  }

  readMachineTimeline(input: Parameters<TimelineQuerySource["readMachineTimeline"]>[0]): TimelineSqlRead {
    const { machine, range, bucketWidthMs, bucketCount } = input;
    const params = {
      machineSource: machine.source,
      machineId: machine.machineId,
      startMs: range.startMs,
      endMs: range.endMs,
      bucketWidthMs,
      lastBucketIndex: bucketCount - 1,
    };
    const metricBuckets = this.db.prepare(METRIC_BUCKETS_SQL).all(params) as MetricBucketRow[];
    const latestRows = this.db.prepare(LATEST_AVAILABILITY_SQL).all(params) as LatestAvailabilityRow[];
    const normalization = this.db.prepare(NORMALIZATION_SQL).get(params) as NormalizationRow | undefined;
    const errorBuckets = this.db.prepare(ERROR_BUCKETS_SQL).all(params) as ErrorBucketRow[];
    const directories = this.db.prepare(DIRECTORY_SUMMARIES_SQL).all(params) as DirectorySummaryRow[];
    if (normalization == null) throw new Error("Fleet timeline normalization aggregate is unavailable.");
    if (metricBuckets.length > FLEET_METRIC_CATALOG.length * bucketCount
      || latestRows.length > FLEET_METRIC_CATALOG.length
      || errorBuckets.length > bucketCount
      || directories.length > MAX_MACHINE_DIRECTORY_SUMMARIES) throw new Error("Fleet timeline query exceeded its bounded result contract.");
    for (const row of metricBuckets) {
      if (!Number.isSafeInteger(row.bucketIndex) || row.bucketIndex < 0 || row.bucketIndex >= bucketCount) {
        throw new Error("Fleet timeline query returned an invalid range-start bucket.");
      }
    }
    const latestAvailability = latestRows.map((row) => ({
      metricId: row.metricId,
      availability: metricObservationSchema.parse({
        metricId: row.metricId,
        value: row.availabilityState === "available" ? 0 : null,
        availability: { state: row.availabilityState, reason: row.availabilityReason },
      }).availability,
    }));
    this.lastRead = {
      metricBucketRows: metricBuckets.length,
      latestAvailabilityRows: latestAvailability.length,
      normalizationRows: 1,
      errorBucketRows: errorBuckets.length,
    };
    return {
      metricBuckets: metricBuckets.map((row) => ({ ...row, hasUnavailable: row.hasUnavailable === 1 })),
      latestAvailability,
      normalization: {
        sampleCount: normalization.sampleCount,
        rawFirstMs: normalization.rawFirstMs,
        rawLastMs: normalization.rawLastMs,
        normalizedFirstMs: normalization.normalizedFirstMs,
        normalizedLastMs: normalization.normalizedLastMs,
        maxClockUncertaintyMs: normalization.maxClockUncertaintyMs,
        hasCurrentLocalCollection: normalization.hasCurrentLocalCollection === 1,
      },
      errorBucketIndexes: errorBuckets.map((row) => row.bucketIndex),
      directories: directories.map((row) => ({
        ...row,
        partial: row.partial === 1,
        onRootFilesystem: row.onRootFilesystem === 1,
      })),
      rowCounts: this.lastRead,
    };
  }

  readFleetOverview(nowMs: number): TimelineOverviewSqlRead {
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error("Fleet overview now must be a nonnegative safe integer.");
    const rows = this.db.prepare(OVERVIEW_LATEST_METRICS_SQL).all({ overviewNowMs: nowMs }) as OverviewMetricRow[];
    if (rows.length > MAX_FLEET_MACHINES * FLEET_METRIC_CATALOG.length) {
      throw new Error("Fleet overview latest-metric query exceeded its bounded result contract.");
    }
    const byMachine = new Map<string, ReturnType<typeof metricObservationSchema.parse>[]>();
    const cpuFiveMinuteAverages = new Map<string, number | null>();
    for (const row of rows) {
      const key = `${row.machineSource}:${row.machineId}`;
      if (!cpuFiveMinuteAverages.has(key)) cpuFiveMinuteAverages.set(key, row.cpuFiveMinuteAverage);
      const metrics = byMachine.get(key);
      const metric = metricObservationSchema.parse({
        metricId: row.metricId,
        value: row.value,
        availability: { state: row.availabilityState, reason: row.availabilityReason },
      });
      if (metrics == null) byMachine.set(key, [metric]);
      else metrics.push(metric);
    }
    for (const metrics of byMachine.values()) {
      metrics.sort((left, right) => FLEET_METRIC_CATALOG.findIndex((entry) => entry.id === left.metricId)
        - FLEET_METRIC_CATALOG.findIndex((entry) => entry.id === right.metricId));
    }
    this.lastOverviewMetrics = rows.length;
    return { latestMetrics: byMachine, cpuFiveMinuteAverages };
  }
}

type TimelineCoverage = MachineTimelineResult["coverage"];
type TimelineGap = MachineTimelineResult["gaps"][number];

const EMPTY_ATTACHMENTS: AttachmentSnapshot = {
  sourceRevision: 0,
  targets: [],
  status: {
    state: "synced",
    sourceRevision: 0,
    desiredRevision: 0,
    lastAckedRevision: 0,
    pending: false,
    inFlight: false,
    attempts: 0,
    nextAttemptAt: null,
    lastError: null,
    errorKind: null,
  },
};

function safeNow(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Timeline query clock must return a nonnegative safe integer.");
  return value;
}

function sameGeneration(left: TimelineGeneration, right: TimelineGeneration): boolean {
  return left.dataRevision === right.dataRevision && left.settingsRevision === right.settingsRevision;
}

/** Keep the declared core sample grain at short ranges, then expand deterministically. */
export function timelineBucketWidthMs(range: Readonly<{ startMs: number; endMs: number }>): number {
  const duration = range.endMs - range.startMs;
  if (!Number.isSafeInteger(duration) || duration < 1) throw new Error("Timeline range must have a positive safe-integer duration.");
  return Math.max(SAMPLE_INTERVAL_MS, Math.ceil(duration / MAX_TIMELINE_BUCKETS / 1_000) * 1_000);
}

function bucketCount(range: Readonly<{ startMs: number; endMs: number }>, widthMs: number): number {
  return Math.ceil((range.endMs - range.startMs) / widthMs);
}

function emptyBucket(startMs: number, endMs: number) {
  return { startMs, endMs, min: null, average: null, max: null, last: null, count: 0 };
}

function defaultMetricAvailability() {
  return { state: "not-collected" as const, reason: "No retained observation for this metric." };
}

function summarizeCoverage(
  range: Readonly<{ startMs: number; endMs: number }>,
  widthMs: number,
  normalization: TimelineSqlRead["normalization"],
): TimelineCoverage {
  if (normalization.sampleCount === 0) {
    return { state: "empty", firstObservedAtMs: null, lastObservedAtMs: null, retainedFromMs: null, retainedToMs: null };
  }
  const firstObservedAtMs = normalization.normalizedFirstMs;
  const lastObservedAtMs = normalization.normalizedLastMs;
  if (firstObservedAtMs == null || lastObservedAtMs == null) throw new Error("Non-empty fleet timeline lacks normalized coverage.");
  const complete = firstObservedAtMs <= range.startMs + widthMs && lastObservedAtMs >= range.endMs - widthMs;
  return {
    state: complete ? "complete" : "partial",
    firstObservedAtMs,
    lastObservedAtMs,
    retainedFromMs: complete ? range.startMs : firstObservedAtMs,
    retainedToMs: complete ? range.endMs : lastObservedAtMs,
  };
}

function normalizationSummary(machine: FleetMachineIdentity, normalization: TimelineSqlRead["normalization"]) {
  const basis = machine.source === "enrolled-host"
    ? "remote-server-request-midpoint" as const
    : normalization.hasCurrentLocalCollection ? "local-observation" as const : "legacy-local-observation" as const;
  if (normalization.sampleCount === 0) {
    return {
      basis,
      sampleCount: 0,
      rawHostObservedRange: { firstMs: null, lastMs: null },
      normalizedRange: { firstMs: null, lastMs: null },
      maxClockUncertaintyMs: null,
    };
  }
  if (normalization.rawFirstMs == null || normalization.rawLastMs == null
    || normalization.normalizedFirstMs == null || normalization.normalizedLastMs == null
    || normalization.maxClockUncertaintyMs == null) throw new Error("Non-empty fleet timeline lacks normalization facts.");
  return {
    basis,
    sampleCount: normalization.sampleCount,
    rawHostObservedRange: { firstMs: normalization.rawFirstMs, lastMs: normalization.rawLastMs },
    normalizedRange: { firstMs: normalization.normalizedFirstMs, lastMs: normalization.normalizedLastMs },
    maxClockUncertaintyMs: basis === "remote-server-request-midpoint" ? normalization.maxClockUncertaintyMs : 0,
  };
}

function warningText(value: string, limit = 256): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

function validWarningThresholds(value: FleetWarningThresholds | null | undefined): FleetWarningThresholds | null {
  if (value == null) return null;
  const thresholds = [value.cpu, value.ram, value.disk];
  return thresholds.every((threshold) => Number.isFinite(threshold) && threshold >= 0 && threshold <= 100)
    ? value
    : null;
}

function availableMetricValue(
  metrics: readonly ReturnType<typeof metricObservationSchema.parse>[],
  metricId: FleetMetricId,
): number | null {
  const metric = metrics.find((candidate) => candidate.metricId === metricId);
  return metric?.availability.state === "available" ? metric.value : null;
}

function metricPercentage(used: number | null, total: number | null): number | null {
  if (used == null || total == null || !Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return null;
  const percentage = used / total * 100;
  return Number.isFinite(percentage) ? percentage : null;
}

const DIRECTORY_PRESENTATION = new Map<string, Readonly<{ label: string; parentId?: string }>>(
  MONITORED_DIRECTORIES.map((directory) => [directory.id, { label: directory.label, parentId: "parentId" in directory ? directory.parentId : undefined }]),
);

function directoryLabel(id: string): string {
  const known = DIRECTORY_PRESENTATION.get(id);
  if (known != null) return known.label;
  // The configured server path is deliberately never treated as a host-side
  // fact in a fleet result. It remains inspectable through the owner-managed
  // settings surface, while this dashboard names the bounded measurement.
  return id.startsWith("configured-") ? "Configured directory" : id;
}

function directoryParentId(id: string): string | null {
  return DIRECTORY_PRESENTATION.get(id)?.parentId ?? null;
}

function summarizeDirectories(rows: NonNullable<TimelineSqlRead["directories"]>): NonNullable<MachineTimelineResult["directories"]> {
  const byId = new Map(rows.map((row) => [row.id, row]));
  return rows.map((row) => {
    const children = rows.filter((candidate) => directoryParentId(candidate.id) === row.id);
    const childBytes = children.reduce((total, child) => total + child.bytes, 0);
    const childFirstBytes = children.reduce((total, child) => total + child.firstBytes, 0);
    const bytes = Math.max(0, row.bytes - childBytes);
    const firstBytes = Math.max(0, row.firstBytes - childFirstBytes);
    const durationMs = row.collectedAtMs - row.firstCollectedAtMs;
    return {
      id: row.id,
      label: directoryLabel(row.id),
      bytes,
      growthBytesPerDay: durationMs > 0 ? (bytes - firstBytes) / durationMs * 86_400_000 : null,
      derived: children.length > 0,
      partial: row.partial || children.some((child) => child.partial),
      onRootFilesystem: row.onRootFilesystem,
    };
  }).filter((entry) => byId.has(entry.id));
}

function metricThresholdWarnings(
  thresholds: FleetWarningThresholds | null,
  cpuFiveMinuteAverage: number | null,
  latestMetrics: readonly ReturnType<typeof metricObservationSchema.parse>[],
): FleetOverviewResult["machines"][number]["warnings"] {
  if (thresholds == null) return [];
  const warnings: FleetOverviewResult["machines"][number]["warnings"] = [];
  if (cpuFiveMinuteAverage != null && Number.isFinite(cpuFiveMinuteAverage) && cpuFiveMinuteAverage >= thresholds.cpu) {
    warnings.push({
      kind: "metric-threshold",
      metricId: "cpu.utilization.percent",
      message: `CPU 5m average ${cpuFiveMinuteAverage.toFixed(0)}% (threshold ${thresholds.cpu.toFixed(0)}%)`,
    });
  }
  const ram = metricPercentage(
    availableMetricValue(latestMetrics, "memory.used.bytes"),
    availableMetricValue(latestMetrics, "memory.total.bytes"),
  );
  if (ram != null && ram >= thresholds.ram) {
    warnings.push({
      kind: "metric-threshold",
      metricId: "memory.used.bytes",
      message: `RAM ${ram.toFixed(0)}% (threshold ${thresholds.ram.toFixed(0)}%)`,
    });
  }
  const disk = metricPercentage(
    availableMetricValue(latestMetrics, "disk.root.used.bytes"),
    availableMetricValue(latestMetrics, "disk.root.total.bytes"),
  );
  if (disk != null && disk >= thresholds.disk) {
    warnings.push({
      kind: "metric-threshold",
      metricId: "disk.root.used.bytes",
      message: `Root disk ${disk.toFixed(0)}% (threshold ${thresholds.disk.toFixed(0)}%)`,
    });
  }
  return warnings;
}

function overviewFreshness(machine: FleetMachineState | null, now: number): "fresh" | "stale" | "unknown" {
  if (machine == null || machine.latestCollectedAtMs == null) return "unknown";
  if (machine.connection === "disconnected") return "stale";
  return machine.latestCollectedAtMs >= now - FLEET_FRESH_AFTER_MS ? "fresh" : "stale";
}

function gapReason(
  hasUnavailable: boolean,
  hasCollectorError: boolean,
  machineConnection: FleetMachineState["connection"],
): TimelineGap["reason"] {
  if (hasUnavailable) return "unavailable";
  if (hasCollectorError) return "collector-error";
  if (machineConnection === "disconnected") return "host-offline";
  // This source has no global retained-bound query. Do not overclaim
  // retention for a connected source with no samples or a future range.
  return "no-samples";
}

function compareGaps(left: TimelineGap, right: TimelineGap): number {
  return left.startMs - right.startMs
    || (left.metricId < right.metricId ? -1 : left.metricId > right.metricId ? 1 : 0)
    || left.endMs - right.endMs;
}

/**
 * Server-owned composition. FleetStore supplies only lightweight registry,
 * generation, and exact event operations; all history reduction goes through
 * the injected bounded query source and never contacts a daemon.
 */
export class TimelineQueryService {
  readonly cache: FleetCache;
  private readonly store: FleetStore;
  private readonly source: TimelineQuerySource;
  private readonly now: () => number;
  private readonly attachmentSnapshot: () => AttachmentSnapshot;
  private readonly warningThresholds: FleetWarningThresholdProvider;

  constructor(store: FleetStore, source: TimelineQuerySource, options: TimelineQueryOptions = {}) {
    this.store = store;
    this.source = source;
    this.cache = options.cache ?? new FleetCache(options.cacheOptions);
    this.now = options.now ?? (() => Date.now());
    this.attachmentSnapshot = options.attachmentSnapshot ?? (() => EMPTY_ATTACHMENTS);
    this.warningThresholds = options.warningThresholds ?? (() => null);
  }

  invalidateMachine(machine: FleetMachineIdentity, kind: FleetCacheInvalidationKind): void {
    this.cache.invalidateMachine(machine, kind);
  }

  invalidateOverview(): void {
    this.cache.invalidateOverview();
  }

  async fleetOverview(input: unknown = { contractVersion: FLEET_CONTRACT_VERSION }): Promise<FleetOverviewResult> {
    fleetOverviewRequestSchema.parse(input);
    // generatedAtMs and freshness are clock-derived, so a generation-only
    // cache would serve stale state across the freshness threshold/reconnect.
    for (let attempt = 0; attempt < MAX_OVERVIEW_GENERATION_ATTEMPTS; attempt += 1) {
      const overview = await this.buildFleetOverview(this.store.fleetGeneration());
      if (overview != null) return overview;
    }
    throw new Error("Fleet overview changed generation while it was being read.");
  }

  async machineTimeline(input: MachineTimelineRequest): Promise<MachineTimelineResult> {
    const request = machineTimelineRequestSchema.parse(input);
    const generation = this.store.generation(request.machine);
    return await this.cache.getOrLoad(
      fleetTimelineCacheKey(request.machine, request.range, generation),
      { kind: "timeline", machine: request.machine },
      () => this.buildMachineTimeline(request, generation),
    );
  }

  /** Inventory is one committed SQLite profile, never a host RPC on selection. */
  machineInventory(input: unknown): MachineInventoryResult {
    const request = machineInventoryRequestSchema.parse(input);
    const generation = this.store.generation(request.machine);
    const inventory = this.store.inventory(request.machine);
    return machineInventoryResultSchema.parse({
      contractVersion: FLEET_CONTRACT_VERSION,
      machine: request.machine,
      generation,
      inventory: inventory?.inventory ?? null,
      receivedAtMs: inventory?.receivedAtMs ?? null,
      lastError: inventory?.lastError ?? null,
      lastErrorAtMs: inventory?.lastErrorAtMs ?? null,
    });
  }

  private async buildFleetOverview(generation: TimelineGeneration): Promise<FleetOverviewResult | null> {
    const now = safeNow(this.now);
    const overview = this.source.readFleetOverview(now);
    const thresholds = validWarningThresholds(await this.warningThresholds());
    // Settings can be asynchronous. Do not combine a metric read from before
    // that await with machine state committed after it; generation revisions
    // are monotonic, so a caller can safely rebuild from the newer snapshot.
    if (!sameGeneration(generation, this.store.fleetGeneration())) return null;
    const machineStates = this.store.machines();
    if (!sameGeneration(generation, this.store.fleetGeneration())) return null;
    const machines = machineStates.map((machine) => {
      const freshness = overviewFreshness(machine, now);
      const machineKey = machineIdentityKey(machine.machine);
      const latestMetrics = [...(overview.latestMetrics.get(machineKey) ?? [])];
      const warnings: FleetOverviewResult["machines"][number]["warnings"] = [];
      if (machine.connection === "disconnected") warnings.push({ kind: "disconnected", message: "Machine is disconnected.", metricId: null });
      if (freshness === "stale") warnings.push({ kind: "stale", message: "Machine data is stale.", metricId: null });
      if (machine.lastError != null) warnings.push({ kind: "collector-error", message: warningText(machine.lastError), metricId: null });
      for (const metric of latestMetrics) {
        if (metric.availability.state === "unavailable") {
          warnings.push({ kind: "unsupported-capability", message: `Metric ${metric.metricId} is unavailable.`, metricId: metric.metricId });
        }
      }
      warnings.push(...metricThresholdWarnings(thresholds, overview.cpuFiveMinuteAverages.get(machineKey) ?? null, latestMetrics));
      return {
        machine: machine.machine,
        label: machine.label,
        connection: machine.connection,
        freshness,
      latestCollectedAtMs: machine.latestCollectedAtMs,
        cpu5mPercent: overview.cpuFiveMinuteAverages.get(machineKey) ?? null,
        lastError: machine.lastError,
        capabilities: machine.capabilities,
        latestMetrics,
        warnings,
        generation: machine.generation,
      };
    });
    return fleetOverviewResultSchema.parse({
      contractVersion: FLEET_CONTRACT_VERSION,
      generatedAtMs: now,
      generation,
      machines,
      attachments: { scope: "fleet", snapshot: this.attachmentSnapshot() },
    });
  }

  private buildMachineTimeline(request: MachineTimelineRequest, generation: TimelineGeneration): MachineTimelineResult {
    const machine = this.store.machine(request.machine);
    if (machine == null) throw new Error("Fleet machine is not registered by the server.");
    const { range } = request;
    const widthMs = timelineBucketWidthMs(range);
    const count = bucketCount(range, widthMs);
    if (count > MAX_TIMELINE_BUCKETS) throw new Error("Timeline bucketing exceeded the contract limit.");
    const rows = this.source.readMachineTimeline({ machine: request.machine, range, bucketWidthMs: widthMs, bucketCount: count });
    const coverage = summarizeCoverage(range, widthMs, rows.normalization);
    const timeNormalization = normalizationSummary(request.machine, rows.normalization);
    const byMetricBucket = new Map(rows.metricBuckets.map((row) => [`${row.metricId}\u0000${row.bucketIndex}`, row]));
    const availability = new Map(rows.latestAvailability.map((row) => [row.metricId, row.availability]));
    const errorBuckets = new Set(rows.errorBucketIndexes);
    const gaps: TimelineGap[] = [];
    const metrics = FLEET_METRIC_CATALOG.map((catalog) => {
      const buckets = Array.from({ length: count }, (_, index) => {
        const startMs = range.startMs + index * widthMs;
        const endMs = Math.min(range.endMs, startMs + widthMs);
        const row = byMetricBucket.get(`${catalog.id}\u0000${index}`);
        if (row == null || row.count === 0) return emptyBucket(startMs, endMs);
        if (row.min == null || row.average == null || row.max == null || row.last == null) {
          throw new Error("Non-empty fleet metric bucket lacks an aggregate statistic.");
        }
        return { startMs, endMs, min: row.min, average: row.average, max: row.max, last: row.last, count: row.count };
      });
      let missingStart: number | null = null;
      let missingReason: TimelineGap["reason"] | null = null;
      for (let index = 0; index <= buckets.length; index += 1) {
        const current = buckets[index];
        const row = index === buckets.length ? null : byMetricBucket.get(`${catalog.id}\u0000${index}`);
        const reason = current == null || current.count > 0 ? null : gapReason(
          row?.hasUnavailable === true,
          errorBuckets.has(index),
          machine.connection,
        );
        if (reason != null && missingStart == null) {
          missingStart = index;
          missingReason = reason;
          continue;
        }
        if (reason === missingReason) continue;
        if (missingStart != null) {
          const first = buckets[missingStart]!;
          const last = buckets[index - 1]!;
          gaps.push({ metricId: catalog.id, startMs: first.startMs, endMs: last.endMs, reason: missingReason! });
        }
        missingStart = reason == null ? null : index;
        missingReason = reason;
      }
      return { metricId: catalog.id, availability: availability.get(catalog.id) ?? defaultMetricAvailability(), buckets };
    });
    if (gaps.length > MAX_TIMELINE_GAPS) throw new Error("Fleet timeline emitted more gaps than the contract can represent.");
    const events = this.store.timelineEvents(request.machine, range.startMs, range.endMs);
    return machineTimelineResultSchema.parse({
      contractVersion: FLEET_CONTRACT_VERSION,
      machine: request.machine,
      generation,
      range,
      bucket: { alignment: "range-start", widthMs, count },
      coverage,
      timeNormalization,
      metrics,
      gaps: gaps.sort(compareGaps),
      directories: summarizeDirectories(rows.directories ?? []),
      events,
    });
  }
}
