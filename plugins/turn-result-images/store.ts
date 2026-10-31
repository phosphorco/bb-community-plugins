import type Database from 'better-sqlite3';
import { InputSchemas, PathSchema, canonicalJson, canonicalByteLength, claimKey, checkResolutionTransition, JsonAdmissionError } from '@phosphorco/bb-turn-results';
import type { Resolution, SourceRef } from '@phosphorco/bb-turn-results';
import { imageIdentity } from './recognition.ts';
import type { ImageHistory, ImageMaterialization } from './verification.ts';
import { MAX_MATERIALIZATION_BYTES } from './image-policy.ts';

export interface ImageStoreEntry { history: ImageHistory; materialization: ImageMaterialization | null; resolution: Resolution }
export type ImageCommit = { state: 'committed' | 'unchanged'; entry: ImageStoreEntry } | { state: 'conflict' | 'capacity'; reason: string };
export interface ImageStoreStats { rows: number; logicalBytes: number; physicalBytes: number; evicted: number; epoch: string; head: number }
export interface ImageObservationStore {
  read(source: SourceRef): ImageStoreEntry | null;
  commit(entry: ImageStoreEntry): ImageCommit;
  stats(): ImageStoreStats;
}
export const IMAGE_STORE_LIMITS = Object.freeze({ maxRowBytes: 24_576, maxLogicalBytes: 24 * 1024 * 1024,
  maxRows: 1024, maxRowsPerThread: 128, maxPhysicalBytes: 64 * 1024 * 1024, maxEvictions: 32, busyTimeoutMs: 100 });
export interface ImageStoreOptions {
  maxRowBytes?: number; maxLogicalBytes?: number; maxRows?: number; maxRowsPerThread?: number;
  maxPhysicalBytes?: number; maxEvictions?: number; busyTimeoutMs?: number; epochFactory?: () => string;
}
export class ImageStoreError extends Error {
  readonly code: 'invalid-entry' | 'corrupt' | 'schema' | 'database' | 'physical-capacity' | 'capacity';
  constructor(code: ImageStoreError['code'], message: string) { super(message); this.name = 'ImageStoreError'; this.code = code; }
}
class Rollback extends Error {
  readonly state: 'conflict' | 'capacity';
  constructor(state: Rollback['state'], reason: string) { super(reason); this.state = state; }
}
const owner = 'turn-result-images';
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const sha = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
function ensure(value: unknown, reason: string): asserts value { if (!value) throw new Error(reason); }
function keys(value: object, allowed: readonly string[]) { ensure(Object.keys(value).every(key => allowed.includes(key)), 'Unknown stored field.'); }
function validate(raw: unknown, maxBytes: number): ImageStoreEntry {
  // Canonical admission walks data descriptors, rejecting accessors, cycles,
  // nonplain objects and excessive strings BEFORE JSON parsing/schema traversal.
  const entry = JSON.parse(canonicalJson(raw, maxBytes)) as ImageStoreEntry;
  ensure(entry && typeof entry === 'object', 'Expected entry.');
  function sparse(value: unknown): void {
    if (typeof value === 'string') { ensure(!/^data:[^,]*;base64,/iu.test(value), 'Encoded media is not sparse evidence.'); return; }
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      ensure(!['prompt', 'revisedprompt', 'revised_prompt', 'transcript', 'base64', 'bytes', 'contentencoding', 'providerresult'].includes(key.toLowerCase()), 'Provider payload is not sparse evidence.');
      sparse(child);
    }
  }
  sparse(entry);
  keys(entry, ['history', 'materialization', 'resolution']);
  const h = entry.history;
  ensure(h && typeof h === 'object', 'Missing history.');
  keys(h, ['identity', 'proof', 'nativeCreatedAt', 'path', 'providerSha256']);
  h.identity = InputSchemas.identity.parse(h.identity);
  h.proof = InputSchemas.proof.parse(h.proof) as ImageHistory['proof'];
  ensure(h.proof.kind === 'native-image', 'Expected native image proof.');
  PathSchema.parse(h.path);
  ensure(/^(?:\/|[A-Za-z]:[\\/]|\\\\)/u.test(h.path) && !h.path.split(/[\\/]/u).includes('..'), 'Expected exact absolute saved path.');
  ensure(integer(h.nativeCreatedAt), 'Invalid native creation time.');
  ensure(h.providerSha256 === null || sha(h.providerSha256), 'Invalid provider SHA.');
  ensure(same(h.identity, imageIdentity(h.identity.ref.source, h.identity.evidence.selectedDigest, h.path)), 'Image identity/path conflict.');
  ensure(same(h.proof.source, h.identity.ref.source) && h.proof.selectedDigest === h.identity.evidence.selectedDigest, 'Proof/source conflict.');
  ensure((h.proof.artifactDigest ?? null) === h.providerSha256, 'Provider proof digest conflict.');
  entry.resolution = InputSchemas.resolution.parse(entry.resolution);
  const r = entry.resolution;
  ensure(same(r.identity, h.identity) && same(r.proof, h.proof), 'Resolution identity/proof conflict.');
  ensure(r.knowledge === 'confirmed' && r.outcomeEvidence?.kind === 'observation'
    && r.outcomeEvidence.id === h.identity.ref.source.eventId
    && r.outcomeEvidence.digest === h.identity.evidence.selectedDigest
    && r.outcomeEvidence.recordedAt === h.nativeCreatedAt, 'Original completed generation evidence conflict.');
  const m = entry.materialization;
  ensure(m === null || !!m && typeof m === 'object', 'Missing materialization field.');
  if (m !== null) {
    try { canonicalJson(m, MAX_MATERIALIZATION_BYTES); }
    catch (error) {
      if (error instanceof JsonAdmissionError && error.code === 'over-budget') throw new ImageStoreError('capacity', 'materialization-byte-cap');
      throw error;
    }
    keys(m, ['schema', 'identity', 'proof', 'providerSha256', 'path', 'target', 'nativeCreatedAt', 'width', 'height', 'sizeBytes', 'verifiedAt']);
    ensure(m.schema === 1 && same(m.identity, h.identity) && same(m.proof, h.proof), 'Materialization identity/proof conflict.');
    const target = InputSchemas.file.parse(m.target);
    ensure(target.kind === 'host' && target.path === h.path && m.path === h.path, 'Materialization exact target/path conflict.');
    ensure(sha(m.providerSha256) && m.providerSha256 === h.providerSha256 && m.nativeCreatedAt === h.nativeCreatedAt, 'Materialization original evidence conflict.');
    ensure(integer(m.width) && m.width > 0 && m.width <= 0x7fffffff && integer(m.height) && m.height > 0 && m.height <= 0x7fffffff, 'Invalid PNG header dimensions.');
    ensure(integer(m.sizeBytes) && m.sizeBytes > 0 && m.sizeBytes <= 8 * 1024 * 1024 && integer(m.verifiedAt), 'Invalid materialization metadata.');
  }
  if (r.route.kind === 'file') ensure(m !== null && same(r.route.target, m.target), 'File route lacks exact verified binding.');
  if (r.provenance.artifactLocation.state === 'verified') {
    ensure(m !== null && same(r.provenance.artifactLocation.target, m.target)
      && r.provenance.artifactLocation.sha256 === m.providerSha256, 'Verified location lacks exact verified binding.');
  }
  if (r.route.kind === 'source') ensure(r.route.threadId === h.identity.ref.source.threadId
    && r.route.eventId === h.identity.ref.source.eventId && r.route.seq === h.identity.ref.source.seq, 'Source route conflict.');
  // Native history has no historical host evidence. Current materialization is
  // availability evidence only, even after a restart.
  ensure(r.provenance.originHost.state === 'unknown', 'Historical origin is not recorded.');
  canonicalJson(entry, maxBytes);
  return entry;
}
interface Meta { schema_version: number; epoch: string; head: number; evicted: number; row_count: number; logical_bytes: number }
interface Row { claim_key: string; thread_id: string; event_id: string; payload_bytes: number; payload_json: string; updated_sequence: number }

/** Host owns the dedicated database handle and its lifecycle. There are no
 * background jobs, last-access writes, bytes, transcript or feed tombstones.
 * Physical cap measures allocated MAIN pages; DELETE journals are transient and
 * may additionally approach main DB size (plus SQLite journal headers).
 */
export function createImageObservationStore(db: Database.Database, options: ImageStoreOptions = {}): ImageObservationStore {
  const limits: { -readonly [K in keyof typeof IMAGE_STORE_LIMITS]: number } = { ...IMAGE_STORE_LIMITS };
  for (const key of Object.keys(IMAGE_STORE_LIMITS) as (keyof typeof limits)[]) {
    const value = options[key];
    if (value === undefined) continue;
    if (!integer(value) || value > IMAGE_STORE_LIMITS[key] || (value < 1 && key !== 'maxEvictions' && key !== 'busyTimeoutMs')) throw new RangeError(`Invalid lower-only ${key}.`);
    limits[key] = value;
  }
  const numberPragma = (name: string) => {
    const value: unknown = db.pragma(name, { simple: true });
    if (!integer(value)) throw new ImageStoreError('database', `Invalid SQLite ${name}.`);
    return value;
  };
  db.pragma(`busy_timeout = ${limits.busyTimeoutMs}`);
  const journal: unknown = db.pragma('journal_mode = DELETE', { simple: true });
  if (journal !== 'delete') throw new ImageStoreError('database', 'Dedicated file database must use DELETE journal mode.');
  const pageSize = numberPragma('page_size');
  const maxPages = Math.floor(limits.maxPhysicalBytes / pageSize);
  if (maxPages < 1 || numberPragma('page_count') > maxPages) throw new ImageStoreError('physical-capacity', 'Existing main DB exceeds physical cap.');
  const actualMax = numberPragma(`max_page_count = ${maxPages}`);
  if (actualMax > maxPages) throw new ImageStoreError('physical-capacity', 'SQLite physical page cap was not applied.');
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('image_observation_meta','image_observation_records')").all() as { name: string }[];
  if (tables.length === 1) throw new ImageStoreError('corrupt', 'Incomplete image store schema.');
  if (tables.length === 0) {
    db.transaction(() => {
      db.exec(`CREATE TABLE image_observation_meta (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1), schema_version INTEGER NOT NULL,
        epoch TEXT NOT NULL, head INTEGER NOT NULL, evicted INTEGER NOT NULL,
        row_count INTEGER NOT NULL, logical_bytes INTEGER NOT NULL);
        CREATE TABLE image_observation_records (
        claim_key TEXT PRIMARY KEY, thread_id TEXT NOT NULL, event_id TEXT NOT NULL,
        payload_bytes INTEGER NOT NULL, payload_json TEXT NOT NULL, updated_sequence INTEGER NOT NULL);
        CREATE INDEX image_observation_oldest ON image_observation_records(updated_sequence,claim_key);
        CREATE INDEX image_observation_thread_oldest ON image_observation_records(thread_id,updated_sequence,claim_key);`);
      const epoch = (options.epochFactory ?? (() => globalThis.crypto.randomUUID()))();
      InputSchemas.revision.parse({ epoch, sequence: 0 });
      db.prepare('INSERT INTO image_observation_meta VALUES(1,1,?,0,0,0,0)').run(epoch);
    }).immediate();
  }
  function meta(): Meta {
    const m = db.prepare('SELECT * FROM image_observation_meta WHERE singleton=1').get() as Meta | undefined;
    if (!m) throw new ImageStoreError('corrupt', 'Missing image store metadata.');
    if (m.schema_version !== 1) throw new ImageStoreError('schema', 'Unsupported image store schema.');
    try {
      InputSchemas.revision.parse({ epoch: m.epoch, sequence: m.head });
      ensure(integer(m.evicted) && integer(m.row_count) && m.row_count <= IMAGE_STORE_LIMITS.maxRows
        && integer(m.logical_bytes) && m.logical_bytes <= IMAGE_STORE_LIMITS.maxLogicalBytes, 'Invalid counters.');
      ensure(m.row_count === 0 ? m.logical_bytes === 0 : m.logical_bytes > 0, 'Inconsistent counters.');
    } catch { throw new ImageStoreError('corrupt', 'Invalid image store metadata.'); }
    return m;
  }
  meta();
  const find = db.prepare('SELECT * FROM image_observation_records WHERE claim_key=?');
  function decode(row: Row, m: Meta): ImageStoreEntry {
    try {
      // No unbounded JSON parse when the database itself has been corrupted.
      ensure(typeof row.payload_json === 'string' && row.payload_json.length <= IMAGE_STORE_LIMITS.maxRowBytes, 'Oversized stored JSON.');
      ensure(integer(row.payload_bytes) && row.payload_bytes <= IMAGE_STORE_LIMITS.maxRowBytes, 'Invalid row size.');
      ensure(new TextEncoder().encode(row.payload_json).byteLength <= IMAGE_STORE_LIMITS.maxRowBytes, 'Oversized UTF8 stored JSON.');
      const entry = validate(JSON.parse(row.payload_json), IMAGE_STORE_LIMITS.maxRowBytes);
      ensure(canonicalJson(entry, IMAGE_STORE_LIMITS.maxRowBytes) === row.payload_json
        && canonicalByteLength(entry, IMAGE_STORE_LIMITS.maxRowBytes) === row.payload_bytes, 'Noncanonical stored JSON/size.');
      ensure(claimKey(owner, entry.history.identity.ref) === row.claim_key && row.thread_id === entry.history.identity.ref.source.threadId
        && row.event_id === entry.history.identity.ref.source.eventId, 'Stored key mismatch.');
      ensure(integer(row.updated_sequence) && row.updated_sequence > 0 && row.updated_sequence <= m.head
        && entry.resolution.revision.epoch === m.epoch && entry.resolution.revision.sequence === row.updated_sequence, 'Stored revision mismatch.');
      return entry;
    } catch { throw new ImageStoreError('corrupt', 'Corrupt image observation row.'); }
  }
  const semantic = (entry: ImageStoreEntry) => canonicalJson({ ...entry, resolution: { ...entry.resolution, revision: null } }, IMAGE_STORE_LIMITS.maxRowBytes);
  const save = db.transaction((raw: ImageStoreEntry): ImageCommit => {
    const m = meta();
    let incoming: ImageStoreEntry;
    try {
      // First charge the entire caller object, including its ignored revision.
      canonicalJson(raw, limits.maxRowBytes);
      incoming = validate({ ...raw, resolution: { ...raw.resolution, revision: { epoch: m.epoch, sequence: Math.min(Number.MAX_SAFE_INTEGER, m.head + 1) } } }, limits.maxRowBytes);
    } catch (error) {
      if (error instanceof ImageStoreError && error.code === 'capacity') throw new Rollback('capacity', error.message);
      if (error && typeof error === 'object' && 'code' in error && error.code === 'over-budget') throw new Rollback('capacity', 'row-byte-cap');
      throw new Rollback('conflict', 'invalid-image-entry');
    }
    let key: string;
    try { key = claimKey(owner, incoming.history.identity.ref); }
    catch { throw new Rollback('capacity', 'claim-key-admission'); }
    const previousRow = find.get(key) as Row | undefined;
    const previous = previousRow ? decode(previousRow, m) : null;
    if (previous) {
      const a = previous.history, b = incoming.history;
      if (!same(a.identity, b.identity) || a.path !== b.path || a.nativeCreatedAt !== b.nativeCreatedAt
        || a.providerSha256 !== null && a.providerSha256 !== b.providerSha256
        || previous.materialization !== null && !same(previous.materialization, incoming.materialization)) throw new Rollback('conflict', 'immutable-image-binding');
      if (semantic(previous) === semantic(incoming)) return { state: 'unchanged', entry: previous };
      if (m.head === Number.MAX_SAFE_INTEGER) throw new Rollback('capacity', 'revision-head-exhausted');
      try { if (checkResolutionTransition(previous.resolution, incoming.resolution) !== 'apply') throw new Error('Rejected transition.'); }
      catch { throw new Rollback('conflict', 'resolution-transition'); }
    }
    if (m.head === Number.MAX_SAFE_INTEGER) throw new Rollback('capacity', 'revision-head-exhausted');
    const payload = canonicalJson(incoming, limits.maxRowBytes);
    const bytes = canonicalByteLength(incoming, limits.maxRowBytes);
    let rows = m.row_count + (previous ? 0 : 1), logical = m.logical_bytes - (previousRow?.payload_bytes ?? 0) + bytes;
    let threadRows = (db.prepare('SELECT count(*) AS n FROM image_observation_records WHERE thread_id=?').get(incoming.history.identity.ref.source.threadId) as { n: number }).n + (previous ? 0 : 1);
    let evicted = 0;
    while (rows > limits.maxRows || logical > limits.maxLogicalBytes || threadRows > limits.maxRowsPerThread) {
      if (evicted >= limits.maxEvictions) throw new Rollback('capacity', 'eviction-write-cap');
      const victim = (threadRows > limits.maxRowsPerThread
        ? db.prepare('SELECT * FROM image_observation_records WHERE claim_key<>? AND thread_id=? ORDER BY updated_sequence,claim_key LIMIT 1').get(key, incoming.history.identity.ref.source.threadId)
        : db.prepare('SELECT * FROM image_observation_records WHERE claim_key<>? ORDER BY updated_sequence,claim_key LIMIT 1').get(key)) as Row | undefined;
      if (!victim) throw new Rollback('capacity', 'payload-capacity');
      decode(victim, m); // Corrupt history is never silently discarded as eviction.
      db.prepare('DELETE FROM image_observation_records WHERE claim_key=?').run(victim.claim_key);
      rows--; logical -= victim.payload_bytes; evicted++;
      if (victim.thread_id === incoming.history.identity.ref.source.threadId) threadRows--;
    }
    if (!integer(m.evicted + evicted)) throw new Rollback('capacity', 'eviction-counter-exhausted');
    db.prepare(`INSERT INTO image_observation_records VALUES(?,?,?,?,?,?) ON CONFLICT(claim_key) DO UPDATE SET
      payload_bytes=excluded.payload_bytes,payload_json=excluded.payload_json,updated_sequence=excluded.updated_sequence`).run(
      key, incoming.history.identity.ref.source.threadId, incoming.history.identity.ref.source.eventId, bytes, payload, m.head + 1);
    db.prepare('UPDATE image_observation_meta SET head=?,evicted=?,row_count=?,logical_bytes=? WHERE singleton=1').run(m.head + 1, m.evicted + evicted, rows, logical);
    return { state: 'committed', entry: incoming };
  });
  const read = db.transaction((source: SourceRef): ImageStoreEntry | null => {
      canonicalJson(source, 4096);
      const parsed = InputSchemas.source.parse(source);
      const ref = imageIdentity(parsed, '0'.repeat(64), '/key-only').ref;
      let key: string;
      try { key = claimKey(owner, ref); }
      catch (error) {
        if (error instanceof JsonAdmissionError && error.code === 'over-budget') throw new ImageStoreError('capacity', 'claim-key-admission');
        throw error;
      }
      const m = meta(), row = find.get(key) as Row | undefined;
      if (!row) return null;
      const entry = decode(row, m);
      if (!same(entry.history.identity.ref.source, parsed)) throw new ImageStoreError('invalid-entry', 'Requested source conflicts with stored original source.');
      return entry;
  });
  return {
    read(source) { return read.deferred(source); },
    commit(entry) {
      try { return save.immediate(entry); }
      catch (error) {
        if (error instanceof Rollback) return { state: error.state, reason: error.message };
        if (error instanceof ImageStoreError) throw error;
        const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
        if (code === 'SQLITE_FULL') return { state: 'capacity', reason: 'physical-page-cap' };
        if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED') return { state: 'capacity', reason: 'database-busy' };
        throw new ImageStoreError('database', 'Image observation transaction failed.');
      }
    },
    stats() { const m = meta(); return { rows: m.row_count, logicalBytes: m.logical_bytes,
      physicalBytes: numberPragma('page_count') * pageSize, evicted: m.evicted, epoch: m.epoch, head: m.head }; },
  };
}
