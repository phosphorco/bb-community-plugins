/** Internal collection utility, bundled into each adopting plugin. No host scans or writes. */
export interface ReadSnapshot<T> {
  readonly data: T | null
  readonly error: string | null
  readonly loading: boolean
}

export interface ReadRecoveryEnvironment {
  visible(): boolean
  setTimeout(callback: () => void, delay: number): unknown
  clearTimeout(timer: unknown): void
  listen(wake: () => void, visibility: () => void): () => void
}

/** One mounted resource owns one request queue and one failed-read retry. */
export function createRecoveringRead<T>(read: () => Promise<T>, environment: ReadRecoveryEnvironment) {
  let snapshot: ReadSnapshot<T> = { data: null, error: null, loading: true }
  const listeners = new Set<() => void>()
  let active = false, epoch = 0, requested = false, delay = 1000
  let timer: unknown | null = null
  let detach: (() => void) | undefined
  let pending: Promise<void> | undefined
  let flight = 0
  const waiters: Array<() => void> = []
  const emit = () => { for (const listener of listeners) listener() }
  const cancel = () => { if (timer !== null) environment.clearTimeout(timer); timer = null }
  const finish = () => { for (const resolve of waiters.splice(0)) resolve() }
  const schedule = () => {
    if (!active || !snapshot.error || timer !== null || !environment.visible()) return
    timer = environment.setTimeout(() => {
      timer = null
      delay = Math.min(30000, delay * 2)
      if (active && environment.visible()) void refresh()
    }, delay)
  }
  const pump = () => {
    if (!active || pending || !requested) return
    requested = false
    const generation = epoch
    const request = ++flight
    snapshot = { ...snapshot, loading: true }
    emit()
    pending = Promise.resolve().then(async () => {
      if (!active || generation !== epoch) return
      const data = await read()
      if (!active || generation !== epoch) return
      snapshot = { data, error: null, loading: false }
      delay = 1000
      emit()
    }).catch(cause => {
      if (!active || generation !== epoch) return
      snapshot = { ...snapshot, error: cause instanceof Error ? cause.message : String(cause), loading: false }
      emit()
    }).finally(() => {
      if (request !== flight) return
      pending = undefined
      if (!active) return
      if (requested) pump()
      else { finish(); schedule() }
    })
  }
  function refresh(): Promise<void> {
    if (!active) return Promise.resolve()
    cancel()
    requested = true
    const promise = new Promise<void>(resolve => waiters.push(resolve))
    pump()
    return promise
  }
  const wake = () => { if (active && snapshot.error && environment.visible()) void refresh() }
  return {
    snapshot: () => snapshot,
    refresh,
    /** Merge a confirmed item change without claiming the failed list read recovered. */
    update(change: (data: T | null) => T) {
      if (!active) return
      const wasPending = !!pending
      epoch++
      snapshot = { ...snapshot, data: change(snapshot.data) }
      emit()
      if (wasPending) void refresh()
    },
    /** A confirmed full snapshot (e.g. a successful operation) supersedes pending reads. */
    confirm(data: T) {
      if (!active) return
      epoch++
      flight++
      pending = undefined
      requested = false
      cancel()
      finish()
      delay = 1000
      snapshot = { data, error: null, loading: false }
      emit()
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      if (!active) {
        active = true
        epoch++
        detach = environment.listen(wake, () => { if (environment.visible()) wake(); else cancel() })
        void refresh()
      }
      let subscribed = true
      return () => {
        if (!subscribed) return
        subscribed = false
        listeners.delete(listener)
        if (listeners.size) return
        active = false
        epoch++
        requested = false
        flight++
        pending = undefined
        cancel()
        detach?.()
        detach = undefined
        finish()
      }
    },
  }
}
