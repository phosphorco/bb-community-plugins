import {
  machineIdentityKey,
  timelineGenerationKey,
  type FleetMachineIdentity,
  type TimelineGeneration,
} from "./fleet-contract.ts";

/** The two independently invalidatable result shapes owned by the read model. */
export type FleetCacheDetailKind = "overview" | "timeline";
export type FleetCacheInvalidationKind = FleetCacheDetailKind | "all";

export type FleetCacheScope =
  | Readonly<{ kind: "overview" }>
  | Readonly<{ kind: "timeline"; machine: FleetMachineIdentity }>;

export type FleetCacheOptions = Readonly<{
  /** Serialized result bytes retained in the LRU. Defaults to 8 MiB. */
  maxBytes?: number;
}>;

type CacheEntry = Readonly<{
  scope: FleetCacheScope;
  value: unknown;
  bytes: number;
}>;

type InFlight = {
  scope: FleetCacheScope;
  obsolete: boolean;
  promise: Promise<unknown>;
};

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const encoder = new TextEncoder();

function cacheBytes(value: unknown): number | null {
  try {
    const serialized = JSON.stringify(value);
    return serialized == null ? null : encoder.encode(serialized).byteLength;
  } catch {
    // A result that cannot be safely serialized must still be delivered, but
    // cannot participate in a deterministic byte-bounded cache.
    return null;
  }
}

function sameMachine(left: FleetMachineIdentity, right: FleetMachineIdentity): boolean {
  return machineIdentityKey(left) === machineIdentityKey(right);
}

/**
 * Cache keys name the effective generation, never a caller's possibly stale
 * generation. This prevents a prior result from satisfying a newer read even
 * when an explicit invalidation was missed.
 */
export function fleetTimelineCacheKey(
  machine: FleetMachineIdentity,
  range: Readonly<{ startMs: number; endMs: number }>,
  generation: TimelineGeneration,
): string {
  return [
    "machine-timeline",
    machineIdentityKey(machine),
    range.startMs,
    range.endMs,
    timelineGenerationKey(generation),
  ].join("|");
}

export function fleetOverviewCacheKey(generation: TimelineGeneration): string {
  return ["fleet-overview", timelineGenerationKey(generation)].join("|");
}

/**
 * A small LRU with keyed single-flight loading. Invalidation marks a running
 * ticket obsolete before removing it, so a late success or failure can neither
 * reinsert a stale value nor erase a replacement flight for the same key.
 */
export class FleetCache {
  private readonly maxBytes: number;
  private readonly entries = new Map<string, CacheEntry>();
  private readonly flights = new Map<string, InFlight>();
  private usedBytes = 0;

  constructor(options: FleetCacheOptions = {}) {
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("Fleet cache maxBytes must be a positive safe integer.");
    this.maxBytes = maxBytes;
  }

  get byteSize(): number {
    return this.usedBytes;
  }

  get entryCount(): number {
    return this.entries.size;
  }

  get inFlightCount(): number {
    return this.flights.size;
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  get<T>(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (entry == null) return undefined;
    // Delete/reinsert is the portable Map LRU promotion operation.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value as T;
  }

  getOrLoad<T>(key: string, scope: FleetCacheScope, load: () => Promise<T> | T): Promise<T> {
    const cached = this.get<T>(key);
    if (cached !== undefined) return Promise.resolve(cached);

    const current = this.flights.get(key);
    if (current != null) return current.promise as Promise<T>;

    // Invoke synchronously so callers cannot race a scheduler tick before
    // their matching request has joined the single flight.
    let loaded: Promise<T>;
    try {
      loaded = Promise.resolve(load());
    } catch (cause) {
      loaded = Promise.reject(cause);
    }

    const ticket: InFlight = {
      scope,
      obsolete: false,
      promise: Promise.resolve(),
    };
    const settled = loaded.then((value) => {
      if (!ticket.obsolete && this.flights.get(key) === ticket) this.insert(key, scope, value);
      return value;
    });
    ticket.promise = settled.finally(() => {
      // A newer post-invalidation flight must remain discoverable.
      if (this.flights.get(key) === ticket) this.flights.delete(key);
    });
    this.flights.set(key, ticket);
    return ticket.promise as Promise<T>;
  }

  invalidateMachine(machine: FleetMachineIdentity, kind: FleetCacheInvalidationKind): void {
    if (kind === "overview") {
      this.invalidateOverview();
      return;
    }
    this.invalidateWhere((scope) => {
      if (scope.kind !== "timeline" || !sameMachine(scope.machine, machine)) return false;
      return kind === "timeline" || kind === "all";
    });
    if (kind === "all") this.invalidateOverview();
  }

  invalidateOverview(): void {
    this.invalidateWhere((scope) => scope.kind === "overview");
  }

  clear(): void {
    this.invalidateWhere(() => true);
  }

  private invalidateWhere(matches: (scope: FleetCacheScope) => boolean): void {
    for (const [key, entry] of this.entries) {
      if (!matches(entry.scope)) continue;
      this.entries.delete(key);
      this.usedBytes -= entry.bytes;
    }
    for (const [key, flight] of this.flights) {
      if (!matches(flight.scope)) continue;
      // Mark before deleting: settled handlers use both guards.
      flight.obsolete = true;
      this.flights.delete(key);
    }
  }

  private insert(key: string, scope: FleetCacheScope, value: unknown): void {
    const bytes = cacheBytes(value);
    if (bytes == null || bytes > this.maxBytes) return;

    const prior = this.entries.get(key);
    if (prior != null) {
      this.entries.delete(key);
      this.usedBytes -= prior.bytes;
    }
    while (this.usedBytes + bytes > this.maxBytes) {
      const oldest = this.entries.entries().next().value as [string, CacheEntry] | undefined;
      if (oldest == null) break;
      this.entries.delete(oldest[0]);
      this.usedBytes -= oldest[1].bytes;
    }
    this.entries.set(key, { scope, value, bytes });
    this.usedBytes += bytes;
  }
}
