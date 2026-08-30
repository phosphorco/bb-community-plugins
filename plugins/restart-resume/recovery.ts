export const DEFAULT_RESUME_MESSAGE = ".";

export const HOST_DAEMON_ERROR_CODE = "thread_command_failed";
export const HOST_DAEMON_ERROR_MESSAGE =
  "Thread interrupted because the host daemon disconnected";
export const HOST_DAEMON_RECOVERY_WINDOW_MS = 60_000;

export const INTERRUPTED_TURN_RESUME_MESSAGE =
  "The host daemon restarted while this thread was working. Continue from the last durable state. Report any material effects of the restart; if there are none, reply with a single '.'.";

export interface RecoveryEvent {
  seq: number;
  type: string;
  data: unknown;
  scope?: RecoveryEventScope;
  createdAt?: number;
}

export type RecoveryEventScope =
  | { kind: "thread" }
  | { kind: "turn"; turnId: string };

export interface RecoveryThread {
  status: string;
  archivedAt: number | null;
  deletedAt: number | null;
}

export function latestHostRestartInterruption(
  events: readonly RecoveryEvent[],
): RecoveryEvent | null {
  return events.reduce<RecoveryEvent | null>((current, event) => {
    if (!isHostRestartInterruption(event)) return current;
    return current === null || event.seq > current.seq ? event : current;
  }, null);
}

export function hasEventsAfter(
  events: readonly RecoveryEvent[],
  sequence: number,
): boolean {
  return events.some((event) => event.seq > sequence);
}

export function latestHostDaemonError(
  events: readonly RecoveryEvent[],
  beforeSeq = Number.POSITIVE_INFINITY,
): RecoveryEvent | null {
  return events.reduce<RecoveryEvent | null>((current, event) => {
    if (event.seq >= beforeSeq || !isHostDaemonError(event)) return current;
    return current === null || event.seq > current.seq ? event : current;
  }, null);
}

export function hostDaemonErrorAt(
  events: readonly RecoveryEvent[],
  interruptionSeq: number,
): number | null {
  return latestHostDaemonError(events, interruptionSeq)?.createdAt ?? null;
}

export function isWithinRecoveryWindow(
  timestamp: number,
  latestTimestamp: number,
  windowMs = HOST_DAEMON_RECOVERY_WINDOW_MS,
): boolean {
  return Math.abs(timestamp - latestTimestamp) <= windowMs;
}

export function hasInterruptedTurn(
  events: readonly RecoveryEvent[],
  interruptionSeq: number,
): boolean {
  const priorEvents = events.filter((event) => event.seq < interruptionSeq);
  const latestError = priorEvents
    .filter((event) => event.type === "system/error")
    .reduce<RecoveryEvent | null>(
      (current, event) => (current === null || event.seq > current.seq ? event : current),
      null,
    );

  // Core emits a thread-scoped error for a restart with no active turn. A
  // turn-scoped error is paired with the interrupted completion for that turn.
  if (latestError?.scope?.kind === "thread") return false;
  if (latestError?.scope?.kind !== "turn") return false;
  const turnId = latestError.scope.turnId;

  return priorEvents.some(
    (event) =>
      event.seq < latestError.seq &&
      event.type === "turn/completed" &&
      event.scope?.kind === "turn" &&
      event.scope.turnId === turnId &&
      recordValue(event.data)?.status === "interrupted",
  );
}

export function hasResumeRequestAfter(
  events: readonly RecoveryEvent[],
  interruptionSeq: number,
  message: string,
): boolean {
  return events.some((event) => {
    if (event.seq <= interruptionSeq || event.type !== "client/turn/requested") {
      return false;
    }
    const input = recordValue(event.data)?.input;
    return (
      Array.isArray(input) &&
      input.some(
        (part) =>
          typeof part === "object" &&
          part !== null &&
          "type" in part &&
          part.type === "text" &&
          "text" in part &&
          part.text === message,
      )
    );
  });
}

export function isRecoverableThread(thread: RecoveryThread): boolean {
  return (
    thread.status === "error" &&
    thread.archivedAt === null &&
    thread.deletedAt === null
  );
}

export function normalizeProjectMessage(message: string | null | undefined): string | null {
  return message === undefined || message === null || message.trim() === ""
    ? null
    : message;
}

export function resumeMessageFor(
  projectMessage: string | null | undefined,
  interruptedTurn: boolean,
): string {
  return (
    normalizeProjectMessage(projectMessage) ??
    (interruptedTurn ? INTERRUPTED_TURN_RESUME_MESSAGE : DEFAULT_RESUME_MESSAGE)
  );
}

function isHostRestartInterruption(event: RecoveryEvent): boolean {
  return (
    event.type === "system/thread/interrupted" &&
    recordValue(event.data)?.reason === "host-daemon-restarted"
  );
}

function isHostDaemonError(event: RecoveryEvent): boolean {
  const data = recordValue(event.data);
  return (
    event.type === "system/error" &&
    data?.code === HOST_DAEMON_ERROR_CODE &&
    data.message === HOST_DAEMON_ERROR_MESSAGE
  );
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}
