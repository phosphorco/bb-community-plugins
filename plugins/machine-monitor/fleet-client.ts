import {
  FLEET_CONTRACT_VERSION,
  machineIdentityKey,
  timelineGenerationKey,
  type FleetMachineIdentity,
  type FleetOverviewResult,
  type MachineTimelineRequest,
  type MachineTimelineResult,
  type TimelineGeneration,
} from "./fleet-contract.ts";

export type TimelineRange = Readonly<{ startMs: number; endMs: number }>;

export type FleetClientTransport = Readonly<{
  readOverview: () => Promise<FleetOverviewResult>;
  readTimeline: (request: MachineTimelineRequest) => Promise<MachineTimelineResult>;
}>;

export type FleetClientOptions = Readonly<{
  /** The browser keeps detail only; overview summaries always remain resident. */
  maxTimelineBytes?: number;
  /** Limits simultaneous detail RPCs; queued reads remain coalesced by exact key. */
  maxTimelineFlights?: number;
}>;

type TimelineEntry = Readonly<{
  machineKey: string;
  value: MachineTimelineResult;
  bytes: number;
}>;

type TimelineFlight = {
  key: string;
  machineKey: string;
  request: MachineTimelineRequest;
  range: TimelineRange;
  lifecycle: number;
  obsolete: boolean;
  started: boolean;
  priority: TimelineFlightPriority;
  promise: Promise<MachineTimelineResult>;
  resolve: (value: MachineTimelineResult) => void;
  reject: (cause: unknown) => void;
};

type OverviewFlight = {
  lifecycle: number;
  obsolete: boolean;
  promise: Promise<FleetOverviewResult>;
};

const DEFAULT_MAX_TIMELINE_BYTES = 8 * 1024 * 1024;
// Six speculative picker reads plus the selected timeline normally consume at
// most seven slots. Leave one foreground slot available without allowing an
// invalidation storm to create unbounded live RPCs.
const DEFAULT_MAX_TIMELINE_FLIGHTS = 8;
const encoder = new TextEncoder();

export type TimelineFlightPriority = "selected" | "prefetch";

export type TimelineReadOptions = Readonly<{
  priority?: TimelineFlightPriority;
}>;

export function fleetClientTimelineKey(machine: FleetMachineIdentity, range: TimelineRange, generation: TimelineGeneration): string {
  return [
    "machine-timeline",
    machineIdentityKey(machine),
    range.startMs,
    range.endMs,
    timelineGenerationKey(generation),
  ].join("|");
}

function sameRange(left: TimelineRange, right: TimelineRange): boolean {
  return left.startMs === right.startMs && left.endMs === right.endMs;
}

function sameGeneration(left: TimelineGeneration, right: TimelineGeneration): boolean {
  return left.dataRevision === right.dataRevision && left.settingsRevision === right.settingsRevision;
}

function serializedBytes(value: unknown): number | null {
  try {
    const serialized = JSON.stringify(value);
    return serialized == null ? null : encoder.encode(serialized).byteLength;
  } catch {
    return null;
  }
}

/**
 * Browser-side read cache. It deliberately owns no timers, polling, or daemon
 * work: all calls are to the local BB server's persisted fleet read model.
 */
export class FleetClient {
  private readonly maxTimelineBytes: number;
  private readonly maxTimelineFlights: number;
  private readonly timeline = new Map<string, TimelineEntry>();
  /** Current exact-key requests, including requests waiting for a flight slot. */
  private readonly flights = new Map<string, TimelineFlight>();
  /** Transport-started requests. This is the resource constrained by the cap. */
  private readonly outstandingFlights = new Set<TimelineFlight>();
  private readonly queuedFlights: TimelineFlight[] = [];
  private timelineBytes = 0;
  /** Effect cleanup advances this so old async work can never re-enter a new mount. */
  private lifecycle = 0;
  private overview: FleetOverviewResult | null = null;
  private overviewFlight: OverviewFlight | null = null;

  constructor(private readonly transport: FleetClientTransport, options: FleetClientOptions = {}) {
    const maxTimelineBytes = options.maxTimelineBytes ?? DEFAULT_MAX_TIMELINE_BYTES;
    if (!Number.isSafeInteger(maxTimelineBytes) || maxTimelineBytes < 1) {
      throw new Error("Fleet timeline cache max bytes must be a positive safe integer.");
    }
    const maxTimelineFlights = options.maxTimelineFlights ?? DEFAULT_MAX_TIMELINE_FLIGHTS;
    if (!Number.isSafeInteger(maxTimelineFlights) || maxTimelineFlights < 1) {
      throw new Error("Fleet timeline flight limit must be a positive safe integer.");
    }
    this.maxTimelineBytes = maxTimelineBytes;
    this.maxTimelineFlights = maxTimelineFlights;
  }

  getOverview(): FleetOverviewResult | null {
    return this.overview;
  }

  setOverview(overview: FleetOverviewResult): void {
    this.overview = overview;
  }

  get timelineByteSize(): number {
    return this.timelineBytes;
  }

  get timelineEntryCount(): number {
    return this.timeline.size;
  }

  get timelineFlightCount(): number {
    return this.flights.size;
  }

  /** Number of detail RPCs presently consuming a bounded transport slot. */
  get timelineOutstandingFlightCount(): number {
    return this.outstandingFlights.size;
  }

  /**
   * Starts an effect lifecycle. This is intentionally reusable: React Strict
   * Mode cleans an effect up and immediately installs it again using the same
   * ref-owned client. Old flights are made obsolete before the new lifecycle
   * can issue reads.
   */
  activate(): void {
    this.obsoleteFlights();
    this.lifecycle += 1;
  }

  /** Coalesces overview rereads but does not cache them as freshness is clock-derived. */
  readOverview(): Promise<FleetOverviewResult> {
    if (this.overviewFlight != null && !this.overviewFlight.obsolete && this.overviewFlight.lifecycle === this.lifecycle) {
      return this.overviewFlight.promise;
    }
    const ticket: OverviewFlight = {
      lifecycle: this.lifecycle,
      obsolete: false,
      promise: Promise.resolve(undefined as never),
    };
    let request: Promise<FleetOverviewResult>;
    try {
      request = Promise.resolve(this.transport.readOverview());
    } catch (cause) {
      request = Promise.reject(cause);
    }
    ticket.promise = request.finally(() => {
      if (this.overviewFlight === ticket) this.overviewFlight = null;
    });
    this.overviewFlight = ticket;
    return ticket.promise;
  }

  /** A revision-current selection can obtain this synchronously and make no RPC. */
  getTimeline(machine: FleetMachineIdentity, range: TimelineRange, generation: TimelineGeneration): MachineTimelineResult | undefined {
    const key = fleetClientTimelineKey(machine, range, generation);
    const entry = this.timeline.get(key);
    if (entry == null) return undefined;
    this.timeline.delete(key);
    this.timeline.set(key, entry);
    return entry.value;
  }

  /**
   * Single-flight detail load keyed by identity, exact range, and exact
   * revisions. A response returned after machine invalidation may resolve to
   * its original caller, but is never inserted into the LRU.
   */
  readTimeline(
    machine: FleetMachineIdentity,
    range: TimelineRange,
    generation: TimelineGeneration,
    options: TimelineReadOptions = {},
  ): Promise<MachineTimelineResult> {
    const request: MachineTimelineRequest = {
      contractVersion: FLEET_CONTRACT_VERSION,
      machine,
      range,
      generation,
    };
    const key = fleetClientTimelineKey(machine, range, generation);
    const cached = this.getTimeline(machine, range, generation);
    if (cached != null) return Promise.resolve(cached);
    const active = this.flights.get(key);
    if (active != null) {
      // A picker warmup may be waiting when the user selects that row. Keep
      // its single-flight promise but move it ahead of other speculative work.
      if (options.priority !== "prefetch" && active.priority === "prefetch" && !active.started) {
        active.priority = "selected";
        this.promoteQueuedFlight(active);
      }
      return active.promise;
    }

    let resolve!: (value: MachineTimelineResult) => void;
    let reject!: (cause: unknown) => void;
    const ticket: TimelineFlight = {
      key,
      machineKey: machineIdentityKey(machine),
      request,
      range,
      lifecycle: this.lifecycle,
      obsolete: false,
      started: false,
      priority: options.priority ?? "selected",
      promise: new Promise<MachineTimelineResult>((nextResolve, nextReject) => {
        resolve = nextResolve;
        reject = nextReject;
      }),
      resolve,
      reject,
    };
    this.flights.set(key, ticket);
    this.scheduleTimelineFlight(ticket);
    return ticket.promise;
  }

  /** Invalidates only one machine's detail; unrelated resident timelines stay hot. */
  invalidateMachine(machine: FleetMachineIdentity): void {
    const key = machineIdentityKey(machine);
    for (const [cacheKey, entry] of this.timeline) {
      if (entry.machineKey !== key) continue;
      this.timeline.delete(cacheKey);
      this.timelineBytes -= entry.bytes;
    }
    for (const [flightKey, flight] of this.flights) {
      if (flight.machineKey !== key) continue;
      flight.obsolete = true;
      this.flights.delete(flightKey);
      if (!flight.started) this.rejectQueuedFlight(flight);
    }
  }

  dispose(): void {
    this.obsoleteFlights();
    this.lifecycle += 1;
    this.timeline.clear();
    this.timelineBytes = 0;
  }

  private obsoleteFlights(): void {
    for (const flight of this.flights.values()) {
      flight.obsolete = true;
      if (!flight.started) this.rejectQueuedFlight(flight);
    }
    this.flights.clear();
    this.queuedFlights.length = 0;
    if (this.overviewFlight != null) this.overviewFlight.obsolete = true;
    this.overviewFlight = null;
  }

  private scheduleTimelineFlight(ticket: TimelineFlight): void {
    if (this.outstandingFlights.size < this.maxTimelineFlights) {
      this.startTimelineFlight(ticket);
      return;
    }
    if (ticket.priority === "selected") {
      const firstPrefetch = this.queuedFlights.findIndex((candidate) => candidate.priority === "prefetch");
      if (firstPrefetch >= 0) this.queuedFlights.splice(firstPrefetch, 0, ticket);
      else this.queuedFlights.unshift(ticket);
      return;
    }
    this.queuedFlights.push(ticket);
  }

  private startTimelineFlight(ticket: TimelineFlight): void {
    if (ticket.obsolete || ticket.started || ticket.lifecycle !== this.lifecycle) return;
    ticket.started = true;
    this.outstandingFlights.add(ticket);
    let requestPromise: Promise<MachineTimelineResult>;
    try {
      requestPromise = Promise.resolve(this.transport.readTimeline(ticket.request));
    } catch (cause) {
      requestPromise = Promise.reject(cause);
    }
    void requestPromise.then((result) => {
      // Do not trust an RPC result to satisfy a different selection key. The
      // caller handles a newer generation by rereading the lightweight overview.
      if (!sameRange(result.range, ticket.range) || machineIdentityKey(result.machine) !== ticket.machineKey) {
        throw new Error("Machine timeline response did not match its requested machine and range.");
      }
      if (!ticket.obsolete && ticket.lifecycle === this.lifecycle) this.insertTimeline(result);
      return result;
    }).then(
      (result) => this.finishTimelineFlight(ticket, () => ticket.resolve(result)),
      (cause) => this.finishTimelineFlight(ticket, () => ticket.reject(cause)),
    );
  }

  private finishTimelineFlight(ticket: TimelineFlight, settle: () => void): void {
    this.outstandingFlights.delete(ticket);
    if (this.flights.get(ticket.key) === ticket) this.flights.delete(ticket.key);
    settle();
    this.drainTimelineFlights();
  }

  private drainTimelineFlights(): void {
    while (this.outstandingFlights.size < this.maxTimelineFlights) {
      const ticket = this.queuedFlights.shift();
      if (ticket == null) return;
      if (ticket.obsolete || ticket.lifecycle !== this.lifecycle || this.flights.get(ticket.key) !== ticket) continue;
      this.startTimelineFlight(ticket);
    }
  }

  private promoteQueuedFlight(ticket: TimelineFlight): void {
    const index = this.queuedFlights.indexOf(ticket);
    if (index < 0) return;
    this.queuedFlights.splice(index, 1);
    const firstPrefetch = this.queuedFlights.findIndex((candidate) => candidate.priority === "prefetch");
    if (firstPrefetch >= 0) this.queuedFlights.splice(firstPrefetch, 0, ticket);
    else this.queuedFlights.unshift(ticket);
  }

  private rejectQueuedFlight(ticket: TimelineFlight): void {
    const index = this.queuedFlights.indexOf(ticket);
    if (index >= 0) this.queuedFlights.splice(index, 1);
    ticket.reject(new Error("Machine timeline request was superseded before it started."));
  }

  private insertTimeline(value: MachineTimelineResult): void {
    const key = fleetClientTimelineKey(value.machine, value.range, value.generation);
    const bytes = serializedBytes(value);
    if (bytes == null || bytes > this.maxTimelineBytes) return;
    const prior = this.timeline.get(key);
    if (prior != null) {
      this.timeline.delete(key);
      this.timelineBytes -= prior.bytes;
    }
    while (this.timelineBytes + bytes > this.maxTimelineBytes) {
      const oldest = this.timeline.entries().next().value as [string, TimelineEntry] | undefined;
      if (oldest == null) break;
      this.timeline.delete(oldest[0]);
      this.timelineBytes -= oldest[1].bytes;
    }
    this.timeline.set(key, { machineKey: machineIdentityKey(value.machine), value, bytes });
    this.timelineBytes += bytes;
  }
}

/**
 * A fleet invalidation arrives with one changed machine. Preserve every other
 * summary object so one collection cannot fan out into 256 picker rerenders.
 */
export function mergeFleetOverview(previous: FleetOverviewResult | null, next: FleetOverviewResult): FleetOverviewResult {
  if (previous == null) return next;
  const priorByKey = new Map(previous.machines.map((machine) => [machineIdentityKey(machine.machine), machine]));
  return {
    ...next,
    // An overview RPC returns the complete current fleet. A burst of A then B
    // invalidations can therefore share one RPC; compare every row rather than
    // trusting the final signal's identity, which would otherwise retain A's
    // old summary. Serialization is only an identity optimization: a mismatch
    // always chooses the new authoritative row.
    machines: next.machines.map((machine) => {
      const prior = priorByKey.get(machineIdentityKey(machine.machine));
      return prior != null && JSON.stringify(prior) === JSON.stringify(machine) ? prior : machine;
    }),
  };
}

export function fleetGenerationMatches(left: TimelineGeneration, right: TimelineGeneration): boolean {
  return sameGeneration(left, right);
}
