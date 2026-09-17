import type Database from "better-sqlite3";

import {
  canonicalizeResource,
  createProjectionCommand,
  isMachineMonitorAttachmentTarget,
  machineMonitorResource,
  MACHINE_MONITOR_PRODUCER_ID,
  MAX_ATTACHMENT_TARGETS,
  projectionPayloadDigest,
  type AttachmentError,
  type AttachmentSnapshot,
  type AttachmentStatus,
  type CanonicalResource,
  type ProjectionCommand,
  type ProjectionResponse,
  type ReplaceAttachmentsInput,
  type Resource,
} from "./attachment-contract.ts";
import { bucketSizeFor, type DirectorySample, type MachineSample, type MemoryDiagnostics } from "./monitor.ts";

export const machineMonitorMigrations = [
  `CREATE TABLE IF NOT EXISTS machine_samples (
    collected_at INTEGER PRIMARY KEY,
    cpu_percent REAL,
    memory_used_bytes INTEGER,
    memory_total_bytes INTEGER,
    disk_used_bytes INTEGER,
    disk_total_bytes INTEGER,
    load1 REAL
  )`,
  `CREATE INDEX IF NOT EXISTS machine_samples_collected_at ON machine_samples(collected_at)`,
  `CREATE TABLE IF NOT EXISTS directory_samples (
    collected_at INTEGER NOT NULL,
    location TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    PRIMARY KEY (collected_at, location)
  )`,
  `CREATE INDEX IF NOT EXISTS directory_samples_location_collected_at ON directory_samples(location, collected_at)`,
  `ALTER TABLE machine_samples ADD COLUMN load5 REAL`,
  `CREATE TABLE IF NOT EXISTS memory_diagnostics (
    collected_at INTEGER PRIMARY KEY,
    sample_interval_ms INTEGER,
    pressure_some_percent REAL,
    pressure_full_percent REAL,
    swap_in_pages_per_second REAL,
    swap_out_pages_per_second REAL,
    refault_pages_per_second REAL,
    reclaim_pages_per_second REAL,
    bb_cgroup_memory_bytes INTEGER,
    processes_json TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS memory_diagnostics_collected_at ON memory_diagnostics(collected_at)`,
  `ALTER TABLE memory_diagnostics ADD COLUMN process_details_collected_at INTEGER`,
  `UPDATE memory_diagnostics SET processes_json = '[]'`,
  `ALTER TABLE directory_samples ADD COLUMN on_root_filesystem INTEGER`,
  `ALTER TABLE directory_samples ADD COLUMN partial INTEGER`,
  `CREATE TABLE IF NOT EXISTS machine_monitor_reference_links (
    target_provider TEXT NOT NULL,
    target_canonical_keys_json TEXT NOT NULL,
    target_presentation_json TEXT NOT NULL,
    position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 255),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (target_provider, target_canonical_keys_json),
    UNIQUE (position)
  )`,
  `CREATE TABLE IF NOT EXISTS machine_monitor_reference_state (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    desired_revision INTEGER NOT NULL CHECK (desired_revision >= 0),
    desired_payload_digest TEXT,
    last_acked_revision INTEGER NOT NULL CHECK (last_acked_revision >= 0),
    last_acked_mutation_id TEXT,
    last_error TEXT,
    error_kind TEXT CHECK (error_kind IN ('absent', 'transient', 'incompatible', 'blocked')),
    updated_at INTEGER NOT NULL
  )`,
  `INSERT OR IGNORE INTO machine_monitor_reference_state
    (singleton, desired_revision, desired_payload_digest, last_acked_revision,
     last_acked_mutation_id, last_error, error_kind, updated_at)
   VALUES (1, 0, NULL, 0, NULL, NULL, NULL, 0)`,
  `CREATE TABLE IF NOT EXISTS machine_monitor_reference_outbox (
    singleton INTEGER NOT NULL CHECK (singleton = 1),
    slot TEXT NOT NULL CHECK (slot IN ('pending', 'in_flight')),
    revision INTEGER NOT NULL CHECK (revision > 0),
    mutation_id TEXT NOT NULL,
    expected_remote_revision INTEGER NOT NULL CHECK (expected_remote_revision >= 0),
    payload_json TEXT NOT NULL,
    payload_digest TEXT NOT NULL CHECK (length(payload_digest) = 64),
    attempts INTEGER NOT NULL CHECK (attempts >= 0),
    next_attempt_at INTEGER,
    lease_until INTEGER,
    last_error TEXT,
    error_kind TEXT CHECK (error_kind IN ('absent', 'transient', 'incompatible', 'blocked')),
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (singleton, slot)
  )`,
  `CREATE TABLE IF NOT EXISTS machine_monitor_fleet_state (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    data_revision INTEGER NOT NULL CHECK (data_revision >= 0),
    settings_revision INTEGER NOT NULL CHECK (settings_revision >= 0)
  )`,
  `INSERT OR IGNORE INTO machine_monitor_fleet_state (singleton, data_revision, settings_revision)
   VALUES (1, 0, 0)`,
  `CREATE TABLE IF NOT EXISTS machine_monitor_fleet_machines (
    machine_source TEXT NOT NULL CHECK (machine_source IN ('local-bb-server', 'enrolled-host')),
    machine_id TEXT NOT NULL,
    label TEXT NOT NULL,
    connection TEXT NOT NULL CHECK (connection IN ('local', 'connected', 'disconnected', 'unknown')),
    capabilities_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_collected_at INTEGER,
    last_fresh_at INTEGER,
    last_error TEXT,
    last_error_at INTEGER,
    data_revision INTEGER NOT NULL CHECK (data_revision >= 0),
    settings_revision INTEGER NOT NULL CHECK (settings_revision >= 0),
    PRIMARY KEY (machine_source, machine_id),
    CHECK (
      (machine_source = 'local-bb-server' AND machine_id = 'local-bb-server' AND connection = 'local')
      OR (machine_source = 'enrolled-host' AND machine_id <> 'local-bb-server' AND connection <> 'local')
    )
  )`,
  `CREATE TABLE IF NOT EXISTS machine_monitor_fleet_collections (
    machine_source TEXT NOT NULL,
    machine_id TEXT NOT NULL,
    collector_session_id TEXT NOT NULL,
    sequence INTEGER NOT NULL CHECK (sequence >= 0),
    host_observed_at INTEGER NOT NULL,
    server_sent_at INTEGER NOT NULL,
    server_received_at INTEGER NOT NULL,
    normalized_at INTEGER NOT NULL,
    clock_uncertainty_ms INTEGER NOT NULL CHECK (clock_uncertainty_ms >= 0),
    payload_digest TEXT NOT NULL CHECK (length(payload_digest) = 64),
    payload_json TEXT NOT NULL,
    PRIMARY KEY (machine_source, machine_id, collector_session_id, sequence),
    FOREIGN KEY (machine_source, machine_id) REFERENCES machine_monitor_fleet_machines(machine_source, machine_id),
    CHECK (host_observed_at >= 0 AND server_sent_at >= 0 AND server_received_at >= 0
      AND normalized_at >= 0 AND clock_uncertainty_ms BETWEEN 0 AND 3600000),
    CHECK (server_received_at >= server_sent_at),
    CHECK (normalized_at >= server_sent_at AND normalized_at <= server_received_at)
  )`,
  `CREATE INDEX IF NOT EXISTS machine_monitor_fleet_collections_machine_time
    ON machine_monitor_fleet_collections(machine_source, machine_id, normalized_at, collector_session_id, sequence)`,
  `CREATE TABLE IF NOT EXISTS machine_monitor_fleet_metric_values (
    machine_source TEXT NOT NULL,
    machine_id TEXT NOT NULL,
    collector_session_id TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    normalized_at INTEGER NOT NULL,
    metric_id TEXT NOT NULL,
    value REAL,
    availability_state TEXT NOT NULL CHECK (availability_state IN ('available', 'unavailable', 'not-collected')),
    availability_reason TEXT,
    PRIMARY KEY (machine_source, machine_id, collector_session_id, sequence, metric_id),
    CHECK (value IS NULL OR value >= 0),
    CHECK ((availability_state = 'available' AND value IS NOT NULL AND availability_reason IS NULL)
      OR (availability_state <> 'available' AND value IS NULL)),
    FOREIGN KEY (machine_source, machine_id, collector_session_id, sequence)
      REFERENCES machine_monitor_fleet_collections(machine_source, machine_id, collector_session_id, sequence)
  )`,
  `CREATE INDEX IF NOT EXISTS machine_monitor_fleet_metric_values_machine_time
    ON machine_monitor_fleet_metric_values(machine_source, machine_id, normalized_at, metric_id)`,
  `CREATE TABLE IF NOT EXISTS machine_monitor_fleet_directory_details (
    machine_source TEXT NOT NULL,
    machine_id TEXT NOT NULL,
    collected_at INTEGER NOT NULL,
    location TEXT NOT NULL,
    bytes INTEGER NOT NULL CHECK (bytes >= 0),
    on_root_filesystem INTEGER NOT NULL CHECK (on_root_filesystem IN (0, 1)),
    partial INTEGER NOT NULL CHECK (partial IN (0, 1)),
    payload_digest TEXT NOT NULL CHECK (length(payload_digest) = 64),
    CHECK (collected_at >= 0),
    PRIMARY KEY (machine_source, machine_id, collected_at, location),
    FOREIGN KEY (machine_source, machine_id) REFERENCES machine_monitor_fleet_machines(machine_source, machine_id)
  )`,
  `CREATE INDEX IF NOT EXISTS machine_monitor_fleet_directory_details_machine_time
    ON machine_monitor_fleet_directory_details(machine_source, machine_id, collected_at, location)`,
  `CREATE TABLE IF NOT EXISTS machine_monitor_fleet_memory_details (
    machine_source TEXT NOT NULL,
    machine_id TEXT NOT NULL,
    collected_at INTEGER NOT NULL,
    sample_interval_ms INTEGER,
    pressure_some_percent REAL,
    pressure_full_percent REAL,
    swap_in_pages_per_second REAL,
    swap_out_pages_per_second REAL,
    refault_pages_per_second REAL,
    reclaim_pages_per_second REAL,
    bb_cgroup_memory_bytes INTEGER,
    processes_json TEXT NOT NULL,
    process_details_collected_at INTEGER,
    payload_digest TEXT NOT NULL CHECK (length(payload_digest) = 64),
    PRIMARY KEY (machine_source, machine_id, collected_at),
    FOREIGN KEY (machine_source, machine_id) REFERENCES machine_monitor_fleet_machines(machine_source, machine_id),
    CHECK (collected_at >= 0)
  )`,
  `CREATE INDEX IF NOT EXISTS machine_monitor_fleet_memory_details_machine_time
    ON machine_monitor_fleet_memory_details(machine_source, machine_id, collected_at)`,
  `CREATE TABLE IF NOT EXISTS machine_monitor_fleet_events (
    machine_source TEXT NOT NULL,
    machine_id TEXT NOT NULL,
    producer_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    contract_version INTEGER NOT NULL,
    producer_version INTEGER NOT NULL,
    event_start_at INTEGER NOT NULL,
    event_end_at INTEGER NOT NULL,
    payload_digest TEXT NOT NULL CHECK (length(payload_digest) = 64),
    event_json TEXT NOT NULL,
    PRIMARY KEY (machine_source, machine_id, producer_id, event_id),
    FOREIGN KEY (machine_source, machine_id) REFERENCES machine_monitor_fleet_machines(machine_source, machine_id),
    CHECK (event_start_at >= 0 AND event_end_at >= event_start_at)
  )`,
  `CREATE INDEX IF NOT EXISTS machine_monitor_fleet_events_machine_time
    ON machine_monitor_fleet_events(machine_source, machine_id, event_start_at, producer_id, event_id)`,
  `CREATE TABLE IF NOT EXISTS machine_monitor_fleet_errors (
    machine_source TEXT NOT NULL,
    machine_id TEXT NOT NULL,
    error_id TEXT NOT NULL,
    occurred_at INTEGER NOT NULL,
    kind TEXT NOT NULL,
    message TEXT NOT NULL,
    payload_digest TEXT NOT NULL CHECK (length(payload_digest) = 64),
    PRIMARY KEY (machine_source, machine_id, error_id),
    FOREIGN KEY (machine_source, machine_id) REFERENCES machine_monitor_fleet_machines(machine_source, machine_id),
    CHECK (occurred_at >= 0)
  )`,
  `CREATE INDEX IF NOT EXISTS machine_monitor_fleet_errors_machine_time
    ON machine_monitor_fleet_errors(machine_source, machine_id, occurred_at, error_id)`,
  `INSERT OR IGNORE INTO machine_monitor_fleet_machines
    (machine_source, machine_id, label, connection, capabilities_json, created_at, updated_at,
     last_collected_at, last_fresh_at, last_error, last_error_at, data_revision, settings_revision)
   VALUES ('local-bb-server', 'local-bb-server', 'Local BB server', 'local', '[]', 0, 0,
     NULL, NULL, NULL, NULL, 0, 0)`,
  `INSERT OR IGNORE INTO machine_monitor_fleet_collections
    (machine_source, machine_id, collector_session_id, sequence, host_observed_at,
     server_sent_at, server_received_at, normalized_at, clock_uncertainty_ms, payload_digest, payload_json)
   SELECT 'local-bb-server', 'local-bb-server', 'legacy-machine-samples-v1', collected_at,
     collected_at, collected_at, collected_at, collected_at, 0,
     '0000000000000000000000000000000000000000000000000000000000000000', '{}'
   FROM machine_samples`,
  `INSERT OR IGNORE INTO machine_monitor_fleet_metric_values
    (machine_source, machine_id, collector_session_id, sequence, normalized_at, metric_id, value, availability_state, availability_reason)
   SELECT 'local-bb-server', 'local-bb-server', 'legacy-machine-samples-v1', collected_at, collected_at,
     metric_id, value, 'available', NULL
   FROM (
     SELECT collected_at, 'cpu.utilization.percent' AS metric_id, cpu_percent AS value FROM machine_samples WHERE cpu_percent IS NOT NULL
     UNION ALL SELECT collected_at, 'memory.used.bytes', memory_used_bytes FROM machine_samples WHERE memory_used_bytes IS NOT NULL
     UNION ALL SELECT collected_at, 'memory.total.bytes', memory_total_bytes FROM machine_samples WHERE memory_total_bytes IS NOT NULL
     UNION ALL SELECT collected_at, 'disk.root.used.bytes', disk_used_bytes FROM machine_samples WHERE disk_used_bytes IS NOT NULL
     UNION ALL SELECT collected_at, 'disk.root.total.bytes', disk_total_bytes FROM machine_samples WHERE disk_total_bytes IS NOT NULL
     UNION ALL SELECT collected_at, 'load.1', load1 FROM machine_samples WHERE load1 IS NOT NULL
     UNION ALL SELECT collected_at, 'load.5', load5 FROM machine_samples WHERE load5 IS NOT NULL
   )`,
  `INSERT OR IGNORE INTO machine_monitor_fleet_collections
    (machine_source, machine_id, collector_session_id, sequence, host_observed_at,
     server_sent_at, server_received_at, normalized_at, clock_uncertainty_ms, payload_digest, payload_json)
   SELECT 'local-bb-server', 'local-bb-server', 'legacy-memory-diagnostics-v1', collected_at,
     collected_at, collected_at, collected_at, collected_at, 0,
     '0000000000000000000000000000000000000000000000000000000000000000', '{}'
   FROM memory_diagnostics`,
  `INSERT OR IGNORE INTO machine_monitor_fleet_metric_values
    (machine_source, machine_id, collector_session_id, sequence, normalized_at, metric_id, value, availability_state, availability_reason)
   SELECT 'local-bb-server', 'local-bb-server', 'legacy-memory-diagnostics-v1', collected_at, collected_at,
     metric_id, value, 'available', NULL
   FROM (
     SELECT collected_at, 'memory.pressure.some.percent' AS metric_id, pressure_some_percent AS value FROM memory_diagnostics WHERE pressure_some_percent IS NOT NULL
     UNION ALL SELECT collected_at, 'memory.pressure.full.percent', pressure_full_percent FROM memory_diagnostics WHERE pressure_full_percent IS NOT NULL
     UNION ALL SELECT collected_at, 'memory.swap.in.pages-per-second', swap_in_pages_per_second FROM memory_diagnostics WHERE swap_in_pages_per_second IS NOT NULL
     UNION ALL SELECT collected_at, 'memory.swap.out.pages-per-second', swap_out_pages_per_second FROM memory_diagnostics WHERE swap_out_pages_per_second IS NOT NULL
   )`,
  `INSERT OR IGNORE INTO machine_monitor_fleet_directory_details
    (machine_source, machine_id, collected_at, location, bytes, on_root_filesystem, partial, payload_digest)
   SELECT 'local-bb-server', 'local-bb-server', collected_at, location, bytes,
     COALESCE(on_root_filesystem, 0), COALESCE(partial, 0),
     '0000000000000000000000000000000000000000000000000000000000000000'
   FROM directory_samples`,
  `INSERT OR IGNORE INTO machine_monitor_fleet_memory_details
    (machine_source, machine_id, collected_at, sample_interval_ms, pressure_some_percent,
     pressure_full_percent, swap_in_pages_per_second, swap_out_pages_per_second,
     refault_pages_per_second, reclaim_pages_per_second, bb_cgroup_memory_bytes,
     processes_json, process_details_collected_at, payload_digest)
   SELECT 'local-bb-server', 'local-bb-server', collected_at, sample_interval_ms, pressure_some_percent,
     pressure_full_percent, swap_in_pages_per_second, swap_out_pages_per_second,
     refault_pages_per_second, reclaim_pages_per_second, bb_cgroup_memory_bytes,
     processes_json, process_details_collected_at,
     '0000000000000000000000000000000000000000000000000000000000000000'
   FROM memory_diagnostics`,
  `UPDATE machine_monitor_fleet_machines SET
    last_collected_at = (SELECT MAX(normalized_at) FROM machine_monitor_fleet_collections
      WHERE machine_source = 'local-bb-server' AND machine_id = 'local-bb-server'),
    last_fresh_at = (SELECT MAX(normalized_at) FROM machine_monitor_fleet_collections
      WHERE machine_source = 'local-bb-server' AND machine_id = 'local-bb-server'),
    data_revision = CASE WHEN EXISTS (SELECT 1 FROM machine_monitor_fleet_collections
      WHERE machine_source = 'local-bb-server' AND machine_id = 'local-bb-server') THEN 1 ELSE 0 END
   WHERE machine_source = 'local-bb-server' AND machine_id = 'local-bb-server'`,
  `UPDATE machine_monitor_fleet_state SET data_revision = CASE WHEN EXISTS
    (SELECT 1 FROM machine_monitor_fleet_collections) THEN 1 ELSE data_revision END
   WHERE singleton = 1`,
  `CREATE TABLE IF NOT EXISTS machine_monitor_fleet_memory_observations (
    machine_source TEXT NOT NULL,
    machine_id TEXT NOT NULL,
    collector_session_id TEXT NOT NULL,
    sequence INTEGER NOT NULL CHECK (sequence >= 0),
    host_observed_at INTEGER NOT NULL,
    server_sent_at INTEGER NOT NULL,
    server_received_at INTEGER NOT NULL,
    normalized_at INTEGER NOT NULL,
    clock_uncertainty_ms INTEGER NOT NULL CHECK (clock_uncertainty_ms >= 0),
    pressure_some_percent REAL,
    pressure_full_percent REAL,
    swap_in_pages_per_second REAL,
    swap_out_pages_per_second REAL,
    payload_digest TEXT NOT NULL CHECK (length(payload_digest) = 64),
    PRIMARY KEY (machine_source, machine_id, collector_session_id, sequence),
    FOREIGN KEY (machine_source, machine_id) REFERENCES machine_monitor_fleet_machines(machine_source, machine_id),
    CHECK (host_observed_at >= 0 AND server_sent_at >= 0 AND server_received_at >= 0
      AND normalized_at >= 0 AND clock_uncertainty_ms BETWEEN 0 AND 3600000),
    CHECK (server_received_at >= server_sent_at),
    CHECK (normalized_at >= server_sent_at AND normalized_at <= server_received_at),
    CHECK (pressure_some_percent IS NULL OR pressure_some_percent >= 0),
    CHECK (pressure_full_percent IS NULL OR pressure_full_percent >= 0),
    CHECK (swap_in_pages_per_second IS NULL OR swap_in_pages_per_second >= 0),
    CHECK (swap_out_pages_per_second IS NULL OR swap_out_pages_per_second >= 0)
  )`,
  `CREATE INDEX IF NOT EXISTS machine_monitor_fleet_memory_observations_machine_time
    ON machine_monitor_fleet_memory_observations(machine_source, machine_id, normalized_at, collector_session_id, sequence)`,
  `CREATE TABLE IF NOT EXISTS machine_monitor_fleet_inventory (
    machine_source TEXT NOT NULL,
    machine_id TEXT NOT NULL,
    collector_session_id TEXT NOT NULL,
    host_observed_at INTEGER NOT NULL,
    server_sent_at INTEGER NOT NULL,
    server_received_at INTEGER NOT NULL,
    payload_digest TEXT NOT NULL CHECK (length(payload_digest) = 64),
    payload_json TEXT NOT NULL,
    last_error TEXT,
    last_error_at INTEGER,
    PRIMARY KEY (machine_source, machine_id),
    FOREIGN KEY (machine_source, machine_id) REFERENCES machine_monitor_fleet_machines(machine_source, machine_id),
    CHECK (host_observed_at >= 0 AND server_sent_at >= 0 AND server_received_at >= server_sent_at),
    CHECK (last_error_at IS NULL OR last_error_at >= 0)
  )`,
];

export class MachineMonitorStore {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  insert(sample: MachineSample): void {
    this.db.prepare(`INSERT OR REPLACE INTO machine_samples
      (collected_at, cpu_percent, memory_used_bytes, memory_total_bytes, disk_used_bytes, disk_total_bytes, load1, load5)
      VALUES (@collectedAt, @cpuPercent, @memoryUsedBytes, @memoryTotalBytes, @diskUsedBytes, @diskTotalBytes, @load1, @load5)`)
      .run(sample);
  }

  prune(before: number): void {
    this.db.prepare("DELETE FROM machine_samples WHERE collected_at < ?").run(before);
    this.db.prepare("DELETE FROM directory_samples WHERE collected_at < ?").run(before);
  }

  latest(): MachineSample | null {
    return this.db.prepare(`SELECT collected_at AS collectedAt, cpu_percent AS cpuPercent,
      memory_used_bytes AS memoryUsedBytes, memory_total_bytes AS memoryTotalBytes,
      disk_used_bytes AS diskUsedBytes, disk_total_bytes AS diskTotalBytes, load1, load5
      FROM machine_samples ORDER BY collected_at DESC LIMIT 1`).get() as MachineSample | undefined ?? null;
  }

  history(since: number, until: number): MachineSample[] {
    const bucketSize = bucketSizeFor(until - since);
    return this.db.prepare(`SELECT CAST((collected_at / @bucketSize) * @bucketSize AS INTEGER) AS collectedAt,
      AVG(cpu_percent) AS cpuPercent, AVG(memory_used_bytes) AS memoryUsedBytes,
      AVG(memory_total_bytes) AS memoryTotalBytes, AVG(disk_used_bytes) AS diskUsedBytes,
      AVG(disk_total_bytes) AS diskTotalBytes, AVG(load1) AS load1, AVG(load5) AS load5
      FROM machine_samples WHERE collected_at BETWEEN @since AND @until
      GROUP BY (collected_at / @bucketSize) ORDER BY collectedAt ASC`)
      .all({ since, until, bucketSize }) as MachineSample[];
  }

  insertDirectories(samples: DirectorySample[]): void {
    const insert = this.db.prepare("INSERT OR REPLACE INTO directory_samples (collected_at, location, bytes, on_root_filesystem, partial) VALUES (@collectedAt, @location, @bytes, @onRootFilesystem, @partial)");
    this.db.transaction((entries: DirectorySample[]) => entries.forEach((entry) => insert.run({
      ...entry,
      onRootFilesystem: entry.onRootFilesystem ? 1 : 0,
      partial: entry.partial ? 1 : 0,
    })))(samples);
  }

  insertMemoryDiagnostics(diagnostics: MemoryDiagnostics): void {
    this.db.prepare(`INSERT OR REPLACE INTO memory_diagnostics
      (collected_at, sample_interval_ms, pressure_some_percent, pressure_full_percent,
       swap_in_pages_per_second, swap_out_pages_per_second, refault_pages_per_second,
       reclaim_pages_per_second, bb_cgroup_memory_bytes, processes_json, process_details_collected_at)
      VALUES (@collectedAt, @sampleIntervalMs, @pressureSomePercent, @pressureFullPercent,
       @swapInPagesPerSecond, @swapOutPagesPerSecond, @refaultPagesPerSecond,
       @reclaimPagesPerSecond, @bbCgroupMemoryBytes, @processesJson, @processDetailsCollectedAt)`)
      .run({ ...diagnostics, processesJson: JSON.stringify(diagnostics.processes) });
  }

  latestMemoryDiagnostics(): MemoryDiagnostics | null {
    const row = this.db.prepare(`SELECT collected_at AS collectedAt, sample_interval_ms AS sampleIntervalMs,
      pressure_some_percent AS pressureSomePercent, pressure_full_percent AS pressureFullPercent,
      swap_in_pages_per_second AS swapInPagesPerSecond, swap_out_pages_per_second AS swapOutPagesPerSecond,
      refault_pages_per_second AS refaultPagesPerSecond, reclaim_pages_per_second AS reclaimPagesPerSecond,
      bb_cgroup_memory_bytes AS bbCgroupMemoryBytes, processes_json AS processesJson,
      process_details_collected_at AS processDetailsCollectedAt
      FROM memory_diagnostics ORDER BY collected_at DESC LIMIT 1`).get() as (Omit<MemoryDiagnostics, "processes"> & { processesJson: string }) | undefined;
    if (row == null) return null;
    const { processesJson, ...diagnostics } = row;
    try { return { ...diagnostics, processes: JSON.parse(processesJson) as MemoryDiagnostics["processes"] }; } catch { return null; }
  }

  pruneMemoryDiagnostics(before: number, maxSnapshots: number): void {
    this.db.prepare("DELETE FROM memory_diagnostics WHERE collected_at < ?").run(before);
    this.db.prepare(`DELETE FROM memory_diagnostics WHERE collected_at NOT IN (
      SELECT collected_at FROM memory_diagnostics ORDER BY collected_at DESC LIMIT ?
    )`).run(maxSnapshots);
  }

  averageCpuSince(since: number): number | null {
    const row = this.db.prepare("SELECT AVG(cpu_percent) AS value FROM machine_samples WHERE collected_at >= ? AND cpu_percent IS NOT NULL").get(since) as { value: number | null };
    return row.value;
  }

  directorySummary(since: number, until: number): Array<{ location: string; bytes: number; onRootFilesystem: boolean | null; partial: boolean | null; collectedAt: number; firstBytes: number; firstCollectedAt: number }> {
    return this.db.prepare(`SELECT newest.location, newest.bytes, newest.on_root_filesystem AS onRootFilesystem, newest.partial, newest.collected_at AS collectedAt, first.bytes AS firstBytes, first.collected_at AS firstCollectedAt
      FROM directory_samples newest
      JOIN directory_samples first ON first.location = newest.location
      WHERE newest.collected_at = (SELECT MAX(collected_at) FROM directory_samples latest WHERE latest.location = newest.location AND latest.collected_at <= @until)
        AND first.collected_at = (SELECT MIN(collected_at) FROM directory_samples earliest WHERE earliest.location = newest.location AND earliest.collected_at >= @since AND earliest.collected_at <= @until)
      ORDER BY newest.location`).all({ since, until }) as Array<{ location: string; bytes: number; onRootFilesystem: boolean | null; partial: boolean | null; collectedAt: number; firstBytes: number; firstCollectedAt: number }>;
  }
}

type ReferenceStateRow = {
  desiredRevision: number;
  desiredPayloadDigest: string | null;
  lastAckedRevision: number;
  lastAckedMutationId: string | null;
  lastError: string | null;
  errorKind: AttachmentStatus["errorKind"];
  updatedAt: number;
};

type ReferenceLinkRow = {
  targetProvider: string;
  targetCanonicalKeysJson: string;
  targetPresentationJson: string;
  position: number;
};

type OutboxRow = {
  slot: "pending" | "in_flight";
  revision: number;
  mutationId: string;
  expectedRemoteRevision: number;
  payloadJson: string;
  payloadDigest: string;
  attempts: number;
  nextAttemptAt: number | null;
  leaseUntil: number | null;
  lastError: string | null;
  errorKind: Exclude<AttachmentStatus["errorKind"], null>;
  updatedAt: number;
};

export type ClaimedProjection = {
  command: ProjectionCommand;
  payloadJson: string;
  payloadDigest: string;
  attempts: number;
};

export type ReconcileProjection = {
  revision: number;
  payloadDigest: string;
};

const LEASE_MS = 75_000;
const MAX_BACKOFF_MS = 60_000;
export const ABSENT_RETRY_MS = 60_000;

function backoffMs(attempt: number): number {
  return Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** Math.max(0, attempt - 1));
}

function parseResource(row: ReferenceLinkRow): CanonicalResource {
  let keys: unknown;
  let presentation: unknown;
  try {
    keys = JSON.parse(row.targetCanonicalKeysJson);
    presentation = JSON.parse(row.targetPresentationJson);
  } catch (cause) {
    throw new Error(`Machine Monitor reference row is corrupt: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  const resource = canonicalizeResource({ provider: row.targetProvider, keys, presentation } as Resource);
  if (!isMachineMonitorAttachmentTarget(resource)) throw new Error("Machine Monitor reference row is not a supported attachment target.");
  return resource;
}

function parseCommand(row: OutboxRow): ProjectionCommand {
  let value: unknown;
  try { value = JSON.parse(row.payloadJson); } catch (cause) {
    throw new Error(`Machine Monitor outbox row is corrupt: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  const command = value as ProjectionCommand;
  if (command.payloadDigest !== row.payloadDigest || command.revision !== row.revision || command.mutationId !== row.mutationId) {
    throw new Error("Machine Monitor outbox tuple is corrupt.");
  }
  return command;
}

export class MachineMonitorReferenceStore {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  private state(): ReferenceStateRow {
    const row = this.db.prepare(`SELECT desired_revision AS desiredRevision,
      desired_payload_digest AS desiredPayloadDigest,
      last_acked_revision AS lastAckedRevision,
      last_acked_mutation_id AS lastAckedMutationId,
      last_error AS lastError, error_kind AS errorKind, updated_at AS updatedAt
      FROM machine_monitor_reference_state WHERE singleton = 1`).get() as ReferenceStateRow | undefined;
    if (row == null) throw new Error("Machine Monitor reference state is missing.");
    return row;
  }

  private links(): CanonicalResource[] {
    const rows = this.db.prepare(`SELECT target_provider AS targetProvider,
      target_canonical_keys_json AS targetCanonicalKeysJson,
      target_presentation_json AS targetPresentationJson, position
      FROM machine_monitor_reference_links ORDER BY position`).all() as ReferenceLinkRow[];
    return rows.map(parseResource);
  }

  private outbox(slot?: "pending" | "in_flight"): OutboxRow[] {
    return this.db.prepare(`SELECT slot, revision, mutation_id AS mutationId,
      expected_remote_revision AS expectedRemoteRevision, payload_json AS payloadJson,
      payload_digest AS payloadDigest, attempts, next_attempt_at AS nextAttemptAt,
      lease_until AS leaseUntil, last_error AS lastError, error_kind AS errorKind,
      updated_at AS updatedAt FROM machine_monitor_reference_outbox
      ${slot == null ? "" : "WHERE slot = ?"} ORDER BY CASE slot WHEN 'in_flight' THEN 0 ELSE 1 END`)
      .all(...(slot == null ? [] : [slot])) as OutboxRow[];
  }

  private statusAt(now: number): AttachmentStatus {
    const state = this.state();
    const rows = this.outbox();
    const pending = rows.find((row) => row.slot === "pending");
    const inFlight = rows.find((row) => row.slot === "in_flight");
    const current = pending ?? inFlight;
    const errorKind = state.errorKind ?? current?.errorKind ?? null;
    const statusState: AttachmentStatus["state"] = errorKind === "blocked" || errorKind === "incompatible"
      ? "blocked"
      : errorKind === "absent" || errorKind === "transient"
        ? "degraded"
        : pending != null || inFlight != null || state.lastAckedRevision < state.desiredRevision
          ? "pending"
          : "synced";
    return {
      state: statusState,
      sourceRevision: state.desiredRevision,
      desiredRevision: state.desiredRevision,
      lastAckedRevision: state.lastAckedRevision,
      pending: pending != null,
      inFlight: inFlight != null,
      attempts: current?.attempts ?? 0,
      nextAttemptAt: pending?.nextAttemptAt ?? inFlight?.leaseUntil ?? null,
      lastError: state.lastError ?? current?.lastError ?? null,
      errorKind,
    };
  }

  snapshot(now = Date.now()): AttachmentSnapshot {
    return {
      sourceRevision: this.state().desiredRevision,
      targets: this.links().map(({ provider, keys, presentation }) => ({ provider, keys, presentation })),
      status: this.statusAt(now),
    };
  }

  replaceAttachments(input: ReplaceAttachmentsInput, now = Date.now()): { outcome: "applied" | "unchanged" | "cas-mismatch"; snapshot: AttachmentSnapshot } {
    if (!Number.isSafeInteger(input.expectedSourceRevision) || input.expectedSourceRevision < 0) throw new Error("expectedSourceRevision must be a nonnegative safe integer.");
    if (!Array.isArray(input.targets) || input.targets.length > MAX_ATTACHMENT_TARGETS) throw new Error(`targets must contain at most ${MAX_ATTACHMENT_TARGETS} resources.`);
    const targets = input.targets.map((target) => {
      const canonical = canonicalizeResource(target);
      if (!isMachineMonitorAttachmentTarget(canonical)) throw new Error("Machine Monitor attachments must target exact BB threads or safe HTTP(S) URLs.");
      return canonical;
    });
    const identities = new Set<string>();
    for (const target of targets) {
      if (identities.has(target.canonicalIdentityJson)) throw new Error("Machine Monitor attachments must not contain duplicate targets.");
      identities.add(target.canonicalIdentityJson);
    }
    let outcome: "applied" | "unchanged" | "cas-mismatch" = "applied";
    this.db.transaction(() => {
      // Read and compare inside the write transaction so two concurrent
      // complete-set replacements cannot both pass the same source CAS.
      const current = this.links();
      const state = this.state();
      if (input.expectedSourceRevision !== state.desiredRevision) {
        outcome = "cas-mismatch";
        return;
      }
      const same = current.length === targets.length && current.every((entry, index) => {
        const target = targets[index]!;
        return entry.canonicalIdentityJson === target.canonicalIdentityJson && entry.presentationJson === target.presentationJson;
      });
      if (same) {
        outcome = "unchanged";
        return;
      }
      if (state.desiredRevision >= Number.MAX_SAFE_INTEGER) throw new Error("Machine Monitor reference revision exhausted.");

      const revision = state.desiredRevision + 1;
      const command = createProjectionCommand(revision, state.lastAckedRevision, targets);
      const payloadJson = JSON.stringify(command);
      const payloadDigest = command.payloadDigest;
      this.db.prepare("DELETE FROM machine_monitor_reference_links").run();
      const insert = this.db.prepare(`INSERT INTO machine_monitor_reference_links
        (target_provider, target_canonical_keys_json, target_presentation_json, position, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)`);
      targets.forEach((target, position) => insert.run(target.provider, target.canonicalKeysJson, target.presentationJson, position, now, now));
      this.db.prepare(`UPDATE machine_monitor_reference_state SET
        desired_revision = ?, desired_payload_digest = ?, last_error = NULL,
        error_kind = NULL, updated_at = ? WHERE singleton = 1`).run(revision, payloadDigest, now);
      this.db.prepare("DELETE FROM machine_monitor_reference_outbox WHERE singleton = 1 AND slot = 'pending'").run();
      this.db.prepare(`INSERT INTO machine_monitor_reference_outbox
        (singleton, slot, revision, mutation_id, expected_remote_revision, payload_json,
         payload_digest, attempts, next_attempt_at, lease_until, last_error, error_kind, updated_at)
        VALUES (1, 'pending', ?, ?, ?, ?, ?, 0, ?, NULL, NULL, NULL, ?)`)
        .run(revision, command.mutationId, command.expectedRevision, payloadJson, payloadDigest, now, now);
    })();
    return { outcome, snapshot: this.snapshot(now) };
  }

  recoverExpiredLeases(now = Date.now()): boolean {
    const inFlight = this.outbox("in_flight")[0];
    if (inFlight == null || (inFlight.leaseUntil != null && inFlight.leaseUntil > now)) return false;
    const pending = this.outbox("pending")[0];
    this.db.transaction(() => {
      if (pending != null) {
        this.db.prepare("DELETE FROM machine_monitor_reference_outbox WHERE singleton = 1 AND slot = 'in_flight'").run();
      } else {
        this.db.prepare(`UPDATE machine_monitor_reference_outbox SET slot = 'pending',
          next_attempt_at = ?, lease_until = NULL, updated_at = ?
          WHERE singleton = 1 AND slot = 'in_flight'`).run(now, now);
      }
    })();
    return true;
  }

  /**
   * A new service generation owns the durable outbox after plugin reload. An
   * old generation's RPC may still be unresolved because the SDK call has no
   * cancellation input, so reclaim its immutable tuple immediately instead of
   * waiting for the old lease to expire. A newer pending tuple always wins.
   */
  recoverInFlightForRestart(now = Date.now()): boolean {
    const inFlight = this.outbox("in_flight")[0];
    if (inFlight == null) return false;
    const pending = this.outbox("pending")[0];
    this.db.transaction(() => {
      if (pending != null) {
        this.db.prepare("DELETE FROM machine_monitor_reference_outbox WHERE singleton = 1 AND slot = 'in_flight'").run();
      } else {
        this.db.prepare(`UPDATE machine_monitor_reference_outbox SET slot = 'pending',
          next_attempt_at = ?, lease_until = NULL, updated_at = ?
          WHERE singleton = 1 AND slot = 'in_flight'`).run(now, now);
      }
    })();
    return true;
  }

  claimDue(now = Date.now(), leaseMs = LEASE_MS): ClaimedProjection | null {
    this.recoverExpiredLeases(now);
    const inFlight = this.outbox("in_flight")[0];
    if (inFlight != null) {
      if (inFlight.leaseUntil == null || inFlight.leaseUntil > now) return null;
      this.db.prepare(`UPDATE machine_monitor_reference_outbox SET lease_until = ?,
        updated_at = ? WHERE singleton = 1 AND slot = 'in_flight'`).run(now + leaseMs, now);
      return { command: parseCommand(inFlight), payloadJson: inFlight.payloadJson, payloadDigest: inFlight.payloadDigest, attempts: inFlight.attempts };
    }
    const pending = this.outbox("pending")[0];
    if (pending == null || pending.nextAttemptAt == null || pending.nextAttemptAt > now) return null;
    this.db.prepare(`UPDATE machine_monitor_reference_outbox SET slot = 'in_flight',
      next_attempt_at = NULL, lease_until = ?, updated_at = ?
      WHERE singleton = 1 AND slot = 'pending'`).run(now + leaseMs, now);
    return { command: parseCommand(pending), payloadJson: pending.payloadJson, payloadDigest: pending.payloadDigest, attempts: pending.attempts };
  }

  nextWakeAt(now = Date.now()): number | null {
    const rows = this.outbox();
    const inFlight = rows.find((row) => row.slot === "in_flight");
    if (inFlight != null) return inFlight.leaseUntil == null || inFlight.leaseUntil <= now ? now : inFlight.leaseUntil;
    const pending = rows.find((row) => row.slot === "pending");
    return pending?.nextAttemptAt ?? null;
  }

  private matchingInFlight(command: ClaimedProjection): OutboxRow | null {
    const row = this.outbox("in_flight")[0];
    if (row == null) return null;
    return row.revision === command.command.revision && row.mutationId === command.command.mutationId
      && row.payloadDigest === command.payloadDigest && row.payloadJson === command.payloadJson ? row : null;
  }

  private updateStateError(error: AttachmentError | null, now: number): void {
    this.db.prepare(`UPDATE machine_monitor_reference_state SET last_error = ?,
      error_kind = ?, updated_at = ? WHERE singleton = 1`).run(error?.message ?? null, error?.kind ?? null, now);
  }

  recordReconciliationFailure(error: AttachmentError, now = Date.now()): void {
    if (error.kind === "aborted") return;
    this.updateStateError(error, now);
  }

  private updatePendingExpectedRevision(remoteRevision: number, now: number): void {
    const pending = this.outbox("pending")[0];
    if (pending == null) return;
    const command = parseCommand(pending);
    this.db.prepare(`UPDATE machine_monitor_reference_outbox SET expected_remote_revision = ?,
      payload_json = ?, updated_at = ? WHERE singleton = 1 AND slot = 'pending'`)
      .run(remoteRevision, JSON.stringify({ ...command, expectedRevision: remoteRevision }), now);
  }

  recordFailure(command: ClaimedProjection, error: AttachmentError, now = Date.now()): boolean {
    if (error.kind === "aborted") return false;
    const current = this.matchingInFlight(command);
    if (current == null) return false;
    const pending = this.outbox("pending")[0];
    const attempts = current.attempts + 1;
    const retryAt = error.kind === "transient"
      ? now + backoffMs(attempts)
      : error.kind === "absent" ? now + ABSENT_RETRY_MS : null;
    this.db.transaction(() => {
      if (pending != null) {
        this.db.prepare("DELETE FROM machine_monitor_reference_outbox WHERE singleton = 1 AND slot = 'in_flight'").run();
      } else {
        this.db.prepare(`UPDATE machine_monitor_reference_outbox SET slot = 'pending', attempts = ?,
          next_attempt_at = ?, lease_until = NULL, last_error = ?, error_kind = ?, updated_at = ?
          WHERE singleton = 1 AND slot = 'in_flight'`).run(attempts, retryAt, error.message, error.kind, now);
      }
      if (pending == null) this.updateStateError(error, now);
    })();
    return true;
  }

  private acknowledge(command: ClaimedProjection, remoteRevision: number, now: number): boolean {
    if (this.matchingInFlight(command) == null) return false;
    const state = this.state();
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM machine_monitor_reference_outbox WHERE singleton = 1 AND slot = 'in_flight'").run();
      this.db.prepare(`UPDATE machine_monitor_reference_state SET last_acked_revision = MAX(last_acked_revision, ?),
        last_acked_mutation_id = ?, last_error = NULL, error_kind = NULL, updated_at = ? WHERE singleton = 1`)
        .run(remoteRevision, command.command.mutationId, now);
      if (this.outbox("pending")[0] != null) this.updatePendingExpectedRevision(remoteRevision, now);
    })();
    return true;
  }

  private rebase(remoteRevision: number, now: number): void {
    const state = this.state();
    const targets = this.links();
    if (state.desiredRevision >= Number.MAX_SAFE_INTEGER || remoteRevision >= Number.MAX_SAFE_INTEGER) throw new Error("Machine Monitor reference revision exhausted.");
    const revision = Math.max(state.desiredRevision, remoteRevision) + 1;
    const command = createProjectionCommand(revision, remoteRevision, targets);
    const payloadJson = JSON.stringify(command);
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM machine_monitor_reference_outbox WHERE singleton = 1 AND slot IN ('pending', 'in_flight')").run();
      this.db.prepare(`UPDATE machine_monitor_reference_state SET desired_revision = ?,
        desired_payload_digest = ?, last_error = NULL, error_kind = NULL, updated_at = ? WHERE singleton = 1`)
        .run(revision, command.payloadDigest, now);
      this.db.prepare(`INSERT INTO machine_monitor_reference_outbox
        (singleton, slot, revision, mutation_id, expected_remote_revision, payload_json,
         payload_digest, attempts, next_attempt_at, lease_until, last_error, error_kind, updated_at)
        VALUES (1, 'pending', ?, ?, ?, ?, ?, 0, ?, NULL, NULL, NULL, ?)`)
        .run(revision, command.mutationId, remoteRevision, payloadJson, command.payloadDigest, now, now);
    })();
  }

  recordResponse(command: ClaimedProjection, response: ProjectionResponse, now = Date.now()): "ignored" | "acknowledged" | "rebased" | "blocked" {
    if (this.matchingInFlight(command) == null) return "ignored";
    const validRemoteRevision = Number.isSafeInteger(response.currentRevision) && response.currentRevision >= 0;
    const validRemoteDigest = response.currentDigest === null || /^[0-9a-f]{64}$/.test(response.currentDigest);
    if (!validRemoteRevision || !validRemoteDigest) {
      this.recordFailure(command, {
        kind: "blocked",
        code: "invalid_response",
        status: null,
        message: "Cross References returned an invalid projection response.",
      }, now);
      return "blocked";
    }
    if (response.outcome === "applied" || response.outcome === "duplicate" || response.outcome === "equal") {
      if (response.currentRevision < command.command.revision || response.currentDigest !== command.payloadDigest) {
        this.recordFailure(command, {
          kind: "blocked",
          code: "invalid_response",
          status: null,
          message: "Cross References returned a response for a different projection.",
        }, now);
        return "blocked";
      }
      this.acknowledge(command, response.currentRevision, now);
      return "acknowledged";
    }
    if ((response.outcome === "stale" || response.outcome === "cas-mismatch") && response.currentDigest === command.payloadDigest) {
      if (response.currentRevision < command.command.revision) {
        this.recordFailure(command, {
          kind: "blocked",
          code: "invalid_response",
          status: null,
          message: "Cross References returned a stale response with an invalid revision.",
        }, now);
        return "blocked";
      }
      this.acknowledge(command, response.currentRevision, now);
      return "acknowledged";
    }
    if (response.outcome === "stale" || response.outcome === "cas-mismatch") {
      this.rebase(response.currentRevision, now);
      return "rebased";
    }
    const error: AttachmentError = {
      kind: "blocked",
      code: response.outcome,
      status: null,
      message: `Cross References rejected the projection as ${response.outcome}.`,
    };
    this.recordFailure(command, error, now);
    return "blocked";
  }

  reconcileRemote(projection: ReconcileProjection | null, now = Date.now()): "unchanged" | "queued" | "rebased" | "acknowledged" {
    const state = this.state();
    const targets = this.links();
    const source = canonicalizeResource(machineMonitorResource());
    const localDigest = projectionPayloadDigest(MACHINE_MONITOR_PRODUCER_ID, source, false, targets);
    const remoteRevision = projection?.revision ?? 0;
    const remoteDigest = projection?.payloadDigest ?? null;
    const hasLocalState = state.desiredRevision > 0 || targets.length > 0;
    this.updateStateError(null, now);
    if (!hasLocalState && projection == null) return "unchanged";
    if (remoteDigest === localDigest && remoteRevision >= state.desiredRevision) {
      this.db.transaction(() => {
        this.db.prepare(`DELETE FROM machine_monitor_reference_outbox WHERE singleton = 1 AND slot IN ('pending', 'in_flight')`).run();
        this.db.prepare(`UPDATE machine_monitor_reference_state SET desired_revision = MAX(desired_revision, ?),
          desired_payload_digest = ?, last_acked_revision = MAX(last_acked_revision, ?),
          last_acked_mutation_id = NULL, last_error = NULL, error_kind = NULL, updated_at = ? WHERE singleton = 1`)
          .run(remoteRevision, localDigest, remoteRevision, now);
      })();
      return "acknowledged";
    }
    if (remoteRevision >= state.desiredRevision && projection != null) {
      this.rebase(remoteRevision, now);
      return "rebased";
    }

    const pending = this.outbox("pending")[0];
    const inFlight = this.outbox("in_flight")[0];
    if (inFlight == null) {
      if (pending != null) {
        const command = parseCommand(pending);
        if (command.expectedRevision !== remoteRevision || pending.errorKind === "absent") {
          const nextCommand = { ...command, expectedRevision: remoteRevision };
          this.db.prepare(`UPDATE machine_monitor_reference_outbox SET expected_remote_revision = ?,
            payload_json = ?, last_error = NULL, error_kind = NULL,
            next_attempt_at = ?, updated_at = ? WHERE singleton = 1 AND slot = 'pending'`)
            .run(remoteRevision, JSON.stringify(nextCommand), now, now);
        }
      } else {
        const revision = Math.max(state.desiredRevision, remoteRevision, 0);
        const command = createProjectionCommand(Math.max(1, revision), remoteRevision, targets);
        const payloadJson = JSON.stringify(command);
        this.db.transaction(() => {
          this.db.prepare(`UPDATE machine_monitor_reference_state SET desired_revision = ?,
            desired_payload_digest = ?, last_error = NULL, error_kind = NULL, updated_at = ? WHERE singleton = 1`)
            .run(command.revision, command.payloadDigest, now);
          this.db.prepare(`INSERT INTO machine_monitor_reference_outbox
            (singleton, slot, revision, mutation_id, expected_remote_revision, payload_json,
             payload_digest, attempts, next_attempt_at, lease_until, last_error, error_kind, updated_at)
            VALUES (1, 'pending', ?, ?, ?, ?, ?, 0, ?, NULL, NULL, NULL, ?)`)
            .run(command.revision, command.mutationId, remoteRevision, payloadJson, command.payloadDigest, now, now);
        })();
      }
    }
    return "queued";
  }
}
