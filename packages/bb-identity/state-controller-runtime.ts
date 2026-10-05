import type { Codec, ConflictToken, ReadOptions, RequestExpectation, Result, Scheduler, Unsubscribe } from './model.js';
import { err, newConflictToken, newOperationId, ok } from './model-runtime.js';
import type { ServerSession } from './host.js';
import type { ConflictContext, ConflictDecision, DraftCheckpoint, DraftStorage, IdentityState, PendingDraft, StateAddress, StateDefinition, StateMutation, StateOutcome, StateRead, StateTransport, SyncSnapshot } from './state.js';
import { stateAddressKey, stateCodecs } from './state-service-runtime.js';

type Readable<T> = Exclude<StateRead<T>, { status: 'migration-required' }>;
type Block<T> = { reason: Extract<SyncSnapshot<T>, { status: 'blocked' }>['reason']; message: string; conflict: ConflictContext<T> | null };
type Flight<T> = { mutation: StateMutation<T>; base: Readable<T>; generation: number };
const defaultScheduler: Scheduler = { now: Date.now, schedule(delay, callback) { const timer = setTimeout(callback, delay); return () => clearTimeout(timer); } };
function frozen<T>(value: T): T { if (value !== null && typeof value === 'object') { for (const child of Object.values(value)) frozen(child); Object.freeze(value); } return value; }
function valueClone<T>(codec: Codec<T>, value: T): T { const result = codec.decode(structuredClone(codec.encode(value))); if (!result.ok) throw new TypeError(result.error.message); return frozen(result.value); }
function version<T>(read: Readable<T>) { return read.status === 'present' ? read.envelope.version : read.version; }
function sameVersion<T>(a: Readable<T>, b: Readable<T>) { return a.status === b.status && version(a).epoch === version(b).epoch && version(a).sequence === version(b).sequence; }

export function createIdentityState<T>(options: {
  readonly address: StateAddress; readonly expected: RequestExpectation; readonly ownerSession: import('./model.js').OwnerSessionId;
  readonly definition: StateDefinition<T>; readonly transport: StateTransport<T>; readonly drafts?: DraftStorage<T>;
  readonly scheduler?: Scheduler; readonly debounceMs?: number; readonly retryLimit?: number;
  readonly onConflict: (context: ConflictContext<T>) => ConflictDecision<T>; readonly initializeEmpty: boolean;
  readonly currentSession: () => Result<ServerSession>;
}): IdentityState<T> {
  const address = frozen({ ...options.address }); const expected = frozen({ ...options.expected });
  const definition = options.definition; const codec = definition.codec; const codecs = stateCodecs(codec);
  const drafts = options.drafts;
  const initial = valueClone(codec, definition.initialValue()); const scheduler = options.scheduler ?? defaultScheduler;
  const retryLimit = options.retryLimit ?? 3; const debounce = options.debounceMs ?? 300;
  if (!Number.isSafeInteger(retryLimit) || retryLimit < 0 || !Number.isFinite(debounce) || debounce < 0) throw new TypeError('Invalid state scheduling limits');
  let lifecycle: 'new' | 'active' | 'detached' | 'disposed' = 'new'; let epoch = 0; let loadId = 0; let localGeneration = 0;
  let base: Readable<T> | null = null; let desired: { value: T } | null = null; let blocked: Block<T> | null = null;
  let pending: Flight<T> | null = null; let networkActive = false; let acknowledgedGeneration = -1;
  let activeSave: Promise<Result<void>> | null = null; let startWork: Promise<Result<void>> | null = null;
  let activeLoad: Promise<Result<void>> | null = null; let timer: Unsubscribe | null = null; let subscription: Unsubscribe | null = null;
  let remotePending = false; let remoteSerial = 0; let remoteHint: { epoch: string; sequence: number } | null = null; let closing = false;
  let checkpoint: DraftCheckpoint<T> | null = null; let recoverySource: DraftCheckpoint<T> | null = null;
  let automaticSuspensions = 0; let automaticEpoch = 0;
  let persistQueue: Promise<unknown> = Promise.resolve(); let persistSerial = 0;
  const abort = new AbortController(); const listeners = new Set<() => void>();
  let snapshot: SyncSnapshot<T> = { status: 'loading', address };
  const currentValue = (read: Readable<T>) => read.status === 'present' ? read.envelope.value : initial;
  const dirty = () => base !== null && desired !== null && !definition.equal(currentValue(base), desired.value);
  const needsSave = () => dirty() || (base?.status === 'empty' && options.initializeEmpty);
  const active = (captured = epoch) => lifecycle === 'active' && captured === epoch;
  const clearTimer = () => { timer?.(); timer = null; };
  const draft = (): PendingDraft<T> | null => base === null || desired === null ? null : frozen({ formatVersion: 1, key: { address, actor: expected.actor, ownerSession: options.ownerSession }, schemaVersion: definition.schemaVersion, acknowledged: base, desired: desired.value, localGeneration, inFlight: pending?.mutation ?? null });
  function emit() {
    if (lifecycle === 'detached' || lifecycle === 'disposed') snapshot = { status: 'detached', address, draft: draft() };
    else if (blocked) snapshot = { status: 'blocked', address, ...blocked, draft: draft() };
    else if (base && desired) snapshot = { status: 'ready', address, ownerSession: options.ownerSession, acknowledged: base, desired: desired.value, dirty: dirty(), saving: networkActive, localGeneration, remotePending };
    else snapshot = { status: 'loading', address };
    for (const listener of listeners) { try { listener(); } catch {} }
  }
  function block(reason: Block<T>['reason'], message: string, conflict: ConflictContext<T> | null = null) { clearTimer(); blocked = { reason, message, conflict }; emit(); }
  function sessionCheck(): Result<void> {
    if (!active()) return err('disposed', 'This state controller is no longer active.');
    const result = options.currentSession();
    if (!result.ok) { block('identity-unavailable', result.error.message); return result; }
    const session = result.value;
    if (session.status !== 'ready') { block('identity-unavailable', session.error.message); return { ok: false, error: session.error }; }
    if (session.instanceId !== address.instanceId || session.actor.identity.key !== expected.actor || session.stamp !== expected.session) { block('owner-changed', 'The identity session changed.'); return err('stale-context', 'The identity session changed.', 'after-refresh'); }
    return ok(undefined);
  }
  async function safe<V>(run: () => Promise<Result<V>>): Promise<Result<V>> { try { return await run(); } catch (error) { return err('unavailable', error instanceof Error ? error.message : 'State operation failed.', 'after-reconnect'); } }
  function persist(captured = draft()): Promise<Result<DraftCheckpoint<T> | null>> {
    if (!drafts) return Promise.resolve(ok(null));
    if (!captured) return Promise.resolve(ok(null));
    const capturedEpoch = epoch; const serial = ++persistSerial;
    const work = persistQueue.then(async () => {
      const result = await safe(() => drafts.write(captured, checkpoint?.revision ?? null));
      if (result.ok) checkpoint = result.value;
      else if (active(capturedEpoch) && serial === persistSerial) block('storage-error', result.error.message);
      return result;
    });
    persistQueue = work.then(() => undefined); return work;
  }
  function schedule() {
    clearTimer(); if (!active() || automaticSuspensions || closing || blocked || pending || !needsSave()) return;
    timer = scheduler.schedule(debounce, () => { timer = null; void sendNew(true); });
  }
  function readClone(read: StateRead<T>): Result<StateRead<T>> {
    const decoded = codecs.read.decode(structuredClone(codecs.read.encode(read)));
    if (!decoded.ok) return decoded;
    const value = decoded.value; const returnedAddress = value.status === 'present' ? value.envelope.address : value.address;
    if (stateAddressKey(returnedAddress) !== stateAddressKey(address) || (value.status === 'present' && value.envelope.schemaVersion !== definition.schemaVersion)) return err('incompatible', 'State response does not match this resource.');
    return ok(frozen(value));
  }
  async function applyDecision(context: ConflictContext<T>, decision: ConflictDecision<T>): Promise<Result<void>> {
    if (!active() || blocked?.conflict?.token !== context.token) return err('stale-context', 'Conflict decision was superseded.');
    if (decision.kind === 'needs-review') { block('conflict', decision.reason, context); return ok(undefined); }
    if (context.remote.status === 'migration-required') { block('migration-required', 'State migration is required.'); return err('conflict', 'State migration is required.'); }
    base = context.remote; desired = { value: valueClone(codec, decision.kind === 'rebase' ? decision.value : currentValue(base)) };
    localGeneration++; blocked = null; emit(); const capturedEpoch = epoch; const saved = await persist();
    if (!saved.ok) return saved; if (active(capturedEpoch)) schedule(); return ok(undefined);
  }
  async function conflict(cause: ConflictContext<T>['cause'], remote: Readable<T>, original: Readable<T>): Promise<Result<void>> {
    if (!desired) return err('unavailable', 'State has no local value.');
    const context: ConflictContext<T> = frozen({ cause, token: newConflictToken(), ownerSession: options.ownerSession, base: original, local: desired.value, remote });
    block('conflict', 'Remote state conflicts with local intent.', context);
    try { return await applyDecision(context, options.onConflict(context)); }
    catch (error) { if (blocked?.conflict?.token !== context.token) return err('stale-context', 'Conflict decision was superseded.'); block('conflict', error instanceof Error ? error.message : 'Conflict policy failed.', context); return err('conflict', 'Conflict policy failed.'); }
  }
  async function applyRemote(read: StateRead<T>, cause: ConflictContext<T>['cause']): Promise<Result<void>> {
    if (read.status === 'migration-required') { block('migration-required', 'State migration is required.'); return err('conflict', 'State migration is required.'); }
    if (pending) { remotePending = true; emit(); return ok(undefined); }
    if (base && version(base).epoch === version(read).epoch && version(read).sequence < version(base).sequence) return ok(undefined);
    if (base && dirty()) {
      if (sameVersion(base, read)) { if (!blocked?.conflict) blocked = null; emit(); schedule(); return ok(undefined); }
      return conflict(cause, read, base);
    }
    base = read; desired = { value: valueClone(codec, currentValue(read)) }; blocked = null; emit(); schedule(); return ok(undefined);
  }
  function queueRemote() {
    if (!active() || activeLoad || pending) return;
    void reload('reconnect');
  }
  function reload(cause: ConflictContext<T>['cause']): Promise<Result<void>> {
    const valid = sessionCheck(); if (!valid.ok) return Promise.resolve(valid);
    const capturedEpoch = epoch; const id = ++loadId; const serial = remoteSerial; remotePending = false;
    const work = (async (): Promise<Result<void>> => {
      const loaded = await safe(() => options.transport.load({ address, expected }, { signal: abort.signal }));
      if (!active(capturedEpoch) || id !== loadId || serial !== remoteSerial) return err('cancelled', 'State load was superseded.');
      const live = sessionCheck(); if (!live.ok) return live;
      if (!loaded.ok) { block('storage-error', loaded.error.message); return loaded; }
      const parsed = readClone(loaded.value); if (!parsed.ok) { block('storage-error', parsed.error.message); return parsed; }
      return applyRemote(parsed.value, cause);
    })();
    activeLoad = work;
    void work.then(() => { if (activeLoad === work) { activeLoad = null; if (active(capturedEpoch) && remoteSerial !== serial) queueRemote(); } });
    return work;
  }
  function outcomeCheck(outcome: StateOutcome<T>, operationId: StateMutation<T>['operationId']): Result<StateOutcome<T>> {
    const parsed = codecs.save.decode(structuredClone(codecs.save.encode(outcome)));
    if (!parsed.ok) return parsed;
    if (parsed.value.operationId !== operationId || parsed.value.status === 'indeterminate') return err('incompatible', 'State receipt has a different operation.');
    const read = 'envelope' in parsed.value ? { status: 'present' as const, envelope: parsed.value.envelope } : parsed.value.current;
    const checked = readClone(read); return checked.ok ? ok(frozen(parsed.value)) : checked;
  }
  async function applyOutcome(captured: Flight<T>, raw: StateOutcome<T>): Promise<Result<void>> {
    const checked = outcomeCheck(raw, captured.mutation.operationId); if (!checked.ok) { block('indeterminate', checked.error.message); return checked; }
    const outcome = checked.value; pending = null; loadId++; blocked = null;
    if (outcome.status === 'saved' || outcome.status === 'unchanged') {
      base = { status: 'present', envelope: outcome.envelope }; acknowledgedGeneration = Math.max(acknowledgedGeneration, captured.generation);
      if (localGeneration === captured.generation) desired = { value: valueClone(codec, outcome.envelope.value) };
      emit();
    } else if ('current' in outcome) {
      if (outcome.current.status === 'migration-required') { block('migration-required', 'State migration is required.'); return err('conflict', 'State migration is required.'); }
      if (outcome.status === 'already-initialized' && localGeneration === captured.generation) {
        base = outcome.current; desired = { value: valueClone(codec, currentValue(base)) }; acknowledgedGeneration = captured.generation; emit();
      } else { const result = await conflict('save-conflict', outcome.current, captured.base); if (!result.ok) return result; }
    }
    const capturedEpoch = epoch; const saved = await persist(); if (!saved.ok) return saved;
    if (active(capturedEpoch)) { if (remotePending) return reload('reconnect'); schedule(); }
    return ok(undefined);
  }
  function transmit(captured: Flight<T>, automatic = false): Promise<Result<void>> {
    const capturedEpoch = epoch;
    const dispatchEpoch = automaticEpoch; let suppressed = false;
    const work = (async (): Promise<Result<void>> => {
      networkActive = true; emit(); const persisted = await persist();
      if (!active(capturedEpoch)) return err('cancelled', 'State save was detached.');
      if (!persisted.ok) { pending = null; networkActive = false; emit(); return persisted; }
      if (automatic && (automaticSuspensions || automaticEpoch !== dispatchEpoch)) {
        suppressed = true; if (pending === captured) pending = null; networkActive = false; emit();
        const saved = await persist(); return saved.ok ? ok(undefined) : saved;
      }
      const valid = sessionCheck(); if (!valid.ok) { networkActive = false; return valid; }
      const response = await safe(() => options.transport.save(captured.mutation, { signal: abort.signal }));
      if (!active(capturedEpoch) || pending !== captured) return err('cancelled', 'State save was detached.');
      networkActive = false;
      const live = sessionCheck(); if (!live.ok) return live;
      if (!response.ok) { block('indeterminate', response.error.message); return response; }
      if (response.value.operationId !== captured.mutation.operationId) { block('indeterminate', 'State operation identity changed.'); return err('incompatible', 'State operation identity changed.'); }
      if (response.value.status === 'indeterminate') { block('indeterminate', 'State save outcome is unknown.'); return err('unavailable', 'State save outcome is unknown.', 'same-operation'); }
      return applyOutcome(captured, response.value);
    })();
    activeSave = work; void work.then(() => { if (activeSave === work) activeSave = null; if (suppressed) schedule(); }); return work;
  }
  function sendNew(automatic = false): Promise<Result<void>> {
    if (automatic && automaticSuspensions) return Promise.resolve(ok(undefined));
    const valid = sessionCheck(); if (!valid.ok) return Promise.resolve(valid);
    if (blocked) return Promise.resolve(err('conflict', blocked.message));
    if (activeSave) return activeSave;
    if (pending) return Promise.resolve(err('unavailable', 'An earlier save needs reconciliation.', 'same-operation'));
    if (!base || !desired || !needsSave()) return Promise.resolve(ok(undefined));
    const mutation: StateMutation<T> = frozen({ kind: base.status === 'empty' ? 'initialize' : 'replace', address, expectedVersion: { ...version(base) }, expected, ownerSession: options.ownerSession, localGeneration, operationId: newOperationId(), schemaVersion: definition.schemaVersion, value: valueClone(codec, desired.value) });
    pending = { mutation, base, generation: localGeneration }; return transmit(pending, automatic);
  }
  let activeReconcile: Promise<Result<void>> | null = null;
  function reconcile(allowReplay: boolean): Promise<Result<void>> {
    if (activeReconcile) return activeReconcile;
    const work = performReconcile(allowReplay); activeReconcile = work;
    const clear = () => { if (activeReconcile === work) activeReconcile = null; };
    void work.then(clear, clear);
    return work;
  }
  async function performReconcile(allowReplay: boolean): Promise<Result<void>> {
    const captured = pending; if (!captured) return ok(undefined);
    const capturedEpoch = epoch; const valid = sessionCheck(); if (!valid.ok) return valid;
    const result = await safe(() => options.transport.reconcile({ address, expected, operationId: captured.mutation.operationId }, { signal: abort.signal }));
    if (!active(capturedEpoch) || pending !== captured) return err('cancelled', 'State reconciliation was superseded.');
    const live = sessionCheck(); if (!live.ok) return live;
    if (!result.ok) { block('indeterminate', result.error.message); return result; }
    if (result.value.status === 'final') return applyOutcome(captured, result.value.outcome);
    if (result.value.status === 'absent-final' && allowReplay) {
      if (captured.mutation.expected.actor !== expected.actor || captured.mutation.expected.session !== expected.session) { block('draft-recovery', 'The original operation cannot be re-authored under a new session.'); return err('stale-context', 'The original operation requires its original session.'); }
      blocked = null; return transmit(captured);
    }
    block('indeterminate', 'The previous save remains unresolved; no replacement was sent.'); return err('unavailable', 'The previous save remains unresolved.', 'same-operation');
  }
  async function performFlush(): Promise<Result<void>> {
    clearTimer(); const valid = sessionCheck(); if (!valid.ok) return valid;
    const goal = localGeneration; let retries = 0;
    if (activeSave) { const result = await activeSave; if (!result.ok) return result; }
    while (active()) {
      if (pending) { const result = await reconcile(retries++ < retryLimit); if (!result.ok) return result; }
      if (blocked) return err('conflict', blocked.message);
      if (!needsSave() || acknowledgedGeneration >= goal) return ok(undefined);
      const result = await sendNew(); if (!result.ok) return result;
    }
    return err('disposed', 'The state controller is detached.');
  }
  async function flush(): Promise<Result<void>> {
    let cancel: Unsubscribe = () => {};
    const timeout = new Promise<Result<void>>(resolve => {
      cancel = scheduler.schedule(30_000, () => {
        if (active()) block('indeterminate', 'Flush timed out; pending intent is retained.');
        resolve(err('unavailable', 'Flush timed out; pending intent is retained.', 'same-operation'));
      });
    });
    try { return await Promise.race([performFlush(), timeout]); } finally { cancel(); }
  }
  function detach(): PendingDraft<T> | null {
    if (lifecycle === 'detached' || lifecycle === 'disposed') return draft();
    lifecycle = 'detached'; epoch++; loadId++; clearTimer(); abort.abort(); subscription?.(); subscription = null; emit(); return draft();
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) { if (lifecycle === 'disposed') return () => {}; listeners.add(listener); return () => listeners.delete(listener); },
    start() {
      if (lifecycle === 'detached' || lifecycle === 'disposed') return Promise.resolve(err('disposed', 'Create a new state controller after detach.'));
      if (startWork) return startWork;
      lifecycle = 'active';
      subscription = options.transport.subscribe(address, event => {
        if (!active() || stateAddressKey(event.address) !== stateAddressKey(address)) return;
        if (base && event.version.epoch === version(base).epoch && event.version.sequence <= version(base).sequence) return;
        if (remoteHint && event.version.epoch === remoteHint.epoch && event.version.sequence <= remoteHint.sequence) return;
        remoteHint = { ...event.version }; remotePending = true; remoteSerial++;
        if (blocked?.conflict) block('conflict', 'Refreshing the remote state before reviewing this conflict.');
        else emit();
        queueRemote();
      });
      startWork = reload('dirty-load'); return startWork;
    },
    edit(value) {
      const valid = sessionCheck(); if (!valid.ok) return valid;
      if (closing || blocked || snapshot.status !== 'ready') return err('unavailable', 'State is not editable.');
      try { desired = { value: valueClone(codec, value) }; } catch (error) { return err('invalid-input', error instanceof Error ? error.message : 'Invalid state.'); }
      localGeneration++; emit(); schedule(); return ok(undefined);
    },
    suspendAutomaticDispatch() {
      automaticSuspensions++; automaticEpoch++; clearTimer(); let released = false;
      return () => { if (released) return; released = true; automaticSuspensions--; if (!automaticSuspensions) schedule(); };
    },
    flush,
    async reconnect(input) { const valid = sessionCheck(); if (!valid.ok) return valid; const existing = activeSave ?? activeReconcile ?? activeLoad; if (input?.reuseInFlight && existing) return existing; if (activeSave) { const settled = await activeSave; if (!settled.ok && !pending) return settled; } if (pending) { const result = await reconcile(false); if (!result.ok) return result; } return reload('reconnect'); },
    async resolveConflict(token, decision) { const valid = sessionCheck(); if (!valid.ok) return valid; const context = blocked?.conflict; if (!context || context.token !== token) return err('stale-context', 'Conflict decision was superseded.'); return applyDecision(context, decision); },
    async recover(candidate) {
      if (!drafts) return err('unsupported', 'Draft recovery is disabled for this state.');
      const valid = sessionCheck(); if (!valid.ok) return valid;
      if (activeSave || pending || dirty()) return err('conflict', 'Resolve current edits before recovering another draft.');
      const source = candidate.draft;
      if (source.formatVersion !== 1 || source.key.actor !== expected.actor || source.schemaVersion !== definition.schemaVersion || stateAddressKey(source.key.address) !== stateAddressKey(address)) return err('invalid-input', 'Draft does not match this resource and actor.');
      const parsed = readClone(source.acknowledged); if (!parsed.ok || parsed.value.status === 'migration-required') return err('invalid-input', 'Draft base is invalid.');
      let mutation: StateMutation<T> | null = null;
      if (source.inFlight) { const result = codecs.mutation.decode(structuredClone(codecs.mutation.encode(source.inFlight))); if (!result.ok || stateAddressKey(result.value.address) !== stateAddressKey(address) || result.value.schemaVersion !== definition.schemaVersion || result.value.expected.actor !== expected.actor || result.value.localGeneration > source.localGeneration) return err('invalid-input', 'Draft operation does not match its owner or generation.'); mutation = frozen(result.value); }
      clearTimer(); base = parsed.value; desired = { value: valueClone(codec, source.desired) }; localGeneration = source.localGeneration;
      recoverySource = frozen(structuredClone(candidate)); checkpoint = source.key.ownerSession === options.ownerSession ? recoverySource : null;
      if (mutation) { pending = { mutation, base, generation: mutation.localGeneration }; block('draft-recovery', 'Reconciling the original operation.'); const result = await reconcile(false); if (!result.ok) return result; }
      const capturedEpoch = epoch; const loaded = await reload('draft-recovery'); if (!loaded.ok || !active(capturedEpoch)) return loaded;
      return ok(undefined);
    },
    async discardRecovery(candidate) {
      if (!drafts) return err('unsupported', 'Draft recovery is disabled for this state.');
      if (!active()) return err('disposed', 'This state controller is no longer active.');
      const source = candidate.draft;
      if (source.formatVersion !== 1 || source.key.actor !== expected.actor
        || source.schemaVersion !== definition.schemaVersion
        || stateAddressKey(source.key.address) !== stateAddressKey(address)) {
        return err('invalid-input', 'Draft does not match this resource and actor.');
      }
      const removed = await safe(() => drafts.remove(source.key, candidate.revision));
      if (!removed.ok || !active()) return removed.ok
        ? err('disposed', 'This state controller is no longer active.')
        : removed;
      const sameCheckpoint = (entry: DraftCheckpoint<T> | null) => entry !== null
        && entry.revision === candidate.revision
        && entry.draft.key.actor === source.key.actor
        && entry.draft.key.ownerSession === source.key.ownerSession
        && stateAddressKey(entry.draft.key.address) === stateAddressKey(source.key.address);
      if (sameCheckpoint(checkpoint)) checkpoint = null;
      if (sameCheckpoint(recoverySource)) recoverySource = null;
      return ok(undefined);
    },
    async recoveryCandidates(readOptions?: ReadOptions) {
      if (readOptions?.signal?.aborted) return err('cancelled', 'Recovery lookup was cancelled.');
      if (!drafts) return ok([]);
      const result = await safe(() => drafts.find(address, expected.actor, 20));
      if (readOptions?.signal?.aborted) return err('cancelled', 'Recovery lookup was cancelled.');
      return result;
    },
    checkpoint: () => persist(),
    detach,
    async close(input) {
      if (!drafts) { detach(); return ok(undefined); }
      if (input.pending === 'flush') { closing = true; const result = await flush(); const retained = detach(); if (!result.ok) { await persist(retained); return result; } return ok(undefined); }
      const retained = detach(); if (input.pending === 'preserve') { const result = await persist(retained); return result.ok ? ok(undefined) : result; }
      await persistQueue;
      const candidates = new Map<string, DraftCheckpoint<T>>(); for (const entry of [checkpoint, recoverySource]) if (entry) candidates.set(JSON.stringify(entry.draft.key), entry);
      for (const entry of candidates.values()) { const removed = await safe(() => drafts.remove(entry.draft.key, entry.revision)); if (!removed.ok) return removed; }
      return ok(undefined);
    },
    dispose() { detach(); lifecycle = 'disposed'; listeners.clear(); },
  };
}
