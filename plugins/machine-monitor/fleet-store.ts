import { createHash } from "node:crypto";

import type Database from "better-sqlite3";

import {
  FLEET_CONTRACT_VERSION,
  FLEET_METRIC_CATALOG,
  LOCAL_BB_SERVER_MACHINE_ID,
  MAX_FLEET_MACHINES,
  MAX_TIMELINE_EVENTS,
  collectionEnvelopeSchema,
  machineInventoryEnvelopeSchema,
  machineInventoryPayloadSchema,
  machineIdentitySchema,
  metricObservationSchema,
  timelineEventSchema,
  type FleetCollectionEnvelope,
  type FleetMachineIdentity,
  type MachineInventoryEnvelope,
  type MachineInventoryPayload,
  type FleetMetricId,
  type TimelineGeneration,
} from "./fleet-contract.ts";
import { MAX_REPORTED_DIRECTORIES, type DirectorySample, type MemoryDiagnostics } from "./monitor.ts";

export type FleetMachineConnection = "local" | "connected" | "disconnected" | "unknown";

export type FleetMachineRegistration = {
  machine: FleetMachineIdentity;
  label: string;
  connection: FleetMachineConnection;
  capabilities: readonly string[];
  serverObservedAtMs: number;
};

export type FleetMachineState = {
  machine: FleetMachineIdentity;
  label: string;
  connection: FleetMachineConnection;
  capabilities: string[];
  createdAtMs: number;
  updatedAtMs: number;
  latestCollectedAtMs: number | null;
  freshestAtMs: number | null;
  lastError: string | null;
  lastErrorAtMs: number | null;
  generation: TimelineGeneration;
};

export type FleetMetricObservation = ReturnType<typeof metricObservationSchema.parse>;
export type FleetTimelineEvent = ReturnType<typeof timelineEventSchema.parse>;

export type FleetMetricValue = {
  atMs: number;
  collectorSessionId: string;
  sequence: number;
  observation: FleetMetricObservation;
};

export type FleetMachineError = {
  errorId: string;
  occurredAtMs: number;
  kind: string;
  message: string;
};

export type FleetDirectoryDetail = DirectorySample;
export type FleetMemoryDetail = MemoryDiagnostics;
export type FleetMachineInventory = {
  inventory: MachineInventoryPayload;
  receivedAtMs: number;
  lastError: string | null;
  lastErrorAtMs: number | null;
};
/**
 * The memory lane has its own cadence and sequence, so it cannot reuse a
 * core collection identity. Keep its privacy-safe catalog values separate
 * from the optional process-detail payload retained in FleetMemoryDetail.
 */
export type FleetMemoryObservation = {
  collectorSessionId: string;
  sequence: number;
  hostObservedAtMs: number;
  serverSentAtMs: number;
  serverReceivedAtMs: number;
  normalizedAtMs: number;
  clockUncertaintyMs: number;
  pressureSomePercent: number | null;
  pressureFullPercent: number | null;
  swapInPagesPerSecond: number | null;
  swapOutPagesPerSecond: number | null;
};

export type FleetPruneResult = {
  collections: number;
  metrics: number;
  directories: number;
  memory: number;
  memoryObservations: number;
  events: number;
  errors: number;
  affectedMachines: number;
};

type MachineRow = {
  machineSource: string;
  machineId: string;
  label: string;
  connection: FleetMachineConnection;
  capabilitiesJson: string;
  createdAtMs: number;
  updatedAtMs: number;
  latestCollectedAtMs: number | null;
  freshestAtMs: number | null;
  lastError: string | null;
  lastErrorAtMs: number | null;
  dataRevision: number;
  settingsRevision: number;
};

type CollectionRow = {
  collectorSessionId: string;
  sequence: number;
  hostObservedAtMs: number;
  serverSentAtMs: number;
  serverReceivedAtMs: number;
  normalizedAtMs: number;
  clockUncertaintyMs: number;
};

type MetricRow = {
  normalizedAtMs: number;
  collectorSessionId: string;
  sequence: number;
  metricId: FleetMetricId;
  value: number | null;
  availabilityState: "available" | "unavailable" | "not-collected";
  availabilityReason: string | null;
};

type EventRow = { eventJson: string };
type InventoryRow = {
  collectorSessionId: string;
  hostObservedAtMs: number;
  serverReceivedAtMs: number;
  payloadJson: string;
  lastError: string | null;
  lastErrorAtMs: number | null;
};

const CONTROL_CHARACTER = /\p{Cc}/u;
const MAX_CAPABILITIES = 32;
const MAX_CAPABILITY_LENGTH = 96;
const MAX_DIRECTORY_LOCATION_LENGTH = 512;
const MAX_MEMORY_PROCESSES = 64;
const MAX_MEMORY_JSON_BYTES = 64 * 1024;
const MAX_ERROR_ID_LENGTH = 128;
const MAX_ERROR_KIND_LENGTH = 96;
const MAX_ERROR_MESSAGE_LENGTH = 1_024;

function assertSafeTimestamp(value: unknown, name: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a nonnegative safe integer.`);
}

function assertNonnegativeNumber(value: unknown, name: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`${name} must be a finite nonnegative number.`);
}

function assertBoundedText(value: unknown, name: string, maxLength: number): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || value.trim().length === 0 || CONTROL_CHARACTER.test(value)) {
    throw new Error(`${name} must be nonblank, bounded text without control characters.`);
  }
}

function canonicalValue(value: unknown): unknown {
  if (value == null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("A durable fleet payload contains a non-finite number.");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(object).sort()) result[key] = canonicalValue(object[key]);
    return result;
  }
  throw new Error("A durable fleet payload contains an unsupported value.");
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function parseCapabilities(value: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (cause) {
    throw new Error(`Machine capabilities are corrupt: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) throw new Error("Machine capabilities are corrupt.");
  return parsed as string[];
}

function rowMachine(row: MachineRow): FleetMachineState {
  return {
    machine: machineIdentitySchema.parse({ source: row.machineSource, machineId: row.machineId }),
    label: row.label,
    connection: row.connection,
    capabilities: parseCapabilities(row.capabilitiesJson),
    createdAtMs: row.createdAtMs,
    updatedAtMs: row.updatedAtMs,
    latestCollectedAtMs: row.latestCollectedAtMs,
    freshestAtMs: row.freshestAtMs,
    lastError: row.lastError,
    lastErrorAtMs: row.lastErrorAtMs,
    generation: { dataRevision: row.dataRevision, settingsRevision: row.settingsRevision },
  };
}

function metricOrder(metricId: FleetMetricId): number {
  return FLEET_METRIC_CATALOG.findIndex((entry) => entry.id === metricId);
}

function eventBounds(event: FleetTimelineEvent): { startMs: number; endMs: number } {
  return event.time.kind === "instant"
    ? { startMs: event.time.atMs, endMs: event.time.atMs }
    : { startMs: event.time.startMs, endMs: event.time.endMs };
}

function validateRegistration(input: FleetMachineRegistration): FleetMachineRegistration & { capabilitiesJson: string } {
  const machine = machineIdentitySchema.parse(input.machine);
  assertBoundedText(input.label, "machine label", 256);
  if (!(["local", "connected", "disconnected", "unknown"] as const).includes(input.connection)) {
    throw new Error("machine connection is invalid.");
  }
  if ((machine.source === "local-bb-server") !== (input.connection === "local")) {
    throw new Error("only the reserved local BB server may use the local connection state.");
  }
  if (!Array.isArray(input.capabilities) || input.capabilities.length > MAX_CAPABILITIES) {
    throw new Error(`machine capabilities must contain at most ${MAX_CAPABILITIES} entries.`);
  }
  const capabilities = [...input.capabilities];
  for (const capability of capabilities) assertBoundedText(capability, "machine capability", MAX_CAPABILITY_LENGTH);
  capabilities.sort();
  if (new Set(capabilities).size !== capabilities.length) throw new Error("machine capabilities must be unique.");
  assertSafeTimestamp(input.serverObservedAtMs, "serverObservedAtMs");
  return { ...input, machine, capabilities, capabilitiesJson: canonicalJson(capabilities) };
}

function validateDirectory(detail: FleetDirectoryDetail): void {
  assertSafeTimestamp(detail.collectedAt, "directory collectedAt");
  assertBoundedText(detail.location, "directory location", MAX_DIRECTORY_LOCATION_LENGTH);
  if (!Number.isSafeInteger(detail.bytes) || detail.bytes < 0) throw new Error("directory bytes must be a nonnegative safe integer.");
  if (typeof detail.onRootFilesystem !== "boolean" || typeof detail.partial !== "boolean") {
    throw new Error("directory filesystem and partial flags must be boolean.");
  }
}

function validateMemoryDiagnostic(diagnostic: FleetMemoryDetail): void {
  assertSafeTimestamp(diagnostic.collectedAt, "memory diagnostic collectedAt");
  if (diagnostic.processDetailsCollectedAt != null) assertSafeTimestamp(diagnostic.processDetailsCollectedAt, "memory processDetailsCollectedAt");
  if (diagnostic.sampleIntervalMs != null && (!Number.isSafeInteger(diagnostic.sampleIntervalMs) || diagnostic.sampleIntervalMs < 0)) {
    throw new Error("memory sampleIntervalMs must be a nonnegative safe integer or null.");
  }
  const metrics: Array<[string, number | null]> = [
    ["pressureSomePercent", diagnostic.pressureSomePercent],
    ["pressureFullPercent", diagnostic.pressureFullPercent],
    ["swapInPagesPerSecond", diagnostic.swapInPagesPerSecond],
    ["swapOutPagesPerSecond", diagnostic.swapOutPagesPerSecond],
    ["refaultPagesPerSecond", diagnostic.refaultPagesPerSecond],
    ["reclaimPagesPerSecond", diagnostic.reclaimPagesPerSecond],
    ["bbCgroupMemoryBytes", diagnostic.bbCgroupMemoryBytes],
  ];
  for (const [name, value] of metrics) if (value != null) assertNonnegativeNumber(value, `memory ${name}`);
  if (!Array.isArray(diagnostic.processes) || diagnostic.processes.length > MAX_MEMORY_PROCESSES) {
    throw new Error(`memory diagnostics must contain at most ${MAX_MEMORY_PROCESSES} process entries.`);
  }
  for (const process of diagnostic.processes) {
    if (!Number.isSafeInteger(process.pid) || process.pid < 0 || !Number.isSafeInteger(process.startTime) || process.startTime < 0) {
      throw new Error("memory process identity is invalid.");
    }
    assertBoundedText(process.name, "memory process name", 256);
    assertBoundedText(process.workload, "memory process workload", 256);
    if (process.workloadDetail != null) assertBoundedText(process.workloadDetail, "memory process workload detail", 512);
    const values: Array<[string, number | null]> = [
      ["rssBytes", process.rssBytes],
      ["minorFaultsPerSecond", process.minorFaultsPerSecond],
      ["majorFaultsPerSecond", process.majorFaultsPerSecond],
    ];
    for (const [name, value] of values) if (value != null) assertNonnegativeNumber(value, `memory process ${name}`);
    if (process.rssDeltaBytes != null && (typeof process.rssDeltaBytes !== "number" || !Number.isFinite(process.rssDeltaBytes))) {
      throw new Error("memory process rssDeltaBytes must be a finite number or null.");
    }
  }
  if (Buffer.byteLength(canonicalJson(diagnostic.processes), "utf8") > MAX_MEMORY_JSON_BYTES) {
    throw new Error("memory process diagnostics exceed the durable payload bound.");
  }
}

function validateMemoryObservation(observation: FleetMemoryObservation): void {
  assertBoundedText(observation.collectorSessionId, "memory collector session ID", 128);
  if (!Number.isSafeInteger(observation.sequence) || observation.sequence < 0) {
    throw new Error("memory sequence must be a nonnegative safe integer.");
  }
  assertSafeTimestamp(observation.hostObservedAtMs, "memory hostObservedAtMs");
  assertSafeTimestamp(observation.serverSentAtMs, "memory serverSentAtMs");
  assertSafeTimestamp(observation.serverReceivedAtMs, "memory serverReceivedAtMs");
  assertSafeTimestamp(observation.normalizedAtMs, "memory normalizedAtMs");
  assertSafeTimestamp(observation.clockUncertaintyMs, "memory clockUncertaintyMs");
  if (observation.serverReceivedAtMs < observation.serverSentAtMs) {
    throw new Error("memory serverReceivedAtMs must not precede serverSentAtMs.");
  }
  if (observation.normalizedAtMs < observation.serverSentAtMs || observation.normalizedAtMs > observation.serverReceivedAtMs) {
    throw new Error("memory normalizedAtMs must be chosen by the server inside its request/response interval.");
  }
  if (observation.clockUncertaintyMs > 60 * 60_000) {
    throw new Error("memory clockUncertaintyMs exceeds the bounded fleet clock uncertainty.");
  }
  const metrics: Array<[string, number | null]> = [
    ["pressureSomePercent", observation.pressureSomePercent],
    ["pressureFullPercent", observation.pressureFullPercent],
    ["swapInPagesPerSecond", observation.swapInPagesPerSecond],
    ["swapOutPagesPerSecond", observation.swapOutPagesPerSecond],
  ];
  for (const [name, value] of metrics) if (value != null) assertNonnegativeNumber(value, `memory observation ${name}`);
}

function metricFromRow(row: MetricRow): FleetMetricObservation {
  return metricObservationSchema.parse({
    metricId: row.metricId,
    value: row.value,
    availability: { state: row.availabilityState, reason: row.availabilityReason },
  });
}

/**
 * Central durable truth for the local BB server and every authenticated host.
 * The coordinator must register identities from its own host directory before
 * writing payloads; collection payloads themselves never create machines.
 */
export class FleetStore {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  private findMachine(machine: FleetMachineIdentity): MachineRow | null {
    const parsed = machineIdentitySchema.parse(machine);
    return this.db.prepare(`SELECT machine_source AS machineSource, machine_id AS machineId,
      label, connection, capabilities_json AS capabilitiesJson, created_at AS createdAtMs,
      updated_at AS updatedAtMs, last_collected_at AS latestCollectedAtMs,
      last_fresh_at AS freshestAtMs, last_error AS lastError, last_error_at AS lastErrorAtMs,
      data_revision AS dataRevision, settings_revision AS settingsRevision
      FROM machine_monitor_fleet_machines WHERE machine_source = ? AND machine_id = ?`)
      .get(parsed.source, parsed.machineId) as MachineRow | undefined ?? null;
  }

  private requireMachine(machine: FleetMachineIdentity): MachineRow {
    const row = this.findMachine(machine);
    if (row == null) throw new Error("Fleet machine is not registered by the server.");
    return row;
  }

  private bumpDataRevision(machine: FleetMachineIdentity): TimelineGeneration {
    this.db.prepare(`UPDATE machine_monitor_fleet_machines
      SET data_revision = data_revision + 1 WHERE machine_source = ? AND machine_id = ?`)
      .run(machine.source, machine.machineId);
    this.db.prepare("UPDATE machine_monitor_fleet_state SET data_revision = data_revision + 1 WHERE singleton = 1").run();
    return this.generation(machine);
  }

  private bumpSettingsRevision(machine: FleetMachineIdentity): TimelineGeneration {
    this.db.prepare(`UPDATE machine_monitor_fleet_machines
      SET settings_revision = settings_revision + 1 WHERE machine_source = ? AND machine_id = ?`)
      .run(machine.source, machine.machineId);
    this.db.prepare("UPDATE machine_monitor_fleet_state SET settings_revision = settings_revision + 1 WHERE singleton = 1").run();
    return this.generation(machine);
  }

  registerMachine(input: FleetMachineRegistration): { changed: boolean; machine: FleetMachineState } {
    const registration = validateRegistration(input);
    return this.db.transaction((entry: typeof registration) => {
      const existing = this.findMachine(entry.machine);
      if (existing == null) {
        const count = (this.db.prepare("SELECT COUNT(*) AS count FROM machine_monitor_fleet_machines").get() as { count: number }).count;
        if (count >= MAX_FLEET_MACHINES) throw new Error(`fleet registry may contain at most ${MAX_FLEET_MACHINES} machines.`);
        this.db.prepare(`INSERT INTO machine_monitor_fleet_machines
          (machine_source, machine_id, label, connection, capabilities_json, created_at, updated_at,
           last_collected_at, last_fresh_at, last_error, last_error_at, data_revision, settings_revision)
          VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, 0, 0)`)
          .run(entry.machine.source, entry.machine.machineId, entry.label, entry.connection, entry.capabilitiesJson, entry.serverObservedAtMs, entry.serverObservedAtMs);
        this.bumpDataRevision(entry.machine);
        return { changed: true, machine: this.machine(entry.machine)! };
      }
      const changed = existing.label !== entry.label || existing.connection !== entry.connection || existing.capabilitiesJson !== entry.capabilitiesJson;
      if (changed) {
        this.db.prepare(`UPDATE machine_monitor_fleet_machines SET label = ?, connection = ?,
          capabilities_json = ?, updated_at = ? WHERE machine_source = ? AND machine_id = ?`)
          .run(entry.label, entry.connection, entry.capabilitiesJson, entry.serverObservedAtMs, entry.machine.source, entry.machine.machineId);
        this.bumpDataRevision(entry.machine);
      }
      return { changed, machine: this.machine(entry.machine)! };
    })(registration);
  }

  machine(machine: FleetMachineIdentity): FleetMachineState | null {
    const row = this.findMachine(machine);
    return row == null ? null : rowMachine(row);
  }

  machines(): FleetMachineState[] {
    const rows = this.db.prepare(`SELECT machine_source AS machineSource, machine_id AS machineId,
      label, connection, capabilities_json AS capabilitiesJson, created_at AS createdAtMs,
      updated_at AS updatedAtMs, last_collected_at AS latestCollectedAtMs,
      last_fresh_at AS freshestAtMs, last_error AS lastError, last_error_at AS lastErrorAtMs,
      data_revision AS dataRevision, settings_revision AS settingsRevision
      FROM machine_monitor_fleet_machines ORDER BY machine_source ASC, machine_id ASC`).all() as MachineRow[];
    return rows.map(rowMachine);
  }

  generation(machine: FleetMachineIdentity): TimelineGeneration {
    const row = this.requireMachine(machine);
    return { dataRevision: row.dataRevision, settingsRevision: row.settingsRevision };
  }

  fleetGeneration(): TimelineGeneration {
    const row = this.db.prepare(`SELECT data_revision AS dataRevision, settings_revision AS settingsRevision
      FROM machine_monitor_fleet_state WHERE singleton = 1`).get() as TimelineGeneration | undefined;
    if (row == null) throw new Error("Fleet generation state is missing.");
    return row;
  }

  advanceSettingsGeneration(machine: FleetMachineIdentity): TimelineGeneration {
    const parsed = machineIdentitySchema.parse(machine);
    return this.db.transaction(() => {
      this.requireMachine(parsed);
      return this.bumpSettingsRevision(parsed);
    })();
  }

  /**
   * Store one latest low-churn inventory snapshot per authenticated machine.
   * Its digest intentionally excludes request timing and collector session, so
   * routine refreshes do not churn fleet/UI revisions.
   */
  recordInventory(input: MachineInventoryEnvelope): { outcome: "inserted" | "changed" | "unchanged"; generation: TimelineGeneration } {
    const envelope = machineInventoryEnvelopeSchema.parse(input);
    const payloadJson = canonicalJson(envelope.inventory);
    const payloadDigest = digest({
      visibility: envelope.inventory.visibility,
      os: envelope.inventory.os,
      cpu: envelope.inventory.cpu,
      memory: envelope.inventory.memory,
      disks: envelope.inventory.disks,
      disksAvailability: envelope.inventory.disksAvailability,
      raid: envelope.inventory.raid,
      location: envelope.inventory.location,
      limitations: envelope.inventory.limitations,
    });
    return this.db.transaction((entry: MachineInventoryEnvelope) => {
      this.requireMachine(entry.machine);
      const existing = this.db.prepare(`SELECT payload_digest AS payloadDigest, last_error AS lastError
        FROM machine_monitor_fleet_inventory WHERE machine_source = ? AND machine_id = ?`)
        .get(entry.machine.source, entry.machine.machineId) as { payloadDigest: string; lastError: string | null } | undefined;
      if (existing == null) {
        this.db.prepare(`INSERT INTO machine_monitor_fleet_inventory
          (machine_source, machine_id, collector_session_id, host_observed_at, server_sent_at, server_received_at,
           payload_digest, payload_json, last_error, last_error_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`)
          .run(entry.machine.source, entry.machine.machineId, entry.inventory.collectorSessionId, entry.inventory.observedAtMs,
            entry.serverSentAtMs, entry.serverReceivedAtMs, payloadDigest, payloadJson);
        return { outcome: "inserted" as const, generation: this.bumpDataRevision(entry.machine) };
      }
      const changed = existing.payloadDigest !== payloadDigest || existing.lastError != null;
      this.db.prepare(`UPDATE machine_monitor_fleet_inventory SET collector_session_id = ?, host_observed_at = ?,
        server_sent_at = ?, server_received_at = ?, payload_digest = ?, payload_json = ?, last_error = NULL, last_error_at = NULL
        WHERE machine_source = ? AND machine_id = ?`)
        .run(entry.inventory.collectorSessionId, entry.inventory.observedAtMs, entry.serverSentAtMs, entry.serverReceivedAtMs,
          payloadDigest, payloadJson, entry.machine.source, entry.machine.machineId);
      return { outcome: changed ? "changed" as const : "unchanged" as const, generation: changed ? this.bumpDataRevision(entry.machine) : this.generation(entry.machine) };
    })(envelope);
  }

  recordInventoryFailure(machine: FleetMachineIdentity, message: string, occurredAtMs: number): { changed: boolean; generation: TimelineGeneration } {
    const parsed = machineIdentitySchema.parse(machine);
    assertBoundedText(message, "inventory error", MAX_ERROR_MESSAGE_LENGTH);
    assertSafeTimestamp(occurredAtMs, "inventory error time");
    return this.db.transaction(() => {
      this.requireMachine(parsed);
      const result = this.db.prepare(`UPDATE machine_monitor_fleet_inventory SET last_error = ?, last_error_at = ?
        WHERE machine_source = ? AND machine_id = ? AND (last_error IS NULL OR last_error <> ? OR last_error_at <> ?)`)
        .run(message, occurredAtMs, parsed.source, parsed.machineId, message, occurredAtMs);
      const changed = result.changes > 0;
      return { changed, generation: changed ? this.bumpDataRevision(parsed) : this.generation(parsed) };
    })();
  }

  inventory(machine: FleetMachineIdentity): FleetMachineInventory | null {
    const parsed = machineIdentitySchema.parse(machine);
    const row = this.db.prepare(`SELECT collector_session_id AS collectorSessionId, host_observed_at AS hostObservedAtMs,
      server_received_at AS serverReceivedAtMs, payload_json AS payloadJson, last_error AS lastError, last_error_at AS lastErrorAtMs
      FROM machine_monitor_fleet_inventory WHERE machine_source = ? AND machine_id = ?`)
      .get(parsed.source, parsed.machineId) as InventoryRow | undefined;
    if (row == null) return null;
    let inventory: unknown;
    try {
      inventory = JSON.parse(row.payloadJson);
    } catch (cause) {
      throw new Error(`Machine inventory is corrupt: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
    return {
      inventory: machineInventoryPayloadSchema.parse(inventory),
      receivedAtMs: row.serverReceivedAtMs,
      lastError: row.lastError,
      lastErrorAtMs: row.lastErrorAtMs,
    };
  }

  recordCollection(input: FleetCollectionEnvelope): { outcome: "inserted" | "duplicate"; generation: TimelineGeneration } {
    const envelope = collectionEnvelopeSchema.parse(input);
    if (envelope.normalizedAtMs < envelope.serverSentAtMs || envelope.normalizedAtMs > envelope.serverReceivedAtMs) {
      throw new Error("normalized collection time must be chosen by the server inside its request/response interval.");
    }
    const payloadJson = canonicalJson(envelope);
    const payloadDigest = digest(envelope);
    return this.db.transaction((entry: FleetCollectionEnvelope) => {
      this.requireMachine(entry.machine);
      const existing = this.db.prepare(`SELECT payload_digest AS payloadDigest
        FROM machine_monitor_fleet_collections WHERE machine_source = ? AND machine_id = ?
          AND collector_session_id = ? AND sequence = ?`)
        .get(entry.machine.source, entry.machine.machineId, entry.collectorSessionId, entry.sequence) as { payloadDigest: string } | undefined;
      if (existing != null) {
        if (existing.payloadDigest !== payloadDigest) throw new Error("A collector session/sequence was reused with a different payload.");
        return { outcome: "duplicate" as const, generation: this.generation(entry.machine) };
      }
      const newer = this.db.prepare(`SELECT 1 FROM machine_monitor_fleet_collections
        WHERE machine_source = ? AND machine_id = ? AND collector_session_id = ? AND sequence > ? LIMIT 1`)
        .get(entry.machine.source, entry.machine.machineId, entry.collectorSessionId, entry.sequence);
      if (newer != null) throw new Error("A collector session cannot persist an out-of-order sequence.");
      this.db.prepare(`INSERT INTO machine_monitor_fleet_collections
        (machine_source, machine_id, collector_session_id, sequence, host_observed_at,
         server_sent_at, server_received_at, normalized_at, clock_uncertainty_ms, payload_digest, payload_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(entry.machine.source, entry.machine.machineId, entry.collectorSessionId, entry.sequence,
          entry.hostObservedAtMs, entry.serverSentAtMs, entry.serverReceivedAtMs, entry.normalizedAtMs,
          entry.clockUncertaintyMs, payloadDigest, payloadJson);
      const insertMetric = this.db.prepare(`INSERT INTO machine_monitor_fleet_metric_values
        (machine_source, machine_id, collector_session_id, sequence, normalized_at, metric_id,
         value, availability_state, availability_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const observation of entry.metrics) {
        insertMetric.run(entry.machine.source, entry.machine.machineId, entry.collectorSessionId, entry.sequence,
          entry.normalizedAtMs, observation.metricId, observation.value, observation.availability.state, observation.availability.reason);
      }
      this.db.prepare(`UPDATE machine_monitor_fleet_machines SET
        last_collected_at = CASE WHEN last_collected_at IS NULL OR last_collected_at < ? THEN ? ELSE last_collected_at END,
        last_fresh_at = CASE WHEN last_fresh_at IS NULL OR last_fresh_at < ? THEN ? ELSE last_fresh_at END,
        last_error = CASE WHEN last_error_at IS NULL OR last_error_at <= ? THEN NULL ELSE last_error END,
        last_error_at = CASE WHEN last_error_at IS NULL OR last_error_at <= ? THEN NULL ELSE last_error_at END,
        updated_at = MAX(updated_at, ?)
        WHERE machine_source = ? AND machine_id = ?`)
        .run(entry.normalizedAtMs, entry.normalizedAtMs, entry.normalizedAtMs, entry.normalizedAtMs,
          entry.normalizedAtMs, entry.normalizedAtMs, entry.serverReceivedAtMs, entry.machine.source, entry.machine.machineId);
      return { outcome: "inserted" as const, generation: this.bumpDataRevision(entry.machine) };
    })(envelope);
  }

  collections(machine: FleetMachineIdentity, sinceMs: number, untilMs: number): FleetCollectionEnvelope[] {
    const parsed = machineIdentitySchema.parse(machine);
    assertSafeTimestamp(sinceMs, "collection sinceMs");
    assertSafeTimestamp(untilMs, "collection untilMs");
    if (untilMs < sinceMs) throw new Error("collection untilMs must not precede sinceMs.");
    this.requireMachine(parsed);
    const rows = this.db.prepare(`SELECT collector_session_id AS collectorSessionId, sequence,
      host_observed_at AS hostObservedAtMs, server_sent_at AS serverSentAtMs,
      server_received_at AS serverReceivedAtMs, normalized_at AS normalizedAtMs,
      clock_uncertainty_ms AS clockUncertaintyMs
      FROM machine_monitor_fleet_collections WHERE machine_source = ? AND machine_id = ?
        AND normalized_at BETWEEN ? AND ?
      ORDER BY normalized_at ASC, collector_session_id ASC, sequence ASC`)
      .all(parsed.source, parsed.machineId, sinceMs, untilMs) as CollectionRow[];
    const metrics = this.db.prepare(`SELECT normalized_at AS normalizedAtMs,
      collector_session_id AS collectorSessionId, sequence, metric_id AS metricId, value,
      availability_state AS availabilityState, availability_reason AS availabilityReason
      FROM machine_monitor_fleet_metric_values WHERE machine_source = ? AND machine_id = ?
        AND collector_session_id = ? AND sequence = ? ORDER BY metric_id ASC`);
    return rows.map((row) => collectionEnvelopeSchema.parse({
      machine: parsed,
      contractVersion: FLEET_CONTRACT_VERSION,
      ...row,
      metrics: (metrics.all(parsed.source, parsed.machineId, row.collectorSessionId, row.sequence) as MetricRow[])
        .map(metricFromRow)
        .sort((left, right) => metricOrder(left.metricId) - metricOrder(right.metricId)),
    }));
  }

  metricValues(machine: FleetMachineIdentity, sinceMs: number, untilMs: number): FleetMetricValue[] {
    const parsed = machineIdentitySchema.parse(machine);
    assertSafeTimestamp(sinceMs, "metric sinceMs");
    assertSafeTimestamp(untilMs, "metric untilMs");
    if (untilMs < sinceMs) throw new Error("metric untilMs must not precede sinceMs.");
    this.requireMachine(parsed);
    const rows = this.db.prepare(`SELECT normalized_at AS normalizedAtMs,
      collector_session_id AS collectorSessionId, sequence, metric_id AS metricId, value,
      availability_state AS availabilityState, availability_reason AS availabilityReason
      FROM machine_monitor_fleet_metric_values WHERE machine_source = ? AND machine_id = ?
        AND normalized_at BETWEEN ? AND ?
      ORDER BY normalized_at ASC, collector_session_id ASC, sequence ASC, metric_id ASC`)
      .all(parsed.source, parsed.machineId, sinceMs, untilMs) as MetricRow[];
    return rows.map((row) => ({
      atMs: row.normalizedAtMs,
      collectorSessionId: row.collectorSessionId,
      sequence: row.sequence,
      observation: metricFromRow(row),
    }));
  }

  latestMetrics(machine: FleetMachineIdentity): FleetMetricObservation[] {
    const parsed = machineIdentitySchema.parse(machine);
    this.requireMachine(parsed);
    const rows = this.db.prepare(`SELECT normalized_at AS normalizedAtMs,
      collector_session_id AS collectorSessionId, sequence, metric_id AS metricId, value,
      availability_state AS availabilityState, availability_reason AS availabilityReason
      FROM machine_monitor_fleet_metric_values WHERE machine_source = ? AND machine_id = ?
      ORDER BY normalized_at DESC, collector_session_id DESC, sequence DESC, metric_id ASC`)
      .all(parsed.source, parsed.machineId) as MetricRow[];
    const latest = new Map<FleetMetricId, FleetMetricObservation>();
    for (const row of rows) if (!latest.has(row.metricId)) latest.set(row.metricId, metricFromRow(row));
    return [...latest.values()].sort((left, right) => metricOrder(left.metricId) - metricOrder(right.metricId));
  }

  recordDirectoryDetails(machine: FleetMachineIdentity, details: readonly FleetDirectoryDetail[]): { inserted: number; duplicate: number; generation: TimelineGeneration } {
    const parsed = machineIdentitySchema.parse(machine);
    if (details.length > MAX_REPORTED_DIRECTORIES) {
      throw new Error(`directory detail batches may contain at most ${MAX_REPORTED_DIRECTORIES} entries.`);
    }
    for (const detail of details) validateDirectory(detail);
    const identities = new Set<string>();
    for (const detail of details) {
      const identity = `${detail.collectedAt}\u0000${detail.location}`;
      if (identities.has(identity)) throw new Error("directory detail batch contains duplicate location/time identities.");
      identities.add(identity);
    }
    return this.db.transaction((entries: readonly FleetDirectoryDetail[]) => {
      this.requireMachine(parsed);
      let inserted = 0;
      let duplicate = 0;
      for (const detail of entries) {
        const payloadDigest = digest(detail);
        const existing = this.db.prepare(`SELECT payload_digest AS payloadDigest
          FROM machine_monitor_fleet_directory_details WHERE machine_source = ? AND machine_id = ?
            AND collected_at = ? AND location = ?`).get(parsed.source, parsed.machineId, detail.collectedAt, detail.location) as { payloadDigest: string } | undefined;
        if (existing != null) {
          if (existing.payloadDigest !== payloadDigest) throw new Error("A directory detail identity was reused with a different payload.");
          duplicate += 1;
          continue;
        }
        this.db.prepare(`INSERT INTO machine_monitor_fleet_directory_details
          (machine_source, machine_id, collected_at, location, bytes, on_root_filesystem, partial, payload_digest)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(parsed.source, parsed.machineId, detail.collectedAt,
          detail.location, detail.bytes, detail.onRootFilesystem ? 1 : 0, detail.partial ? 1 : 0, payloadDigest);
        inserted += 1;
      }
      const generation = inserted === 0 ? this.generation(parsed) : this.bumpDataRevision(parsed);
      return { inserted, duplicate, generation };
    })(details);
  }

  directoryDetails(machine: FleetMachineIdentity, sinceMs: number, untilMs: number): FleetDirectoryDetail[] {
    const parsed = machineIdentitySchema.parse(machine);
    assertSafeTimestamp(sinceMs, "directory sinceMs");
    assertSafeTimestamp(untilMs, "directory untilMs");
    if (untilMs < sinceMs) throw new Error("directory untilMs must not precede sinceMs.");
    this.requireMachine(parsed);
    const rows = this.db.prepare(`SELECT collected_at AS collectedAt, location, bytes,
      on_root_filesystem AS onRootFilesystem, partial FROM machine_monitor_fleet_directory_details
      WHERE machine_source = ? AND machine_id = ? AND collected_at BETWEEN ? AND ?
      ORDER BY collected_at ASC, location ASC`).all(parsed.source, parsed.machineId, sinceMs, untilMs) as Array<{ collectedAt: number; location: string; bytes: number; onRootFilesystem: number; partial: number }>;
    return rows.map((row) => ({ ...row, onRootFilesystem: row.onRootFilesystem === 1, partial: row.partial === 1 }));
  }

  private insertMemoryDetail(machine: FleetMachineIdentity, detail: FleetMemoryDetail, payloadDigest: string, processesJson: string): "inserted" | "duplicate" {
    const existing = this.db.prepare(`SELECT payload_digest AS payloadDigest
      FROM machine_monitor_fleet_memory_details WHERE machine_source = ? AND machine_id = ? AND collected_at = ?`)
      .get(machine.source, machine.machineId, detail.collectedAt) as { payloadDigest: string } | undefined;
    if (existing != null) {
      if (existing.payloadDigest !== payloadDigest) throw new Error("A memory detail timestamp was reused with a different payload.");
      return "duplicate";
    }
    this.db.prepare(`INSERT INTO machine_monitor_fleet_memory_details
      (machine_source, machine_id, collected_at, sample_interval_ms, pressure_some_percent,
       pressure_full_percent, swap_in_pages_per_second, swap_out_pages_per_second,
       refault_pages_per_second, reclaim_pages_per_second, bb_cgroup_memory_bytes,
       processes_json, process_details_collected_at, payload_digest)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(machine.source, machine.machineId, detail.collectedAt, detail.sampleIntervalMs,
        detail.pressureSomePercent, detail.pressureFullPercent, detail.swapInPagesPerSecond,
        detail.swapOutPagesPerSecond, detail.refaultPagesPerSecond, detail.reclaimPagesPerSecond,
        detail.bbCgroupMemoryBytes, processesJson, detail.processDetailsCollectedAt, payloadDigest);
    return "inserted";
  }

  private insertMemoryObservation(machine: FleetMachineIdentity, observation: FleetMemoryObservation, payloadDigest: string): "inserted" | "duplicate" {
    const existing = this.db.prepare(`SELECT payload_digest AS payloadDigest
      FROM machine_monitor_fleet_memory_observations WHERE machine_source = ? AND machine_id = ?
        AND collector_session_id = ? AND sequence = ?`)
      .get(machine.source, machine.machineId, observation.collectorSessionId, observation.sequence) as { payloadDigest: string } | undefined;
    if (existing != null) {
      if (existing.payloadDigest !== payloadDigest) throw new Error("A memory collector session/sequence was reused with a different payload.");
      return "duplicate";
    }
    const newer = this.db.prepare(`SELECT 1 FROM machine_monitor_fleet_memory_observations
      WHERE machine_source = ? AND machine_id = ? AND collector_session_id = ? AND sequence > ? LIMIT 1`)
      .get(machine.source, machine.machineId, observation.collectorSessionId, observation.sequence);
    if (newer != null) throw new Error("A memory collector session cannot persist an out-of-order sequence.");
    this.db.prepare(`INSERT INTO machine_monitor_fleet_memory_observations
      (machine_source, machine_id, collector_session_id, sequence, host_observed_at,
       server_sent_at, server_received_at, normalized_at, clock_uncertainty_ms,
       pressure_some_percent, pressure_full_percent, swap_in_pages_per_second,
       swap_out_pages_per_second, payload_digest)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(machine.source, machine.machineId, observation.collectorSessionId, observation.sequence,
        observation.hostObservedAtMs, observation.serverSentAtMs, observation.serverReceivedAtMs,
        observation.normalizedAtMs, observation.clockUncertaintyMs, observation.pressureSomePercent,
        observation.pressureFullPercent, observation.swapInPagesPerSecond,
        observation.swapOutPagesPerSecond, payloadDigest);
    return "inserted";
  }

  recordMemoryDetail(machine: FleetMachineIdentity, detail: FleetMemoryDetail): { outcome: "inserted" | "duplicate"; generation: TimelineGeneration } {
    const parsed = machineIdentitySchema.parse(machine);
    validateMemoryDiagnostic(detail);
    const payloadDigest = digest(detail);
    const processesJson = canonicalJson(detail.processes);
    return this.db.transaction(() => {
      this.requireMachine(parsed);
      const outcome = this.insertMemoryDetail(parsed, detail, payloadDigest, processesJson);
      return { outcome, generation: outcome === "inserted" ? this.bumpDataRevision(parsed) : this.generation(parsed) };
    })();
  }

  recordMemoryObservation(machine: FleetMachineIdentity, observation: FleetMemoryObservation): { outcome: "inserted" | "duplicate"; generation: TimelineGeneration } {
    const parsed = machineIdentitySchema.parse(machine);
    validateMemoryObservation(observation);
    const payloadDigest = digest(observation);
    return this.db.transaction(() => {
      this.requireMachine(parsed);
      const outcome = this.insertMemoryObservation(parsed, observation, payloadDigest);
      return { outcome, generation: outcome === "inserted" ? this.bumpDataRevision(parsed) : this.generation(parsed) };
    })();
  }

  /** Commits the bounded timeline observation and private detail together. */
  recordMemory(
    machine: FleetMachineIdentity,
    observation: FleetMemoryObservation,
    detail: FleetMemoryDetail,
  ): {
    outcome: "inserted" | "duplicate";
    observationOutcome: "inserted" | "duplicate";
    detailOutcome: "inserted" | "duplicate";
    generation: TimelineGeneration;
  } {
    const parsed = machineIdentitySchema.parse(machine);
    validateMemoryObservation(observation);
    validateMemoryDiagnostic(detail);
    const observationDigest = digest(observation);
    const detailDigest = digest(detail);
    const processesJson = canonicalJson(detail.processes);
    return this.db.transaction(() => {
      this.requireMachine(parsed);
      const observationOutcome = this.insertMemoryObservation(parsed, observation, observationDigest);
      const detailOutcome = this.insertMemoryDetail(parsed, detail, detailDigest, processesJson);
      const outcome = observationOutcome === "inserted" || detailOutcome === "inserted" ? "inserted" as const : "duplicate" as const;
      return {
        outcome,
        observationOutcome,
        detailOutcome,
        generation: outcome === "inserted" ? this.bumpDataRevision(parsed) : this.generation(parsed),
      };
    })();
  }

  memoryDetails(machine: FleetMachineIdentity, sinceMs: number, untilMs: number): FleetMemoryDetail[] {
    const parsed = machineIdentitySchema.parse(machine);
    assertSafeTimestamp(sinceMs, "memory sinceMs");
    assertSafeTimestamp(untilMs, "memory untilMs");
    if (untilMs < sinceMs) throw new Error("memory untilMs must not precede sinceMs.");
    this.requireMachine(parsed);
    const rows = this.db.prepare(`SELECT collected_at AS collectedAt, sample_interval_ms AS sampleIntervalMs,
      pressure_some_percent AS pressureSomePercent, pressure_full_percent AS pressureFullPercent,
      swap_in_pages_per_second AS swapInPagesPerSecond, swap_out_pages_per_second AS swapOutPagesPerSecond,
      refault_pages_per_second AS refaultPagesPerSecond, reclaim_pages_per_second AS reclaimPagesPerSecond,
      bb_cgroup_memory_bytes AS bbCgroupMemoryBytes, processes_json AS processesJson,
      process_details_collected_at AS processDetailsCollectedAt
      FROM machine_monitor_fleet_memory_details WHERE machine_source = ? AND machine_id = ?
        AND collected_at BETWEEN ? AND ? ORDER BY collected_at ASC`)
      .all(parsed.source, parsed.machineId, sinceMs, untilMs) as Array<Omit<FleetMemoryDetail, "processes"> & { processesJson: string }>;
    return rows.map(({ processesJson, ...detail }) => {
      let processes: unknown;
      try {
        processes = JSON.parse(processesJson);
      } catch (cause) {
        throw new Error(`Memory detail is corrupt: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
      const result = { ...detail, processes } as FleetMemoryDetail;
      validateMemoryDiagnostic(result);
      return result;
    });
  }

  recordMachineError(machine: FleetMachineIdentity, error: FleetMachineError): { outcome: "inserted" | "duplicate"; generation: TimelineGeneration } {
    const parsed = machineIdentitySchema.parse(machine);
    assertBoundedText(error.errorId, "machine error ID", MAX_ERROR_ID_LENGTH);
    assertSafeTimestamp(error.occurredAtMs, "machine error time");
    assertBoundedText(error.kind, "machine error kind", MAX_ERROR_KIND_LENGTH);
    assertBoundedText(error.message, "machine error message", MAX_ERROR_MESSAGE_LENGTH);
    const payloadDigest = digest(error);
    return this.db.transaction((entry: FleetMachineError) => {
      this.requireMachine(parsed);
      const existing = this.db.prepare(`SELECT payload_digest AS payloadDigest FROM machine_monitor_fleet_errors
        WHERE machine_source = ? AND machine_id = ? AND error_id = ?`).get(parsed.source, parsed.machineId, entry.errorId) as { payloadDigest: string } | undefined;
      if (existing != null) {
        if (existing.payloadDigest !== payloadDigest) throw new Error("A machine error ID was reused with a different payload.");
        return { outcome: "duplicate" as const, generation: this.generation(parsed) };
      }
      this.db.prepare(`INSERT INTO machine_monitor_fleet_errors
        (machine_source, machine_id, error_id, occurred_at, kind, message, payload_digest)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(parsed.source, parsed.machineId, entry.errorId, entry.occurredAtMs, entry.kind, entry.message, payloadDigest);
      this.db.prepare(`UPDATE machine_monitor_fleet_machines SET
        last_error = CASE WHEN last_error_at IS NULL OR last_error_at <= ? THEN ? ELSE last_error END,
        last_error_at = CASE WHEN last_error_at IS NULL OR last_error_at <= ? THEN ? ELSE last_error_at END,
        updated_at = MAX(updated_at, ?) WHERE machine_source = ? AND machine_id = ?`)
        .run(entry.occurredAtMs, entry.message, entry.occurredAtMs, entry.occurredAtMs, entry.occurredAtMs, parsed.source, parsed.machineId);
      return { outcome: "inserted" as const, generation: this.bumpDataRevision(parsed) };
    })(error);
  }

  machineErrors(machine: FleetMachineIdentity, sinceMs: number, untilMs: number): FleetMachineError[] {
    const parsed = machineIdentitySchema.parse(machine);
    assertSafeTimestamp(sinceMs, "error sinceMs");
    assertSafeTimestamp(untilMs, "error untilMs");
    if (untilMs < sinceMs) throw new Error("error untilMs must not precede sinceMs.");
    this.requireMachine(parsed);
    return this.db.prepare(`SELECT error_id AS errorId, occurred_at AS occurredAtMs, kind, message
      FROM machine_monitor_fleet_errors WHERE machine_source = ? AND machine_id = ?
        AND occurred_at BETWEEN ? AND ? ORDER BY occurred_at ASC, error_id ASC`)
      .all(parsed.source, parsed.machineId, sinceMs, untilMs) as FleetMachineError[];
  }

  appendTimelineEvent(machine: FleetMachineIdentity, input: FleetTimelineEvent): { outcome: "inserted" | "duplicate"; generation: TimelineGeneration } {
    const parsed = machineIdentitySchema.parse(machine);
    const event = timelineEventSchema.parse(input);
    const bounds = eventBounds(event);
    const eventJson = canonicalJson(event);
    const payloadDigest = digest(event);
    return this.db.transaction((entry: FleetTimelineEvent) => {
      this.requireMachine(parsed);
      const existing = this.db.prepare(`SELECT payload_digest AS payloadDigest FROM machine_monitor_fleet_events
        WHERE machine_source = ? AND machine_id = ? AND producer_id = ? AND event_id = ?`)
        .get(parsed.source, parsed.machineId, entry.producer.id, entry.eventId) as { payloadDigest: string } | undefined;
      if (existing != null) {
        if (existing.payloadDigest !== payloadDigest) throw new Error("A timeline producer/event identity was reused with a different payload.");
        return { outcome: "duplicate" as const, generation: this.generation(parsed) };
      }
      this.db.prepare(`INSERT INTO machine_monitor_fleet_events
        (machine_source, machine_id, producer_id, event_id, contract_version, producer_version,
         event_start_at, event_end_at, payload_digest, event_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(parsed.source, parsed.machineId, entry.producer.id, entry.eventId, entry.contractVersion,
          entry.producer.version, bounds.startMs, bounds.endMs, payloadDigest, eventJson);
      return { outcome: "inserted" as const, generation: this.bumpDataRevision(parsed) };
    })(event);
  }

  timelineEvents(machine: FleetMachineIdentity, sinceMs: number, untilMs: number, limit = MAX_TIMELINE_EVENTS): { events: FleetTimelineEvent[]; totalCount: number; truncated: boolean } {
    const parsed = machineIdentitySchema.parse(machine);
    assertSafeTimestamp(sinceMs, "event sinceMs");
    assertSafeTimestamp(untilMs, "event untilMs");
    if (untilMs < sinceMs) throw new Error("event untilMs must not precede sinceMs.");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_TIMELINE_EVENTS) throw new Error(`event limit must be between 1 and ${MAX_TIMELINE_EVENTS}.`);
    this.requireMachine(parsed);
    const count = (this.db.prepare(`SELECT COUNT(*) AS count FROM machine_monitor_fleet_events
      WHERE machine_source = ? AND machine_id = ? AND event_end_at >= ? AND event_start_at <= ?`)
      .get(parsed.source, parsed.machineId, sinceMs, untilMs) as { count: number }).count;
    const rows = this.db.prepare(`SELECT event_json AS eventJson FROM machine_monitor_fleet_events
      WHERE machine_source = ? AND machine_id = ? AND event_end_at >= ? AND event_start_at <= ?
      ORDER BY event_start_at ASC, producer_id ASC, event_id ASC LIMIT ?`)
      .all(parsed.source, parsed.machineId, sinceMs, untilMs, limit) as EventRow[];
    const events = rows.map((row) => {
      try {
        return timelineEventSchema.parse(JSON.parse(row.eventJson));
      } catch (cause) {
        throw new Error(`Timeline event is corrupt: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    });
    return { events, totalCount: count, truncated: count > events.length };
  }

  prune(beforeMs: number): FleetPruneResult {
    assertSafeTimestamp(beforeMs, "retention beforeMs");
    return this.db.transaction((before: number) => {
      const affected = this.db.prepare(`SELECT machine_source AS machineSource, machine_id AS machineId FROM machine_monitor_fleet_collections WHERE normalized_at < ?
        UNION SELECT machine_source, machine_id FROM machine_monitor_fleet_metric_values WHERE normalized_at < ?
        UNION SELECT machine_source, machine_id FROM machine_monitor_fleet_directory_details WHERE collected_at < ?
        UNION SELECT machine_source, machine_id FROM machine_monitor_fleet_memory_details WHERE collected_at < ?
        UNION SELECT machine_source, machine_id FROM machine_monitor_fleet_memory_observations WHERE normalized_at < ?
        UNION SELECT machine_source, machine_id FROM machine_monitor_fleet_events WHERE event_end_at < ?
        UNION SELECT machine_source, machine_id FROM machine_monitor_fleet_errors WHERE occurred_at < ?`)
        .all(before, before, before, before, before, before, before) as Array<{ machineSource: string; machineId: string }>;
      const metrics = this.db.prepare("DELETE FROM machine_monitor_fleet_metric_values WHERE normalized_at < ?").run(before).changes;
      const collections = this.db.prepare("DELETE FROM machine_monitor_fleet_collections WHERE normalized_at < ?").run(before).changes;
      const directories = this.db.prepare("DELETE FROM machine_monitor_fleet_directory_details WHERE collected_at < ?").run(before).changes;
      const memory = this.db.prepare("DELETE FROM machine_monitor_fleet_memory_details WHERE collected_at < ?").run(before).changes;
      const memoryObservations = this.db.prepare("DELETE FROM machine_monitor_fleet_memory_observations WHERE normalized_at < ?").run(before).changes;
      const events = this.db.prepare("DELETE FROM machine_monitor_fleet_events WHERE event_end_at < ?").run(before).changes;
      const errors = this.db.prepare("DELETE FROM machine_monitor_fleet_errors WHERE occurred_at < ?").run(before).changes;
      if (affected.length > 0) {
        for (const row of affected) {
          this.db.prepare(`UPDATE machine_monitor_fleet_machines SET data_revision = data_revision + 1
            WHERE machine_source = ? AND machine_id = ?`).run(row.machineSource, row.machineId);
        }
        this.db.prepare("UPDATE machine_monitor_fleet_state SET data_revision = data_revision + 1 WHERE singleton = 1").run();
      }
      return { collections, metrics, directories, memory, memoryObservations, events, errors, affectedMachines: affected.length };
    })(beforeMs);
  }

  localMachine(): FleetMachineState {
    const machine = { source: "local-bb-server", machineId: LOCAL_BB_SERVER_MACHINE_ID } as const;
    const row = this.machine(machine);
    if (row == null) throw new Error("The reserved local BB server machine is missing.");
    return row;
  }
}
