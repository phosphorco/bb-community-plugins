import { Buffer } from "node:buffer";
import type Database from "better-sqlite3";

import {
  canonicalizeIdentity,
  canonicalizeResource,
  serializeResource,
  type CanonicalIdentity,
  type CanonicalResource,
  type Presentation,
  type Resource,
} from "./canonical.ts";
import {
  defaultPageSize,
  normalizeIdentityInput,
  normalizeProjectionCommand,
  type ApplyProjectionInput,
  type ApplyProjectionResponse,
  type BacklinkRow,
  type CrossReferencesChangedSignal,
  type GetProjectionResponse,
  type ListBacklinksInput,
  type ListBacklinksResponse,
  type NormalizedProjectionCommand,
} from "./model.ts";
import {
  CrossReferenceValidationError,
  PROTOCOL_VERSION,
  validateDigest,
  validateProducerPluginId,
  validateRevision,
} from "./canonical.ts";

type Sqlite = Database.Database;

export const crossReferencesMigrations = [
  `CREATE TABLE IF NOT EXISTS cross_reference_meta (
     singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
     scope_kind TEXT NOT NULL CHECK (scope_kind = 'installation-local'),
     model_version INTEGER NOT NULL CHECK (model_version = 1)
   );
   INSERT INTO cross_reference_meta (singleton, scope_kind, model_version)
   VALUES (1, 'installation-local', 1)
   ON CONFLICT(singleton) DO NOTHING`,
  `CREATE TABLE IF NOT EXISTS resources (
     id INTEGER PRIMARY KEY,
     provider TEXT NOT NULL,
     canonical_keys_json TEXT NOT NULL,
     key_count INTEGER NOT NULL CHECK (key_count BETWEEN 1 AND 32),
     created_at INTEGER NOT NULL,
     UNIQUE (provider, canonical_keys_json),
     UNIQUE (id, provider)
   )`,
  `CREATE TABLE IF NOT EXISTS resource_keys (
     resource_id INTEGER NOT NULL,
     provider TEXT NOT NULL,
     key TEXT NOT NULL,
     value TEXT NOT NULL,
     PRIMARY KEY (resource_id, key),
     FOREIGN KEY (resource_id, provider) REFERENCES resources(id, provider)
       ON DELETE CASCADE
   )`,
  `CREATE TABLE IF NOT EXISTS source_projections (
     id INTEGER PRIMARY KEY,
     producer_plugin_id TEXT NOT NULL,
     source_resource_id INTEGER NOT NULL,
     revision INTEGER NOT NULL CHECK (revision >= 0),
     mutation_id TEXT NOT NULL,
     payload_digest TEXT NOT NULL CHECK (length(payload_digest) = 64),
     source_presentation_json TEXT NOT NULL,
     tombstone INTEGER NOT NULL CHECK (tombstone IN (0, 1)),
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     UNIQUE (producer_plugin_id, source_resource_id),
     FOREIGN KEY (source_resource_id) REFERENCES resources(id) ON DELETE RESTRICT
   )`,
  `CREATE TABLE IF NOT EXISTS reference_occurrences (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     projection_id INTEGER NOT NULL,
     target_resource_id INTEGER NOT NULL,
     target_presentation_json TEXT NOT NULL,
     position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 255),
     created_at INTEGER NOT NULL,
     UNIQUE (projection_id, target_resource_id),
     UNIQUE (projection_id, position),
     FOREIGN KEY (projection_id) REFERENCES source_projections(id)
       ON DELETE CASCADE,
     FOREIGN KEY (target_resource_id) REFERENCES resources(id) ON DELETE RESTRICT
   )`,
  `CREATE INDEX IF NOT EXISTS resource_keys_match_idx
     ON resource_keys(provider, key, value, resource_id);
   CREATE INDEX IF NOT EXISTS reference_occurrences_target_idx
     ON reference_occurrences(target_resource_id, id)`,
] as const;

export function enableForeignKeys(db: Sqlite): void {
  db.pragma("foreign_keys = ON");
  const enabled = db.pragma("foreign_keys", { simple: true });
  if (enabled !== 1) {
    throw new Error("Cross References requires SQLite foreign_keys = ON.");
  }
}

interface ResourceRow {
  id: number;
  provider: string;
  canonical_keys_json: string;
}

interface ProjectionRow {
  id: number;
  producer_plugin_id: string;
  source_resource_id: number;
  revision: number;
  mutation_id: string;
  payload_digest: string;
  source_presentation_json: string;
  tombstone: number;
  created_at: number;
  updated_at: number;
}

interface OccurrenceIdentityRow {
  provider: string;
  canonical_keys_json: string;
}

interface BacklinkQueryRow {
  occurrence_id: number;
  source_provider: string;
  source_canonical_keys_json: string;
  source_presentation_json: string;
  producer_plugin_id: string;
  revision: number;
  target_presentation_json: string;
  position: number;
}

export interface BacklinkCursor {
  v: 1;
  targetDigest: string;
  upperId: number;
  afterId: number;
}

export interface ApplyProjectionStoreResult extends ApplyProjectionResponse {
  changed: boolean;
  signal: CrossReferencesChangedSignal | null;
}

function rowValue<T extends object>(row: T | undefined): T | null {
  return row ?? null;
}

function parseJson<T>(json: string, label: string): T {
  try {
    return JSON.parse(json) as T;
  } catch {
    throw new Error(`Stored ${label} is not valid JSON.`);
  }
}

function resourceFromRow(row: ResourceRow, presentationJson: string): Resource {
  const keys = parseJson<Record<string, string>>(row.canonical_keys_json, "resource keys");
  const presentation = parseJson<Presentation>(presentationJson, "presentation");
  return serializeResource(canonicalizeResource({ provider: row.provider, keys, presentation }));
}

function identityFromRow(row: OccurrenceIdentityRow): CanonicalIdentity {
  return canonicalizeIdentity({
    provider: row.provider,
    keys: parseJson<Record<string, string>>(row.canonical_keys_json, "resource keys"),
  });
}

function cursorJson(cursor: BacklinkCursor): string {
  return JSON.stringify({
    v: cursor.v,
    targetDigest: cursor.targetDigest,
    upperId: cursor.upperId,
    afterId: cursor.afterId,
  });
}

export function encodeBacklinkCursor(cursor: BacklinkCursor): string {
  validateDigest(cursor.targetDigest, "cursor.targetDigest");
  validateRevision(cursor.upperId, "cursor.upperId", 0);
  validateRevision(cursor.afterId, "cursor.afterId", 0);
  if (cursor.v !== 1 || cursor.afterId > cursor.upperId) {
    throw new CrossReferenceValidationError("cursor bounds are invalid.");
  }
  return Buffer.from(cursorJson(cursor), "utf8").toString("base64url");
}

function decodeBacklinkCursor(encoded: string, targetDigest: string, highWatermark: number): BacklinkCursor {
  if (typeof encoded !== "string" || encoded.length === 0 || encoded.length > 4_096 || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw new CrossReferenceValidationError("cursor encoding is invalid.");
  }
  let bytes: Buffer;
  try {
    bytes = Buffer.from(encoded, "base64url");
  } catch {
    throw new CrossReferenceValidationError("cursor encoding is invalid.");
  }
  if (bytes.toString("base64url") !== encoded) {
    throw new CrossReferenceValidationError("cursor encoding is invalid.");
  }

  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new CrossReferenceValidationError("cursor is not valid UTF-8.");
  }
  let value: unknown;
  try {
    value = JSON.parse(decoded);
  } catch {
    throw new CrossReferenceValidationError("cursor is not valid JSON.");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CrossReferenceValidationError("cursor payload is invalid.");
  }
  const record = value as Record<string, unknown>;
  const fields = Object.keys(record).sort();
  if (fields.join(",") !== "afterId,targetDigest,upperId,v") {
    throw new CrossReferenceValidationError("cursor fields are invalid.");
  }
  const cursor: BacklinkCursor = {
    v: record.v as 1,
    targetDigest: record.targetDigest as string,
    upperId: record.upperId as number,
    afterId: record.afterId as number,
  };
  if (cursor.v !== 1 || cursor.targetDigest !== targetDigest) {
    throw new CrossReferenceValidationError("cursor does not belong to this target.");
  }
  validateDigest(cursor.targetDigest, "cursor.targetDigest");
  validateRevision(cursor.upperId, "cursor.upperId", 0);
  validateRevision(cursor.afterId, "cursor.afterId", 0);
  if (cursor.afterId > cursor.upperId || cursor.upperId > highWatermark) {
    throw new CrossReferenceValidationError("cursor bounds are invalid.");
  }
  if (encodeBacklinkCursor(cursor) !== encoded) {
    throw new CrossReferenceValidationError("cursor encoding is not canonical.");
  }
  return cursor;
}

export class CrossReferenceStore {
  private readonly db: Sqlite;

  constructor(db: Sqlite) {
    this.db = db;
  }

  private findResource(identity: CanonicalIdentity): ResourceRow | null {
    const row = this.db.prepare(
      `SELECT id, provider, canonical_keys_json
         FROM resources
        WHERE provider = ? AND canonical_keys_json = ?`,
    ).get(identity.provider, identity.canonicalKeysJson) as ResourceRow | undefined;
    return rowValue(row);
  }

  private ensureResource(resource: CanonicalResource, now: number): number {
    this.db.prepare(
      `INSERT INTO resources (provider, canonical_keys_json, key_count, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(provider, canonical_keys_json) DO NOTHING`,
    ).run(resource.provider, resource.canonicalKeysJson, Object.keys(resource.keys).length, now);

    const row = this.findResource(resource);
    if (row === null) throw new Error("Could not create or load the canonical resource.");
    const insertKey = this.db.prepare(
      `INSERT INTO resource_keys (resource_id, provider, key, value)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(resource_id, key) DO NOTHING`,
    );
    for (const [key, value] of Object.entries(resource.keys)) {
      insertKey.run(row.id, resource.provider, key, value);
    }
    return row.id;
  }

  private findProjection(producerPluginId: string, sourceResourceId: number): ProjectionRow | null {
    const row = this.db.prepare(
      `SELECT id, producer_plugin_id, source_resource_id, revision, mutation_id,
              payload_digest, source_presentation_json, tombstone, created_at, updated_at
         FROM source_projections
        WHERE producer_plugin_id = ? AND source_resource_id = ?`,
    ).get(producerPluginId, sourceResourceId) as ProjectionRow | undefined;
    return rowValue(row);
  }

  private occurrenceTargetDigests(projectionId: number): string[] {
    const rows = this.db.prepare(
      `SELECT resources.provider, resources.canonical_keys_json
         FROM reference_occurrences
         JOIN resources ON resources.id = reference_occurrences.target_resource_id
        WHERE reference_occurrences.projection_id = ?
        ORDER BY reference_occurrences.position`,
    ).all(projectionId) as OccurrenceIdentityRow[];
    return rows.map((row) => identityFromRow(row).identityDigest);
  }

  applyProjection(input: ApplyProjectionInput): ApplyProjectionStoreResult {
    // Normalize the complete command before opening the write transaction.
    const command = normalizeProjectionCommand(input);
    return this.db.transaction(() => this.applyNormalizedProjection(command))();
  }

  private applyNormalizedProjection(command: NormalizedProjectionCommand): ApplyProjectionStoreResult {
    const existingSource = this.findResource(command.source);
    const current = existingSource === null
      ? null
      : this.findProjection(command.producerPluginId, existingSource.id);
    const currentRevision = current?.revision ?? 0;
    const currentDigest = current?.payload_digest ?? null;

    if (command.revision < currentRevision) {
      return { outcome: "stale", currentRevision, currentDigest, changed: false, signal: null };
    }
    if (command.revision === currentRevision) {
      const outcome = current !== null
        && current.mutation_id === command.mutationId
        && current.payload_digest === command.payloadDigest
        ? "duplicate"
        : current !== null && current.payload_digest === command.payloadDigest
          ? "equal"
          : "conflict";
      return { outcome, currentRevision, currentDigest, changed: false, signal: null };
    }
    if (command.expectedRevision !== currentRevision) {
      return { outcome: "cas-mismatch", currentRevision, currentDigest, changed: false, signal: null };
    }

    const now = Date.now();
    const sourceResourceId = this.ensureResource(command.source, now);
    const targetResourceIds = command.targets.map((target) => this.ensureResource(target, now));
    const priorTargetDigests = current === null ? [] : this.occurrenceTargetDigests(current.id);
    let projectionId: number;

    if (current === null) {
      const inserted = this.db.prepare(
        `INSERT INTO source_projections (
           producer_plugin_id, source_resource_id, revision, mutation_id,
           payload_digest, source_presentation_json, tombstone, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        command.producerPluginId,
        sourceResourceId,
        command.revision,
        command.mutationId,
        command.payloadDigest,
        command.source.presentationJson,
        command.tombstone ? 1 : 0,
        now,
        now,
      );
      projectionId = Number(inserted.lastInsertRowid);
    } else {
      projectionId = current.id;
      this.db.prepare(
        `UPDATE source_projections
            SET revision = ?, mutation_id = ?, payload_digest = ?,
                source_presentation_json = ?, tombstone = ?, updated_at = ?
          WHERE id = ?`,
      ).run(
        command.revision,
        command.mutationId,
        command.payloadDigest,
        command.source.presentationJson,
        command.tombstone ? 1 : 0,
        now,
        projectionId,
      );
      this.db.prepare(`DELETE FROM reference_occurrences WHERE projection_id = ?`).run(projectionId);
    }

    const insertOccurrence = this.db.prepare(
      `INSERT INTO reference_occurrences (
         projection_id, target_resource_id, target_presentation_json, position, created_at
       ) VALUES (?, ?, ?, ?, ?)`,
    );
    for (let position = 0; position < command.targets.length; position += 1) {
      const target = command.targets[position]!;
      insertOccurrence.run(projectionId, targetResourceIds[position], target.presentationJson, position, now);
    }

    const affectedIdentityDigests = [
      command.source.identityDigest,
      ...priorTargetDigests,
      ...command.targets.map((target) => target.identityDigest),
    ].filter((digest, index, all) => all.indexOf(digest) === index);
    const signal: CrossReferencesChangedSignal = {
      protocolVersion: PROTOCOL_VERSION,
      affectedIdentityDigests,
      producerPluginId: command.producerPluginId,
      sourceIdentityDigest: command.source.identityDigest,
      revision: command.revision,
    };
    return {
      outcome: "applied",
      currentRevision: command.revision,
      currentDigest: command.payloadDigest,
      changed: true,
      signal,
    };
  }

  getProjection(input: { producerPluginId: string; source: { provider: string; keys: Record<string, string> } }): GetProjectionResponse {
    const producerPluginId = validateProducerPluginId(input.producerPluginId);
    const sourceIdentity = normalizeIdentityInput(input.source);
    const sourceRow = this.findResource(sourceIdentity);
    if (sourceRow === null) return { projection: null };
    const projection = this.findProjection(producerPluginId, sourceRow.id);
    if (projection === null) return { projection: null };

    const occurrences = this.db.prepare(
      `SELECT resources.id, resources.provider, resources.canonical_keys_json,
              reference_occurrences.target_presentation_json
         FROM reference_occurrences
         JOIN resources ON resources.id = reference_occurrences.target_resource_id
        WHERE reference_occurrences.projection_id = ?
        ORDER BY reference_occurrences.position`,
    ).all(projection.id) as Array<ResourceRow & { target_presentation_json: string }>;
    return {
      projection: {
        producerPluginId: projection.producer_plugin_id,
        source: resourceFromRow(sourceRow, projection.source_presentation_json),
        revision: projection.revision,
        mutationId: projection.mutation_id,
        payloadDigest: projection.payload_digest,
        tombstone: projection.tombstone === 1,
        targets: occurrences.map((row) => resourceFromRow(row, row.target_presentation_json)),
      },
    };
  }

  listBacklinks(input: ListBacklinksInput): ListBacklinksResponse {
    const targetIdentity = normalizeIdentityInput(input.target);
    const pageSize = defaultPageSize(input.pageSize);
    const highWatermark = this.occurrenceHighWatermark();
    const cursor = input.cursor === undefined
      ? {
          v: 1 as const,
          targetDigest: targetIdentity.identityDigest,
          upperId: this.currentOccurrenceMaximum(),
          afterId: 0,
        }
      : decodeBacklinkCursor(input.cursor, targetIdentity.identityDigest, highWatermark);
    const targetRow = this.findResource(targetIdentity);
    if (targetRow === null) return { rows: [], nextCursor: null };

    const rows = this.db.prepare(
      `SELECT reference_occurrences.id AS occurrence_id,
              source_resources.provider AS source_provider,
              source_resources.canonical_keys_json AS source_canonical_keys_json,
              source_projections.source_presentation_json,
              source_projections.producer_plugin_id,
              source_projections.revision,
              reference_occurrences.target_presentation_json,
              reference_occurrences.position
         FROM reference_occurrences
         JOIN source_projections
           ON source_projections.id = reference_occurrences.projection_id
         JOIN resources AS source_resources
           ON source_resources.id = source_projections.source_resource_id
        WHERE reference_occurrences.target_resource_id = ?
          AND reference_occurrences.id > ?
          AND reference_occurrences.id <= ?
        ORDER BY reference_occurrences.id ASC
        LIMIT ?`,
    ).all(targetRow.id, cursor.afterId, cursor.upperId, pageSize + 1) as BacklinkQueryRow[];

    const hasNext = rows.length > pageSize;
    const page = hasNext ? rows.slice(0, pageSize) : rows;
    const nextCursor = hasNext
      ? encodeBacklinkCursor({
          v: 1,
          targetDigest: targetIdentity.identityDigest,
          upperId: cursor.upperId,
          afterId: page.at(-1)!.occurrence_id,
        })
      : null;
    const backlinkRows: BacklinkRow[] = page.map((row) => ({
      source: resourceFromRow({
        id: 0,
        provider: row.source_provider,
        canonical_keys_json: row.source_canonical_keys_json,
      }, row.source_presentation_json),
      producerPluginId: row.producer_plugin_id,
      revision: row.revision,
      targetPresentation: parseJson<Presentation>(row.target_presentation_json, "target presentation"),
      position: row.position,
    }));
    return { rows: backlinkRows, nextCursor };
  }

  private currentOccurrenceMaximum(): number {
    const row = this.db.prepare(
      `SELECT COALESCE(MAX(id), 0) AS maximum FROM reference_occurrences`,
    ).get() as { maximum: number };
    return validateRevision(row.maximum, "occurrence upper bound", 0);
  }

  private occurrenceHighWatermark(): number {
    const row = this.db.prepare(
      `SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'reference_occurrences'), 0) AS high_watermark`,
    ).get() as { high_watermark: number };
    return validateRevision(row.high_watermark, "occurrence high-watermark", 0);
  }
}

export const migrations = crossReferencesMigrations;
export const crossReferenceMigrations = crossReferencesMigrations;
export { CrossReferenceStore as CrossReferencesStore };
