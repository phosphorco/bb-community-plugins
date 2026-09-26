/** Transitional collector controls. These do not claim OS/process isolation. */
export const CAPTURE_LIMITS = Object.freeze({
  requests: 128,
  responseBytes: 8 * 1024 * 1024,
  elapsedMs: 15_000,
  minimumIntervalMs: 60_000,
});

export class CaptureBudget {
  readonly controller = new AbortController();
  private requests = 0;
  private bytes = 0;
  private readonly startedAt = performance.now();
  private readonly timer: ReturnType<typeof setTimeout>;

  constructor() {
    this.timer = setTimeout(() => this.controller.abort(new Error("Analytics capture deadline exceeded.")), CAPTURE_LIMITS.elapsedMs);
    this.timer.unref?.();
  }

  check(): void {
    this.controller.signal.throwIfAborted();
    if (performance.now() - this.startedAt >= CAPTURE_LIMITS.elapsedMs) {
      this.controller.abort(new Error("Analytics capture deadline exceeded."));
      this.controller.signal.throwIfAborted();
    }
  }

  async read<T>(fetch: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.check();
    if (++this.requests > CAPTURE_LIMITS.requests) {
      this.controller.abort(new Error("Analytics capture request budget exceeded."));
      this.check();
    }
    // Deliberately await the underlying request. A timeout must not free the
    // shared slot while an SDK implementation is still ignoring cancellation.
    const value = await fetch(this.controller.signal);
    this.check();
    this.bytes += Buffer.byteLength(JSON.stringify(value), "utf8");
    if (this.bytes > CAPTURE_LIMITS.responseBytes) {
      this.controller.abort(new Error("Analytics capture response budget exceeded."));
      this.check();
    }
    return value;
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.controller.abort(new Error("Analytics capture ended."));
  }
}

export type CaptureAdmission<T> =
  | { status: "completed"; value: T }
  | { status: "busy" | "cooldown"; retryAfterMs: number };

/** One slot and one cooldown for ALL transitional extraction on this host.
 * No queue, per-feature worker, waiter accumulation, or manual-refresh bypass.
 */
export class CaptureAdmissionLane {
  private active = false;
  private nextAt = 0;
  private readonly clock: () => number;

  constructor(clock: () => number = Date.now) { this.clock = clock; }

  async run<T>(capture: () => Promise<T>): Promise<CaptureAdmission<T>> {
    if (this.active) return { status: "busy", retryAfterMs: CAPTURE_LIMITS.minimumIntervalMs };
    if (this.clock() < this.nextAt) return { status: "cooldown", retryAfterMs: this.nextAt - this.clock() };
    this.active = true;
    try { return { status: "completed", value: await capture() }; }
    finally {
      this.nextAt = this.clock() + CAPTURE_LIMITS.minimumIntervalMs;
      this.active = false;
    }
  }
}
