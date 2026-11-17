import type Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { InstanceId, OperationLookup, Result, IdentityKey, IdentityError } from '@phosphorco/bb-identity/model';
import { stateAddressKey, stateCodecs, type AtomicStateStorage, type StateAddress, type StateRead, type StateMutation, type StateOutcome } from '@phosphorco/bb-identity/state';
import { linksCodec, locatorKey, type LinksRecord, type FindInputV2, type FindOutputV2 } from '@phosphorco/bb-people-accounts/v2';
import { PeopleAccountsV2Error, type LinksReaderV2 } from '@phosphorco/bb-people-accounts/v2/bb';
import { LINKS_RECORD, linksResource } from './links-model';

export type LinksDatabase = Pick<Database.Database, 'prepare' | 'exec' | 'transaction'>;
const codecs = stateCodecs(linksCodec);
const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const err = (code: IdentityError['code'], message: string, retry: IdentityError['retry'] = 'never'): Result<never> => ({ ok: false, error: { code, message, retry } });
const detail = (error: unknown) => error instanceof Error ? error.message : 'Unknown storage failure';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const receiptSchema = z.object({ fingerprint: z.string(), data: z.string(), created_at: z.number() });
const recordSchema = z.object({ schema_version: z.number(), data: z.string() });
const indexSchema = z.object({ epoch: z.string(), sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) });
const cursorSchema = z.strictObject({ version: z.literal(1), locator: z.string(), revision: z.string(), after: z.string() });

/** Feature-owned atomic SQLite storage; native identity owns validation, transport and synchronization. */
export class LinksStore implements AtomicStateStorage<LinksRecord> {
  readonly boundary = 'same-process-synchronous' as const;
  readonly receiptRetentionMs = 30 * 24 * 60 * 60 * 1000;
  constructor(readonly db: LinksDatabase, readonly instanceId: InstanceId, private readonly now = Date.now) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS people_links_records(address TEXT PRIMARY KEY, schema_version INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS people_links_receipts(address TEXT NOT NULL, operation_id TEXT NOT NULL, fingerprint TEXT NOT NULL, data TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(address,operation_id));
      CREATE TABLE IF NOT EXISTS people_links_revision(instance TEXT PRIMARY KEY, epoch TEXT NOT NULL, sequence INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS people_links_index(instance TEXT NOT NULL, supplier TEXT NOT NULL, subject TEXT NOT NULL, owner TEXT NOT NULL, link_id TEXT NOT NULL, PRIMARY KEY(instance,supplier,subject,owner));
    `);
    db.prepare('INSERT OR IGNORE INTO people_links_revision(instance,epoch,sequence) VALUES(?,?,0)').run(instanceId, randomUUID());
  }
  private check(address: StateAddress) {
    if (address.instanceId !== this.instanceId || address.pluginId !== linksResource.pluginId || address.collection !== linksResource.definition.collection || address.recordId !== LINKS_RECORD) throw new Error('Unexpected links address');
  }
  private indexVersion() { return indexSchema.parse(this.db.prepare('SELECT epoch,sequence FROM people_links_revision WHERE instance=?').get(this.instanceId)); }
  private current(address: StateAddress): StateRead<LinksRecord> {
    this.check(address);
    const found = this.db.prepare('SELECT schema_version,data FROM people_links_records WHERE address=?').get(stateAddressKey(address));
    if (!found) return { status: 'empty', address, version: { epoch: this.indexVersion().epoch, sequence: 0 } };
    const row = recordSchema.parse(found);
    if (row.schema_version !== linksResource.definition.schemaVersion) return { status: 'migration-required', address, storedSchemaVersion: row.schema_version };
    const decoded = codecs.read.decode(JSON.parse(row.data));
    if (!decoded.ok || decoded.value.status !== 'present' || stateAddressKey(decoded.value.envelope.address) !== stateAddressKey(address)) throw new Error('Invalid stored links');
    return decoded.value;
  }
  private receipt(address: StateAddress, operationId: string) {
    this.check(address);
    const row = this.db.prepare('SELECT fingerprint,data,created_at FROM people_links_receipts WHERE address=? AND operation_id=?').get(stateAddressKey(address), operationId);
    return row ? receiptSchema.parse(row) : null;
  }
  async read(address: StateAddress): Promise<Result<StateRead<LinksRecord>>> {
    try { return ok(this.current(address)); } catch (error) { return err('unavailable', `Stored links could not be read: ${detail(error)}`, 'after-reconnect'); }
  }
  async commit(input: Parameters<AtomicStateStorage<LinksRecord>['commit']>[0]): Promise<Result<StateOutcome<LinksRecord>>> {
    try {
      return this.db.transaction((): Result<StateOutcome<LinksRecord>> => {
        const decoded = codecs.mutation.decode(codecs.mutation.encode(input.mutation));
        if (!decoded.ok) return decoded;
        const mutation = decoded.value;
        this.check(mutation.address);
        const fingerprint = digest(JSON.stringify(codecs.mutation.encode(mutation)));
        const prior = this.receipt(mutation.address, mutation.operationId);
        if (prior) {
          if (this.now() - prior.created_at > this.receiptRetentionMs) return err('expired', 'This operation receipt has expired; do not reuse its ID.');
          if (prior.fingerprint !== fingerprint) return err('invalid-operation', 'Operation ID was reused with a different mutation.');
          const decoded = codecs.save.decode(JSON.parse(prior.data));
          if (!decoded.ok) return decoded;
          return decoded.value.status === 'indeterminate' ? err('incompatible', 'Invalid stored links receipt.') : ok(decoded.value);
        }
        const actor = input.validateAtCommit();
        if (!actor.ok) return actor;
        const current = this.current(mutation.address);
        if (current.status === 'migration-required' || mutation.schemaVersion !== linksResource.definition.schemaVersion) return err('invalid-input', 'Stored links require an explicit schema migration.');
        let outcome: StateOutcome<LinksRecord>;
        if (mutation.kind === 'initialize' && current.status === 'present') outcome = { status: 'already-initialized', current, operationId: mutation.operationId };
        else {
          const version = current.status === 'present' ? current.envelope.version : current.version;
          if (version.epoch !== mutation.expectedVersion.epoch || version.sequence !== mutation.expectedVersion.sequence) outcome = { status: 'conflict', current, operationId: mutation.operationId };
          else if (current.status === 'present' && linksResource.definition.equal(current.envelope.value, mutation.value)) outcome = { status: 'unchanged', envelope: current.envelope, operationId: mutation.operationId };
          else {
            if (!Number.isSafeInteger(version.sequence + 1) || !Number.isSafeInteger(this.indexVersion().sequence + 1)) return err('unavailable', 'Links version capacity exceeded.');
            const envelope = { address: mutation.address, version: { epoch: version.epoch, sequence: version.sequence + 1 }, schemaVersion: mutation.schemaVersion, value: mutation.value, lastEditedBy: actor.value };
            this.db.prepare('INSERT INTO people_links_records(address,schema_version,data) VALUES(?,?,?) ON CONFLICT(address) DO UPDATE SET schema_version=excluded.schema_version,data=excluded.data').run(stateAddressKey(mutation.address), mutation.schemaVersion, JSON.stringify(codecs.read.encode({ status: 'present', envelope })));
            this.db.prepare('DELETE FROM people_links_index WHERE instance=? AND owner=?').run(this.instanceId, mutation.address.owner);
            const insert = this.db.prepare('INSERT INTO people_links_index(instance,supplier,subject,owner,link_id) VALUES(?,?,?,?,?)');
            for (const link of mutation.value.links) insert.run(this.instanceId, link.identity.pluginId, link.identity.subject, mutation.address.owner, link.id);
            this.db.prepare('UPDATE people_links_revision SET sequence=sequence+1 WHERE instance=?').run(this.instanceId);
            outcome = { status: 'saved', envelope, operationId: mutation.operationId };
          }
        }
        this.db.prepare('INSERT INTO people_links_receipts(address,operation_id,fingerprint,data,created_at) VALUES(?,?,?,?,?)').run(stateAddressKey(mutation.address), mutation.operationId, fingerprint, JSON.stringify(codecs.save.encode(outcome)), this.now());
        return ok(outcome);
      }).immediate();
    } catch (error) { return err('unavailable', `Links were not committed: ${detail(error)}. Reconcile the original operation before retrying.`, 'after-reconnect'); }
  }
  async reconcile(input: Parameters<AtomicStateStorage<LinksRecord>['reconcile']>[0]): Promise<Result<OperationLookup<StateOutcome<LinksRecord>>>> {
    try {
      const prior = this.receipt(input.address, input.operationId);
      if (!prior) return ok({ status: 'absent-final', retry: 'same-operation-only' });
      if (this.now() - prior.created_at > this.receiptRetentionMs) return ok({ status: 'unknown', reason: 'expired' });
      const decoded = codecs.save.decode(JSON.parse(prior.data));
      if (!decoded.ok) return decoded;
      if (decoded.value.status === 'indeterminate') return err('incompatible', 'Invalid stored links receipt.');
      return ok({ status: 'final', outcome: decoded.value });
    } catch (error) { return err('unavailable', `Links receipt could not be read: ${detail(error)}`, 'after-reconnect'); }
  }
  private address(owner: IdentityKey): StateAddress { return { instanceId: this.instanceId, pluginId: linksResource.pluginId, collection: linksResource.definition.collection, recordId: LINKS_RECORD, owner }; }
  private find(input: FindInputV2): FindOutputV2 {
    return this.db.transaction((): FindOutputV2 => {
      const version = this.indexVersion(); const revision = `${version.epoch}/${version.sequence}`;
      const conflict = { version: 2, status: 'conflict', identity: input.identity } as const;
      if (input.revision !== undefined && input.revision !== revision) return conflict;
      let after = '';
      if (input.cursor !== undefined) {
        let cursor;
        try { cursor = cursorSchema.parse(JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8'))); }
        catch { throw new PeopleAccountsV2Error('incompatible'); }
        if (cursor.locator !== digest(locatorKey(input.identity)) || cursor.revision !== revision) return conflict;
        after = cursor.after;
      }
      const rows = this.db.prepare('SELECT owner,link_id FROM people_links_index WHERE instance=? AND supplier=? AND subject=? AND owner>? ORDER BY owner LIMIT ?').all(this.instanceId, input.identity.pluginId, input.identity.subject, after, input.limit + 1) as { owner: IdentityKey; link_id: string }[];
      const page = rows.slice(0, input.limit);
      return { version: 2, status: 'page', identity: input.identity, revision, coverage: 'complete', links: page.map(row => ({ personKey: row.owner, id: row.link_id })), nextCursor: rows.length > input.limit ? Buffer.from(JSON.stringify({ version: 1, locator: digest(locatorKey(input.identity)), revision, after: page[page.length - 1]!.owner })).toString('base64url') : null };
    })();
  }
  readonly reader: LinksReaderV2 = {
    links: async input => ({ version: 2, results: await Promise.all(input.personKeys.map(async personKey => {
      const read = await this.read(this.address(personKey));
      if (!read.ok || read.value.status === 'migration-required') return { personKey, status: 'unavailable' as const };
      if (read.value.status === 'empty') return { personKey, status: 'missing' as const };
      return { personKey, status: 'found' as const, version: read.value.envelope.version, links: read.value.envelope.value.links };
    })) }),
    find: async input => this.find(input),
  };
}
