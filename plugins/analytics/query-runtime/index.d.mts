import type {
  EXECUTION_LIMITS,
  ExecutionWorkerOutcome,
  IsolatedExecutionWorker,
  LockedChildQueryAdmission,
  QueryAdmissionOutcome,
  SharedExecutionCoordinator,
  TrustedSourceHandoff,
} from "../execution-contract.ts";

type ErrorCode = Extract<
  ExecutionWorkerOutcome,
  { kind: "error" }
>["error"]["code"];
type EventTime = Readonly<{ monotonicMs: number }>;
export type RuntimeObservation =
  & EventTime
  & Readonly<
    | { kind: "child-spawn"; pid: number; entrySha256: string }
    | { kind: "bootstrap-ready"; pid: number; bootstrapFingerprint: string }
    | {
      kind: "source-materialized";
      pid: number;
      executionId: string;
      materializationId: string;
      childReadCount: number;
      reused: boolean;
    }
    | {
      kind: "dispatch";
      pid: number;
      executionId: string;
      physicalKey: string;
      queued: number;
      queuedBytes: number;
      sqlExecutionCount: number;
    }
    | {
      kind: "completion";
      executionId: string;
      outcome: "success" | "error";
      code?: ErrorCode;
      resultBytes: number;
    }
    | {
      kind: "cache";
      physicalKey: string;
      hit: boolean;
      entries: number;
      bytes: number;
    }
    | {
      kind: "kill-requested";
      pid: number;
      executionId: string;
      reason:
        | "deadline"
        | "parent-close"
        | "startup-failure"
        | "worker-crash"
        | "subscriber-cancelled"
        | "materialization-timeout"
        | "idle-expired";
    }
    | {
      kind: "child-exit";
      pid: number;
      executionId: string;
      code: number | null;
      signal: NodeJS.Signals | null;
    }
    | {
      kind: "close-confirmed";
      pid: number;
      queued: number;
      entries: number;
      bytes: number;
    }
  >;

export interface QueryRuntime {
  /** Parser-only admission on the locked child, before immutable resolution. */
  admitQuery(
    input: Parameters<LockedChildQueryAdmission["admitQuery"]>[0],
    signal?: AbortSignal,
  ): Promise<QueryAdmissionOutcome>;
  readonly worker: IsolatedExecutionWorker;
  readonly coordinator: SharedExecutionCoordinator;
  /** Resolves only after the owned process exits; rejects if exit is unconfirmed. */
  close(): Promise<void>;
}

export interface QueryRuntimeOptions {
  /** Trusted host construction only. No client-supplied paths or source facts. */
  readonly trustedSource: TrustedSourceHandoff;
  /** Tests/host policy may only reduce these limits. */
  readonly resourceLimits?: Partial<
    { [K in keyof typeof EXECUTION_LIMITS]: number }
  >;
  readonly observer?: (event: RuntimeObservation) => void;
  /** Internal deterministic test gates; not an RPC or bundle capability. */
  readonly testControl?: Readonly<{
    beforeDispatch?: () => void | Promise<void>;
    beforeChildExecution?: () => void | Promise<void>;
    beforeChildResult?: () => void | Promise<void>;
    testMaterializationCheckpoint?: boolean;
    beforeMaterializationCommit?: () => void | Promise<void>;
  }>;
}

export function createQueryRuntime(
  options: QueryRuntimeOptions,
): Promise<QueryRuntime>;
