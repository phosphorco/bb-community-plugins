/**
 * Conformance suite for feature-owned AtomicStateStorage implementations.
 * A feature supplies its real storage over a fresh store; the suite checks the
 * public contract only and prescribes no schema, database or product model.
 */
import type { ActorSnapshot, OperationId, Result } from './model.js';
import { idCodec } from './model-runtime.js';
import type { AtomicStateStorage, StateMutation, StateRead, StateSave, StateVersion } from './state.js';
import type { StateStorageConformanceOptions } from './testing.js';
import { personFixture } from './testing-runtime.js';

class StorageConformanceError extends Error {
  readonly check: string;
  constructor(check: string, detail: string) { super(`[state storage ${check}] ${detail}`); this.name = 'StorageConformanceError'; this.check = check; }
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const record = value as Record<string, unknown>;
  return '{' + Object.keys(record).filter(k => record[k] !== undefined).sort().map(k => JSON.stringify(k) + ':' + canonical(record[k])).join(',') + '}';
}

function id<Kind extends string>(kind: Kind, value: string) {
  const decoded = idCodec(kind).decode(value);
  if (!decoded.ok) throw new TypeError(decoded.error.message);
  return decoded.value;
}

export function defineStateStorageConformance<T>(options: StateStorageConformanceOptions<T>): void {
  const actor: ActorSnapshot = options.actor ?? personFixture({ subject: 'storage-conformance', name: 'Storage conformance' });
  const schemaVersion = options.schemaVersion ?? 1;
  const [first, second] = options.values;
  const prefix = options.prefix ?? 'state storage conformance: ';
  const accepted = (): Result<ActorSnapshot> => ({ ok: true, value: actor });
  // Mirrors the state controller: the first write to an empty record is `initialize`; `replace` is only
  // ever sent for a present record. Storages may (and thread-progress / thread-brief do) refuse replace-on-empty.
  const mutation = (input: { readonly recordId: string; readonly operation: string; readonly value: T; readonly expectedVersion: StateVersion; readonly kind?: 'initialize' | 'replace' }): StateMutation<T> => {
    const address = options.address(input.recordId);
    return {
      kind: input.kind ?? 'replace', address, expectedVersion: input.expectedVersion,
      expected: { actor: address.owner, session: id('server-session', 'storage-conformance-session') },
      ownerSession: id('owner-session', 'storage-conformance-owner'), localGeneration: 1,
      operationId: id('operation', input.operation), schemaVersion, value: input.value,
    };
  };
  const check = (name: string, condition: unknown, detail: string): void => { if (!condition) throw new StorageConformanceError(name, detail); };
  const same = (name: string, actual: unknown, expected: unknown, detail: string) => check(name, canonical(actual) === canonical(expected), `${detail}\n  expected: ${canonical(expected)}\n  actual:   ${canonical(actual)}`);
  const value = <V>(name: string, result: Result<V>): V => { if (!result.ok) throw new StorageConformanceError(name, `unexpected error ${result.error.code}: ${result.error.message}`); return result.value; };
  const code = (name: string, result: Result<unknown>, expected: string) => check(name, !result.ok && result.error.code === expected, `expected error ${expected}, got ${canonical(result)}`);
  const versionOf = (read: StateRead<T>) => read.status === 'present' ? read.envelope.version : read.status === 'empty' ? read.version : null;
  const outcome = (name: string, save: Result<StateSave<T>>, status: string) => { const v = value(name, save); check(name, v.status === status, `expected ${status}, got ${v.status}`); return v; };
  const noValidation = (name: string) => (): Result<ActorSnapshot> => { throw new StorageConformanceError(name, 'validateAtCommit ran for a mutation that must not commit'); };
  async function withStorage(name: string, body: (storage: AtomicStateStorage<T>, clock: { advance(ms: number): void }, opened: Awaited<ReturnType<typeof options.open>>) => Promise<void>) {
    let now = 1_750_000_000_000;
    const opened = await options.open({ now: () => now });
    check(name, opened.storage.boundary === 'same-process-synchronous', 'storage must declare a same-process-synchronous commit boundary');
    try { await body(opened.storage, { advance(ms) { now += ms; } }, opened); } finally { await opened.close?.(); }
  }
  const empty = async (name: string, storage: AtomicStateStorage<T>, recordId: string): Promise<StateVersion> => {
    const read = value(name, await storage.read(options.address(recordId)));
    check(name, read.status === 'empty', `a fresh record reads as ${read.status}, not empty`);
    return versionOf(read)!;
  };

  options.test(`${prefix}empty records have a stable version`, () => withStorage('empty-version', async storage => {
    const name = 'empty-version';
    const a = await empty(name, storage, 'conformance-empty');
    same(name, await empty(name, storage, 'conformance-empty'), a, 'two reads of an empty record disagree on its version');
  }));

  options.test(`${prefix}initialize has one winner; unchanged and conflict are reported`, () => withStorage('initialize-winner', async storage => {
    const name = 'initialize-winner', version = await empty(name, storage, 'conformance-init');
    const winner = outcome(name, await storage.commit({ mutation: mutation({ recordId: 'conformance-init', operation: 'init-a', value: first, expectedVersion: version, kind: 'initialize' }), validateAtCommit: accepted }), 'saved');
    if (winner.status !== 'saved') return;
    outcome(name, await storage.commit({ mutation: mutation({ recordId: 'conformance-init', operation: 'init-b', value: second, expectedVersion: version, kind: 'initialize' }), validateAtCommit: accepted }), 'already-initialized');
    outcome(name, await storage.commit({ mutation: mutation({ recordId: 'conformance-init', operation: 'same-value', value: first, expectedVersion: winner.envelope.version }), validateAtCommit: accepted }), 'unchanged');
    outcome(name, await storage.commit({ mutation: mutation({ recordId: 'conformance-init', operation: 'stale-version', value: second, expectedVersion: version }), validateAtCommit: accepted }), 'conflict');
    same(name, value(name, await storage.read(options.address('conformance-init'))), { status: 'present', envelope: winner.envelope }, 'losing mutations changed the record');
  }));

  options.test(`${prefix}operation ids are immutable, replayed exactly and address scoped`, () => withStorage('operation-ids', async storage => {
    const name = 'operation-ids', version = await empty(name, storage, 'conformance-replay');
    const original = mutation({ recordId: 'conformance-replay', operation: 'shared-operation', value: first, expectedVersion: version, kind: 'initialize' });
    const saved = await storage.commit({ mutation: original, validateAtCommit: accepted });
    outcome(name, saved, 'saved');
    same(name, await storage.commit({ mutation: structuredClone(original), validateAtCommit: noValidation(name) }), saved, 'an exact replay did not return the original outcome');
    code(name, await storage.commit({ mutation: { ...original, value: second }, validateAtCommit: noValidation(name) }), 'invalid-operation');
    same(name, value(name, await storage.reconcile({ address: original.address, operationId: original.operationId })), { status: 'final', outcome: value(name, saved) }, 'reconcile does not report the original outcome');
    const otherVersion = await empty(name, storage, 'conformance-replay-other');
    outcome(name, await storage.commit({ mutation: mutation({ recordId: 'conformance-replay-other', operation: 'shared-operation', value: second, expectedVersion: otherVersion, kind: 'initialize' }), validateAtCommit: accepted }), 'saved');
  }));

  options.test(`${prefix}expired operation ids stay tombstoned and the record is retained`, () => withStorage('expiry', async (storage, clock) => {
    const name = 'expiry', version = await empty(name, storage, 'conformance-expiry');
    const original = mutation({ recordId: 'conformance-expiry', operation: 'expiring-operation', value: first, expectedVersion: version, kind: 'initialize' });
    const saved = outcome(name, await storage.commit({ mutation: original, validateAtCommit: accepted }), 'saved');
    clock.advance(storage.receiptRetentionMs + 1);
    same(name, value(name, await storage.reconcile({ address: original.address, operationId: original.operationId })), { status: 'unknown', reason: 'expired' }, 'an expired operation must reconcile as unknown/expired');
    code(name, await storage.commit({ mutation: structuredClone(original), validateAtCommit: noValidation(name) }), 'expired');
    code(name, await storage.commit({ mutation: { ...original, value: second }, validateAtCommit: noValidation(name) }), 'expired');
    if (saved.status === 'saved') same(name, value(name, await storage.read(original.address)), { status: 'present', envelope: saved.envelope }, 'expiry changed the record');
  }));

  options.test(`${prefix}a commit-time rejection leaves neither record nor operation outcome`, () => withStorage('commit-rejection', async (storage, _clock, opened) => {
    const name = 'commit-rejection', before = value(name, await storage.read(options.address('conformance-rejected')));
    const rejected = mutation({ recordId: 'conformance-rejected', operation: 'rejected-operation', value: first, expectedVersion: versionOf(before)!, kind: before.status === 'empty' ? 'initialize' : 'replace' });
    let inside: boolean | null = null;
    const result = await storage.commit({ mutation: rejected, validateAtCommit: () => { inside = opened.insideCommit?.() ?? null; return { ok: false, error: { code: 'expired', message: 'scope released before commit', retry: 'never' } }; } });
    code(name, result, 'expired');
    if (opened.insideCommit) check(name, inside === true, 'validateAtCommit ran outside the synchronous commit transaction');
    same(name, value(name, await storage.read(rejected.address)), before, 'a rejected commit changed the record');
    same(name, value(name, await storage.reconcile({ address: rejected.address, operationId: rejected.operationId as OperationId })), { status: 'absent-final', retry: 'same-operation-only' }, 'a rejected commit left an operation outcome');
  }));

  const restart = `${prefix}records and operation outcomes survive a restart`;
  const gap = options.skip?.restart;
  if (gap !== undefined) { const skip = options.test.skip ?? options.test; skip(`${restart} — gap: ${gap}`, async () => {}); return; }
  options.test(restart, async () => {
    const name = 'restart';
    await withStorage(name, async (storage, _clock, opened) => {
      if (!opened.reopen) throw new StorageConformanceError(name, 'open() returned no reopen(); supply reopen, or pass skip.restart with the reason restart durability is not checked.');
      const version = await empty(name, storage, 'conformance-restart');
      const original = mutation({ recordId: 'conformance-restart', operation: 'durable-operation', value: first, expectedVersion: version, kind: 'initialize' });
      const saved = outcome(name, await storage.commit({ mutation: original, validateAtCommit: accepted }), 'saved');
      const restarted = await opened.reopen();
      if (saved.status === 'saved') same(name, value(name, await restarted.read(original.address)), { status: 'present', envelope: saved.envelope }, 'the record did not survive a restart');
      same(name, value(name, await restarted.reconcile({ address: original.address, operationId: original.operationId })), { status: 'final', outcome: saved }, 'the operation outcome did not survive a restart');
    });
  });
}

