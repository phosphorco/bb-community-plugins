/** One owner per window generation. Aborting fences callbacks; only an exact
 * committed-cleanup acknowledgement returns the occupied resource reservation. */
export interface CanvasPriority { visible: boolean; focused: boolean; dialog: boolean; order: number; activation: number }
export interface CanvasLease { readonly id: number; readonly signal: AbortSignal; readonly dialog: boolean }
export interface CanvasSnapshot {
  state: 'queued' | 'granted' | 'retiring' | 'stalled' | 'suspended' | 'released' | 'capacity';
  signal: AbortSignal | null;
  lease: CanvasLease | null;
}
export interface CanvasRequest {
  getSnapshot(): CanvasSnapshot;
  subscribe(listener: () => void): () => void;
  update(priority: CanvasPriority): void;
  setAvailable(available: boolean): void;
  restart(): void;
  acknowledgeRetired(lease: CanvasLease): boolean;
  dispose(): void;
}
export const CANVAS_LIMITS = Object.freeze({ requests: 64, occupied: 4, dialogs: 1, retirementMs: 1500 });
interface Entry {
  key: string; priority: CanvasPriority; sequence: number; alive: boolean; available: boolean;
  controller: AbortController | null; lease: CanvasLease | null;
  phase: 'granted' | 'retiring' | 'stalled' | null;
  timer: ReturnType<typeof setTimeout> | null;
  snapshot: CanvasSnapshot; listeners: Set<() => void>;
}
function validate(priority: CanvasPriority): CanvasPriority {
  if (typeof priority.visible !== 'boolean' || typeof priority.focused !== 'boolean' || typeof priority.dialog !== 'boolean'
    || !Number.isSafeInteger(priority.order) || priority.order < 0 || !Number.isSafeInteger(priority.activation) || priority.activation < 0) throw new TypeError('Invalid gallery canvas priority.');
  return { ...priority };
}
function samePriority(a: CanvasPriority, b: CanvasPriority) {
  return a.visible === b.visible && a.focused === b.focused && a.dialog === b.dialog && a.order === b.order && a.activation === b.activation;
}
export function createWindowCanvasOwner(options: { retirementMs?: number } = {}) {
  const retirementMs = options.retirementMs ?? CANVAS_LIMITS.retirementMs;
  if (!Number.isSafeInteger(retirementMs) || retirementMs < 1 || retirementMs > CANVAS_LIMITS.retirementMs) throw new TypeError('Invalid retirement deadline.');
  const entries = new Map<string, Entry>(), records = new Set<Entry>();
  let sequence = 0, leaseId = 0, hidden = false, disposed = false, reconciling = false, dirty = false;
  let drain: Promise<void> | null = null, resolveDrain: (() => void) | null = null;
  const occupied = () => [...records].filter(entry => entry.lease !== null);
  const rank = (a: Entry, b: Entry) =>
    Number(b.priority.focused && b.phase === 'granted') - Number(a.priority.focused && a.phase === 'granted')
    || Number(b.priority.focused) - Number(a.priority.focused)
    || Number(b.priority.dialog) - Number(a.priority.dialog)
    || b.priority.activation - a.priority.activation || a.priority.order - b.priority.order || a.sequence - b.sequence;
  function publish(entry: Entry) {
    const state = entry.phase ?? (!entry.alive ? 'released' : hidden ? 'suspended' : 'queued');
    if (entry.snapshot.state === state && entry.snapshot.lease === entry.lease) return;
    entry.snapshot = { state, lease: entry.lease, signal: entry.lease?.signal ?? null };
    for (const listener of [...entry.listeners]) { try { listener(); } catch { /* isolate subscribers */ } }
    if (!entry.alive && entry.lease === null) entry.listeners.clear();
  }
  function revoke(entry: Entry) {
    if (entry.phase !== 'granted') return;
    const lease = entry.lease!;
    entry.phase = 'retiring';
    entry.timer = setTimeout(() => {
      entry.timer = null;
      if (entry.lease !== lease || entry.phase !== 'retiring') return;
      entry.phase = 'stalled'; publish(entry); // Never manufacture cleanup or retry.
    }, retirementMs);
    // Abort may reenter the allocator. Keep the reservation before notifying.
    entry.controller!.abort();
    if (entry.lease === lease) publish(entry);
  }
  function reconcile() {
    dirty = true;
    if (reconciling) return;
    reconciling = true;
    try {
      while (dirty) {
        dirty = false;
        const ordered = [...entries.values()].sort(rank), desired = new Set<Entry>();
        let dialog = false;
        if (!hidden && !disposed) for (const entry of ordered) {
          if (desired.size >= CANVAS_LIMITS.occupied) break;
          if (!entry.alive || !entry.available || !(entry.priority.visible || entry.priority.focused || entry.priority.dialog)) continue;
          if (entry.priority.dialog && dialog) continue;
          dialog ||= entry.priority.dialog; desired.add(entry);
        }
        for (const entry of [...records]) if (entry.phase === 'granted'
          && (!desired.has(entry) || entry.lease!.dialog !== entry.priority.dialog)) revoke(entry);
        for (const entry of ordered) {
          if (!entry.alive || entries.get(entry.key) !== entry) continue;
          if (desired.has(entry) && entry.lease === null) {
            const held = occupied();
            if (held.length < CANVAS_LIMITS.occupied && (!entry.priority.dialog || !held.some(other => other.lease!.dialog))) {
              entry.controller = new AbortController();
              entry.lease = Object.freeze({ id: ++leaseId, signal: entry.controller.signal, dialog: entry.priority.dialog });
              entry.phase = 'granted';
            }
          }
          publish(entry);
        }
      }
    } finally { reconciling = false; }
    if (occupied().length === 0 && resolveDrain) {
      const resolve = resolveDrain; resolveDrain = null; drain = null; resolve();
    }
  }
  function retire(entry: Entry) {
    if (!entry.alive) return;
    entry.alive = false;
    if (entries.get(entry.key) === entry) entries.delete(entry.key);
    if (entry.lease) revoke(entry); else records.delete(entry);
    publish(entry);
  }
  return {
    request(key: string, priority: CanvasPriority): CanvasRequest {
      if (!key || new TextEncoder().encode(key).length > 2048) throw new TypeError('Invalid scoped canvas key.');
      const parsed = validate(priority), previous = entries.get(key);
      const admitted = !disposed && (records.size < CANVAS_LIMITS.requests || (previous !== undefined && previous.lease === null));
      const entry: Entry = { key, priority: parsed, sequence: ++sequence, alive: admitted, available: true,
        controller: null, lease: null, phase: null, timer: null,
        snapshot: { state: disposed ? 'released' : admitted ? 'queued' : 'capacity', signal: null, lease: null }, listeners: new Set() };
      // Install ownership before aborting old callbacks. A nested replacement wins.
      if (admitted) {
        // Reserve the request slot before old subscribers can reenter. An
        // unleased predecessor can relinquish its slot synchronously.
        if (previous?.lease === null) records.delete(previous);
        records.add(entry); entries.set(key, entry);
        if (previous) retire(previous);
        if (entry.alive && entries.get(key) === entry) reconcile();
      }
      return {
        getSnapshot: () => entry.snapshot,
        subscribe(listener) { if (!entry.alive && entry.lease === null) return () => {}; entry.listeners.add(listener); return () => { entry.listeners.delete(listener); }; },
        update(next) {
          const parsed = validate(next);
          if (!entry.alive || entries.get(key) !== entry || samePriority(entry.priority, parsed)) return;
          entry.priority = parsed; reconcile();
        },
        setAvailable(value) {
          if (typeof value !== 'boolean') throw new TypeError('Invalid availability.');
          if (!entry.alive || entry.available === value) return;
          entry.available = value; reconcile();
        },
        restart() { if (!entry.alive) return; revoke(entry); reconcile(); },
        acknowledgeRetired(lease) {
          if (entry.lease !== lease || entry.phase === 'granted' || !lease.signal.aborted) return false;
          if (entry.timer !== null) clearTimeout(entry.timer);
          entry.timer = null; entry.lease = null; entry.controller = null; entry.phase = null;
          if (!entry.alive) records.delete(entry);
          publish(entry); reconcile(); return true;
        },
        dispose() { if (!entry.alive) return; retire(entry); reconcile(); },
      };
    },
    setHidden(value: boolean) { if (typeof value !== 'boolean') throw new TypeError('Invalid visibility.'); if (hidden === value || disposed) return; hidden = value; reconcile(); },
    dispose() { if (disposed) return; disposed = true; for (const entry of [...entries.values()]) retire(entry); reconcile(); },
    whenDrained(): Promise<void> {
      if (occupied().length === 0) return Promise.resolve();
      if (drain === null) drain = new Promise<void>(resolve => { resolveDrain = resolve; });
      return drain;
    },
    counts() {
      const held = occupied();
      return { requests: records.size, granted: held.filter(e => e.phase === 'granted').length,
        retiring: held.filter(e => e.phase === 'retiring' || e.phase === 'stalled').length,
        occupied: held.length, dialogs: held.filter(e => e.lease!.dialog).length,
        stalled: held.filter(e => e.phase === 'stalled').length };
    },
  };
}
