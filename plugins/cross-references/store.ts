import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { canonicalJson } from "@phosphorco/bb-context-recognition";
import { recognitionIdentity, recognitionIdentityRecord, verifiedFileIdentity, verifiedFileIdentityRecord, isUtf16CodePointBoundary } from "@phosphorco/bb-cross-references";
import { persistedExcerpt } from './mention-excerpts.ts';
import { mentionFrame } from './mention-markdown.ts';
import { MENTION_LIMITS, MentionLocationSchema, mentionKey, type MentionScan, type ObservedMention, type MentionEdgeCap } from "./mention-evidence.ts";

import {
  canonicalizeIdentity,
  canonicalizeResource,
  serializeResource,
  projectionPayloadDigest,
  projectionPayloadJson,
  MAX_PROJECTION_PAYLOAD_BYTES,
  utf8ByteLength,
  sha256Hex,
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
  type ForwardReferenceRow,
  type GetProjectionResponse,
  type ListBacklinksInput,
  type ListBacklinksResponse,
  type ListForwardReferencesInput,
  type ListForwardReferencesResponse,
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
  // Append migrations only: installed plugin storage binds each earlier
  // statement, so modifying the initial index migration would strand users.
  `CREATE INDEX IF NOT EXISTS source_projections_source_idx
     ON source_projections(source_resource_id, id)`,
  `ALTER TABLE reference_occurrences ADD COLUMN last_seen_at INTEGER
     CHECK (last_seen_at IS NULL OR last_seen_at >= 0)`,
  `CREATE TABLE assistant_link_jobs (
     thread_id TEXT PRIMARY KEY, project_id TEXT NOT NULL,
     version INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0,
     retry_at INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0
   );
   CREATE TABLE assistant_link_sync (
     thread_id TEXT PRIMARY KEY, synced_at INTEGER NOT NULL
   )`,
  `CREATE TABLE recognized_resources (
     resource_id INTEGER PRIMARY KEY REFERENCES resources(id) ON DELETE CASCADE,
     source_identity_json TEXT NOT NULL CHECK (length(CAST(source_identity_json AS BLOB)) <= 16384),
     codec_version INTEGER NOT NULL CHECK (codec_version = 1)
   );
   CREATE TABLE mention_streams (
     producer_plugin_id TEXT NOT NULL,
     source_resource_id INTEGER NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
     evidence_revision INTEGER NOT NULL CHECK (evidence_revision >= 1),
     evidence_digest TEXT NOT NULL CHECK (length(evidence_digest) = 64),
     collector_version INTEGER NOT NULL,
     coverage_json TEXT NOT NULL,
     last_successful_scan_at INTEGER NOT NULL,
     PRIMARY KEY (producer_plugin_id, source_resource_id)
   );
   CREATE TABLE mention_occurrences (
     producer_plugin_id TEXT NOT NULL,
     source_resource_id INTEGER NOT NULL,
     target_resource_id INTEGER NOT NULL REFERENCES resources(id) ON DELETE RESTRICT,
     occurrence_key TEXT NOT NULL CHECK (length(occurrence_key) = 64),
     source_locator_json TEXT NOT NULL,
     source_content_revision TEXT NOT NULL CHECK (length(source_content_revision) = 64),
     span_start INTEGER NOT NULL CHECK (span_start >= 0),
     span_end INTEGER NOT NULL CHECK (span_end > span_start),
     message_created_at INTEGER NOT NULL,
     observed_at INTEGER NOT NULL,
     provenance_json TEXT NOT NULL,
     confirmed_in_scan INTEGER NOT NULL CHECK (confirmed_in_scan IN (0, 1)),
     PRIMARY KEY (producer_plugin_id, source_resource_id, target_resource_id, occurrence_key),
     FOREIGN KEY (producer_plugin_id, source_resource_id)
       REFERENCES mention_streams(producer_plugin_id, source_resource_id) ON DELETE CASCADE
   );
   CREATE INDEX mention_occurrences_target_idx ON mention_occurrences(target_resource_id, source_resource_id)`,
  `CREATE TABLE mention_edge_caps (
     producer_plugin_id TEXT NOT NULL,
     source_resource_id INTEGER NOT NULL,
     target_resource_id INTEGER NOT NULL REFERENCES resources(id) ON DELETE RESTRICT,
     state TEXT NOT NULL CHECK (state IN ('capped', 'unknown')),
     PRIMARY KEY (producer_plugin_id, source_resource_id, target_resource_id),
     FOREIGN KEY (producer_plugin_id, source_resource_id)
       REFERENCES mention_streams(producer_plugin_id, source_resource_id) ON DELETE CASCADE
   );
   -- Earlier global clipping cannot identify a particular edge. Preserve that
   -- uncertainty until a complete authoritative scan replaces this producer.
   INSERT INTO mention_edge_caps
   SELECT s.producer_plugin_id, s.source_resource_id, o.target_resource_id, 'unknown'
     FROM mention_streams s
     JOIN source_projections p ON p.producer_plugin_id = s.producer_plugin_id
       AND p.source_resource_id = s.source_resource_id
     JOIN reference_occurrences o ON o.projection_id = p.id
    WHERE json_extract(s.coverage_json, '$.retentionLimited') = 1`,
  `ALTER TABLE mention_streams ADD COLUMN cap_history_unknown INTEGER NOT NULL DEFAULT 0
     CHECK (cap_history_unknown IN (0, 1));
   UPDATE mention_streams SET cap_history_unknown = 1
    WHERE EXISTS (SELECT 1 FROM mention_edge_caps c
      WHERE c.producer_plugin_id = mention_streams.producer_plugin_id
        AND c.source_resource_id = mention_streams.source_resource_id
        AND NOT EXISTS (SELECT 1 FROM source_projections p
          JOIN reference_occurrences o ON o.projection_id = p.id
          WHERE p.producer_plugin_id = c.producer_plugin_id
            AND p.source_resource_id = c.source_resource_id
            AND p.tombstone = 0 AND o.target_resource_id = c.target_resource_id));
   DELETE FROM mention_edge_caps WHERE NOT EXISTS (
     SELECT 1 FROM source_projections p JOIN reference_occurrences o ON o.projection_id = p.id
      WHERE p.producer_plugin_id = mention_edge_caps.producer_plugin_id
        AND p.source_resource_id = mention_edge_caps.source_resource_id
        AND p.tombstone = 0 AND o.target_resource_id = mention_edge_caps.target_resource_id)`,
  `ALTER TABLE assistant_link_jobs ADD COLUMN priority INTEGER NOT NULL DEFAULT 0
     CHECK (priority BETWEEN 0 AND 2);
   -- Recover the only historical viewed intent that was explicitly retained.
   -- Failed positive-time retries carry no recoverable historical priority.
   UPDATE assistant_link_jobs SET priority = 2 WHERE retry_at = -1 AND attempts = 0;
   CREATE INDEX assistant_link_jobs_priority_retry_idx
     ON assistant_link_jobs(priority DESC, retry_at)`,
  `ALTER TABLE mention_occurrences ADD COLUMN authored_url_state TEXT NOT NULL DEFAULT 'unknown'
     CHECK(authored_url_state IN ('unknown','not-url','exact'));
   ALTER TABLE mention_occurrences ADD COLUMN exact_authored_href TEXT
     CHECK(exact_authored_href IS NULL OR (typeof(exact_authored_href)='text' AND length(exact_authored_href) BETWEEN 1 AND 4096
       AND length(CAST(exact_authored_href AS BLOB))<=16384));
   ALTER TABLE mention_streams ADD COLUMN bound_graph_revision INTEGER
     CHECK(bound_graph_revision IS NULL OR (typeof(bound_graph_revision)='integer' AND bound_graph_revision BETWEEN 0 AND 9007199254740991));
   CREATE TABLE mention_excerpts (
     producer_plugin_id TEXT NOT NULL, source_resource_id INTEGER NOT NULL,
     target_resource_id INTEGER NOT NULL, occurrence_key TEXT NOT NULL,
     source_content_revision TEXT NOT NULL CHECK(length(source_content_revision)=64),
     codec_version INTEGER NOT NULL CHECK(codec_version=1),
     state TEXT NOT NULL CHECK(state IN ('ready','unavailable')),
     excerpt_text TEXT, excerpt_source_start INTEGER, excerpt_source_end INTEGER,
     match_start INTEGER, match_end INTEGER,
     clipped_before INTEGER NOT NULL CHECK(clipped_before IN (0,1)),
     clipped_after INTEGER NOT NULL CHECK(clipped_after IN (0,1)),
     match_clipped_before INTEGER NOT NULL CHECK(match_clipped_before IN (0,1)),
     match_clipped_after INTEGER NOT NULL CHECK(match_clipped_after IN (0,1)),
     unavailable_reason TEXT,
     PRIMARY KEY(producer_plugin_id,source_resource_id,target_resource_id,occurrence_key),
     FOREIGN KEY(producer_plugin_id,source_resource_id,target_resource_id,occurrence_key)
       REFERENCES mention_occurrences ON DELETE CASCADE,
     CHECK((state='ready' AND excerpt_text IS NOT NULL AND typeof(excerpt_text)='text' AND unavailable_reason IS NULL
       AND excerpt_source_start IS NOT NULL AND typeof(excerpt_source_start)='integer'
       AND excerpt_source_end IS NOT NULL AND typeof(excerpt_source_end)='integer'
       AND match_start IS NOT NULL AND typeof(match_start)='integer'
       AND match_end IS NOT NULL AND typeof(match_end)='integer'
       AND excerpt_source_start>=0 AND excerpt_source_end>excerpt_source_start AND excerpt_source_end<=262144
       AND match_start>=0 AND match_end>match_start AND match_end<=262144)
       OR (state='unavailable' AND excerpt_text IS NULL
       AND excerpt_source_start IS NULL AND excerpt_source_end IS NULL AND match_start IS NULL AND match_end IS NULL
       AND unavailable_reason IS NOT NULL AND unavailable_reason IN ('indivisible-word','no-eligible-context')
       AND clipped_before=0 AND clipped_after=0 AND match_clipped_before=0 AND match_clipped_after=0)),
     CHECK(excerpt_text IS NULL OR length(CAST(excerpt_text AS BLOB))<=1280)
   );
   CREATE INDEX mention_exact_href_v2_idx ON mention_occurrences(exact_authored_href COLLATE BINARY,
     message_created_at DESC,source_resource_id,producer_plugin_id,target_resource_id,occurrence_key)
     WHERE authored_url_state='exact' AND exact_authored_href IS NOT NULL;
   CREATE INDEX mention_unknown_href_v2_idx ON mention_occurrences(producer_plugin_id,source_resource_id,target_resource_id,occurrence_key)
     WHERE authored_url_state='unknown';
   CREATE INDEX mention_target_time_v2_idx ON mention_occurrences(target_resource_id,message_created_at DESC,
     source_resource_id,producer_plugin_id,occurrence_key)`,
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
  last_seen_at: number | null;
}

interface ForwardReferenceQueryRow {
  occurrence_id: number;
  target_provider: string;
  target_canonical_keys_json: string;
  target_presentation_json: string;
  producer_plugin_id: string;
  revision: number;
  position: number;
  last_seen_at: number | null;
}

export interface BacklinkCursor {
  v: 1;
  targetDigest: string;
  upperId: number;
  afterId: number;
}

export interface ForwardReferenceCursor {
  v: 1;
  sourceDigest: string;
  producerPluginId: string | null;
  upperId: number;
  afterId: number;
}

export interface ApplyProjectionStoreResult extends ApplyProjectionResponse {
  changed: boolean;
  signal: CrossReferencesChangedSignal | null;
}

export interface ObservedReference {
  target: Resource;
  lastSeenAt: number | null;
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

function forwardReferenceCursorJson(cursor: ForwardReferenceCursor): string {
  return JSON.stringify({
    v: cursor.v,
    sourceDigest: cursor.sourceDigest,
    producerPluginId: cursor.producerPluginId,
    upperId: cursor.upperId,
    afterId: cursor.afterId,
  });
}

export function encodeForwardReferenceCursor(cursor: ForwardReferenceCursor): string {
  validateDigest(cursor.sourceDigest, "cursor.sourceDigest");
  if (cursor.producerPluginId !== null) validateProducerPluginId(cursor.producerPluginId);
  validateRevision(cursor.upperId, "cursor.upperId", 0);
  validateRevision(cursor.afterId, "cursor.afterId", 0);
  if (cursor.v !== 1 || cursor.afterId > cursor.upperId) {
    throw new CrossReferenceValidationError("cursor bounds are invalid.");
  }
  return Buffer.from(forwardReferenceCursorJson(cursor), "utf8").toString("base64url");
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

function decodeForwardReferenceCursor(
  encoded: string,
  sourceDigest: string,
  producerPluginId: string | null,
  highWatermark: number,
): ForwardReferenceCursor {
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
    throw new CrossReferenceValidationError("cursor encoding is not canonical.");
  }

  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new CrossReferenceValidationError("cursor is not valid JSON.");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CrossReferenceValidationError("cursor payload is invalid.");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "afterId,producerPluginId,sourceDigest,upperId,v") {
    throw new CrossReferenceValidationError("cursor fields are invalid.");
  }
  const cursor: ForwardReferenceCursor = {
    v: record.v as 1,
    sourceDigest: record.sourceDigest as string,
    producerPluginId: record.producerPluginId as string | null,
    upperId: record.upperId as number,
    afterId: record.afterId as number,
  };
  if (cursor.v !== 1 || cursor.sourceDigest !== sourceDigest || cursor.producerPluginId !== producerPluginId) {
    throw new CrossReferenceValidationError("cursor does not belong to this source.");
  }
  validateDigest(cursor.sourceDigest, "cursor.sourceDigest");
  if (cursor.producerPluginId !== null) validateProducerPluginId(cursor.producerPluginId);
  validateRevision(cursor.upperId, "cursor.upperId", 0);
  validateRevision(cursor.afterId, "cursor.afterId", 0);
  if (cursor.afterId > cursor.upperId || cursor.upperId > highWatermark) {
    throw new CrossReferenceValidationError("cursor bounds are invalid.");
  }
  if (encodeForwardReferenceCursor(cursor) !== encoded) {
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

  /**
   * Old development builds could have admitted an unsafe url/href resource.
   * Resource identities are otherwise retained after an occurrence disappears,
   * so remove only invalid URL rows that are no longer referenced by either an
   * occurrence or a source projection. Active source-owned occurrences are
   * left for their producer's next complete-set replacement.
   */
  pruneUnsafeUrlResources(): number {
    return this.db.transaction(() => {
      const rows = this.db.prepare(
        "SELECT id, provider, canonical_keys_json FROM resources WHERE provider = 'url'",
      ).all() as ResourceRow[];
      let removed = 0;
      const remove = this.db.prepare(`DELETE FROM resources
        WHERE id = ?
          AND NOT EXISTS (SELECT 1 FROM reference_occurrences WHERE target_resource_id = resources.id)
          AND NOT EXISTS (SELECT 1 FROM source_projections WHERE source_resource_id = resources.id)`);
      for (const row of rows) {
        try {
          canonicalizeIdentity({ provider: row.provider, keys: parseJson<Record<string, string>>(row.canonical_keys_json, "resource keys") });
        } catch {
          removed += remove.run(row.id).changes;
        }
      }
      return removed;
    })();
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
    this.pruneUnsafeUrlResources();

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

  /** Update native observations from source messages. Retain disabled-producer
   * snapshots as historical source truth until explicit thread deletion. */
  replaceObservedThreadReferences(source: Resource, observed: readonly ObservedReference[], complete: boolean, deleted = false): CrossReferencesChangedSignal[] {
    const canonicalSource = canonicalizeResource(source);
    const sourceIdentity = { provider: source.provider, keys: source.keys };
    const incoming = observed.map((row) => {
      const target = canonicalizeResource(row.target);
      if (row.lastSeenAt !== null) {
        validateRevision(row.lastSeenAt, "lastSeenAt", 0);
        if (row.lastSeenAt > 8_640_000_000_000_000) throw new CrossReferenceValidationError("lastSeenAt exceeds the date range.");
      }
      return { target: serializeResource(target), key: target.canonicalIdentityJson, lastSeenAt: row.lastSeenAt };
    });
    return this.db.transaction(() => {
      const current = this.getProjection({ producerPluginId: "cross-references", source: sourceIdentity }).projection;
      const legacy = this.getProjection({ producerPluginId: "thread-links", source: sourceIdentity }).projection;
      const unique = new Map<string, typeof incoming[number]>();
      for (const row of incoming) {
        const prior = unique.get(row.key);
        if (prior === undefined || (row.lastSeenAt ?? -1) > (prior.lastSeenAt ?? -1)) unique.set(row.key, row);
      }
      if (!complete && !deleted) {
        for (const target of (current?.targets ?? [])) {
          const key = canonicalizeResource(target).canonicalIdentityJson;
          if (!unique.has(key)) unique.set(key, { key, target, lastSeenAt: null });
        }
      }
      const selected = deleted ? [] : [...unique.values()].sort((a, b) => (b.lastSeenAt ?? -1) - (a.lastSeenAt ?? -1) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)).slice(0, 256);
      const targets = selected.map((row) => row.target);
      const signals: CrossReferencesChangedSignal[] = [];
      const replace = (producerPluginId: string, prior: typeof current, tombstone: boolean, next: Resource[]) => {
        const digest = projectionPayloadDigest(producerPluginId, canonicalSource, tombstone, next.map(canonicalizeResource));
        if (prior?.payloadDigest === digest) return;
        const result = this.applyProjection({
          protocolVersion: 1, producerPluginId, mutationId: randomUUID(), source,
          revision: (prior?.revision ?? 0) + 1, expectedRevision: prior?.revision ?? 0,
          payloadDigest: digest, tombstone, targets: next,
        });
        if (result.signal !== null) signals.push(result.signal);
      };
      // Preserve previously known times when a bounded scan is incomplete.
      const sourceRow = this.findResource(canonicalSource);
      const priorTimes = sourceRow === null ? [] : this.db.prepare(`SELECT target_resource_id, last_seen_at FROM reference_occurrences
        JOIN source_projections ON source_projections.id = reference_occurrences.projection_id
        WHERE source_projections.source_resource_id = ? AND source_projections.producer_plugin_id = 'cross-references'`).all(sourceRow.id) as Array<{ target_resource_id: number; last_seen_at: number | null }>;
      const times = new Map(priorTimes.map((row) => [row.target_resource_id, row.last_seen_at]));
      replace("cross-references", current, deleted, targets);
      const storedSource = this.findResource(canonicalSource)!;
      const projection = this.findProjection("cross-references", storedSource.id)!;
      let timeChanged = false;
      const update = this.db.prepare(`UPDATE reference_occurrences SET last_seen_at = ?
        WHERE projection_id = ? AND target_resource_id = ? AND last_seen_at IS NOT ?`);
      for (const row of selected) {
        const resourceId = this.findResource(canonicalizeResource(row.target))!.id;
        const timestamp = !complete ? Math.max(row.lastSeenAt ?? -1, times.get(resourceId) ?? -1) : row.lastSeenAt;
        const value = timestamp === -1 ? null : timestamp;
        const changed = update.run(value, projection.id, resourceId, value).changes > 0;
        timeChanged = timeChanged || changed;
      }
      if (deleted && legacy !== null && !legacy.tombstone) replace("thread-links", legacy, true, []);
      if (timeChanged && signals.length === 0) signals.push({
        protocolVersion: 1, producerPluginId: "cross-references", sourceIdentityDigest: canonicalSource.identityDigest,
        revision: projection.revision, affectedIdentityDigests: [canonicalSource.identityDigest, ...selected.map((row) => canonicalizeResource(row.target).identityDigest)],
      });
      return signals;
    })();
  }

  /** Internal product-store view, intentionally not exposed through strict v1 RPCs. */
  mentionState(source: {provider:string;keys:Record<string,string>}): {
    revision:number; digest:string|null; coverage: MentionScan["coverage"]|null; edgeCaps:MentionEdgeCap[];
    occurrences:Array<ObservedMention & {occurrenceKey:string;observedAt:number;confirmed:boolean}>;
  } {
    const resource=this.findResource(canonicalizeIdentity(source));
    if(!resource)return {revision:0,digest:null,coverage:null,edgeCaps:[],occurrences:[]};
    const stream=this.db.prepare(`SELECT * FROM mention_streams WHERE producer_plugin_id = 'cross-references' AND source_resource_id = ?`).get(resource.id) as any;
    if(!stream)return {revision:0,digest:null,coverage:null,edgeCaps:[],occurrences:[]};
    const projection=this.getProjection({producerPluginId:'cross-references',source}).projection;
    const targets=new Map((projection?.targets??[]).map(t=>[canonicalizeResource(t).canonicalIdentityJson,t]));
    const caps=new Map<string,MentionEdgeCap>((projection?.targets??[]).map(t=>{
      const identity=canonicalizeResource(t);
      return [identity.canonicalIdentityJson,{target:{provider:identity.provider,keys:identity.keys},state:'uncapped'}];
    }));
    const capRows=this.db.prepare(`SELECT r.provider, r.canonical_keys_json, c.state FROM mention_edge_caps c
      JOIN resources r ON r.id = c.target_resource_id
      WHERE c.producer_plugin_id = 'cross-references' AND c.source_resource_id = ?`).all(resource.id) as Array<OccurrenceIdentityRow & {state:'capped'|'unknown'}>;
    for(const row of capRows){const identity=identityFromRow(row);caps.set(identity.canonicalIdentityJson,{target:{provider:identity.provider,keys:identity.keys},state:row.state});}
    const edgeCaps=[...caps].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([,cap])=>cap);
    const rows=this.db.prepare(`SELECT m.*, r.provider, r.canonical_keys_json, e.state excerpt_state, e.source_content_revision excerpt_content_revision,
        e.codec_version,e.excerpt_text,e.excerpt_source_start,e.excerpt_source_end,e.match_start,e.match_end,
        e.clipped_before,e.clipped_after,e.match_clipped_before,e.match_clipped_after,e.unavailable_reason FROM mention_occurrences m
      JOIN resources r ON r.id = m.target_resource_id
      JOIN source_projections p ON p.producer_plugin_id=m.producer_plugin_id AND p.source_resource_id=m.source_resource_id AND p.tombstone=0
      JOIN reference_occurrences o ON o.projection_id=p.id AND o.target_resource_id=m.target_resource_id
      LEFT JOIN mention_excerpts e ON e.producer_plugin_id=m.producer_plugin_id AND e.source_resource_id=m.source_resource_id
        AND e.target_resource_id=m.target_resource_id AND e.occurrence_key=m.occurrence_key WHERE m.producer_plugin_id = 'cross-references' AND m.source_resource_id = ?
      ORDER BY m.target_resource_id, m.occurrence_key`).all(resource.id) as any[];
    return {revision:stream.evidence_revision,digest:stream.evidence_digest,coverage:{...JSON.parse(stream.coverage_json),capHistoryUnknown:stream.cap_history_unknown===1},edgeCaps,
      occurrences:rows.map(row=>{
        const identity=canonicalizeIdentity({provider:row.provider,keys:JSON.parse(row.canonical_keys_json)});
        const target=targets.get(identity.canonicalIdentityJson);
        if(!target)throw new Error('Location without an active producer edge.');
        return {target,locator:JSON.parse(row.source_locator_json),sourceContentRevision:row.source_content_revision,
          span:{start:row.span_start,end:row.span_end},messageCreatedAt:row.message_created_at,
          provenance:JSON.parse(row.provenance_json),authoredUrlState:row.authored_url_state,...(row.exact_authored_href===null?{}:{exactAuthoredHref:row.exact_authored_href}),
          ...(row.excerpt_state==null?{}:{excerpt:persistedExcerpt(row,row.source_content_revision) as import('@phosphorco/bb-cross-references').ExcerptRecordV2}),occurrenceKey:row.occurrence_key,observedAt:row.observed_at,confirmed:row.confirmed_in_scan===1};
      })};
  }

  /** Commit edge claims and bounded locations together inside the collector's
   * existing generation fence. v1 count/digest/revision semantics stay intact. */
  replaceConversationMentions(source:Resource, scan:MentionScan, deleted=false):CrossReferencesChangedSignal[] {
    const canonicalSource=canonicalizeResource(source);
    // Resources carry presentation; identity-only store/v1 readers deliberately
    // reject it. Project the validated identity explicitly at every boundary.
    const sourceIdentity={provider:canonicalSource.provider,keys:canonicalSource.keys};
    const normalized=scan.occurrences.map(({target,...location})=>({target:serializeResource(canonicalizeResource(target)),...MentionLocationSchema.parse(location)}));
    const bodies=new Map<string,{body:string;frame:ReturnType<typeof mentionFrame>;hrefs:Map<string,string>;revision:string}>();
    for(const row of normalized) {
      const state=row.authoredUrlState??'unknown';
      if((state==='exact')!==(row.exactAuthoredHref!==undefined))throw new Error('Inconsistent authored URL state.');
      if(row.excerpt?.state==='ready'||state==='exact'){
        let proof=bodies.get(row.locator.messageId);
        if(!proof){const body=scan.sourceBodies?.get(row.locator.messageId);if(body===undefined||body.length>MENTION_LIMITS.messageChars)throw new Error('Admitted source body required for new evidence proof.');
          const frame=mentionFrame(body);proof={body,frame,hrefs:new Map(frame.links.flatMap(l=>l.authoredHref?[[`${l.span.start}:${l.span.end}`,l.authoredHref] as const]:[])),revision:sha256Hex(body)};bodies.set(row.locator.messageId,proof);}
        if(proof.revision!==row.sourceContentRevision||row.span.end>proof.body.length)throw new Error('Evidence source body binding mismatch.');
        if(state==='exact'&&proof.body.slice(row.span.start,row.span.end)!==row.exactAuthoredHref&&
          proof.hrefs.get(`${row.span.start}:${row.span.end}`)!==row.exactAuthoredHref)throw new Error('Authored destination lacks original spelling proof.');
        const ex=row.excerpt;
        if(ex?.state==='ready'){
          if(!isUtf16CodePointBoundary(proof.body,ex.sourceSpan.start)||!isUtf16CodePointBoundary(proof.body,ex.sourceSpan.end)||
             !isUtf16CodePointBoundary(proof.body,row.span.start)||!isUtf16CodePointBoundary(proof.body,row.span.end))throw new Error('Excerpt source offsets split a UTF16 code point.');
          if(proof.body.slice(ex.sourceSpan.start,ex.sourceSpan.end)!==ex.text||ex.sourceSpan.end>proof.body.length||
             ex.matchSpan.start!==Math.max(0,row.span.start-ex.sourceSpan.start)||ex.matchSpan.end!==Math.min(row.span.end,ex.sourceSpan.end)-ex.sourceSpan.start||
             ex.matchClippedBefore!==(ex.sourceSpan.start>row.span.start)||ex.matchClippedAfter!==(ex.sourceSpan.end<row.span.end))throw new Error('Excerpt does not prove its original slice.');
          // Sorted forbidden intervals; only a local predecessor/next seek is needed.
          const holes=proof.frame.forbidden;let lo=0,hi=holes.length;
          while(lo<hi){const mid=(lo+hi)>>>1;if(holes[mid]!.end<=ex.sourceSpan.start)lo=mid+1;else hi=mid;}
          if(holes[lo]&&holes[lo]!.start<ex.sourceSpan.end)throw new Error('Excerpt crosses excluded source content.');
        }
      }
      if(row.locator.threadId!==source.keys.thread)throw new Error('Location belongs to another source.');
      // The adapter, rather than an opaque raw id parser, defines the mapping.
      if(row.target.provider==='recognition' || row.provenance.source.provider==='bb.file' || row.provenance.verifiedFile){
        const file=row.provenance.verifiedFile;
        if(row.provenance.source.provider==='bb.file' && !file)throw new Error('Native file assertion requires verified frame metadata.');
        if(file && row.provenance.source.provider!=='bb.file')throw new Error('Verified file metadata requires a native file source.');
        if(file?.kind==='thread-storage' && file.threadId!==sourceIdentity.keys.thread)throw new Error('File storage owner does not match its source.');
        const mapped=file?verifiedFileIdentity(file):recognitionIdentity(row.provenance.source);
        if(canonicalizeIdentity(mapped).canonicalIdentityJson!==canonicalizeResource(row.target).canonicalIdentityJson)throw new Error('Recognition identity mapping mismatch.');
      }
    }
    return this.db.transaction(()=>{
      const prior=this.mentionState(sourceIdentity);
      const now=Date.now(), fullyObserved=new Set(scan.observedMessageIds), scanned=new Set(scan.scannedMessageIds), failed=new Set(scan.failedSuppliers);
      const retained:Array<ObservedMention & {occurrenceKey:string;observedAt:number;confirmed:boolean}>=[];
      const incoming=normalized.map(row=>({...row,occurrenceKey:mentionKey(row),observedAt:now,confirmed:true}));
      const byLocation=new Map(incoming.map(row=>[row.occurrenceKey,row]));
      if(!deleted)for(const row of prior.occurrences){
        const supplierUncertain=row.provenance.origin==='contributed' && (scan.discoveryIncomplete || failed.has(row.provenance.pluginId));
        const missingMessage=scan.coverage.timelineComplete && !scanned.has(row.locator.messageId);
        if(missingMessage)continue;
        const replacement=byLocation.get(row.occurrenceKey);
        if(replacement) {
          // A transport failure is not evidence that a typed observation went
          // away. Keep it unconfirmed instead of adding a second generic edge.
          if(supplierUncertain && replacement.provenance.source.provider==='bb.url' && replacement.sourceContentRevision===row.sourceContentRevision){
            byLocation.delete(row.occurrenceKey);retained.push({...row,confirmed:false});
          }
          continue;
        }
        if(!fullyObserved.has(row.locator.messageId) || supplierUncertain)retained.push({...row,confirmed:false});
      }
      const groups=new Map<string,typeof retained>();
      const groupKeys=new Map<string,Set<string>>();
      for(const row of deleted?[]:[...byLocation.values(),...retained]){
        const key=canonicalizeResource(row.target).canonicalIdentityJson;
        const group=groups.get(key)??[];
        const keys=groupKeys.get(key)??new Set<string>();
        if(!keys.has(row.occurrenceKey)){keys.add(row.occurrenceKey);group.push(row);}
        groupKeys.set(key,keys);groups.set(key,group);
      }
      const incomplete=!scan.coverage.timelineComplete || scan.coverage.reasons.length>0 || scan.discoveryIncomplete || failed.size>0;
      let capHistoryUnknown=!deleted && incomplete && prior.coverage?.capHistoryUnknown===true;
      const durableCaps=new Map<string,MentionEdgeCap>();
      if(incomplete && !deleted)for(const cap of prior.edgeCaps)if(cap.state!=='uncapped')durableCaps.set(canonicalizeIdentity(cap.target).canonicalIdentityJson,cap);
      // A bounded sample cannot prove that earlier clipping stopped. Reset only
      // after sufficient complete observation or this producer/source tombstone.
      let retentionLimited=!deleted && (scan.coverage.retentionLimited || (incomplete && prior.coverage?.retentionLimited===true));
      const ordered=[...groups].map(([key,rows])=>({key,rows:rows.sort((a,b)=>b.messageCreatedAt-a.messageCreatedAt || a.locator.messageId.localeCompare(b.locator.messageId) || a.span.start-b.span.start || a.occurrenceKey.localeCompare(b.occurrenceKey))}))
        .sort((a,b)=>b.rows[0]!.messageCreatedAt-a.rows[0]!.messageCreatedAt || a.key.localeCompare(b.key));
      if(ordered.length>MENTION_LIMITS.targets)retentionLimited=true;
      const selectedGroups=ordered.slice(0,MENTION_LIMITS.targets);
      const kept=selectedGroups.flatMap(group=>{
        if(group.rows.length>MENTION_LIMITS.perEdge){
          retentionLimited=true;
          const identity=canonicalizeResource(group.rows[0]!.target);
          durableCaps.set(group.key,{target:{provider:identity.provider,keys:identity.keys},state:'capped'});
        }
        return group.rows.slice(0,MENTION_LIMITS.perEdge);
      });
      const observations:ObservedReference[]=selectedGroups.map(group=>({target:group.rows[0]!.target,lastSeenAt:group.rows[0]!.messageCreatedAt}));
      // Pre-migration native claims lack locations. An incomplete scan cannot
      // withdraw them. Known located claims follow the message/supplier scope.
      const current=this.getProjection({producerPluginId:'cross-references',source:sourceIdentity}).projection;
      const located=new Set(prior.occurrences.map(row=>canonicalizeResource(row.target).canonicalIdentityJson));
      if(incomplete && !deleted)for(const target of current?.targets??[]){
        if(!located.has(canonicalizeResource(target).canonicalIdentityJson))observations.push({target,lastSeenAt:null});
      }
      // Retained claims keep the original v1 lastSeenAt meaning and time, even
      // when the newest location was clipped by the bounded retained sample.
      if(incomplete){
        const times=this.listForwardReferences({source:sourceIdentity,producerPluginId:'cross-references',pageSize:100});
        let page=times;
        const priorTimes=new Map<string,number|null>();
        while(true){for(const row of page.rows)priorTimes.set(canonicalizeResource(row.target).canonicalIdentityJson,row.lastSeenAt??null);
          if(!page.nextCursor)break;page=this.listForwardReferences({source:sourceIdentity,producerPluginId:'cross-references',pageSize:100,cursor:page.nextCursor});}
        for(const row of observations)row.lastSeenAt=Math.max(row.lastSeenAt??-1,priorTimes.get(canonicalizeResource(row.target).canonicalIdentityJson)??-1);
        for(const row of observations)if(row.lastSeenAt===-1)row.lastSeenAt=null;
      }
      // Fit the existing exact v1 payload before its strict writer runs. Measure
      // canonical target JSON once and add comma bytes, rather than serializing
      // an ever-growing projection on every candidate. Ordering/dedup matches
      // the existing native edge selector; no protocol cap is relaxed.
      const candidates=new Map<string,{target:Resource;lastSeenAt:number|null;canonical:CanonicalResource}>();
      for(const row of observations){const canonical=canonicalizeResource(row.target),key=canonical.canonicalIdentityJson,prior=candidates.get(key);
        if(!prior || (row.lastSeenAt??-1)>(prior.lastSeenAt??-1))candidates.set(key,{...row,canonical});}
      const ranked=[...candidates].sort(([a,ar],[b,br])=>(br.lastSeenAt??-1)-(ar.lastSeenAt??-1) || (a<b?-1:a>b?1:0));
      const fitted:ObservedReference[]=[];
      let payloadBytes=utf8ByteLength(projectionPayloadJson('cross-references',canonicalSource,deleted,[])),payloadLimited=false;
      for(const [,row] of ranked.slice(0,MENTION_LIMITS.targets)){
        const extra=utf8ByteLength(JSON.stringify(serializeResource(row.canonical)))+(fitted.length?1:0);
        if(payloadBytes+extra>MAX_PROJECTION_PAYLOAD_BYTES){payloadLimited=true;continue;}
        fitted.push({target:row.target,lastSeenAt:row.lastSeenAt});payloadBytes+=extra;
      }
      if(payloadLimited){retentionLimited=true;capHistoryUnknown=true;}
      const signals=this.replaceObservedThreadReferences(source,fitted,true,deleted);
      const sourceId=this.findResource(canonicalSource)!.id;
      const active=this.getProjection({producerPluginId:'cross-references',source:sourceIdentity}).projection!;
      const activeKeys=new Set(active.targets.map(t=>canonicalizeResource(t).canonicalIdentityJson));
      const final=kept.filter(row=>activeKeys.has(canonicalizeResource(row.target).canonicalIdentityJson));
      if(final.length!==kept.length)retentionLimited=true;
      // Only retained graph targets get keyed metadata. Remember any discarded
      // clipping with one source bit rather than accumulating inactive targets.
      for(const key of durableCaps.keys())if(!activeKeys.has(key)){durableCaps.delete(key);capHistoryUnknown=true;}
      const priorActiveKeys=new Set((current?.targets??[]).map(target=>canonicalizeResource(target).canonicalIdentityJson));
      if(capHistoryUnknown && incomplete)for(const target of active.targets){
        const identity=canonicalizeResource(target),key=identity.canonicalIdentityJson;
        if(!priorActiveKeys.has(key) && !durableCaps.has(key))durableCaps.set(key,{target:{provider:identity.provider,keys:identity.keys},state:'unknown'});
      }
      const edgeCaps=[...durableCaps].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([,cap])=>cap);
      retentionLimited=retentionLimited || edgeCaps.length>0 || capHistoryUnknown;
      const coverage={...scan.coverage,retentionLimited,capHistoryUnknown,
        reasons:[...new Set([...scan.coverage.reasons,...(payloadLimited?['projection-payload-budget']:[])])].sort()};
      const digest=sha256Hex(canonicalJson({boundGraphRevision:active.revision,coverage,edgeCaps,locations:final.map(row=>({target:canonicalizeResource(row.target).canonicalIdentityJson,
        locator:row.locator,sourceContentRevision:row.sourceContentRevision,span:row.span,messageCreatedAt:row.messageCreatedAt,
        provenance:row.provenance,confirmed:row.confirmed,excerpt:row.excerpt??null,authoredUrlState:row.authoredUrlState??'unknown',exactAuthoredHref:row.exactAuthoredHref??null})).sort((a,b)=>canonicalJson(a).localeCompare(canonicalJson(b)))}));
      const revision=prior.revision+(digest!==prior.digest?1:0);
      this.db.prepare(`INSERT INTO mention_streams (producer_plugin_id, source_resource_id, evidence_revision, evidence_digest, collector_version, coverage_json, last_successful_scan_at, cap_history_unknown,bound_graph_revision) VALUES ('cross-references', ?, ?, ?, 2, ?, ?, ?, ?)
        ON CONFLICT(producer_plugin_id,source_resource_id) DO UPDATE SET evidence_revision=excluded.evidence_revision,
        evidence_digest=excluded.evidence_digest,coverage_json=excluded.coverage_json,last_successful_scan_at=excluded.last_successful_scan_at,cap_history_unknown=excluded.cap_history_unknown,bound_graph_revision=excluded.bound_graph_revision,collector_version=2`)
        .run(sourceId,revision,digest,canonicalJson(coverage),now,capHistoryUnknown?1:0,active.revision);
      this.db.prepare(`DELETE FROM mention_edge_caps WHERE producer_plugin_id = 'cross-references' AND source_resource_id = ?`).run(sourceId);
      const insertCap=this.db.prepare(`INSERT INTO mention_edge_caps VALUES ('cross-references', ?, ?, ?)`);
      for(const cap of edgeCaps){
        const target=this.findResource(canonicalizeIdentity(cap.target));
        if(!target)throw new Error('Cap state without a retained resource identity.');
        insertCap.run(sourceId,target.id,cap.state);
      }
      this.db.prepare(`DELETE FROM mention_occurrences WHERE producer_plugin_id = 'cross-references' AND source_resource_id = ?`).run(sourceId);
      const insert=this.db.prepare(`INSERT INTO mention_occurrences(producer_plugin_id,source_resource_id,target_resource_id,occurrence_key,source_locator_json,source_content_revision,span_start,span_end,message_created_at,observed_at,provenance_json,confirmed_in_scan,authored_url_state,exact_authored_href)
        VALUES ('cross-references', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      const insertExcerpt=this.db.prepare(`INSERT INTO mention_excerpts VALUES ('cross-references',?,?,?,?,1,?,?,?,?,?,?,?,?,?,?,?)`);
      for(const row of final){
        const targetId=this.findResource(canonicalizeResource(row.target))!.id;
        if(row.target.provider==='recognition')this.db.prepare(`INSERT INTO recognized_resources VALUES (?, ?, 1)
          ON CONFLICT(resource_id) DO NOTHING`).run(targetId,row.provenance.verifiedFile?verifiedFileIdentityRecord(row.provenance.verifiedFile):recognitionIdentityRecord(row.provenance.source));
        insert.run(sourceId,targetId,row.occurrenceKey,canonicalJson(row.locator),row.sourceContentRevision,row.span.start,row.span.end,
          row.messageCreatedAt,row.observedAt,canonicalJson(row.provenance),row.confirmed?1:0,row.authoredUrlState??'unknown',row.exactAuthoredHref??null);
        const ex=row.excerpt;
        if(ex)insertExcerpt.run(sourceId,targetId,row.occurrenceKey,row.sourceContentRevision,ex.state,ex.state==='ready'?ex.text:null,
          ex.state==='ready'?ex.sourceSpan.start:null,ex.state==='ready'?ex.sourceSpan.end:null,ex.state==='ready'?ex.matchSpan.start:null,ex.state==='ready'?ex.matchSpan.end:null,
          ex.state==='ready'&&ex.clippedBefore?1:0,ex.state==='ready'&&ex.clippedAfter?1:0,ex.state==='ready'&&ex.matchClippedBefore?1:0,ex.state==='ready'&&ex.matchClippedAfter?1:0,ex.state==='unavailable'?ex.reason:null);
      }
      if(digest!==prior.digest && signals.length===0)signals.push({
        protocolVersion:1,producerPluginId:'cross-references',sourceIdentityDigest:canonicalSource.identityDigest,
        revision:active.revision,affectedIdentityDigests:[...new Set([canonicalSource.identityDigest,
          ...active.targets.map(t=>canonicalizeResource(t).identityDigest),
          ...prior.edgeCaps.map(cap=>canonicalizeIdentity(cap.target).identityDigest)])],
      });
      return signals;
    })();
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
    if (targetRow === null) return { rows: [], total: 0, nextCursor: null };

    // Group within the captured upper bound before applying afterId or LIMIT:
    // duplicate producer assertions must not leak into later pages.
    const matching = `SELECT MIN(reference_occurrences.id) AS occurrence_id, MAX(reference_occurrences.last_seen_at) AS last_seen_at
         FROM reference_occurrences
         JOIN source_projections
           ON source_projections.id = reference_occurrences.projection_id
        WHERE reference_occurrences.target_resource_id = ?
          AND source_projections.tombstone = 0
          AND reference_occurrences.id <= ?
        GROUP BY source_projections.source_resource_id`;
    const total = (this.db.prepare(
      `SELECT COUNT(*) AS total FROM (${matching})`,
    ).get(targetRow.id, cursor.upperId) as { total: number }).total;

    const rows = this.db.prepare(
      `SELECT reference_occurrences.id AS occurrence_id, matching.last_seen_at,
              source_resources.provider AS source_provider,
              source_resources.canonical_keys_json AS source_canonical_keys_json,
              source_projections.source_presentation_json,
              source_projections.producer_plugin_id,
              source_projections.revision,
              reference_occurrences.target_presentation_json,
              reference_occurrences.position
         FROM (${matching}) AS matching
         JOIN reference_occurrences
           ON reference_occurrences.id = matching.occurrence_id
         JOIN source_projections
           ON source_projections.id = reference_occurrences.projection_id
         JOIN resources AS source_resources
           ON source_resources.id = source_projections.source_resource_id
        WHERE reference_occurrences.id > ?
        ORDER BY reference_occurrences.id ASC
        LIMIT ?`,
    ).all(targetRow.id, cursor.upperId, cursor.afterId, pageSize + 1) as BacklinkQueryRow[];

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
      lastSeenAt: row.last_seen_at,
    }));
    return { rows: backlinkRows, total: validateRevision(total, "backlink total", 0), nextCursor };
  }

  /**
   * Read one representative occurrence per exact target identity. Producer
   * projections retain all assertions; no reverse relationship is materialized.
   */
  listForwardReferences(input: ListForwardReferencesInput): ListForwardReferencesResponse {
    const sourceIdentity = normalizeIdentityInput(input.source);
    const producerPluginId = input.producerPluginId === undefined ? null : validateProducerPluginId(input.producerPluginId);
    const pageSize = defaultPageSize(input.pageSize);
    const highWatermark = this.occurrenceHighWatermark();
    const cursor = input.cursor === undefined
      ? {
          v: 1 as const,
          sourceDigest: sourceIdentity.identityDigest,
          producerPluginId,
          upperId: this.currentOccurrenceMaximum(),
          afterId: 0,
        }
      : decodeForwardReferenceCursor(input.cursor, sourceIdentity.identityDigest, producerPluginId, highWatermark);
    const sourceRow = this.findResource(sourceIdentity);
    if (sourceRow === null) return { rows: [], total: 0, nextCursor: null };

    const matching = `SELECT MIN(reference_occurrences.id) AS occurrence_id, MAX(reference_occurrences.last_seen_at) AS last_seen_at
         FROM source_projections
         JOIN reference_occurrences
           ON reference_occurrences.projection_id = source_projections.id
        WHERE source_projections.source_resource_id = ?
          AND source_projections.tombstone = 0
          AND (? IS NULL OR source_projections.producer_plugin_id = ?)
          AND reference_occurrences.id <= ?
        GROUP BY reference_occurrences.target_resource_id`;
    const total = (this.db.prepare(
      `SELECT COUNT(*) AS total FROM (${matching})`,
    ).get(sourceRow.id, producerPluginId, producerPluginId, cursor.upperId) as { total: number }).total;

    const rows = this.db.prepare(
      `SELECT reference_occurrences.id AS occurrence_id, matching.last_seen_at,
              target_resources.provider AS target_provider,
              target_resources.canonical_keys_json AS target_canonical_keys_json,
              reference_occurrences.target_presentation_json,
              source_projections.producer_plugin_id,
              source_projections.revision,
              reference_occurrences.position
         FROM (${matching}) AS matching
         JOIN reference_occurrences
           ON reference_occurrences.id = matching.occurrence_id
         JOIN source_projections
           ON source_projections.id = reference_occurrences.projection_id
         JOIN resources AS target_resources
           ON target_resources.id = reference_occurrences.target_resource_id
        WHERE reference_occurrences.id > ?
        ORDER BY reference_occurrences.id ASC
        LIMIT ?`,
    ).all(sourceRow.id, producerPluginId, producerPluginId, cursor.upperId, cursor.afterId, pageSize + 1) as ForwardReferenceQueryRow[];

    const hasNext = rows.length > pageSize;
    const page = hasNext ? rows.slice(0, pageSize) : rows;
    const nextCursor = hasNext
      ? encodeForwardReferenceCursor({
          v: 1,
          sourceDigest: sourceIdentity.identityDigest,
          producerPluginId,
          upperId: cursor.upperId,
          afterId: page.at(-1)!.occurrence_id,
        })
      : null;
    const forwardRows: ForwardReferenceRow[] = page.map((row) => ({
      target: resourceFromRow({
        id: 0,
        provider: row.target_provider,
        canonical_keys_json: row.target_canonical_keys_json,
      }, row.target_presentation_json),
      producerPluginId: row.producer_plugin_id,
      revision: row.revision,
      position: row.position,
      lastSeenAt: row.last_seen_at,
    }));
    return { rows: forwardRows, total: validateRevision(total, "forward-reference total", 0), nextCursor };
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
