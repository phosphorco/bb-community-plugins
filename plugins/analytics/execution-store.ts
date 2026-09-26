/**
 * Bounded, generation-keyed execution cache.  This is deliberately separate
 * from retained execution/reference authority: eviction here only removes a
 * reusable result and never tells a snapshot provider to discard a lease.
 */
export type CachedExecution<T> = Readonly<{
  value: T;
  bytes: number;
  expiresAtMs: number;
}>;

export class BoundedExecutionStore<T> {
  readonly #entries = new Map<string, CachedExecution<T>>();
  #bytes = 0;
  readonly limits: Readonly<{ maxEntries: number; maxBytes: number; ttlMs: number }>;
  readonly now: () => number;

  constructor(limits: Readonly<{ maxEntries: number; maxBytes: number; ttlMs: number }>, now: () => number = Date.now) {
    this.limits = limits;
    this.now = now;
    if (!Number.isSafeInteger(limits.maxEntries) || limits.maxEntries < 1 ||
      !Number.isSafeInteger(limits.maxBytes) || limits.maxBytes < 1 ||
      !Number.isSafeInteger(limits.ttlMs) || limits.ttlMs < 1) {
      throw new Error("Execution cache limits must be finite positive integers.");
    }
  }

  get(key: string): T | null {
    const entry = this.#entries.get(key);
    if (!entry) return null;
    if (entry.expiresAtMs <= this.now()) {
      this.delete(key);
      return null;
    }
    // Map insertion order is the LRU order.
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return structuredClone(entry.value);
  }

  set(key: string, value: T, bytes: number): boolean {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.limits.maxBytes) return false;
    this.delete(key);
    while (this.#entries.size >= this.limits.maxEntries || this.#bytes + bytes > this.limits.maxBytes) {
      const oldest = this.#entries.keys().next().value as string | undefined;
      if (oldest == null) break;
      this.delete(oldest);
    }
    this.#entries.set(key, Object.freeze({ value: immutableClone(value), bytes, expiresAtMs: this.now() + this.limits.ttlMs }));
    this.#bytes += bytes;
    return true;
  }

  delete(key: string): void {
    const entry = this.#entries.get(key);
    if (!entry) return;
    this.#entries.delete(key);
    this.#bytes -= entry.bytes;
  }

  get size(): number { return this.#entries.size; }
  get bytes(): number { return this.#bytes; }
}
function immutableClone<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}
function deepFreeze<T>(value: T): T {
  if (value != null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
