import type { CanvasLease, CanvasRequest } from './canvas-owner.ts';

/** Consumer-owned bridge. Abort fences immediately; passive cleanup or an
 * acknowledged root disposal proves absence. Neither onReady nor time proves it. */
export function createPresentationLifetime(request: CanvasRequest, options: { signal: AbortSignal; current: () => boolean }) {
  const bindings = new WeakMap<CanvasLease, object>();
  const states = new WeakMap<CanvasLease, { mounts: number; absent: boolean }>();
  let attached = 0, rootHolds = 0, rootAbsent = false, stopped = false, queued = false;
  function state(lease: CanvasLease) {
    let value = states.get(lease);
    if (!value) { value = { mounts: 0, absent: false }; states.set(lease, value); }
    return value;
  }
  function check() {
    const snapshot = request.getSnapshot(), lease = snapshot.lease;
    if (!lease || rootHolds !== 0 || snapshot.state === 'granted') return;
    const value = state(lease);
    if (value.mounts === 0 && (value.absent || rootAbsent)) request.acknowledgeRetired(lease);
  }
  function queueCheck() {
    if (queued) return;
    queued = true;
    queueMicrotask(() => { queued = false; check(); });
  }
  function stop() {
    if (!stopped) {
      stopped = true; request.dispose();
      options.signal.removeEventListener('abort', stop); unsubscribe();
    }
    queueCheck();
  }
  const unsubscribe = request.subscribe(queueCheck);
  options.signal.addEventListener('abort', stop, { once: true });
  if (options.signal.aborted) stop();
  return {
    request,
    /** Immutable binding belongs to the lease, not a disposable React memo. */
    capture<T extends object>(lease: CanvasLease, value: T): T {
      const previous = bindings.get(lease);
      if (previous) return previous as T;
      bindings.set(lease, value); return value;
    },
    isActive(): boolean { return !stopped && !options.signal.aborted && options.current(); },
    isCurrent(lease: CanvasLease): boolean {
      const snapshot = request.getSnapshot();
      return !stopped && !options.signal.aborted && !lease.signal.aborted && options.current()
        && snapshot.state === 'granted' && snapshot.lease === lease;
    },
    /** Call from the adapter's passive effect, not render or layout cleanup. */
    attach(): () => void {
      attached++;
      return () => {
        attached--;
        queueMicrotask(() => { if (attached === 0) stop(); });
      };
    },
    /** Wraps the actual public host subtree, including its Suspense boundary. */
    mounted(lease: CanvasLease): () => void {
      const value = state(lease); value.mounts++; value.absent = false;
      let live = true;
      return () => {
        if (!live) return;
        live = false; value.mounts--; value.absent = true; queueCheck();
      };
    },
    committedAbsent(lease: CanvasLease): void { state(lease).absent = true; queueCheck(); },
    /** Begin BEFORE queuing root.unmount. Finish only AFTER actual root disposal.
     * A missing finish intentionally stalls. Finishing cannot bypass mounted hosts. */
    beginRootDisposal(): () => void {
      rootHolds++; stop();
      let pending = true;
      return () => {
        if (!pending) return;
        pending = false; rootHolds--; rootAbsent = true; queueCheck();
      };
    },
    dispose(): void {
      stop(); options.signal.removeEventListener('abort', stop); unsubscribe();
    },
  };
}
export type PresentationLifetime = ReturnType<typeof createPresentationLifetime>;
