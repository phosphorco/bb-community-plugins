import type Database from 'better-sqlite3';
import {
  InputSchemas, IdentifierSchema, PluginIdSchema, canonicalJson, canonicalByteLength,
  claimKey, checkResolutionTransition, JsonAdmissionError, ResultsContractError, utf8Bytes,
} from '@phosphorco/bb-turn-results';
import type { ResultIdentity, ClaimRef, Resolution, FeedChange, JsonValue, SourceRevision, OutcomeEvidence } from '@phosphorco/bb-turn-results';

/** Dedicated injected public storage handle. The caller owns scheduling, native
 * validation, source membership admission, demanded work and database close.
 * This module performs no native/source reads and creates no background work. */
export const GALLERY_INDEX_LIMITS = Object.freeze({
  maxObservations: 8192, maxObservationsPerThread: 512, maxThreads: 1024,
  maxStages: 4096, maxStagesPerThread: 256, maxSuppliers: 4096, maxSuppliersPerThread: 256,
  maxLogicalBytes: 32 * 1024 * 1024, maxMetadataBytes: 4 * 1024 * 1024,
  maxPhysicalBytes: 96 * 1024 * 1024, busyTimeoutMs: 100,
});
export type GalleryIndexOptions = { [K in keyof typeof GALLERY_INDEX_LIMITS]?: number };
export interface CoverageInterval {
  fromSeq: number; throughSeq: number;
  state: 'indexed' | 'unindexed' | 'evicted' | 'unsupported' | 'oversized' | 'unplaced';
  owner?: string; reason?: string;
}
export interface StageValue {
  stage: 'discover' | 'native' | 'recognize' | 'resolve' | 'feed' | 'maintenance';
  cursor: string | null; status: 'ready' | 'parked' | 'complete';
  /** Caller-owned finite work: identities, refs/digests, balanced deferred groups,
   * range, expected revision, etc. Never normalized event text/transcripts. */
  debt: JsonValue;
}
export interface StageRecord { version: number; value: StageValue }
export interface SupplierState {
  revision: string; connection: 'connected' | 'disconnected' | 'unsupported';
  freshUntil: number | null;
  /** Feed reset can invalidate sibling observations without rewriting them. */
  epoch?: string | null;
}
interface SupplierRecord extends SupplierState { previousRevision: string | null; epoch: string | null; previousEpoch: string | null }
export type IndexChange = FeedChange | { kind: 'candidate'; identity: ResultIdentity };
export interface GalleryPage {
  /** Listed owner stamped by the consumer, never read from supplier payload. */
  owner: string; threadId: string; changes: IndexChange[];
  stage?: { id: string; expectedVersion: number | null; value: StageValue };
  supplier?: SupplierState;
  coverage?: CoverageInterval[];
  /** Explicit user historical reindex, never set by automatic mounted refresh. */
  allowReindex?: boolean;
}
export type IndexCommit =
  | { state: 'committed' | 'unchanged'; mutations: number; changedBytes: number; stageVersion: number | null }
  | { state: 'capacity' | 'conflict' | 'revalidate'; reason: string };
export interface GalleryObservation {
  key: string; owner: string; identity: ResultIdentity; resolution: Resolution | null;
  unresolved: boolean; firstObservedOrder: number;
  corrections: OutcomeEvidence[];
  sourceExpired: SourceRevision | null;
  retracted: { revision: SourceRevision; supersedesEvidenceDigest: string; reason: string } | null;
  freshness: 'fresh' | 'stale' | 'disconnected' | 'unsupported' | 'unverified';
  /** Display projection only; retained factual availability remains in resolution. */
  currentAvailability: Resolution['availability'] | null;
}
export interface ReadPageOptions { limit?: number; after?: { seq: number; key: string }; now: number }
export interface ObservationPage { rows: GalleryObservation[]; next: { seq: number; key: string } | null }
export interface PendingResolveInput {
  threadId: string; owner: string; turnId: string; fromSeq: number; throughSeq: number;
  after: { seq: number; key: string } | null; limit: number;
}
export interface PendingResolvePage { rows: ResultIdentity[]; next: { seq: number; key: string } | null }
export interface GalleryIndex {
  readPending(input: PendingResolveInput): PendingResolvePage;
  knownIdentities(threadId: string, owner: string, refs: ClaimRef[]): ResultIdentity[];
  applyPage(page: GalleryPage): IndexCommit;
  readTurn(threadId: string, turnId: string, options: ReadPageOptions): ObservationPage;
  readThread(threadId: string, options: ReadPageOptions): ObservationPage;
  readStage(threadId: string, owner: string, id: string): StageRecord | null;
  listStages(threadId: string, options?: { owner?: string; after?: string; limit?: number }): { rows: { key: string; owner: string; id: string; record: StageRecord }[]; next: string | null };
  coverage(threadId: string): { state: 'unindexed' | 'partial' | 'deleted'; intervals: CoverageInterval[] };
  evict(options?: { threadId?: string; limit?: number }): IndexCommit;
  /** Explicit metadata reclamation. Only completed CAS-matched work retires. */
  retireStage(threadId: string, owner: string, id: string, expectedVersion: number): IndexCommit;
  /** Bounded whole-thread index retirement; remaining rows are hidden until
   * completion. Absence then means unindexed; never a native deletion claim. */
  evictThread(threadId: string, limit?: number): IndexCommit;
  deleteThread(threadId: string, limit?: number): IndexCommit;
  stats(): { observations: number; threads: number; stages: number; suppliers: number; logicalBytes: number; metadataBytes: number; physicalBytes: number; maxPhysicalBytes: number; journalReserveBytes: number; evicted: number };
}
export class GalleryIndexError extends Error {
  readonly code: 'schema' | 'corrupt' | 'database' | 'physical-capacity';
  constructor(code: GalleryIndexError['code'], message: string) { super(message); this.name = 'GalleryIndexError'; this.code = code; }
}
class Refusal extends Error {
  readonly state: 'capacity' | 'conflict' | 'revalidate';
  constructor(state: Refusal['state'], reason: string) { super(reason); this.state = state; }
}
type Kind = 'claim' | 'thread' | 'stage' | 'supplier';
interface Row { kind: Kind; record_key: string; thread_id: string; owner: string; turn_id: string; seq: number; first_order: number; payload_json: string; charge: number }
interface Meta { schema_version: number; observations: number; threads: number; stages: number; suppliers: number; logical_bytes: number; metadata_bytes: number; order_head: number; evicted: number }
interface ThreadRecord { deleted: boolean; retiring: boolean; intervals: CoverageInterval[] }
type CompactResolution = Omit<Resolution, 'identity' | 'proof'> & { proof: Omit<Resolution['proof'], 'source'> };
interface ClaimRecord {
  schema: 1; identity: ResultIdentity; resolution: CompactResolution | null;
  unresolved: boolean; corrections: OutcomeEvidence[]; sourceExpired: SourceRevision | null;
  retracted: GalleryObservation['retracted']; revision: SourceRevision | null;
  supplierRevision: string | null;
}
interface Mutation { before: Row | undefined; after: Row | undefined }
const MAX_ROW = 8192, MAX_STAGE = 49152, MAX_THREAD = 32768, MAX_SUPPLIER = 1024;
const MAX_INTERVALS = 128, MAX_CORRECTIONS = 32, META_CHARGE = 1024;
const integer = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
function ensure(v: unknown, message: string): asserts v { if (!v) throw new Refusal('conflict', message); }
function text(value: unknown, bytes: number): asserts value is string {
  ensure(typeof value === 'string' && value.length <= bytes && utf8Bytes(value) <= bytes, 'invalid-text');
}
function id(value: string) { return IdentifierSchema.parse(value); }
function key(thread: string, owner: string, stage?: string) { return canonicalJson(stage === undefined ? [thread, owner] : [thread, owner, stage], 2048); }
function sparse(value: unknown): void {
  if (typeof value === 'string') { ensure(!/^data:/iu.test(value), 'media-data-is-not-durable'); return; }
  if (!value || typeof value !== 'object') return;
  for (const [name, child] of Object.entries(value)) {
    ensure(!['base64', 'prompt', 'revisedprompt', 'revised_prompt', 'transcript', 'providerresult', 'provider_result', 'normalizedevents'].includes(name.toLowerCase()), 'non-sparse-payload');
    sparse(child);
  }
}
function clone<T>(value: T, cap: number): T { const result = JSON.parse(canonicalJson(value, cap)) as T; sparse(result); return result; }
function compact(value: Resolution): CompactResolution {
  const { identity: _identity, proof, ...rest } = value;
  const { source: _source, ...binding } = proof;
  return { ...rest, proof: binding };
}
function expand(record: ClaimRecord): Resolution | null {
  if (!record.resolution) return null;
  return InputSchemas.resolution.parse({ ...record.resolution, identity: record.identity, proof: { ...record.resolution.proof, source: record.identity.ref.source } });
}
function resolution(raw: Resolution): Resolution {
  // Charge/admit the full public input before discarding ephemeral media leases.
  const copy = clone(raw, 65536);
  if ('media' in copy.fallback) delete copy.fallback.media;
  return InputSchemas.resolution.parse(copy);
}
function intervals(previous: CoverageInterval[], additions: CoverageInterval[]): CoverageInterval[] {
  let result = previous;
  for (const next of additions) {
    ensure(integer(next.fromSeq) && integer(next.throughSeq) && next.fromSeq <= next.throughSeq, 'invalid-coverage-range');
    ensure(['indexed', 'unindexed', 'evicted', 'unsupported', 'oversized', 'unplaced'].includes(next.state), 'invalid-coverage-state');
    if (next.owner !== undefined) PluginIdSchema.parse(next.owner);
    if (next.reason !== undefined) text(next.reason, 256);
    const retained: CoverageInterval[] = [];
    for (const old of result) {
      if (old.owner !== next.owner || old.throughSeq < next.fromSeq || old.fromSeq > next.throughSeq) retained.push(old);
      else {
        if (old.fromSeq < next.fromSeq) retained.push({ ...old, throughSeq: next.fromSeq - 1 });
        if (old.throughSeq > next.throughSeq) retained.push({ ...old, fromSeq: next.throughSeq + 1 });
      }
    }
    result = [...retained, next].sort((a, b) => (a.owner ?? '').localeCompare(b.owner ?? '') || a.fromSeq - b.fromSeq);
    const coalesced: CoverageInterval[] = [];
    for (const item of result) {
      const last = coalesced[coalesced.length - 1];
      if (last && last.owner === item.owner && last.state === item.state && last.reason === item.reason && item.fromSeq - last.throughSeq <= 1) last.throughSeq = Math.max(last.throughSeq, item.throughSeq);
      else coalesced.push({ ...item });
    }
    result = coalesced;
    // Pressure loses precision conservatively; it never fills a gap as indexed.
    if (result.length > MAX_INTERVALS) result = [{ fromSeq: Math.min(...result.map(v => v.fromSeq)), throughSeq: Math.max(...result.map(v => v.throughSeq)), state: 'unindexed', reason: 'coverage-capacity' }];
  }
  return result;
}

export function createGalleryIndex(db: Database.Database, options: GalleryIndexOptions = {}): GalleryIndex {
  const limits: { -readonly [K in keyof typeof GALLERY_INDEX_LIMITS]: number } = { ...GALLERY_INDEX_LIMITS };
  for (const name of Object.keys(options) as (keyof typeof limits)[]) {
    const value = options[name];
    if (!(name in limits) || !integer(value) || value < 1 || value > GALLERY_INDEX_LIMITS[name]) throw new RangeError(`Invalid lower-only ${name}.`);
    limits[name] = value;
  }
  if (db.inTransaction) throw new GalleryIndexError('database', 'Index requires its own dedicated transactions.');
  if (limits.maxLogicalBytes < META_CHARGE || limits.maxMetadataBytes < META_CHARGE) throw new RangeError('Limits must include the 1024-byte global metadata charge.');
  const pragma = (name: string): number => {
    const v: unknown = db.pragma(name, { simple: true });
    if (!integer(v)) throw new GalleryIndexError('database', 'Invalid SQLite numeric pragma.');
    return v;
  };
  // Reject future/partial schemas before any schema or persistent pragma change.
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('gallery_meta','gallery_records')").all();
  if (names.length === 1) throw new GalleryIndexError('corrupt', 'Incomplete gallery schema.');
  if (names.length === 2) {
    const m = db.prepare('SELECT schema_version FROM gallery_meta WHERE singleton=1').get() as { schema_version: number } | undefined;
    if (!m) throw new GalleryIndexError('corrupt', 'Missing gallery metadata.');
    if (m.schema_version !== 1) throw new GalleryIndexError('schema', 'Unsupported gallery schema; no migration or reset performed.');
  }
  db.pragma(`busy_timeout = ${limits.busyTimeoutMs}`);
  if (db.pragma('journal_mode = DELETE', { simple: true }) !== 'delete') throw new GalleryIndexError('database', 'A dedicated file database with DELETE journal is required.');
  if (names.length === 0) db.pragma('page_size = 4096');
  const pageSize = pragma('page_size');
  if (pageSize !== 4096) throw new GalleryIndexError('database', 'Gallery requires 4096-byte pages.');
  const maxPages = Math.floor(limits.maxPhysicalBytes / pageSize);
  if (maxPages < 1 || pragma('page_count') > maxPages || pragma(`max_page_count = ${maxPages}`) > maxPages) throw new GalleryIndexError('physical-capacity', 'Gallery main database exceeds its physical page cap.');
  db.pragma('temp_store = MEMORY');
  if (names.length === 0) try { db.transaction(() => {
    db.exec(`CREATE TABLE gallery_meta (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1), schema_version INTEGER NOT NULL,
      observations INTEGER NOT NULL, threads INTEGER NOT NULL, stages INTEGER NOT NULL, suppliers INTEGER NOT NULL,
      logical_bytes INTEGER NOT NULL, metadata_bytes INTEGER NOT NULL, order_head INTEGER NOT NULL, evicted INTEGER NOT NULL);
      CREATE TABLE gallery_records (
      kind TEXT NOT NULL, record_key TEXT NOT NULL, thread_id TEXT NOT NULL, owner TEXT NOT NULL,
      turn_id TEXT NOT NULL, seq INTEGER NOT NULL, first_order INTEGER NOT NULL, payload_json TEXT NOT NULL,
      charge INTEGER NOT NULL, PRIMARY KEY(kind,record_key));
      CREATE INDEX gallery_thread_read ON gallery_records(kind,thread_id,seq,record_key);
      CREATE INDEX gallery_turn_read ON gallery_records(kind,thread_id,turn_id,seq,record_key);
      CREATE INDEX gallery_stage_read ON gallery_records(kind,thread_id,owner,record_key);
      CREATE INDEX gallery_work_read ON gallery_records(thread_id,kind,record_key);
      CREATE INDEX gallery_oldest ON gallery_records(kind,first_order,record_key);
      CREATE INDEX gallery_thread_oldest ON gallery_records(kind,thread_id,first_order,record_key);`);
    db.prepare('INSERT INTO gallery_meta VALUES(1,1,0,0,0,0,?,?,0,0)').run(META_CHARGE, META_CHARGE);
  }).immediate(); } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'SQLITE_FULL') throw new GalleryIndexError('physical-capacity', 'Gallery schema does not fit the configured physical cap; initialization rolled back.');
    throw error;
  }
  const get = db.prepare('SELECT * FROM gallery_records WHERE kind=? AND record_key=?');
  const count = db.prepare('SELECT count(*) AS n FROM gallery_records WHERE kind=? AND thread_id=?');
  const put = db.prepare(`INSERT INTO gallery_records VALUES(@kind,@record_key,@thread_id,@owner,@turn_id,@seq,@first_order,@payload_json,@charge)
    ON CONFLICT(kind,record_key) DO UPDATE SET payload_json=excluded.payload_json,charge=excluded.charge`);
  const remove = db.prepare('DELETE FROM gallery_records WHERE kind=? AND record_key=?');
  function meta(): Meta {
    const m = db.prepare('SELECT * FROM gallery_meta WHERE singleton=1').get() as Meta | undefined;
    if (!m || m.schema_version !== 1 || Object.values(m).some(v => !integer(v)) || m.metadata_bytes < META_CHARGE || m.logical_bytes < m.metadata_bytes) throw new GalleryIndexError('corrupt', 'Invalid gallery counters.');
    return m;
  }
  meta();
  // Existing schema and physical limits are validated before adding this
  // derived index. A failed transaction leaves retained rows and stages intact.
  try { db.transaction(() => db.exec(`CREATE INDEX IF NOT EXISTS gallery_pending_read
    ON gallery_records(thread_id,owner,turn_id,seq,record_key)
    WHERE kind='claim' AND json_extract(payload_json,'$.unresolved')=1
      AND json_type(payload_json,'$.retracted')='null'`)).immediate(); }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'SQLITE_FULL')
      throw new GalleryIndexError('physical-capacity', 'Pending index initialization rolled back.');
    throw error;
  }
  const find = (kind: Kind, k: string) => get.get(kind, k) as Row | undefined;
  const cap = (kind: Kind) => kind === 'claim' ? MAX_ROW : kind === 'stage' ? MAX_STAGE : kind === 'thread' ? MAX_THREAD : MAX_SUPPLIER;
  function charged(row: Omit<Row, 'charge'>) { return canonicalByteLength(row, cap(row.kind) + 8192) + 256; }
  function make(kind: Kind, k: string, thread: string, owner: string, payload: unknown, m: Meta, old?: Row, turn = '', seq = 0): Row {
    const row = { kind, record_key: k, thread_id: thread, owner, turn_id: turn, seq, first_order: old?.first_order ?? m.order_head + 1, payload_json: canonicalJson(payload, cap(kind)) };
    return { ...row, charge: charged(row) };
  }
  function decode<T>(row: Row): T {
    try {
      ensure(integer(row.seq) && integer(row.first_order) && row.first_order > 0 && integer(row.charge), 'invalid-row-columns');
      ensure(typeof row.payload_json === 'string' && row.payload_json.length <= cap(row.kind), 'oversized-stored-row');
      const value = clone(JSON.parse(row.payload_json), cap(row.kind));
      const { charge, ...rest } = row;
      ensure(canonicalJson(value, cap(row.kind)) === row.payload_json && charged(rest) === charge, 'stored-charge-mismatch');
      if (row.kind === 'claim') {
        const c = value as ClaimRecord;
        ensure(c.schema === 1 && typeof c.unresolved === 'boolean' && Array.isArray(c.corrections) && c.corrections.length <= MAX_CORRECTIONS, 'invalid-claim');
        const identity = InputSchemas.identity.parse(c.identity), s = identity.ref.source;
        ensure(s.threadId === row.thread_id && s.turnId === row.turn_id && s.seq === row.seq && claimKey(row.owner, identity.ref) === row.record_key, 'stored-identity-mismatch');
        expand(c);
        ensure(c.revision === null || same(InputSchemas.revision.parse(c.revision), c.revision), 'invalid-retained-revision');
        ensure(c.sourceExpired === null || same(InputSchemas.revision.parse(c.sourceExpired), c.sourceExpired), 'invalid-retained-expiry');
        ensure(c.supplierRevision === null || typeof c.supplierRevision === 'string', 'invalid-supplier-revision');
      } else if (row.kind === 'stage') {
        const stage = value as StageRecord;
        ensure(integer(stage.version) && stage.version > 0, 'invalid-stage-generation');
        validateStage(stage.value);
        const parts = JSON.parse(row.record_key) as string[];
        ensure(parts.length === 3 && parts[0] === row.thread_id && parts[1] === row.owner, 'invalid-stage-key'); id(parts[2]!);
      } else if (row.kind === 'thread') {
        const t = value as ThreadRecord;
        ensure(typeof t.deleted === 'boolean' && typeof t.retiring === 'boolean' && Array.isArray(t.intervals) && t.intervals.length <= MAX_INTERVALS && row.record_key === row.thread_id, 'invalid-thread-record');
        intervals([], t.intervals);
      } else if (row.kind === 'supplier') {
        const s = value as SupplierRecord;
        id(s.revision); ensure(s.previousRevision === null || typeof s.previousRevision === 'string', 'invalid-previous-supplier');
        ensure(['connected', 'disconnected', 'unsupported'].includes(s.connection) && (s.freshUntil === null || integer(s.freshUntil)) && row.record_key === key(row.thread_id, row.owner), 'invalid-supplier-record');
        for (const epoch of [s.epoch, s.previousEpoch]) if (epoch !== null) InputSchemas.revision.parse({ epoch, sequence: 0 });
      }
      return value as T;
    } catch { throw new GalleryIndexError('corrupt', 'Corrupt gallery row; retained data was not reset.'); }
  }
  function validateStage(value: StageValue): void {
    ensure(!!value && typeof value === 'object' && Object.keys(value).every(k => ['stage', 'cursor', 'status', 'debt'].includes(k)), 'invalid-stage-fields');
    ensure(['discover', 'native', 'recognize', 'resolve', 'feed', 'maintenance'].includes(value.stage) && ['ready', 'parked', 'complete'].includes(value.status), 'invalid-stage');
    if (value.cursor !== null) text(value.cursor, 512);
    canonicalByteLength(value.debt, MAX_STAGE);
  }
  function thread(threadId: string): { row: Row | undefined; value: ThreadRecord } {
    const row = find('thread', threadId);
    return { row, value: row ? decode<ThreadRecord>(row) : { deleted: false, retiring: false, intervals: [] } };
  }
  function flush(mutations: Mutation[], m: Meta, evicted = 0, stageVersion: number | null = null): IndexCommit {
    const changed = mutations.filter(v => v.before?.payload_json !== v.after?.payload_json || !!v.before !== !!v.after);
    if (!changed.length) return { state: 'unchanged', mutations: 0, changedBytes: 0, stageVersion };
    const changedBytes = changed.reduce((sum, v) => sum + (v.after?.charge ?? v.before?.charge ?? 0), META_CHARGE);
    if (changed.length + 1 > 40 || changedBytes > 1048576) throw new Refusal('capacity', 'transaction-budget');
    const next = { ...m, order_head: m.order_head + 1, evicted: m.evicted + evicted };
    const counter = { claim: 'observations', thread: 'threads', stage: 'stages', supplier: 'suppliers' } as const;
    for (const change of changed) {
      const row = change.after ?? change.before!;
      const delta = (change.after?.charge ?? 0) - (change.before?.charge ?? 0);
      next.logical_bytes += delta;
      if (row.kind !== 'claim') next.metadata_bytes += delta;
      next[counter[row.kind]] += Number(!!change.after) - Number(!!change.before);
    }
    if (Object.values(next).some(v => !integer(v))) throw new Refusal('capacity', 'counter-exhausted');
    if (next.observations > limits.maxObservations || next.threads > limits.maxThreads || next.stages > limits.maxStages || next.suppliers > limits.maxSuppliers || next.logical_bytes > limits.maxLogicalBytes || next.metadata_bytes > limits.maxMetadataBytes) throw new Refusal('capacity', 'index-capacity');
    // Indexed counts are bounded by the configured per-thread caps. No table scan.
    const checked = new Set<string>();
    for (const change of changed) {
      const row = change.after;
      if (!row || row.kind === 'thread') continue;
      const scope = key(row.thread_id, row.kind);
      if (checked.has(scope)) continue;
      checked.add(scope);
      const n = (count.get(row.kind, row.thread_id) as { n: number }).n + changed.filter(v => (v.after ?? v.before)!.kind === row.kind && (v.after ?? v.before)!.thread_id === row.thread_id).reduce((sum, v) => sum + Number(!!v.after) - Number(!!v.before), 0);
      const max = row.kind === 'claim' ? limits.maxObservationsPerThread : row.kind === 'stage' ? limits.maxStagesPerThread : limits.maxSuppliersPerThread;
      if (n > max) throw new Refusal('capacity', 'thread-capacity');
    }
    // All planning/validation/charging precedes the first mutation. No eviction
    // is hidden inside an application transaction. SQLite errors roll all back.
    for (const v of changed) { if (v.after) put.run(v.after); else remove.run(v.before!.kind, v.before!.record_key); }
    db.prepare(`UPDATE gallery_meta SET observations=@observations,threads=@threads,stages=@stages,suppliers=@suppliers,
      logical_bytes=@logical_bytes,metadata_bytes=@metadata_bytes,order_head=@order_head,evicted=@evicted WHERE singleton=1`).run(next);
    return { state: 'committed', mutations: changed.length + 1, changedBytes, stageVersion };
  }
  function commit(work: () => IndexCommit): IndexCommit {
    if (db.inTransaction) return { state: 'conflict', reason: 'caller-transaction-not-supported' };
    try { return db.transaction(work).immediate(); }
    catch (error) {
      if (error instanceof Refusal) return { state: error.state, reason: error.message };
      if (error instanceof JsonAdmissionError && error.code === 'over-budget') return { state: 'capacity', reason: 'encoded-byte-cap' };
      if (error instanceof GalleryIndexError) throw error;
      if (error instanceof ResultsContractError) return { state: 'conflict', reason: error.kind };
      if (error instanceof JsonAdmissionError || error && typeof error === 'object' && 'name' in error && error.name === 'ZodError') return { state: 'conflict', reason: 'invalid-page' };
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
      if (/^SQLITE_(FULL|BUSY|LOCKED|IOERR|CANTOPEN)/u.test(code)) return { state: 'capacity', reason: code };
      throw error;
    }
  }
  function apply(page: GalleryPage): IndexCommit {
    const p = clone(page, 262144);
    PluginIdSchema.parse(p.owner); id(p.threadId);
    ensure(Array.isArray(p.changes) && p.changes.length <= 8, 'page-count-over-limit');
    ensure(p.coverage === undefined || p.coverage.length <= 8, 'coverage-page-over-limit');
    const m = meta(), t = thread(p.threadId);
    ensure(!t.value.deleted && !t.value.retiring, 'thread-deleted-or-retiring');
    const mutations: Mutation[] = [], seen = new Set<string>();
    const supplier = find('supplier', key(p.threadId, p.owner));
    const previousSupplier = supplier ? decode<SupplierRecord>(supplier) : null;
    const supplierRevision = p.supplier?.revision ?? previousSupplier?.revision ?? null;
    const epochs = new Set(p.changes.flatMap(v => v.kind === 'candidate' ? [] : [v.kind === 'upsert' ? v.value.revision.epoch : v.revision.epoch]));
    ensure(epochs.size <= 1, 'mixed-page-epochs');
    const pageEpoch = [...epochs][0];
    if (p.supplier?.epoch !== undefined && p.supplier.epoch !== null) InputSchemas.revision.parse({ epoch: p.supplier.epoch, sequence: 0 });
    ensure(p.supplier?.epoch == null || pageEpoch === undefined || pageEpoch === p.supplier.epoch, 'supplier-page-epoch-conflict');
    if (p.supplier || pageEpoch !== undefined && pageEpoch !== previousSupplier?.epoch) {
      const state = p.supplier ?? previousSupplier ?? { revision: 'unverified', connection: 'connected', freshUntil: null };
      id(state.revision);
      ensure(['connected', 'disconnected', 'unsupported'].includes(state.connection) && (state.freshUntil === null || integer(state.freshUntil)), 'invalid-supplier-state');
      const epoch = p.supplier?.epoch === null ? null : p.supplier?.epoch ?? pageEpoch ?? previousSupplier?.epoch ?? null;
      if (epoch !== null && epoch !== previousSupplier?.epoch && epoch === previousSupplier?.previousEpoch) throw new Refusal('revalidate', 'retired-source-epoch');
      const value: SupplierRecord = { ...state, epoch, previousEpoch: epoch === previousSupplier?.epoch ? previousSupplier.previousEpoch : previousSupplier?.epoch ?? null,
        previousRevision: previousSupplier?.revision === state.revision ? previousSupplier.previousRevision : previousSupplier?.revision ?? null };
      mutations.push({ before: supplier, after: make('supplier', key(p.threadId, p.owner), p.threadId, p.owner, value, m, supplier) });
    }
    let stageVersion: number | null = null;
    if (p.stage) {
      id(p.stage.id);
      const k = key(p.threadId, p.owner, p.stage.id), before = find('stage', k);
      const old = before ? decode<StageRecord>(before) : null;
      ensure((old?.version ?? null) === p.stage.expectedVersion, 'stage-version-conflict');
      const v = p.stage.value;
      validateStage(v);
      // Global durable generation prevents ABA after completed-stage retirement
      // and recreation of the same caller-owned unit id.
      stageVersion = m.order_head + 1;
      ensure(integer(stageVersion), 'stage-version-exhausted');
      mutations.push({ before, after: make('stage', k, p.threadId, p.owner, { version: stageVersion, value: v }, m, before) });
    }
    const gaps = [...(p.coverage ?? [])];
    for (const raw of p.changes) {
      ensure(['candidate', 'upsert', 'source-expired', 'retract'].includes(raw.kind), 'invalid-change-kind');
      const value = raw.kind === 'upsert' ? resolution(raw.value) : null;
      const identity = raw.kind === 'candidate' ? InputSchemas.identity.parse(raw.identity) : value?.identity;
      const ref = identity?.ref ?? ('ref' in raw ? InputSchemas.ref.parse(raw.ref) : null);
      ensure(ref && ref.source.threadId === p.threadId, 'foreign-thread');
      const k = claimKey(p.owner, ref);
      ensure(!seen.has(k), 'duplicate-page-claim'); seen.add(k);
      const before = find('claim', k), old = before ? decode<ClaimRecord>(before) : null;
      if (!old && !identity) {
        gaps.push({ fromSeq: ref.source.seq, throughSeq: ref.source.seq, owner: p.owner, state: 'unplaced', reason: 'unknown-claim-change' });
        continue; // An expiry/retraction cannot invent an observation.
      }
      if (!old && !p.allowReindex && t.value.intervals.some(v => v.state === 'evicted' && (v.owner === undefined || v.owner === p.owner) && v.fromSeq <= ref.source.seq && v.throughSeq >= ref.source.seq)) throw new Refusal('capacity', 'explicit-reindex-required');
      const c: ClaimRecord = old ?? { schema: 1, identity: identity!, resolution: null, unresolved: true, corrections: [], sourceExpired: null, retracted: null, revision: null, supplierRevision };
      if (identity) ensure(same(c.identity, identity), 'immutable-identity-conflict');
      const previous = expand(c);
      if (value) {
        if (c.revision?.epoch === value.revision.epoch && value.revision.sequence < c.revision.sequence) continue;
        if (previous) {
          const decision = checkResolutionTransition(previous, value);
          if (decision === 'stale') continue;
          if (decision === 'revalidate') throw new Refusal('revalidate', 'source-epoch-revalidation');
          if (decision === 'unchanged' && (c.sourceExpired || c.retracted)) continue;
        }
        if (c.revision && same(c.revision, value.revision) && (c.sourceExpired || c.retracted)) throw new Refusal('conflict', 'same-revision-different-change');
        if (previous?.outcomeEvidence && value.correction && (!same(previous.outcomeEvidence, value.outcomeEvidence) || previous.knowledge !== value.knowledge)) {
          if (c.corrections.length === MAX_CORRECTIONS) throw new Refusal('capacity', 'correction-history-cap');
          c.corrections.push(previous.outcomeEvidence);
        }
        // Retraction remains visible until an explicit evidence correction.
        if (c.retracted && value.correction?.supersedesEvidenceDigest !== c.retracted.supersedesEvidenceDigest) throw new Refusal('conflict', 'retraction-requires-correction');
        c.resolution = compact(value); c.unresolved = false; c.sourceExpired = null; c.retracted = null;
        c.revision = value.revision; c.supplierRevision = supplierRevision;
      } else if (raw.kind === 'source-expired' || raw.kind === 'retract') {
        const revision = InputSchemas.revision.parse(raw.revision);
        if (c.revision && c.revision.epoch !== revision.epoch) throw new Refusal('revalidate', 'source-epoch-revalidation');
        if (c.revision && revision.sequence < c.revision.sequence) continue;
        if (c.revision && revision.sequence === c.revision.sequence) {
          if (raw.kind === 'source-expired' && same(c.sourceExpired, revision) || raw.kind === 'retract' && c.retracted && same(c.retracted, { revision, supersedesEvidenceDigest: raw.supersedesEvidenceDigest, reason: raw.reason })) continue;
          throw new Refusal('conflict', 'same-revision-different-change');
        }
        if (raw.kind === 'retract') {
          text(raw.reason, 256);
          ensure(!!previous?.outcomeEvidence && previous.outcomeEvidence.digest === raw.supersedesEvidenceDigest, 'invalid-retraction-evidence');
          c.retracted = { revision, supersedesEvidenceDigest: raw.supersedesEvidenceDigest, reason: raw.reason };
        } else c.sourceExpired = revision;
        c.revision = revision;
      }
      const s = c.identity.ref.source;
      mutations.push({ before, after: make('claim', k, p.threadId, p.owner, c, m, before, s.turnId, s.seq) });
    }
    t.value.intervals = intervals(t.value.intervals, gaps);
    mutations.push({ before: t.row, after: make('thread', p.threadId, p.threadId, '', t.value, m, t.row) });
    return flush(mutations, m, 0, stageVersion);
  }
  function read(threadId: string, turnId: string | null, options: ReadPageOptions): ObservationPage {
    id(threadId); if (turnId !== null) id(turnId);
    const limit = options.limit ?? 64;
    ensure(integer(limit) && limit >= 1 && limit <= 64 && integer(options.now), 'invalid-read-bound');
    if (options.after) { ensure(integer(options.after.seq), 'invalid-read-cursor'); text(options.after.key, 1024); }
    const t = thread(threadId);
    if (t.value.deleted || t.value.retiring) return { rows: [], next: null };
    const after = options.after;
    const clauses = ["kind='claim'", 'thread_id=?', ...(turnId === null ? [] : ['turn_id=?']), ...(after ? ['(seq,record_key) > (?,?)'] : [])];
    const args = [threadId, ...(turnId === null ? [] : [turnId]), ...(after ? [after.seq, after.key] : []), limit + 1];
    const found = db.prepare(`SELECT * FROM gallery_records WHERE ${clauses.join(' AND ')} ORDER BY seq,record_key LIMIT ?`).all(...args) as Row[];
    const rows = found.slice(0, limit).map(row => {
      const c = decode<ClaimRecord>(row), r = expand(c), sr = find('supplier', key(threadId, row.owner)), s = sr ? decode<SupplierRecord>(sr) : null;
      const freshness: GalleryObservation['freshness'] = s?.connection === 'disconnected' ? 'disconnected' : s?.connection === 'unsupported' ? 'unsupported' : !s || c.supplierRevision === null || !c.revision ? 'unverified' : s.revision !== c.supplierRevision || s.epoch !== c.revision.epoch || s.freshUntil === null || s.freshUntil <= options.now ? 'stale' : 'fresh';
      const expired = c.sourceExpired || c.retracted || freshness !== 'fresh' || r?.availability.expiresAt !== null && r?.availability.expiresAt !== undefined && r.availability.expiresAt <= options.now;
      return { key: row.record_key, owner: row.owner, identity: c.identity, resolution: r, unresolved: c.unresolved, firstObservedOrder: row.first_order, corrections: c.corrections, sourceExpired: c.sourceExpired, retracted: c.retracted, freshness,
        currentAvailability: r ? expired ? { ...r.availability, state: 'unknown' as const, reason: c.retracted ? 'retracted' : c.sourceExpired ? 'source-expired' : 'stale-source-or-availability' } : r.availability : null };
    });
    const last = found[limit - 1];
    return { rows, next: found.length > limit && last ? { seq: last.seq, key: last.record_key } : null };
  }
  function retireThread(threadId: string, limit: number, deleted: boolean): IndexCommit { return commit(() => {
    id(threadId); ensure(integer(limit) && limit > 0 && limit <= 32, 'invalid-delete-limit');
    const t = thread(threadId), m = meta();
    const rows = db.prepare("SELECT * FROM gallery_records WHERE thread_id=? AND kind<>'thread' ORDER BY kind,record_key LIMIT ?").all(threadId, limit + 1) as Row[];
    if (!t.row && !rows.length) return { state: 'unchanged', mutations: 0, changedBytes: 0, stageVersion: null };
    const mutations: Mutation[] = rows.slice(0, limit).map(before => ({ before, after: undefined }));
    t.value.deleted ||= deleted; t.value.retiring = true;
    if (!t.value.deleted) t.value.intervals = [];
    mutations.push({ before: t.row, after: rows.length > limit ? make('thread', threadId, threadId, '', t.value, m, t.row) : undefined });
    return flush(mutations, m);
  }); }
  return {
    readPending(input) {
      canonicalByteLength(input, 4096);
      id(input.threadId); id(input.turnId); PluginIdSchema.parse(input.owner);
      ensure(Object.keys(input).every(k => ['threadId','turnId','owner','fromSeq','throughSeq','after','limit'].includes(k)), 'invalid-pending-fields');
      ensure(integer(input.fromSeq) && integer(input.throughSeq) && input.fromSeq <= input.throughSeq
        && integer(input.limit) && input.limit >= 1 && input.limit <= 8, 'invalid-pending-range');
      const a = input.after;
      if (a !== null) {
        ensure(a && Object.keys(a).length === 2 && integer(a.seq) && a.seq >= input.fromSeq && a.seq <= input.throughSeq
          && typeof a.key === 'string' && utf8Bytes(a.key) <= 1024, 'invalid-pending-cursor');
        const key = JSON.parse(a.key);
        ensure(Array.isArray(key) && key.length === 5 && key.every(v => typeof v === 'string') && key[0] === input.owner && key[1] === input.threadId
          && canonicalJson(key, 1024) === a.key, 'foreign-pending-cursor');
      }
      return db.transaction(() => {
        const t = thread(input.threadId); if (t.value.deleted || t.value.retiring) return { rows: [], next: null };
        const found = db.prepare(`SELECT * FROM gallery_records INDEXED BY gallery_pending_read
          WHERE kind='claim' AND json_extract(payload_json,'$.unresolved')=1 AND json_type(payload_json,'$.retracted')='null'
          AND thread_id=? AND owner=? AND turn_id=?
          AND (seq,record_key)${a ? '>' : '>='}(?,?) AND seq<=? ORDER BY seq,record_key LIMIT ?`)
          .all(input.threadId, input.owner, input.turnId, a?.seq ?? input.fromSeq, a?.key ?? '', input.throughSeq, input.limit + 1) as Row[];
        const rows = found.slice(0,input.limit).map(row => decode<ClaimRecord>(row).identity);
        const last = found[Math.min(found.length,input.limit)-1];
        const page = { rows, next: found.length > input.limit && last ? { seq: last.seq, key: last.record_key } : null };
        canonicalByteLength(page, 65536); return page;
      }).deferred();
    },
    knownIdentities(threadId, owner, refs) {
      // Validate the whole bounded request before any primary-key reads. Reuse
      // the original complete identity; selected evidence is never recomputed.
      id(threadId); PluginIdSchema.parse(owner);
      ensure(Array.isArray(refs) && refs.length <= 8, 'invalid-known-refs-limit');
      const keys = refs.map(raw => {
        const ref = InputSchemas.ref.parse(raw);
        ensure(ref.source.threadId === threadId, 'foreign-thread');
        return claimKey(owner, ref);
      });
      ensure(new Set(keys).size === keys.length, 'duplicate-known-ref');
      return db.transaction(() => {
        const t = thread(threadId); if (t.value.deleted || t.value.retiring) return [];
        const identities = keys.flatMap(k => {
          const row = find('claim', k);
          if (!row) return [];
          ensure(row.thread_id === threadId && row.owner === owner, 'foreign-known-claim');
          return [decode<ClaimRecord>(row).identity];
        });
        canonicalByteLength(identities, 65536);
        return identities;
      }).deferred();
    },
    applyPage: page => commit(() => apply(page)),
    readTurn: (threadId, turnId, options) => db.transaction(() => read(threadId, turnId, options)).deferred(),
    readThread: (threadId, options) => db.transaction(() => read(threadId, null, options)).deferred(),
    readStage(threadId, owner, stageId) {
      id(threadId); PluginIdSchema.parse(owner); id(stageId);
      const t = thread(threadId); if (t.value.deleted || t.value.retiring) return null;
      const row = find('stage', key(threadId, owner, stageId)); return row ? decode<StageRecord>(row) : null;
    },
    listStages(threadId, options = {}) {
      id(threadId); if (options.owner !== undefined) PluginIdSchema.parse(options.owner);
      const limit = options.limit ?? 32; ensure(integer(limit) && limit > 0 && limit <= 32, 'invalid-stage-read-limit');
      if (options.after !== undefined) text(options.after, 2048);
      const t = thread(threadId); if (t.value.deleted || t.value.retiring) return { rows: [], next: null };
      const rows = db.prepare(`SELECT * FROM gallery_records WHERE kind='stage' AND thread_id=? ${options.owner ? 'AND owner=?' : ''} ${options.after ? 'AND record_key>?' : ''} ORDER BY record_key LIMIT ?`).all(threadId, ...(options.owner ? [options.owner] : []), ...(options.after ? [options.after] : []), limit + 1) as Row[];
      const page = rows.slice(0, limit).map(row => ({ key: row.record_key, owner: row.owner, id: (JSON.parse(row.record_key) as string[])[2]!, record: decode<StageRecord>(row) }));
      return { rows: page, next: rows.length > limit ? page[page.length - 1]!.key : null };
    },
    coverage(threadId) { id(threadId); const t = thread(threadId); return { state: t.value.deleted ? 'deleted' : t.row ? 'partial' : 'unindexed', intervals: t.value.intervals }; },
    evict(options = {}) { return commit(() => {
      const limit = options.limit ?? 16; ensure(integer(limit) && limit > 0 && limit <= 16, 'invalid-eviction-limit');
      if (options.threadId !== undefined) id(options.threadId);
      const m = meta(), victims = db.prepare(`SELECT * FROM gallery_records WHERE kind='claim' ${options.threadId === undefined ? '' : 'AND thread_id=?'} ORDER BY first_order,record_key LIMIT ?`).all(...(options.threadId === undefined ? [] : [options.threadId]), limit) as Row[];
      const mutations: Mutation[] = [], threads = new Map<string, ReturnType<typeof thread>>();
      for (const row of victims) {
        decode<ClaimRecord>(row);
        mutations.push({ before: row, after: undefined });
        let t = threads.get(row.thread_id); if (!t) { t = thread(row.thread_id); threads.set(row.thread_id, t); }
        t.value.intervals = intervals(t.value.intervals, [{ fromSeq: row.seq, throughSeq: row.seq, owner: row.owner, state: 'evicted', reason: 'index-retention' }]);
      }
      for (const [threadId, t] of threads) mutations.push({ before: t.row, after: make('thread', threadId, threadId, '', t.value, m, t.row) });
      return flush(mutations, m, victims.length);
    }); },
    retireStage(threadId, owner, stageId, expectedVersion) { return commit(() => {
      id(threadId); PluginIdSchema.parse(owner); id(stageId); ensure(integer(expectedVersion), 'invalid-stage-version');
      const before = find('stage', key(threadId, owner, stageId));
      if (!before) return { state: 'unchanged', mutations: 0, changedBytes: 0, stageVersion: null };
      const old = decode<StageRecord>(before);
      ensure(old.version === expectedVersion && old.value.status === 'complete', 'stage-not-complete-or-version-conflict');
      return flush([{ before, after: undefined }], meta());
    }); },
    evictThread: (threadId, limit = 32) => retireThread(threadId, limit, false),
    deleteThread: (threadId, limit = 32) => retireThread(threadId, limit, true),
    stats() { const m = meta(); return { observations: m.observations, threads: m.threads, stages: m.stages, suppliers: m.suppliers, logicalBytes: m.logical_bytes, metadataBytes: m.metadata_bytes, physicalBytes: pragma('page_count') * pageSize, maxPhysicalBytes: maxPages * pageSize, journalReserveBytes: maxPages * (pageSize + 8) + 65536, evicted: m.evicted }; },
  };
}
