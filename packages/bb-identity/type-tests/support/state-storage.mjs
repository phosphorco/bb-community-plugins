/**
 * Feature-owned proof storage for identity-scoped state.
 *
 * The caller supplies `db` from `bb.storage.database()` and normally supplies
 * `migrate: bb.storage.migrate.bind(bb.storage)`. No identity credentials,
 * network access, or plugin lifecycle hooks live here.
 */
export const proofStateStorageMigrations = [
  `CREATE TABLE IF NOT EXISTS p6r_proof_state_meta (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS p6r_proof_state_records (
    address_key TEXT PRIMARY KEY NOT NULL,
    address_json TEXT NOT NULL,
    value_json TEXT NOT NULL,
    epoch TEXT NOT NULL,
    sequence INTEGER NOT NULL CHECK(sequence >= 0),
    schema_version INTEGER NOT NULL CHECK(schema_version >= 0),
    editor_json TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS p6r_proof_state_receipts (
    address_key TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    mutation_json TEXT NOT NULL,
    outcome_json TEXT,
    retained_until INTEGER NOT NULL,
    expired_at INTEGER,
    PRIMARY KEY (address_key, operation_id)
  )`,
];

function failure(code, message, retry = 'never') {
  return { ok: false, error: { code, message, retry } };
}

function success(value) {
  return { ok: true, value };
}

function json(value) {
  const visit = (current) => {
    if (current === null || typeof current === 'string' || typeof current === 'boolean') return current;
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) throw new TypeError('State storage accepts finite JSON numbers only.');
      return current;
    }
    if (Array.isArray(current)) return current.map(visit);
    if (typeof current !== 'object') throw new TypeError('State storage accepts JSON values only.');
    const prototype = Object.getPrototypeOf(current);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError('State storage accepts plain JSON objects only.');
    // An own `__proto__` key is data, not an instruction to mutate the canonicalizer's prototype.
    const next = Object.create(null);
    for (const key of Object.keys(current).sort()) {
      if (current[key] === undefined) throw new TypeError('State storage does not accept undefined values.');
      next[key] = visit(current[key]);
    }
    return next;
  };
  return JSON.stringify(visit(value));
}

function addressKey(address) {
  return json([address.instanceId, address.pluginId, address.collection, address.recordId, address.owner]);
}

function clone(value) {
  return JSON.parse(json(value));
}

function applyMigrations(db, migrate) {
  if (migrate) return migrate(db, proofStateStorageMigrations);
  return db.transaction(() => {
    for (const statement of proofStateStorageMigrations) db.exec(statement);
  })();
}

/**
 * Implements AtomicStateStorage's same-process synchronous boundary. Receipt
 * identity is `(address, operationId)`, not a process-global operation ID.
 */
export function createProofStateStorage({
  db,
  migrate,
  now = () => Date.now(),
  receiptRetentionMs = 24 * 60 * 60 * 1000,
  emptyEpoch = 'p6r-proof-empty-r1',
}) {
  if (!db || typeof db.prepare !== 'function' || typeof db.transaction !== 'function') {
    throw new TypeError('createProofStateStorage requires a better-sqlite3 compatible database handle.');
  }
  if (!Number.isSafeInteger(receiptRetentionMs) || receiptRetentionMs <= 0) {
    throw new TypeError('receiptRetentionMs must be a positive safe integer.');
  }
  applyMigrations(db, migrate);
  db.prepare('INSERT OR IGNORE INTO p6r_proof_state_meta(key, value) VALUES (?, ?)').run('empty_epoch', emptyEpoch);
  const recordedEpoch = db.prepare('SELECT value FROM p6r_proof_state_meta WHERE key = ?').get('empty_epoch')?.value;
  if (typeof recordedEpoch !== 'string' || recordedEpoch.length === 0) throw new Error('Proof state storage has no durable empty epoch.');

  const selectRecord = db.prepare('SELECT value_json, epoch, sequence, schema_version, editor_json FROM p6r_proof_state_records WHERE address_key = ?');
  const selectReceipt = db.prepare('SELECT mutation_json, outcome_json, expired_at FROM p6r_proof_state_receipts WHERE address_key = ? AND operation_id = ?');
  const insertReceipt = db.prepare('INSERT INTO p6r_proof_state_receipts(address_key, operation_id, mutation_json, outcome_json, retained_until) VALUES (?, ?, ?, ?, ?)');
  const expireReceipts = db.prepare('UPDATE p6r_proof_state_receipts SET outcome_json = NULL, expired_at = ? WHERE retained_until <= ? AND expired_at IS NULL');
  const upsertRecord = db.prepare(`INSERT INTO p6r_proof_state_records(address_key, address_json, value_json, epoch, sequence, schema_version, editor_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(address_key) DO UPDATE SET address_json = excluded.address_json, value_json = excluded.value_json,
      epoch = excluded.epoch, sequence = excluded.sequence, schema_version = excluded.schema_version, editor_json = excluded.editor_json`);

  const version = (sequence) => ({ epoch: recordedEpoch, sequence });
  const readRow = (address) => {
    const row = selectRecord.get(addressKey(address));
    return row
      ? { status: 'present', envelope: {
        address: clone(address), version: { epoch: row.epoch, sequence: row.sequence }, schemaVersion: row.schema_version,
        value: JSON.parse(row.value_json), lastEditedBy: JSON.parse(row.editor_json),
      } }
      : { status: 'empty', address: clone(address), version: version(0) };
  };
  const recordReceipt = (key, operationId, mutationJson, outcome) => {
    insertReceipt.run(key, operationId, mutationJson, json(outcome), now() + receiptRetentionMs);
  };
  const commitTransaction = db.transaction((input, mutationJson, key, at) => {
    // Expiry retains the address/op tombstone so an old operation can never become fresh work.
    expireReceipts.run(at, at);
    // Receipt identity is resolved first; a duplicate never revalidates or re-CASes.
    const duplicate = selectReceipt.get(key, input.mutation.operationId);
    if (duplicate) {
      if (duplicate.expired_at !== null) return failure('expired', 'Operation receipt expired and cannot authorize new work.');
      if (duplicate.mutation_json !== mutationJson) return failure('invalid-operation', 'Operation ID was reused with a different immutable mutation.');
      return success(JSON.parse(duplicate.outcome_json));
    }

    // This callback is deliberately inside the SQLite transaction and immediately precedes CAS/write.
    const validated = input.validateAtCommit();
    if (!validated.ok) return validated;
    const current = readRow(input.mutation.address);
    const currentPresent = current.status === 'present';
    const currentVersion = currentPresent ? current.envelope.version : current.version;
    const expected = input.mutation.expectedVersion;
    const matches = currentVersion.epoch === expected.epoch && currentVersion.sequence === expected.sequence;
    let outcome;
    if (input.mutation.kind === 'initialize' && currentPresent) {
      outcome = { status: 'already-initialized', current, operationId: input.mutation.operationId };
    } else if (!matches) {
      outcome = { status: 'conflict', current, operationId: input.mutation.operationId };
    } else if (currentPresent && json(current.envelope.value) === json(input.mutation.value)
      && current.envelope.schemaVersion === input.mutation.schemaVersion) {
      outcome = { status: 'unchanged', envelope: current.envelope, operationId: input.mutation.operationId };
    } else {
      const nextSequence = currentVersion.sequence + 1;
      const envelope = {
        address: clone(input.mutation.address), version: version(nextSequence), schemaVersion: input.mutation.schemaVersion,
        value: clone(input.mutation.value), lastEditedBy: clone(validated.value),
      };
      upsertRecord.run(key, json(envelope.address), json(envelope.value), envelope.version.epoch, envelope.version.sequence,
        envelope.schemaVersion, json(envelope.lastEditedBy));
      outcome = { status: 'saved', envelope, operationId: input.mutation.operationId };
    }
    recordReceipt(key, input.mutation.operationId, mutationJson, outcome);
    return success(outcome);
  });

  return {
    boundary: 'same-process-synchronous',
    receiptRetentionMs,
    async read(address) {
      try { return success(readRow(address)); }
      catch (error) { return failure('unavailable', error instanceof Error ? error.message : 'State read failed.', 'after-reconnect'); }
    },
    async commit(input) {
      let mutationJson;
      let key;
      try {
        mutationJson = json(input.mutation);
        key = addressKey(input.mutation.address);
      } catch (error) {
        return failure('invalid-input', error instanceof Error ? error.message : 'State mutation is not JSON.');
      }
      try {
        return commitTransaction.immediate(input, mutationJson, key, now());
      } catch (error) {
        return failure('unavailable', error instanceof Error ? error.message : 'State commit failed.', 'after-reconnect');
      }
    },
    async reconcile({ address, operationId }) {
      try {
        const at = now();
        expireReceipts.run(at, at);
        const receipt = selectReceipt.get(addressKey(address), operationId);
        return success(receipt
          ? receipt.expired_at !== null
            ? { status: 'unknown', reason: 'expired' }
            : { status: 'final', outcome: JSON.parse(receipt.outcome_json) }
          : { status: 'absent-final', retry: 'same-operation-only' });
      } catch (error) {
        return failure('unavailable', error instanceof Error ? error.message : 'State receipt lookup failed.', 'after-reconnect');
      }
    },
  };
}
